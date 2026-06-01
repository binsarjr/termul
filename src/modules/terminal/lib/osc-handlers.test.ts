import { describe, expect, it, vi } from "vitest";
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

    expect(onCwd).toHaveBeenCalledWith("/home/me/project");
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
    expect(onCwd).toHaveBeenCalledWith("/home/me/new-cwd");
  });

  it("works without state for backwards compatibility (legacy callers)", () => {
    // The state parameter is optional — when omitted, OSC 7 is always
    // honored (legacy behavior). Tests must confirm we didn't break this.
    const { term, handlers } = makeFakeTerm();
    const onCwd = vi.fn();
    registerCwdHandler(term, onCwd);

    handlers.get(7)?.("file://host/home/me/project");
    expect(onCwd).toHaveBeenCalledWith("/home/me/project");
  });

  it("normalizes Windows drive-letter OSC 7 paths", () => {
    const { term, handlers } = makeFakeTerm();
    const onCwd = vi.fn();
    registerCwdHandler(term, onCwd);

    handlers.get(7)?.("file:///C:/Users/me/project");
    expect(onCwd).toHaveBeenCalledWith("C:/Users/me/project");
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
  let altScreen = false;
  const markers: { line: number; isDisposed: boolean }[] = [];
  const term = {
    parser: {
      registerOscHandler(code: number, handler: OscHandler) {
        handlers.set(code, handler);
        return { dispose: () => handlers.delete(code) };
      },
    },
    registerMarker: vi.fn(() => {
      const m = { line, isDisposed: false, dispose: vi.fn() } as unknown as IMarker;
      markers.push(m as unknown as { line: number; isDisposed: boolean });
      return m;
    }),
    buffer: {
      get active() {
        return { type: altScreen ? "alternate" : "normal" };
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
    setAltScreen: (v: boolean) => {
      altScreen = v;
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
      ring.beginCommand(`cmd-${i}`, null);
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
    const { term, handlers } = makeBlockTerm();
    const tracker = registerPromptTracker(term);

    handlers.get(133)?.("C;first"); // never closed (interrupted)
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

    handlers.get(133)?.("C;cmd");
    handlers.get(133)?.("D;0");
    tracker.dispose();

    // Every marker handed out (prompt + start + end) gets disposed.
    for (const m of markers as unknown as IMarker[]) {
      expect(m.dispose).toHaveBeenCalled();
    }
  });
});
