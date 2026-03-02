# Changelog — The Companion Customizations

All modifications applied via `bun patch`.

## [0.69.0-openclaw.1] — 2026-03-02

### Upgraded from 0.58.2 to 0.69.0

Auto-updater bumped the-companion from 0.58.2 to 0.69.0, wiping all patches. Re-applied and adapted all patches for 0.69.0 compatibility.

#### Breaking changes in 0.69.0
- Token-based authentication added (token printed in server log)
- Service now runs from global bun install (`~/.bun/bin/the-companion`)
- Auto-updater rewrites systemd service file, removing custom env vars
- UI mode toggle simplified to 2 modes (Agent/Plan) — our 4-mode dropdown overrides this

#### New: AI Validation via SDK Bridge
- **Files**: `server/ai-validator.ts`, `server/routes/settings-routes.ts`
- Patched `ai-validator.ts` to use `COMPANION_AI_VALIDATION_URL` env var (defaults to `https://ccsdk.lasse.dev/v1/messages`)
- API key fallback: uses `"sdk-bridge"` as key when env var is set (no Anthropic API key needed)
- Patched `settings-routes.ts` to report `anthropicApiKeyConfigured: true` when SDK bridge is active
- Validation model: `claude-haiku-4-5-20251001`

#### Updated: 4-Mode Dropdown for 0.69.0
- **Files**: `dist/index.html`
- Updated MODES array with `match` arrays to handle 0.69.0's new labels ("Agent"→bypassPermissions, "Plan"→plan)
- Dropdown still provides all 4 modes: Default, Accept Edits, Yolo, Plan

#### Updated: Continue Session Tab for 0.69.0
- **Files**: `dist/index.html`
- Updated formRoot selector to handle `max-w-2xl` (was `max-w-5xl` in 0.58.2)
- Tab injection and session browser confirmed working via Playwright headless tests

#### Session Browser (Continue Session page)
- **Files**: `server/index.ts`
- `GET /api/claude-sessions` endpoint — scans `~/.claude/projects/` and `~/.claude/history.jsonl`
- Returns: `sessionId`, `slug`, `project`, `cwd`, `gitBranch`, `lastActive`, `sizeKB`, `lastInput`
- Browsable session list with search/filter on Continue Session tab and `/continue` page

### Patched Files (0.69.0)

| File | Changes |
|------|---------|
| `dist/index.html` | CSS overrides + JS injection (features 1-2, 5-9, 12) |
| `server/index.ts` | `/continue` route + `/api/claude-sessions` endpoint (features 3, 12) |
| `server/routes/fs-routes.ts` | `showHidden` param + `POST /api/fs/mkdir` (features 1-2) |
| `server/cli-launcher.ts` | Default `bypassPermissions` (feature 4) |
| `server/ai-validator.ts` | SDK bridge URL + API key fallback (new) |
| `server/routes/settings-routes.ts` | Report API key configured when SDK bridge active (new) |

### Systemd Service (not in patch)

```
Environment=COMPANION_SESSION_DIR=/home/openclaw/.openclaw/companion/sessions
Environment=COMPANION_AI_VALIDATION_URL=https://ccsdk.lasse.dev/v1/messages
```

---

## [0.58.2-openclaw.2] — 2026-03-02

### New

#### 12. Session Browser (Continue Session page)
- **Files**: `server/index.ts`
- New `GET /api/claude-sessions` endpoint — scans `~/.claude/projects/` and `~/.claude/history.jsonl` to discover all existing Claude Code sessions
- Returns: `sessionId`, `slug`, `project`, `cwd`, `gitBranch`, `lastActive`, `sizeKB`, `lastInput`
- Continue Session page now shows a browsable session list with search/filter
- Click a session to auto-fill session ID and working directory
- Sessions sorted by last-active timestamp, shows slug name, git branch badge, project path, relative time

## [0.58.2-openclaw.1] — 2026-02-22

### Upgraded from 0.51.0 to 0.58.2

- Retargeted patches to new file locations (routes.ts split into sub-files)
- `resumeSessionId` now upstreamed — removed from our patch
- Minified bundle patch eliminated (fetch interceptor handles showHidden client-side)
- Patch size reduced from 445KB to ~45KB

## [0.51.0-openclaw.1] — 2026-02-20

### Features

#### 1. Show Hidden Files Toggle (folder picker)
- **Files**: `dist/index.html`, `server/routes/fs-routes.ts`
- Adds a "Show hidden" checkbox to the React modal folder picker (new session)
- Global `fetch` interceptor appends `showHidden=1` to `/api/fs/list` requests
- Backend: `GET /api/fs/list` accepts `?showHidden=1` query param to include dotfiles/dotdirs
- Toggling the checkbox refreshes the current directory via React fiber internals
  (walks `__reactFiber` → `fiber.return` chain → finds `useCallback` navigate function)

#### 2. New Folder Creation
- **Files**: `dist/index.html`, `server/routes/fs-routes.ts`, `server/index.ts`
- "+ New Folder" button in the React modal folder picker (uses same fiber walk to get current path + navigate)
- "+ New Folder" button in the Continue Session page folder picker
- Backend: new `POST /api/fs/mkdir` endpoint — accepts `{ path }`, creates directory recursively

#### 3. Continue Session Page
- **Files**: `server/index.ts`
- Full `/continue` route serving a standalone HTML page
- Session ID input field + folder picker with navigation, show hidden, new folder
- Session browser panel with discovered Claude Code sessions (see #12)
- Submits to `POST /api/sessions/create` with `resumeSessionId` and `cwd`
- Redirects to `/#/session/<id>` on success

#### 4. Default bypassPermissions Mode
- **Files**: `server/cli-launcher.ts`
- When no `permissionMode` is specified, defaults to `"bypassPermissions"` (YOLO mode)

#### 5. Four-Mode Permission Dropdown
- **Files**: `dist/index.html`
- Replaces React's binary plan/YOLO toggle with a full dropdown: Default, Accept Edits, Yolo, Plan
- Single-click opens the dropdown (capture-phase event interception with `stopImmediatePropagation`)
- Mode changes sent via WebSocket `set_permission_mode` message to the active session
- WebSocket interceptor tracks per-session browser connections

#### 6. Mobile Ribbon Layout
- **Files**: `dist/index.html`
- On screens <= 640px: textarea spans full width, mode + action buttons form a ribbon row below
- Uses CSS `flex-wrap`, `order`, and `:has()` selectors — no JS needed
- Mode button label hidden on mobile (icon-only)

#### 7. Per-Session Draft Storage
- **Files**: `dist/index.html`
- Saves unsent message text per session ID on `hashchange` and `beforeunload`
- Restores draft when switching back to a session
- Uses native `HTMLTextAreaElement.prototype.value` setter + synthetic `input` event
  to update React-controlled textarea state

#### 8. Session Rename
- **Files**: `dist/index.html`
- Double-click on session title header to rename inline
- Calls existing `PATCH /api/sessions/:id/name` endpoint
- MutationObserver-based injection

#### 9. Continue Session Tab
- **Files**: `dist/index.html`
- Injects a "Continue Session" tab in the new session creation UI
- Links to the `/continue` page

#### 10. Persistent Session Storage (systemd)
- **Files**: `~/.config/systemd/user/the-companion.service` (not in patch)
- Added `COMPANION_SESSION_DIR=/home/openclaw/.openclaw/companion/sessions`
- Sessions now persist across reboots (previously stored in `/tmp/vibe-sessions/`)

### Patched Files (0.58.2)

| File | Changes |
|------|---------|
| `dist/index.html` | CSS overrides + JS injection (features 1-2, 5-9) |
| `server/index.ts` | `/continue` route + `/api/claude-sessions` endpoint (features 3, 12) |
| `server/routes/fs-routes.ts` | `showHidden` param + `POST /api/fs/mkdir` (features 1-2) |
| `server/cli-launcher.ts` | Default `bypassPermissions` (feature 4) |

### Technical Notes

- All frontend enhancements are injected via a `<script>` block in `dist/index.html` that runs after React mounts
- MutationObserver watches for DOM changes and injects UI enhancements as components appear
- React component state is accessed via fiber internals (`__reactFiber` + suffix properties)
- WebSocket connections are intercepted to enable mode changes on active sessions
- Session browser parses `~/.claude/projects/*/` JSONL files and `~/.claude/history.jsonl` for metadata
