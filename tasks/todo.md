# Perf audit fixes — 2026-06-10

Sumber: tasks/perf-audit-2026-06-10.md (34 temuan terkonfirmasi, 21 item merged).

## Wave 1 (paralel, file disjoint) — SELESAI, verified
- [x] 1.1 manualChunks mermaid (`vite.config.ts`) — mermaid keluar dari preload
- [x] 1.2 Lazy MarkdownStack/PdfStack + hapus barrel re-export — codemirror/pdfjs/katex lazy
- [x] 1.3 useWhisperRecording dynamic import @ai-sdk/openai
- [x] 1.5 Hapus dead code getUsage/tokenlens (AiMiniWindow chunk 306K→62K)
- [x] 1.7 Font woff2-only + drop KaTeX ttf/woff dari dist (0 legacy font)
- [x] 4.5 Startup: Promise.all + command get_launch_info gabungan (get_launch_dir dihapus, provably unused)
- [x] 1.4 Lazy-load icon Catppuccin — icons-*.js 310K jadi lazy chunk
- [x] 2.1 experimental_throttle: 50 di kedua useChat
- [x] 2.2 estimateTokens early-return saat lastInput > 0
- [x] 3.1 rAF loop terminal → event-driven (park/kick lifecycle, geometry math untouched)
- [x] 4.1 spawn_blocking untuk fs commands (+ fs_glob, sekelas)
- [x] 4.7 sort_by_cached_key + hidden-filter-before-stat
- [x] 4.2 shell spawn_blocking, inner thread dihapus, timeout 300s tetap
- [x] 4.6 ringbuffer drain bulk
- [x] 4.4 writePref tanpa save() eksplisit; slider persist di onValueCommit

Verifikasi wave 1: pnpm build OK (main 1016K→688K; modulepreload tinggal react/xterm/streamdown/radix/ai-sdk-shared/motion); vitest 284/284; cargo test 213/213; clippy clean.

Follow-up wave 1: pattern `useState + useEffect sync` dari fix slider (react-doctor: no-derived-state-effect) di-refactor ke hook `useSliderDraft` (render-phase prev-comparison, tanpa effect) — src/settings/lib/useSliderDraft.ts, dipakai di GeneralSection (zoom) + ThemesSection (opacity, blur). tsc clean. Temuan doctor lain di scan dev→main = pre-existing branch code, di luar scope goal ini (akan dicatat di laporan akhir).

## Wave 2 (setelah wave 1 verified) — SELESAI, verified
- [x] 2.3 React.memo TabBar/Header; semua prop distabilkan (refs + useCallback); doRefresh skip isLoading saat snapshot ada (1 render, bukan 2); bonus: filter/map TabBar digabung
- [x] 3.2 rendererPool: term.clear()+reset() saat detach + WebGL dispose via idle-TTL 45s (cancel di bind/rewire)
- [x] 3.3 pty_set_dormant: Rust DormantTail ring 256KB, zero IPC saat hibernated, splice in-order saat wake (registerOsc-before-drain terjaga); aktif hanya saat dropHibernatedOutput=true
- [x] 3.4 Flusher PTY: done flag pindah ke dalam pending mutex, wait_timeout → cv.wait untimed; zero idle wakeups; +5 test dormant baru
- [x] 4.3 net.rs: body Option<String>, chunk via Channel<tauri::ipc::Response> raw bytes, end sentinel zero-length (anti race); JS enqueue Uint8Array langsung
- [x] Bonus: hapus dead command ai_http_request + struct HttpResponse (0 caller)

Verifikasi wave 2: pnpm build OK; vitest 284/284; cargo test 218/218 (163 lib incl 5 dormant baru); clippy clean.

## Wave 3 — SELESAI, verified
- [x] 1.6 chatRuntime.ts baru (makeChat/getOrCreateChat/sendMessage/stop); chatStore tinggal plain state + import type; composer & review.ts dynamic-import runtime; experimental_transcribe ikut dynamic
- [x] Streamdown de-coloring: chunk `utils` baru (clsx/tailwind-merge/cva/vite preload-helper) → streamdown & ai-sdk-shared jadi lazy murni

## Verifikasi final — SEMUA HIJAU
- [x] pnpm build OK; dist/index.html modulepreload final: react, xterm, utils, radix, motion (+2 CSS). Mermaid/codemirror/pdfjs/katex/streamdown/ai-sdk-shared/ai-openai/icons semua lazy
- [x] npx tsc --noEmit clean
- [x] vitest 284/284
- [x] cargo test 218/218 (163 lib + 23 fs_search + 25 git_ops + 7 shell_bg); clippy clean
- [x] Runtime smoke `pnpm tauri dev`: vite ready 306ms, Rust compile OK, app jalan, PTY open id=1 — boot frontend→IPC→terminal sukses, nol error/panic di log

## Review

Angka kunci (sebelum → sesudah):
- Eager JS startup (modulepreload): ~7.4 MB → ~1.64 MB (main 1016K→644K; mermaid 2.88M, codemirror 1.14M, streamdown 482K, pdfjs 425K, ai-sdk-shared 399K, icons 310K, katex 259K, ai-openai 95K semua keluar)
- AiMiniWindow chunk 306K→62K (dead code tokenlens)
- Dist: 0 font legacy (ttf/woff); ~886 KB raw dihapus
- Idle CPU: rAF loops park saat idle (0 callback); flusher PTY 0 wakeup idle (sebelumnya 20/s/tab); tab hibernated 0 IPC
- Memory/GPU: slot detached di-reset + WebGL dispose TTL 45s
- UI freeze: fs_grep/search/read pindah ke spawn_blocking
- Catatan QA manual (belum diobservasi visual): markdown/pdf/mermaid pane pertama kali dibuka (lazy), ghost autocomplete + hover toolbar di zoom≠1, slider settings (preview live, persist saat release), hibernate tab dengan `yes` lalu wake, AI streaming provider lokal (Ollama)
- Temuan react-doctor pre-existing (dev→main, di luar scope perf): ExplorerSearch (state-sync effects), FileExplorer, GitHistoryPane, SourceControlPanel — kandidat cleanup terpisah

---

# Arsip: Autocomplete fixes (trace 2026-06-10) — selesai

Verified: 284 FE tests + tsc clean; 158 Rust tests + clippy clean.
Catatan deferred yang masih relevan:
- Smart-case/frequency ranking butuh buffer-rewrite design.
- Ghost untuk wrapped multi-row input.
- rAF polling pattern di TerminalAutocompleteLayer/BlockHoverLayer → sekarang ditangani item 3.1 di atas.
