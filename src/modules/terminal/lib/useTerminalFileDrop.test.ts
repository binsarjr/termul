import { describe, expect, it } from "vitest";
import { quoteShellArg } from "@/lib/shellQuote";
import {
  createDropRouter,
  dragClientPoint,
  formatDropPaths,
} from "./useTerminalFileDrop";

describe("formatDropPaths", () => {
  it("returns an empty string for no paths", () => {
    expect(formatDropPaths([])).toBe("");
  });

  it("shell-quotes a single path", () => {
    expect(formatDropPaths(["/Users/me/shot.png"])).toBe(
      quoteShellArg("/Users/me/shot.png"),
    );
  });

  it("quotes paths with spaces so the shell keeps them as one argument", () => {
    const path = "/Users/me/my shot.png";
    const result = formatDropPaths([path]);
    expect(result).toBe(quoteShellArg(path));
    expect(result).toContain(" ");
  });

  it("joins multiple paths with a single space", () => {
    expect(formatDropPaths(["/a.png", "/b.png"])).toBe(
      `${quoteShellArg("/a.png")} ${quoteShellArg("/b.png")}`,
    );
  });

  it("drops empty path entries", () => {
    expect(formatDropPaths(["", "/a.png"])).toBe(quoteShellArg("/a.png"));
  });
});

describe("dragClientPoint", () => {
  it("passes macOS/Linux logical positions through untouched on Retina", () => {
    expect(dragClientPoint({ x: 1200, y: 400 }, false, 2)).toEqual({
      x: 1200,
      y: 400,
    });
  });

  it("scales Windows physical positions by devicePixelRatio", () => {
    expect(dragClientPoint({ x: 1200, y: 400 }, true, 2)).toEqual({
      x: 600,
      y: 200,
    });
  });

  it("treats a missing devicePixelRatio as 1 on Windows", () => {
    expect(dragClientPoint({ x: 10, y: 20 }, true, 0)).toEqual({
      x: 10,
      y: 20,
    });
  });
});

describe("createDropRouter", () => {
  type Pane = { leafId: number };
  const PANES: Array<{ leafId: number; minX: number; maxX: number }> = [
    { leafId: 1, minX: 0, maxX: 499 },
    { leafId: 2, minX: 500, maxX: 999 },
  ];

  function makeRouter(start = 0) {
    let now = start;
    const router = createDropRouter<Pane>({
      hitTest: (point) => {
        const pane = PANES.find((p) => point.x >= p.minX && point.x <= p.maxX);
        return pane ? { leafId: pane.leafId } : null;
      },
      toClient: (position) => position,
      now: () => now,
    });
    return { router, tick: (ms: number) => (now += ms) };
  }

  it("drops onto the pane under the cursor, not the first pane", () => {
    const { router } = makeRouter();
    router.handle({ type: "over", position: { x: 700, y: 100 } });
    const action = router.handle({
      type: "drop",
      paths: ["/shot.png"],
      position: { x: 700, y: 100 },
    });
    expect(action).toEqual({
      kind: "drop",
      target: { leafId: 2 },
      text: quoteShellArg("/shot.png"),
      paths: ["/shot.png"],
    });
  });

  it("falls back to the highlighted pane when the drop point misses", () => {
    const { router } = makeRouter();
    router.handle({ type: "over", position: { x: 700, y: 100 } });
    const action = router.handle({
      type: "drop",
      paths: ["/shot.png"],
      position: { x: 2000, y: 100 },
    });
    expect(action).toEqual({
      kind: "drop",
      target: { leafId: 2 },
      text: quoteShellArg("/shot.png"),
      paths: ["/shot.png"],
    });
  });

  it("threads the raw (unquoted) paths through for the SSH upload branch", () => {
    const { router } = makeRouter();
    router.handle({ type: "over", position: { x: 100, y: 100 } });
    const action = router.handle({
      type: "drop",
      paths: ["/Users/me/my shot.png", "/b.png"],
      position: { x: 100, y: 100 },
    });
    expect(action).toEqual({
      kind: "drop",
      target: { leafId: 1 },
      text: formatDropPaths(["/Users/me/my shot.png", "/b.png"]),
      paths: ["/Users/me/my shot.png", "/b.png"],
    });
  });

  it("highlights the hovered pane on enter and over, clears on leave", () => {
    const { router } = makeRouter();
    expect(
      router.handle({
        type: "enter",
        paths: ["/shot.png"],
        position: { x: 700, y: 100 },
      }),
    ).toEqual({ kind: "highlight", target: { leafId: 2 } });
    expect(
      router.handle({ type: "over", position: { x: 100, y: 100 } }),
    ).toEqual({ kind: "highlight", target: { leafId: 1 } });
    expect(router.handle({ type: "leave" })).toEqual({
      kind: "highlight",
      target: null,
    });
  });

  it("does not reuse a hover target after leave", () => {
    const { router } = makeRouter();
    router.handle({ type: "over", position: { x: 700, y: 100 } });
    router.handle({ type: "leave" });
    const action = router.handle({
      type: "drop",
      paths: ["/shot.png"],
      position: { x: 2000, y: 100 },
    });
    expect(action).toEqual({ kind: "highlight", target: null });
  });

  it("swallows a duplicate drop even when it resolves to another pane", () => {
    const { router, tick } = makeRouter();
    router.handle({ type: "over", position: { x: 700, y: 100 } });
    const first = router.handle({
      type: "drop",
      paths: ["/shot.png"],
      position: { x: 700, y: 100 },
    });
    expect(first.kind).toBe("drop");
    tick(50);
    const dupe = router.handle({
      type: "drop",
      paths: ["/shot.png"],
      position: { x: 100, y: 100 },
    });
    expect(dupe).toEqual({ kind: "highlight", target: null });
  });

  it("allows the same paths again after the dedupe window", () => {
    const { router, tick } = makeRouter();
    const drop = () =>
      router.handle({
        type: "drop",
        paths: ["/shot.png"],
        position: { x: 100, y: 100 },
      });
    expect(drop().kind).toBe("drop");
    tick(1000);
    expect(drop().kind).toBe("drop");
  });

  it("ignores drops with no usable paths", () => {
    const { router } = makeRouter();
    const action = router.handle({
      type: "drop",
      paths: [],
      position: { x: 100, y: 100 },
    });
    expect(action).toEqual({ kind: "highlight", target: null });
  });
});
