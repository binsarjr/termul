# Warp-style block hover model + empty-prompt fix

Branch: `feat/warp-block-hover` → PR to `dev`. Follows up merged PR #21.

## Findings (verified, not assumed)
- Empty Enter in zsh emits only OSC 133 `D`/`A` (no `C`) — captured live from the
  real `zshrc.zsh`. So empty-Enter blocks have a **null start marker** and
  `rebuild()` already skips them. The bug agent's "empty command block" root
  cause is wrong for stock zsh; the screenshot's many red bars couldn't be
  reproduced headlessly (likely the user's real `~/.zshrc` framework hooks, or an
  xterm render quirk).
- User decisions (AskUserQuestion): **fully hover-only** (no persistent marks) +
  **replace the corner pill** with a per-block hover toolbar (hover OR Cmd+↑/↓).
- xterm constraint (verified in installed v6 source): a decoration is hidden once
  its *start* row scrolls off — so the full-block highlight must be an **overlay**
  driven by `blockAtClientY`, not a decoration.

## Phase A — controller rework (no UI) — ≤5 files
- [x] Rename `blockDecorations.ts` → `blockController.ts`; `BlockDecorations` → `BlockController`.
- [x] Drop all `registerDecoration`/rebuild/style machinery.
- [x] Add hover state + `getActiveBlock` = hovered ?? selected; `setHover`, `getActiveFrame()` (client-coord rect, clamped to viewport, one gBCR), `selectionInfo()`.
- [x] `isInteractiveBlock(block)` = live start marker && `command.trim()` — applied to hit-test + nav so empty blocks are never targetable (defends the screenshot bug).
- [x] `useTerminalSession`: rename field `blockDeco`→`blockCtl`; unify `getActiveBlock` = hovered ?? selected ?? last; add `setBlockHoverAt`, `pinActiveBlock`, `getBlockHoverFrame`.
- [x] Rewrite tests → `blockController.test.ts` (nav skips empties, hover, eviction); drop decoration-count tests.
- [x] Verify: `tsc --noEmit` + vitest.

## Phase B — hover overlay UI — ≤5 files
- [x] New `BlockHoverLayer.tsx`: full-width highlight + top-right toolbar (status dot, copy cmd / copy output / filter / ⋮ more → copy both, reinput, filter). rAF-positioned via refs (no per-frame setState).
- [x] `TerminalPane.tsx`: relative wrapper, mousemove→`setBlockHoverAt`, render overlay; keep right-click `BlockContextMenu` + filter dialog; remove the pill.
- [x] Delete `BlockAffordance.tsx`.
- [x] Verify: `tsc --noEmit` + vitest + `npm run build`.

## Phase C — review + ship
- [x] Adversarial review workflow on the diff (run wsgli6jam).
- [x] Apply confirmed review fixes (see Review).
- [x] Commit, push `feat/warp-block-hover`, open PR → `dev` (#22).
- [x] Flag GUI smoke-test (hover highlight/toolbar/menu can't be driven headlessly).

## Review

### What shipped
Replaced the always-on red gutter bars + corner pill with a Warp-style,
strictly hover-driven affordance:
- **`blockController.ts`** (was `blockDecorations.ts`) — no longer paints xterm
  decorations (a decoration vanishes the moment its start row scrolls off, so it
  can't represent a whole block). It now owns hover + keyboard-selection state and
  exposes `getActiveFrame()`, which returns one viewport-clamped client rect per
  frame. `isInteractiveBlock` (live start marker && non-empty command) gates every
  hover / nav / hit-test, so an empty prompt can never draw UI.
- **`BlockHoverLayer.tsx`** — a single overlay element, repositioned imperatively
  in a rAF loop from `getActiveFrame()` (no per-frame setState). Full-width tint +
  left accent + a top-right toolbar (status dot, n/total counter, copy command,
  copy output, filter, ⋮ menu). Shown on hover OR Cmd+↑/↓ selection.
- **`TerminalPane.tsx` / `useTerminalSession.ts`** — pointer wiring on the wrapper
  (so the floating toolbar stays hoverable), `setBlockHoverAt`, `pinActiveBlock`
  (on ⋮ open, so menu actions target the right block even though the menu portals
  out of the grid), `getBlockHoverFrame`.

### Adversarial review (workflow wsgli6jam) — 8 findings
Refuted 5 (end-line for running commands [live cmd lives in `ring.open`, never in
the frame], toolbar-off-screen [anchored to the xterm-screen edge, always ≥8px +
`overflow-hidden`], color-mix unsupported [min OS 13 ⇒ Safari 16 supports it], 2
test-coverage notes [non-blocking]). Confirmed + fixed 3:
1. **Frozen toolbar floats** when a block scrolls off under streaming output while
   the ⋮ menu is open → rAF loop now `hide()`s if `getFrame()` is null even while
   pinned.
2. **Keyboard-selection vs hover precedence + label mismatch** → `selectRelative`
   clears hover so Cmd+C targets the selected block; the n/total counter shows only
   when the toolbar is on the keyboard-selected block.
3. **Copy-output false success** — a no-output command (`cd /tmp`) flashed the green
   tick → `copyActive` returns a boolean; the toolbar flashes only on a real copy.

Plus the 2 react-doctor nits from the new code (`w-2 h-2`→`size-2`, `h-5 w-5`→
`size-5`) and added 7 DOM-stubbed tests for `getActiveFrame`/`blockAtClientY`.

### Verification
- `tsc --noEmit` → clean. `vitest run` → 143/143 pass (blockController 19).
- `npm run build` → success (chunk-size warning is pre-existing).
- react-doctor → 44 findings, all pre-existing in `App.tsx`; **zero** in changed files.

### Two-perspective
- *Perfectionist*: the `interactive()` filter runs O(n) per frame inside the rAF
  loop; negligible at the 50-block ring cap but cacheable on `ring.onChange` if the
  cap ever grows. `getActiveFrame`/`blockAtClientY` are now unit-tested with stubbed
  DOM, but the actual hover→highlight→toolbar wiring is only verifiable in the GUI.
- *Pragmatist*: behavior is correct and the hot path is trivial work; ship it and
  smoke-test the GUI.

### Not done here (out of scope / needs GUI)
- Manual smoke test: hover tint, toolbar buttons, ⋮ menu, Cmd+↑/↓ nav, copy flash.
- Pre-existing `App.tsx` react-doctor findings — separate cleanup PR, not this one.

## Batch 2 — Warp-fidelity fixes (from user screenshots)

User feedback on the shipped overlay: (1) the highlight covered only the output,
not the command line — they must read as **one block**; (2) the red left bar
should appear **only on error**, not always; (3) the bar must not sit on top of
the first glyph — it needs **padding/gutter**.

### What changed
- **One block = command + output.** `osc-handlers.ts` now also keeps the OSC 133
  `A` marker (`promptMarker`) on each `CommandBlock`, transferred to the block at
  `C` (and ownership released so the next prompt's `A` can't dispose it; freed on
  eviction / ring dispose). The highlight top is derived as `startMarker.line - 1`
  — the row directly above the output — which is robust (the start marker is
  always captured for a real command) and spacer-safe (zsh prints a blank line
  above many prompts, so the raw `A` line is unreliable; `block.command` has its
  control chars/newlines stripped by zsh preexec, so multi-line detection from the
  string is impossible). Falls back to `promptMarker` only when there is no output
  marker. `blockTopLine`/`blockEndLine`/`liveLine` centralize this in
  `blockController.ts`; `isInteractiveBlock` now accepts an output **or** prompt
  anchor.
- **Error-only accent bar.** Replaced the always-on `inset` box-shadow with a
  separate `accentRef` div that is shown **only when the command failed**
  (`exitCode !== 0`), living in the left gutter (never over the glyph).
- **Left gutter.** `.xterm { padding-left: 12px }` — FitAddon reads padding off
  `.xterm` and subtracts it, so the column count stays correct while `.xterm-screen`
  + canvas shift right together (overlay positions off `.xterm-screen`'s rect, so
  it stays glyph-aligned).

### Review fixes folded in
1. **`blockEndLine` collapse** (confirmed medium/high) — a no-output command whose
   end marker lands on its top line (e.g. at buffer line 0) produced an empty
   `[top, top)` range → invisible/unclickable. Now clamped to `≥ topLine + 1`.
   New degenerate-case test (`paints a no-output command at line 0…`).
2. **Zoom misalignment** (confirmed medium) — the overlay lives in the
   `zoom: --app-zoom` subtree while the terminal is zoom-exempt, so raw screen-px
   assignments rendered at `px*zoom` and drifted off the text at non-default zoom.
   `BlockHoverLayer` now takes a `zoom` prop (from `usePreferencesStore`) and
   divides every geometry assignment by it via a `px()` helper (no-op at zoom 1).

### Verification
- `tsc --noEmit` → clean. `vitest run` → **147/147** (blockController 21,
  osc-handlers 15).
- `npm run build` → success (pre-existing chunk-size warning only).
- react-doctor → still 44, all pre-existing in `App.tsx`; **zero** in changed files.
- GUI: requires a full `pnpm tauri dev` restart (controller + prompt tracker are
  instantiated at slot-bind, so Vite HMR doesn't re-instantiate them) + running a
  **new** command to see the unified highlight.
