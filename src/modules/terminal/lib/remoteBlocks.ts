import type { IMarker, Terminal } from "@xterm/xterm";
import { commandFromPromptRow, isCleanPromptRow } from "./historyMatch";
import { registerMarkerSafe, type CommandBlockRing } from "./osc-handlers";

/**
 * Heuristic per-command blocks inside an SSH session against a STOCK remote
 * shell — one that emits no OSC 133 of its own, so the whole session would
 * otherwise collapse into the single local `ssh <host>` block.
 *
 * Lifecycle: Enter on a row that looks like a prompt with typed input opens a
 * pending block (prompt marker on the cursor row, output-start marker one row
 * below — onData fires before the remote echoes anything, so the cursor still
 * sits on the prompt row; xterm markers may be pinned on a not-yet-existing
 * row and track correctly). When the cursor then settles for REMOTE_SETTLE_MS
 * on a clean prompt row, the block closes there and is pushed into the ring.
 * Bare settles with no pending block are ignored, so prompt redraws (Ctrl+C on
 * an empty line, clear, resize reflow) never fabricate blocks.
 *
 * `isActive` gates everything: the session must be inside ssh and the remote
 * must NOT have shown its own OSC 133 (then the nested C/D path owns blocks
 * and this tracker stands down). Heuristic blocks carry `exitCode: null` —
 * a stock remote reports no exit status to read.
 */

const REMOTE_SETTLE_MS = 150;

type PendingBlock = {
  command: string;
  promptMarker: IMarker | null;
  startMarker: IMarker | null;
};

export function createRemoteBlockTracker(
  term: Terminal,
  ring: CommandBlockRing,
  deps: { isActive: () => boolean },
): { dispose: () => void } {
  let pending: PendingBlock | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  // Pool terminals are reused across sessions after term.reset(), so a leaked
  // pending marker would survive into a stranger's session — dispose, always.
  const cancelPending = () => {
    pending?.promptMarker?.dispose();
    pending?.startMarker?.dispose();
    pending = null;
  };

  const clearTimer = () => {
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  };

  /** The untrimmed cursor row + cursor column, or null on the alt screen. */
  const readCursorRow = (): { text: string; cursorX: number } | null => {
    try {
      const buf = term.buffer.active;
      if (buf.type === "alternate") return null;
      const line = buf.getLine(buf.baseY + buf.cursorY);
      if (!line) return null;
      return { text: line.translateToString(false), cursorX: buf.cursorX };
    } catch {
      return null;
    }
  };

  const close = (endMarker: IMarker | null) => {
    if (!pending) return;
    // pushClosed force-flushes the ring's open block (the local `ssh` command)
    // first, so the session-spanning ssh block can't shadow this one.
    ring.pushClosed({
      command: pending.command,
      promptMarker: pending.promptMarker,
      startMarker: pending.startMarker,
      endMarker,
      exitCode: null,
      source: "remote",
    });
    pending = null;
  };

  const settle = () => {
    settleTimer = null;
    if (!pending) return;
    if (!deps.isActive()) {
      cancelPending();
      return;
    }
    // Alt screen (remote vim/less): leave the pending block open — the next
    // cursor move after the TUI exits re-arms the timer and closes it then,
    // mirroring how the local OSC path captures a vim block.
    const row = readCursorRow();
    if (!row) return;
    if (!isCleanPromptRow(row.text, row.cursorX)) return;
    close(registerMarkerSafe(term));
  };

  const onData = term.onData((d) => {
    // Exact Enter only — fires synchronously on keypress, before the remote
    // echoes, while the cursor is still on the prompt row. Pasted multi-line
    // input never matches (accepted limitation).
    if (d !== "\r" && d !== "\n") return;
    if (!deps.isActive()) {
      cancelPending();
      return;
    }
    const row = readCursorRow();
    if (!row) return;
    const command = commandFromPromptRow(row.text, row.cursorX);
    if (command === null) return;
    // Type-ahead (Enter again before the settle fired): the previous command's
    // block ends where this prompt sits — same exclusive-end semantics as a D.
    if (pending) close(registerMarkerSafe(term));
    pending = {
      command,
      promptMarker: registerMarkerSafe(term),
      startMarker: registerMarkerSafe(term, 1),
    };
  });

  const onCursorMove = term.onCursorMove(() => {
    if (!pending) return;
    clearTimer();
    settleTimer = setTimeout(settle, REMOTE_SETTLE_MS);
  });

  return {
    dispose: () => {
      clearTimer();
      cancelPending();
      onData.dispose();
      onCursorMove.dispose();
    },
  };
}
