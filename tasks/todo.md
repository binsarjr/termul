# Plan: tab labels (SSH + no-trim + active-pane) and updater recheck

Decisions (from user): full tab titles by default with a "truncate" toggle; SSH
host badge on terminal tabs; updater needs a real recheck + authoritative latest
(the bug is getting stuck on the first-found update, not a stale manifest).

## Phase A: per-leaf SSH/remote state so the title follows the active pane
Today the leaf only stores `cwd`; `remoteCwd`/`sshHost` live on the tab as the
active leaf's value, and `focusPane`/`focusNextPaneInTab` restore only `cwd` on
pane switch, so SSH state goes stale across panes.

- [ ] panes.ts: add `remoteCwd?` and `sshHost?` to the leaf node; add
      `findLeafRemoteCwd`/`findLeafSshHost` and `setLeafRemoteCwd`/`setLeafSshHost`
      (mirror the existing `findLeafCwd`/`setLeafCwd`).
- [ ] useTabs.ts `setRemoteCwd`/`setSshHost`: write the value into the leaf in the
      tree (for ALL leaves) AND mirror to the tab only when that leaf is active.
      Keep the keystroke-rate bail-out guards.
- [ ] useTabs.ts `focusPane`/`focusNextPaneInTab`: on switch, restore the tab's
      `cwd`/`remoteCwd`/`sshHost` from the now-active leaf's tree state.
- [ ] Verify: split a tab, ssh in one pane, switch panes -> title + badge update.

## Phase B: SSH badge, no-trim default, settings
- [ ] settings store.ts: add prefs (camelCase + KEY + default + setter + onChange map):
      - `tabSshBadge: boolean` default true (show SSH host badge on terminal tabs)
      - `truncateTabTitles: boolean` default false (false = full names, strip scrolls)
      - `tabTitleFromActivePane: boolean` default true (dynamic auto-title until renamed)
- [ ] GeneralSection.tsx: add a "Tabs" group (SectionHeader + SettingRow + Switch)
      wiring the three toggles. (Grouping: a Tabs group inside General.)
- [ ] TabBar.tsx:
      - gate `truncate`/`max-w-*` on `truncateTabTitles` (off = no cap, tabs grow).
      - add an SSH host badge for terminal tabs when the active pane has `sshHost`
        (or `remoteCwd`) and `tabSshBadge` is on, mirroring the remote file-tab badge.
- [ ] labelFor / gating: when `tabTitleFromActivePane` is off, terminal tabs fall
      back to the static `title`.
- [ ] Verify: full names show; toggle re-enables truncation; SSH badge appears.

## Phase C: updater recheck + authoritative latest
Root cause (confirmed with user): no recheck; the checker sticks to the first-found
update and the 30-min throttle hides newer ones.

- [ ] updaterStore.ts: generalize the GitHub Releases API fetch (today Linux-only)
      into the source of truth for the latest published tag on ALL platforms.
- [ ] Mac/Win: run the Tauri plugin `checkUpdate()` for the installable update; if the
      plugin reports up-to-date but the GitHub tag is newer, surface manual-download
      info instead of "up to date" (never stuck below the real latest).
- [ ] A manual recheck bypasses the throttle and SUPERSEDES the current found state.
- [ ] UI: add a visible "Check for updates" / "Recheck" button in UpdaterDialog and
      AboutSection; re-check on window focus so reopening refreshes.
- [ ] Verify: simulate found v1, then recheck surfaces the newer version.

## Phase D (optional, low cost): CI version-sync guard
- [ ] release.yml: fail the release if the git tag != tauri.conf.json version.
      (Offered; skipped unless you want it.)

## Verification (all phases)
- [ ] tsc --noEmit, vitest run, vite build. No Rust changes expected (cargo n/a).

## Review

All four phases implemented and verified. tsc --noEmit exit 0, vitest 419/419
passed, vite build OK, startup modulepreload set unchanged
(react/xterm/utils/radix/motion).

Phase A (per-leaf SSH/remote state):
- panes.ts: leaf became the exported `LeafNode` with optional `sshHost`/`remoteCwd`;
  added `findLeafNode` (returns the node so callers can tell "unset" from "not
  found", unlike the cwd-only finder), plus `setLeafSshHost`/`setLeafRemoteCwd`.
- useTabs.ts: `setRemoteCwd`/`setSshHost` now write per-leaf for ANY matching tab
  and mirror to the tab only when that leaf is active; `focusPane`,
  `focusNextPaneInTab`, `splitActivePane`, `closePaneByLeaf`, `closeActivePane` all
  restore cwd/remoteCwd/sshHost from the now-active leaf via `leafDisplay`.
- sessionStore.ts: `stripLeafRuntime` clears runtime SSH/remote fields on persist so
  a restored local shell never shows a stale SSH badge.

Phase B (badge, no-trim default, settings):
- store.ts: added `tabTitleFromActivePane` (true), `tabSshBadge` (true),
  `truncateTabTitles` (false) end-to-end (KEY + default + loader + setter + onChange).
- GeneralSection.tsx: new "Tabs" group with the three toggles.
- labelFor.ts: gated dynamic terminal title on `tabTitleFromActivePane`.
- TabBar.tsx: truncation/`max-w-*` gated on `truncateTabTitles` (off = tabs grow,
  strip scrolls); SSH host badge for terminal tabs when `tabSshBadge` is on.

Phase C (updater recheck + authoritative latest):
- updaterStore.ts: replaced the Linux-only `checkLinuxRelease` with
  `fetchLatestRelease`, now the source of truth for the newest tag on ALL platforms.
  Mac/Win still prefer the Tauri plugin for one-click install, but fall back to a
  manual download when the plugin lags behind (or errors against) the freshly
  published tag, so it never sticks below the real latest. A manual recheck bypasses
  the throttle and supersedes the current found state.
- UpdaterDialog.tsx: "checking" is showable so a recheck doesn't flash the dialog
  closed; added "Check again" to the available/manual footers.
- AboutSection.tsx: dedicated "Check again" button once an update is surfaced (the
  primary button then installs/opens it); manual-available now opens the dialog.
- App.tsx: re-check on window focus (throttled) so refocusing picks up a release.

Phase D (CI version-sync guard):
- release.yml: added a `verify-version` job that fails a `v*` tag release when the
  tag does not match `src-tauri/tauri.conf.json` version; `publish-tauri` now
  `needs: verify-version`. Guards the other way a wrong version could surface.

Notes:
- react-doctor's 17 no-adjust-state-on-prop-change findings are all in pre-existing
  files (ExplorerSearch, FileExplorer, GitHistoryPane, SourceControlPanel,
  TerminalAutocompleteLayer); none introduced here.
- No Rust changes, so cargo was not involved.
