# Audit Performa & Resource — Termul

Semua temuan di bawah sudah diverifikasi adversarial terhadap source code dan hasil build aktual (HEAD `823d72a`). Diurutkan per tema, quick wins duluan (impact gede, effort kecil).

---

## 1. Bundle & Startup JS

Catatan umum: karena ini Tauri app (asset di-serve dari disk lokal), "saving" di sini terutama berupa **parse/compile/eval time + memory saat startup**, bukan network transfer.

### 1.1 Chunk mermaid 2.88 MB ke-load statically di startup gara-gara `manualChunks` miss `@mermaid-js/parser`
- **File:** `vite.config.ts:57`, `dist/index.html:36`, `src/modules/markdown/MermaidDiagram.tsx:27`
- **Masalah:** Source code cuma pakai `await import("mermaid")`, tapi matcher `manualChunks` cuma cek `/mermaid/` dan `/dagre-d3-es/` — path `@mermaid-js/parser` lolos, jadi facade module-nya nyangkut di `main` dan bikin static edge ke seluruh chunk mermaid (2.884.674 bytes, di-modulepreload tiap launch). Ada 11 static import `@mermaid-js/parser` di 10 file dist mermaid yang jadi akar masalahnya.
- **Fix (one-liner, sudah diverifikasi via test build):** tambah matcher: `if (id.includes("/mermaid/") || id.includes("@mermaid-js/") || id.includes("/dagre-d3-es/")) return "mermaid";`. Verifikasi: `dist/index.html` nggak lagi modulepreload `mermaid-*.js` dan `grep 'from"./mermaid' dist/assets/main-*.js` kosong.
- **Efek:** ~2.88 MB JS hilang dari fetch+parse+eval startup. Impact **high**, effort **small** — quick win terbesar di repo.

### 1.2 MarkdownStack & PdfStack statically imported + barrel re-export bocor — codemirror (1.14 MB), katex (259 KB), pdfjs (425 KB) ikut ke startup
- **File:** `src/app/App.tsx:71-72`, `src/modules/markdown/index.ts:2`, `src/modules/pdf/index.ts:2`, `src/modules/markdown/MarkdownPreviewPane.tsx:4-11`, `src/components/ai-elements/chat-code-lezer.ts:2-3`, `src/modules/pdf/lib/pdfjs.ts:1`
- **Masalah:** App import barrel `@/modules/markdown` dan `@/modules/pdf`. Barrel-nya re-export `MarkdownPreviewPane` / `PdfViewerPane` secara eager (padahal nggak ada konsumen di luar modul masing-masing), dan keduanya bawa side-effect import (CSS katex/pdf_viewer, `GlobalWorkerOptions.workerSrc`) yang nggak bisa di-tree-shake. Rantai `MarkdownPreviewPane → PreviewCode → MarkdownCode → ChatCodeBlock → chat-code-lezer.ts` (static `StringStream` + `@lezer/highlight`) juga narik seluruh chunk codemirror 1.140.723 bytes ke entry.
- **Fix:** clone pattern `EditorStackLazy.tsx` yang sudah ada untuk `MarkdownStackLazy`/`PdfStackLazy`, **DAN wajib hapus re-export barrel** `MarkdownPreviewPane`/`PdfViewerPane` (tanpa ini, hasilnya nol — sudah dibuktikan via build). Opsional: bikin import di `chat-code-lezer.ts:2-3` jadi dynamic juga.
- **Efek (verified via build):** -1.83 MB JS (codemirror 1.140 KB + katex 259 KB + pdfjs 425 KB) + 203 KB blocking CSS dari startup; chunk mermaid juga keluar dari preload graph. Total bareng fix 1.1: ~4.3 MB deferred. Catatan: streamdown 482 KB *tetap* eager karena Rollup nge-color `clsx`/`tailwind-merge`/preload-helper ke chunk-nya — perlu tweak `manualChunks` terpisah kalau mau di-defer juga. **Penting:** working tree saat ini ada leftover setengah jadi dari test fix ini (`MarkdownStackLazy.tsx` untracked, `markdown/index.ts` & `vite.config.ts` modified) — selesaikan (sisi pdf + barrel cleanup) atau revert, jangan dibiarkan nanggung.
- Impact **high**, effort **small**.

### 1.3 `useWhisperRecording` static-import `@ai-sdk/openai`, bocorin chunk ai-openai (95 KB) ke startup
- **File:** `src/modules/ai/hooks/useWhisperRecording.ts:1-2` (via `composer.tsx:8` ← `App.tsx:34`)
- **Masalah:** Semua provider AI sudah lazy via `agent.ts:101`, kecuali hook whisper ini yang static-import `createOpenAI` padahal cuma dipakai di `transcribeBlob` (setelah user selesai rekam audio). Hasilnya `ai-openai-DQkylm6L.js` (95.240 bytes) ikut di-modulepreload.
- **Fix:** pindahin ke dynamic import di dalam `transcribeBlob`. Catatan: fix ini **sudah ter-apply uncommitted di working tree** oleh proses paralel — tinggal commit + rebuild. Dynamic import `"ai"`-nya kosmetik aja (package `ai` tetap di startup via ~20 modul lain), yang penting `@ai-sdk/openai`-nya.
- **Efek:** -95 KB parse/eval startup. Impact **medium**, effort **small** (praktis tinggal commit).

### 1.4 Seluruh icon set Catppuccin (~310 KB) di-inline dan di-`JSON.parse` saat startup
- **File:** `src/modules/explorer/lib/iconResolver.ts:1` (+ `fileIcons.ts`/`folderIcons.ts`)
- **Masalah:** `import catppuccinIcons from "@iconify-json/catppuccin/icons.json"` (659 icons, 1416 `<path>`) ke-bundle ke main chunk sebagai blob `JSON.parse('...')` 310.121 bytes — ~20% dari main chunk build sekarang (1.58 MB) — di-parse synchronous tiap launch. Lookup-nya dynamic by extension jadi tree-shaking mustahil.
- **Fix:** lazy-load: `await import("@iconify-json/catppuccin/icons.json")` di first explorer render, dengan fallback default file/folder icon lalu patch via `dataUrlCache` yang sudah ada. Tabel name→slug yang murah tetap synchronous.
- **Efek:** -310 KB dari main (fetch + scan string literal + eager JSON.parse); icon explorer hydrate telat 1 frame. Impact **medium-high**, effort **medium**.

### 1.5 Cost lookup `tokenlens` bawa katalog 687 model (~238 KB) — dan hasilnya dead code
- **File:** `src/components/ai-elements/context.tsx:14`
- **Masalah:** `import { getUsage } from "tokenlens"` nge-embed full model catalog ke chunk `AiMiniWindow` (306 KB, ~78%-nya katalog). Lucunya: `ContextContentFooter` selalu di-render dengan children (`AiMiniWindow.tsx:425-430`), jadi footer default yang nampilin cost dari `getUsage` **nggak pernah render** — app sudah punya `estimateCost` sendiri di `src/modules/ai/config`.
- **Fix:** hapus import `getUsage` + komputasi `costUSD` dari vendored `context.tsx`. Selesai.
- **Efek:** -~238 KB dari chunk AI window (lazy-loaded, jadi ini app-size + first-open parse, bukan startup). Impact **low**, effort **small** setelah tahu itu dead code.

### 1.6 `chatStore` eager `Chat` import nahan chunk ai-sdk-shared 399 KB (termasuk zod) di startup
- **File:** `src/modules/ai/store/chatStore.ts:1-5` (← `App.tsx:32`)
- **Masalah:** Import `Chat` dari `@ai-sdk/react` + value-import dari `"ai"` + `createContextAwareTransport` (yang grafnya narik `agent.ts` dan `tools/*` + zod) bikin `ai-sdk-shared-FnSExENj.js` (399.390 bytes) selalu di-preload, bahkan tanpa AI session.
- **Fix:** defer **seluruh** dependency graph `makeChat` (bukan cuma `@ai-sdk/react`) — misal split ke modul `chatRuntime` yang cuma di-import komponen AI yang sudah lazy; state plain di chatStore tetap static. Wajib barengan fix 1.3 (whisper edge), kalau nggak chunk-nya tetap nyangkut.
- **Efek:** ~400 KB keluar dari startup critical path. Buat user dengan AI key, `AgentRunBridge` tetap mount saat launch jadi chunk-nya tetap ke-load — tapi async setelah first paint, bukan blocking eval main. Impact **medium**, effort **large** — kerjain belakangan.

### 1.7 ~886 KB font format legacy (ttf/woff) yang nggak pernah di-request webview
- **File:** `src/main.tsx:1-4` (@fontsource/jetbrains-mono), CSS katex → 59 file `KaTeX_*` di dist
- **Masalah:** WKWebView/WebView2 selalu milih woff2, tapi dist ship KaTeX ttf (513.664 B) + woff (303.116 B) + duplikat jetbrains-mono woff (69.696 B). `fonts.css:7-15` sudah contoh benar: Inter woff2-only.
- **Fix:** ganti import @fontsource dengan @font-face woff2-only (pattern Inter), + vite plugin kecil (generateBundle hook) yang drop asset `/KaTeX_.*\.(ttf|woff)$/` dan strip src()-nya dari CSS. Catatan: KaTeX punya 20 family; `KaTeX_Size3-Regular.woff2` di-inline base64 di CSS, sisanya file.
- **Efek:** -~886 KB raw dist (realistis 500–880 KB di installer setelah kompresi Tauri). Ini murni installer size, **bukan** runtime perf. Impact **low-medium**, effort **small**.

---

## 2. Hot Path Streaming AI (React render)

### 2.1 `useChat` tanpa `experimental_throttle` → re-render per network chunk
- **File:** `src/modules/ai/components/AgentRunBridge.tsx:64`, `src/modules/ai/components/AiMiniWindow.tsx:175`
- **Masalah:** Kedua call site subscribe unthrottled — tiap stream chunk (bisa 100+/detik di provider cepat) trigger `useSyncExternalStore` update: Bridge ngerjain dua useMemo O(transcript) per chunk (`approvalsPending` :96-105, `fileMutationFingerprint` :142-160), plus seluruh Body→Header→AiChatView di mini window ikut re-render. `@ai-sdk/react` 3.0.170 yang terpasang sudah support `experimental_throttle`.
- **Fix:** `useChat({ chat, experimental_throttle: 50 })` (atau ~100ms) di kedua tempat.
- **Efek:** per-chunk render collapse jadi ~10-20/s tanpa perubahan UX kelihatan; memo O(transcript) dan Streamdown re-parse (untuk message yang lagi streaming) turun proporsional. Impact **high**, effort **small**.

### 2.2 `estimateTokens` JSON.stringify seluruh tool input/output transcript tiap message update
- **File:** `src/modules/ai/components/AiMiniWindow.tsx:315-331, 344-346`
- **Masalah:** useMemo `estimateTokens(messages)` jalan tiap streamed chunk (selama mini window kebuka), serialize semua tool part — output tool bisa puluhan KB — padahal hasilnya cuma dipakai kalau `lastInput === 0` (belum ada token count beneran).
- **Fix:** early-return 0 dari memo kalau `lastInput > 0`. Itu aja sudah cover steady-state.
- **Efek:** ngilangin biaya CPU O(transcript-bytes) per token append; digabung throttle fix 2.1, mini window jadi murah saat streaming. Impact **medium**, effort **small**.

### 2.3 Header/TabBar re-render tiap App-wide state flip; refresh source-control double-render seluruh App tree
- **File:** `src/modules/tabs/TabBar.tsx:108,186,248-505`, `src/app/App.tsx:1190,1777,1793`, `src/modules/source-control/useSourceControl.ts:183,271-279`
- **Masalah:** Header/TabBar/TerminalStack/StatusBar nggak ada yang `React.memo`. TabBar render Radix ContextMenu root/trigger + ~12 inline handler per tab. Tiap git refresh (focus-driven, debounced 400ms / max 1×1.5s) setState 2× → seluruh App tree (~2000 baris) render 2×, termasuk tab strip.
- **Fix:** wrap TabBar/Header di `React.memo`; `useCallback` dua inline closure (`onNewEditor` App.tsx:1777, `onOpenSettings` :1793) — itu memo-defeater aslinya; juga stabilkan `onNewGitGraph` (baca sourceControl via ref) biar memo hold di semua path. Opsional: skip setState `isLoading: true` kalau snapshot repo sudah ada, biar refresh background settle 1 render.
- **Efek:** ngilangin re-render tab strip + context menu reconciliation per refresh/state flip — kerasa di sesi dengan banyak tab. Impact **medium**, effort **medium**.

---

## 3. Terminal: Idle CPU & Memory

### 3.1 Dua rAF loop unconditional jalan 60–120 Hz selama pane terminal fokus, walau idle total
*(merge dari 3 dimensi: react-render, terminal-hotpath, leaks-idle)*
- **File:** `src/modules/terminal/BlockHoverLayer.tsx:156-176`, `src/modules/terminal/TerminalAutocompleteLayer.tsx:62-95`, `src/modules/terminal/lib/autocompleteController.ts:104-147,182-229`, `TerminalPane.tsx:221-234`
- **Masalah:** Kedua layer self-reschedule rAF selamanya selama `active={visible && focused}` — yaitu praktis selalu, untuk sebuah terminal app. Saat idle empty prompt: 2 wakeup/frame + 1 alokasi string `translateToString` + 3 style write redundant per frame. Saat ada input nganggur di prompt: `matchHistory` scan history (worst case 5000 entries, cap di `src-tauri/src/modules/history.rs:20`) per frame + layout read. Saat block hovered: 2× `getBoundingClientRect` per frame. Ini headline idle-CPU metric buat terminal emulator — display link WKWebView nggak pernah tidur.
- **Fix:** bikin event-driven. BlockHoverLayer: start loop saat hover/selection, stop setelah `getFrame()` null. Autocomplete: gate via `term.onData`/`onCursorMove`/`onScroll` (controller sudah hook onData), stop setelah `getRender()` null; cache hasil `ghostSuffix` keyed by input string biar frame berulang skip history scan. Reposisi geometry dari xterm `onRender`/`onScroll` + mousemove handler yang sudah rAF-throttled.
- **Efek:** idle CPU/energy turun dari 120–240 callback/s ke ~0 saat nggak ada apa-apa untuk di-track; GC churn dari alokasi string per-frame hilang. Impact **high**, effort **medium**.

### 3.2 Renderer pool nahan WebGL context + scrollback buffer slot detached selamanya
*(merge: terminal-hotpath + leaks-idle)*
- **File:** `src/modules/terminal/lib/rendererPool.ts:519-543` (detach), `:20` (POOL_MAX_SIZE=10), `:325-326` (bindSlot reset), `:397-414` (stale rebind path)
- **Masalah:** `detachSlotFromLeaf` parkir slot ke recycler off-screen tanpa `term.reset()` dan tanpa `disposeSlotWebgl()`. User yang pernah buka 10 pane lalu balik ke 1 ninggalin 9 slot idle, masing-masing megang WebGL context (char-atlas texture + framebuffers, multi-MB GPU memory) + scrollback CircularList (default 2000, bisa sampai 50.000 baris) — selamanya. Padahal rebind selalu replay dari snapshot, jadi retain buffer itu pure waste; dan `bindSlot` sudah toleran addon hilang (re-attach via `scheduleUnhide`).
- **Fix:** di `detachSlotFromLeaf` setelah serialize: `slot.term.clear(); slot.term.reset();` (lossless, langsung aman). Untuk WebGL: dispose lewat **idle-TTL timer** (~30-60s, di-cancel saat rebind) — **jangan** immediate, karena detach juga jalan synchronous di slot-steal path `acquireSlot` (rendererPool.ts:305) dan immediate dispose bakal maksa context create + atlas regen tiap tab switch.
- **Efek:** memory (JS heap + GPU) yang ditahan slot idle turun ke nol setelah TTL; nggak ada regresi tab-flip. Impact **medium**, effort **small**.

### 3.3 Tab hibernated tetap nerima tiap chunk PTY output lewat IPC cuma buat di-drop di JS
- **File:** `src/modules/terminal/lib/useTerminalSession.ts:302-317`, `src/modules/terminal/lib/dormantRing.ts:1-2`, `src-tauri/src/modules/pty/session.rs:260`
- **Masalah:** Rust nggak kenal konsep dormant — flusher kirim semua chunk via channel. JS-nya: kalau spill aktif, chunk dibuang total (Rust sudah nulis ke spill file); kalau nggak, masuk ring 256 KB. Background job berisik (build, log tail) bayar IPC cross-process + WebView wakeup + alokasi ArrayBuffer per chunk untuk byte yang maksimal 256 KB terakhirnya doang yang kepakai (saat `dropHibernatedOutput` default on).
- **Fix:** tambah command `pty_set_dormant(id, bool)` mirroring pattern setSpill: saat dormant, flusher Rust buffer ke tail ring in-process, frontend baca sekali pas wake. Panggil dari bindLeafToSlot/unbindLeafFromSlot. **Catatan:** harus hormati preferensi `dropHibernatedOutput=false` (ringCaps = Infinity → keep semua), jadi buffer Rust-nya nggak boleh selalu bounded.
- **Efek:** wakeup WebView + IPC traffic untuk tab hibernated turun ke nol selama background job jalan. Impact **medium**, effort **medium**.

### 3.4 Flusher PTY bangun tiap 50ms per tab walau shell idle total
*(merge dari 3 dimensi: terminal-hotpath, rust-backend, ipc-events)*
- **File:** `src-tauri/src/modules/pty/session.rs:22, 240-246, 295-306`
- **Masalah:** `FLUSH_MAX_IDLE = 50ms` → 20 wakeup/s per session, 10 tab = 200 wakeup/s, di atas threshold ~150/s yang di-flag macOS untuk battery impact. Timeout-nya ada karena beneran ada lost-wakeup race: waiter set `done` + `notify_all()` **tanpa** megang pending mutex (:305-306).
- **Fix:** set flag `done` sambil megang `pending` mutex (waiter sudah ambil lock di :296 untuk tail snapshot, taruh di situ), lalu ganti `wait_timeout` jadi `cv.wait` untanggal — zero idle wakeups. **Jangan** sekadar ganti ke plain `cv.wait` tanpa fix lock-nya — bakal kena permanent thread hang di race tersebut. Alternatif minimal: naikkan FLUSH_MAX_IDLE ke 1s (worst case flusher linger ~1s pas shutdown, harmless).
- **Efek:** ini perbaikan **energy/idle-wakeups** (battery, Activity Monitor "Idle Wake Ups"), bukan throughput — per wakeup cuma microseconds. Impact **low-medium**, effort **small**.

---

## 4. Rust Backend & IPC

### 4.1 Command filesystem berat jalan synchronous di main/UI thread
- **File:** `src-tauri/src/modules/fs/grep.rs:46-47`, `fs/search.rs:45-46,146-147`, `fs/file.rs:49-50,93-94`, `history.rs:200-201`
- **Masalah:** `fs_grep` (parallel full-tree walk + regex), `fs_search` (scan 50k entries), `fs_read_bytes` (`std::fs::read` sampai 100 MB), `fs_read_file`, `read_shell_history` semuanya non-async command — di Tauri 2 itu dieksekusi inline di webview main thread (`Webview::on_message`). Grep repo gede = UI freeze ratusan ms sampai detik. Modul git sudah benar (`spawn_blocking` via helper `blocking()`).
- **Fix:** ubah jadi `async fn` + bungkus body di `tauri::async_runtime::spawn_blocking`, persis mirror `git/commands.rs:10-21`. (Jangan pakai `#[tauri::command(async)]` doang — itu malah blokir worker tokio di walk multi-detik.)
- **Efek:** ngilangin UI freeze multi-ratus-ms s.d. multi-detik saat repo-wide grep, explorer search, baca PDF gede, dan first-load shell history. Impact **high**, effort **small**.

### 4.2 `shell_run_command` / `shell_session_run` blokir tokio worker dengan `rx.recv()` sampai 300s + thread redundant per command
- **File:** `src-tauri/src/modules/shell/mod.rs:70-75, 220-224`, `shell/session.rs:90-100`
- **Masalah:** `thread::spawn` + blocking `rx.recv()` di dalam async command = 1 worker tokio ke-park sepanjang durasi command (max 300s). `ShellSession::run` spawn thread kedua lagi. Worst case (concurrent shell call ≥ jumlah worker, biasanya 8-16) semua async command lain ikut tersendat; common case-nya 1 worker parked + 1-2 thread spawn mubazir per call.
- **Fix:** ganti dengan `tauri::async_runtime::spawn_blocking(...).await` (pattern git/commands.rs), hapus inner thread spawn di `ShellSession::run`. Panic isolation tetap kejaga via `JoinError`.
- **Efek:** worker tokio bebas, dua thread spawn per AI shell call hilang. Impact **medium**, effort **small**.

### 4.3 Streaming AI lokal kirim tiap chunk sebagai JSON array of numbers (~4× inflasi + per-byte parse)
*(merge: rust-backend + ipc-events)*
- **File:** `src-tauri/src/modules/net.rs:350-352, 364, 412-418`, `src/modules/ai/lib/proxyFetch.ts:6, 29-48, 115`
- **Masalah:** `Chunk { bytes: Vec<u8> }` via `Channel<AiStreamEvent>` di-serialize serde_json → tiap byte jadi ~4 char desimal, lalu di JS `Uint8Array.from(number[])` per token chunk. Request body juga sama (`Array.from(encode(body))`). **Scope:** path ini cuma dipakai provider lokal/custom (Ollama, LM Studio, MLX, openai-compatible — `agent.ts:176-206`); cloud provider pakai fetch native. Tapi model lokal streaming-nya kenceng, dan overhead-nya nimpa webview main thread barengan re-render per-token.
- **Fix:** body → `Option<String>` (AI SDK post JSON text; kasih fallback buat ArrayBuffer/Blob input), data chunk → channel kedua raw bytes `Channel<tauri::ipc::Response>` persis pattern PTY (`pty/session.rs:109,260`). **Hati-hati:** (a) jangan `from_utf8_lossy` per chunk — boundary chunk bisa motong UTF-8 multi-byte, hasilnya U+FFFD; (b) end/error di channel JSON terpisah bisa race ordering vs chunk terakhir — pakai raw message zero-length sebagai end sentinel atau framing in-band.
- **Efek:** payload streamed ~4× lebih kecil + ngilangin JSON parse per-byte & GC pressure di main thread selama tiap respons AI lokal. Impact **medium-high** (buat user model lokal), effort **medium**.

### 4.4 Slider preferensi nulis full settings file ke disk + emit cross-window event tiap drag tick
- **File:** `src/modules/settings/store.ts:207, 215-219`, `src/settings/sections/ThemesSection.tsx:338,351`, `GeneralSection.tsx:172`
- **Masalah:** `writePref` selalu `store.set` + **`store.save()` eksplisit** + `emit` — padahal LazyStore sudah dikonfigurasi `autoSave: 200`. Slider Radix (opacity step 0.01, blur, zoom) manggil ini dari `onValueChange` yang fire tiap pointer move → drag 1 detik = puluhan disk write + IPC + broadcast.
- **Fix:** hapus `await store.save()` di writePref (biarkan autoSave batch), keep emit buat live preview; dan/atau persist di `onValueCommit` dengan preview dari local state (varian ini yang bener-bener ngilangin IPC per-tick).
- **Efek:** disk write saat drag turun dari per-pointer-move ke max 5/s atau 1× per release. Impact **medium**, effort **small**.

### 4.5 Startup blokir first render di 3 IPC round-trip berurutan
- **File:** `src/main.tsx:20-23`, `src/lib/launchDir.ts:6-9`, `src-tauri/src/lib.rs:13`
- **Masalah:** `await pty_close_all` → `await get_launch_dir` → `await workspace_current_dir` serial sebelum `ReactDOM.render` (launch GUI normal tanpa CLI arg = 3 round-trip; dengan CLI dir = 2).
- **Fix:** `Promise.all([pty_close_all, initLaunchDir()])` + gabung dua invoke launch-dir jadi satu command Rust.
- **Efek:** kecil tapi gratis — hemat ~2 round-trip latency (low single-digit ms, lebih kerasa di cold webview/Windows). Impact **low**, effort **small**.

### 4.6 `BoundedRingBuffer` evict overflow per-byte pakai loop `pop_front`
- **File:** `src-tauri/src/modules/shell/ringbuffer.rs:41-47`, `shell/background.rs:14,150-154`
- **Masalah:** Setelah cap 4 MiB kena, tiap push 8 KiB jalanin sampai 8192 `pop_front` di dalam mutex. Tiap pop O(1) sih, jadi ordenya microseconds per push — tapi tetap kerjaan mubazir di dalam lock. (FYI: cost lock-hold yang lebih gede di modul ini adalah `read_from` yang copy sampai 4 MiB di dalam lock tiap poll `read_logs`.)
- **Fix:** `self.buf.drain(..overflow);` — untuk u8 jadi head-index bookkeeping doang.
- **Efek:** lock-hold time lebih pendek; beberapa persen core saat proses streaming puluhan MB/s. Impact **low**, effort **small**.

### 4.7 Sort listing/search alokasi lowercase String per comparison; filter hidden jalan setelah stat
- **File:** `src-tauri/src/modules/fs/tree.rs:49-65, 84-93, 128`, `fs/search.rs:128-132, 217`
- **Masalah:** Comparator `to_lowercase()` per perbandingan (O(n log n) alokasi; ~270k buat dir 10k entry) di `fs_read_dir`/`fs_list_files`/ranking search. Plus check `.`-prefix di tree.rs:63 jalan **setelah** `fs::metadata` — hidden entries (ratusan di $HOME) di-stat lalu dibuang. Konteks: fs_list_files di-cache per root, fs:changed di-debounce 150ms/1s, jadi ini minor — dan bagian yang paling berdampak adalah filter-before-stat (stat syscall dominan di dir gede).
- **Fix:** `sort_by_cached_key` (atau precompute lowercase key), dan pindahin check hidden sebelum `metadata()`.
- **Efek:** fs_read_dir lebih cepat di dir gede / $HOME, alokasi sort hilang. Impact **low**, effort **small**.

---

## Top 5 Prioritas

1. **Fix `manualChunks` mermaid** (1.1) — one-liner di `vite.config.ts:57`, -2.88 MB JS dari startup, sudah terverifikasi via build.
2. **Lazy MarkdownStack/PdfStack + hapus barrel re-export** (1.2) — -1.83 MB JS + 203 KB CSS, dan mermaid/codemirror keluar dari preload graph (~4.3 MB total bareng #1). Sekalian beresin leftover setengah jadi di working tree.
3. **`spawn_blocking` untuk command fs** (4.1) — ngilangin UI freeze multi-detik saat grep/search/baca file gede; pattern-nya sudah ada di `git/commands.rs`.
4. **`experimental_throttle` di kedua `useChat` + early-return `estimateTokens`** (2.1 + 2.2) — dua perubahan kecil yang motong mayoritas CPU per-token saat AI streaming.
5. **rAF loop terminal jadi event-driven** (3.1) — ngilangin 120–240 wakeup/s saat idle; ini metrik idle-CPU paling penting buat sebuah terminal emulator.
