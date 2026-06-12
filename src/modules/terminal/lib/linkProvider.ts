import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";

// Port of @xterm/addon-web-links' LinkComputer (Copyright (c) 2019 The
// xterm.js authors, MIT), extended to follow URLs across hard newlines. Ink-based CLIs (Claude Code,
// gh, ...) pre-wrap long URLs at the terminal width with real line breaks, so
// every visual row is its own unwrapped buffer line and the stock addon only
// matched (and opened) the clicked fragment. A row is treated as continuing
// onto the next when it is filled to the last column and the next row starts
// with a non-space character at column 0 (same heuristic as iTerm2/WezTerm).
const URL_REGEX =
  /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/;

const MAX_JOIN_CHARS = 2048;

export class TermulWebLinkProvider implements ILinkProvider {
  constructor(
    private readonly terminal: Terminal,
    private readonly activate: (event: MouseEvent, uri: string) => void,
  ) {}

  provideLinks(
    y: number,
    callback: (links: ILink[] | undefined) => void,
  ): void {
    callback(computeLinks(y, this.terminal, this.activate));
  }
}

export function computeLinks(
  y: number,
  terminal: Terminal,
  activate: (event: MouseEvent, uri: string) => void,
): ILink[] {
  const rex = new RegExp(URL_REGEX.source, "g");
  const [lines, startLineIndex] = getWindowedLineStrings(y - 1, terminal);
  const joined = lines.join("");

  const result: ILink[] = [];
  let match: RegExpExecArray | null;
  while ((match = rex.exec(joined))) {
    const text = match[0];
    if (!isUrl(text)) continue;

    const [startY, startX] = mapStrIdx(
      terminal,
      startLineIndex,
      0,
      match.index,
    );
    const [endY, endX] = mapStrIdx(terminal, startY, startX, text.length);
    if (startY === -1 || startX === -1 || endY === -1 || endX === -1) continue;

    result.push({
      range: {
        start: { x: startX + 1, y: startY + 1 },
        end: { x: endX, y: endY + 1 },
      },
      text,
      activate,
    });
  }
  return result;
}

function isUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const parsedBase =
      url.password && url.username
        ? `${url.protocol}//${url.username}:${url.password}@${url.host}`
        : url.username
          ? `${url.protocol}//${url.username}@${url.host}`
          : `${url.protocol}//${url.host}`;
    return urlString
      .toLocaleLowerCase()
      .startsWith(parsedBase.toLocaleLowerCase());
  } catch {
    return false;
  }
}

// True when `lower` continues the line above it: soft wrap (xterm reflow), or
// a hard wrap where the upper row runs to the last column and the lower row
// starts flush at column 0.
function joinsUp(
  upperContent: string,
  lower: IBufferLine,
  lowerContent: string,
  cols: number,
): boolean {
  if (lower.isWrapped) return true;
  return (
    upperContent.length === cols &&
    lowerContent.length > 0 &&
    lowerContent[0] !== " "
  );
}

// Collect the rows around lineIndex that can hold one continuous URL, joined
// top to bottom. Expansion stops at a row containing a space (a URL cannot
// cross it) or past MAX_JOIN_CHARS. Returns the line strings plus the top
// line index. Rows are pulled with trimRight=true, which only ever trims the
// window's last row (every joined row above is full by construction), so the
// string-to-buffer mapping in mapStrIdx stays exact.
function getWindowedLineStrings(
  lineIndex: number,
  terminal: Terminal,
): [string[], number] {
  const buf = terminal.buffer.active;
  const current = buf.getLine(lineIndex);
  if (!current) return [[], lineIndex];
  const currentContent = current.translateToString(true);

  const lines: string[] = [];
  let topIdx = lineIndex;
  let scanned = 0;

  let lower: IBufferLine = current;
  let lowerContent = currentContent;
  while (scanned < MAX_JOIN_CHARS) {
    const upper = buf.getLine(topIdx - 1);
    if (!upper) break;
    const upperContent = upper.translateToString(true);
    if (!joinsUp(upperContent, lower, lowerContent, terminal.cols)) break;
    topIdx--;
    lines.push(upperContent);
    scanned += upperContent.length;
    if (upperContent.includes(" ")) break;
    lower = upper;
    lowerContent = upperContent;
  }
  lines.reverse();
  lines.push(currentContent);

  let bottomIdx = lineIndex;
  let upperContent = currentContent;
  scanned = 0;
  while (scanned < MAX_JOIN_CHARS) {
    const below = buf.getLine(bottomIdx + 1);
    if (!below) break;
    const belowContent = below.translateToString(true);
    if (!joinsUp(upperContent, below, belowContent, terminal.cols)) break;
    bottomIdx++;
    lines.push(belowContent);
    scanned += belowContent.length;
    if (belowContent.includes(" ")) break;
    upperContent = belowContent;
  }

  return [lines, topIdx];
}

// Map a string index in the joined window back to a buffer position as
// [lineIndex, columnIndex] (0-based), or [-1, -1] on a missing line.
function mapStrIdx(
  terminal: Terminal,
  lineIndex: number,
  rowIndex: number,
  stringIndex: number,
): [number, number] {
  const buf = terminal.buffer.active;
  const cell = buf.getNullCell();
  let start = rowIndex;
  while (stringIndex) {
    const line = buf.getLine(lineIndex);
    if (!line) return [-1, -1];
    for (let i = start; i < line.length; ++i) {
      line.getCell(i, cell);
      const chars = cell.getChars();
      const width = cell.getWidth();
      if (width) {
        stringIndex -= chars.length || 1;

        // Correct for an early-wrapped wide char: the row's last cell is left
        // empty and the glyph starts the next (wrapped) row, but trimRight
        // already dropped that empty cell from the string.
        if (i === line.length - 1 && chars === "") {
          const next = buf.getLine(lineIndex + 1);
          if (next?.isWrapped) {
            next.getCell(0, cell);
            if (cell.getWidth() === 2) stringIndex += 1;
          }
        }
      }
      if (stringIndex < 0) return [lineIndex, i];
    }
    lineIndex++;
    start = 0;
  }
  return [lineIndex, start];
}
