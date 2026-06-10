import type { IMarker, Terminal } from "@xterm/xterm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlockController, isInteractiveBlock } from "./blockController";
import { CommandBlockRing } from "./osc-handlers";

let nextMarkerId = 1;
function fakeMarker(line: number, disposed = false): IMarker {
  return {
    id: nextMarkerId++,
    line,
    isDisposed: disposed,
    dispose: vi.fn(),
    onDispose: () => ({ dispose() {} }),
  } as unknown as IMarker;
}

function makeFakeTerm() {
  const scrolledTo: number[] = [];
  const term = {
    scrollToLine(line: number) {
      scrolledTo.push(line);
    },
    // The controller subscribes to these to wake the overlay's parked loop.
    onScroll: () => ({ dispose: () => {} }),
    onResize: () => ({ dispose: () => {} }),
  } as unknown as Terminal;
  return { term, scrolledTo };
}

/** Push `count` real closed blocks (prompt lines 0,10,20,…) into a fresh ring. */
function ringWith(count: number): CommandBlockRing {
  const ring = new CommandBlockRing();
  for (let i = 0; i < count; i++) {
    // promptMarker = command line, startMarker = output line, endMarker = end.
    ring.beginCommand(`cmd${i}`, fakeMarker(i * 10), fakeMarker(i * 10 + 1));
    ring.endCommand(0, fakeMarker(i * 10 + 5));
  }
  return ring;
}

/** One closed real-command block whose highlight spans [promptLine, endLine):
 * the command line at `promptLine`, output starting at `promptLine + 1`. */
function ringWithBlock(
  promptLine: number,
  endLine: number,
  command = "build",
  exit = 0,
): CommandBlockRing {
  const ring = new CommandBlockRing();
  ring.beginCommand(command, fakeMarker(promptLine), fakeMarker(promptLine + 1));
  ring.endCommand(exit, fakeMarker(endLine));
  return ring;
}

/**
 * A terminal stubbed with just enough DOM for the geometry methods: a fixed
 * `rows`, a `.xterm-screen` element with a fixed bounding rect, and a settable
 * `viewportY` so a test can scroll the buffer under the block.
 */
function makeDomTerm(
  rows: number,
  rect: { top: number; left: number; width: number; height: number },
) {
  let viewportY = 0;
  const screen = {
    getBoundingClientRect: () =>
      ({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        x: rect.left,
        y: rect.top,
        toJSON: () => ({}),
      }) as DOMRect,
  };
  const term = {
    rows,
    element: {
      querySelector: (sel: string) =>
        sel === ".xterm-screen" ? (screen as unknown as HTMLElement) : null,
    },
    buffer: {
      active: {
        get viewportY() {
          return viewportY;
        },
      },
    },
    scrollToLine() {},
    onScroll: () => ({ dispose: () => {} }),
    onResize: () => ({ dispose: () => {} }),
  } as unknown as Terminal;
  return {
    term,
    setViewportY: (y: number) => {
      viewportY = y;
    },
  };
}

beforeEach(() => {
  nextMarkerId = 1;
});

describe("CommandBlockRing.onChange", () => {
  it("fires when a block closes and stops after unsubscribe", () => {
    const ring = new CommandBlockRing();
    const cb = vi.fn();
    const off = ring.onChange(cb);

    ring.beginCommand("ls", fakeMarker(0), fakeMarker(1));
    ring.endCommand(0, fakeMarker(2));
    expect(cb).toHaveBeenCalledTimes(1);

    off();
    ring.beginCommand("pwd", fakeMarker(3), fakeMarker(4));
    ring.endCommand(0, fakeMarker(5));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("isInteractiveBlock", () => {
  it("accepts a real command with a live start marker", () => {
    const ring = ringWith(1);
    expect(isInteractiveBlock(ring.all()[0])).toBe(true);
  });

  it("rejects an empty-command block (empty Enter)", () => {
    expect(
      isInteractiveBlock({
        command: "  ",
        promptMarker: fakeMarker(0),
        startMarker: fakeMarker(1),
        endMarker: fakeMarker(2),
        exitCode: 127,
      }),
    ).toBe(false);
  });

  it("rejects a block with no / disposed top markers", () => {
    expect(
      isInteractiveBlock({
        command: "ls",
        promptMarker: null,
        startMarker: null,
        endMarker: fakeMarker(1),
        exitCode: 0,
      }),
    ).toBe(false);
    expect(
      isInteractiveBlock({
        command: "ls",
        promptMarker: fakeMarker(0, true),
        startMarker: fakeMarker(0, true),
        endMarker: null,
        exitCode: 0,
      }),
    ).toBe(false);
  });

  it("accepts a real command that has only an output (start) marker", () => {
    // A shell that emits C but not A (or whose prompt marker scrolled off):
    // the block still highlights from the output line.
    expect(
      isInteractiveBlock({
        command: "ls",
        promptMarker: null,
        startMarker: fakeMarker(3),
        endMarker: fakeMarker(5),
        exitCode: 0,
      }),
    ).toBe(true);
  });

  it("accepts a heuristic remote block (null exit code, live markers)", () => {
    expect(
      isInteractiveBlock({
        command: "ls -la",
        promptMarker: fakeMarker(0),
        startMarker: fakeMarker(1),
        endMarker: fakeMarker(4),
        exitCode: null,
        source: "remote",
      }),
    ).toBe(true);
  });
});

describe("BlockController.selectRelative", () => {
  it("Cmd+Up with no selection picks the newest block and scrolls to it", () => {
    const { term, scrolledTo } = makeFakeTerm();
    const ring = ringWith(3); // lines 0,10,20
    const ctl = new BlockController(term, ring);

    const picked = ctl.selectRelative(-1);
    expect(picked).toBe(ring.all()[2]);
    expect(scrolledTo[scrolledTo.length - 1]).toBe(20); // newest block's start
  });

  it("Cmd+Down with no selection is a no-op", () => {
    const { term } = makeFakeTerm();
    const ctl = new BlockController(term, ringWith(3));
    expect(ctl.selectRelative(1)).toBeNull();
    expect(ctl.getSelected()).toBeNull();
  });

  it("walks older then newer, clamps at oldest, clears past newest", () => {
    const { term } = makeFakeTerm();
    const ring = ringWith(3);
    const ctl = new BlockController(term, ring);
    const [b0, b1, b2] = ring.all();

    expect(ctl.selectRelative(-1)).toBe(b2); // newest
    expect(ctl.selectRelative(-1)).toBe(b1);
    expect(ctl.selectRelative(-1)).toBe(b0); // oldest
    expect(ctl.selectRelative(-1)).toBe(b0); // clamp at oldest
    expect(ctl.selectRelative(1)).toBe(b1);
    expect(ctl.selectRelative(1)).toBe(b2);
    expect(ctl.selectRelative(1)).toBeNull(); // past newest → cleared
    expect(ctl.getSelected()).toBeNull();
  });

  it("skips non-interactive blocks (empty Enter / empty command) during nav", () => {
    const { term } = makeFakeTerm();
    const ring = new CommandBlockRing();
    ring.beginCommand("real1", fakeMarker(0), fakeMarker(1));
    ring.endCommand(0, fakeMarker(5));
    ring.endCommand(0, fakeMarker(8)); // D with no C → null markers, command ""
    ring.beginCommand("", fakeMarker(10), fakeMarker(11)); // markers but empty cmd
    ring.endCommand(127, fakeMarker(12));
    ring.beginCommand("real2", fakeMarker(20), fakeMarker(21));
    ring.endCommand(0, fakeMarker(25));

    const ctl = new BlockController(term, ring);
    const all = ring.all();
    const real1 = all[0];
    const real2 = all[3];

    // Only the two real commands are ever selected; the empties are skipped.
    expect(ctl.selectRelative(-1)).toBe(real2);
    expect(ctl.selectRelative(-1)).toBe(real1);
    expect(ctl.selectRelative(-1)).toBe(real1); // clamp — no empties before it
    expect(ctl.selectRelative(1)).toBe(real2);
    expect(ctl.selectRelative(1)).toBeNull();
  });

  it("returns null when there are no blocks", () => {
    const { term } = makeFakeTerm();
    const ctl = new BlockController(term, new CommandBlockRing());
    expect(ctl.selectRelative(-1)).toBeNull();
    expect(ctl.selectRelative(1)).toBeNull();
  });

  it("drops a selection that was evicted from the ring", () => {
    const { term } = makeFakeTerm();
    const ring = new CommandBlockRing(2); // capacity 2
    ring.beginCommand("a", fakeMarker(0), fakeMarker(1));
    ring.endCommand(0, fakeMarker(2));
    const ctl = new BlockController(term, ring);
    const oldest = ring.all()[0];
    ctl.selectRelative(-1);
    expect(ctl.getSelected()).toBe(oldest);

    ring.beginCommand("b", fakeMarker(10), fakeMarker(11));
    ring.endCommand(0, fakeMarker(12));
    ring.beginCommand("c", fakeMarker(20), fakeMarker(21));
    ring.endCommand(0, fakeMarker(22));
    expect(ctl.getSelected()).toBeNull();
    ctl.dispose();
  });
});

describe("BlockController hover", () => {
  it("getActiveBlock prefers hover, falls back to selection", () => {
    const { term } = makeFakeTerm();
    const ring = ringWith(3);
    const ctl = new BlockController(term, ring);
    const [b0, , b2] = ring.all();

    ctl.selectRelative(-1); // selects newest (b2)
    expect(ctl.getActiveBlock()).toBe(b2);

    ctl.setHover(b0);
    expect(ctl.getActiveBlock()).toBe(b0); // hover wins

    ctl.setHover(null);
    expect(ctl.getActiveBlock()).toBe(b2); // back to selection
  });

  it("ignores hover on non-interactive blocks", () => {
    const { term } = makeFakeTerm();
    const ring = new CommandBlockRing();
    ring.beginCommand("", fakeMarker(0), fakeMarker(1)); // empty command
    ring.endCommand(127, fakeMarker(2));
    const ctl = new BlockController(term, ring);

    ctl.setHover(ring.all()[0]);
    expect(ctl.getActiveBlock()).toBeNull();
  });
});

describe("BlockController.getActiveFrame", () => {
  // rows=24 over a 480px screen ⇒ 20px cells, so a buffer line maps cleanly.
  const RECT = { top: 100, left: 50, width: 800, height: 480 };

  it("returns null when nothing is hovered or selected", () => {
    const { term } = makeDomTerm(24, RECT);
    const ctl = new BlockController(term, ringWithBlock(10, 12));
    expect(ctl.getActiveFrame()).toBeNull();
  });

  it("frames the hovered block clamped to on-screen rows, no counter", () => {
    const { term, setViewportY } = makeDomTerm(24, RECT);
    setViewportY(5);
    const ring = ringWithBlock(10, 12);
    const ctl = new BlockController(term, ring);
    ctl.setHover(ring.all()[0]);

    // topRow = 10-5 = 5, botRow = 12-5 = 7, cellHeight = 20.
    expect(ctl.getActiveFrame()).toEqual({
      top: 100 + 5 * 20,
      left: 50,
      width: 800,
      height: (7 - 5) * 20,
      exitCode: 0,
      source: "local",
      selection: null,
    });
  });

  it("carries the block's source through to the frame (remote badge)", () => {
    const { term } = makeDomTerm(24, { ...RECT, top: 0 });
    const ring = new CommandBlockRing();
    ring.pushClosed({
      command: "ls -la",
      promptMarker: fakeMarker(2),
      startMarker: fakeMarker(3),
      endMarker: fakeMarker(5),
      exitCode: null,
      source: "remote",
    });
    const ctl = new BlockController(term, ring);
    ctl.setHover(ring.all()[0]);

    expect(ctl.getActiveFrame()?.source).toBe("remote");
  });

  it("includes the n/total counter only when keyboard-selected", () => {
    const { term } = makeDomTerm(24, { ...RECT, top: 0 });
    const ring = ringWithBlock(2, 4);
    const ctl = new BlockController(term, ring);
    ctl.selectRelative(-1); // select the only block

    expect(ctl.getActiveFrame()?.selection).toEqual({ index: 0, total: 1 });
  });

  it("returns null when the block has scrolled fully out of view", () => {
    const { term, setViewportY } = makeDomTerm(24, RECT);
    const ring = ringWithBlock(10, 12);
    const ctl = new BlockController(term, ring);
    ctl.setHover(ring.all()[0]);
    setViewportY(40); // lines 10–12 now sit far above the viewport
    expect(ctl.getActiveFrame()).toBeNull();
  });

  it("paints a no-output command at line 0 instead of collapsing to nothing", () => {
    // Degenerate top-of-buffer case: start and end markers both land on line 0
    // (a command that produced no output, next prompt on the same row). The end
    // line must be clamped to at least top+1 so the block keeps a paintable row
    // rather than an empty [0,0) range that would never draw or hit-test.
    const { term } = makeDomTerm(24, { ...RECT, top: 0 });
    const ring = new CommandBlockRing();
    ring.beginCommand("clear", fakeMarker(0), fakeMarker(0));
    ring.endCommand(0, fakeMarker(0));
    const ctl = new BlockController(term, ring);
    ctl.setHover(ring.all()[0]);

    const frame = ctl.getActiveFrame();
    expect(frame).not.toBeNull();
    expect(frame?.height).toBe(20); // exactly one row, not zero
  });
});

describe("BlockController.blockAtClientY", () => {
  const RECT = { top: 100, left: 50, width: 800, height: 480 };

  it("returns the interactive block whose rows cover the point", () => {
    const { term, setViewportY } = makeDomTerm(24, RECT);
    setViewportY(5);
    const ring = ringWithBlock(10, 12); // buffer lines 10,11
    const ctl = new BlockController(term, ring);
    expect(ctl.blockAtClientY(210)).toBe(ring.all()[0]); // row 5 → line 10
    expect(ctl.blockAtClientY(225)).toBe(ring.all()[0]); // row 6 → line 11
  });

  it("returns null past the block end and before its start", () => {
    const { term, setViewportY } = makeDomTerm(24, RECT);
    setViewportY(5);
    const ctl = new BlockController(term, ringWithBlock(10, 12));
    expect(ctl.blockAtClientY(245)).toBeNull(); // row 7 → line 12 (== endLine)
    expect(ctl.blockAtClientY(185)).toBeNull(); // row 4 → line 9 (before start)
  });

  it("ignores non-interactive (empty) blocks under the point", () => {
    const { term } = makeDomTerm(24, { ...RECT, top: 0 });
    const ring = new CommandBlockRing();
    ring.beginCommand("", fakeMarker(0), fakeMarker(1)); // empty command
    ring.endCommand(127, fakeMarker(2));
    const ctl = new BlockController(term, ring);
    expect(ctl.blockAtClientY(5)).toBeNull();
  });
});
