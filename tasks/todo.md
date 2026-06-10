# SSH per-command blocks — 2026-06-10

Plan: ~/.claude/plans/transient-sleeping-kazoo.md. Scope user: Pendekatan 1+2
(poles nested OSC 133 + heuristic prompt-boundary utk remote stock).

## Phase A — Pure helpers (historyMatch.ts)
- [x] A.1 isCleanPromptRow(rowText, cursorX) + commandFromPromptRow(rowText, cursorX)
- [x] A.2 historyMatch.test.ts: 14 kasus baru (prompt bersih/ketikan/Password:/RPROMPT/sigil-EOL/pinned false-positive)

## Phase B — Engine (osc-handlers.ts)
- [x] B.1 CommandBlock.source + beginCommand(source); call site pakai `detected` (fix bare-C) + depth>1 → remote
- [x] B.2 CommandBlockRing.pushClosed() publik (force-push open dulu)
- [x] B.3 initialDepth opt + sawNestedCommand() expose + export registerMarkerSafe(term, offset)
- [x] B.4 osc-handlers.test.ts: ekstensi makeBlockTerm (setRow/getLine, registerMarker offset-aware) + 8 tes baru

## Phase C — Heuristic tracker (remoteBlocks.ts BARU)
- [x] C.1 createRemoteBlockTracker: Enter→pending (marker cursor & cursor+1 pra-echo), settle 150ms→pushClosed, type-ahead close, alt-screen defer, cancel/dispose ketat (pool reuse)
- [x] C.2 remoteBlocks.test.ts — 13 tes (fake term + fake timers)

## Phase D — Wiring + UI
- [x] D.1 useTerminalSession: initialDepth `fromSpill ? 0 : s.sshHost ? 1 : 0`, tracker gated `!!s.sshHost && !prompt.sawNestedCommand()`, source di readBlock/CommandBlockView
- [x] D.2 blockController: BlockFrame.source + getActiveFrame
- [x] D.3 BlockHoverLayer: badge "remote" di toolbar (ref-imperatif, toggle di position())
- [x] D.4 blockController.test.ts: source ter-plumb (frame toEqual di-update), block heuristik interaktif

## Phase E — Verifikasi
- [x] E.1 tsc clean, vitest 338/338, pnpm build OK, modulepreload tetap 5 chunk
- [x] E.2a Runtime boot pnpm tauri dev bersih (4 PTY restore, 0 error/panic di log)
- [x] E.2b Manual user: awalnya GAGAL (nol block di ssh) → debug → fix → user konfirmasi works

## Debug "nol block di ssh" (laporan user)

Workflow 3 investigator + adjudicator; repro pipeline penuh dgn xterm ASLI
(remoteBlocks.integration.test.ts, tanpa DOM) lolos → logika benar, masalah
environmental. Akar masalah TERBUKTI di mesin user: `~/.zshrc` men-source
iTerm2 shell integration → aktif juga di Termul (gate-nya cuma tolak
tmux/screen/linux/dumb) → tiap perintah emit DUA OSC 133 C (C; iTerm2 +
C;<cmd> termul) → saat `ssh`, depth 1→2 → `sawNestedCommand` latch true
sepanjang sesi → heuristic tracker mundur permanen → nol block (pill tetap
hidup karena onCommand fire di depth 1).

Fix:
- **osc-handlers.ts**: collapse C/D duplikat integrasi bertumpuk — C/D di
  baris buffer SAMA tanpa A/D (utk C) / A/C (utk D) di antaranya = perintah
  yang sama; tidak dihitung, tidak latch sawNested, tidak buka/tutup block.
  C nested asli selalu di baris lebih bawah (remote minimal echo newline) dan
  A remote me-reset dedup. Bonus: ring lebih bersih (1 block per perintah
  lokal, bukan 2 + 1 degraded).
- **zshrc.zsh + bashrc.bash**: marker B di-APPEND ke PS1 (sebelumnya prepend
  = kolom 0) — bug laten yang mematikan deteksi pill ssh di bash lokal
  (bare-C PS0 + typedCommand kebaca prompt+command) dan derivasi input
  autocomplete. fish sudah benar.
- PROMPT_SIGILS TIDAK dilebarkan ke ➜ (omz): sigil-nya di AWAL prompt, match
  boundary akan menelan segmen cwd/git ke label perintah. Tetap limitation.
- Tes: stacked-integration di osc-handlers.test.ts (3 kasus) + 2 skenario
  xterm-asli di remoteBlocks.integration.test.ts (8 tes integrasi total).
  Final: vitest 349/349, tsc clean. User konfirmasi works.

Follow-up (SEMUA SELESAI, post-v0.3.5 — naik di rilis berikutnya):
- [x] Race `write_if_changed` shell_init.rs — temp suffix kini unik
  (`.__termul_tmp__<pid>_<seq>` via AtomicU64) di kedua copy (unix+windows);
  4 PTY spawn serentak tidak lagi saling curi file temp. cargo check clean.
- [x] Laggy echo: Enter sebelum echo ter-parse kini membuka pending
  PROVISIONAL (command null), lalu command di-re-read dari baris prompt
  saat block ditutup (`commandFromPromptRowText`, strip RPROMPT yang nempel
  tepi kanan). Bare Enter → cancel di settle, marker di-dispose. V1
  integration test dibalik: sekarang assert "ls" TERTANGKAP; V1b baru
  meng-cover bare Enter. Late read diprioritaskan di atas partial read.
- [x] Stale s.sshHost: `clearShellLifecycleState` di onExit + respawnSession
  (close() tidak menjalankan exit callback) — clear sshHost/remoteOsc7Seen,
  notify onSshHost(null), dan `promptTracker.resetNesting()` (depth/sawNested/
  dedup rows) supaya shell baru mulai dari state bersih.

## Review (SSH per-command blocks)

- **Fix bash bare-C**: `beginCommand` kini menerima `detected` (payload ATAU
  buffer-read) — block lokal di bash (PS0 emit `C` polos) jadi interaktif.
  Keamanan tetap: buffer-read hanya saat commandStart di-pin B dengan A hidup.
- **Penanda remote**: `CommandBlock.source` ("remote" saat depth C > 1 atau
  block heuristik) → `BlockFrame.source` → badge "remote" di hover toolbar.
- **Fix wake/depth**: `initialDepth` seed `s.sshHost ? 1 : 0` saat rebind
  (jalur spill tetap 0 karena replay transkrip penuh) — replay dormant tail
  mid-ssh tidak lagi menghapus pill ssh.
- **Heuristic remote blocks** (`remoteBlocks.ts`): utk remote stock tanpa
  OSC 133. Enter di baris prompt (sigil+spasi) buka pending (marker pra-echo);
  cursor settle 150ms di baris prompt bersih tutup block (`pushClosed`
  force-flush block ssh luar agar tidak shadow). Stand down otomatis saat
  remote ternyata punya OSC 133 (`sawNestedCommand`). exitCode selalu null
  (dot abu). Batasan terdokumentasi di plan: wrapped/multi-line tidak
  tertangkap, output mirip prompt bisa nutup kepagian, exit `ssh` tak jadi
  block, prompt tanpa sigil ($#%❯) tidak terdeteksi.
- Verif: 338 tes (52 baru), tsc/build clean, boot dev bersih. Sisa: tes manual
  ssh oleh user (E.2b).

---

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
