/**
 * Integration tests against the REAL @xterm/xterm Terminal (no fakes, no DOM,
 * never open()ed): feeds soft-wrapped and hard-wrapped URLs through the real
 * parser/buffer and asserts computeLinks resolves the full URL with exact
 * buffer ranges from every hovered row.
 */
import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { computeLinks } from "./linkProvider";

const COLS = 80;

const URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
  "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
  "&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=" +
  "q2embxFAq0m0ba4FJvEbO6H7mwG379wKYEuBvVnnaWo&code_challenge_method=S256" +
  "&state=wLYyXWG48Mazigbf0BtCRKgyzZf8TB-tv2leojA0vv0";

function makeTerm(): Terminal {
  return new Terminal({ cols: COLS, rows: 24, scrollback: 200 });
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

const activate = () => {};

function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

describe("computeLinks against a real xterm buffer", () => {
  it("resolves a hard-wrapped url (real newlines, Ink style) from every row", async () => {
    const term = makeTerm();
    const urlRows = chunks(URL, COLS);
    await write(
      term,
      "Browser didn't open? Use the url below to sign in (c to copy)\r\n\r\n" +
        urlRows.join("\r\n") +
        "\r\n\r\nPaste code here if prompted >",
    );

    const firstUrlY = 3;
    for (let i = 0; i < urlRows.length; i++) {
      const links = computeLinks(firstUrlY + i, term, activate);
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe(URL);
      expect(links[0].range.start).toEqual({ x: 1, y: firstUrlY });
      expect(links[0].range.end).toEqual({
        x: URL.length - COLS * (urlRows.length - 1),
        y: firstUrlY + urlRows.length - 1,
      });
    }

    const blankY = firstUrlY + urlRows.length;
    expect(computeLinks(blankY, term, activate)).toHaveLength(0);
    expect(computeLinks(blankY + 1, term, activate)).toHaveLength(0);
  });

  it("resolves a soft-wrapped url written as one long string", async () => {
    const term = makeTerm();
    await write(term, `url: ${URL}\r\nPaste code here if prompted >`);

    const totalRows = Math.ceil((URL.length + 5) / COLS);
    for (let y = 1; y <= totalRows; y++) {
      const links = computeLinks(y, term, activate);
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe(URL);
      expect(links[0].range.start).toEqual({ x: 6, y: 1 });
    }
  });

  it("does not glue unrelated text after a short url row", async () => {
    const term = makeTerm();
    await write(term, "https://example.com\r\nPaste code here");
    const links = computeLinks(1, term, activate);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("https://example.com");
  });

  it("finds no links in joined full rows without a url", async () => {
    const term = makeTerm();
    await write(term, `${"x".repeat(COLS)}\r\nyyy`);
    expect(computeLinks(1, term, activate)).toHaveLength(0);
    expect(computeLinks(2, term, activate)).toHaveLength(0);
  });
});
