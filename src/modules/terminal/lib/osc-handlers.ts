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
  /** Where the command ran: absent/"local" = the local shell, "remote" = inside
   * an ssh session (a nested OSC 133 C, or a heuristic prompt-boundary block). */
  source?: "local" | "remote";
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
    source: "local" | "remote" = "local",
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
      source,
    };
  }

  /**
   * Push an already-closed block assembled outside the C/D lifecycle (the
   * heuristic remote tracker). The still-open block — the local `ssh` command
   * the remote block runs inside — is force-pushed first: hit-testing iterates
   * newest-first, so leaving it open until the local D would make the
   * session-spanning ssh block shadow every block nested inside it.
   */
  pushClosed(block: CommandBlock): void {
    if (this.open) {
      this.push(this.open);
      this.open = null;
    }
    this.push(block);
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
  /** True while the current local command contains nested OSC 133 C/D pairs —
   * the remote shell has its own integration, so the heuristic remote-block
   * tracker must stand down or it would double-capture every command. Resets
   * when the local command ends (depth back to 0). */
  sawNestedCommand: () => boolean;
  /** Zero the command-depth state. For shell respawn: the old shell's open
   * command died with it (a kill mid-ssh leaves depth stuck at 1, so the new
   * shell's every C would read as nested and onCommand would never fire). */
  resetNesting: () => void;
  /** Re-pin a command-start whose marker was destroyed out-of-band while the
   * prompt row survived: term.clear() (Cmd+K) keeps the cursor line but runs
   * buffer.clearAllMarkers(), and without a new pin the autocomplete ghost
   * stays dead until the next prompt cycle. Call with the cursor back on the
   * pin's row; no-op when there is no pin or its marker is still alive. */
  repinCommandStart: () => void;
  blocks: CommandBlockRing;
  dispose: () => void;
};

/**
 * Side-channel callbacks for the raw OSC 133 command lifecycle, independent of
 * the command-block ring. `onCommand` fires with the parsed command line on C
 * (only when non-empty). `onCommandEnd` fires on the D that closes the local
 * command — NOT on D's emitted by a nested remote shell. Used to detect a local
 * `ssh <host>` from the command text and surface a remote indicator for the
 * session's lifetime — even when the remote shell emits no OSC 7 of its own.
 *
 * Command-depth nesting: a remote host whose own shell has OSC 133 integration
 * emits a C/D pair around every remote command, nested inside the local `ssh`
 * command's outer C/D. Treating every D as end-of-command would clear the remote
 * indicator after the FIRST remote command while the ssh session is still live.
 * We track depth (C => +1, D => −1) and only fire `onCommandEnd` when depth
 * returns to 0 — i.e. the local command (the one that ran `ssh`) actually
 * exited. A stock remote shell emits neither C nor D, so depth holds at 1 across
 * the whole session and the local ssh's own D fires it; this matters for the
 * partial case (remote emits OSC 133 but no OSC 7) where the remoteCwd fallback
 * can't keep the pill alive.
 */
export type PromptTrackerOpts = {
  onCommand?: (command: string) => void;
  onCommandEnd?: () => void;
  /** Seed for the command-depth counter. A pane that rebinds mid-ssh (wake
   * from hibernation) replays only the dormant tail — the remote commands —
   * without the original local `C;ssh …`, so a fresh tracker counting from 0
   * would misread them as local depth-1/0 pairs and clear the ssh indicator.
   * Seed 1 when the session is known to be inside ssh. The spill path replays
   * the FULL transcript (the outer C included), so it must keep seeding 0. */
  initialDepth?: number;
  /** Seed for the command-start pin. A hibernation rebind replays a
   * serialized snapshot that carries no OSC 133, so a fresh tracker would
   * have no pin (autocomplete dead at the restored prompt) until the next
   * full prompt cycle. `col` is the buffer column captured at release;
   * `rowOffset` is the pin row relative to the cursor — the cursor position
   * is what snapshot replay reproduces exactly. Any replayed A/B/C/D takes
   * over from the seed. The spill path replays the raw transcript (OSC 133
   * included) and resets the terminal first, so it must keep passing null. */
  initialCommandStart?: { col: number; rowOffset: number } | null;
};

export function registerPromptTracker(
  term: Terminal,
  state?: ShellIntegrationState,
  opts?: PromptTrackerOpts,
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
  // Re-seed the pin captured before a hibernation release (see
  // PromptTrackerOpts.initialCommandStart). term.write is async-FIFO and the
  // tracker is registered while the snapshot bytes are still queued, so the
  // marker must anchor via an empty write's callback — it lands exactly
  // between the snapshot and the dormant-ring bytes. A replayed A/B/C/D from
  // the ring replaces commandStart, which voids a still-pending anchor.
  const seed = opts?.initialCommandStart;
  if (seed) {
    const pin: { marker: IMarker | null; col: number } = {
      marker: null,
      col: seed.col,
    };
    commandStart = pin;
    try {
      term.write("", () => {
        if (commandStart !== pin || isAltScreen(term)) return;
        pin.marker = registerMarkerSafe(term, seed.rowOffset);
      });
    } catch {
      commandStart = null;
    }
  }
  // OSC 133 command nesting. A C opens a command (+1), its D closes it (−1).
  // A remote shell with its own OSC 133 integration emits inner C/D pairs that
  // nest inside the local command's span; only the D that returns depth to 0
  // ends the local command. See PromptTrackerOpts for why this matters to ssh.
  let commandDepth = opts?.initialDepth ?? 0;
  let sawNested = false;
  // Buffer rows of the last counted C and D, for stacked-integration dedup.
  // The user's own rc files often source ANOTHER OSC 133 integration (iTerm2,
  // WezTerm, Kitty…) on top of Termul's, so every command emits two C's and
  // two D's. Counting both C's would read depth 2 as "the remote shell has its
  // own integration" and latch sawNested for an entire ssh session — killing
  // the heuristic remote blocks. The duplicates fire back to back from the
  // same prompt hook, so they land on the SAME buffer row; a genuinely nested
  // remote C/D always sits on a later row (the remote echoed at least a
  // newline) and its integration emits its own A in between, which resets the
  // dedup. Same row + same prompt cycle (no A/D for C, no A/C for D) ⇒ the
  // same command ⇒ collapse the duplicate entirely.
  let lastCLine: number | null = null;
  let lastDLine: number | null = null;
  const blocks = new CommandBlockRing();
  const d = term.parser.registerOscHandler(133, (data) => {
    // OSC 133 A — start of new prompt (between commands).
    if (data.startsWith("A")) {
      if (state) state.inCommand = false;
      clearCommandStart();
      lastCLine = null;
      lastDLine = null;
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
      lastDLine = null;
      // Stacked-integration duplicate (see lastCLine above): same command,
      // collapse — don't count, don't latch sawNested, don't open a block.
      const cLine = cursorLineSafe(term);
      if (cLine >= 0 && cLine === lastCLine) {
        clearCommandStart();
        return true;
      }
      lastCLine = cLine;
      // Count the command (local or nested-remote) for end-of-command pairing.
      // Independent of the alt-screen block-capture guard below so depth stays
      // balanced whether a command runs on the normal or the alternate screen.
      commandDepth++;
      if (commandDepth >= 2) sawNested = true;
      // Capture the typed command from the buffer BEFORE the start pin is
      // cleared. Many shell integrations emit a bare `C` with no command in the
      // payload, so this buffer read (the same source the autocomplete uses) is
      // what makes `ssh <host>` detection fire on a stock OSC 133 setup.
      const typedCommand = readTypedCommand(term, commandStart);
      // Command submitted: the input line is final, no more editing.
      clearCommandStart();
      // Skip block capture inside a TUI (vim/htop/less): the alt screen has no
      // scrollback and its incremental redraws would produce bogus ranges.
      if (!isAltScreen(term)) {
        // Payload is "C;<cmd>": everything after the first ";" is the command.
        const command = data.startsWith("C;") ? data.slice(2) : "";
        // Surface the raw command line (e.g. for `ssh <host>` detection), but
        // only for the OUTER local command (depth 1). A nested remote shell's
        // C (depth > 1) is a command running *inside* the ssh session, not the
        // local one — firing for it would flip the indicator to a nested host
        // (and leak a pill onto an injected `C;ssh ...` in command output).
        // Fall back to the buffer-read command when the payload omits it.
        const detected = command || typedCommand;
        if (detected && commandDepth === 1) opts?.onCommand?.(detected);
        // Hand this prompt's A marker (the command line) to the block so its
        // highlight spans the command, not just the output. Release ownership
        // (marker = null) so the next A doesn't dispose it — the block owns it
        // for its lifetime now and frees it on eviction / ring dispose.
        // `detected` (not the raw payload) so bash's bare `C` — whose command
        // only exists via the buffer read — still yields an interactive block.
        const promptMarker = marker;
        marker = null;
        blocks.beginCommand(
          detected,
          promptMarker,
          registerMarkerSafe(term),
          commandDepth > 1 ? "remote" : "local",
        );
      }
    } else if (data.startsWith("D")) {
      // OSC 133 D — command ends.
      if (state) state.inCommand = false;
      clearCommandStart();
      lastCLine = null;
      // Stacked-integration duplicate (same command's second D, same row):
      // skip — the first D already closed the block and fired onCommandEnd.
      const dLine = cursorLineSafe(term);
      if (dLine >= 0 && dLine === lastDLine) return true;
      lastDLine = dLine;
      // Close one command level. Only the D that returns depth to 0 ends the
      // LOCAL command — D's from a nested remote shell's OSC 133 integration
      // (depth > 1) must not fire onCommandEnd, or the ssh pill would clear
      // after the first remote command while the session is still live.
      // A D with no open command (depth already 0, e.g. bash 3.2 / PowerShell
      // skipping the pre-exec C) still counts as end-of-command — clamp at 0 so
      // the existing degraded-block behavior is preserved. Always signal here,
      // even on the alt screen: a local `ssh` that dropped straight into a
      // remote TUI still exits at depth 0 and the indicator must clear.
      if (commandDepth > 0) commandDepth--;
      if (commandDepth === 0) {
        sawNested = false;
        opts?.onCommandEnd?.();
      }
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
    sawNestedCommand: () => sawNested,
    resetNesting: () => {
      commandDepth = 0;
      sawNested = false;
      lastCLine = null;
      lastDLine = null;
    },
    repinCommandStart: () => {
      if (!commandStart || isAltScreen(term)) return;
      const m = commandStart.marker;
      if (m && !m.isDisposed) return;
      commandStart.marker = registerMarkerSafe(term);
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

/**
 * Best-effort read of the just-submitted command from the buffer: the text on
 * the pinned command-start row, from the start column to the end of that row.
 * Used as a fallback for OSC 133 `C` payloads that carry no command (the common
 * case), so `ssh <host>` detection works without iTerm-style command payloads.
 * Single-row only; returns "" on the alt screen, a disposed pin, or no row.
 */
function readTypedCommand(
  term: Terminal,
  start: { marker: IMarker | null; col: number } | null,
): string {
  const m = start?.marker;
  if (!m || m.isDisposed || isAltScreen(term)) return "";
  try {
    const row = term.buffer.active.getLine(m.line);
    if (!row) return "";
    // Column-addressed read (start.col is a buffer column, not a string index —
    // wide CJK/emoji cells make the two diverge); trimRight drops the trailing
    // blank cells so we get just the command.
    return row.translateToString(true, start!.col).trim();
  } catch {
    return "";
  }
}

/** registerMarker that never throws. `offset` is rows below the cursor; xterm
 * does no bounds validation, so a marker pinned one row past the last buffer
 * row simply tracks the future row (exported for the heuristic remote-block
 * tracker, which pins output-start before the row exists). */
export function registerMarkerSafe(term: Terminal, offset = 0): IMarker | null {
  try {
    return term.registerMarker(offset) ?? null;
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

/** Absolute buffer row of the cursor, or -1 when unreadable (-1 never equals a
 * stored row, so dedup degrades to "count everything" rather than collapsing). */
function cursorLineSafe(term: Terminal): number {
  try {
    const buf = term.buffer.active;
    return buf.baseY + buf.cursorY;
  } catch {
    return -1;
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
