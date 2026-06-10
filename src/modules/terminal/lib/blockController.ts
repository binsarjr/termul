import type { IMarker, Terminal } from "@xterm/xterm";
import type { CommandBlock, CommandBlockRing } from "./osc-handlers";

/** The buffer line of a marker, or null when it is missing / disposed / off. */
function liveLine(marker: IMarker | null): number | null {
  return marker && !marker.isDisposed && marker.line >= 0 ? marker.line : null;
}

/**
 * Top buffer line of a block's highlight — the command line, so the command and
 * its output read as one unit (Warp-style). The command's output begins at the
 * start marker (OSC 133 C), so the command itself sits on the row directly above
 * it. Deriving the top this way — rather than from the prompt marker (OSC 133 A)
 * — is both robust (the start marker is always captured for a real command) and
 * keeps the blank spacer line that many prompts print above themselves out of
 * the highlight. Falls back to the prompt line only when there is no output
 * marker at all. Null when neither anchor is live.
 */
function blockTopLine(block: CommandBlock): number | null {
  const startLine = liveLine(block.startMarker);
  if (startLine !== null) return Math.max(0, startLine - 1);
  return liveLine(block.promptMarker);
}

/** Exclusive bottom buffer line of a block: the next-prompt line (OSC 133 D)
 * when known, else just past the output start, else just past the top. Always
 * at least `topLine + 1` so an interactive block paints (and hit-tests) at least
 * its command row — a no-output command whose end marker collapses onto the top
 * line (e.g. at buffer line 0) must never produce an empty range. */
function blockEndLine(block: CommandBlock, topLine: number): number {
  const endLine = liveLine(block.endMarker);
  if (endLine !== null) return Math.max(topLine + 1, endLine);
  const startLine = liveLine(block.startMarker);
  if (startLine !== null) return Math.max(topLine + 1, startLine + 1);
  return topLine + 1;
}

/** A block is interactive — hoverable, selectable, highlightable — only when it
 * has a live anchor marker (output or prompt) AND a real command. Empty-Enter
 * prompts emit OSC 133 D/A but no C (no preexec), so they have no output marker
 * and no command; excluding them here means an empty prompt never gets a
 * highlight or toolbar, matching Warp. This is also the guard that keeps stray
 * "command not found"-era empty blocks from ever drawing UI regardless of how
 * the shell emitted them. */
export function isInteractiveBlock(block: CommandBlock): boolean {
  const hasAnchor =
    liveLine(block.startMarker) !== null ||
    liveLine(block.promptMarker) !== null;
  return hasAnchor && block.command.trim().length > 0;
}

/** Geometry of the active block, in client coordinates, clamped to the rows
 * currently on screen. `null` when the block is fully scrolled out of view. */
export type BlockFrame = {
  top: number;
  left: number;
  width: number;
  height: number;
  exitCode: number | null;
  source: "local" | "remote";
  selection: { index: number; total: number } | null;
};

/**
 * Owns the per-pane block interaction state — which block is hovered and which
 * is keyboard-selected — and turns the bound `term` + `ring` into the geometry
 * the hover overlay paints. One controller lives for as long as a slot is bound;
 * it is disposed when the slot unbinds.
 *
 * It deliberately registers no xterm decorations: a decoration is hidden the
 * moment its start row scrolls off (xterm keys visibility on the start marker
 * alone), which can't represent a whole-block surface. The overlay instead
 * reads `getActiveFrame()` each render frame and positions a single DOM element,
 * so the highlight stays correct even when a tall block's command row is above
 * the viewport.
 */
export class BlockController {
  private selected: CommandBlock | null = null;
  private hovered: CommandBlock | null = null;
  private readonly disposers: (() => void)[];
  private disposed = false;

  constructor(
    private readonly term: Terminal,
    private readonly ring: CommandBlockRing,
    /** Wakes the overlay's parked positioning loop; the loop re-parks itself
     * once getActiveFrame() goes null, so notifying is always safe. */
    private readonly notify: () => void = () => {},
  ) {
    this.disposers = [
      // Drop a hovered/selected block once it is evicted from the ring.
      ring.onChange(() => {
        this.validSelected();
        this.validHovered();
        this.notify();
      }),
      // A tracked block that scrolled fully out of view parks the overlay;
      // scrolling or resizing can bring it back on screen, so wake to re-check.
      term.onScroll(() => this.notify()).dispose,
      term.onResize(() => this.notify()).dispose,
    ];
  }

  /** The block the overlay attaches to: the hovered one, else the
   * keyboard-selected one. Null when neither applies. */
  getActiveBlock(): CommandBlock | null {
    return this.validHovered() ?? this.validSelected();
  }

  getSelected(): CommandBlock | null {
    return this.validSelected();
  }

  /** The most recent interactive block — the fallback target for copy/reinput
   * shortcuts when nothing is hovered or selected. Skips trailing empty-Enter
   * blocks so a bare prompt is never the copy target. */
  lastBlock(): CommandBlock | null {
    const blocks = this.interactive();
    return blocks.length ? blocks[blocks.length - 1] : null;
  }

  /** Hover the given block (no-op for non-interactive blocks / blocks not in the
   * ring). Pass null to clear the hover. */
  setHover(block: CommandBlock | null): void {
    const next =
      block && isInteractiveBlock(block) && this.interactive().includes(block)
        ? block
        : null;
    this.hovered = next;
    this.notify();
  }

  clearSelection(): void {
    this.selected = null;
    this.notify();
  }

  /**
   * Move the keyboard selection among the interactive blocks. `delta < 0` walks
   * toward older blocks (Cmd+Up), `delta > 0` toward newer (Cmd+Down). With no
   * current selection, Up selects the newest block and Down is a no-op. Walking
   * past the newest clears the selection (back to the live prompt). Returns the
   * newly selected block, or null when nothing is selected.
   */
  selectRelative(delta: number): CommandBlock | null {
    // Keyboard navigation takes over from the mouse: drop any hover so the
    // selected block becomes the active target even if the pointer is parked
    // over a different block (otherwise Cmd+C would copy the hovered one).
    this.hovered = null;
    this.notify();
    const blocks = this.interactive();
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
    this.notify();
    return this.selected;
  }

  /** Select a specific block without scrolling (it is already on screen), or
   * clear when passed null. Used by the right-click menu. */
  select(block: CommandBlock | null): void {
    this.selected =
      block && isInteractiveBlock(block) && this.interactive().includes(block)
        ? block
        : null;
    this.notify();
  }

  /** The interactive block whose row range covers the buffer line under
   * `clientY`, or null when the point lands on the live prompt / a gap / a
   * non-interactive (empty) prompt. */
  blockAtClientY(clientY: number): CommandBlock | null {
    const screen = this.screenEl();
    const rows = this.term.rows;
    if (!screen || rows <= 0) return null;
    const rect = screen.getBoundingClientRect();
    if (rect.height <= 0) return null;
    const cellHeight = rect.height / rows;
    let row = Math.floor((clientY - rect.top) / cellHeight);
    if (row < 0) row = 0;
    if (row > rows - 1) row = rows - 1;
    const line = this.term.buffer.active.viewportY + row;

    const blocks = this.interactive();
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      const topLine = blockTopLine(block);
      if (topLine === null) continue;
      // Span the command line through the output: a click on either hits it.
      if (line >= topLine && line < blockEndLine(block, topLine)) return block;
    }
    return null;
  }

  /** Client-coordinate geometry of the active block, clamped to the on-screen
   * rows, plus its exit status and selection index. Null when there is no active
   * block or it is fully scrolled out of view. One `getBoundingClientRect`. */
  getActiveFrame(): BlockFrame | null {
    const block = this.getActiveBlock();
    if (!block) return null;
    const topLine = blockTopLine(block);
    if (topLine === null) return null;
    const screen = this.screenEl();
    const rows = this.term.rows;
    if (!screen || rows <= 0) return null;
    const rect = screen.getBoundingClientRect();
    if (rect.height <= 0) return null;
    const cellHeight = rect.height / rows;
    const viewportY = this.term.buffer.active.viewportY;
    const endLine = blockEndLine(block, topLine);
    const topRow = Math.max(0, topLine - viewportY);
    const botRow = Math.min(rows, endLine - viewportY);
    if (botRow <= topRow) return null; // fully off screen

    return {
      top: rect.top + topRow * cellHeight,
      left: rect.left,
      width: rect.width,
      height: (botRow - topRow) * cellHeight,
      exitCode: block.exitCode,
      source: block.source ?? "local",
      // Show the n/total counter only when the toolbar is on the
      // keyboard-selected block, not when merely hovering another one.
      selection: block === this.validSelected() ? this.selectionInfo() : null,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of this.disposers) d();
    this.selected = null;
    this.hovered = null;
  }

  /** Closed blocks that are real commands, oldest-first. */
  private interactive(): CommandBlock[] {
    return this.ring.all().filter(isInteractiveBlock);
  }

  private selectionInfo(): { index: number; total: number } | null {
    const sel = this.validSelected();
    if (!sel) return null;
    const blocks = this.interactive();
    const index = blocks.indexOf(sel);
    if (index < 0) return null;
    return { index, total: blocks.length };
  }

  private validSelected(): CommandBlock | null {
    if (this.selected && !this.interactive().includes(this.selected)) {
      this.selected = null; // evicted or no longer interactive
    }
    return this.selected;
  }

  private validHovered(): CommandBlock | null {
    if (this.hovered && !this.interactive().includes(this.hovered)) {
      this.hovered = null;
    }
    return this.hovered;
  }

  private scrollToSelected(): void {
    // Scroll to the command line (top of the block), not the output, so the
    // selected command is what comes into view.
    const topLine = this.selected ? blockTopLine(this.selected) : null;
    if (topLine !== null) this.term.scrollToLine(topLine);
  }

  private screenEl(): HTMLElement | null {
    return (
      (this.term.element?.querySelector(".xterm-screen") as HTMLElement) ?? null
    );
  }
}
