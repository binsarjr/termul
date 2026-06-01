import type { IMarker, Terminal } from "@xterm/xterm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlockDecorations } from "./blockDecorations";
import { CommandBlockRing } from "./osc-handlers";

let nextMarkerId = 1;
function fakeMarker(line: number): IMarker {
  return {
    id: nextMarkerId++,
    line,
    isDisposed: false,
    dispose: vi.fn(),
    onDispose: () => ({ dispose() {} }),
  } as unknown as IMarker;
}

function makeFakeTerm() {
  const scrolledTo: number[] = [];
  let resizeCb: (() => void) | null = null;
  const decorations: { dispose: ReturnType<typeof vi.fn> }[] = [];
  const term = {
    registerDecoration() {
      const deco = {
        element: { style: {} } as unknown as HTMLElement,
        onRender: () => ({ dispose() {} }),
        dispose: vi.fn(),
      };
      decorations.push(deco);
      return deco;
    },
    onResize(cb: () => void) {
      resizeCb = cb;
      return { dispose: () => (resizeCb = null) };
    },
    scrollToLine(line: number) {
      scrolledTo.push(line);
    },
  } as unknown as Terminal;
  return {
    term,
    scrolledTo,
    decorations,
    fireResize: () => resizeCb?.(),
  };
}

/** Push `count` closed blocks (lines 0,10,20,…) into a fresh ring. */
function ringWith(count: number): CommandBlockRing {
  const ring = new CommandBlockRing();
  for (let i = 0; i < count; i++) {
    ring.beginCommand(`cmd${i}`, fakeMarker(i * 10));
    ring.endCommand(0, fakeMarker(i * 10 + 5));
  }
  return ring;
}

beforeEach(() => {
  nextMarkerId = 1;
});

describe("CommandBlockRing.onChange", () => {
  it("fires when a block closes and stops after unsubscribe", () => {
    const ring = new CommandBlockRing();
    const cb = vi.fn();
    const off = ring.onChange(cb);

    ring.beginCommand("ls", fakeMarker(0));
    ring.endCommand(0, fakeMarker(1));
    expect(cb).toHaveBeenCalledTimes(1);

    off();
    ring.beginCommand("pwd", fakeMarker(2));
    ring.endCommand(0, fakeMarker(3));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("BlockDecorations.selectRelative", () => {
  it("registers one decoration per closed block", () => {
    const { term, decorations } = makeFakeTerm();
    const deco = new BlockDecorations(term, ringWith(3));
    expect(decorations).toHaveLength(3);
    deco.dispose();
  });

  it("Cmd+Up with no selection picks the newest block and scrolls to it", () => {
    const { term, scrolledTo } = makeFakeTerm();
    const ring = ringWith(3); // lines 0,10,20
    const deco = new BlockDecorations(term, ring);

    const picked = deco.selectRelative(-1);
    expect(picked).toBe(ring.all()[2]);
    expect(scrolledTo.at(-1)).toBe(20); // newest block's start line
  });

  it("Cmd+Down with no selection is a no-op", () => {
    const { term } = makeFakeTerm();
    const deco = new BlockDecorations(term, ringWith(3));
    expect(deco.selectRelative(1)).toBeNull();
    expect(deco.getSelected()).toBeNull();
  });

  it("walks older then newer, clamps at oldest, clears past newest", () => {
    const { term } = makeFakeTerm();
    const ring = ringWith(3);
    const deco = new BlockDecorations(term, ring);
    const [b0, b1, b2] = ring.all();

    expect(deco.selectRelative(-1)).toBe(b2); // newest
    expect(deco.selectRelative(-1)).toBe(b1);
    expect(deco.selectRelative(-1)).toBe(b0); // oldest
    expect(deco.selectRelative(-1)).toBe(b0); // clamp at oldest
    expect(deco.selectRelative(1)).toBe(b1);
    expect(deco.selectRelative(1)).toBe(b2);
    expect(deco.selectRelative(1)).toBeNull(); // past newest → cleared
    expect(deco.getSelected()).toBeNull();
  });

  it("returns null when there are no blocks", () => {
    const { term } = makeFakeTerm();
    const deco = new BlockDecorations(term, new CommandBlockRing());
    expect(deco.selectRelative(-1)).toBeNull();
    expect(deco.selectRelative(1)).toBeNull();
  });

  it("rebuilds decorations when the ring changes", () => {
    const { term, decorations } = makeFakeTerm();
    const ring = ringWith(1);
    const deco = new BlockDecorations(term, ring);
    expect(decorations).toHaveLength(1);

    ring.beginCommand("more", fakeMarker(99));
    ring.endCommand(0, fakeMarker(100));
    // Old decoration disposed + two re-registered for the two blocks.
    expect(decorations).toHaveLength(3);
    expect(decorations[0].dispose).toHaveBeenCalled();
    deco.dispose();
  });

  it("drops a selection that was evicted from the ring", () => {
    const { term } = makeFakeTerm();
    const ring = new CommandBlockRing(2); // capacity 2
    ring.beginCommand("a", fakeMarker(0));
    ring.endCommand(0, fakeMarker(1));
    const deco = new BlockDecorations(term, ring);
    const oldest = ring.all()[0];
    deco.selectRelative(-1);
    expect(deco.getSelected()).toBe(oldest);

    // Two more commands evict the first block (capacity 2).
    ring.beginCommand("b", fakeMarker(10));
    ring.endCommand(0, fakeMarker(11));
    ring.beginCommand("c", fakeMarker(20));
    ring.endCommand(0, fakeMarker(21));
    expect(deco.getSelected()).toBeNull();
    deco.dispose();
  });
});
