import { describe, expect, it } from "vitest";
import { labelFor } from "./labelFor";
import { moveItem, type TerminalTab } from "./useTabs";

function term(patch: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 1,
    kind: "terminal",
    title: "shell",
    paneTree: { kind: "leaf", id: 2 },
    activeLeafId: 2,
    ...patch,
  };
}

describe("moveItem", () => {
  it("moves an element forward", () => {
    expect(moveItem([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4]);
  });

  it("moves an element backward", () => {
    expect(moveItem([1, 2, 3, 4], 3, 1)).toEqual([1, 4, 2, 3]);
  });

  it("is a no-op when from === to", () => {
    const arr = [1, 2, 3];
    const out = moveItem(arr, 1, 1);
    expect(out).toBe(arr);
    expect(out).toEqual([1, 2, 3]);
  });

  it("returns the array unchanged when indices are out of range", () => {
    const arr = [1, 2, 3];
    expect(moveItem(arr, -1, 1)).toBe(arr);
    expect(moveItem(arr, 1, 5)).toBe(arr);
    expect(moveItem(arr, 9, 0)).toBe(arr);
  });

  it("preserves length and membership", () => {
    const arr = ["a", "b", "c", "d", "e"];
    const out = moveItem(arr, 4, 0);
    expect(out).toHaveLength(arr.length);
    expect([...out].sort()).toEqual([...arr].sort());
    expect(out[0]).toBe("e");
  });

  it("returns a new array without mutating the input", () => {
    const arr = [1, 2, 3];
    const out = moveItem(arr, 0, 2);
    expect(out).not.toBe(arr);
    expect(arr).toEqual([1, 2, 3]);
  });
});

describe("labelFor (terminal custom title)", () => {
  it("derives the dynamic label from the cwd basename", () => {
    expect(labelFor(term({ cwd: "/Users/me/projects/app" }))).toBe("app");
  });

  it("falls back to the stored title when there is no cwd", () => {
    expect(labelFor(term({ title: "private", cwd: undefined }))).toBe("private");
  });

  it("returns '/' for the filesystem root", () => {
    expect(labelFor(term({ cwd: "/" }))).toBe("/");
  });

  it("shows the custom title and ignores the dynamic cwd name", () => {
    expect(
      labelFor(term({ cwd: "/Users/me/projects/app", customTitle: "deploy" })),
    ).toBe("deploy");
  });

  it("reverts to the dynamic name once the custom title is cleared", () => {
    const base = { cwd: "/Users/me/projects/app" };
    // Both undefined and "" mean "no custom title" -> dynamic name returns.
    expect(labelFor(term({ ...base, customTitle: undefined }))).toBe("app");
    expect(labelFor(term({ ...base, customTitle: "" }))).toBe("app");
  });

  it("does not apply custom titles to non-terminal tabs", () => {
    expect(
      labelFor({ id: 9, kind: "editor", title: "main.rs", path: "/main.rs", dirty: false, preview: false }),
    ).toBe("main.rs");
  });
});
