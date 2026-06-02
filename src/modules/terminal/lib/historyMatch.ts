/**
 * Pure helpers for inline shell-history autocomplete. Kept free of xterm/DOM so
 * the matching and input-reconstruction rules are unit-testable on their own.
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

/** Reconstructed current line plus whether we still trust it. */
export type InputState = { input: string; tracking: boolean };

/**
 * Fold one chunk of terminal input into the reconstructed current line.
 *
 * We can only safely track plain forward typing and backspace. The moment
 * anything else happens — arrow keys, Ctrl-W, Tab completion, a paste with
 * control bytes — the line can change in ways we don't see, so we stop tracking
 * (`tracking: false`) and suppress suggestions until the next fresh prompt. A
 * bare Enter starts a fresh line, so it re-enables tracking with an empty input.
 *
 * Crucially we do NOT keep appending while untracked: doing so would build a
 * partial *suffix* of the real line (e.g. typing after Ctrl-W), which the
 * buffer cross-check can't catch because a suffix still `endsWith` itself. The
 * buffer cross-check remains a second line of defence on top of this.
 */
export function reduceTracked(state: InputState, data: string): InputState {
  if (data === "\r") {
    return { input: "", tracking: true };
  }
  if (data === "\x7f" || data === "\b") {
    return state.tracking
      ? { input: state.input.slice(0, -1), tracking: true }
      : state;
  }
  if (isPlainText(data)) {
    return state.tracking
      ? { input: state.input + data, tracking: true }
      : state;
  }
  return { input: "", tracking: false };
}

/** True when every char is printable (no ESC, no C0/C1 controls, no DEL). */
function isPlainText(data: string): boolean {
  if (data.length === 0) return false;
  for (const ch of data) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}
