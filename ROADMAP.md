# Companion Customizations — Roadmap

## Submitted PRs (upstream)

- [x] **Show hidden files + mkdir in folder picker** — [#382](https://github.com/The-Vibe-Company/companion/pull/382)
- [x] **Mobile ribbon layout for chat input** — [#383](https://github.com/The-Vibe-Company/companion/pull/383)
- [x] **Default bypassPermissions mode** — [#384](https://github.com/The-Vibe-Company/companion/pull/384)

## Applied locally (bun patch on 0.72.0)

- [x] Continue Session page (`/continue` route) — resume external CLI sessions
- [x] 4-mode permission dropdown (default/accept-edits/yolo/plan)
- [x] Per-session draft message storage (localStorage-backed)
- [x] Session rename via double-click on title
- [x] Continue Session tab in creation UI
- [x] Session browser — auto-discover Claude Code sessions from `~/.claude/` on Continue page
- [x] AI Validation via SDK bridge (`ccsdk.lasse.dev`) — no Anthropic API key needed

## In Progress

- [ ] **Permission mode selector fix** — Debug injected dropdown on v0.72.0
- [ ] **Session sort controls** — Sortable "Branch from session" panel
- [ ] **AI Validation overhaul** — Multi-provider support (Anthropic/OpenAI/Custom)
- [ ] **Cost tracking** — Per-session cost badge + `/usage` dashboard
- [ ] **Session persistence setting** — UI setting for session storage directory

## Planned features

- [ ] **Copy chat conversation** — Per-message copy button, "copy full conversation" action, and code block copy for easy clipboard access
- [ ] **Mobile chat tab navigation** — Add a Chat tab to the mobile top bar (Diffs/Shell/Processes exist but no way back to chat except Shell → "Back to chat")
- [ ] **1M model variant support** — Add `claude-opus-4-6-1m` and `claude-sonnet-4-6-1m` (1M context) to model selection in session creation UI
- [ ] **Remote Control toggle** — Settings toggle to enable Claude Code Remote Control for all sessions; per-session button to send `/remote-control`; display session URL + QR code in Companion UI
- [ ] **Remote Connection client** — "Connect to remote session" option alongside New/Continue; discover and connect to remote-controllable Claude Code sessions running on other machines
- [ ] **Resume external CLI sessions** — Submit `/continue` route as proper React page PR upstream
- [ ] **Fine-tuning sessions** — Allow adjusting session parameters after creation (model, permission mode, cwd, environment variables, etc.)
- [ ] **Persistent session storage by default** — Propose upstream: default `COMPANION_SESSION_DIR` to `~/.companion/sessions` instead of `/tmp`

## Infrastructure

- [x] Persistent session storage (`COMPANION_SESSION_DIR` in systemd service)
- [x] AI validation URL override (`COMPANION_AI_VALIDATION_URL` in systemd service)
- [x] Bun patch workflow for local customizations
- [x] Git repo with backup on GitHub (`lazmo88/companion` — `openclaw/patch-backup` branch)
- [ ] Prevent auto-updater from wiping patches (pin version or disable auto-update)
