import { describe, expect, it } from "vitest";
import type { GitChangedFile, GitStatusSnapshot } from "@/modules/ai/lib/native";
import { buildGitDecorations } from "./useExplorerGitStatus";

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

function snapshot(
  repoRoot: string,
  changedFiles: GitChangedFile[],
): GitStatusSnapshot {
  return {
    repoRoot,
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    isDetached: false,
    truncated: false,
    changedFiles,
  };
}

const untracked = (path: string) =>
  changed({ path, worktreeStatus: "?", unstaged: true, untracked: true });
const modified = (path: string) =>
  changed({ path, worktreeStatus: "M", unstaged: true });
const stagedAdd = (path: string) =>
  changed({ path, indexStatus: "A", staged: true });

describe("buildGitDecorations", () => {
  it("returns empty decorations for a null status", () => {
    const { fileCode, dirCode } = buildGitDecorations(null, "/repo");
    expect(fileCode.size).toBe(0);
    expect(dirCode.size).toBe(0);
  });

  it("maps relative git paths to absolute explorer paths with codes", () => {
    const status = snapshot("/repo", [untracked("a.txt"), modified("src/b.ts")]);
    const { fileCode } = buildGitDecorations(status, "/repo");
    expect(fileCode.get("/repo/a.txt")).toBe("U");
    expect(fileCode.get("/repo/src/b.ts")).toBe("M");
  });

  it("rolls changes up into every ancestor directory inside the tree", () => {
    const status = snapshot("/repo", [modified("src/deep/b.ts")]);
    const { dirCode } = buildGitDecorations(status, "/repo");
    expect(dirCode.get("/repo/src/deep")).toBe("M");
    expect(dirCode.get("/repo/src")).toBe("M");
    expect(dirCode.get("/repo")).toBe("M");
  });

  it("picks the most prominent status when a folder has mixed children", () => {
    const status = snapshot("/repo", [
      stagedAdd("src/added.ts"),
      modified("src/changed.ts"),
    ]);
    const { dirCode } = buildGitDecorations(status, "/repo");
    expect(dirCode.get("/repo/src")).toBe("M"); // modified outranks added
  });

  it("excludes changes outside the explorer root", () => {
    const status = snapshot("/repo", [
      modified("src/inside.ts"),
      modified("other/outside.ts"),
    ]);
    const { fileCode, dirCode } = buildGitDecorations(status, "/repo/src");
    expect(fileCode.get("/repo/src/inside.ts")).toBe("M");
    expect(fileCode.has("/repo/other/outside.ts")).toBe(false);
    expect(dirCode.has("/repo/other")).toBe(false);
  });

  it("normalizes backslash repo roots to forward slashes", () => {
    const status = snapshot("C:\\repo", [modified("a.ts")]);
    const { fileCode } = buildGitDecorations(status, "C:/repo");
    expect(fileCode.get("C:/repo/a.ts")).toBe("M");
  });
});
