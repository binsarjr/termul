import { describe, expect, it } from "vitest";
import type { GitChangedFile } from "@/modules/ai/lib/native";
import {
  fileStatusCode,
  moreProminentStatus,
  normalizeStatusCode,
  statusAccentClass,
  statusCodeForMode,
  statusTextClass,
} from "./statusDecoration";

function changed(partial: Partial<GitChangedFile> & { path: string }): GitChangedFile {
  return {
    originalPath: null,
    indexStatus: " ",
    worktreeStatus: " ",
    staged: false,
    unstaged: false,
    untracked: false,
    statusLabel: "",
    ...partial,
  };
}

describe("normalizeStatusCode", () => {
  it("maps porcelain chars to canonical codes", () => {
    expect(normalizeStatusCode("?")).toBe("U");
    expect(normalizeStatusCode("m")).toBe("M");
    expect(normalizeStatusCode("C")).toBe("R");
    expect(normalizeStatusCode("  A ")).toBe("A");
  });

  it("falls back to M for empty input", () => {
    expect(normalizeStatusCode("")).toBe("M");
  });
});

describe("fileStatusCode", () => {
  it("reports untracked files as U", () => {
    const file = changed({
      path: "a.txt",
      worktreeStatus: "?",
      unstaged: true,
      untracked: true,
    });
    expect(fileStatusCode(file)).toBe("U");
  });

  it("uses the index status for staged-only files", () => {
    const file = changed({ path: "a.txt", indexStatus: "A", staged: true });
    expect(fileStatusCode(file)).toBe("A");
    expect(statusCodeForMode("+", file)).toBe("A");
  });

  it("uses the worktree status for unstaged modifications", () => {
    const file = changed({ path: "a.txt", worktreeStatus: "M", unstaged: true });
    expect(fileStatusCode(file)).toBe("M");
  });
});

describe("status colors", () => {
  it("pairs each code with a foreground and background class", () => {
    expect(statusTextClass("U")).toContain("teal");
    expect(statusTextClass("M")).toContain("amber");
    expect(statusTextClass("D")).toContain("rose");
    expect(statusAccentClass("A")).toContain("emerald");
    expect(statusAccentClass("R")).toContain("sky");
  });

  it("falls back to a muted class for unknown codes", () => {
    expect(statusTextClass("X")).toContain("muted");
    expect(statusAccentClass("X")).toContain("muted");
  });
});

describe("moreProminentStatus", () => {
  it("ranks tracked modifications above additions and untracked", () => {
    expect(moreProminentStatus("M", "A")).toBe("M");
    expect(moreProminentStatus("A", "U")).toBe("A");
    expect(moreProminentStatus("D", "R")).toBe("D");
  });
});
