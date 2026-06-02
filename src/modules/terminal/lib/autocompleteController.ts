import type { Terminal } from "@xterm/xterm";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useHistoryStore } from "./historyStore";
import {
  ghostSuffix,
  type InputState,
  matchHistory,
  reduceTracked,
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
 * plus a Ctrl+Space dropdown. The current input line is reconstructed from
 * keystrokes ({@link reduceInput}) and cross-checked against the real xterm
 * buffer before anything is shown, so a tracking drift only ever costs a
 * suggestion — it never injects or displays a wrong one. All matching is local.
 *
 * The overlay polls {@link getRender} on an animation frame (mirroring the
 * block hover layer), so this controller stays a plain object — no emitter, and
 * re-resolving it each frame means a rebind after hibernation is transparent.
 */
export class AutocompleteController {
  private input = "";
  /** False once we've lost track of the line (a control sequence we can't model);
   * no input is built and no ghost shown until the next fresh prompt (Enter). */
  private tracking = true;
  private dropdownOpen = false;
  private selectedIndex = 0;
  private disposers: (() => void)[] = [];

  constructor(
    private readonly term: Terminal,
    private readonly write: (data: string) => void,
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

  private onData(d: string): void {
    // A bare Enter submits the line: promote it so it's instantly suggestable —
    // but only if we were tracking and it was actually visible (echoed), so
    // no-echo input like a `read -s` password is never captured.
    if (
      d === "\r" &&
      this.tracking &&
      this.input.trim() &&
      this.inputVisible()
    ) {
      useHistoryStore.getState().addRecent(this.input);
    }
    const next: InputState = reduceTracked(
      { input: this.input, tracking: this.tracking },
      d,
    );
    this.input = next.input;
    this.tracking = next.tracking;
    // Losing the line (arrow keys, Ctrl-*, paste with controls) also closes the
    // dropdown, so a stale selection can never splice into a line we no longer
    // recognise.
    if (!next.tracking) this.dropdownOpen = false;
    else if (this.dropdownOpen) this.clampSelection();
  }

  /** True when the text on the cursor's row up to the cursor ends with our
   * reconstructed input — i.e. the input is really sitting at the cursor. */
  private inputVisible(): boolean {
    if (this.input.length === 0) return false;
    const buf = this.term.buffer.active;
    if (buf.type === "alternate") return false;
    const cy = buf.cursorY;
    if (cy < 0 || cy >= this.term.rows) return false;
    const line = buf.getLine(buf.baseY + cy)?.translateToString(true) ?? "";
    return line.slice(0, buf.cursorX).endsWith(this.input);
  }

  private clampSelection(): void {
    const n = matchHistory(this.entries(), this.input, DROPDOWN_MAX).length;
    this.selectedIndex = n === 0 ? 0 : Math.min(this.selectedIndex, n - 1);
  }

  /** Live geometry + suggestion for the overlay; null when nothing to show.
   * Cheap to call every frame: short-circuits before any layout read when the
   * line is empty and the dropdown is closed. */
  getRender(): AutocompleteRender | null {
    if (!this.enabled()) return null;
    if (this.input.length === 0 && !this.dropdownOpen) return null;

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
    const ghost = this.inputVisible() ? ghostSuffix(entries, this.input) : "";
    const items = this.dropdownOpen
      ? matchHistory(entries, this.input, DROPDOWN_MAX)
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

  /** Accept the inline ghost suggestion (Right-arrow at end-of-line). */
  private acceptGhost(): boolean {
    if (!this.inputVisible()) return false;
    const ghost = ghostSuffix(this.entries(), this.input);
    if (!ghost) return false;
    this.write(ghost);
    this.input += ghost;
    return true;
  }

  private acceptSelected(): boolean {
    const items = matchHistory(this.entries(), this.input, DROPDOWN_MAX);
    const pick = items[this.selectedIndex];
    if (!pick) return false;
    // Never splice into a line whose content we don't recognise. An empty input
    // (blank-prompt dropdown) is fine — we just write the whole command.
    if (this.input !== "" && !this.inputVisible()) return false;
    const remainder = pick.slice(this.input.length);
    if (remainder) this.write(remainder);
    this.input = pick;
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
          const n = matchHistory(this.entries(), this.input, DROPDOWN_MAX).length;
          if (n > 0) this.selectedIndex = (this.selectedIndex + 1) % n;
          return true;
        }
        case "ArrowUp": {
          const n = matchHistory(this.entries(), this.input, DROPDOWN_MAX).length;
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
