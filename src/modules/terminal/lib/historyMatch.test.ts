import { describe, expect, it } from "vitest";
import {
  commandFromPromptRow,
  cursorAtInputEnd,
  deriveInputFromRow,
  ghostSuffix,
  isCleanPromptRow,
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

  it("skips multiline entries (accepting one would run its first line)", () => {
    const entries = ["for i in 1 2\ndo echo $i\ndone", "for x in", "ls"];
    expect(matchHistory(entries, "for", 10)).toEqual(["for x in"]);
    expect(matchHistory(entries, "", 10)).toEqual(["for x in", "ls"]);
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

describe("cursorAtInputEnd", () => {
  // Takes the untrimmed row text from the cursor column to the row's end;
  // real xterm pads trailing blank cells out to the full terminal width.
  const pad = (text: string, cols = 72) => text.padEnd(cols, " ");

  it("true when only blanks follow the cursor", () => {
    expect(cursorAtInputEnd(pad(""))).toBe(true);
  });

  it("true when nothing follows the cursor (unpadded row)", () => {
    expect(cursorAtInputEnd("")).toBe(true);
  });

  it("false with text right at the cursor (mid-line edit)", () => {
    expect(cursorAtInputEnd(pad("atus"))).toBe(false);
  });

  it("false when the cursor sits on a space inside the command", () => {
    expect(cursorAtInputEnd(pad(" status"))).toBe(false);
  });

  it("tolerates a right-aligned RPROMPT hugging the row's right edge", () => {
    expect(cursorAtInputEnd(" ".repeat(65) + "[main] ")).toBe(true);
  });

  it("false for a double-space gap inside the command (tail not at the edge)", () => {
    expect(cursorAtInputEnd(pad("  status"))).toBe(false);
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

describe("isCleanPromptRow", () => {
  // Untrimmed rows: real xterm pads trailing blank cells to the full width.
  const pad = (text: string, cols = 72) => text.padEnd(cols, " ");

  it("true on a clean bash prompt with the cursor at the input col", () => {
    const row = pad("pi@raspberrypi:~/Desktop $ ");
    expect(isCleanPromptRow(row, 27)).toBe(true);
  });

  it("false once a command is typed before the cursor", () => {
    const row = pad("pi@raspberrypi:~ $ ls");
    expect(isCleanPromptRow(row, 21)).toBe(false);
  });

  it("false with real text right after the cursor (mid-line)", () => {
    const row = pad("host $ ls");
    expect(isCleanPromptRow(row, 7)).toBe(false);
  });

  it("false on a password-style row (no sigil, no path)", () => {
    expect(isCleanPromptRow(pad("Password:"), 9)).toBe(false);
  });

  it("false on an empty row", () => {
    expect(isCleanPromptRow(pad(""), 0)).toBe(false);
  });

  it("tolerates a right-aligned RPROMPT hugging the row's edge", () => {
    const row = "~/proj ❯ " + " ".repeat(56) + "[main] ";
    expect(isCleanPromptRow(row, 9)).toBe(true);
  });

  it("true via the promptCwd fallback when the sigil sits at EOL (no trailing space)", () => {
    expect(isCleanPromptRow(pad("root@host:/etc#"), 15)).toBe(true);
  });

  // Pinned behavior, not an endorsement: output that ends in `sigil+space`
  // with the cursor resting right after is indistinguishable from a prompt.
  it("false-positive on prompt-lookalike output (documented limitation)", () => {
    expect(isCleanPromptRow(pad("Total: 100$ "), 12)).toBe(true);
  });
});

describe("commandFromPromptRow", () => {
  const pad = (text: string, cols = 72) => text.padEnd(cols, " ");

  it("returns the typed command on a clean prompt row", () => {
    const row = pad("pi@raspberrypi:~ $ ls -la");
    expect(commandFromPromptRow(row, 25)).toBe("ls -la");
  });

  it("null when the row has no recognizable prompt boundary", () => {
    expect(commandFromPromptRow(pad("Password:"), 9)).toBeNull();
  });

  it("null for a bare Enter on an empty prompt", () => {
    expect(commandFromPromptRow(pad("host $ "), 7)).toBeNull();
  });

  it("strips a right-aligned RPROMPT via the cursor-bounded slice", () => {
    const row = "host $ ls" + " ".repeat(56) + "[main] ";
    expect(commandFromPromptRow(row, 9)).toBe("ls");
  });

  it("takes the full row tail when the cursor sits mid-line (shell runs the whole line)", () => {
    const row = pad("host $ ls -la");
    expect(commandFromPromptRow(row, 9)).toBe("ls -la");
  });

  it("trims leading spaces of the typed input", () => {
    const row = pad("host $   ls");
    expect(commandFromPromptRow(row, 11)).toBe("ls");
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
