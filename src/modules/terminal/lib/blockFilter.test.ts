import { describe, expect, it } from "vitest";
import { filterBlockOutput } from "./blockFilter";

const OUTPUT = ["apple pie", "Banana", "cherry", "APPLE tart"].join("\n");

describe("filterBlockOutput", () => {
  it("returns every line for an empty or whitespace query", () => {
    expect(filterBlockOutput(OUTPUT, "", false).lines).toHaveLength(4);
    expect(filterBlockOutput(OUTPUT, "   ", false).lines).toHaveLength(4);
  });

  it("matches case-insensitive substrings", () => {
    const r = filterBlockOutput(OUTPUT, "apple", false);
    expect(r.lines).toEqual(["apple pie", "APPLE tart"]);
    expect(r.total).toBe(4);
    expect(r.invalid).toBe(false);
  });

  it("matches with a case-insensitive regex", () => {
    expect(filterBlockOutput(OUTPUT, "^a", true).lines).toEqual([
      "apple pie",
      "APPLE tart",
    ]);
    expect(filterBlockOutput(OUTPUT, "rr|na", true).lines).toEqual([
      "Banana",
      "cherry",
    ]);
  });

  it("flags an invalid regex instead of throwing", () => {
    const r = filterBlockOutput(OUTPUT, "(", true);
    expect(r.invalid).toBe(true);
    expect(r.lines).toEqual([]);
    expect(r.total).toBe(4);
  });

  it("treats an invalid regex as a literal when regex is off", () => {
    const r = filterBlockOutput("a(b\nxyz", "(", false);
    expect(r.invalid).toBe(false);
    expect(r.lines).toEqual(["a(b"]);
  });

  it("handles empty output", () => {
    const r = filterBlockOutput("", "x", false);
    expect(r.lines).toEqual([]);
    expect(r.total).toBe(0);
  });
});
