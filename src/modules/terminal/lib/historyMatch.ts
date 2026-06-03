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

/** Prompt sigils that conventionally sit at the END of a shell prompt, just
 * before the command: bash `$`, root `#`, zsh `%`, starship/pure `❯`. `>` is
 * deliberately excluded so a `>`/`>>` redirect in the command isn't mistaken
 * for the prompt boundary. */
const PROMPT_SIGILS = "$#%❯";
const PROMPT_BOUNDARY = new RegExp(`[${PROMPT_SIGILS}][ \\t]`, "g");

/**
 * Best-effort column where the command starts on a prompt row that carries NO
 * shell integration (a stock remote shell over SSH): the position just past the
 * last prompt sigil-then-space at or before `cursorX`. Returns -1 when no
 * recognizable boundary is found, so the caller suggests nothing rather than
 * guessing the whole row. Pure, so the heuristic is unit-tested directly.
 */
export function promptInputStart(rowText: string, cursorX: number): number {
  const upToCursor = rowText.slice(0, Math.max(0, cursorX));
  PROMPT_BOUNDARY.lastIndex = 0;
  let end = -1;
  let m: RegExpExecArray | null;
  while ((m = PROMPT_BOUNDARY.exec(upToCursor)) !== null) {
    end = m.index + m[0].length;
  }
  return end;
}

/** The cwd shown in a stock remote shell's prompt, for the file explorer to
 * follow when an SSH session has no OSC 7 of its own. Pulls the trailing
 * `~`/`~/…`/`/…` path token that sits just before the prompt sigil on a clean
 * prompt row — the `\w` field of the common default PS1 (`\u@\h:\w\$`), e.g.
 * `pi@raspberrypi:~/Backups $` → `~/Backups`. Returns null when the row isn't a
 * clean prompt (a command is being typed, mid-output, or a custom prompt with
 * no path), so the caller keeps the last known cwd instead of guessing. `~` is
 * left unresolved — the caller expands it against the known remote home. */
const PROMPT_CWD = new RegExp(`([~/][^\\s]*)\\s*[${PROMPT_SIGILS}]\\s*$`);
export function promptCwd(rowText: string): string | null {
  const m = rowText.match(PROMPT_CWD);
  return m ? m[1] : null;
}
