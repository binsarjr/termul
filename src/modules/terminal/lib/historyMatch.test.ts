import { describe, expect, it } from "vitest";
import { deriveInputFromRow, ghostSuffix, matchHistory } from "./historyMatch";

const HIST = ["git status", "git stash pop", "git status -sb", "npm run dev"];

describe("matchHistory", () => {
  it("returns prefix matches in entry (most-recent) order", () => {
    expect(matchHistory(HIST, "git st", 10)).toEqual([
      "git status",
      "git stash pop",
      "git status -sb",
    ]);
  });

  it("excludes an exact-equal entry", () => {
    expect(matchHistory(HIST, "git status", 10)).toEqual(["git status -sb"]);
  });

  it("is case-sensitive", () => {
    expect(matchHistory(HIST, "GIT", 10)).toEqual([]);
  });

  it("respects the limit", () => {
    expect(matchHistory(HIST, "git", 1)).toEqual(["git status"]);
  });

  it("returns most-recent entries for empty input (dropdown seed)", () => {
    expect(matchHistory(HIST, "", 2)).toEqual(["git status", "git stash pop"]);
  });
});

describe("ghostSuffix", () => {
  it("returns the remainder of the best match", () => {
    expect(ghostSuffix(HIST, "git sta")).toBe("tus");
  });

  it("is empty when nothing matches", () => {
    expect(ghostSuffix(HIST, "zzz")).toBe("");
  });

  it("is empty for empty input", () => {
    expect(ghostSuffix(HIST, "")).toBe("");
  });
});

describe("deriveInputFromRow", () => {
  it("slices the row from startCol up to the cursor", () => {
    expect(deriveInputFromRow("$ git status", 2, 9)).toBe("git sta");
  });

  it("works at startCol 0 (no prompt prefix)", () => {
    expect(deriveInputFromRow("git status", 0, 3)).toBe("git");
  });

  it("returns the full typed text when the cursor is at end", () => {
    expect(deriveInputFromRow("$ ls -la", 2, 8)).toBe("ls -la");
  });

  it("keeps a trailing space when the cursor sits past it (untrimmed row)", () => {
    // The caller must pass the untrimmed row; the cursor (6) is right of the
    // typed space so the derived input includes it.
    expect(deriveInputFromRow("$ git ", 2, 6)).toBe("git ");
  });

  it("is empty when the cursor sits at the start col (no-echo line)", () => {
    expect(deriveInputFromRow("$ ", 2, 2)).toBe("");
  });

  it("is empty when the cursor is before the start col", () => {
    expect(deriveInputFromRow("$ git", 2, 1)).toBe("");
  });

  it("is empty when the start col is negative (invalid marker)", () => {
    expect(deriveInputFromRow("git status", -1, 5)).toBe("");
  });
});
