# Companion Customizations — Roadmap

## Submitted PRs (upstream)

- [x] **Show hidden files + mkdir in folder picker** — [#382](https://github.com/The-Vibe-Company/companion/pull/382)
- [x] **Mobile ribbon layout for chat input** — [#383](https://github.com/The-Vibe-Company/companion/pull/383)
- [x] **Default bypassPermissions mode** — [#384](https://github.com/The-Vibe-Company/companion/pull/384)

## Applied locally (bun patch, not yet submitted)

- [x] Continue Session page (`/continue` route) — resume external CLI sessions
- [x] 4-mode permission dropdown (default/accept-edits/yolo/plan)
- [x] Per-session draft message storage
- [x] Session rename via double-click on title
- [x] Continue Session tab in creation UI
- [x] Session browser — auto-discover Claude Code sessions from `~/.claude/` on Continue page

## Planned features

- [ ] **Resume external CLI sessions** — Submit `/continue` route as proper React page PR upstream
- [ ] **Per-session draft storage** — Implement properly in Composer.tsx (save/restore unsent text per sessionId)
- [ ] **Fine-tuning sessions** — Allow adjusting session parameters after creation (model, permission mode, cwd, environment variables, etc.)
- [ ] **Copy chat conversation** — Easy copy button/function in the chat view to copy message content, full conversation, or code blocks to clipboard
- [ ] **Persistent session storage by default** — Propose upstream: default `COMPANION_SESSION_DIR` to `~/.companion/sessions` instead of `/tmp`

## Infrastructure

- [x] Persistent session storage (`COMPANION_SESSION_DIR` in systemd service)
- [x] Bun patch workflow for local customizations
- [x] Git repo with backup on GitHub (`lazmo88/companion` — `openclaw/patch-backup` branch)
