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
        get cursorX() {
          return cursorX;
        },
        cursorY: 0,
        getLine: (_line: number) => ({
          // Honor trimRight like the real xterm BufferLine: trimming drops
          // trailing whitespace, so currentInput() must read untrimmed to keep
          // a just-typed trailing space.
          translateToString: (trim?: boolean) =>
            trim ? rowText.replace(/\s+$/, "") : rowText,
        }),
      },
    },
    onData: (cb: (d: string) => void) => {
      dataHandlers.push(cb);
      return { dispose: () => {} };
    },
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
    sendData: (d: string) => {
      for (const cb of dataHandlers) cb(d);
    },
  };
}

const HIST = ["git status", "git stash pop", "npm run dev"];
// Command start col = 2 (just past the "$ " prompt), single row.
const START = () => ({ line: 0, col: 2 });

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

  it("Tab repro: ArrowLeft mid-line still derives on-row input → ghost shows", () => {
    const fake = makeFakeTerm();
    const ctl = new AutocompleteController(fake.term, () => {}, START);

    // After accepting a dropdown pick the row holds "git st".
    fake.setRow("$ git st", 8);
    expect(ctl.getRender()?.ghost).toBe("atus");

    // ArrowLeft: cursor moves left on the SAME row (mid-line edit). The input is
    // now "git s" (col 2 .. cursor 7) and a ghost for that still resolves.
    fake.setCursorX(7);
    expect(ctl.getRender()?.ghost).toBe("tatus");
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
