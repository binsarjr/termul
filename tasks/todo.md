# Drag-drop → auto-upload to SSH host — 2026-06-12

Goal: when a file is dropped onto a pane that is currently SSHed into a host,
upload it to `~/.termul-uploads/` on that host (reusing the explorer's
ControlMaster — no re-auth) and insert the **remote** absolute path at the
prompt, so a remote `claude` can read it. Non-SSH panes keep today's behavior
(insert the local path). Paste-image is a later phase.

Decisions (locked by user):
- Destination: remote temp dir `${TMPDIR:-/tmp}/termul-uploads` (OS-appropriate;
  resolved + mkdir'd in one remote exec). [updated 2026-06-12 from ~/.termul-uploads]
- Transfer: `scp` over the existing ControlMaster socket (`-o ControlPath=`).
- UX: automatic, with a sonner toast (loading → success/error).
- Scope now: drag-drop only. Paste deferred.

## Phase 1 — Rust backend (3 files)
- [x] `ssh/ops.rs`: `upload_file(state, host, local_path) -> remote_abs_path`
      + `sanitize_upload_name` + 4 unit tests
- [x] `ssh/mod.rs`: `#[tauri::command] ssh_upload_file`
- [x] `lib.rs`: registered `ssh::ssh_upload_file`

## Phase 2 — Frontend (2 files)
- [x] `useTerminalSession.ts`: `sshHostForSession(leafId)` export
- [x] `useTerminalFileDrop.ts`: raw paths threaded; SSH branch →
      `uploadDroppedFiles` (sequential invoke + sonner toast + remote insert)

## Phase 3 — Verify
- [x] `useTerminalFileDrop.test.ts`: +`paths` in drop assertions, +raw-paths case
- [x] `cargo check` + `cargo clippy --lib` clean
- [x] `tsc --noEmit` clean, `vitest run` 389/389
- [x] `vite build` OK; modulepreload still 5 chunks (react/xterm/utils/radix/motion)
- [x] `cargo test --lib upload_tests` 4/4
- [ ] (manual, later) `pnpm tauri dev`: drop image while SSHed → toast → remote
      path inserted → `claude` reads it

## Phase 4 — Paste-image backend (4 files) ✅
- [x] `Cargo.toml`: `base64 = "0.22"` (resolved to locked 0.22.1)
- [x] `modules/mod.rs`: `pub mod paste;`
- [x] `modules/paste.rs`: `materialize_paste_image` + `sanitize_ext` + 2 unit tests
- [x] `lib.rs`: `paste` in `use`, `paste::materialize_paste_image` registered

## Phase 5 — Paste-image frontend (4 files) ✅
- [x] `remoteUpload.ts` (new): `quotePathsForShell`, `uploadDroppedPaths`,
      `pasteImage` — no session import (acyclic). Consolidated drop+paste upload UX.
- [x] `useTerminalFileDrop.ts`: now uses `uploadDroppedPaths`; `formatDropPaths`
      delegates to `quotePathsForShell`; dropped the duplicated helper block.
- [x] `rendererPool.ts`: `LeafBridge.handlePasteImage?`; capture-phase `paste`
      listener on slot `host` (image-only preventDefault; text paste untouched).
- [x] `useTerminalSession.ts`: bridge `handlePasteImage` → `pasteImage({host:
      s.sshHost, blob, mime})` → `s.pty.write(path + " ")`.

## Phase 6 — Verify paste ✅
- [x] `cargo check`/`clippy --lib` clean, `cargo test paste` 2/2
- [x] `tsc` OK, `vitest` 389/389, `vite build` OK; modulepreload still 5 chunks
- [ ] (manual) `pnpm tauri dev`: Cmd+V image while SSHed → upload → remote path;
      local pane → local temp path; text paste still normal

### Review (paste)
- Interception via a capture-phase `paste` listener on the slot host — fires
  before xterm's textarea handler, only claims the event when an image is present,
  so text paste is completely unaffected. Decoupled from sessions via the new
  optional `LeafBridge.handlePasteImage` (no circular import).
- Upload UX consolidated into `remoteUpload.ts`; drop + paste now share one path.
- Image bytes cross IPC as base64 (simple/confident vs Tauri binary-channel
  guesswork). Fine for screenshots; very large pastes pay a ~33% wire overhead.
- Still needs a real GUI run to confirm WKWebView populates `clipboardData.items`
  with the image on macOS Cmd+V (high-confidence, but unverified at runtime).

### Known limitations (documented, not bugs)
- SSH detection is heuristic (typed `ssh user@host`); alias/mosh/nested-ssh not
  detected → falls back to local-path insert.
- Upload ControlMaster re-auths (BatchMode); passphrase key not in ssh-agent
  fails even if the interactive terminal ssh succeeded.
- Folders rejected (no `-r`); same-name re-upload overwrites in the scratch dir.
- Non-ASCII/space filenames are sanitized to `_` for scp-mode-independence.
- Windows client → remote (scp drive-letter parsing) untested; user is macOS.

### Review
(to fill after implementation)
