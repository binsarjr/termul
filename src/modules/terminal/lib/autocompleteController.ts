import type { Terminal } from "@xterm/xterm";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useHistoryStore } from "./historyStore";
import { useRemoteHistoryStore } from "./remoteHistoryStore";
import {
  cursorAtInputEnd,
  deriveInputFromRow,
  matchHistory,
  promptInputStart,
} from "./historyMatch";

/** Max rows shown in the Ctrl+Space dropdown. */
const DROPDOWN_MAX = 8;

/** What the overlay needs to paint, in client (screen) pixel coordinates — the
 * overlay converts to its local space and divides by the app zoom, exactly like
 * the block hover layer. Null render = paint nothing. */
export type AutocompleteRender = {
  cursorLeft: number;
  cursorTop: number;
  cellWidth: number;
  cellHeight: number;
  /** Inline ghost-text suffix after the cursor; "" when none. */
  ghost: string;
  /** Dropdown items, or null when the dropdown is closed/empty. */
  dropdown: string[] | null;
  selectedIndex: number;
};

/**
 * Per-terminal inline shell-history autocomplete: ghost text after the cursor
 * plus a Ctrl+Space dropdown. The current input is derived straight from the
 * xterm buffer using the OSC 133 prompt-end marker (B) the command-block feature
 * already pins, so it stays correct in any editing state — arrows, mid-line
 * edits, accepted suggestions — not just plain forward typing. The ghost only
 * renders (and accepts) while the cursor sits at the END of the input, fish
 * style — mid-line it would paint over the rest of the line and steal the
 * Right-arrow from cursor movement. All matching is local; a missing marker
 * (shell without integration) simply yields no input, so we never show a wrong
 * suggestion.
 *
 * The overlay reads {@link getRender} on an animation frame while something is
 * showing (mirroring the block hover layer) and parks once it goes null, so the
 * controller pokes {@link notify} whenever the buffer, viewport, history, or
 * prefs change — anything that could make a parked overlay paint again.
 * Re-resolving the controller each frame means a rebind after hibernation is
 * transparent.
 */
export class AutocompleteController {
  private dropdownOpen = false;
  private selectedIndex = 0;
  private disposers: (() => void)[] = [];
  // Single-slot memo over the history scans: the overlay settles on
  // consecutive frames with unchanged input, and both stores replace their
  // entry arrays immutably, so (entries, input) identity keys it exactly.
  private matchCache: { entries: string[]; input: string; items: string[] } | null =
    null;

  constructor(
    private readonly term: Terminal,
    private readonly write: (data: string) => void,
    private readonly getCommandStart: () => {
      line: number;
      col: number;
    } | null,
    /** The session's current SSH target (`[user@]host`) when it's in an `ssh`
     * session, else null — so matching draws on the remote shell's history. */
    private readonly getSshHost: () => string | null = () => null,
    /** Wakes the overlay's parked settle loop; the loop re-parks itself once
     * getRender() goes null, so notifying is always safe. */
    private readonly notify: () => void = () => {},
  ) {
    // Make sure history is loaded for matching (deduped in the store).
    void useHistoryStore.getState().load();
    this.disposers.push(term.onData((d) => this.onData(d)).dispose);
    this.disposers.push(term.onCursorMove(() => this.notify()).dispose);
    this.disposers.push(term.onRender(() => this.notify()).dispose);
    this.disposers.push(term.onScroll(() => this.notify()).dispose);
    // History arriving after the user already typed (first local load, a slow
    // remote fetch) and the autocomplete pref flipping on must also wake it.
    this.disposers.push(useHistoryStore.subscribe(() => this.notify()));
    this.disposers.push(useRemoteHistoryStore.subscribe(() => this.notify()));
    this.disposers.push(usePreferencesStore.subscribe(() => this.notify()));
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  private enabled(): boolean {
    return usePreferencesStore.getState().historyAutocomplete;
  }

  /** The active SSH target, or null when this session is on the local shell. */
  private host(): string | null {
    const h = this.getSshHost();
    return h && h.length > 0 ? h : null;
  }

  private entries(): string[] {
    const host = this.host();
    if (host) {
      // Lazily fetch the remote shell's history (deduped per host in the store).
      useRemoteHistoryStore.getState().ensure(host);
      return useRemoteHistoryStore.getState().entriesFor(host);
    }
    return useHistoryStore.getState().entries;
  }

  /** matchHistory, memoized on (entries, input) so the per-frame settle loop
   * and repeated key handling never re-scan history while nothing changed. */
  private cachedMatches(entries: string[], input: string): string[] {
    const c = this.matchCache;
    if (c && c.entries === entries && c.input === input) return c.items;
    const items = matchHistory(entries, input, DROPDOWN_MAX);
    this.matchCache = { entries, input, items };
    return items;
  }

  /** The ghost suffix (ghostSuffix semantics), derived from the same memoized
   * match list — the best match is its first row either way. */
  private cachedGhost(entries: string[], input: string): string {
    if (input === "") return "";
    const best = this.cachedMatches(entries, input)[0];
    return best ? best.slice(input.length) : "";
  }

  /** The current command input, read live from the buffer's prompt row, plus
   * whether the cursor sits at the END of that input (the only place a ghost
   * may render or be accepted — mid-line a Right-arrow means "move right").
   * Input is empty on the alt screen, on a wrapped/multi-row line, or when the
   * cursor sits at/before the command-start column.
   *
   * Two ways to locate where the command starts on the cursor row:
   *  - the OSC 133 prompt-end marker the local shell integration pins (precise);
   *  - in a remote SSH session, where a stock shell emits no OSC 133, a prompt
   *    heuristic ({@link promptInputStart}). Without this the remote case has no
   *    marker → empty input → the autocomplete could never suggest anything. */
  private readInput(): { input: string; atEnd: boolean } {
    const none = { input: "", atEnd: false };
    const buf = this.term.buffer.active;
    if (buf.type === "alternate") return none;
    const cursorRow = buf.baseY + buf.cursorY;

    const start = this.getCommandStart();
    if (start) {
      // Multi-row / wrapped input — bail. Safe: only costs a suggestion.
      if (cursorRow !== start.line) return none;
      const line = buf.getLine(start.line);
      if (!line) return none;
      // Column-addressed reads (translateToString with start/end columns):
      // wide CJK/emoji cells occupy two columns but one string char, so slicing
      // the whole-row string by column numbers would shear the input. Untrimmed
      // (trimRight=false) so a just-typed trailing space (e.g. "git ") survives
      // and the ghost doesn't double-space the next word; bounding at cursorX
      // keeps RPROMPT / right-aligned text past the cursor excluded.
      const input =
        start.col >= 0 && buf.cursorX > start.col
          ? line.translateToString(false, start.col, buf.cursorX)
          : "";
      return {
        input,
        atEnd: cursorAtInputEnd(line.translateToString(false, buf.cursorX)),
      };
    }

    // No marker. Only fall back to the prompt heuristic inside an ssh session,
    // so local behavior (which always has a marker) is left exactly as-is.
    // (String-indexed on purpose: promptInputStart scans the row text itself;
    // best-effort for stock remote prompts, which are overwhelmingly ASCII.)
    if (!this.host()) return none;
    const line = buf.getLine(cursorRow);
    if (!line) return none;
    const rowText = line.translateToString(false);
    const col = promptInputStart(rowText, buf.cursorX);
    if (col < 0) return none;
    return {
      input: deriveInputFromRow(rowText, col, buf.cursorX),
      atEnd: cursorAtInputEnd(line.translateToString(false, buf.cursorX)),
    };
  }

  private currentInput(): string {
    return this.readInput().input;
  }

  private onData(d: string): void {
    // A bare Enter (or Ctrl-J) submits the line: promote it so it's instantly
    // suggestable. currentInput() reads the echoed row, so a no-echo `read -s`
    // password keeps the cursor at the start col → empty → never captured
    // (no-secret-capture). A leading space is the shells' own "don't record
    // this" convention (HIST_IGNORE_SPACE / fish default) — honor it here too.
    if (d === "\r" || d === "\n") {
      // This Enter reached the PTY (a dropdown-consumed Enter never lands
      // here), so the line is submitted: close the dropdown or its key
      // handling would leak into whatever runs next (arrows in vim, etc).
      this.dropdownOpen = false;
      const input = this.currentInput();
      if (input.trim() && !input.startsWith(" ")) {
        const host = this.host();
        if (host) useRemoteHistoryStore.getState().addRecent(host, input);
        else useHistoryStore.getState().addRecent(input);
      }
    }
    if (this.dropdownOpen) this.clampSelection();
  }

  private clampSelection(): void {
    const n = this.cachedMatches(this.entries(), this.currentInput()).length;
    this.selectedIndex = n === 0 ? 0 : Math.min(this.selectedIndex, n - 1);
  }

  /** Live geometry + suggestion for the overlay; null when nothing to show.
   * Cheap to call every frame: short-circuits before any layout read when the
   * line is empty and the dropdown is closed. */
  getRender(): AutocompleteRender | null {
    if (!this.enabled()) return null;
    const { input, atEnd } = this.readInput();
    if (input.length === 0 && !this.dropdownOpen) return null;

    const screen = this.term.element?.querySelector(
      ".xterm-screen",
    ) as HTMLElement | null;
    if (!screen) return null;
    const rect = screen.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const cols = this.term.cols;
    const rows = this.term.rows;
    if (cols <= 0 || rows <= 0) return null;

    const buf = this.term.buffer.active;
    if (buf.type === "alternate") return null;
    // Only paint while the viewport is pinned to the bottom (the live prompt).
    // cursorY is relative to the bottom page, so a scrolled-back viewport would
    // place the ghost over scrollback rows instead of the (off-screen) cursor.
    if (buf.viewportY !== buf.baseY) return null;
    const cx = buf.cursorX;
    const cy = buf.cursorY;
    if (cy < 0 || cy >= rows) return null;

    const entries = this.entries();
    // No ghost mid-line: it would paint over the text right of the cursor.
    const ghost = input && atEnd ? this.cachedGhost(entries, input) : "";
    const items = this.dropdownOpen ? this.cachedMatches(entries, input) : [];
    const dropdown = items.length > 0 ? items : null;
    if (!ghost && !dropdown) return null;

    const cellWidth = rect.width / cols;
    const cellHeight = rect.height / rows;
    return {
      cursorLeft: rect.left + cx * cellWidth,
      cursorTop: rect.top + cy * cellHeight,
      cellWidth,
      cellHeight,
      ghost,
      dropdown,
      selectedIndex: dropdown
        ? Math.min(this.selectedIndex, dropdown.length - 1)
        : 0,
    };
  }

  /** Accept the inline ghost suggestion — only when the cursor sits at the end
   * of the input, mirroring where the ghost renders; mid-line the Right-arrow
   * must keep moving the cursor, not splice the suffix into the line. The next
   * frame re-derives the input from the buffer once the shell echoes the write,
   * so there's no local state to keep in sync. */
  private acceptGhost(): boolean {
    const { input, atEnd } = this.readInput();
    if (!input || !atEnd) return false;
    const ghost = this.cachedGhost(this.entries(), input);
    if (!ghost) return false;
    this.write(ghost);
    return true;
  }

  private acceptSelected(): boolean {
    const input = this.currentInput();
    const items = this.cachedMatches(this.entries(), input);
    const pick = items[this.selectedIndex];
    if (!pick) return false;
    // An empty input (blank-prompt dropdown) is fine — we write the whole pick.
    const remainder = pick.slice(input.length);
    if (remainder) this.write(remainder);
    this.dropdownOpen = false;
    return true;
  }

  /** Accept a dropdown row by index — the overlay's click path. */
  acceptDropdownIndex(index: number): boolean {
    if (!this.dropdownOpen || index < 0) return false;
    this.selectedIndex = index;
    return this.acceptSelected();
  }

  /**
   * Called from the renderer pool's key handler on keydown. Returns true when
   * the key was consumed (the pool then preventDefaults and drops it). Returns
   * false for everything else so normal typing/onData tracking continues.
   */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.enabled()) return false;

    // Never touch keys on the alt screen (vim/htop/less): there is no prompt
    // to complete there, and consuming Ctrl+Space would eat readline/emacs
    // set-mark. Also drop any dropdown that survived into the TUI, so its key
    // branch below can't swallow arrows/Escape or paste an entry via Enter.
    if (this.term.buffer.active.type === "alternate") {
      this.dropdownOpen = false;
      return false;
    }

    // Ctrl+Space toggles the dropdown.
    if (
      event.ctrlKey &&
      (event.code === "Space" || event.key === " ") &&
      !event.metaKey &&
      !event.altKey
    ) {
      this.dropdownOpen = !this.dropdownOpen;
      this.selectedIndex = 0;
      // No echo follows a consumed key, so wake the parked overlay directly.
      this.notify();
      return true;
    }

    if (this.dropdownOpen) {
      switch (event.key) {
        case "Escape":
          this.dropdownOpen = false;
          return true;
        case "ArrowDown": {
          const n = this.cachedMatches(this.entries(), this.currentInput())
            .length;
          if (n > 0) this.selectedIndex = (this.selectedIndex + 1) % n;
          return true;
        }
        case "ArrowUp": {
          const n = this.cachedMatches(this.entries(), this.currentInput())
            .length;
          if (n > 0) this.selectedIndex = (this.selectedIndex - 1 + n) % n;
          return true;
        }
        case "Enter":
        case "Tab":
          return this.acceptSelected();
        default:
          return false;
      }
    }

    // Inline ghost: plain Right-arrow at end of line accepts it (fish-style).
    // Modified Right is line/word navigation, handled elsewhere.
    if (
      event.key === "ArrowRight" &&
      !event.metaKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.shiftKey
    ) {
      return this.acceptGhost();
    }

    return false;
  }
}
