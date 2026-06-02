/**
 * Pure helpers for inline shell-history autocomplete. Kept free of xterm/DOM so
 * the matching and input-derivation rules are unit-testable on their own.
 */

/**
 * Prefix matches for `input` against `entries` (which are already
 * most-recent-first and de-duplicated). Case-sensitive, exact-equal excluded
 * (no point suggesting what's already fully typed). An empty input returns the
 * most recent entries — used to populate the Ctrl+Space dropdown on a blank
 * prompt.
 */
export function matchHistory(
  entries: readonly string[],
  input: string,
  limit: number,
): string[] {
  const out: string[] = [];
  if (input === "") {
    for (const c of entries) {
      out.push(c);
      if (out.length >= limit) break;
    }
    return out;
  }
  for (const c of entries) {
    if (c.length > input.length && c.startsWith(input)) {
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** The single best ghost-text suggestion's *remainder* (the part past what's
 * typed), or "" when there's no match. */
export function ghostSuffix(entries: readonly string[], input: string): string {
  if (input === "") return "";
  const best = matchHistory(entries, input, 1)[0];
  return best ? best.slice(input.length) : "";
}

/**
 * The current command input as it sits on the prompt row, derived straight from
 * the xterm buffer: the row's text from the command-start column up to the
 * cursor. Empty when the cursor is at/before the start (e.g. a no-echo password
 * line keeps the cursor at the start col) or the start col is invalid. The
 * cursor is always left of any ghost (an overlay, not buffer text), so there's
 * no trailing-ghost to strip.
 */
export function deriveInputFromRow(
  rowText: string,
  startCol: number,
  cursorX: number,
): string {
  if (startCol < 0 || cursorX <= startCol) return "";
  return rowText.slice(startCol, cursorX);
}
