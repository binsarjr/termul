import { describe, expect, it } from "vitest";
import { ghostSuffix, matchHistory, reduceTracked } from "./historyMatch";

const T = (input: string) => ({ input, tracking: true });

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

describe("reduceTracked", () => {
  it("appends plain typed characters", () => {
    expect(reduceTracked(T("git st"), "a")).toEqual(T("git sta"));
  });

  it("appends a multi-char paste of plain text", () => {
    expect(reduceTracked(T("git "), "status")).toEqual(T("git status"));
  });

  it("pops on backspace (DEL or BS)", () => {
    expect(reduceTracked(T("gits"), "\x7f")).toEqual(T("git"));
    expect(reduceTracked(T("gits"), "\b")).toEqual(T("git"));
  });

  it("backspace on empty stays empty", () => {
    expect(reduceTracked(T(""), "\x7f")).toEqual(T(""));
  });

  it("Enter starts a fresh tracked line", () => {
    expect(reduceTracked(T("git status"), "\r")).toEqual(T(""));
  });

  it("stops tracking on an arrow-key escape sequence", () => {
    expect(reduceTracked(T("git status"), "\x1b[D")).toEqual({
      input: "",
      tracking: false,
    });
  });

  it("stops tracking on a Ctrl sequence", () => {
    expect(reduceTracked(T("git status"), "\x03")).toEqual({
      input: "",
      tracking: false,
    });
  });

  it("stops tracking on a paste containing a newline", () => {
    expect(reduceTracked(T("a"), "b\nc")).toEqual({
      input: "",
      tracking: false,
    });
  });

  it("does NOT build input while untracked (no partial-suffix matching)", () => {
    const s = { input: "", tracking: false };
    expect(reduceTracked(s, "x")).toEqual(s);
    expect(reduceTracked(s, "\x7f")).toEqual(s);
  });

  it("re-enables tracking on the next Enter", () => {
    expect(reduceTracked({ input: "", tracking: false }, "\r")).toEqual(T(""));
  });
});
