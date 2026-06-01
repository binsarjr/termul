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
- [ ] `CommandBlockRing.onChange` listener (fires on push/dispose)
- [ ] `blockDecorations.ts`: per-block left gutter bar via `registerDecoration`,
      colored by exit (red=fail, subtle=ok), spans block rows, rebuilds on
      ring change + `term.onResize` (reflow). Skips open block.
- [ ] wire controller in `bindLeafToSlot`; dispose on unbind (mirror `s.blocks`)
- [ ] verify

## Phase 3 — selection + keyboard nav (#2) + copy targets selected (#3)
- [ ] selection index in controller; `selectRelative`, `clear`, `scrollToSelected`
- [ ] selected block highlighted (accent gutter + faint tint)
- [ ] session API: `selectPrevBlock/selectNextBlock/clearBlockSelection/getActiveBlock`
- [ ] copy/reinput act on selected block, fallback to last
- [ ] shortcuts `block.selectPrev/selectNext` (mac: Cmd+Up/Down; else Ctrl+Shift+Up/Down),
      gated to focused terminal; Esc clears
- [ ] pill reflects active (selected||last) block + "n/m" when selected
- [ ] verify

## Phase 4 — per-block context menu (#4)
- [ ] right-click terminal → hit-test click row → block, select it, show menu
- [ ] menu: copy command/output/both, reinput, (filter output)
- [ ] verify

## Phase 5 — block output filter (#5, the "cleaner first win")
- [ ] dialog: filter selected block output by query (case/regex), copy filtered
- [ ] palette + context-menu entry
- [ ] verify

## Out of v1 (note in PR)
- multi-block select (Cmd+A / shift-click) — sub-part of #3
- full block-scoped find inside SearchAddon range — #5 harder half
- low gaps #7–#12

## Verification log
(filled per phase)
