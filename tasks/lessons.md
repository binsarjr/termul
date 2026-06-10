## ssh-remote-pill adversarial fixes (2026-06-03)

- parseSshHost: short-flag BUNDLES ending in a value-flag (`-Cp 2222`, `-qp 2222`,
  `-fp 2222`) consume the NEXT token as the value. Old `tok.length===2` check only
  handled lone `-p`. Fix: find first SSH_VALUE_FLAGS char index k in tok.slice(1);
  i++ only when k is the LAST index (value is next token); mid-bundle char => glued.
- rendererPool.bindSlot: registerOsc MUST run before drainRing so OSC 133 C/D
  captured in the dormant ring during hibernation drive the fresh trackers; else a
  replayed ssh-exit D is lost and the remote pill stays stuck. Snapshot still writes
  first (markers land at correct positions); only live-ring bytes flow through handlers.
- osc-handlers depth tracking: nested remote OSC 133 D (integrated remote shell)
  must NOT fire onCommandEnd. Count C=+1 / D=-1; fire only at depth 0 (clamped so a
  D-without-C from bash3.2/PowerShell still fires). Do NOT reset depth on A (remote
  prompts emit A too).

## tabs active-state styling (2026-06-03)

- shadcn's `@import "shadcn/tailwind.css"` defines `@custom-variant data-active`
  as `&:where([data-active]:not([data-active="false"]))` — it requires a literal
  `data-active` ATTRIBUTE. But radix-ui `Tabs.Trigger` only emits `data-state="active"`.
  So every `data-active:` selector in `components/ui/tabs.tsx` was dead (active styling
  never applied). Fix: use `data-[state=active]:` to match what the primitive emits.
  Rule: never assume a Tailwind variant name matches a primitive's attribute — grep the
  `@custom-variant` def AND the radix dist (`grep data-state node_modules/.../react-tabs`).
- TabBar's active text stayed muted in dark because the base trigger leaves an always-on
  `dark:text-muted-foreground` (specificity 0,2,0) that TIED the override
  `data-[state=active]:text-foreground` (0,2,0) — source order then won for muted.
  tailwind-merge does NOT drop it (different variant key: `dark` vs `data-[state=active]`).
  Fix: give the override a `dark:data-[state=active]:` prefix (0,3,0) so it deterministically
  wins by specificity, not source order. Same trick keeps the active fill over the base's
  `dark:data-[state=active]:bg-input/30`.
- VISIBILITY root cause: `bg-accent` is the app's "selected" token and pops in lists
  (they sit on `bg-background`, L≈0.148 → contrast ~big). But the tab strip sits on the
  `bg-card` titlebar (L≈0.218), so `bg-accent` (L≈0.275) is only ~1.18:1 over it — reads
  as FLAT. Measured (browser canvas, real compiled CSS): bg-accent active = rgb(34,41,43)
  on card rgb(22,27,29) = 1.175:1; switched to `bg-foreground/15` (translucent ink overlay,
  theme-aware: white in dark / black in light) = rgb(56,60,62) = 1.559:1, a clearly visible
  pill. Rule: don't reuse a "selected" token blindly across surfaces — contrast depends on
  what's BEHIND it; verify the composited contrast for the actual parent background.

## tabs active-state styling, round 2 (2026-06-10)

- The 2026-06-03 fix STILL didn't ship a visible active tab: in TabBar each
  TabsTrigger sits inside `<ContextMenuTrigger asChild>`. Radix ContextMenuTrigger
  injects `data-state="closed"/"open"` BEFORE `...triggerProps`, and Slot child
  props win, so the forwarded data-state reaches Tabs.Trigger's spread and
  clobbers its own `data-state="active"/"inactive"`. Every tab rendered with
  data-state="closed" → ALL `data-[state=*]` selectors were dead.
  Rule: when two radix primitives are composed via asChild, grep BOTH dists for
  `data-state` — same-named attributes get silently overwritten by spread order.
- Durable fix: style off `aria-selected` (Tabs.Trigger sets it; ContextMenu
  doesn't, so it survives the slot merge). `aria-selected:x` = (0,2,0) beats the
  base `dark:text-muted-foreground` (0,1,0) without needing dark: duplicates;
  scope inactive hovers with `aria-[selected=false]:hover:` so hovering the
  active tab is a no-op.
- Verification lesson: the previous fix was reasoned about but never OBSERVED at
  the surface — that's how a dead selector shipped twice. Termul's frontend
  white-screens in a plain browser (boot requires Tauri IPC); runtime checks
  must go through `pnpm tauri dev`.

## perf-fix waves (2026-06-10)

- Prefs zustand store syncs ASYNC via Tauri event `termul://prefs-changed`
  (cross-window), not synchronously on setter call. Any local "draft" mirroring
  a pref (slider drag, etc.) must NOT clear on commit — clear when the store
  value round-trips. Pattern: `useSliderDraft` (render-phase prev-comparison,
  src/settings/lib/useSliderDraft.ts), never `useState + useEffect`-sync
  (react-doctor: no-derived-state-effect).
- Lazy-loading a module is useless if the barrel still eagerly re-exports the
  heavy component, or if `manualChunks` misses a sub-package (`@mermaid-js/parser`
  pinned the whole 2.9MB mermaid chunk into main). After ANY import/chunk change,
  verify the real artifact: `grep modulepreload dist/index.html` — target list is
  react, xterm, utils, radix, motion only.
- Rollup "colors" shared tiny deps (clsx/tailwind-merge/preload-helper) into
  whichever chunk loads first alphabetically-ish; an eager import of clsx then
  pins the whole 480KB streamdown chunk eager. Route shared utils to their own
  manual chunk.
- Tauri 2 non-async commands run inline on the webview main thread — any
  filesystem walk/read in a `#[tauri::command] fn` freezes the UI. Pattern:
  `async fn` + `tauri::async_runtime::spawn_blocking` (see git/commands.rs
  `blocking()` helper, now mirrored in fs/ and shell/).
- Condvar discipline: predicate writes MUST happen under the same mutex the
  waiter holds, or `wait_timeout` is papering over a lost-wakeup race (PTY
  flusher had exactly this; fixed = untimed `cv.wait` + zero idle wakeups).
