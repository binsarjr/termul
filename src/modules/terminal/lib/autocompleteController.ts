import type { Terminal } from "@xterm/xterm";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useHistoryStore } from "./historyStore";
import { deriveInputFromRow, ghostSuffix, matchHistory } from "./historyMatch";

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
 * edits, accepted suggestions — not just plain forward typing. All matching is
 * local; a missing marker (shell without integration) simply yields no input,
 * so we never show a wrong suggestion.
 *
 * The overlay polls {@link getRender} on an animation frame (mirroring the
 * block hover layer), so this controller stays a plain object — no emitter, and
 * re-resolving it each frame means a rebind after hibernation is transparent.
 */
export class AutocompleteController {
  private dropdownOpen = false;
  private selectedIndex = 0;
  private disposers: (() => void)[] = [];

  constructor(
    private readonly term: Terminal,
    private readonly write: (data: string) => void,
    private readonly getCommandStart: () => {
      line: number;
      col: number;
    } | null,
  ) {
    // Make sure history is loaded for matching (deduped in the store).
    void useHistoryStore.getState().load();
    this.disposers.push(term.onData((d) => this.onData(d)).dispose);
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  private enabled(): boolean {
    return usePreferencesStore.getState().historyAutocomplete;
  }

  private entries(): string[] {
    return useHistoryStore.getState().entries;
  }

  /** The current command input, read live from the buffer's prompt row. Empty
   * when there's no live prompt marker, on the alt screen, on a wrapped/multi-row
   * line, or when the cursor sits at/before the command-start column. */
  private currentInput(): string {
    const start = this.getCommandStart();
    if (!start) return "";
    const buf = this.term.buffer.active;
    if (buf.type === "alternate") return "";
    const cursorRow = buf.baseY + buf.cursorY;
    // Multi-row / wrapped input — bail. Safe: only costs a suggestion.
    if (cursorRow !== start.line) return "";
    // Untrimmed (trimRight=false): translateToString(true) drops trailing
    // whitespace, which would swallow a just-typed trailing space (e.g. "git ")
    // and make the ghost double-space the next word. The slice is bounded by
    // cursorX, so RPROMPT / right-aligned text past the cursor is still excluded.
    const rowText = buf.getLine(start.line)?.translateToString(false) ?? "";
    return deriveInputFromRow(rowText, start.col, buf.cursorX);
  }

  private onData(d: string): void {
    // A bare Enter submits the line: promote it so it's instantly suggestable.
    // currentInput() reads the echoed row, so a no-echo `read -s` password keeps
    // the cursor at the start col → empty → never captured (no-secret-capture).
    if (d === "\r") {
      const input = this.currentInput();
      if (input.trim()) useHistoryStore.getState().addRecent(input);
    }
    if (this.dropdownOpen) this.clampSelection();
  }

  private clampSelection(): void {
    const n = matchHistory(this.entries(), this.currentInput(), DROPDOWN_MAX)
      .length;
    this.selectedIndex = n === 0 ? 0 : Math.min(this.selectedIndex, n - 1);
  }

  /** Live geometry + suggestion for the overlay; null when nothing to show.
   * Cheap to call every frame: short-circuits before any layout read when the
   * line is empty and the dropdown is closed. */
  getRender(): AutocompleteRender | null {
    if (!this.enabled()) return null;
    const input = this.currentInput();
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
    const cx = buf.cursorX;
    const cy = buf.cursorY;
    if (cy < 0 || cy >= rows) return null;

    const entries = this.entries();
    const ghost = input ? ghostSuffix(entries, input) : "";
    const items = this.dropdownOpen
      ? matchHistory(entries, input, DROPDOWN_MAX)
      : [];
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

  /** Accept the inline ghost suggestion (Right-arrow at end-of-line). The next
   * frame re-derives the input from the buffer once the shell echoes the write,
   * so there's no local state to keep in sync. */
  private acceptGhost(): boolean {
    const input = this.currentInput();
    if (!input) return false;
    const ghost = ghostSuffix(this.entries(), input);
    if (!ghost) return false;
    this.write(ghost);
    return true;
  }

  private acceptSelected(): boolean {
    const input = this.currentInput();
    const items = matchHistory(this.entries(), input, DROPDOWN_MAX);
    const pick = items[this.selectedIndex];
    if (!pick) return false;
    // An empty input (blank-prompt dropdown) is fine — we write the whole pick.
    const remainder = pick.slice(input.length);
    if (remainder) this.write(remainder);
    this.dropdownOpen = false;
    return true;
  }

  /**
   * Called from the renderer pool's key handler on keydown. Returns true when
   * the key was consumed (the pool then preventDefaults and drops it). Returns
   * false for everything else so normal typing/onData tracking continues.
   */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.enabled()) return false;

    // Ctrl+Space toggles the dropdown.
    if (
      event.ctrlKey &&
      (event.code === "Space" || event.key === " ") &&
      !event.metaKey &&
      !event.altKey
    ) {
      this.dropdownOpen = !this.dropdownOpen;
      this.selectedIndex = 0;
      return true;
    }

    if (this.dropdownOpen) {
      switch (event.key) {
        case "Escape":
          this.dropdownOpen = false;
          return true;
        case "ArrowDown": {
          const n = matchHistory(this.entries(), this.currentInput(), DROPDOWN_MAX)
            .length;
          if (n > 0) this.selectedIndex = (this.selectedIndex + 1) % n;
          return true;
        }
        case "ArrowUp": {
          const n = matchHistory(this.entries(), this.currentInput(), DROPDOWN_MAX)
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
