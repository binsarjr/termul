# Autocomplete fixes (trace 2026-06-10)

## Done
- [x] Mid-line ghost + Right-arrow hijack: ghost only at end of input (`cursorAtInputEnd`)
- [x] Ghost drawn over scrollback when viewport not at bottom: bail when `viewportY !== baseY`
- [x] Ghost glyphs not descaled by app zoom (fontSize/letterSpacing ÷ zoom)
- [x] Overlay clipped to pane (`overflow-hidden`)

## Done (round 2)
- [x] Dropdown state leak: closed on submitted Enter/Ctrl-J; all keys ignored on alt screen
- [x] Wide chars (CJK/emoji): input derivation + readTypedCommand now column-addressed via `translateToString(false, startCol, endCol)`
- [x] zsh metafied history: unmetafy + lossy decode (local `read_shell_history` and remote `ssh_read_history`); delete path byte-exact
- [x] zsh multiline: backslash continuations joined; multiline entries skipped in matching (accepting one would run its first line)
- [x] Leading-space commands no longer promoted (ignorespace convention)
- [x] Exported HISTFILE honored (zsh/bash); fish honors XDG_DATA_HOME
- [x] Dropdown items clickable (mousedown accept, terminal keeps focus)

Verified: 284 FE tests + tsc clean; 158 Rust tests + clippy clean.

## Deferred (needs design, not a straight fix)
- Smart-case / frequency / cwd-aware ranking: accept writes the suffix only, so a
  case-insensitive match would splice mixed-case commands ("git" + "Git Status"
  → "git Status"); needs buffer-rewrite design first.
- Ghost for wrapped (multi-row) input: needs wrapped-line walk + multi-row overlay.
- Clear-history vs live shells (zsh rewrites the file on exit): document only.
- React Doctor flags in TerminalAutocompleteLayer (rAF polling pattern shared
  with BlockHoverLayer) and TabBar (pre-existing): out of scope here.
