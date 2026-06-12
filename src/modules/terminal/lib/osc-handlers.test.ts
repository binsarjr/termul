import { describe, expect, it, vi } from "vitest";
import { Terminal as XTerminal } from "@xterm/xterm";
import type { IMarker, Terminal } from "@xterm/xterm";
import {
  CommandBlockRing,
  createShellIntegrationState,
  registerCwdHandler,
  registerPromptTracker,
} from "./osc-handlers";

/**
 * Minimal in-memory fake of the xterm `Terminal` surface we touch — just
 * enough to register OSC handlers and invoke them with crafted payloads.
 * The OSC handler signature is `(data: string) => boolean | Promise<boolean>`.
 */
type OscHandler = (data: string) => boolean | Promise<boolean>;

function makeFakeTerm() {
  const handlers = new Map<number, OscHandler>();
  const term = {
    parser: {
      registerOscHandler(code: number, handler: OscHandler) {
        handlers.set(code, handler);
        return { dispose: () => handlers.delete(code) };
      },
    },
    registerMarker: vi.fn().mockReturnValue({ isDisposed: false, dispose: vi.fn() }),
  } as unknown as Terminal;
  return { term, handlers };
}

describe("OSC 7 cwd handler — gated by OSC 133 in-command state", () => {
  it("accepts OSC 7 when no command is running", () => {
    const { term, handlers } = makeFakeTerm();
    const state = createShellIntegrationState();
    const onCwd = vi.fn();
    registerPromptTracker(term, state);
    registerCwdHandler(term, onCwd, state);

    // OSC 133 A means "new prompt is about to be drawn" — we're between
    // commands and OSC 7 from the shell is legitimate here.
    handlers.get(133)?.("A");
    handlers.get(7)?.("file://host/home/me/project");

    expect(onCwd).toHaveBeenCalledWith("/home/me/project", "host");
  });

  it("rejects OSC 7 emitted while a command is running", () => {
    const { term, handlers } = makeFakeTerm();
    const state = createShellIntegrationState();
    const onCwd = vi.fn();
    registerPromptTracker(term, state);
    registerCwdHandler(term, onCwd, state);

    // Simulate: user runs `ssh attacker.host`, which prints attacker bytes
    // including an OSC 7 trying to silently move the AI's cwd into /etc.
    handlers.get(133)?.("A"); // prompt drawn
    handlers.get(133)?.("B"); // command begins (user hit enter)
    handlers.get(7)?.("file://host/etc"); // attacker injection

    expect(onCwd).not.toHaveBeenCalled();
  });

  it("re-accepts OSC 7 after command finishes (OSC 133 D)", () => {
    const { term, handlers } = makeFakeTerm();
    const state = createShellIntegrationState();
    const onCwd = vi.fn();
    registerPromptTracker(term, state);
    registerCwdHandler(term, onCwd, state);

    handlers.get(133)?.("A");
    handlers.get(133)?.("B"); // running
    handlers.get(7)?.("file://host/etc"); // blocked
    handlers.get(133)?.("D;0"); // command exited
    handlers.get(7)?.("file://host/home/me/new-cwd"); // legitimate post-cmd OSC 7

    expect(onCwd).toHaveBeenCalledTimes(1);
    expect(onCwd).toHaveBeenCalledWith("/home/me/new-cwd", "host");
  });

  it("works without state for backwards compatibility (legacy callers)", () => {
    // The state parameter is optional — when omitted, OSC 7 is always
    // honored (legacy behavior). Tests must confirm we didn't break this.
    const { term, handlers } = makeFakeTerm();
    const onCwd = vi.fn();
    registerCwdHandler(term, onCwd);

    handlers.get(7)?.("file://host/home/me/project");
    expect(onCwd).toHaveBeenCalledWith("/home/me/project", "host");
  });

  it("normalizes Windows drive-letter OSC 7 paths", () => {
    const { term, handlers } = makeFakeTerm();
    const onCwd = vi.fn();
    registerCwdHandler(term, onCwd);

    handlers.get(7)?.("file:///C:/Users/me/project");
    expect(onCwd).toHaveBeenCalledWith("C:/Users/me/project", "");
  });

  it("forwards the OSC 7 host so a remote cwd can be told apart", () => {
    const { term, handlers } = makeFakeTerm();
    const onCwd = vi.fn();
    registerCwdHandler(term, onCwd);

    handlers.get(7)?.("file://prod.example.com/var/www");
    expect(onCwd).toHaveBeenCalledWith("/var/www", "prod.example.com");
  });
});

/**
 * Fake term with marker + alt-screen support, for the command-block capture
 * driven by OSC 133 C/D. Each registerMarker returns a marker carrying the
 * current line counter so output ranges are inspectable.
 */
function makeBlockTerm() {
  const handlers = new Map<number, OscHandler>();
  let line = 0;
  let cursorX = 0;
  let altScreen = false;
  const rows = new Map<number, string>();
  const markers: { line: number; isDisposed: boolean; dispose: () => void }[] =
    [];
  const term = {
    parser: {
      registerOscHandler(code: number, handler: OscHandler) {
        handlers.set(code, handler);
        return { dispose: () => handlers.delete(code) };
      },
    },
    registerMarker: vi.fn((offset = 0) => {
      const m = {
        line: line + offset,
        isDisposed: false,
        dispose: vi.fn(),
      } as unknown as IMarker;
      markers.push(
        m as unknown as { line: number; isDisposed: boolean; dispose: () => void },
      );
      return m;
    }),
    buffer: {
      get active() {
        return {
          type: altScreen ? "alternate" : "normal",
          cursorX,
          baseY: 0,
          cursorY: line,
          getLine(l: number) {
            const text = rows.get(l);
            if (text === undefined) return undefined;
            return {
              translateToString: (trimRight: boolean, start = 0, end?: number) => {
                const s = text.slice(start, end);
                return trimRight ? s.replace(/\s+$/, "") : s;
              },
            };
          },
        };
      },
    },
  } as unknown as Terminal;
  return {
    term,
    handlers,
    markers,
    advance: (n = 1) => {
      line += n;
    },
    setCursorX: (x: number) => {
      cursorX = x;
    },
    setAltScreen: (v: boolean) => {
      altScreen = v;
    },
    setRow: (l: number, text: string) => {
      rows.set(l, text);
    },
  };
}

describe("OSC 133 command-block capture", () => {
  it("builds a block from C then D with command text and exit code", () => {
    const { term, handlers, advance } = makeBlockTerm();
    const tracker = registerPromptTracker(term, createShellIntegrationState());

    handlers.get(133)?.("A"); // prompt
    handlers.get(133)?.("B"); // enter pressed
    handlers.get(133)?.("C;npm run build"); // command known, output starts
    advance(3); // three lines of output scroll by
    handlers.get(133)?.("D;0"); // exit 0

    const block = tracker.blocks.last();
    expect(block).not.toBeNull();
    expect(block?.command).toBe("npm run build");
    expect(block?.exitCode).toBe(0);
    expect(block?.startMarker?.line).toBe(0);
    expect(block?.endMarker?.line).toBe(3);
  });

  it("captures the prompt line (OSC 133 A) distinct from the output start", () => {
    const { term, handlers, advance } = makeBlockTerm();
    const tracker = registerPromptTracker(term);

    handlers.get(133)?.("A"); // prompt line = 0
    handlers.get(133)?.("B");
    advance(1); // user typed the command + Enter → cursor on the output line
    handlers.get(133)?.("C;ls"); // output starts at line 1
    advance(2);
    handlers.get(133)?.("D;0"); // next prompt at line 3

    const block = tracker.blocks.last();
    expect(block?.promptMarker?.line).toBe(0); // the command line
    expect(block?.startMarker?.line).toBe(1); // first output line
    expect(block?.endMarker?.line).toBe(3);
  });

  it("transfers the A marker so the next prompt doesn't dispose it", () => {
    const { term, handlers } = makeBlockTerm();
    const tracker = registerPromptTracker(term);

    handlers.get(133)?.("A"); // prompt marker
    handlers.get(133)?.("C;ls"); // hands the A marker to the block
    handlers.get(133)?.("D;0");
    const promptMarker = tracker.blocks.last()?.promptMarker;
    expect(promptMarker).toBeTruthy();

    handlers.get(133)?.("A"); // a fresh prompt must NOT dispose the block's marker
    expect(promptMarker?.dispose).not.toHaveBeenCalled();
  });

  it("captures a nonzero exit code", () => {
    const { term, handlers } = makeBlockTerm();
    const tracker = registerPromptTracker(term);

    handlers.get(133)?.("C;false");
    handlers.get(133)?.("D;127");

    expect(tracker.blocks.last()?.exitCode).toBe(127);
  });

  it("evicts the oldest block past the ring capacity", () => {
    const ring = new CommandBlockRing(3);
    for (let i = 0; i < 5; i++) {
      ring.beginCommand(`cmd-${i}`, null, null);
      ring.endCommand(0, null);
    }
    const all = ring.all();
    expect(all).toHaveLength(3);
    expect(all[0].command).toBe("cmd-2");
    expect(all[2].command).toBe("cmd-4");
    expect(ring.last()?.command).toBe("cmd-4");
  });

  it("skips capture while the alternate screen is active (TUIs)", () => {
    const { term, handlers, setAltScreen } = makeBlockTerm();
    const tracker = registerPromptTracker(term);

    setAltScreen(true); // vim/htop is on the alt buffer
    handlers.get(133)?.("C;vim file.txt");
    handlers.get(133)?.("D;0");

    expect(tracker.blocks.all()).toHaveLength(0);
    expect(tracker.blocks.last()).toBeNull();
  });

  it("degrades to an output-only block when D arrives without a C", () => {
    const { term, handlers } = makeBlockTerm();
    const tracker = registerPromptTracker(term);

    // bash 3.2 / PowerShell can skip the pre-exec C marker; D must not throw.
    expect(() => handlers.get(133)?.("D;0")).not.toThrow();

    const block = tracker.blocks.last();
    expect(block).not.toBeNull();
    expect(block?.command).toBe("");
    expect(block?.exitCode).toBe(0);
  });

  it("pushes an unclosed block when a new C arrives before D", () => {
    const { term, handlers, advance } = makeBlockTerm();
    const tracker = registerPromptTracker(term);

    handlers.get(133)?.("C;first"); // never closed (interrupted)
    advance(1); // the second command sits on a later row
    handlers.get(133)?.("C;second");
    handlers.get(133)?.("D;0");

    const all = tracker.blocks.all();
    expect(all).toHaveLength(2);
    expect(all[0].command).toBe("first");
    expect(all[0].exitCode).toBeNull();
    expect(all[1].command).toBe("second");
    expect(all[1].exitCode).toBe(0);
  });

  it("parses a missing/garbage exit code as null", () => {
    const { term, handlers } = makeBlockTerm();
    const tracker = registerPromptTracker(term);

    handlers.get(133)?.("C;cmd");
    handlers.get(133)?.("D"); // no ";<exit>" payload

    expect(tracker.blocks.last()?.exitCode).toBeNull();
  });

  it("disposes all markers on tracker dispose", () => {
    const { term, handlers, markers } = makeBlockTerm();
    const tracker = registerPromptTracker(term);

    handlers.get(133)?.("A"); // prompt marker (transferred to the block at C)
    handlers.get(133)?.("C;cmd");
    handlers.get(133)?.("D;0");
    tracker.dispose();

    // Every marker handed out (prompt + start + end) gets disposed.
    for (const m of markers as unknown as IMarker[]) {
      expect(m.dispose).toHaveBeenCalled();
    }
  });
});

describe("OSC 133 command-start tracking (autocomplete input source)", () => {
  it("captures {line,col} at B from the prompt-end cursor", () => {
    const { term, handlers, advance, setCursorX } = makeBlockTerm();
    const tracker = registerPromptTracker(term);

    handlers.get(133)?.("A"); // prompt row
    advance(0);
    setCursorX(2); // cursor sits just past the "$ " prompt
    handlers.get(133)?.("B");

    expect(tracker.getCommandStart()).toEqual({ line: 0, col: 2 });
  });

  it("is null before B (no live edit line yet)", () => {
    const { term, handlers } = makeBlockTerm();
    const tracker = registerPromptTracker(term);

    handlers.get(133)?.("A");
    expect(tracker.getCommandStart()).toBeNull();
  });

  it("clears on C (command submitted)", () => {
    const { term, handlers, setCursorX } = makeBlockTerm();
    const tracker = registerPromptTracker(term);

    handlers.get(133)?.("A");
    setCursorX(2);
    handlers.get(133)?.("B");
    expect(tracker.getCommandStart()).not.toBeNull();
    handlers.get(133)?.("C;ls");
    expect(tracker.getCommandStart()).toBeNull();
  });

  it("clears on D (command ended)", () => {
    const { term, handlers, setCursorX } = makeBlockTerm();
    const tracker = registerPromptTracker(term);

    handlers.get(133)?.("A");
    setCursorX(2);
    handlers.get(133)?.("B");
    handlers.get(133)?.("D;0");
    expect(tracker.getCommandStart()).toBeNull();
  });

  it("clears on the next A (new prompt)", () => {
    const { term, handlers, setCursorX } = makeBlockTerm();
    const tracker = registerPromptTracker(term);

    handlers.get(133)?.("A");
    setCursorX(2);
    handlers.get(133)?.("B");
    expect(tracker.getCommandStart()).not.toBeNull();
    handlers.get(133)?.("A"); // fresh prompt
    expect(tracker.getCommandStart()).toBeNull();
  });

  it("does not capture on the alternate screen (TUIs)", () => {
    const { term, handlers, setCursorX, setAltScreen } = makeBlockTerm();
    const tracker = registerPromptTracker(term);

    handlers.get(133)?.("A"); // live prompt marker, so only the alt guard can block
    setAltScreen(true);
    setCursorX(2);
    handlers.get(133)?.("B");
    expect(tracker.getCommandStart()).toBeNull();
  });

  it("ignores a B injected during command output (no live prompt marker)", () => {
    const { term, handlers, setCursorX } = makeBlockTerm();
    const tracker = registerPromptTracker(term);

    handlers.get(133)?.("A");
    setCursorX(2);
    handlers.get(133)?.("B");
    handlers.get(133)?.("C;ssh pi"); // submitted: A marker handed off, start cleared
    setCursorX(40);
    handlers.get(133)?.("B"); // spoofed by command output — no live A marker
    expect(tracker.getCommandStart()).toBeNull();
  });

  it("disposes the command-start marker on tracker dispose", () => {
    const { term, handlers, markers, setCursorX } = makeBlockTerm();
    const tracker = registerPromptTracker(term);

    handlers.get(133)?.("A");
    setCursorX(2);
    handlers.get(133)?.("B"); // command-start marker registered here
    tracker.dispose();

    for (const m of markers as unknown as IMarker[]) {
      expect(m.dispose).toHaveBeenCalled();
    }
  });
});

/**
 * Command-start pin survival, against the REAL @xterm/xterm Terminal (no
 * fakes, never open()ed): term.clear() runs buffer.clearAllMarkers() and
 * term.write parses async-FIFO — the exact behaviors these paths exist for.
 */
describe("command-start pin survival (real xterm)", () => {
  const ESC = "\x1b";
  const osc133 = (p: string) => `${ESC}]133;${p}${ESC}\\`;
  const makeTerm = () => new XTerminal({ cols: 80, rows: 24 });
  const writeP = (t: XTerminal, data: string) =>
    new Promise<void>((r) => t.write(data, r));
  // "user@mac ~ % " is 13 columns, so B pins col 13.
  const PROMPT = "user@mac ~ % ";

  it("repinCommandStart restores a pin killed by term.clear (Cmd+K)", async () => {
    const term = makeTerm();
    const tracker = registerPromptTracker(term);
    await writeP(
      term,
      `old output\r\n${osc133("A")}${PROMPT}${osc133("B")}git sta`,
    );
    expect(tracker.getCommandStart()).toEqual({ line: 1, col: 13 });

    term.clear(); // clearAllMarkers — the prompt row survives as row 0
    expect(tracker.getCommandStart()).toBeNull();

    tracker.repinCommandStart();
    expect(tracker.getCommandStart()).toEqual({ line: 0, col: 13 });
  });

  it("repinCommandStart is a no-op without a pin or with a live one", async () => {
    const term = makeTerm();
    const tracker = registerPromptTracker(term);
    tracker.repinCommandStart();
    expect(tracker.getCommandStart()).toBeNull();

    await writeP(term, `${osc133("A")}${PROMPT}${osc133("B")}`);
    const before = tracker.getCommandStart();
    tracker.repinCommandStart();
    expect(tracker.getCommandStart()).toEqual(before);
  });

  it("initialCommandStart anchors only after the queued snapshot parses", async () => {
    const term = makeTerm();
    // bindSlot order: the snapshot write is queued first, the tracker is
    // registered synchronously after — before any byte has parsed.
    const replayed = writeP(term, `line one\r\n${PROMPT}git sta`);
    const tracker = registerPromptTracker(term, undefined, {
      initialCommandStart: { col: 13, rowOffset: 0 },
    });
    expect(tracker.getCommandStart()).toBeNull(); // not anchored yet
    await replayed;
    await writeP(term, ""); // drain past the anchor write
    expect(tracker.getCommandStart()).toEqual({ line: 1, col: 13 });
  });

  it("a replayed prompt cycle from the dormant ring overrides the seed", async () => {
    const term = makeTerm();
    const replayed = writeP(term, PROMPT);
    const tracker = registerPromptTracker(term, undefined, {
      initialCommandStart: { col: 13, rowOffset: 0 },
    });
    await replayed;
    await writeP(term, `\r\nout\r\n${osc133("A")}${PROMPT}${osc133("B")}`);
    expect(tracker.getCommandStart()).toEqual({ line: 2, col: 13 });
  });

  it("a pending seed anchor is voided by dispose", async () => {
    const term = makeTerm();
    const replayed = writeP(term, PROMPT);
    const tracker = registerPromptTracker(term, undefined, {
      initialCommandStart: { col: 13, rowOffset: 0 },
    });
    tracker.dispose();
    await replayed;
    await writeP(term, "");
    expect(tracker.getCommandStart()).toBeNull();
  });
});

describe("OSC 133 command lifecycle side-channel (onCommand / onCommandEnd)", () => {
  it("fires onCommand with the parsed command on C", () => {
    const { term, handlers } = makeBlockTerm();
    const onCommand = vi.fn();
    registerPromptTracker(term, createShellIntegrationState(), { onCommand });

    handlers.get(133)?.("A");
    handlers.get(133)?.("B");
    handlers.get(133)?.("C;ssh pi");

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith("ssh pi");
  });

  it("fires onCommand only for the outer/local command, not nested remote C's", () => {
    // A nested remote shell (or injected `C;ssh ...` in command output) must not
    // flip the indicator — only the local command (depth 1) is parsed for ssh.
    const { term, handlers, advance } = makeBlockTerm();
    const onCommand = vi.fn();
    registerPromptTracker(term, createShellIntegrationState(), { onCommand });

    handlers.get(133)?.("C;ssh host"); // local ssh, depth 1 → fires
    advance(2); // remote banner + prompt
    handlers.get(133)?.("C;ssh inner"); // nested remote ssh, depth 2 → ignored
    advance(2);
    handlers.get(133)?.("C;ls"); // nested remote command, depth 3 → ignored

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith("ssh host");
  });

  it("fires onCommandEnd on D", () => {
    const { term, handlers } = makeBlockTerm();
    const onCommandEnd = vi.fn();
    registerPromptTracker(term, createShellIntegrationState(), { onCommandEnd });

    handlers.get(133)?.("C;ssh pi");
    handlers.get(133)?.("D;0");

    expect(onCommandEnd).toHaveBeenCalledTimes(1);
  });

  it("does not fire onCommand for an empty command payload", () => {
    const { term, handlers } = makeBlockTerm();
    const onCommand = vi.fn();
    registerPromptTracker(term, undefined, { onCommand });

    handlers.get(133)?.("C"); // no ";<cmd>" — empty command
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("fires onCommandEnd even when the command ran on the alternate screen", () => {
    const { term, handlers, setAltScreen } = makeBlockTerm();
    const onCommandEnd = vi.fn();
    registerPromptTracker(term, undefined, { onCommandEnd });

    setAltScreen(true); // ssh dropped straight into a remote TUI
    handlers.get(133)?.("D;0");

    expect(onCommandEnd).toHaveBeenCalledTimes(1);
  });

  it("does not fire onCommandEnd on a nested remote shell's D (depth tracking)", () => {
    // Local `ssh host` into a remote whose shell ALSO emits OSC 133. The remote
    // shell wraps each remote command in its own C/D, nested inside the local
    // ssh command. Only the outer (local) ssh D should end the command.
    const { term, handlers, advance } = makeBlockTerm();
    const onCommandEnd = vi.fn();
    registerPromptTracker(term, createShellIntegrationState(), { onCommandEnd });

    handlers.get(133)?.("C;ssh host"); // local ssh begins, depth 1
    advance(2); // remote banner + prompt
    handlers.get(133)?.("C;ls"); // first remote command, depth 2
    advance(1);
    handlers.get(133)?.("D;0"); // remote command ends, depth 1
    expect(onCommandEnd).not.toHaveBeenCalled(); // pill must stay

    advance(1);
    handlers.get(133)?.("C;whoami"); // second remote command, depth 2
    advance(1);
    handlers.get(133)?.("D;0"); // ends, depth 1
    expect(onCommandEnd).not.toHaveBeenCalled();

    advance(1); // "Connection closed" line
    handlers.get(133)?.("D;0"); // local ssh exits, depth 0
    expect(onCommandEnd).toHaveBeenCalledTimes(1);
  });

  it("fires onCommandEnd for each local command without nesting", () => {
    const { term, handlers } = makeBlockTerm();
    const onCommandEnd = vi.fn();
    registerPromptTracker(term, createShellIntegrationState(), { onCommandEnd });

    handlers.get(133)?.("C;ls");
    handlers.get(133)?.("D;0");
    handlers.get(133)?.("C;pwd");
    handlers.get(133)?.("D;0");

    expect(onCommandEnd).toHaveBeenCalledTimes(2);
  });
});

describe("bare-C block command fallback (bash PS0 integration)", () => {
  it("fills the block command from the buffer when the C payload is empty", () => {
    const { term, handlers, setCursorX, setRow } = makeBlockTerm();
    const tracker = registerPromptTracker(term, createShellIntegrationState());

    handlers.get(133)?.("A"); // prompt row 0
    setCursorX(2); // cursor just past "$ "
    handlers.get(133)?.("B");
    setRow(0, "$ ssh pi");
    handlers.get(133)?.("C"); // bash emits a bare C — no payload
    handlers.get(133)?.("D;0");

    const block = tracker.blocks.last();
    expect(block?.command).toBe("ssh pi");
    expect(block?.source).toBe("local");
  });

  it("still leaves the command empty without a pinned start (spoofed/strayed C)", () => {
    const { term, handlers, setRow } = makeBlockTerm();
    const tracker = registerPromptTracker(term, createShellIntegrationState());

    setRow(0, "some output line $ rm -rf /");
    handlers.get(133)?.("C"); // no A/B before it — buffer must not be read
    handlers.get(133)?.("D;0");

    expect(tracker.blocks.last()?.command).toBe("");
  });
});

describe("block source tagging (local vs nested-remote)", () => {
  it("tags nested C's as remote and force-pushes the open local ssh block", () => {
    const { term, handlers, advance } = makeBlockTerm();
    const tracker = registerPromptTracker(term, createShellIntegrationState());

    handlers.get(133)?.("C;ssh host"); // local, depth 1
    advance(2); // remote banner + prompt
    handlers.get(133)?.("C;ls"); // remote integration, depth 2
    advance(1);
    handlers.get(133)?.("D;0"); // closes ls, depth 1

    const all = tracker.blocks.all();
    expect(all).toHaveLength(2);
    expect(all[0].command).toBe("ssh host");
    expect(all[0].source).toBe("local");
    expect(all[0].endMarker).toBeNull(); // force-pushed open, never closed
    expect(all[1].command).toBe("ls");
    expect(all[1].source).toBe("remote");
    expect(all[1].exitCode).toBe(0);
  });
});

describe("initialDepth seeding (mid-ssh rebind replay)", () => {
  it("treats replayed remote C/D pairs as nested, firing callbacks only at true depth 0", () => {
    const { term, handlers, advance } = makeBlockTerm();
    const onCommand = vi.fn();
    const onCommandEnd = vi.fn();
    registerPromptTracker(term, createShellIntegrationState(), {
      onCommand,
      onCommandEnd,
      initialDepth: 1, // session was inside ssh when the pane hibernated
    });

    handlers.get(133)?.("C;ls"); // replayed remote command → depth 2
    expect(onCommand).not.toHaveBeenCalled();
    advance(1);
    handlers.get(133)?.("D;0"); // → depth 1, pill must stay
    expect(onCommandEnd).not.toHaveBeenCalled();

    advance(1); // "Connection closed" line
    handlers.get(133)?.("D;0"); // the real ssh exit → depth 0
    expect(onCommandEnd).toHaveBeenCalledTimes(1);
  });
});

describe("sawNestedCommand (heuristic stand-down signal)", () => {
  it("flips on the first nested C and resets when the local command ends", () => {
    const { term, handlers, advance } = makeBlockTerm();
    const tracker = registerPromptTracker(term, createShellIntegrationState());

    expect(tracker.sawNestedCommand()).toBe(false);
    handlers.get(133)?.("C;ssh host"); // depth 1
    expect(tracker.sawNestedCommand()).toBe(false);
    advance(2); // remote banner + prompt
    handlers.get(133)?.("C;ls"); // depth 2 — remote has its own OSC 133
    expect(tracker.sawNestedCommand()).toBe(true);
    advance(1);
    handlers.get(133)?.("D;0"); // depth 1 — still inside ssh, stays true
    expect(tracker.sawNestedCommand()).toBe(true);
    advance(1);
    handlers.get(133)?.("D;0"); // depth 0 — ssh exited
    expect(tracker.sawNestedCommand()).toBe(false);
  });
});

describe("stacked-integration duplicate C/D collapse (iTerm2 + termul in one rc)", () => {
  // The user's own rc sourcing another OSC 133 integration makes every command
  // emit TWO C's and TWO D's, back to back on the same buffer row. The second
  // of each pair must be collapsed, or depth misreads 2 as "remote has its own
  // integration" and the heuristic ssh blocks stand down for the whole session.
  it("keeps depth 1 and sawNested false across an ssh session with doubled local C's", () => {
    const { term, handlers, advance, setCursorX, setRow } = makeBlockTerm();
    const onCommand = vi.fn();
    const onCommandEnd = vi.fn();
    const tracker = registerPromptTracker(term, createShellIntegrationState(), {
      onCommand,
      onCommandEnd,
    });

    handlers.get(133)?.("A");
    setCursorX(2);
    handlers.get(133)?.("B");
    setRow(0, "$ ssh pi@host");
    handlers.get(133)?.("C;"); // iTerm2's preexec — empty payload, row 0
    handlers.get(133)?.("C;ssh pi@host"); // termul's preexec — SAME row 0

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith("ssh pi@host"); // via buffer read
    expect(tracker.sawNestedCommand()).toBe(false); // the latch must NOT flip
    expect(tracker.blocks.all()).toHaveLength(0); // one OPEN block, none closed

    advance(5); // remote banner, prompt, stock remote session (no OSC at all)
    handlers.get(133)?.("D;0"); // iTerm2's D — ssh exited
    handlers.get(133)?.("D;0"); // termul's D — SAME row, duplicate

    expect(onCommandEnd).toHaveBeenCalledTimes(1);
    const all = tracker.blocks.all();
    expect(all).toHaveLength(1); // no degraded empty block from the second D
    expect(all[0].command).toBe("ssh pi@host");
    expect(all[0].exitCode).toBe(0);
  });

  it("still counts a genuine nested C on a later row as remote", () => {
    const { term, handlers, advance } = makeBlockTerm();
    const tracker = registerPromptTracker(term, createShellIntegrationState());

    handlers.get(133)?.("C;"); // stacked pair for the local ssh
    handlers.get(133)?.("C;ssh host");
    expect(tracker.sawNestedCommand()).toBe(false);

    advance(2); // remote WITH its own integration draws its prompt
    handlers.get(133)?.("C;ls"); // genuinely nested — different row
    expect(tracker.sawNestedCommand()).toBe(true);
  });

  it("alternating C/D on one row (no-output commands) still count separately", () => {
    // C resets the D-dedup and D resets the C-dedup, so a no-output command
    // whose C and the next command's events share rows is never collapsed.
    const { term, handlers } = makeBlockTerm();
    const onCommandEnd = vi.fn();
    registerPromptTracker(term, createShellIntegrationState(), { onCommandEnd });

    handlers.get(133)?.("C;true");
    handlers.get(133)?.("D;0");
    handlers.get(133)?.("C;false");
    handlers.get(133)?.("D;1");

    expect(onCommandEnd).toHaveBeenCalledTimes(2);
  });
});

describe("CommandBlockRing.pushClosed (heuristic remote blocks)", () => {
  const fakeMarker = () =>
    ({ line: 0, isDisposed: false, dispose: vi.fn() }) as unknown as IMarker;

  it("force-pushes the open block first, then the closed one", () => {
    const ring = new CommandBlockRing(10);
    ring.beginCommand("ssh host", null, null);
    ring.pushClosed({
      command: "ls",
      promptMarker: fakeMarker(),
      startMarker: fakeMarker(),
      endMarker: fakeMarker(),
      exitCode: null,
      source: "remote",
    });

    const all = ring.all();
    expect(all).toHaveLength(2);
    expect(all[0].command).toBe("ssh host");
    expect(all[0].endMarker).toBeNull();
    expect(all[1].command).toBe("ls");
    expect(all[1].source).toBe("remote");
  });

  it("a later D without an open block degrades to an empty entry, untouched", () => {
    const ring = new CommandBlockRing(10);
    ring.beginCommand("ssh host", null, null);
    ring.pushClosed({
      command: "ls",
      promptMarker: null,
      startMarker: null,
      endMarker: null,
      exitCode: null,
      source: "remote",
    });
    ring.endCommand(0, null); // the local ssh's D — open slot already flushed

    const all = ring.all();
    expect(all).toHaveLength(3);
    expect(all[2].command).toBe("");
    expect(all[2].exitCode).toBe(0);
  });

  it("disposes adopted markers when a pushed-closed block is evicted", () => {
    const ring = new CommandBlockRing(2);
    const prompt = fakeMarker();
    const start = fakeMarker();
    const end = fakeMarker();
    ring.pushClosed({
      command: "ls",
      promptMarker: prompt,
      startMarker: start,
      endMarker: end,
      exitCode: null,
      source: "remote",
    });
    ring.beginCommand("a", null, null);
    ring.endCommand(0, null);
    ring.beginCommand("b", null, null);
    ring.endCommand(0, null); // capacity 2 → "ls" evicted

    expect(prompt.dispose).toHaveBeenCalled();
    expect(start.dispose).toHaveBeenCalled();
    expect(end.dispose).toHaveBeenCalled();
  });
});
