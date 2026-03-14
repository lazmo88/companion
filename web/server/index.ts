process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";

// Enrich process PATH at startup so binary resolution and `which` calls can find
// binaries installed via version managers (nvm, volta, fnm, etc.).
// Critical when running as a launchd/systemd service with a restricted PATH.
import { getEnrichedPath } from "./path-resolver.js";
process.env.PATH = getEnrichedPath();

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { cacheControlMiddleware } from "./cache-headers.js";
import { createRoutes } from "./routes.js";
import { CliLauncher } from "./cli-launcher.js";
import { WsBridge } from "./ws-bridge.js";
import { SessionStore } from "./session-store.js";
import { WorktreeTracker } from "./worktree-tracker.js";
import { containerManager } from "./container-manager.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { TerminalManager } from "./terminal-manager.js";
import { generateSessionTitle } from "./auto-namer.js";
import * as sessionNames from "./session-names.js";
import { getSettings } from "./settings-manager.js";
import { PRPoller } from "./pr-poller.js";
import { RecorderManager } from "./recorder.js";
import { CronScheduler } from "./cron-scheduler.js";
import { AgentExecutor } from "./agent-executor.js";
import { migrateCronJobsToAgents } from "./agent-cron-migrator.js";
import { LinearAgentBridge } from "./linear-agent-bridge.js";
import { NoVncProxy } from "./novnc-proxy.js";

import { startPeriodicCheck, setServiceMode } from "./update-checker.js";
import { imagePullManager } from "./image-pull-manager.js";
import { restoreIfNeeded as restoreTailscaleFunnel, cleanup as cleanupTailscaleFunnel } from "./tailscale-manager.js";
import { isRunningAsService } from "./service.js";
import { getToken, verifyToken } from "./auth-manager.js";
import { getCookie } from "hono/cookie";
import type { SocketData } from "./ws-bridge.js";
import type { ServerWebSocket } from "bun";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = process.env.__COMPANION_PACKAGE_ROOT || resolve(__dirname, "..");

import { DEFAULT_PORT_DEV, DEFAULT_PORT_PROD } from "./constants.js";

const defaultPort = process.env.NODE_ENV === "production" ? DEFAULT_PORT_PROD : DEFAULT_PORT_DEV;
const port = Number(process.env.PORT) || defaultPort;
const sessionStore = new SessionStore(process.env.COMPANION_SESSION_DIR);
const wsBridge = new WsBridge();
const launcher = new CliLauncher(port);
const worktreeTracker = new WorktreeTracker();
const CONTAINER_STATE_PATH = join(homedir(), ".companion", "containers.json");
const terminalManager = new TerminalManager();
const noVncProxy = new NoVncProxy();
const prPoller = new PRPoller(wsBridge);
const recorder = new RecorderManager();
const cronScheduler = new CronScheduler(launcher, wsBridge);
const agentExecutor = new AgentExecutor(launcher, wsBridge);
const linearAgentBridge = new LinearAgentBridge(agentExecutor, wsBridge);

// ── Cloud relay connection (for receiving webhooks behind a firewall) ────────
// The relay forwards platform webhooks (e.g. GitHub, Slack) to the Companion
// instance via an outbound WebSocket. Currently no webhook handlers are
// registered (Chat SDK was removed). The relay is left disabled until handlers
// are wired up (e.g. LinearAgentBridge or future platform integrations).
if (process.env.COMPANION_RELAY_URL && process.env.COMPANION_RELAY_SECRET) {
  console.warn(
    "[server] COMPANION_RELAY_URL is set but no relay webhook handlers are registered. " +
    "The relay client will not be started. Remove COMPANION_RELAY_URL/COMPANION_RELAY_SECRET " +
    "or wire up webhook handlers to use relay mode.",
  );
}

// ── Restore persisted sessions from disk ────────────────────────────────────
wsBridge.setStore(sessionStore);
wsBridge.setRecorder(recorder);
launcher.setStore(sessionStore);
launcher.setRecorder(recorder);
launcher.restoreFromDisk();
wsBridge.restoreFromDisk();
containerManager.restoreState(CONTAINER_STATE_PATH);

// When the CLI reports its internal session_id, store it for --resume on relaunch
wsBridge.onCLISessionIdReceived((sessionId, cliSessionId) => {
  launcher.setCLISessionId(sessionId, cliSessionId);
});

// When a Codex adapter is created, attach it to the WsBridge
launcher.onCodexAdapterCreated((sessionId, adapter) => {
  wsBridge.attachCodexAdapter(sessionId, adapter);
});

// When a CLI/Codex process exits, mark the corresponding agent execution as completed
launcher.onSessionExited((sessionId, exitCode) => {
  agentExecutor.handleSessionExited(sessionId, exitCode);
});

// Start watching PRs when git info is resolved for a session
wsBridge.onSessionGitInfoReadyCallback((sessionId, cwd, branch) => {
  prPoller.watch(sessionId, cwd, branch);
});

// Auto-relaunch CLI when a browser connects to a session with no CLI
const relaunchingSet = new Set<string>();
const MAX_AUTO_RELAUNCHES = 3;
const autoRelaunchCounts = new Map<string, number>();
wsBridge.onCLIRelaunchNeededCallback(async (sessionId) => {
  if (relaunchingSet.has(sessionId)) return;
  const info = launcher.getSession(sessionId);
  if (info?.archived) return;

  // Add to set BEFORE the grace period to block concurrent browser connections
  relaunchingSet.add(sessionId);

  // Grace period: CLI does normal code-1000 WS reconnection cycles (~30s).
  // Wait 10s, then check if CLI reconnected or process is still alive.
  await new Promise(r => setTimeout(r, 10000));
  if (wsBridge.isCliConnected(sessionId)) { relaunchingSet.delete(sessionId); return; }
  const freshInfo = launcher.getSession(sessionId);
  if (freshInfo && (freshInfo.state === "connected" || freshInfo.state === "running")) {
    relaunchingSet.delete(sessionId); return;
  }
  // PID liveness check — session state/WS can be stale, but signal 0 is definitive
  if (freshInfo?.pid) {
    try { process.kill(freshInfo.pid, 0); relaunchingSet.delete(sessionId); return; } catch {}
  }

  const count = autoRelaunchCounts.get(sessionId) ?? 0;
  if (count >= MAX_AUTO_RELAUNCHES) {
    console.warn(`[server] Auto-relaunch limit (${MAX_AUTO_RELAUNCHES}) reached for session ${sessionId}, giving up`);
    wsBridge.broadcastToSession(sessionId, {
      type: "error",
      message: "Session keeps crashing. Please relaunch manually.",
    });
    relaunchingSet.delete(sessionId);
    return;
  }

  if (freshInfo && freshInfo.state !== "starting") {
    autoRelaunchCounts.set(sessionId, count + 1);
    console.log(`[server] Auto-relaunching CLI for session ${sessionId} (attempt ${count + 1}/${MAX_AUTO_RELAUNCHES})`);
    try {
      const result = await launcher.relaunch(sessionId);
      if (!result.ok && result.error) {
        wsBridge.broadcastToSession(sessionId, { type: "error", message: result.error });
      } else {
        autoRelaunchCounts.delete(sessionId);
      }
    } finally {
      setTimeout(() => relaunchingSet.delete(sessionId), 5000);
    }
  } else {
    relaunchingSet.delete(sessionId);
  }
});

// Kill CLI when idle with no browsers for 20 minutes
wsBridge.onIdleKillCallback(async (sessionId) => {
  const info = launcher.getSession(sessionId);
  if (!info || info.archived) return;
  console.log(`[server] Idle-killing CLI for session ${sessionId} (no browsers, no activity)`);
  await launcher.kill(sessionId);
});

// Auto-generate session title after first turn completes
wsBridge.onFirstTurnCompletedCallback(async (sessionId, firstUserMessage) => {
  // Don't overwrite a name that was already set (manual rename or prior auto-name)
  if (sessionNames.getName(sessionId)) return;
  if (!getSettings().anthropicApiKey.trim()) return;
  const info = launcher.getSession(sessionId);
  const model = info?.model || "claude-sonnet-4-6";
  console.log(`[server] Auto-naming session ${sessionId} via Anthropic with model ${model}...`);
  const title = await generateSessionTitle(firstUserMessage, model);
  // Re-check: a manual rename may have occurred while we were generating
  if (title && !sessionNames.getName(sessionId)) {
    console.log(`[server] Auto-named session ${sessionId}: "${title}"`);
    sessionNames.setName(sessionId, title);
    wsBridge.broadcastNameUpdate(sessionId, title);
  }
});

console.log(`[server] Session persistence: ${sessionStore.directory}`);
if (recorder.isGloballyEnabled()) {
  console.log(`[server] Recording enabled (dir: ${recorder.getRecordingsDir()}, max: ${recorder.getMaxLines()} lines)`);
}

const app = new Hono();

app.use("/api/*", cors());
app.route("/api", createRoutes(launcher, wsBridge, sessionStore, worktreeTracker, terminalManager, prPoller, recorder, cronScheduler, agentExecutor, linearAgentBridge, port));

// ── Claude Code session discovery — parse ~/.claude for existing sessions ─────
app.get("/api/claude-sessions", async (c) => {
  const claudeDir = join(homedir(), ".claude");
  const projectsDir = join(claudeDir, "projects");
  const historyPath = join(claudeDir, "history.jsonl");
  const sessions: Record<string, any> = {};

  try {
    const { readdirSync, statSync, readFileSync } = await import("node:fs");
    for (const proj of readdirSync(projectsDir)) {
      const projPath = join(projectsDir, proj);
      try { if (!statSync(projPath).isDirectory()) continue; } catch { continue; }
      for (const f of readdirSync(projPath)) {
        if (!f.endsWith(".jsonl")) continue;
        const sid = f.replace(".jsonl", "");
        const fpath = join(projPath, f);
        try {
          const stat = statSync(fpath);
          if (stat.size === 0) continue;
          const chunk = readFileSync(fpath, "utf-8").slice(0, 8192);
          const lines = chunk.split("\n").filter(Boolean).slice(0, 5);
          let slug = "", cwd = "", gitBranch = "", permissionMode = "", version = "";
          for (const line of lines) {
            try {
              const d = JSON.parse(line);
              if (d.slug) slug = d.slug;
              if (d.cwd) cwd = d.cwd;
              if (d.gitBranch) gitBranch = d.gitBranch;
              if (d.permissionMode) permissionMode = d.permissionMode;
              if (d.version) version = d.version;
              if (slug) break;
            } catch {}
          }
          const decodedProject = proj.startsWith("-")
            ? proj.replace(/^-/, "/").replace(/-/g, "/")
            : proj;
          sessions[sid] = {
            sessionId: sid, slug, project: decodedProject,
            cwd: cwd || decodedProject, gitBranch, permissionMode, version,
            lastActive: stat.mtimeMs, sizeKB: Math.round(stat.size / 1024),
          };
        } catch {}
      }
    }
  } catch {}

  try {
    const { readFileSync } = await import("node:fs");
    const historyContent = readFileSync(historyPath, "utf-8");
    for (const line of historyContent.split("\n")) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        const sid = d.sessionId;
        if (sid && sessions[sid]) {
          const display = d.display || "";
          if (display && display !== "login" && !display.startsWith("/exit") && !display.startsWith("/config")) {
            sessions[sid].lastInput = display.slice(0, 80);
          }
          if (d.timestamp && d.timestamp > (sessions[sid].historyTs || 0)) {
            sessions[sid].historyTs = d.timestamp;
          }
        }
      } catch {}
    }
  } catch {}

  const result = Object.values(sessions)
    .filter((s: any) => s.sizeKB > 0)
    .sort((a: any, b: any) => b.lastActive - a.lastActive);
  return c.json(result);
});

// ── Usage Summary API — aggregate cost and turn data across all sessions ──────
app.get("/api/usage/summary", (c) => {
  const sessions = launcher.listSessions();
  const names = sessionNames.getAllNames();
  const bridgeStates = wsBridge.getAllSessions();
  const bridgeMap = new Map(bridgeStates.map((s) => [s.session_id, s]));

  const sessionData = sessions.map((s) => {
    const bridge = bridgeMap.get(s.sessionId);
    return {
      sessionId: s.sessionId,
      name: names[s.sessionId] ?? s.name ?? null,
      model: bridge?.model ?? s.model ?? null,
      backendType: s.backendType ?? bridge?.backend_type ?? null,
      total_cost_usd: bridge?.total_cost_usd ?? 0,
      num_turns: bridge?.num_turns ?? 0,
      cwd: bridge?.cwd ?? s.cwd ?? null,
      createdAt: s.createdAt,
      state: s.state,
    };
  });

  const totalCost = sessionData.reduce((sum, s) => sum + (s.total_cost_usd ?? 0), 0);

  return c.json({
    sessions: sessionData,
    totalCost,
    generatedAt: Date.now(),
  });
});

// ── Usage Dashboard page — visual overview of session costs ──────────────────
app.get("/usage", (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Usage Dashboard - The Companion</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
           background: #1a1a1a; color: #e0e0e0; min-height: 100vh; padding: 24px 16px; }
    .page { max-width: 960px; margin: 0 auto; }
    header { display: flex; align-items: center; justify-content: space-between;
             margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
    header h1 { font-size: 1.4rem; color: #fff; letter-spacing: -0.02em; }
    .header-right { display: flex; align-items: center; gap: 12px; }
    .back { color: #5BA8A0; text-decoration: none; font-size: 0.85rem; }
    .back:hover { text-decoration: underline; }
    .refresh-btn { background: none; border: 1px solid #444; border-radius: 6px;
                   color: #888; padding: 4px 10px; font-size: 0.75rem; cursor: pointer;
                   transition: all 0.15s; }
    .refresh-btn:hover { border-color: #5BA8A0; color: #5BA8A0; }
    .refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .last-updated { font-size: 0.72rem; color: #555; }
    .summary-row { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
    .summary-card { flex: 1; min-width: 160px; background: #242424; border: 1px solid #333;
                    border-radius: 10px; padding: 20px 24px; }
    .summary-card .label { font-size: 0.72rem; color: #888; text-transform: uppercase;
                            letter-spacing: 0.06em; margin-bottom: 8px; }
    .summary-card .value { font-size: 1.8rem; font-weight: 700; color: #fff; letter-spacing: -0.02em; }
    .summary-card .value.cost { color: #5BA8A0; }
    .table-card { background: #242424; border: 1px solid #333; border-radius: 10px;
                  overflow: hidden; }
    .table-card-header { padding: 14px 20px; border-bottom: 1px solid #333;
                         display: flex; align-items: center; justify-content: space-between; }
    .table-card-header h2 { font-size: 0.9rem; color: #ccc; font-weight: 600; }
    .table-card-header .count { font-size: 0.75rem; color: #555; }
    table { width: 100%; border-collapse: collapse; }
    thead th { padding: 10px 20px; text-align: left; font-size: 0.72rem; color: #666;
               text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #2e2e2e;
               white-space: nowrap; }
    tbody tr { border-bottom: 1px solid #2a2a2a; transition: background 0.1s; }
    tbody tr:last-child { border-bottom: none; }
    tbody tr:hover { background: #292929; }
    tbody td { padding: 10px 20px; font-size: 0.85rem; vertical-align: middle; }
    td.name a { color: #e0e0e0; text-decoration: none; font-weight: 500; }
    td.name a:hover { color: #5BA8A0; text-decoration: underline; }
    td.name .no-name { color: #555; font-style: italic; font-size: 0.8rem; }
    td.model { color: #888; font-family: monospace; font-size: 0.78rem; }
    td.cost { color: #5BA8A0; font-weight: 600; font-variant-numeric: tabular-nums; }
    td.cost.zero { color: #444; font-weight: 400; }
    td.turns { color: #aaa; font-variant-numeric: tabular-nums; }
    td.status .badge { display: inline-block; padding: 2px 8px; border-radius: 4px;
                       font-size: 0.7rem; font-weight: 600; text-transform: capitalize; }
    .badge.running { background: #1a3a1a; color: #4caf50; border: 1px solid #2d5a2d; }
    .badge.connected { background: #1a2f2d; color: #5BA8A0; border: 1px solid #2a4a47; }
    .badge.starting { background: #2e2a1a; color: #d4a44c; border: 1px solid #4a3d1a; }
    .badge.exited { background: #2a1a1a; color: #888; border: 1px solid #3a2a2a; }
    td.last-active { color: #555; font-size: 0.78rem; white-space: nowrap; }
    .empty-state { padding: 48px 20px; text-align: center; color: #444; font-size: 0.9rem; }
    .error-state { padding: 24px 20px; text-align: center; color: #e55; font-size: 0.85rem; }
    .loading-state { padding: 48px 20px; text-align: center; color: #555; font-size: 0.85rem; }
    @media (max-width: 600px) {
      .summary-card .value { font-size: 1.4rem; }
      thead th, tbody td { padding: 8px 12px; }
      td.model, td.last-active { display: none; }
    }
  </style>
</head>
<body>
  <div class="page">
    <header>
      <h1>Usage Dashboard</h1>
      <div class="header-right">
        <span class="last-updated" id="last-updated"></span>
        <button class="refresh-btn" id="refresh-btn">Refresh</button>
        <a class="back" href="/">Back to Companion</a>
      </div>
    </header>

    <div class="summary-row" id="summary-row">
      <div class="summary-card">
        <div class="label">Total Cost</div>
        <div class="value cost" id="stat-cost">&mdash;</div>
      </div>
      <div class="summary-card">
        <div class="label">Sessions</div>
        <div class="value" id="stat-sessions">&mdash;</div>
      </div>
      <div class="summary-card">
        <div class="label">Total Turns</div>
        <div class="value" id="stat-turns">&mdash;</div>
      </div>
    </div>

    <div class="table-card">
      <div class="table-card-header">
        <h2>Sessions by Cost</h2>
        <span class="count" id="table-count"></span>
      </div>
      <div id="table-container">
        <div class="loading-state">Loading usage data...</div>
      </div>
    </div>
  </div>

  <script>
    const _authToken = (new URLSearchParams(location.search)).get('token') || localStorage.getItem('companion_auth_token') || '';
    function authFetch(url, opts) {
      opts = opts || {};
      opts.headers = Object.assign({ 'Authorization': 'Bearer ' + _authToken }, opts.headers || {});
      return fetch(url, opts);
    }

    function fmtCost(val) {
      if (val === null || val === undefined) return '$0.0000';
      return '$' + val.toFixed(4);
    }

    function timeAgo(ms) {
      if (!ms) return '\\u2014';
      const secs = Math.floor((Date.now() - ms) / 1000);
      if (secs < 60) return 'just now';
      const mins = Math.floor(secs / 60);
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      const days = Math.floor(hrs / 24);
      if (days < 30) return days + 'd ago';
      return new Date(ms).toLocaleDateString();
    }

    function shortModel(m) {
      if (!m) return '\\u2014';
      return m.replace(/^claude-/, '').replace(/-latest$/, '');
    }

    function renderTable(sessions) {
      const container = document.getElementById('table-container');
      const count = document.getElementById('table-count');
      if (!sessions || sessions.length === 0) {
        container.innerHTML = '<div class="empty-state">No sessions found</div>';
        count.textContent = '';
        return;
      }
      count.textContent = sessions.length + ' session' + (sessions.length !== 1 ? 's' : '');
      const rows = sessions.map(s => {
        const nameCell = s.name
          ? '<a href="/#/session/' + s.sessionId + '">' + escHtml(s.name) + '</a>'
          : '<span class="no-name"><a href="/#/session/' + s.sessionId + '" style="color:#555;text-decoration:none;">' + s.sessionId.slice(0, 12) + '...</a></span>';
        const costVal = s.total_cost_usd || 0;
        const costClass = costVal > 0 ? 'cost' : 'cost zero';
        const badge = '<span class="badge ' + (s.state || 'exited') + '">' + (s.state || 'exited') + '</span>';
        return '<tr>' +
          '<td class="name">' + nameCell + '</td>' +
          '<td class="model">' + escHtml(shortModel(s.model)) + '</td>' +
          '<td class="' + costClass + '">' + fmtCost(costVal) + '</td>' +
          '<td class="turns">' + (s.num_turns || 0) + '</td>' +
          '<td class="status">' + badge + '</td>' +
          '<td class="last-active">' + timeAgo(s.createdAt) + '</td>' +
          '</tr>';
      }).join('');
      container.innerHTML = '<table>' +
        '<thead><tr>' +
        '<th>Session Name</th>' +
        '<th>Model</th>' +
        '<th>Cost</th>' +
        '<th>Turns</th>' +
        '<th>Status</th>' +
        '<th>Created</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table>';
    }

    function escHtml(s) {
      return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    async function loadData() {
      const btn = document.getElementById('refresh-btn');
      btn.disabled = true;
      btn.textContent = 'Loading...';
      try {
        const res = await authFetch('/api/usage/summary');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();

        const sessions = (data.sessions || []).slice().sort((a, b) => (b.total_cost_usd || 0) - (a.total_cost_usd || 0));
        const totalCost = data.totalCost || 0;
        const totalTurns = sessions.reduce((n, s) => n + (s.num_turns || 0), 0);

        document.getElementById('stat-cost').textContent = fmtCost(totalCost);
        document.getElementById('stat-sessions').textContent = sessions.length;
        document.getElementById('stat-turns').textContent = totalTurns;

        renderTable(sessions);

        const d = new Date(data.generatedAt);
        document.getElementById('last-updated').textContent = 'Updated ' + d.toLocaleTimeString();
      } catch (e) {
        document.getElementById('table-container').innerHTML =
          '<div class="error-state">Failed to load usage data: ' + escHtml(e.message) + '</div>';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Refresh';
      }
    }

    document.getElementById('refresh-btn').addEventListener('click', loadData);
    loadData();

    // Auto-refresh every 30 seconds
    setInterval(loadData, 30000);
  </script>
</body>
</html>`);
});

// ── Continue Session page — resume an external Claude Code session ───────────
app.get("/continue", (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Continue Session - The Companion</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
           background: #1a1a1a; color: #e0e0e0; min-height: 100vh;
           display: flex; align-items: center; justify-content: center; padding: 16px; }
    .card { background: #242424; border: 1px solid #333; border-radius: 12px;
            padding: 32px; width: 100%; max-width: 520px; }
    h1 { font-size: 1.25rem; margin-bottom: 4px; color: #fff; }
    .subtitle { color: #888; font-size: 0.85rem; margin-bottom: 24px; }
    label { display: block; font-size: 0.8rem; color: #aaa; margin-bottom: 6px; font-weight: 500; }
    input[type="text"] { width: 100%; padding: 10px 12px; background: #1a1a1a; border: 1px solid #444;
            border-radius: 8px; color: #e0e0e0; font-size: 0.9rem; font-family: monospace;
            outline: none; transition: border-color 0.15s; }
    input[type="text"]:focus { border-color: #5BA8A0; }
    input[type="text"]::placeholder { color: #555; }
    .field { margin-bottom: 16px; }
    .hint { font-size: 0.75rem; color: #666; margin-top: 4px; }
    .submit-btn { width: 100%; padding: 10px; background: #5BA8A0; color: #fff; border: none;
             border-radius: 8px; font-size: 0.9rem; font-weight: 600; cursor: pointer;
             transition: background 0.15s; }
    .submit-btn:hover { background: #4a9790; }
    .submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .error { color: #e55; font-size: 0.85rem; margin-top: 12px; }
    .back { display: inline-block; margin-top: 16px; color: #5BA8A0; text-decoration: none;
            font-size: 0.85rem; }
    .back:hover { text-decoration: underline; }
    .fp { border: 1px solid #444; border-radius: 8px; overflow: hidden; background: #1a1a1a; }
    .fp-bar { display: flex; align-items: center; gap: 6px; padding: 8px 10px;
              border-bottom: 1px solid #333; min-height: 38px; }
    .fp-path { flex: 1; font-size: 0.75rem; color: #888; font-family: monospace;
               overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fp-icon-btn { width: 26px; height: 26px; display: flex; align-items: center; justify-content: center;
                   border-radius: 6px; border: none; background: transparent; color: #888;
                   cursor: pointer; transition: all 0.15s; flex-shrink: 0; }
    .fp-icon-btn:hover { background: #333; color: #e0e0e0; }
    .fp-icon-btn svg { width: 14px; height: 14px; }
    .fp-select { display: flex; align-items: center; gap: 6px; padding: 8px 10px;
                 border-bottom: 1px solid #333; cursor: pointer; transition: background 0.15s;
                 color: #5BA8A0; font-size: 0.8rem; font-weight: 500; }
    .fp-select:hover { background: #252525; }
    .fp-select svg { width: 14px; height: 14px; flex-shrink: 0; }
    .fp-select span { font-family: monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fp-list { max-height: 240px; overflow-y: auto; }
    .fp-list::-webkit-scrollbar { width: 6px; }
    .fp-list::-webkit-scrollbar-track { background: transparent; }
    .fp-list::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }
    .fp-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px;
               cursor: pointer; transition: background 0.15s; font-size: 0.8rem; }
    .fp-item:hover { background: #252525; }
    .fp-item svg { width: 14px; height: 14px; color: #666; flex-shrink: 0; }
    .fp-item.hidden-dir { opacity: 0.6; }
    .fp-empty { padding: 16px; text-align: center; font-size: 0.8rem; color: #555; }
    .fp-loading { padding: 16px; text-align: center; font-size: 0.8rem; color: #555; }
    .fp-opts { display: flex; align-items: center; gap: 8px; padding: 6px 10px;
               border-top: 1px solid #333; }
    .fp-opts label { display: flex; align-items: center; gap: 5px; font-size: 0.7rem;
                     color: #888; cursor: pointer; margin: 0; }
    .fp-opts input[type="checkbox"] { accent-color: #5BA8A0; }
    .fp-manual { width: 100%; padding: 8px 10px; background: transparent; border: none;
                 color: #e0e0e0; font-size: 0.8rem; font-family: monospace; outline: none; }
    .fp-manual::placeholder { color: #555; }
    .sb { margin-bottom: 20px; }
    .sb-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .sb-header h2 { font-size: 0.85rem; color: #aaa; font-weight: 500; }
    .sb-refresh { background: none; border: 1px solid #444; border-radius: 6px; color: #888;
                  padding: 3px 8px; font-size: 0.7rem; cursor: pointer; transition: all 0.15s; }
    .sb-refresh:hover { border-color: #5BA8A0; color: #5BA8A0; }
    .sb-search { width: 100%; padding: 8px 10px; background: #1a1a1a; border: 1px solid #444;
                 border-radius: 8px; color: #e0e0e0; font-size: 0.8rem; font-family: monospace;
                 outline: none; margin-bottom: 8px; transition: border-color 0.15s; }
    .sb-search:focus { border-color: #5BA8A0; }
    .sb-search::placeholder { color: #555; }
    .sb-list { max-height: 280px; overflow-y: auto; border: 1px solid #333; border-radius: 8px;
               background: #1a1a1a; }
    .sb-list::-webkit-scrollbar { width: 6px; }
    .sb-list::-webkit-scrollbar-track { background: transparent; }
    .sb-list::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }
    .sb-item { padding: 8px 10px; cursor: pointer; transition: background 0.15s;
               border-bottom: 1px solid #2a2a2a; }
    .sb-item:last-child { border-bottom: none; }
    .sb-item:hover { background: #252525; }
    .sb-item.selected { background: #1a2f2d; border-left: 3px solid #5BA8A0; }
    .sb-item-top { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
    .sb-slug { font-size: 0.8rem; color: #e0e0e0; font-weight: 500; }
    .sb-no-slug { font-size: 0.8rem; color: #666; font-style: italic; }
    .sb-branch { font-size: 0.65rem; color: #5BA8A0; background: #1a2f2d; padding: 1px 5px;
                 border-radius: 3px; white-space: nowrap; }
    .sb-time { font-size: 0.65rem; color: #666; margin-left: auto; white-space: nowrap; }
    .sb-item-bottom { display: flex; align-items: center; gap: 6px; }
    .sb-project { font-size: 0.7rem; color: #555; font-family: monospace;
                  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sb-size { font-size: 0.65rem; color: #444; white-space: nowrap; }
    .sb-last-msg { font-size: 0.7rem; color: #555; margin-top: 2px;
                   overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sb-empty { padding: 20px; text-align: center; font-size: 0.8rem; color: #555; }
    .sb-loading { padding: 20px; text-align: center; font-size: 0.8rem; color: #555; }
    .sb-count { font-size: 0.65rem; color: #555; margin-top: 4px; text-align: right; }
    .sb-or { text-align: center; color: #555; font-size: 0.75rem; margin: 12px 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Continue Session</h1>
    <p class="subtitle">Resume an existing Claude Code session in the Companion</p>

    <div class="sb" id="sb">
      <div class="sb-header">
        <h2>Discovered Sessions</h2>
        <button type="button" class="sb-refresh" id="sb-refresh">Refresh</button>
      </div>
      <input type="text" class="sb-search" id="sb-search" placeholder="Filter by name, project, branch, or ID..." />
      <div class="sb-list" id="sb-list">
        <div class="sb-loading">Loading sessions...</div>
      </div>
      <div class="sb-count" id="sb-count"></div>
    </div>

    <div class="sb-or">or enter session ID manually</div>

    <form id="form">
      <div class="field">
        <label for="sessionId">Claude Code Session ID</label>
        <input type="text" id="sessionId" name="sessionId" required
               placeholder="e.g. 01abc2de-3f45-6789-abcd-ef0123456789" />
        <p class="hint">The session ID from your Claude Code terminal session</p>
      </div>
      <div class="field">
        <label>Working Directory</label>
        <div class="fp" id="fp">
          <div class="fp-bar" id="fp-bar">
            <button type="button" class="fp-icon-btn" id="fp-up" title="Parent directory">
              <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 4l4 4H9.5v4h-3V8H4L8 4z"/></svg>
            </button>
            <span class="fp-path" id="fp-curpath"></span>
            <button type="button" class="fp-icon-btn" id="fp-edit" title="Type path manually">
              <svg viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L3.463 11.098a.25.25 0 00-.064.108l-.563 1.97 1.971-.564a.25.25 0 00.108-.064l8.61-8.61a.25.25 0 000-.354l-1.098-1.097z"/></svg>
            </button>
          </div>
          <div class="fp-select" id="fp-select">
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M12.416 3.376a.75.75 0 01.208 1.04l-5 7.5a.75.75 0 01-1.154.114l-3-3a.75.75 0 011.06-1.06l2.353 2.353 4.493-6.74a.75.75 0 011.04-.207z"/></svg>
            <span id="fp-select-label">Select: /</span>
          </div>
          <div class="fp-list" id="fp-list"></div>
          <div class="fp-opts">
            <label><input type="checkbox" id="fp-hidden" checked /> Show hidden</label>
            <button type="button" id="fp-new-folder" style="margin-left:auto;color:#5BA8A0;font-size:0.7rem;border:1px solid #5BA8A0;border-radius:4px;padding:2px 8px;cursor:pointer;background:none;">+ New Folder</button>
          </div>
        </div>
        <input type="hidden" id="cwd" name="cwd" />
      </div>
      <button type="submit" class="submit-btn" id="btn">Continue Session</button>
      <p class="error" id="error" hidden></p>
    </form>
    <a class="back" href="/">Back to Companion</a>
  </div>
  <script>
    const _authToken = (new URLSearchParams(location.search)).get('token') || localStorage.getItem('companion_auth_token') || '';
    function authFetch(url, opts) {
      opts = opts || {};
      opts.headers = Object.assign({ 'Authorization': 'Bearer ' + _authToken }, opts.headers || {});
      return fetch(url, opts);
    }

    const fpList = document.getElementById('fp-list');
    const fpSelect = document.getElementById('fp-select');
    const fpHidden = document.getElementById('fp-hidden');
    const fpBar = document.getElementById('fp-bar');
    const cwdInput = document.getElementById('cwd');
    let currentPath = '';
    let manualMode = false;

    const UP_SVG = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 4l4 4H9.5v4h-3V8H4L8 4z"/></svg>';
    const EDIT_SVG = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25a1.75 1.75 0 01.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L3.463 11.098a.25.25 0 00-.064.108l-.563 1.97 1.971-.564a.25.25 0 00.108-.064l8.61-8.61a.25.25 0 000-.354l-1.098-1.097z"/></svg>';
    const FOLDER_SVG = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 000 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0016 13.25v-8.5A1.75 1.75 0 0014.25 3H7.5a.25.25 0 01-.2-.1l-.9-1.2c-.33-.44-.85-.7-1.4-.7H1.75z"/></svg>';

    function renderBar() {
      fpBar.innerHTML = '<button type="button" class="fp-icon-btn" data-action="up" title="Parent directory">' + UP_SVG + '</button>' +
        '<span class="fp-path">' + currentPath + '</span>' +
        '<button type="button" class="fp-icon-btn" data-action="edit" title="Type path manually">' + EDIT_SVG + '</button>';
    }
    function enterManualMode() {
      manualMode = true;
      fpBar.innerHTML = '<input type="text" class="fp-manual" data-action="manual" value="' +
        currentPath.replace(/"/g, '&quot;') + '" placeholder="/path/to/project" autofocus />';
      const inp = fpBar.querySelector('[data-action="manual"]');
      inp.focus(); inp.select();
    }
    function exitManualMode(navigate) {
      manualMode = false; renderBar();
      if (navigate) loadDir(navigate);
    }
    fpBar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'up' && currentPath && currentPath !== '/') {
        loadDir(currentPath.split('/').slice(0, -1).join('/') || '/');
      }
      if (btn.dataset.action === 'edit') { manualMode ? exitManualMode() : enterManualMode(); }
    });
    fpBar.addEventListener('keydown', (e) => {
      if (!manualMode) return;
      const inp = fpBar.querySelector('[data-action="manual"]');
      if (e.key === 'Enter') { e.preventDefault(); const v = inp.value.trim(); if (v) exitManualMode(v); }
      if (e.key === 'Escape') { e.stopPropagation(); exitManualMode(); }
    });
    async function loadDir(path) {
      fpList.innerHTML = '<div class="fp-loading">Loading...</div>';
      try {
        const sh = fpHidden.checked ? '1' : '0';
        const url = '/api/fs/list?' + (path ? 'path=' + encodeURIComponent(path) + '&' : '') + 'showHidden=' + sh;
        const res = await authFetch(url);
        const data = await res.json();
        currentPath = data.path;
        cwdInput.value = currentPath;
        renderBar();
        document.getElementById('fp-select-label').textContent = 'Select: ' + (currentPath.split('/').pop() || '/');
        if (data.dirs.length === 0) { fpList.innerHTML = '<div class="fp-empty">No subdirectories</div>'; return; }
        fpList.innerHTML = '';
        for (const dir of data.dirs) {
          const item = document.createElement('div');
          item.className = 'fp-item' + (dir.name.startsWith('.') ? ' hidden-dir' : '');
          item.innerHTML = FOLDER_SVG + '<span>' + dir.name + '</span>';
          item.addEventListener('click', () => loadDir(dir.path));
          fpList.appendChild(item);
        }
      } catch (e) { fpList.innerHTML = '<div class="fp-empty">Error loading directory</div>'; }
    }
    fpSelect.addEventListener('click', () => {
      cwdInput.value = currentPath;
      fpSelect.style.background = '#5BA8A0'; fpSelect.style.color = '#fff';
      setTimeout(() => { fpSelect.style.background = ''; fpSelect.style.color = ''; }, 300);
    });
    fpHidden.addEventListener('change', () => loadDir(currentPath));
    document.getElementById('fp-new-folder').addEventListener('click', () => {
      const name = prompt('New folder name:');
      if (!name || !name.trim()) return;
      const newPath = currentPath + '/' + name.trim();
      authFetch('/api/fs/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newPath })
      }).then(r => r.json()).then(data => {
        if (data.error) { alert('Error: ' + data.error); loadDir(currentPath); }
        else loadDir(newPath);
      }).catch(() => loadDir(currentPath));
    });
    authFetch('/api/fs/home').then(r => r.json()).then(data => {
      loadDir(data.cwd || data.home);
    }).catch(() => loadDir(undefined));

    // Session browser
    const sbList = document.getElementById('sb-list');
    const sbSearch = document.getElementById('sb-search');
    const sbCount = document.getElementById('sb-count');
    let allSessions = [];
    let selectedSession = null;
    function timeAgo(ms) {
      const secs = Math.floor((Date.now() - ms) / 1000);
      if (secs < 60) return 'just now';
      const mins = Math.floor(secs / 60);
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      const days = Math.floor(hrs / 24);
      if (days < 30) return days + 'd ago';
      return new Date(ms).toLocaleDateString();
    }
    function shortPath(p) { return (p || '').replace(/^\\/home\\/[^/]+/, '~'); }
    function renderSessions(filter) {
      const q = (filter || '').toLowerCase();
      const filtered = q ? allSessions.filter(s =>
        (s.slug || '').toLowerCase().includes(q) ||
        (s.project || '').toLowerCase().includes(q) ||
        (s.cwd || '').toLowerCase().includes(q) ||
        (s.gitBranch || '').toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q) ||
        (s.lastInput || '').toLowerCase().includes(q)
      ) : allSessions;
      if (filtered.length === 0) {
        sbList.innerHTML = '<div class="sb-empty">' + (q ? 'No sessions match filter' : 'No Claude Code sessions found') + '</div>';
        sbCount.textContent = ''; return;
      }
      sbList.innerHTML = '';
      for (const s of filtered.slice(0, 50)) {
        const item = document.createElement('div');
        item.className = 'sb-item' + (selectedSession === s.sessionId ? ' selected' : '');
        const name = s.slug
          ? '<span class="sb-slug">' + s.slug + '</span>'
          : '<span class="sb-no-slug">' + s.sessionId.slice(0, 12) + '...</span>';
        const branch = s.gitBranch ? '<span class="sb-branch">' + s.gitBranch + '</span>' : '';
        const time = '<span class="sb-time">' + timeAgo(s.lastActive) + '</span>';
        const project = '<span class="sb-project">' + shortPath(s.cwd || s.project) + '</span>';
        const size = '<span class="sb-size">' + s.sizeKB + 'KB</span>';
        const lastMsg = s.lastInput ? '<div class="sb-last-msg">' + s.lastInput.replace(/</g,'&lt;') + '</div>' : '';
        item.innerHTML = '<div class="sb-item-top">' + name + branch + time + '</div>' +
          '<div class="sb-item-bottom">' + project + size + '</div>' + lastMsg;
        item.addEventListener('click', () => selectSession(s));
        sbList.appendChild(item);
      }
      const showing = filtered.length > 50 ? '50 of ' + filtered.length : filtered.length;
      sbCount.textContent = showing + ' session' + (filtered.length !== 1 ? 's' : '');
    }
    function selectSession(s) {
      selectedSession = s.sessionId;
      document.getElementById('sessionId').value = s.sessionId;
      if (s.cwd) { cwdInput.value = s.cwd; loadDir(s.cwd); }
      renderSessions(sbSearch.value);
    }
    async function loadSessions() {
      sbList.innerHTML = '<div class="sb-loading">Loading sessions...</div>';
      try {
        const res = await authFetch('/api/claude-sessions');
        allSessions = await res.json();
        renderSessions(sbSearch.value);
      } catch (e) { sbList.innerHTML = '<div class="sb-empty">Failed to load sessions</div>'; }
    }
    sbSearch.addEventListener('input', () => renderSessions(sbSearch.value));
    document.getElementById('sb-refresh').addEventListener('click', loadSessions);
    loadSessions();

    // Form submission
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('btn');
      const err = document.getElementById('error');
      err.hidden = true; btn.disabled = true; btn.textContent = 'Creating session...';
      try {
        const sessionId = document.getElementById('sessionId').value.trim();
        const cwd = cwdInput.value.trim() || undefined;
        const res = await authFetch('/api/sessions/create', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resumeSessionId: sessionId, cwd }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to create session');
        window.location.href = '/#/session/' + data.sessionId;
      } catch (ex) {
        err.textContent = ex.message; err.hidden = false;
        btn.disabled = false; btn.textContent = 'Continue Session';
      }
    });
  </script>
</body>
</html>`);
});

// Dynamic manifest — embeds auth token in start_url so PWA auto-authenticates
// on first launch. iOS gives standalone PWAs isolated storage from Safari,
// so this is the only way to bridge auth across the install boundary.
app.get("/manifest.json", (c) => {
  const manifest = {
    name: "The Companion",
    short_name: "Companion",
    description: "Web UI for Claude Code and Codex",
    start_url: "/",
    scope: "/",
    display: "standalone" as const,
    background_color: "#262624",
    theme_color: "#d97757",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };

  // If the user has an auth cookie (set during login), embed token in start_url.
  // Safari sends this cookie when fetching the manifest at "Add to Home Screen" time.
  const authCookie = getCookie(c, "companion_auth");
  if (authCookie && verifyToken(authCookie)) {
    manifest.start_url = `/?token=${authCookie}`;
  } else {
    // Localhost bypass — always embed the token for same-machine installs
    const bunServer = c.env as { requestIP?: (req: Request) => { address: string } | null };
    const ip = bunServer?.requestIP?.(c.req.raw);
    const addr = ip?.address ?? "";
    if (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1") {
      manifest.start_url = `/?token=${getToken()}`;
    }
  }

  c.header("Content-Type", "application/manifest+json");
  return c.json(manifest);
});

// In production, serve built frontend using absolute path (works when installed as npm package)
if (process.env.NODE_ENV === "production") {
  const distDir = resolve(packageRoot, "dist");
  app.use("/*", cacheControlMiddleware());
  app.use("/*", serveStatic({ root: distDir }));
  app.get("/*", serveStatic({ path: resolve(distDir, "index.html") }));
}

const server = Bun.serve<SocketData>({
  port,
  idleTimeout: 0, // Disable top-level idle timeout — it kills idle browser WebSockets (code 1006)
  async fetch(req, server) {
    const url = new URL(req.url);

    // ── CLI WebSocket — Claude Code CLI connects here via --sdk-url ────
    const cliMatch = url.pathname.match(/^\/ws\/cli\/([a-f0-9-]+)$/);
    if (cliMatch) {
      const sessionId = cliMatch[1];
      const upgraded = server.upgrade(req, {
        data: { kind: "cli" as const, sessionId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Helper: check if request is from localhost (same machine)
    const reqIp = server.requestIP(req);
    const reqAddr = reqIp?.address ?? "";
    const isLocalhost = reqAddr === "127.0.0.1" || reqAddr === "::1" || reqAddr === "::ffff:127.0.0.1";

    // ── Browser WebSocket — connects to a specific session ─────────────
    const browserMatch = url.pathname.match(/^\/ws\/browser\/([a-f0-9-]+)$/);
    if (browserMatch) {
      const wsToken = url.searchParams.get("token");
      if (!isLocalhost && !verifyToken(wsToken)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const sessionId = browserMatch[1];
      const upgraded = server.upgrade(req, {
        data: { kind: "browser" as const, sessionId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // ── Terminal WebSocket — embedded terminal PTY connection ─────────
    const termMatch = url.pathname.match(/^\/ws\/terminal\/([a-f0-9-]+)$/);
    if (termMatch) {
      const wsToken = url.searchParams.get("token");
      if (!isLocalhost && !verifyToken(wsToken)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const terminalId = termMatch[1];
      const upgraded = server.upgrade(req, {
        data: { kind: "terminal" as const, terminalId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // ── noVNC WebSocket — proxies VNC data to container's websockify ────
    const novncMatch = url.pathname.match(/^\/ws\/novnc\/([a-f0-9-]+)$/);
    if (novncMatch) {
      const wsToken = url.searchParams.get("token");
      if (!isLocalhost && !verifyToken(wsToken)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const sessionId = novncMatch[1];
      const upgraded = server.upgrade(req, {
        data: { kind: "novnc" as const, sessionId },
      });
      if (upgraded) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Hono handles the rest
    return app.fetch(req, server);
  },
  websocket: {
    idleTimeout: 0,
    sendPings: false, // Disable Bun ping timeout that kills CLI connections (code 1006)
    open(ws: ServerWebSocket<SocketData>) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIOpen(ws, data.sessionId);
        launcher.markConnected(data.sessionId);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserOpen(ws, data.sessionId);
      } else if (data.kind === "terminal") {
        terminalManager.addBrowserSocket(ws);
      } else if (data.kind === "novnc") {
        noVncProxy.handleOpen(ws, data.sessionId);
      }
    },
    message(ws: ServerWebSocket<SocketData>, msg: string | Buffer) {
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIMessage(ws, msg);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserMessage(ws, msg);
      } else if (data.kind === "terminal") {
        terminalManager.handleBrowserMessage(ws, msg);
      } else if (data.kind === "novnc") {
        noVncProxy.handleMessage(ws, msg);
      }
    },
    close(ws: ServerWebSocket<SocketData>, code?: number, reason?: string) {
      console.log("[ws-close]", ws.data.kind, "code=" + code);
      const data = ws.data;
      if (data.kind === "cli") {
        wsBridge.handleCLIClose(ws);
      } else if (data.kind === "browser") {
        wsBridge.handleBrowserClose(ws);
      } else if (data.kind === "terminal") {
        terminalManager.removeBrowserSocket(ws);
      } else if (data.kind === "novnc") {
        noVncProxy.handleClose(ws);
      }
    },
  },
});

const authToken = getToken();
console.log(`Server running on http://localhost:${server.port}`);
console.log();
console.log(`  Auth token: ${authToken}`);
if (process.env.COMPANION_AUTH_TOKEN) {
  console.log("  (using COMPANION_AUTH_TOKEN env var)");
}
console.log();
console.log(`  CLI WebSocket:     ws://localhost:${server.port}/ws/cli/:sessionId`);
console.log(`  Browser WebSocket: ws://localhost:${server.port}/ws/browser/:sessionId`);

if (process.env.NODE_ENV !== "production") {
  console.log("Dev mode: frontend at http://localhost:5174");
}

// ── Cron scheduler ──────────────────────────────────────────────────────────
cronScheduler.startAll();

// ── Agent system ────────────────────────────────────────────────────────────
migrateCronJobsToAgents();
agentExecutor.startAll();

// ── Image pull manager — pre-pull missing Docker images for environments ────
imagePullManager.initFromEnvironments();

// ── Tailscale Funnel restoration ────────────────────────────────────────────
restoreTailscaleFunnel(port).catch((err) => {
  console.warn("[server] Tailscale Funnel restoration failed:", err);
});

// ── Update checker ──────────────────────────────────────────────────────────
startPeriodicCheck();
if (isRunningAsService()) {
  setServiceMode(true);
  console.log("[server] Running as background service (auto-update available)");
}

// ── Memory diagnostics ───────────────────────────────────────────────────────
const MEMORY_LOG_INTERVAL_MS = 5 * 60_000; // every 5 minutes
setInterval(() => {
  const mem = process.memoryUsage();
  const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  const sessionStats = wsBridge.getSessionMemoryStats();
  const totalHistory = sessionStats.reduce((sum, s) => sum + s.historyLen, 0);
  const topSessions = sessionStats
    .sort((a, b) => b.historyLen - a.historyLen)
    .slice(0, 3)
    .map((s) => `${s.id.slice(0, 8)}(h=${s.historyLen},b=${s.browsers})`)
    .join(", ");
  console.log(
    `[mem] rss=${mb(mem.rss)}MB heap=${mb(mem.heapUsed)}/${mb(mem.heapTotal)}MB ` +
    `ext=${mb(mem.external)}MB | ${sessionStats.length} sessions, ${totalHistory} history msgs | top: ${topSessions || "none"}`,
  );
}, MEMORY_LOG_INTERVAL_MS);

// ── Graceful shutdown — persist container state ──────────────────────────────
function gracefulShutdown() {
  console.log("[server] Persisting container state before shutdown...");
  containerManager.persistState(CONTAINER_STATE_PATH);
  cleanupTailscaleFunnel(port);
  process.exit(0);
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

// ── Reconnection watchdog ────────────────────────────────────────────────────
// After a server restart, restored CLI processes may not reconnect their
// WebSocket. Give them a grace period, then kill + relaunch any that are
// still in "starting" state (alive but no WS connection).
const RECONNECT_GRACE_MS = Number(process.env.COMPANION_RECONNECT_GRACE_MS || "30000");
const starting = launcher.getStartingSessions();
if (starting.length > 0) {
  console.log(`[server] Waiting ${RECONNECT_GRACE_MS / 1000}s for ${starting.length} CLI process(es) to reconnect...`);
  setTimeout(async () => {
    const stale = launcher.getStartingSessions();
    for (const info of stale) {
      if (info.archived) continue;
      console.log(`[server] CLI for session ${info.sessionId} did not reconnect, relaunching...`);
      await launcher.relaunch(info.sessionId);
    }
  }, RECONNECT_GRACE_MS);
}
