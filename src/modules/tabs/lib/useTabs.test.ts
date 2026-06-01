import { describe, expect, it } from "vitest";
import { moveItem } from "./useTabs";

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
