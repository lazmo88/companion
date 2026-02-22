# Changelog — The Companion Customizations

All modifications applied to `the-companion@0.51.0` via `bun patch`.

## [0.51.0-openclaw.1] — 2026-02-20

### Features

#### 1. Show Hidden Files Toggle (folder picker)
- **Files**: `dist/index.html`, `server/routes.ts`, `dist/assets/index-C1BTZSkP.js`
- Adds a "Show hidden" checkbox to the React modal folder picker (new session)
- Global `fetch` interceptor appends `showHidden=1` to `/api/fs/list` requests
- Backend: `GET /api/fs/list` accepts `?showHidden=1` query param to include dotfiles/dotdirs
- Toggling the checkbox refreshes the current directory via React fiber internals
  (walks `__reactFiber` → `fiber.return` chain → finds `useCallback` navigate function)

#### 2. New Folder Creation
- **Files**: `dist/index.html`, `server/routes.ts`, `server/index.ts`
- "+ New Folder" button in the React modal folder picker (uses same fiber walk to get current path + navigate)
- "+ New Folder" button in the Continue Session page folder picker
- Backend: new `POST /api/fs/mkdir` endpoint — accepts `{ path }`, creates directory recursively

#### 3. Continue Session Page
- **Files**: `server/index.ts`
- Full `/continue` route serving a standalone HTML page
- Session ID input field + folder picker with navigation, show hidden, new folder
- Submits to `POST /api/sessions/create` with `resumeSessionId` and `cwd`
- Redirects to `/#/session/<id>` on success

#### 4. Resume Session Support
- **Files**: `server/cli-launcher.ts`, `server/routes.ts`
- `resumeSessionId` property added to CLI launcher options
- Plumbed through both session creation routes in `routes.ts`

#### 5. Default bypassPermissions Mode
- **Files**: `server/cli-launcher.ts`
- When no `permissionMode` is specified, defaults to `"bypassPermissions"` (YOLO mode)
- Previously required explicit mode selection

#### 6. Four-Mode Permission Dropdown
- **Files**: `dist/index.html`
- Replaces React's binary plan/YOLO toggle with a full dropdown: Default, Accept Edits, Yolo, Plan
- Single-click opens the dropdown (capture-phase event interception with `stopImmediatePropagation`)
- Mode changes sent via WebSocket `set_permission_mode` message to the active session
- WebSocket interceptor tracks per-session browser connections

#### 7. Mobile Ribbon Layout
- **Files**: `dist/index.html`
- On screens <= 640px: textarea spans full width, mode + action buttons form a ribbon row below
- Uses CSS `flex-wrap`, `order`, and `:has()` selectors — no JS needed
- Mode button label hidden on mobile (icon-only)

#### 8. Per-Session Draft Storage
- **Files**: `dist/index.html`
- Saves unsent message text per session ID on `hashchange` and `beforeunload`
- Restores draft when switching back to a session
- Uses native `HTMLTextAreaElement.prototype.value` setter + synthetic `input` event
  to update React-controlled textarea state

#### 9. Session Rename
- **Files**: `dist/index.html`
- Double-click on session title header to rename inline
- Calls existing `PATCH /api/sessions/:id/name` endpoint
- MutationObserver-based injection

#### 10. Continue Session Tab
- **Files**: `dist/index.html`
- Injects a "Continue Session" tab in the new session creation UI
- Links to the `/continue` page
- CSS for tab bar styling

#### 11. Persistent Session Storage (systemd)
- **Files**: `~/.config/systemd/user/the-companion.service` (not in patch)
- Added `COMPANION_SESSION_DIR=/home/openclaw/.openclaw/companion/sessions`
- Sessions now persist across reboots (previously stored in `/tmp/vibe-sessions/`)

### CSS Additions (`dist/index.html` `<style>` block)

- Mode dropdown overflow fix (`.rounded-[14px].overflow-hidden:has(textarea)`)
- Session chat textarea sizing
- Mobile responsive: font size, z-index for popups
- Mobile ribbon layout (flex-wrap + order)
- Continue Session tab bar styles
- Continue Session form styles
- Folder browser widget styles
- Mode dropdown styles

### Technical Notes

- All frontend enhancements are injected via a `<script>` block in `dist/index.html` that runs after React mounts
- MutationObserver watches for DOM changes and injects UI enhancements as components appear
- React component state is accessed via fiber internals (`__reactFiber` + suffix properties)
- WebSocket connections are intercepted to enable mode changes on active sessions
- The minified React bundle (`dist/assets/index-C1BTZSkP.js`) has 2 line changes for `listDirs` API signature
