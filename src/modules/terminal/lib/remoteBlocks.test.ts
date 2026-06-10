import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IMarker, Terminal } from "@xterm/xterm";
import { CommandBlockRing } from "./osc-handlers";
import { createRemoteBlockTracker } from "./remoteBlocks";

const SETTLE = 150;

/**
 * Fake terminal for the heuristic remote-block tracker: emitter-backed onData
 * and onCursorMove, a row store addressed as baseY+cursorY, and offset-aware
 * registerMarker (the tracker pins output-start one row below the cursor).
 */
function makeFakeTerm() {
  let cursorY = 0;
  let cursorX = 0;
  let altScreen = false;
  const rows = new Map<number, string>();
  const dataListeners = new Set<(d: string) => void>();
  const moveListeners = new Set<() => void>();
  const markers: { line: number; isDisposed: boolean; dispose: () => void }[] =
    [];
  const term = {
    onData(cb: (d: string) => void) {
      dataListeners.add(cb);
      return { dispose: () => dataListeners.delete(cb) };
    },
    onCursorMove(cb: () => void) {
      moveListeners.add(cb);
      return { dispose: () => moveListeners.delete(cb) };
    },
    registerMarker: vi.fn((offset = 0) => {
      const m = { line: cursorY + offset, isDisposed: false, dispose: vi.fn() };
      markers.push(m);
      return m as unknown as IMarker;
    }),
    buffer: {
      get active() {
        return {
          type: altScreen ? "alternate" : "normal",
          baseY: 0,
          cursorY,
          cursorX,
          getLine(l: number) {
            const text = rows.get(l);
            if (text === undefined) return undefined;
            return {
              translateToString: (_trim: boolean, start = 0, end?: number) =>
                text.slice(start, end),
            };
          },
        };
      },
    },
  } as unknown as Terminal;
  return {
    term,
    markers,
    // Prompt rows are padded like a real grid (trailing blanks to full width).
    setRow: (l: number, text: string) => rows.set(l, text.padEnd(80, " ")),
    setCursor: (y: number, x: number) => {
      cursorY = y;
      cursorX = x;
    },
    setAltScreen: (v: boolean) => {
      altScreen = v;
    },
    pressEnter: () => {
      for (const cb of dataListeners) cb("\r");
    },
    type: (d: string) => {
      for (const cb of dataListeners) cb(d);
    },
    moveCursor: () => {
      for (const cb of moveListeners) cb();
    },
  };
}

describe("createRemoteBlockTracker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(isActive: () => boolean = () => true) {
    const fake = makeFakeTerm();
    const ring = new CommandBlockRing(20);
    const tracker = createRemoteBlockTracker(fake.term, ring, { isActive });
    return { ...fake, ring, tracker };
  }

  it("captures a block from Enter to the settled next prompt", () => {
    const t = setup();
    t.setRow(0, "pi@host:~ $ ls -la");
    t.setCursor(0, 18);
    t.pressEnter(); // pending opens: prompt row 0, output starts row 1

    t.setRow(4, "pi@host:~ $ ");
    t.setCursor(4, 12); // output scrolled by, fresh prompt on row 4
    t.moveCursor();
    vi.advanceTimersByTime(SETTLE);

    const all = t.ring.all();
    expect(all).toHaveLength(1);
    expect(all[0].command).toBe("ls -la");
    expect(all[0].source).toBe("remote");
    expect(all[0].exitCode).toBeNull();
    expect(all[0].promptMarker?.line).toBe(0);
    expect(all[0].startMarker?.line).toBe(1);
    expect(all[0].endMarker?.line).toBe(4);
  });

  it("force-pushes the ring's open local ssh block before the first remote block", () => {
    const t = setup();
    t.ring.beginCommand("ssh host", null, null); // the local C, still open

    t.setRow(0, "pi@host:~ $ whoami");
    t.setCursor(0, 18);
    t.pressEnter();
    t.setRow(2, "pi@host:~ $ ");
    t.setCursor(2, 12);
    t.moveCursor();
    vi.advanceTimersByTime(SETTLE);

    const all = t.ring.all();
    expect(all).toHaveLength(2);
    expect(all[0].command).toBe("ssh host");
    expect(all[0].endMarker).toBeNull();
    expect(all[1].command).toBe("whoami");
  });

  it("ignores a bare settle with no pending block (prompt redraw immunity)", () => {
    const t = setup();
    t.setRow(0, "pi@host:~ $ ");
    t.setCursor(0, 12);
    t.moveCursor(); // e.g. Ctrl+C on an empty line redrew the prompt
    vi.advanceTimersByTime(SETTLE);

    expect(t.ring.all()).toHaveLength(0);
  });

  it("cancels at settle when Enter was bare (provisional opened, row stays empty)", () => {
    const t = setup();
    t.setRow(0, "pi@host:~ $ ");
    t.setCursor(0, 12);
    // A clean prompt row at Enter is indistinguishable from a laggy echo, so a
    // provisional pending opens here — the late re-read at close decides.
    t.pressEnter();
    expect(t.markers).toHaveLength(2);

    t.setRow(1, "pi@host:~ $ ");
    t.setCursor(1, 12);
    t.moveCursor();
    vi.advanceTimersByTime(SETTLE);

    expect(t.ring.all()).toHaveLength(0);
    for (const m of t.markers) expect(m.dispose).toHaveBeenCalled();
  });

  it("captures the command via late re-read when the echo lags the Enter", () => {
    const t = setup();
    t.setRow(0, "pi@host:~ $ ");
    t.setCursor(0, 12);
    t.pressEnter(); // laggy link: nothing echoed yet, provisional pending

    // Echo + output + fresh prompt all land afterwards.
    t.setRow(0, "pi@host:~ $ ls -la");
    t.setRow(1, "file1  file2");
    t.setRow(2, "pi@host:~ $ ");
    t.setCursor(2, 12);
    t.moveCursor();
    vi.advanceTimersByTime(SETTLE);

    const all = t.ring.all();
    expect(all).toHaveLength(1);
    expect(all[0].command).toBe("ls -la");
    expect(all[0].source).toBe("remote");
    expect(all[0].promptMarker?.line).toBe(0);
  });

  it("prefers the late re-read over a partial Enter-time read", () => {
    const t = setup();
    t.setRow(0, "pi@host:~ $ l"); // only the first keystroke echoed so far
    t.setCursor(0, 13);
    t.pressEnter();

    t.setRow(0, "pi@host:~ $ ls -la"); // echo caught up on the same row
    t.setRow(2, "pi@host:~ $ ");
    t.setCursor(2, 12);
    t.moveCursor();
    vi.advanceTimersByTime(SETTLE);

    expect(t.ring.all()).toHaveLength(1);
    expect(t.ring.last()?.command).toBe("ls -la");
  });

  it("falls back to the Enter-time read when the prompt row no longer parses", () => {
    const t = setup();
    t.setRow(0, "pi@host:~ $ pwd");
    t.setCursor(0, 15);
    t.pressEnter();

    // The prompt row content got replaced (clear/redraw) — no sigil to re-read.
    t.setRow(0, "garbled output without a sigil");
    t.setRow(2, "pi@host:~ $ ");
    t.setCursor(2, 12);
    t.moveCursor();
    vi.advanceTimersByTime(SETTLE);

    expect(t.ring.all()).toHaveLength(1);
    expect(t.ring.last()?.command).toBe("pwd");
  });

  it("opens nothing on Enter over a non-prompt row (password input)", () => {
    const t = setup();
    t.setRow(0, "Password:");
    t.setCursor(0, 9);
    t.pressEnter();

    expect(t.ring.all()).toHaveLength(0);
    expect(t.markers).toHaveLength(0);
  });

  it("ignores Enter on the alternate screen", () => {
    const t = setup();
    t.setAltScreen(true);
    t.setRow(0, "pi@host:~ $ ls");
    t.setCursor(0, 14);
    t.pressEnter();

    expect(t.ring.all()).toHaveLength(0);
  });

  it("defers the close while a TUI holds the alt screen, closes after exit", () => {
    const t = setup();
    t.setRow(0, "pi@host:~ $ vim notes.txt");
    t.setCursor(0, 25);
    t.pressEnter(); // pending opens

    t.setAltScreen(true); // remote vim
    t.moveCursor();
    vi.advanceTimersByTime(SETTLE);
    expect(t.ring.all()).toHaveLength(0); // still pending, not cancelled

    t.setAltScreen(false); // :q — back on the normal screen, prompt returns
    t.setRow(3, "pi@host:~ $ ");
    t.setCursor(3, 12);
    t.moveCursor();
    vi.advanceTimersByTime(SETTLE);

    const all = t.ring.all();
    expect(all).toHaveLength(1);
    expect(all[0].command).toBe("vim notes.txt");
  });

  it("does not close on output that doesn't look like a prompt", () => {
    const t = setup();
    t.setRow(0, "pi@host:~ $ cat big.log");
    t.setCursor(0, 23);
    t.pressEnter();

    t.setRow(5, "some log line without a sigil");
    t.setCursor(5, 29);
    t.moveCursor();
    vi.advanceTimersByTime(SETTLE); // output paused mid-stream

    expect(t.ring.all()).toHaveLength(0); // still pending

    t.setRow(9, "pi@host:~ $ ");
    t.setCursor(9, 12);
    t.moveCursor();
    vi.advanceTimersByTime(SETTLE);
    expect(t.ring.all()).toHaveLength(1); // closes at the real prompt
  });

  it("cancels the pending block when isActive flips false (nested OSC stand-down)", () => {
    let active = true;
    const t = setup(() => active);
    t.setRow(0, "pi@host:~ $ ls");
    t.setCursor(0, 14);
    t.pressEnter();
    const pendingMarkers = [...t.markers];
    expect(pendingMarkers).toHaveLength(2);

    active = false; // remote OSC 133 appeared / ssh exited
    t.setRow(1, "pi@host:~ $ ");
    t.setCursor(1, 12);
    t.moveCursor();
    vi.advanceTimersByTime(SETTLE);

    expect(t.ring.all()).toHaveLength(0);
    for (const m of pendingMarkers) expect(m.dispose).toHaveBeenCalled();
  });

  it("does nothing at all while inactive (local shell)", () => {
    const t = setup(() => false);
    t.setRow(0, "user@local ~ $ ls");
    t.setCursor(0, 17);
    t.pressEnter();
    t.moveCursor();
    vi.advanceTimersByTime(SETTLE);

    expect(t.ring.all()).toHaveLength(0);
    expect(t.markers).toHaveLength(0);
  });

  it("closes the previous block at the next prompt on type-ahead double Enter", () => {
    const t = setup();
    t.setRow(0, "pi@host:~ $ pwd");
    t.setCursor(0, 15);
    t.pressEnter(); // first pending

    // Second Enter lands before the settle ever fired.
    t.setRow(2, "pi@host:~ $ whoami");
    t.setCursor(2, 18);
    t.pressEnter();

    const all = t.ring.all();
    expect(all).toHaveLength(1);
    expect(all[0].command).toBe("pwd");
    expect(all[0].endMarker?.line).toBe(2); // ends at the next command's prompt row

    t.setRow(4, "pi@host:~ $ ");
    t.setCursor(4, 12);
    t.moveCursor();
    vi.advanceTimersByTime(SETTLE);
    expect(t.ring.all()).toHaveLength(2);
    expect(t.ring.last()?.command).toBe("whoami");
  });

  it("ignores non-Enter keystrokes", () => {
    const t = setup();
    t.setRow(0, "pi@host:~ $ ls");
    t.setCursor(0, 14);
    t.type("a");
    t.type("\t");

    expect(t.ring.all()).toHaveLength(0);
    expect(t.markers).toHaveLength(0);
  });

  it("disposes pending markers and timers on dispose", () => {
    const t = setup();
    t.setRow(0, "pi@host:~ $ ls");
    t.setCursor(0, 14);
    t.pressEnter();
    t.moveCursor(); // settle armed
    const pendingMarkers = [...t.markers];

    t.tracker.dispose();
    vi.advanceTimersByTime(SETTLE); // armed timer must be dead

    expect(t.ring.all()).toHaveLength(0);
    for (const m of pendingMarkers) expect(m.dispose).toHaveBeenCalled();

    // Subscriptions are gone: further events are no-ops.
    t.pressEnter();
    t.moveCursor();
    vi.advanceTimersByTime(SETTLE);
    expect(t.ring.all()).toHaveLength(0);
  });
});
