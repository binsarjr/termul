import { describe, expect, it } from "vitest";
import { encodeSnapshot, decodeSnapshot } from "@/modules/terminal/lib/sessionSnapshots";
import { buildBootState, sanitizeForSave, validateSession } from "./sessionStore";
import type { Tab, TerminalTab } from "./useTabs";

const term = (id: number, extra?: Partial<TerminalTab>): TerminalTab => ({
  id,
  kind: "terminal",
  title: "shell",
  paneTree: { kind: "leaf", id: id + 1 },
  activeLeafId: id + 1,
  ...extra,
});

describe("sanitizeForSave", () => {
  it("keeps restorable kinds and drops transient ones", () => {
    const tabs: Tab[] = [
      term(1),
      { id: 3, kind: "editor", title: "a", path: "/a", dirty: true, preview: false },
      { id: 4, kind: "editor", title: "b", path: "/b", dirty: false, preview: true },
      { id: 5, kind: "markdown", title: "m", path: "/m.md" },
      { id: 6, kind: "settings", title: "Settings", section: "general" },
      {
        id: 7,
        kind: "ai-diff",
        title: "d",
        path: "/d",
        originalContent: "",
        proposedContent: "x",
        approvalId: "abc",
        status: "pending",
        isNewFile: false,
      },
      { id: 8, kind: "git-history", title: "h", repoRoot: "/repo" },
    ];
    const out = sanitizeForSave({ tabs, activeId: 6, groups: [], tabGroupOf: {} });
    expect(out.tabs.map((t) => t.id)).toEqual([1, 3, 5, 8]);
    // dirty buffers can't be recovered; restored editors reload clean
    const editor = out.tabs.find((t) => t.id === 3);
    expect(editor).toMatchObject({ dirty: false, preview: false });
    // active tab (settings) was dropped → falls back to the first kept tab
    expect(out.activeId).toBe(1);
  });

  it("strips terminal runtime fields but keeps restore-relevant ones", () => {
    const tab = term(1, {
      cwd: "/w",
      remoteCwd: "/srv",
      sshHost: "box",
      spillToDisk: true,
      private: true,
      customTitle: "work",
    });
    const out = sanitizeForSave({ tabs: [tab], activeId: 1, groups: [], tabGroupOf: {} });
    const t = out.tabs[0] as TerminalTab;
    expect(t.cwd).toBe("/w");
    expect(t.private).toBe(true);
    expect(t.customTitle).toBe("work");
    expect(t.remoteCwd).toBeUndefined();
    expect(t.sshHost).toBeUndefined();
    expect(t.spillToDisk).toBeUndefined();
  });

  it("prunes group membership of dropped tabs and empty groups", () => {
    const tabs: Tab[] = [
      term(1),
      { id: 3, kind: "settings", title: "Settings", section: "general" },
    ];
    const groups = [
      { id: 10, name: "work", color: "blue" as const, collapsed: false },
      { id: 11, name: "ghost", color: "red" as const, collapsed: false },
    ];
    const out = sanitizeForSave({
      tabs,
      activeId: 1,
      groups,
      tabGroupOf: { 1: 10, 3: 11 },
    });
    expect(out.tabGroupOf).toEqual({ 1: 10 });
    expect(out.groups.map((g) => g.id)).toEqual([10]);
  });
});

describe("validateSession", () => {
  const valid = () =>
    sanitizeForSave({
      tabs: [term(1, { cwd: "/w" })],
      activeId: 1,
      groups: [],
      tabGroupOf: {},
    });

  it("accepts a sanitizeForSave round-trip", () => {
    const session = JSON.parse(JSON.stringify(valid()));
    expect(validateSession(session)).not.toBeNull();
  });

  it.each([
    ["garbage", "not an object"],
    ["null", null],
    ["wrong version", { ...valid(), version: 2 }],
    ["empty tabs", { ...valid(), tabs: [] }],
    ["duplicate ids", { ...valid(), tabs: [term(1), term(1)] }],
    [
      "activeLeafId outside tree",
      { ...valid(), tabs: [{ ...term(1), activeLeafId: 99 }] },
    ],
    [
      "malformed paneTree",
      { ...valid(), tabs: [{ ...term(1), paneTree: { kind: "leaf" } }] },
    ],
  ])("rejects %s", (_label, raw) => {
    expect(validateSession(raw)).toBeNull();
  });

  it("repairs a stale activeId and orphan group refs instead of rejecting", () => {
    const session = {
      ...valid(),
      activeId: 999,
      groups: [],
      tabGroupOf: { 1: 42 },
    };
    const out = validateSession(session);
    expect(out?.activeId).toBe(1);
    expect(out?.tabGroupOf).toEqual({});
  });
});

describe("buildBootState", () => {
  it("reproduces the historical default boot without a session", () => {
    const out = buildBootState({ cwd: "/launch" }, null, undefined);
    expect(out.tabs).toHaveLength(1);
    expect(out.tabs[0]).toMatchObject({ id: 1, kind: "terminal", cwd: "/launch" });
    expect(out.activeId).toBe(1);
    expect(out.nextId).toBe(3);
  });

  it("seeds nextId past every tab, leaf, split, and group id", () => {
    const session = validateSession({
      version: 1,
      tabs: [
        {
          ...term(1),
          paneTree: {
            kind: "split",
            id: 40,
            dir: "row",
            children: [
              { kind: "leaf", id: 2 },
              { kind: "leaf", id: 41 },
            ],
          },
          activeLeafId: 41,
        },
      ],
      activeId: 1,
      groups: [{ id: 50, name: "g", color: "blue", collapsed: false }],
      tabGroupOf: { 1: 50 },
    });
    const out = buildBootState(undefined, session, undefined);
    expect(out.nextId).toBe(51);
  });

  it("appends an active fresh tab for an explicit CLI launch dir", () => {
    const session = validateSession({
      version: 1,
      tabs: [term(1, { cwd: "/old" })],
      activeId: 1,
      groups: [],
      tabGroupOf: {},
    });
    const out = buildBootState(undefined, session, "/cli-dir");
    expect(out.tabs).toHaveLength(2);
    const appended = out.tabs[1] as TerminalTab;
    expect(appended.cwd).toBe("/cli-dir");
    expect(out.activeId).toBe(appended.id);
    expect(out.nextId).toBeGreaterThan(appended.activeLeafId);
  });
});

describe("snapshot encode/decode", () => {
  it("round-trips dims and body", () => {
    const raw = encodeSnapshot({
      snapshot: "hello[31mred",
      cols: 120,
      rows: 32,
      altScreen: false,
    });
    expect(decodeSnapshot(raw)).toEqual({
      snapshot: "hello[31mred\r\n",
      cols: 120,
      rows: 32,
    });
  });

  it("rejects payloads without a valid header", () => {
    expect(decodeSnapshot("plain ansi data")).toBeNull();
    expect(decodeSnapshot("TSNAP1 x y\ndata")).toBeNull();
    expect(decodeSnapshot("TSNAP1 120 32")).toBeNull();
  });
});
