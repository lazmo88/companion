# Companion Backlog

## Active Development (v0.72.0)

### P0 — Bug Fixes
- [ ] **Permission mode selector not working** — Injected 4-mode dropdown (Default/Accept Edits/Yolo/Plan) may not fire on v0.72.0; investigate and fix `injectChatModeDropdown()` selector/timing

### P1 — Quick Wins
- [x] **Draft message persistence** — Upgraded from in-memory `sessionDrafts` to `localStorage` with `cc-draft-{sessionId}` keys; survives page reload
- [ ] **Session sort controls** — Add sort dropdown to "Branch from session" panel: Auto (CWD+chrono), Last Active, Name, Branch, Project

### P2 — Medium Features
- [ ] **Session persistence setting** — Add `sessionDir` to settings UI so users can configure persistent session storage without env vars
- [ ] **AI Validation overhaul** — Support 3 provider presets: Anthropic (current), OpenAI (chat completions), Custom (any OpenAI-compatible URL for LiteLLM, Ollama, vLLM)

### P3 — Larger Features
- [ ] **ccusage / Cost tracking** — Per-session cost badge + standalone `/usage` page with per-model token breakdown, aggregate costs, rate limit utilization

### P1 — New Features

- [ ] **Copy chat conversation** — Per-message copy button (assistant/user messages), "copy full conversation" action, code block clipboard copy. Consider: Markdown export, share link
- [ ] **Mobile chat tab navigation** — Add Chat tab to mobile top bar; currently Diffs/Shell/Processes are accessible but returning to chat requires Shell → "Back to chat"
- [ ] **1M model variant support** — Add `claude-opus-4-6-1m` and `claude-sonnet-4-6-1m` to model picker in session creation; detect/display when a session uses extended context

### P2 — Remote Control Integration

- [ ] **Remote Control toggle** — Add "Enable Remote Control" to Settings UI; writes to Claude Code config so all spawned sessions are remote-controllable. Per-session: button to send `/remote-control` (or `/rc`) to active session. Display session URL + QR code in Companion UI when active. Flags: `--name`, `--verbose`, `--sandbox`/`--no-sandbox`
- [ ] **Remote Connection client** — "Connect to remote session" option in session creation UI. Discover remote-controllable sessions (computer icon + green dot in claude.ai/code). Show connection status. Note: one remote session per Claude Code instance; outbound HTTPS only; ~10 min timeout on network loss

## Ideas / Feature Requests

- [ ] **Auto-scroll to latest message** — On opening a session chat, scroll to the bottom; mobile currently lands on a random mid-conversation position
- [ ] **Codex session resume support** — Codex CLI supports `codex resume <ID>`, but Companion's `spawnCodex()` never passes resume args
- [ ] **Codex session frozen after task_complete** — Companion stops forwarding user messages to Codex app-server after a `task_complete` event; session appears frozen in UI despite processes being alive

## Custom Patches (current — v0.72.0)

- Mode dropdown (full selector replacing toggle)
- Mobile UI fixes (z-index, icon-only mode button, textarea sizing)
- Show hidden files toggle + mkdir in folder picker
- Per-session draft message storage (localStorage-backed)
- Session rename via header double-click
- `/continue` page with session browser
- `/api/claude-sessions` endpoint (session discovery)
- AI validation URL override (`COMPANION_AI_VALIDATION_URL`)
- `showHidden` param on `/fs/list` + `/fs/mkdir` endpoint
