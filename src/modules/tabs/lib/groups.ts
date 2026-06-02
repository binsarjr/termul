import type { Tab } from "./useTabs";

export type GroupColorId =
  | "blue"
  | "green"
  | "amber"
  | "red"
  | "purple"
  | "cyan";

export type TabGroup = {
  id: number;
  name: string;
  color: GroupColorId;
  collapsed: boolean;
};

/** tabId -> groupId */
export type TabGroupMap = Record<number, number>;

/** Theme-driven palette: each color resolves to a `--group-*` CSS variable
 * (defined in globals.css for light/dark), so groups stay theme-overridable. */
export const GROUP_COLORS: { id: GroupColorId; label: string; cssVar: string }[] =
  [
    { id: "blue", label: "Blue", cssVar: "--group-blue" },
    { id: "green", label: "Green", cssVar: "--group-green" },
    { id: "amber", label: "Amber", cssVar: "--group-amber" },
    { id: "red", label: "Red", cssVar: "--group-red" },
    { id: "purple", label: "Purple", cssVar: "--group-purple" },
    { id: "cyan", label: "Cyan", cssVar: "--group-cyan" },
  ];

export function groupColorVar(id: GroupColorId): string {
  const c = GROUP_COLORS.find((g) => g.id === id);
  return `var(${c ? c.cssVar : "--group-blue"})`;
}

/** Next palette color for a new group, cycling by current group count. */
export function nextGroupColor(existing: TabGroup[]): GroupColorId {
  return GROUP_COLORS[existing.length % GROUP_COLORS.length].id;
}

export type TabRow =
  | { kind: "group"; group: TabGroup; count: number }
  | { kind: "tab"; tab: Tab };

/**
 * Flatten tabs into render rows: a group chip is emitted at the start of each
 * contiguous run of a group; a collapsed group emits only its chip (members
 * hidden). Ungrouped tabs pass through unchanged. Pure — drives TabBar.
 */
export function buildTabRows(
  tabs: Tab[],
  groups: TabGroup[],
  groupOf: TabGroupMap,
): TabRow[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const counts = new Map<number, number>();
  for (const t of tabs) {
    const gid = groupOf[t.id];
    if (gid != null) counts.set(gid, (counts.get(gid) ?? 0) + 1);
  }
  const rows: TabRow[] = [];
  let prev: number | null = null;
  for (const t of tabs) {
    const gid = groupOf[t.id] ?? null;
    const group = gid != null ? byId.get(gid) : undefined;
    if (gid !== prev) {
      if (group)
        rows.push({ kind: "group", group, count: counts.get(gid as number) ?? 0 });
      prev = gid;
    }
    if (!group || !group.collapsed) rows.push({ kind: "tab", tab: t });
  }
  return rows;
}

/**
 * Assign `tabId` to `groupId`, keeping the group's run contiguous: the tab is
 * moved to sit right after the group's last current member. If the group has
 * no members yet (freshly created) the order is left unchanged. Pure.
 */
export function assignTabToGroup(
  tabs: Tab[],
  groupOf: TabGroupMap,
  tabId: number,
  groupId: number,
): { tabs: Tab[]; groupOf: TabGroupMap } {
  const nextGroupOf: TabGroupMap = { ...groupOf, [tabId]: groupId };
  const moved = tabs.find((t) => t.id === tabId);
  if (!moved) return { tabs, groupOf: nextGroupOf };
  const without = tabs.filter((t) => t.id !== tabId);
  let lastMember = -1;
  without.forEach((t, i) => {
    if (groupOf[t.id] === groupId) lastMember = i;
  });
  if (lastMember === -1) return { tabs, groupOf: nextGroupOf };
  const at = lastMember + 1;
  return {
    tabs: [...without.slice(0, at), moved, ...without.slice(at)],
    groupOf: nextGroupOf,
  };
}

/**
 * Drop `tabId` from its group. Returns the new map and the group id that became
 * empty (so the caller can delete it), or null. Pure.
 */
export function detachTabFromGroup(
  tabs: Tab[],
  groupOf: TabGroupMap,
  tabId: number,
): { groupOf: TabGroupMap; emptiedGroupId: number | null } {
  const gid = groupOf[tabId];
  if (gid == null) return { groupOf, emptiedGroupId: null };
  const nextGroupOf = { ...groupOf };
  delete nextGroupOf[tabId];
  const stillUsed = tabs.some((t) => t.id !== tabId && nextGroupOf[t.id] === gid);
  return { groupOf: nextGroupOf, emptiedGroupId: stillUsed ? null : gid };
}

/** True when a tab is a member of a collapsed group (hidden in the tab bar). */
export function isTabHidden(
  tabId: number,
  groups: TabGroup[],
  groupOf: TabGroupMap,
): boolean {
  const gid = groupOf[tabId];
  if (gid == null) return false;
  return groups.some((g) => g.id === gid && g.collapsed);
}

/** Tabs that are not inside a collapsed group — the set keyboard nav walks. */
export function visibleTabs(
  tabs: Tab[],
  groups: TabGroup[],
  groupOf: TabGroupMap,
): Tab[] {
  return tabs.filter((t) => !isTabHidden(t.id, groups, groupOf));
}
