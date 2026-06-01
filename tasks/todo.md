# Warp-style command blocks — high+medium gaps

Branch: `feat/warp-blocks-ux` → PR to `dev`. Scope: verified gaps **high+medium** only
(#1 visual render, #2 selection+nav, #3 copy older/both, #4 context menu, #5 block
find/filter, #6 reinput). Low gaps (#7–#12) intentionally excluded.

Foundation already present (data layer): OSC 133 capture, `CommandBlockRing` (50/pane),
per-block start/end markers + exitCode, lazy `readBlockOutput`. Missing: presentation +
interaction. We build that.

## Phase 1 — standalone quick wins (no dep on rendering)
- [x] #3 copy-both: `copyLastCommandBoth` (command + "\n" + output)
- [x] #6 reinput: write active block command into the PTY (no trailing CR)
- [x] shortcuts: add `block.copyBoth`, `block.reinput` (unbound default, like copy*)
- [x] palette entries (auto via SHORTCUTS) + pill buttons
- [x] verify: tsc + vitest

## Phase 2 — visual block rendering (#1)
- [x] `CommandBlockRing.onChange` listener (fires on push)
- [x] `blockDecorations.ts`: per-block left gutter bar via `registerDecoration`,
      colored by exit (red=fail, subtle=ok via --border), rebuilds on ring
      change + `term.onResize` (reflow). Skips open block.
- [x] wire controller in `bindLeafToSlot`; dispose on unbind (mirror `s.blocks`)
- [x] verify

## Phase 3 — selection + keyboard nav (#2) + copy targets selected (#3)
- [x] selection in controller; `selectRelative`, `clearSelection`, `scrollToSelected`
- [x] selected block highlighted (accent/ring gutter + glow)
- [x] session API: `selectPrevBlock/selectNextBlock/clearBlockSelection/getActiveBlock`
- [x] copy/reinput act on selected block, fallback to last
- [x] shortcuts `block.selectPrev/selectNext` (mac: Cmd+Up/Down; else Ctrl+Shift+Up/Down),
      gated to focused terminal; primary click clears (Esc deferred)
- [x] pill reflects active (selected||last) block + "n/m" when selected
- [x] verify

## Phase 4 — per-block context menu (#4)
- [x] right-click terminal → hit-test click row → block, select it, show menu
- [x] menu: copy command/output/both, reinput, filter output
- [x] verify

## Phase 5 — block output filter (#5, the "cleaner first win")
- [x] dialog: filter selected block output by query (case/regex), copy filtered
- [x] context-menu entry (palette covers copy actions automatically)
- [x] verify

## Out of v1 (note in PR)
- multi-block select (Cmd+A / shift-click) — sub-part of #3
- full block-scoped find inside SearchAddon range — #5 harder half (filter shipped)
- spanning bar persists only while the command's start row is on screen
  (xterm decorations gate on marker visibility); full floating frame deferred
- Esc-to-clear-selection (primary click clears today)
- low gaps #7–#12

## Verification log
- Phase 1–5: `tsc --noEmit` clean; `vitest run` 132 passed (incl. 14 new for
  ring observer / selection nav / output filter); `npm run build` ✓.
- react-doctor diff vs main flat at 44 pre-existing findings — no new
  regressions introduced (transient ones fixed as they appeared).
