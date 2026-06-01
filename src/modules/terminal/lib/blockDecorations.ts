import type { IDecoration, IDisposable, Terminal } from "@xterm/xterm";
import type { CommandBlock, CommandBlockRing } from "./osc-handlers";

/**
 * Draws a per-block status bar in the left gutter of the terminal and owns the
 * "selected block" state used for keyboard navigation. One controller is bound
 * to the slot's live `term` + `ring` for as long as the slot is bound; it is
 * disposed (and its decorations released) when the slot unbinds.
 *
 * The bar is an xterm decoration anchored to each block's `startMarker`. xterm
 * only renders a decoration while its marker line is on screen, so the bar acts
 * as a per-command marker at the prompt row (the VS Code shell-integration
 * pattern) rather than a frame that floats over the whole viewport — which
 * would mean hand-tracking marker→pixel positions across scroll and reflow.
 */
export class BlockDecorations {
  private decorations = new Map<CommandBlock, IDecoration>();
  private selected: CommandBlock | null = null;
  private readonly offChange: () => void;
  private readonly offResize: IDisposable;
  private disposed = false;

  constructor(
    private readonly term: Terminal,
    private readonly ring: CommandBlockRing,
  ) {
    this.offChange = ring.onChange(() => this.rebuild());
    // A resize rewraps lines, so a decoration's cell height goes stale; rebuild
    // from the markers' current line positions.
    this.offResize = term.onResize(() => this.rebuild());
    this.rebuild();
  }

  getSelected(): CommandBlock | null {
    return this.validSelected();
  }

  clearSelection(): void {
    if (!this.selected) return;
    this.selected = null;
    this.applyStyles();
  }

  /**
   * Move the selection among the closed blocks. `delta < 0` walks toward older
   * blocks (Cmd+Up), `delta > 0` toward newer (Cmd+Down). With no current
   * selection, Up selects the newest block and Down is a no-op. Walking past
   * the newest block clears the selection (back to the live prompt). Returns
   * the newly selected block, or null when nothing is selected.
   */
  selectRelative(delta: number): CommandBlock | null {
    const blocks = this.ring.all();
    if (blocks.length === 0) return null;

    const current = this.validSelected();
    let idx: number;
    if (!current) {
      if (delta > 0) return null; // nothing newer than the prompt
      idx = blocks.length - 1; // first Cmd+Up → newest block
    } else {
      idx = blocks.indexOf(current) + delta;
    }

    if (idx < 0) idx = 0;
    if (idx >= blocks.length) {
      this.clearSelection();
      return null;
    }

    this.selected = blocks[idx];
    this.scrollToSelected();
    this.applyStyles();
    return this.selected;
  }

  /** Select a specific block without scrolling (it is already on screen). */
  select(block: CommandBlock | null): void {
    this.selected = block && this.ring.all().includes(block) ? block : null;
    this.applyStyles();
  }

  /** The block whose output range covers the buffer line under `clientY`, or
   * null when the click lands on the live prompt / blank area below the blocks.
   * Used to select the block under a right-click before opening its menu. */
  blockAtClientY(clientY: number): CommandBlock | null {
    const screen = this.term.element?.querySelector(
      ".xterm-screen",
    ) as HTMLElement | null;
    const rows = this.term.rows;
    if (!screen || rows <= 0) return null;
    const rect = screen.getBoundingClientRect();
    if (rect.height <= 0) return null;
    const cellHeight = rect.height / rows;
    let row = Math.floor((clientY - rect.top) / cellHeight);
    if (row < 0) row = 0;
    if (row > rows - 1) row = rows - 1;
    const line = this.term.buffer.active.viewportY + row;

    const blocks = this.ring.all();
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      const start = block.startMarker;
      if (!start || start.isDisposed || start.line < 0) continue;
      const end = block.endMarker;
      const endLine =
        end && !end.isDisposed && end.line >= 0
          ? end.line
          : Number.POSITIVE_INFINITY;
      if (line >= start.line && line < endLine) return block;
    }
    return null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offChange();
    this.offResize.dispose();
    for (const deco of this.decorations.values()) deco.dispose();
    this.decorations.clear();
    this.selected = null;
  }

  private validSelected(): CommandBlock | null {
    if (this.selected && !this.ring.all().includes(this.selected)) {
      this.selected = null; // evicted from the ring
    }
    return this.selected;
  }

  private scrollToSelected(): void {
    const block = this.selected;
    if (!block) return;
    const marker = block.startMarker ?? block.endMarker;
    if (marker && !marker.isDisposed && marker.line >= 0) {
      this.term.scrollToLine(marker.line);
    }
  }

  private rebuild(): void {
    if (this.disposed) return;
    for (const deco of this.decorations.values()) deco.dispose();
    this.decorations.clear();

    for (const block of this.ring.all()) {
      const start = block.startMarker;
      if (!start || start.isDisposed || start.line < 0) continue;
      const end = block.endMarker;
      const endLine =
        end && !end.isDisposed && end.line >= 0 ? end.line : start.line + 1;
      const height = Math.max(1, endLine - start.line);
      const deco = this.term.registerDecoration({
        marker: start,
        x: 0,
        width: 1,
        height,
        layer: "top",
      });
      if (!deco) continue;
      deco.onRender((el) => this.style(el, block));
      this.decorations.set(block, deco);
    }
  }

  private applyStyles(): void {
    for (const [block, deco] of this.decorations) {
      if (deco.element) this.style(deco.element, block);
    }
  }

  private style(el: HTMLElement, block: CommandBlock): void {
    const selected = block === this.selected;
    const exit = block.exitCode;
    // Don't let the thin bar eat clicks meant for the terminal grid below it.
    el.style.pointerEvents = "none";
    el.style.boxSizing = "border-box";
    el.style.width = selected ? "4px" : "3px";
    el.style.transition = "background-color 80ms ease";
    if (selected) {
      el.style.backgroundColor = "var(--ring)";
      el.style.boxShadow = "2px 0 6px -1px var(--ring)";
    } else {
      el.style.boxShadow = "none";
      el.style.backgroundColor =
        exit === null
          ? "transparent"
          : exit === 0
            ? "var(--border)"
            : "var(--destructive)";
    }
  }
}
