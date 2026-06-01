import type { IMarker, Terminal } from "@xterm/xterm";

/**
 * Cross-handler state shared between the OSC 7 cwd handler and the OSC 133
 * prompt-marker handler. Tracks whether we are currently inside a running
 * command (between OSC 133 B and the next OSC 133 D / A), so the cwd handler
 * can ignore OSC 7 updates emitted by *command output* (e.g. a remote SSH
 * server, a `cat` of an attacker-controlled file). Only OSC 7 issued by the
 * local shell — which fires between commands — should be honored.
 */
export type ShellIntegrationState = {
  inCommand: boolean;
};

export function createShellIntegrationState(): ShellIntegrationState {
  return { inCommand: false };
}

export function registerCwdHandler(
  term: Terminal,
  onCwd: (cwd: string) => void,
  state?: ShellIntegrationState,
): () => void {
  const d = term.parser.registerOscHandler(7, (data) => {
    // Reject OSC 7 emitted while a command is running: command stdout/stderr
    // is untrusted (it can come from a remote shell, an SSH session, a `cat`
    // of attacker-controlled bytes). The local shell only emits OSC 7
    // between commands via its precmd/PROMPT_COMMAND hook.
    if (state?.inCommand) return true;
    const cwd = parseOsc7(data);
    if (cwd) onCwd(cwd);
    return true;
  });
  return () => d.dispose();
}

/**
 * One captured command block. `startMarker` pins the buffer line where the
 * command's output begins (registered on OSC 133 C), `endMarker` where it ends
 * (registered on OSC 133 D). xterm auto-disposes markers when their line
 * scrolls out of the buffer, so the line range must always be read back lazily
 * and guarded against disposal, never pre-snapshotted.
 */
export type CommandBlock = {
  command: string;
  startMarker: IMarker | null;
  endMarker: IMarker | null;
  exitCode: number | null;
};

/**
 * Bounded in-memory ring of the most recent command blocks for one pane.
 * Oldest blocks are evicted past `capacity`. Disposed markers on an evicted
 * block are released so xterm can reclaim them.
 */
export class CommandBlockRing {
  private blocks: CommandBlock[] = [];
  private open: CommandBlock | null = null;

  constructor(private readonly capacity = 50) {}

  /** OSC 133 C: command line is known and output is about to start. */
  beginCommand(command: string, startMarker: IMarker | null): void {
    // A new C without an intervening D means the previous block never closed
    // (e.g. interrupted). Push it as-is so it isn't lost, then open the new one.
    if (this.open) this.push(this.open);
    this.open = { command, startMarker, endMarker: null, exitCode: null };
  }

  /**
   * OSC 133 D: command finished. Closes the block opened by the matching C.
   * Degrades gracefully when C was missing (no open block): records an
   * output-only block instead of throwing, so PowerShell / bash 3.2 (which can
   * skip the pre-exec C marker) still produce something.
   */
  endCommand(exitCode: number | null, endMarker: IMarker | null): void {
    if (this.open) {
      this.open.endMarker = endMarker;
      this.open.exitCode = exitCode;
      this.push(this.open);
      this.open = null;
      return;
    }
    this.push({ command: "", startMarker: null, endMarker, exitCode });
  }

  private push(block: CommandBlock): void {
    this.blocks.push(block);
    while (this.blocks.length > this.capacity) {
      const evicted = this.blocks.shift();
      evicted?.startMarker?.dispose();
      evicted?.endMarker?.dispose();
    }
  }

  last(): CommandBlock | null {
    return this.blocks.length ? this.blocks[this.blocks.length - 1] : null;
  }

  all(): readonly CommandBlock[] {
    return this.blocks;
  }

  dispose(): void {
    for (const b of this.blocks) {
      b.startMarker?.dispose();
      b.endMarker?.dispose();
    }
    this.blocks = [];
    this.open?.startMarker?.dispose();
    this.open = null;
  }
}

export type PromptTracker = {
  getMarker: () => IMarker | null;
  blocks: CommandBlockRing;
  dispose: () => void;
};

export function registerPromptTracker(
  term: Terminal,
  state?: ShellIntegrationState,
): PromptTracker {
  let marker: IMarker | null = null;
  const blocks = new CommandBlockRing();
  const d = term.parser.registerOscHandler(133, (data) => {
    // OSC 133 A — start of new prompt (between commands).
    if (data.startsWith("A")) {
      if (state) state.inCommand = false;
      marker?.dispose();
      marker = term.registerMarker(0);
    } else if (data.startsWith("B")) {
      // OSC 133 B — command begins. From here on, treat all output as
      // untrusted until we see D (command exit) or the next A (new prompt).
      if (state) state.inCommand = true;
    } else if (data.startsWith("C")) {
      // OSC 133 C — command pre-execution marker; still inside command.
      if (state) state.inCommand = true;
      // Skip block capture inside a TUI (vim/htop/less): the alt screen has no
      // scrollback and its incremental redraws would produce bogus ranges.
      if (!isAltScreen(term)) {
        // Payload is "C;<cmd>": everything after the first ";" is the command.
        const command = data.startsWith("C;") ? data.slice(2) : "";
        blocks.beginCommand(command, registerMarkerSafe(term));
      }
    } else if (data.startsWith("D")) {
      // OSC 133 D — command ends.
      if (state) state.inCommand = false;
      if (!isAltScreen(term)) {
        const exitCode = parseExitCode(data);
        blocks.endCommand(exitCode, registerMarkerSafe(term));
      }
    }
    return true;
  });
  return {
    getMarker: () => (marker && !marker.isDisposed ? marker : null),
    blocks,
    dispose: () => {
      d.dispose();
      marker?.dispose();
      marker = null;
      blocks.dispose();
    },
  };
}

/** Parse the integer exit code from an OSC 133 "D;<exit>" payload. */
function parseExitCode(data: string): number | null {
  if (!data.startsWith("D;")) return null;
  const n = parseInt(data.slice(2), 10);
  return Number.isFinite(n) ? n : null;
}

function isAltScreen(term: Terminal): boolean {
  try {
    return term.buffer.active.type === "alternate";
  } catch {
    return false;
  }
}

function registerMarkerSafe(term: Terminal): IMarker | null {
  try {
    return term.registerMarker(0) ?? null;
  } catch {
    return null;
  }
}

function parseOsc7(data: string): string | null {
  const m = data.match(/^file:\/\/[^/]*(\/.*)$/);
  if (!m) return null;
  let path = m[1];
  try {
    path = decodeURIComponent(path);
  } catch {}
  // /C:/Users/foo -> C:/Users/foo so it's a valid Windows path.
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return path;
}
