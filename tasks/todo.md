# Plan: optional left/vertical tab bar (top | left)

Decision (from user): add an optional vertical tab bar on the LEFT (leftmost,
to the left of the sidebar), chosen via Settings. Resizable column, icon + full
name (Warp-like), default ~180px, clip long names (column is resizable 140-320).
NO keyboard shortcut changes in this task (deferred; user still unsure on Cmd+B
target). Default stays "top" so nothing changes for existing users.

Approach (vetted by design workflow): ONE orientation-aware TabBar (single source
of truth). Do NOT set Radix Tabs Root orientation="vertical" (it injects unwanted
variant styles and flips arrow-key roving focus). Mount the column as a SIBLING
ResizablePanel inside the EXISTING horizontal ResizablePanelGroup, before the
sidebar, with its own zoom-aware divider mirroring the sidebar's.

## Phase 1: preference plumbing + settings UI (no layout change)
- [ ] store.ts: add `TabBarPositionPref = "top" | "left"`; Preferences field
      `tabBarPosition`; KEY const; DEFAULT "top"; loadPreferences entry; setter
      `setTabBarPosition`; onPreferencesChange map entry. (preferences.ts hydrates
      generically, no edit.)
- [ ] GeneralSection.tsx: in the existing "Tabs" group, add a SettingRow with a
      Select (Top | Left), mirroring the Letter-spacing Select pattern.
- [ ] Verify: tsc + vitest. Chooser renders; nothing reacts yet.

## Phase 2: make TabBar orientation-aware (single component)
- [ ] TabBar.tsx: add `orientation?: "horizontal" | "vertical"` (default horizontal).
      - dropTargetAt + 4px threshold become axis-aware (Y for vertical), keep
        place "before"/"after" so onReorder/reorderTab are untouched.
      - outer/inner container: vertical = overflow-y-auto + flex-col w-full
        items-stretch; horizontal = unchanged.
      - gate the wheel-to-horizontal effect on horizontal.
      - drop indicator: vertical = horizontal bar top/bottom; horizontal = unchanged.
      - extract NewTabMenu; vertical pins it as a header above the scroll area;
        horizontal keeps it trailing.
      - vertical label: truncate at column width.
      - do NOT touch the Radix Tabs Root orientation.
- [ ] Verify: tsc + vitest. Top mode byte-for-byte unchanged (default horizontal).

## Phase 3: mount resizable left column + gate Header
- [ ] App.tsx: TABCOL_* constants + clamp/sanitize/read helpers + tabColumnRef +
      width ref + persist + cleanup + handleTabColumnResizeStart (mirror sidebar).
      When position==="left", render the tab-column ResizablePanel + zoom-aware
      divider as the first siblings in the existing group; mount
      `<TabBar orientation="vertical" .../>`.
- [ ] Header.tsx: add `tabBarPosition` prop; render the in-header TabBar block only
      when "top"; when "left" keep just the trailing drag spacer.
- [ ] Verify: tsc + vitest + vite build; eyeball in tauri dev at zoom 0.5/1/2,
      drag-reorder, resize divider, persistence, new-tab menu pinned.

## Pitfalls (from workflow, to honor)
- Radix orientation trap -> keep Root horizontal.
- CSS zoom hit-testing -> copy sidebar divide-by-zoom + Math.round(10/zoom) handle.
- Drag axis -> clientY for vertical; indicator top/bottom.
- Vertical scroll -> gate wheel handler; plain overflow-y-auto.
- New-tab/group controls -> NewTabMenu pinned header in vertical.
- Width key -> termul:tab-column.width (unused); reuse sanitize/clamp guards.
- Don't break top mode -> defaults keep current behavior.
- Header drag region -> keep the flex-1 spacer when TabBar hidden.

## Review
(to fill after implementation)
