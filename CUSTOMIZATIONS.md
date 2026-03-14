# OpenClaw Companion Customizations

Custom modifications to [The-Vibe-Company/companion](https://github.com/The-Vibe-Company/companion) on the `openclaw/custom` branch, based on `the-companion-v0.74.0`.

Fork: [lazmo88/companion](https://github.com/lazmo88/companion)

---

## Overview

These modifications add multi-provider AI validation, usage tracking, session management, and UX enhancements to The Companion. All frontend changes use DOM injection via MutationObserver to avoid modifying React source, keeping upstream merges clean.

---

## Server-Side Changes

### 1. Multi-Provider AI Validation (`server/ai-validator.ts`)

Extends the AI-powered tool call safety validator to support multiple LLM providers:

- **Anthropic** (default) — Uses `COMPANION_AI_VALIDATION_URL` env var to override the API endpoint (e.g., for SDK bridge proxies)
- **OpenAI-compatible** — Works with OpenAI, LiteLLM, Ollama, vLLM, etc. via `/chat/completions`
- **Custom endpoint** — Any OpenAI-compatible URL with optional API key

The dispatcher (`aiEvaluate`) routes to the correct provider based on `settings.aiValidationProvider`. Rule-based pre-filtering catches obviously safe/dangerous operations without making API calls.

### 2. Custom Settings Fields (`server/settings-manager.ts`, `server/routes/settings-routes.ts`)

Four new settings for configuring the AI validation provider:

| Field | Type | Description |
|-------|------|-------------|
| `aiValidationProvider` | string | `"anthropic"`, `"openai"`, or `"custom"` |
| `aiValidationBaseUrl` | string | Base URL for OpenAI-compatible or custom endpoints |
| `aiValidationApiKey` | string | Provider-specific API key (never exposed in GET responses) |
| `aiValidationModel` | string | Model name for validation requests |

All fields are validated, normalized, and persisted through the existing settings API (GET/PUT `/api/settings`).

### 3. Custom API Endpoints (`server/index.ts`)

Four new routes added after the main router:

| Route | Description |
|-------|-------------|
| `GET /api/claude-sessions` | Discovers Claude Code sessions from `~/.claude/projects/`, returns metadata (slug, cwd, git branch, permission mode, version, last input) |
| `GET /api/usage/summary` | Aggregates cost and turn data across active sessions |
| `GET /usage` | HTML usage dashboard with summary cards, sortable session table, auto-refresh |
| `GET /continue` | HTML session continuation page with folder picker, session browser, manual session ID input |

### 4. File System Enhancements (`server/routes/fs-routes.ts`)

- **`GET /fs/list`** — Added `showHidden` query parameter to include dotfiles/dotdirs in listings
- **`POST /fs/mkdir`** — New endpoint for creating directories (recursive), used by the folder picker's "New Folder" button

---

## Frontend Changes (`web/index.html`)

All UI enhancements are injected via inline `<style>` and `<script>` blocks in the Vite entry HTML. A MutationObserver watches for React-rendered elements and enhances them post-render.

### Features

- **Chat mode dropdown** — Replaces the simple toggle with a full mode selector (Default, Accept Edits, Yolo, Plan), sending mode changes via WebSocket
- **Cost badges** — Displays per-session USD cost in the header, updated from WebSocket session events
- **Collapsible sidebar** — WORKBENCH, WORKSPACE, RESOURCES sections can be collapsed, with state persisted in localStorage
- **Session sort** — Dropdown to sort sessions by last active, name, branch, or project
- **Copy buttons** — Injected on code blocks, user messages, and assistant messages
- **Folder picker enhancements** — "Show hidden files" toggle and "+ New Folder" button with inline directory creation
- **Draft persistence** — Per-session chat draft saved/restored from localStorage
- **Session rename** — Double-click the session header to rename via `PATCH /api/sessions/{id}/name`
- **AI validation settings panel** — Custom form injected into the Settings page for configuring the validation provider, URL, API key, and model
- **Fetch interceptor** — Auto-appends `showHidden=1` to `/fs/list` requests when the toggle is active
- **WebSocket interceptor** — Tracks cost data from `session_update`/`session_init` messages

---

## Deployment

Runs as a systemd user service (`the-companion.service`):

```
ExecStart=/home/openclaw/.bun/bin/bun run server/index.ts
WorkingDirectory=/home/openclaw/.openclaw/companion-source/web
Environment=COMPANION_AI_VALIDATION_URL=https://ccsdk.lasse.dev/v1/messages
```

Build: `bun install && bun run build` produces `dist/` with Vite-bundled assets.

All user data (auth, settings, recordings, agents) lives in `~/.companion/`, independent of install location.
