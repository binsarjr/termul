import { describe, expect, it } from "vitest";
import {
  deriveInputFromRow,
  ghostSuffix,
  matchHistory,
  promptCwd,
  promptInputStart,
} from "./historyMatch";

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

describe("promptInputStart", () => {
  it("finds the boundary after a `$ ` bash prompt", () => {
    const row = "pi@raspberrypi:~/Desktop $ ls -la";
    const col = promptInputStart(row, row.length);
    expect(row.slice(col)).toBe("ls -la");
  });

  it("handles a root `# ` prompt", () => {
    const row = "root@host:/etc # cat hosts";
    const col = promptInputStart(row, row.length);
    expect(row.slice(col)).toBe("cat hosts");
  });

  it("handles a zsh `% ` prompt", () => {
    const row = "host% git status";
    const col = promptInputStart(row, row.length);
    expect(row.slice(col)).toBe("git status");
  });

  it("handles a starship `❯ ` prompt", () => {
    const row = "~/code ❯ npm run dev";
    const col = promptInputStart(row, row.length);
    expect(row.slice(col)).toBe("npm run dev");
  });

  it("uses the LAST boundary when the path itself contains a sigil", () => {
    // The `#anchor` in the path must not win over the real `$ ` boundary.
    const row = "u@h:~/a#b $ echo hi";
    const col = promptInputStart(row, row.length);
    expect(row.slice(col)).toBe("echo hi");
  });

  it("returns -1 when there is no recognizable prompt boundary", () => {
    expect(promptInputStart("just some text", 14)).toBe(-1);
  });

  it("is bounded by the cursor, ignoring text to its right", () => {
    const row = "host $ ls -la --color";
    // Cursor sits right after "ls".
    const col = promptInputStart(row, 9);
    expect(row.slice(col, 9)).toBe("ls");
  });

  it("does not treat a `>` redirect as a prompt boundary", () => {
    const row = "host $ echo x > file";
    const col = promptInputStart(row, row.length);
    expect(row.slice(col)).toBe("echo x > file");
  });
});

describe("promptCwd", () => {
  it("pulls `~/sub` from the default bash prompt", () => {
    expect(promptCwd("pi@raspberrypi:~/Backups $ ")).toBe("~/Backups");
  });

  it("pulls a bare `~` (home)", () => {
    expect(promptCwd("pi@raspberrypi:~ $ ")).toBe("~");
  });

  it("pulls an absolute path", () => {
    expect(promptCwd("pi@raspberrypi:/var/log $ ")).toBe("/var/log");
  });

  it("handles a root `#` prompt glued to the path (no space)", () => {
    expect(promptCwd("root@host:/etc# ")).toBe("/etc");
  });

  it("handles zsh `%` and starship `❯` prompts", () => {
    expect(promptCwd("host ~/proj % ")).toBe("~/proj");
    expect(promptCwd("~/proj ❯ ")).toBe("~/proj");
  });

  it("returns null once a command is being typed (row no longer ends at the sigil)", () => {
    expect(promptCwd("pi@raspberrypi:~/Backups $ ls")).toBeNull();
  });

  it("returns null for a prompt with no path token", () => {
    expect(promptCwd("❯ ")).toBeNull();
    expect(promptCwd("$ ")).toBeNull();
  });

  it("takes the LAST path before the final sigil", () => {
    expect(promptCwd("ran /usr/bin $ then cd ~/x $ ")).toBe("~/x");
  });
});
