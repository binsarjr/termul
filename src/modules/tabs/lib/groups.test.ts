import { describe, expect, it } from "vitest";
import {
  assignTabToGroup,
  buildTabRows,
  detachTabFromGroup,
  visibleTabs,
  type TabGroup,
  type TabGroupMap,
} from "./groups";
import type { TerminalTab } from "./useTabs";

function term(id: number): TerminalTab {
  return {
    id,
    kind: "terminal",
    title: `t${id}`,
    paneTree: { kind: "leaf", id: id * 100 },
    activeLeafId: id * 100,
  };
}

const group = (id: number, patch: Partial<TabGroup> = {}): TabGroup => ({
  id,
  name: `g${id}`,
  color: "blue",
  collapsed: false,
  ...patch,
});

describe("buildTabRows", () => {
  it("passes ungrouped tabs through with no chips", () => {
    const tabs = [term(1), term(2)];
    const rows = buildTabRows(tabs, [], {});
    expect(rows.map((r) => r.kind)).toEqual(["tab", "tab"]);
  });

  it("emits a chip before a group's run and renders its members", () => {
    const tabs = [term(1), term(2), term(3)];
    const groups = [group(10)];
    const groupOf: TabGroupMap = { 2: 10, 3: 10 };
    const rows = buildTabRows(tabs, groups, groupOf);
    expect(rows.map((r) => r.kind)).toEqual(["tab", "group", "tab", "tab"]);
    const chip = rows.find((r) => r.kind === "group");
    expect(chip).toMatchObject({ kind: "group", count: 2 });
  });

  it("hides member tabs of a collapsed group, keeping the chip", () => {
    const tabs = [term(1), term(2), term(3)];
    const groups = [group(10, { collapsed: true })];
    const groupOf: TabGroupMap = { 2: 10, 3: 10 };
    const rows = buildTabRows(tabs, groups, groupOf);
    expect(rows.map((r) => r.kind)).toEqual(["tab", "group"]);
    expect(rows.find((r) => r.kind === "group")).toMatchObject({ count: 2 });
  });
});

describe("assignTabToGroup", () => {
  it("moves the tab adjacent to the group's run and records membership", () => {
    const tabs = [term(1), term(2), term(3), term(4)];
    // group 10 owns tab 2; assign tab 4 -> it should sit right after tab 2.
    const res = assignTabToGroup(tabs, { 2: 10 }, 4, 10);
    expect(res.tabs.map((t) => t.id)).toEqual([1, 2, 4, 3]);
    expect(res.groupOf).toEqual({ 2: 10, 4: 10 });
  });

  it("leaves order unchanged when the group has no members yet", () => {
    const tabs = [term(1), term(2)];
    const res = assignTabToGroup(tabs, {}, 2, 10);
    expect(res.tabs.map((t) => t.id)).toEqual([1, 2]);
    expect(res.groupOf).toEqual({ 2: 10 });
  });
});

describe("detachTabFromGroup", () => {
  it("removes membership and reports the group as emptied when it was the last member", () => {
    const tabs = [term(1), term(2)];
    const res = detachTabFromGroup(tabs, { 2: 10 }, 2);
    expect(res.groupOf).toEqual({});
    expect(res.emptiedGroupId).toBe(10);
  });

  it("keeps the group when other members remain", () => {
    const tabs = [term(1), term(2)];
    const res = detachTabFromGroup(tabs, { 1: 10, 2: 10 }, 2);
    expect(res.groupOf).toEqual({ 1: 10 });
    expect(res.emptiedGroupId).toBeNull();
  });
});

describe("visibleTabs", () => {
  it("excludes members of a collapsed group only", () => {
    const tabs = [term(1), term(2), term(3)];
    const groups = [group(10, { collapsed: true })];
    expect(visibleTabs(tabs, groups, { 2: 10 }).map((t) => t.id)).toEqual([
      1, 3,
    ]);
    // expanded group: nothing hidden
    expect(
      visibleTabs(tabs, [group(10)], { 2: 10 }).map((t) => t.id),
    ).toEqual([1, 2, 3]);
  });

  it("collapse is render-only — it never drops a tab from the source list", () => {
    // Guards the hard invariant: collapsing a group must hide tab-bar triggers
    // without removing the tab (which would dispose its PTY). The layout helpers
    // only ever read `tabs`; the source array stays intact across collapse.
    const tabs = [term(1), term(2), term(3)];
    const groupOf: TabGroupMap = { 2: 10, 3: 10 };
    visibleTabs(tabs, [group(10, { collapsed: true })], groupOf);
    buildTabRows(tabs, [group(10, { collapsed: true })], groupOf);
    expect(tabs.map((t) => t.id)).toEqual([1, 2, 3]);
  });
});
