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
  onCwd: (cwd: string, host: string) => void,
  state?: ShellIntegrationState,
): () => void {
  const d = term.parser.registerOscHandler(7, (data) => {
    // Reject OSC 7 emitted while a command is running: command stdout/stderr
    // is untrusted (it can come from a remote shell, an SSH session, a `cat`
    // of attacker-controlled bytes). The local shell only emits OSC 7
    // between commands via its precmd/PROMPT_COMMAND hook. When the remote
    // shell has its own OSC 133 integration it drives this command gate, so its
    // between-command OSC 7 passes — `host` then lets the caller tell a remote
    // cwd apart from a local one (we reflect the remote path but never point
    // the local explorer at it).
    if (state?.inCommand) return true;
    const parsed = parseOsc7(data);
    if (parsed) onCwd(parsed.path, parsed.host);
    return true;
  });
  return () => d.dispose();
}

/**
 * One captured command block. `promptMarker` pins the prompt+command line
 * (registered on OSC 133 A), `startMarker` the line where the command's output
 * begins (OSC 133 C), `endMarker` where it ends (OSC 133 D). Output text is read
 * from `[startMarker, endMarker)`; the whole-block highlight spans
 * `[promptMarker, endMarker)` so the command and its output read as one unit.
 * xterm auto-disposes markers when their line scrolls out of the buffer, so the
 * line range must always be read back lazily and guarded against disposal,
 * never pre-snapshotted.
 */
export type CommandBlock = {
  command: string;
  promptMarker: IMarker | null;
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
  private listeners = new Set<() => void>();

  constructor(private readonly capacity = 50) {}

  /** Notified whenever the set of closed blocks changes (push/evict/dispose). */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  /** OSC 133 C: command line is known and output is about to start. */
  beginCommand(
    command: string,
    promptMarker: IMarker | null,
    startMarker: IMarker | null,
  ): void {
    // A new C without an intervening D means the previous block never closed
    // (e.g. interrupted). Push it as-is so it isn't lost, then open the new one.
    if (this.open) this.push(this.open);
    this.open = {
      command,
      promptMarker,
      startMarker,
      endMarker: null,
      exitCode: null,
    };
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
    this.push({
      command: "",
      promptMarker: null,
      startMarker: null,
      endMarker,
      exitCode,
    });
  }

  private push(block: CommandBlock): void {
    this.blocks.push(block);
    while (this.blocks.length > this.capacity) {
      const evicted = this.blocks.shift();
      evicted?.promptMarker?.dispose();
      evicted?.startMarker?.dispose();
      evicted?.endMarker?.dispose();
    }
    this.emit();
  }

  last(): CommandBlock | null {
    return this.blocks.length ? this.blocks[this.blocks.length - 1] : null;
  }

  all(): readonly CommandBlock[] {
    return this.blocks;
  }

  dispose(): void {
    for (const b of this.blocks) {
      b.promptMarker?.dispose();
      b.startMarker?.dispose();
      b.endMarker?.dispose();
    }
    this.blocks = [];
    this.open?.promptMarker?.dispose();
    this.open?.startMarker?.dispose();
    this.open = null;
    this.listeners.clear();
  }
}

export type PromptTracker = {
  getMarker: () => IMarker | null;
  /** Where the typed command starts (prompt-end row + column), or null when
   * there's no live edit line — used by the inline history autocomplete to
   * derive the current input straight from the buffer. */
  getCommandStart: () => { line: number; col: number } | null;
  blocks: CommandBlockRing;
  dispose: () => void;
};

export function registerPromptTracker(
  term: Terminal,
  state?: ShellIntegrationState,
): PromptTracker {
  let marker: IMarker | null = null;
  // Pins the row+col where the typed command begins, valid only across the edit
  // window (B .. submit/new-prompt). Its own marker — the A marker is handed to
  // the block at C and a multi-line prompt's A row isn't the command row.
  let commandStart: { marker: IMarker | null; col: number } | null = null;
  const clearCommandStart = () => {
    commandStart?.marker?.dispose();
    commandStart = null;
  };
  const blocks = new CommandBlockRing();
  const d = term.parser.registerOscHandler(133, (data) => {
    // OSC 133 A — start of new prompt (between commands).
    if (data.startsWith("A")) {
      if (state) state.inCommand = false;
      clearCommandStart();
      marker?.dispose();
      marker = term.registerMarker(0);
    } else if (data.startsWith("B")) {
      // OSC 133 B — command begins. From here on, treat all output as
      // untrusted until we see D (command exit) or the next A (new prompt).
      if (state) state.inCommand = true;
      // The B marker sits at the prompt's tail, so the cursor is now exactly at
      // the column where the typed command starts. Pin it for autocomplete —
      // but only while this prompt's A marker is still live (between A and C).
      // The A marker is nulled at C and absent during a running command, so a
      // stray ESC]133;B injected by command output can't pin a start into output.
      if (marker && !isAltScreen(term)) {
        clearCommandStart();
        commandStart = {
          marker: registerMarkerSafe(term),
          col: cursorColSafe(term),
        };
      }
    } else if (data.startsWith("C")) {
      // OSC 133 C — command pre-execution marker; still inside command.
      if (state) state.inCommand = true;
      // Command submitted: the input line is final, no more editing.
      clearCommandStart();
      // Skip block capture inside a TUI (vim/htop/less): the alt screen has no
      // scrollback and its incremental redraws would produce bogus ranges.
      if (!isAltScreen(term)) {
        // Payload is "C;<cmd>": everything after the first ";" is the command.
        const command = data.startsWith("C;") ? data.slice(2) : "";
        // Hand this prompt's A marker (the command line) to the block so its
        // highlight spans the command, not just the output. Release ownership
        // (marker = null) so the next A doesn't dispose it — the block owns it
        // for its lifetime now and frees it on eviction / ring dispose.
        const promptMarker = marker;
        marker = null;
        blocks.beginCommand(command, promptMarker, registerMarkerSafe(term));
      }
    } else if (data.startsWith("D")) {
      // OSC 133 D — command ends.
      if (state) state.inCommand = false;
      clearCommandStart();
      if (!isAltScreen(term)) {
        const exitCode = parseExitCode(data);
        blocks.endCommand(exitCode, registerMarkerSafe(term));
      }
    }
    return true;
  });
  return {
    getMarker: () => (marker && !marker.isDisposed ? marker : null),
    getCommandStart: () => {
      const m = commandStart?.marker;
      if (!m || m.isDisposed) return null;
      return { line: m.line, col: commandStart!.col };
    },
    blocks,
    dispose: () => {
      d.dispose();
      marker?.dispose();
      marker = null;
      clearCommandStart();
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

function cursorColSafe(term: Terminal): number {
  try {
    return term.buffer.active.cursorX;
  } catch {
    return 0;
  }
}

function parseOsc7(data: string): { host: string; path: string } | null {
  const m = data.match(/^file:\/\/([^/]*)(\/.*)$/);
  if (!m) return null;
  const host = m[1];
  let path = m[2];
  try {
    path = decodeURIComponent(path);
  } catch {}
  // /C:/Users/foo -> C:/Users/foo so it's a valid Windows path.
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return { host, path };
}
