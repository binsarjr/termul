import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { AutocompleteController } from "./autocompleteController";
import { useHistoryStore } from "./historyStore";
import { usePreferencesStore } from "@/modules/settings/preferences";

/**
 * Fake xterm `Terminal` with a mutable single-row buffer, a settable cursor, and
 * enough DOM stubbing for getRender to reach its geometry reads. We drive the
 * editing state by mutating rowText + cursorX directly — exactly what the real
 * shell echo does to the buffer — so these tests exercise currentInput()'s
 * buffer-derived behavior, not a keystroke model.
 */
function makeFakeTerm() {
  let rowText = "$ ";
  let cursorX = 2;
  let bufType: "normal" | "alternate" = "normal";
  let viewportY = 0;
  const dataHandlers: ((d: string) => void)[] = [];

  const screen = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 800,
      height: 400,
    }),
  };
  const element = {
    querySelector: (sel: string) => (sel === ".xterm-screen" ? screen : null),
  };

  const term = {
    cols: 80,
    rows: 24,
    element,
    buffer: {
      active: {
        get type() {
          return bufType;
        },
        baseY: 0,
        get viewportY() {
          return viewportY;
        },
        get cursorX() {
          return cursorX;
        },
        cursorY: 0,
        getLine: (_line: number) => ({
          // Honor trimRight and the column args like the real xterm BufferLine
          // (the fake rows are ASCII-only, so columns equal string indices).
          // Untrimmed reads keep a just-typed trailing space.
          translateToString: (
            trim?: boolean,
            startCol?: number,
            endCol?: number,
          ) => {
            const s = trim ? rowText.replace(/\s+$/, "") : rowText;
            return s.slice(startCol ?? 0, endCol ?? s.length);
          },
        }),
      },
    },
    onData: (cb: (d: string) => void) => {
      dataHandlers.push(cb);
      return { dispose: () => {} };
    },
    // The controller subscribes to these to wake the overlay's parked loop;
    // no-ops here — the tests drive state by mutating the buffer directly.
    onCursorMove: () => ({ dispose: () => {} }),
    onRender: () => ({ dispose: () => {} }),
    onScroll: () => ({ dispose: () => {} }),
  } as unknown as Terminal;

  return {
    term,
    setRow: (text: string, cx: number) => {
      rowText = text;
      cursorX = cx;
    },
    setCursorX: (cx: number) => {
      cursorX = cx;
    },
    setAltScreen: (v: boolean) => {
      bufType = v ? "alternate" : "normal";
    },
    setViewportY: (v: number) => {
      viewportY = v;
    },
    sendData: (d: string) => {
      for (const cb of dataHandlers) cb(d);
    },
  };
}

const HIST = ["git status", "git stash pop", "npm run dev"];
// Command start col = 2 (just past the "$ " prompt), single row.
const START = () => ({ line: 0, col: 2 });

function key(
  code: string,
  k: string,
  mods: Partial<KeyboardEvent> = {},
): KeyboardEvent {
  return {
    key: k,
    code,
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...mods,
  } as KeyboardEvent;
}

beforeEach(() => {
  useHistoryStore.setState({ entries: [...HIST], loaded: true });
  usePreferencesStore.setState({ historyAutocomplete: true });
});

afterEach(() => {
  useHistoryStore.setState({ entries: [], loaded: false });
});

describe("AutocompleteController — buffer-derived input", () => {
  it("Right-arrow repro: ghost reappears after accept-then-backspace", () => {
    const fake = makeFakeTerm();
    const ctl = new AutocompleteController(fake.term, () => {}, START);

    // User typed "git st" — ghost suggests the rest of "git status".
    fake.setRow("$ git st", 8);
    expect(ctl.getRender()?.ghost).toBe("atus");

    // Accept the ghost (Right-arrow): the shell echo fills the row with the full
    // entry; the old model would now be stuck (a control byte killed tracking).
    fake.setRow("$ git status", 12);
    expect(ctl.getRender()).toBeNull(); // exact match — nothing left to suggest

    // Backspace one char: row shortens, cursor steps back. A ghost must reappear
    // (this is the bug — previously it never came back until Enter).
    fake.setRow("$ git statu", 11);
    expect(ctl.getRender()?.ghost).toBe("s");
  });

  it("ArrowLeft mid-line: ghost is suppressed and Right-arrow falls through", () => {
    const fake = makeFakeTerm();
    let written = "";
    const ctl = new AutocompleteController(
      fake.term,
      (d) => {
        written += d;
      },
      START,
    );

    fake.setRow("$ git st", 8);
    expect(ctl.getRender()?.ghost).toBe("atus");

    // ArrowLeft: cursor mid-line with "t" right of it. No ghost may render, and
    // a plain Right-arrow must reach the shell as cursor movement — accepting
    // here would splice the suffix into the middle of the line.
    fake.setCursorX(7);
    expect(ctl.getRender()).toBeNull();
    const consumed = ctl.handleKey({
      key: "ArrowRight",
      code: "ArrowRight",
      metaKey: false,
      altKey: false,
      ctrlKey: false,
      shiftKey: false,
    } as KeyboardEvent);
    expect(consumed).toBe(false);
    expect(written).toBe("");
  });

  it("scrolled-back viewport → nothing rendered (geometry would be stale)", () => {
    const fake = makeFakeTerm();
    const ctl = new AutocompleteController(fake.term, () => {}, START);

    fake.setRow("$ git st", 8);
    expect(ctl.getRender()?.ghost).toBe("atus");

    // Wheel up one line: viewportY detaches from baseY. cursorY-based geometry
    // would paint the ghost over scrollback rows, so the overlay must go dark.
    fake.setViewportY(-1);
    expect(ctl.getRender()).toBeNull();
  });

  it("alt-screen buffer yields no input → no ghost", () => {
    const fake = makeFakeTerm();
    const ctl = new AutocompleteController(fake.term, () => {}, START);

    fake.setRow("$ git st", 8);
    fake.setAltScreen(true);
    expect(ctl.getRender()).toBeNull();
  });

  it("no live command-start marker → no ghost", () => {
    const fake = makeFakeTerm();
    const ctl = new AutocompleteController(fake.term, () => {}, () => null);

    fake.setRow("$ git st", 8);
    expect(ctl.getRender()).toBeNull();
  });

  it("cursor at/before start col → empty input, no ghost, Enter does not promote", () => {
    const fake = makeFakeTerm();
    const ctl = new AutocompleteController(fake.term, () => {}, START);

    // A no-echo `read -s` line: the shell doesn't echo, so the cursor stays at
    // the start col. currentInput() is "" → nothing to show, nothing to capture.
    fake.setRow("$ ", 2);
    expect(ctl.getRender()).toBeNull();

    fake.sendData("\r");
    // No secret promoted to history (entries untouched).
    expect(useHistoryStore.getState().entries).toEqual(HIST);
  });

  it("Enter promotes the echoed command to history", () => {
    const fake = makeFakeTerm();
    // Construction wires the onData handler that promotes on \r.
    new AutocompleteController(fake.term, () => {}, START);

    fake.setRow("$ make build", 12);
    fake.sendData("\r");
    expect(useHistoryStore.getState().entries[0]).toBe("make build");
  });

  it("keeps a just-typed trailing space → ghost/accept don't double-space", () => {
    const fake = makeFakeTerm();
    let written = "";
    const ctl = new AutocompleteController(
      fake.term,
      (d) => {
        written += d;
      },
      START,
    );

    // User typed "git " (trailing space). The real xterm row trims to "$ git",
    // but the cursor is to the right of the space (cursorX=6). currentInput()
    // must read untrimmed so the input is "git " — not "git".
    fake.setRow("$ git ", 6);
    // Ghost is the remainder of "git status" past "git " → "status", NOT
    // " status" (which would render as "git  status").
    expect(ctl.getRender()?.ghost).toBe("status");

    const accepted = ctl.handleKey({
      key: "ArrowRight",
      code: "ArrowRight",
      metaKey: false,
      altKey: false,
      ctrlKey: false,
      shiftKey: false,
    } as KeyboardEvent);
    expect(accepted).toBe(true);
    // Accept writes exactly "status" → final command "git status", no double space.
    expect(written).toBe("status");
  });

  it("leading-space command is not promoted (ignorespace convention)", () => {
    const fake = makeFakeTerm();
    new AutocompleteController(fake.term, () => {}, START);

    fake.setRow("$  secret --token abc", 21);
    fake.sendData("\r");
    expect(useHistoryStore.getState().entries).toEqual(HIST);
  });

  it("alt screen: keys never consumed, stale dropdown dropped", () => {
    const fake = makeFakeTerm();
    let written = "";
    const ctl = new AutocompleteController(
      fake.term,
      (d) => {
        written += d;
      },
      START,
    );

    fake.setRow("$ git st", 8);
    expect(ctl.handleKey(key("Space", " ", { ctrlKey: true }))).toBe(true);

    // A TUI takes the alt screen while the dropdown is still open: its keys
    // must all reach the TUI (no swallowed arrows/Escape, no pasted entry).
    fake.setAltScreen(true);
    expect(ctl.handleKey(key("ArrowDown", "ArrowDown"))).toBe(false);
    expect(ctl.handleKey(key("Escape", "Escape"))).toBe(false);
    expect(ctl.handleKey(key("Enter", "Enter"))).toBe(false);
    expect(ctl.handleKey(key("Space", " ", { ctrlKey: true }))).toBe(false);
    expect(written).toBe("");

    // Back on the normal screen the stale dropdown is gone for good.
    fake.setAltScreen(false);
    expect(ctl.getRender()?.dropdown ?? null).toBeNull();
  });

  it("an Enter that reaches the PTY closes the dropdown", () => {
    const fake = makeFakeTerm();
    const ctl = new AutocompleteController(fake.term, () => {}, START);

    fake.setRow("$ zzz", 5);
    expect(ctl.handleKey(key("Space", " ", { ctrlKey: true }))).toBe(true);
    // "zzz" matches nothing, so Enter isn't consumed by acceptSelected — it
    // submits the line, and the dropdown must close with it.
    expect(ctl.handleKey(key("Enter", "Enter"))).toBe(false);
    fake.sendData("\r");

    fake.setRow("$ ", 2);
    expect(ctl.getRender()).toBeNull();
  });

  it("accepting the ghost writes only the remainder", () => {
    const fake = makeFakeTerm();
    let written = "";
    const ctl = new AutocompleteController(
      fake.term,
      (d) => {
        written += d;
      },
      START,
    );

    fake.setRow("$ git st", 8);
    // Right-arrow accept path via the public key handler.
    const accepted = ctl.handleKey({
      key: "ArrowRight",
      code: "ArrowRight",
      metaKey: false,
      altKey: false,
      ctrlKey: false,
      shiftKey: false,
    } as KeyboardEvent);
    expect(accepted).toBe(true);
    expect(written).toBe("atus");
  });
});
