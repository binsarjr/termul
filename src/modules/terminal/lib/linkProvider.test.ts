import type { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { computeLinks } from "./linkProvider";

type Row = { text: string; wrapped?: boolean };

function makeCell() {
  return {
    chars: "",
    width: 1,
    getChars() {
      return this.chars;
    },
    getWidth() {
      return this.width;
    },
  };
}

function makeTerminal(rows: Row[], cols: number): Terminal {
  const lines = rows.map((row) => ({
    isWrapped: !!row.wrapped,
    length: cols,
    translateToString(trimRight: boolean) {
      const padded = row.text.padEnd(cols, " ");
      return trimRight ? padded.replace(/ +$/, "") : padded;
    },
    getCell(x: number, cell: ReturnType<typeof makeCell>) {
      cell.chars = x < row.text.length ? row.text[x] : "";
      cell.width = 1;
      return cell;
    },
  }));
  return {
    cols,
    buffer: {
      active: {
        getLine: (i: number) => lines[i],
        getNullCell: makeCell,
      },
    },
  } as unknown as Terminal;
}

const activate = () => {};

function linksAt(rows: Row[], cols: number, y: number) {
  return computeLinks(y, makeTerminal(rows, cols), activate);
}

describe("computeLinks", () => {
  it("finds a plain single-row url with the exact range", () => {
    const links = linksAt([{ text: "see https://example.com now" }], 40, 1);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("https://example.com");
    expect(links[0].range).toEqual({
      start: { x: 5, y: 1 },
      end: { x: 23, y: 1 },
    });
  });

  it("joins soft-wrapped rows like the stock addon", () => {
    const rows: Row[] = [
      { text: "https://example.com/" },
      { text: "abcdef", wrapped: true },
    ];
    for (const y of [1, 2]) {
      const links = linksAt(rows, 20, y);
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe("https://example.com/abcdef");
      expect(links[0].range).toEqual({
        start: { x: 1, y: 1 },
        end: { x: 6, y: 2 },
      });
    }
  });

  it("joins hard-wrapped full rows into one url from any hovered row", () => {
    const rows: Row[] = [
      { text: "Open this url now:" },
      { text: "https://example.com/" },
      { text: "abc/def/ghi/jklmnopq" },
      { text: "rst" },
      { text: "Paste code here" },
    ];
    for (const y of [2, 3, 4]) {
      const links = linksAt(rows, 20, y);
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe(
        "https://example.com/abc/def/ghi/jklmnopqrst",
      );
      expect(links[0].range).toEqual({
        start: { x: 1, y: 2 },
        end: { x: 3, y: 4 },
      });
    }
  });

  it("joins a hard-wrapped url that starts mid-row", () => {
    const rows: Row[] = [{ text: "see https://e.com/ab" }, { text: "cdef" }];
    for (const y of [1, 2]) {
      const links = linksAt(rows, 20, y);
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe("https://e.com/abcdef");
      expect(links[0].range).toEqual({
        start: { x: 5, y: 1 },
        end: { x: 4, y: 2 },
      });
    }
  });

  it("resolves a long pre-wrapped oauth-style url from every row", () => {
    const cols = 100;
    const url =
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
      "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
      "&scope=org%3Acreate_api_key+user%3Aprofile&code_challenge=q2embxFAq0m0ba4FJvEbO6H7mwG379wKYEuBvVnnaWo" +
      "&code_challenge_method=S256&state=wLYyXWG48Mazigbf0BtCRKgyzZf8TB-tv2leojA0vv0";
    const rows: Row[] = [];
    for (let i = 0; i < url.length; i += cols) {
      rows.push({ text: url.slice(i, i + cols) });
    }
    for (let y = 1; y <= rows.length; y++) {
      const links = linksAt(rows, cols, y);
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe(url);
    }
  });

  it("does not join when the url row stops short of the last column", () => {
    const rows: Row[] = [
      { text: "https://example.com" },
      { text: "Paste code here" },
    ];
    const links = linksAt(rows, 20, 1);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("https://example.com");
  });

  it("does not join when the next row is indented", () => {
    const rows: Row[] = [
      { text: "https://example.com/" },
      { text: "  indented text" },
    ];
    const links = linksAt(rows, 20, 1);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("https://example.com/");
  });

  it("returns nothing for joined full rows without a url", () => {
    const rows: Row[] = [{ text: "x".repeat(20) }, { text: "yyy" }];
    expect(linksAt(rows, 20, 1)).toHaveLength(0);
    expect(linksAt(rows, 20, 2)).toHaveLength(0);
  });

  it("rejects matches that do not parse as a url", () => {
    const links = linksAt([{ text: "https://%" }], 40, 1);
    expect(links).toHaveLength(0);
  });

  it("handles a missing buffer line", () => {
    expect(linksAt([{ text: "https://example.com" }], 40, 5)).toHaveLength(0);
  });
});
