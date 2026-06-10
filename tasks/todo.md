# Session restore (reopen all tabs + scrollback) — 2026-06-10

Plan lengkap: ~/.claude/plans/transient-sleeping-kazoo.md. Scope: Tingkat 2
(struktur tab + isi layar). ROADMAP.md:106.

## Phase 1 — Persistensi struktur tab (frontend)
- [x] 1.1 settings/store.ts: pref `restoreSession` (default true) + `readRestoreSessionPref()`
- [x] 1.2 lib/launchDir.ts: `getExplicitLaunchDir()` (CLI launch_dir saja)
- [x] 1.3 tabs/lib/sessionStore.ts (baru): LazyStore termul-session.json, sanitize, saveSession debounced, initSessionRestore (validasi cwd via workspace_authorize + fs_stat sweep), buildBootState (nextId = max semua id +1, append explicit-launch tab)
- [x] 1.4 main.tsx: initSessionRestore() di Promise.all pre-render
- [x] 1.5 useTabs.ts: seed state dari buildBootState; save effect gated hydrated && restoreSession
- [x] Verif: tsc clean, vitest 284/284

## Phase 2 — Snapshot scrollback
- [x] 2.1 src-tauri modules/snapshots.rs (baru): save (async+spawn_blocking, atomic, 8MiB reject) / load / prune (64MiB budget)
- [x] 2.2 daftar di modules/mod.rs + lib.rs invoke_handler
- [x] 2.3 terminal/lib/sessionSnapshots.ts (baru): format TSNAP1, debounce timestamp 2s/maxWait 30s, persist (skip altScreen + private), load take-once, flush, prune
- [x] 2.4 rendererPool.ts: ladder 2MiB di serializeSlot + export serializeLeaf
- [x] 2.5 useTerminalSession.ts: seed via session.ready, arm debounce di deliverPtyBytes, persist saat unbind, cancel saat respawn/dispose
- [x] Verif: tsc clean + cargo check clean

## Phase 3 — Close flush, UI, prune, tes, docs
- [x] 3.1 onCloseRequested flush — dipindah ke App.tsx (butuh React state utk dialog)
- [x] 3.2 wiring setRestorableLeaves/setPrivateLeaves + prune saat boot & save (leaf-set diff guard)
- [x] 3.3 settings GeneralSection: toggle "Restore tabs on launch" (off → clearSession)
- [x] 3.4 sessionStore.test.ts — 17 tes (sanitize, validate, buildBootState, TSNAP1)
- [x] 3.5 ROADMAP.md centang
- [x] Verif final: tsc clean, vitest 301/301, cargo check+clippy clean, pnpm build OK, modulepreload tetap 5 chunk (react/xterm/utils/radix/motion)

## Phase 4 — Confirm-before-close (permintaan lanjutan user)
- [x] Pref `confirmBeforeQuit` (default ON) + toggle "Confirm before closing" di GeneralSection
- [x] App.tsx: onCloseRequested → preventDefault + AlertDialog "Close Termul?"; confirm → flush sesi + destroy
- [x] FIX BUG: `core:window:allow-destroy` hilang di capabilities/default.json → window tak mau tertutup (lesson dicatat di lessons.md)
- [x] User konfirmasi manual: dialog tampil, cancel & close keduanya bekerja

## Review

Fitur session restore (ROADMAP "Persistent terminal sessions and layout restore") selesai:

- **Struktur tab** persist ke `termul-session.json` (LazyStore, debounce 250ms +
  autoSave 200ms): tabs, split paneTree, per-pane cwd, grup, tab aktif, custom
  title. Hydrate sinkron pre-render via `initSessionRestore()` (main.tsx
  Promise.all) → `buildBootState()` di useTabs — tanpa race, tanpa tab default
  yang dibunuh ulang. cwd divalidasi (workspace_authorize, strip yang mati) dan
  file path di-stat (drop tab yang filenya hilang) sebelum hydrate.
- **Scrollback** per-pane ke `app_data_dir/session-snapshots/<leafId>.ansi`
  (Rust `snapshots.rs`: save atomic/load/prune, budget 64MiB, backstop 8MiB;
  frontend ladder 2MiB). Capture saat hibernate + debounce timestamp 2s/maxWait
  30s saat visible (tanpa idle polling). Replay lewat jalur snapshot existing,
  dims di-seed dari header TSNAP1. Tab private tidak pernah ditulis ke disk.
- **Confirm-before-close** + flush sesi di handler close. Cmd+Q macOS bypass
  close-requested (Tauri #3124) — kerugian maksimal ~2-30 dtk scrollback pane
  visible; struktur tab aman (plugin-store flush on RunEvent::Exit).
- **Verifikasi runtime** (tauri dev): sesi sintetis 2 tab/3 pane → 3 PTY spawn
  di cwd benar (lsof), marker snapshot ter-replay & ikut ter-capture ulang
  (round-trip terbukti), file stale ter-prune, boot kedua restore 4 leaf
  (termasuk tab buatan user). User konfirmasi manual restore + confirm-close.
- Temuan react-doctor di scan dev→main = pre-existing (ExplorerSearch,
  GitHistoryPane, FileExplorer, SourceControlPanel, TerminalAutocompleteLayer,
  AutoSaveDelayInput) — bukan dari perubahan ini.
- Follow-up opsional belum dikerjakan: custom Quit menu utk flush saat Cmd+Q,
  dormant-ring append saat close-flush, sesi per-workspace, auto-reconnect SSH.
