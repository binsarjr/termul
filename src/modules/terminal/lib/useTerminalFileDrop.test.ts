import { describe, expect, it } from "vitest";
import { quoteShellArg } from "@/lib/shellQuote";
import { formatDropPaths } from "./useTerminalFileDrop";

describe("formatDropPaths", () => {
  it("returns an empty string for no paths", () => {
    expect(formatDropPaths([])).toBe("");
  });

  it("shell-quotes a single path", () => {
    expect(formatDropPaths(["/Users/me/shot.png"])).toBe(
      quoteShellArg("/Users/me/shot.png"),
    );
  });

  it("quotes paths with spaces so the shell keeps them as one argument", () => {
    const path = "/Users/me/my shot.png";
    const result = formatDropPaths([path]);
    expect(result).toBe(quoteShellArg(path));
    expect(result).toContain(" ");
  });

  it("joins multiple paths with a single space", () => {
    expect(formatDropPaths(["/a.png", "/b.png"])).toBe(
      `${quoteShellArg("/a.png")} ${quoteShellArg("/b.png")}`,
    );
  });

  it("drops empty path entries", () => {
    expect(formatDropPaths(["", "/a.png"])).toBe(quoteShellArg("/a.png"));
  });
});
