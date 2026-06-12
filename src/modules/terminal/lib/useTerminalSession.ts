import { ensureMonoFontsLoaded } from "@/lib/fonts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { SearchAddon } from "@xterm/addon-search";
import { hostname } from "@tauri-apps/plugin-os";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { isLocalHost, parseSshTarget } from "./remoteCwd";
import { AutocompleteController } from "./autocompleteController";
import { promptCwd } from "./historyMatch";
import { BlockController, type BlockFrame } from "./blockController";
import {
  DEFAULT_BYTE_CAP,
  DEFAULT_CHUNK_CAP,
  DormantRing,
} from "./dormantRing";
import {
  type CommandBlock,
  type CommandBlockRing,
  createShellIntegrationState,
  type PromptTracker,
  registerCwdHandler,
  registerPromptTracker,
} from "./osc-handlers";
import { createRemoteBlockTracker } from "./remoteBlocks";
import { pasteImage, quotePathsForShell } from "./remoteUpload";
import { openPty, type PtySession } from "./pty-bridge";
import {
  acquireSlot,
  applyBackgroundActive,
  applyFontFamily,
  applyFontSize,
  applyLetterSpacing,
  applyTheme as applyPoolTheme,
  applyScrollback,
  applyWebglPreference,
  configureRendererPool,
  focusSlot,
  getSlotForLeaf,
  releaseSlot,
  serializeLeaf,
  setSlotFocused,
  snapshotLeaf,
  type Slot,
} from "./rendererPool";
import {
  armSnapshotDebounce,
  cancelSnapshotDebounce,
  loadRestoredSnapshot,
  persistSnapshot,
} from "./sessionSnapshots";

// How long the cursor must sit still before the prompt-cwd heuristic reads the
// row — long enough for a remote command's output to finish printing and the
// new prompt to settle, short enough to feel instant after a `cd`.
const CWD_SETTLE_MS = 150;

type Callbacks = {
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string, remote: boolean) => void;
  // The host of a locally-detected `ssh <host>` (from the OSC 133 C command),
  // or null when that ssh session ends (OSC 133 D). Independent of onCwd:
  // surfaces a remote indicator even when the remote shell emits no OSC 7.
  onSshHost?: (host: string | null) => void;
};

type Session = {
  pty: PtySession | null;
  ptyOpening: boolean;
  initialCwd: string | undefined;
  lastCwd: string | null;
  // Whether lastCwd came from a remote (SSH) shell. Display-only: a remote cwd
  // updates the tab label/status pill but never the local explorer.
  lastCwdRemote: boolean;
  // The detected `ssh <target>` this session is currently in (mirrors what the
  // tab's sshHost holds), or null on the local shell. Read by the autocomplete
  // controller to match against the remote host's history instead of local.
  sshHost: string | null;
  // True once this ssh session has emitted a real OSC 7 of its own, so the
  // prompt-cwd heuristic stands down (the shell's own absolute path wins).
  // Reset when the ssh session ends.
  remoteOsc7Seen: boolean;
  pendingExit: number | null;
  shellExited: boolean;
  callbacks: Callbacks;
  visibleNow: boolean;
  focusedNow: boolean;
  disposed: boolean;
  ready: Promise<void>;
  cols: number;
  rows: number;
  container: HTMLDivElement | null;
  snapshot: string | null;
  searchQuery: string | null;
  dormantRing: DormantRing;
  hasSlot: boolean;
  // Command-block ring owned by the prompt tracker of the currently bound
  // slot. Set when a slot binds (registerOsc), cleared on release. Lets the
  // block accessors reach the live ring; null when no slot is bound.
  blocks: CommandBlockRing | null;
  // The bound slot's prompt tracker, for resetting its command-depth state on
  // shell exit/respawn (the old shell's open command died with it). Lives and
  // dies with `blocks`.
  promptTracker: PromptTracker | null;
  // Hover/selection + geometry controller for the bound slot's block ring.
  // Lives and dies with `blocks` (created on bind, disposed on release).
  blockCtl: BlockController | null;
  // Inline shell-history autocomplete for the bound slot. Created on bind,
  // disposed on release. Reachable from the key handler (via resolveLeaf) and
  // the overlay (via getAutocomplete).
  autocompleteCtl: AutocompleteController | null;
  // True if the slot was in alt-screen mode (TUI like vim, htop, dofek)
  // at the most recent release. Read once on the next bind to trigger a
  // SIGWINCH-driven repaint instead of replaying dormant bytes.
  altScreenAtRelease: boolean;
  // The autocomplete's command-start pin captured at release (col + pin row
  // relative to the cursor). The serialized snapshot replayed on rebind has
  // no OSC 133, so the fresh prompt tracker re-seeds from this instead of
  // staying pinless (ghost dead) until the next prompt cycle. Consumed once
  // on the next bind; null when released mid-command or on the alt screen.
  commandStartSeed: { col: number; rowOffset: number } | null;
  // Per-tab "keep full output" disk spill. When true, hibernation bytes are
  // captured to the Rust spill file (not the RAM ring) and wake replays the
  // full scrollback from that file. Mirrors the tab's spillToDisk choice.
  spill: boolean;
  // Mirrors the Rust-side dormant flag. While true the backend parks output
  // in an in-process tail ring instead of streaming every chunk over IPC just
  // for deliverPtyBytes to ring (or drop) it here; waking splices the tail
  // back into the data channel. Only set while hibernated with the
  // dropHibernatedOutput preference on and spill off — in every other mode
  // output streams exactly as before.
  dormant: boolean;
  // True while a spill replay is writing the transcript on wake. Live bytes are
  // suppressed (they're already in the replayed file, spilled before shipping,
  // so re-writing them would duplicate output) until the queued write is sent.
  replaying: boolean;
  // Bumped on every (un)bind so a slow spill read from a prior bind that
  // resolves after an unbind/rebind is recognised as stale and ignored.
  replayToken: number;
};

const sessions = new Map<number, Session>();

// Wake callbacks for the focused pane's overlay settle loops (block hover +
// autocomplete), registered by the layers and poked by the bound slot's
// controllers so the loops can park while there is nothing to paint. Kept
// outside Session: a layer's effect can subscribe before its session exists
// (child effects run before the parent's), and they survive slot rebinds.
const blockOverlayKicks = new Map<number, () => void>();
const autocompleteOverlayKicks = new Map<number, () => void>();

// This machine's hostname, used to tell a remote (SSH) OSC 7 cwd apart from a
// local one. Resolved once at startup; until it lands, every host is treated as
// local (see isLocalHost) so the non-SSH case is never disrupted.
let localHostname: string | null = null;
void hostname()
  .then((h) => {
    localHostname = h;
  })
  .catch(() => {});

const readyLeaves = new Set<number>();
const readyWaiters = new Map<
  number,
  { resolve: () => void; timer: ReturnType<typeof setTimeout> }[]
>();

function markSessionReady(leafId: number): void {
  if (readyLeaves.has(leafId)) return;
  readyLeaves.add(leafId);
  const waiters = readyWaiters.get(leafId);
  if (!waiters) return;
  readyWaiters.delete(leafId);
  for (const w of waiters) {
    clearTimeout(w.timer);
    w.resolve();
  }
}

export function whenSessionReady(leafId: number, timeoutMs = 4000): Promise<void> {
  if (readyLeaves.has(leafId)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const arr = readyWaiters.get(leafId);
      const i = arr?.findIndex((w) => w.timer === timer) ?? -1;
      if (arr && i >= 0) arr.splice(i, 1);
      resolve();
    }, timeoutMs);
    const arr = readyWaiters.get(leafId) ?? [];
    arr.push({ resolve, timer });
    readyWaiters.set(leafId, arr);
  });
}

export function writeToSession(leafId: number, data: string): boolean {
  const s = sessions.get(leafId);
  if (!s || !s.pty) return false;
  void s.pty.write(data);
  return true;
}

/**
 * The `ssh <target>` this pane is currently in (the dialed `[user@]host`), or
 * null on the local shell. Used by the file-drop handler to upload a dropped
 * file to the remote instead of inserting a useless local path.
 */
export function sshHostForSession(leafId: number): string | null {
  return sessions.get(leafId)?.sshHost ?? null;
}

/**
 * Clear the scrollback and screen of the currently focused terminal, keeping
 * the active prompt line — macOS Terminal's ⌘K behaviour. Returns false when no
 * focused terminal slot is bound (e.g. focus is in the editor or AI panel).
 */
export function clearFocusedTerminal(): boolean {
  for (const [leafId, s] of sessions) {
    if (!s.visibleNow || !s.focusedNow) continue;
    const slot = getSlotForLeaf(leafId);
    if (!slot) continue;
    // term.clear() keeps the cursor's row but runs buffer.clearAllMarkers(),
    // killing the autocomplete's command-start pin mid-prompt — the ghost
    // would stay dead until the next prompt cycle. Re-pin right after, but
    // only when the pin sits on the cursor row (the one row clear preserves;
    // a wrapped multi-row edit line loses its pin row for real).
    const buf = slot.term.buffer.active;
    const cs = s.promptTracker?.getCommandStart() ?? null;
    const repin =
      cs !== null &&
      buf.type !== "alternate" &&
      cs.line === buf.baseY + buf.cursorY;
    slot.term.clear();
    if (repin) s.promptTracker?.repinCommandStart();
    return true;
  }
  return false;
}

export function leafIdForPty(ptyId: number): number | null {
  for (const [leafId, s] of sessions) {
    if (s.pty?.id === ptyId) return leafId;
  }
  return null;
}

configureRendererPool({
  resolveLeaf(leafId) {
    const s = sessions.get(leafId);
    if (!s) return null;
    return {
      writeToPty: (data) => {
        s.pty?.write(data);
      },
      handleAutocompleteKey: (event) =>
        s.autocompleteCtl?.handleKey(event) ?? false,
      resizePty: (cols, rows) => {
        s.cols = cols;
        s.rows = rows;
        s.pty?.resize(cols, rows);
      },
      kickPty: (cols, rows) => {
        const pty = s.pty;
        if (!pty || cols <= 0 || rows <= 0) return;
        // Linux only emits SIGWINCH when the winsize ioctl actually
        // changes dims, so bump +1 row then restore. The TUI receives
        // (possibly two) SIGWINCHes and repaints from scratch.
        pty
          .resize(cols, rows + 1)
          .then(() => pty.resize(cols, rows))
          .catch((e) => console.warn("[termul] kickPty failed:", e));
      },
      handlePasteImage: (blob, mime) => {
        // Upload to the SSHed host (or save locally), then drop the resulting
        // path at the prompt — same shape as a dropped file.
        void pasteImage({ host: s.sshHost, blob, mime }).then((path) => {
          if (path) void s.pty?.write(`${quotePathsForShell([path])} `);
        });
      },
    };
  },
  evictLeaf(leafId) {
    const s = sessions.get(leafId);
    if (!s) return;
    unbindLeafFromSlot(leafId, s);
  },
  isLeafFocused(leafId) {
    const s = sessions.get(leafId);
    return !!s && s.visibleNow && s.focusedNow;
  },
});

function ensureSession(leafId: number, initialCwd?: string): Session {
  const existing = sessions.get(leafId);
  if (existing) return existing;

  const session: Session = {
    pty: null,
    ptyOpening: false,
    initialCwd,
    lastCwd: null,
    lastCwdRemote: false,
    sshHost: null,
    remoteOsc7Seen: false,
    pendingExit: null,
    shellExited: false,
    callbacks: {},
    visibleNow: false,
    focusedNow: false,
    disposed: false,
    ready: Promise.resolve(),
    cols: 0,
    rows: 0,
    container: null,
    snapshot: null,
    searchQuery: null,
    dormantRing: makeDormantRing(),
    hasSlot: false,
    blocks: null,
    promptTracker: null,
    blockCtl: null,
    autocompleteCtl: null,
    altScreenAtRelease: false,
    commandStartSeed: null,
    spill: false,
    dormant: false,
    replaying: false,
    replayToken: 0,
  };
  sessions.set(leafId, session);

  session.ready = (async () => {
    await ensureMonoFontsLoaded();
    await document.fonts.ready;
    // Session restore: seed the persisted scrollback before the first bind /
    // PTY spawn (both wait on `ready`), so the existing snapshot-replay path
    // plays it back exactly like a hibernated tab waking up. Resolves null
    // synchronously for leaves that aren't part of a restored session.
    const restored = await loadRestoredSnapshot(leafId);
    if (restored && !session.disposed && session.snapshot === null) {
      session.snapshot = restored.snapshot;
      if (restored.cols > 0) session.cols = restored.cols;
      if (restored.rows > 0) session.rows = restored.rows;
    }
  })();

  return session;
}

/** The dormant-ring caps for a given `dropHibernatedOutput` choice: the default
 * caps (drop old output past 256 KB / 256 chunks, with an overflow notice) when
 * on, unbounded (keep every byte, replayed in full on wake — at the cost of
 * unbounded memory for noisy background tabs) when off. */
function ringCapsFor(dropHibernatedOutput: boolean): [number, number] {
  return dropHibernatedOutput
    ? [DEFAULT_BYTE_CAP, DEFAULT_CHUNK_CAP]
    : [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
}

/** A dormant ring honoring the current `dropHibernatedOutput` preference. Read
 * imperatively so each freshly created/reset ring picks up the live choice. */
function makeDormantRing(): DormantRing {
  return new DormantRing(
    ...ringCapsFor(usePreferencesStore.getState().dropHibernatedOutput),
  );
}

// Apply the trim preference to every live ring the moment it changes, so the
// toggle takes effect on already-open (and already-hibernated) tabs — not just
// sessions created afterward. Tightening caps evicts old buffered output now;
// loosening them lets subsequent output accumulate.
let lastDropPref = usePreferencesStore.getState().dropHibernatedOutput;
usePreferencesStore.subscribe((state) => {
  if (state.dropHibernatedOutput === lastDropPref) return;
  lastDropPref = state.dropHibernatedOutput;
  const caps = ringCapsFor(state.dropHibernatedOutput);
  for (const s of sessions.values()) {
    s.dormantRing.setCaps(...caps);
    applyDormant(s);
  }
});

function deliverPtyBytes(leafId: number, bytes: Uint8Array): void {
  const s = sessions.get(leafId);
  if (!s) return;
  const slot = getSlotForLeaf(leafId);
  if (!slot) {
    // Hibernated. A spilled session is captured to disk by Rust, so skip the
    // RAM ring entirely — that's the whole point (no unbounded memory).
    if (!s.spill) s.dormantRing.push(bytes);
    return;
  }
  // Suppress live writes while replaying the spill transcript on wake: these
  // bytes were spilled before being shipped, so they're already in the queued
  // replay — writing them now would duplicate output.
  if (s.replaying) return;
  slot.term.write(bytes);
  // Session restore: capture the buffer once output goes quiet. Hibernated
  // leaves are covered by the release-time persist instead.
  armSnapshotDebounce(leafId, () => serializeLeaf(leafId));
}

/** Re-enable spill on a freshly (re)opened PTY when the tab already had it on
 * (e.g. a new split pane in a spilled tab, or after respawn). No seed needed —
 * a fresh terminal has no prior scrollback. No-op on the common spill-off path. */
function applySpill(s: Session): void {
  if (!s.spill) return;
  s.pty?.setSpill(true).catch((e) => {
    console.warn("[termul] setSpill failed:", e);
  });
}

/** Reconcile the Rust-side dormant flag with the session's current state.
 * Backend buffering only replaces the IPC stream when hibernation output is
 * bounded (dropHibernatedOutput on) and not already captured to disk (spill);
 * with dropHibernatedOutput off the ring caps are Infinity — every byte must
 * keep streaming — so the session stays non-dormant. Idempotent. */
function applyDormant(s: Session): void {
  const pty = s.pty;
  if (!pty || s.disposed) return;
  const next =
    !s.hasSlot &&
    !s.spill &&
    usePreferencesStore.getState().dropHibernatedOutput;
  if (s.dormant === next) return;
  s.dormant = next;
  pty.setDormant(next).catch((e) => {
    console.warn("[termul] setDormant failed:", e);
  });
}

/**
 * Toggle the per-tab "keep full output to disk" for a leaf's session. Driven by
 * the terminal pane when the owning tab's spill choice changes (and on mount).
 * Idempotent; cheap no-op when unchanged.
 */
export function setSessionSpill(leafId: number, enabled: boolean): void {
  const s = sessions.get(leafId);
  if (!s || s.spill === enabled) return;
  s.spill = enabled;
  // Seed the file with current scrollback on enable (live snapshot if bound,
  // else the last release snapshot) so pre-enable history survives the first
  // wake. No seed on disable.
  const seed = enabled
    ? (snapshotLeaf(leafId) ?? s.snapshot ?? undefined)
    : undefined;
  s.pty?.setSpill(enabled, seed).catch((e) => {
    console.warn("[termul] setSpill failed:", e);
  });
  // Spill and dormant are mutually exclusive: a spilled tab keeps streaming
  // (chunks land on disk Rust-side), a non-spilled hibernated one may park.
  applyDormant(s);
}

/**
 * Reconstruct a spilled session's terminal from its on-disk transcript on wake:
 * read the bounded tail from Rust, reset, and replay it. Live bytes are
 * suppressed (s.replaying) across the async read so they don't double-render;
 * xterm queues writes in order, so resuming right after dispatching the replay
 * keeps later live output correctly after the transcript. A bind/unbind during
 * the read bumps replayToken, marking this result stale.
 */
function replayFromSpill(
  leafId: number,
  s: Session,
  fallbackSnapshot: string | null,
): void {
  const pty = s.pty;
  if (!pty) return;
  const token = s.replayToken;
  s.replaying = true;
  pty
    .readSpill()
    .then((buf) => {
      if (s.disposed || s.replayToken !== token) return;
      const slot = getSlotForLeaf(leafId);
      if (!slot) return;
      slot.term.reset();
      if (buf.byteLength > 0) slot.term.write(new Uint8Array(buf));
      else if (fallbackSnapshot) slot.term.write(fallbackSnapshot);
    })
    .catch((e) => {
      console.warn("[termul] spill replay failed:", e);
    })
    .finally(() => {
      // Only clear suppression if no newer bind has taken over.
      if (s.replayToken === token) s.replaying = false;
    });
}

/** Reset per-shell lifecycle state when the shell process goes away (exit or
 * respawn): the ssh pill and the OSC 133 command-depth both describe the DEAD
 * shell's world and must not leak onto its successor. */
function clearShellLifecycleState(s: Session): void {
  if (s.sshHost) {
    s.sshHost = null;
    s.remoteOsc7Seen = false;
    s.callbacks.onSshHost?.(null);
  }
  s.promptTracker?.resetNesting();
}

async function openPtyForSession(
  leafId: number,
  s: Session,
  cwd: string | undefined,
): Promise<PtySession> {
  const startCols = s.cols > 0 ? s.cols : 80;
  const startRows = s.rows > 0 ? s.rows : 24;
  return openPty(
    startCols,
    startRows,
    {
      onData: (bytes) => deliverPtyBytes(leafId, bytes),
      onExit: (code) => {
        s.shellExited = true;
        s.pty = null;
        s.dormant = false;
        // The local shell died — any ssh session and open command nesting
        // died with it. Stale state would keep the pill up, and a depth stuck
        // at 1 would make every command of a respawned shell read as nested
        // (onCommand silenced, heuristic blocks misarmed).
        clearShellLifecycleState(s);
        const slot = getSlotForLeaf(leafId);
        if (slot) slot.term.options.disableStdin = true;
        if (s.callbacks.onExit) s.callbacks.onExit(code);
        else s.pendingExit = code;
      },
    },
    cwd,
  );
}

function bindLeafToSlot(leafId: number, s: Session): void {
  if (!s.container) return;
  const altScreen = s.altScreenAtRelease;
  s.altScreenAtRelease = false;
  // A spilled session reconstructs from the on-disk transcript rather than the
  // snapshot + RAM ring. Alt-screen TUIs (SIGWINCH repaint) and exited shells
  // (no live pty to read; final snapshot suffices) keep the normal path.
  const fromSpill = s.spill && !altScreen && !s.shellExited && !!s.pty;
  // Captured before it's nulled below: used as a fallback if the spill read
  // comes back empty (e.g. enabled with nothing captured yet).
  const fallbackSnapshot = s.snapshot;
  // Every (re)bind invalidates a prior in-flight spill replay and clears any
  // leftover suppression; replayFromSpill re-arms it below when relevant.
  s.replayToken++;
  s.replaying = false;
  acquireSlot({
    leafId,
    container: s.container,
    snapshot: fromSpill ? null : s.snapshot,
    altScreen,
    drainRing: fromSpill ? () => {} : (write) => s.dormantRing.drain(write),
    shellExited: s.shellExited,
    searchQuery: s.searchQuery,
    cols: s.cols,
    rows: s.rows,
    registerOsc: (term) => {
      // Shared in-command flag — see osc-handlers.ts. The prompt tracker
      // flips it on OSC 133 B/C/D/A; the cwd handler reads it to ignore OSC
      // 7 emitted by untrusted command output (remote SSH, `cat` of an
      // attacker file, etc.).
      const shellState = createShellIntegrationState();

      // Both OSC 7 and the prompt-cwd heuristic funnel cwd updates through here,
      // so the dedup and the session-ready signal live in one place.
      const dispatchCwd = (next: string, remote: boolean) => {
        markSessionReady(leafId);
        if (s.lastCwd === next && s.lastCwdRemote === remote) return;
        s.lastCwd = next;
        s.lastCwdRemote = remote;
        s.callbacks.onCwd?.(next, remote);
      };

      const prompt = registerPromptTracker(term, shellState, {
        // Detect a local `ssh <host>` from the raw command line and surface a
        // remote indicator for its lifetime — even against a stock remote shell
        // that emits no OSC 7 of its own. Cleared when the command ends (the
        // local ssh process exits → OSC 133 D).
        onCommand: (cmd) => {
          // The FULL target (`user@host`), not the bare host, so the remote
          // browser connects as the same identity the terminal did. Mirror it
          // onto the session so the autocomplete controller matches against the
          // remote host's history for the session's lifetime.
          const target = parseSshTarget(cmd);
          s.sshHost = target;
          if (target) s.callbacks.onSshHost?.(target);
        },
        onCommandEnd: () => {
          s.sshHost = null;
          s.remoteOsc7Seen = false;
          s.callbacks.onSshHost?.(null);
        },
        // A rebind mid-ssh replays the dormant tail — remote commands without
        // the original local `C;ssh …` — so a 0-seeded tracker would misread
        // them as local pairs and clear the pill. The spill path replays the
        // FULL transcript (outer C included), so it must recount from 0.
        initialDepth: fromSpill ? 0 : s.sshHost ? 1 : 0,
        // Same asymmetry for the autocomplete pin: the snapshot has no OSC
        // 133 (re-seed from the release capture), the spill transcript does
        // (and its replay resets the terminal, killing a seeded marker).
        initialCommandStart: fromSpill ? null : s.commandStartSeed,
      });
      s.commandStartSeed = null;
      // Expose the slot's command-block ring to the session so getLastBlock /
      // getBlocks can read it. The prompt tracker disposes the ring on its own
      // disposer (returned below), so we only need to drop our reference.
      s.blocks = prompt.blocks;
      s.promptTracker = prompt;
      const blockCtl = new BlockController(term, prompt.blocks, () =>
        blockOverlayKicks.get(leafId)?.(),
      );
      s.blockCtl = blockCtl;
      // Pass the live accessor (not a snapshot) so it tracks the tracker that's
      // rebuilt per slot bind after hibernation.
      const autocompleteCtl = new AutocompleteController(
        term,
        (data) => s.pty?.write(data),
        prompt.getCommandStart,
        () => s.sshHost,
        () => autocompleteOverlayKicks.get(leafId)?.(),
      );
      s.autocompleteCtl = autocompleteCtl;
      const cwd = registerCwdHandler(
        term,
        (next, host) => {
          const remote = !isLocalHost(host, localHostname);
          // A real OSC 7 from the remote shell is authoritative (absolute path),
          // so stand the prompt heuristic down for the rest of the session.
          if (remote) s.remoteOsc7Seen = true;
          dispatchCwd(next, remote);
        },
        shellState,
      );

      // Stock remote shells emit no OSC 7, so registerCwdHandler never fires for
      // them. Recover the cwd from the prompt line instead: once output settles
      // on a new prompt (the cursor stops moving), read the `\w` the default PS1
      // prints (promptCwd) and let the explorer follow it. Gated to an ssh
      // session that hasn't shown a real OSC 7, so the local shell is untouched.
      let cwdTimer: ReturnType<typeof setTimeout> | null = null;
      const readPromptCwd = () => {
        cwdTimer = null;
        if (!s.sshHost || s.remoteOsc7Seen) return;
        const buf = term.buffer.active;
        if (buf.type === "alternate") return;
        const row = buf
          .getLine(buf.baseY + buf.cursorY)
          ?.translateToString(true);
        const next = row ? promptCwd(row) : null;
        if (next) dispatchCwd(next, true);
      };
      const cursorMove = term.onCursorMove(() => {
        if (!s.sshHost || s.remoteOsc7Seen) return;
        if (cwdTimer !== null) clearTimeout(cwdTimer);
        cwdTimer = setTimeout(readPromptCwd, CWD_SETTLE_MS);
      });

      // Heuristic per-command blocks for an ssh session against a stock remote
      // shell (no OSC 133 of its own). Stands down the moment the remote shows
      // nested OSC 133 — that path owns block capture then. NOT gated on
      // remoteOsc7Seen: OSC 7 says nothing about command boundaries.
      const remoteBlocks = createRemoteBlockTracker(term, prompt.blocks, {
        isActive: () => !!s.sshHost && !prompt.sawNestedCommand(),
      });

      return [
        remoteBlocks.dispose,
        () => {
          blockCtl.dispose();
          if (s.blockCtl === blockCtl) s.blockCtl = null;
        },
        () => {
          autocompleteCtl.dispose();
          if (s.autocompleteCtl === autocompleteCtl) s.autocompleteCtl = null;
        },
        () => {
          if (cwdTimer !== null) clearTimeout(cwdTimer);
          cursorMove.dispose();
        },
        () => {
          if (s.promptTracker === prompt) s.promptTracker = null;
          prompt.dispose();
        },
        cwd,
      ];
    },
    onSearchReady: (addon) => s.callbacks.onSearchReady?.(addon),
  });
  s.snapshot = null;
  s.hasSlot = true;
  // After the bind: the OSC handlers registered above must exist before the
  // spliced dormant tail arrives over the data channel.
  applyDormant(s);
  if (fromSpill) replayFromSpill(leafId, s, fallbackSnapshot);
  if (s.lastCwd !== null) s.callbacks.onCwd?.(s.lastCwd, s.lastCwdRemote);
  if (s.pendingExit !== null) {
    const code = s.pendingExit;
    s.pendingExit = null;
    s.callbacks.onExit?.(code);
  }
}

function unbindLeafFromSlot(leafId: number, s: Session): void {
  if (!s.hasSlot) return;
  // Invalidate any in-flight spill replay and drop its byte suppression so a
  // late read result can't write into (or freeze) a now-unbound terminal.
  s.replayToken++;
  s.replaying = false;
  // Capture the autocomplete's command-start pin before releaseSlot disposes
  // the tracker, keyed to the cursor (the one position snapshot replay
  // restores exactly) so the rebind can re-seed it — see commandStartSeed.
  s.commandStartSeed = null;
  const cs = s.promptTracker?.getCommandStart() ?? null;
  const slot = cs ? getSlotForLeaf(leafId) : null;
  if (cs && slot) {
    const buf = slot.term.buffer.active;
    if (buf.type !== "alternate") {
      s.commandStartSeed = {
        col: cs.col,
        rowOffset: cs.line - (buf.baseY + buf.cursorY),
      };
    }
  }
  const out = releaseSlot(leafId);
  if (out) {
    s.snapshot = out.snapshot;
    if (out.cols > 0) s.cols = out.cols;
    if (out.rows > 0) s.rows = out.rows;
    s.altScreenAtRelease = out.altScreen;
    // Session restore: hibernation is the main persist trigger — the buffer
    // was just serialized anyway, and a hibernated session never re-saves
    // (no idle work). Any armed capture is superseded by this fresher one.
    cancelSnapshotDebounce(leafId);
    persistSnapshot(leafId, out);
  }
  // releaseSlot ran the prompt-tracker disposer, which disposed the block
  // controller + the ring's markers. Drop our references so the accessors
  // report no blocks until rebind.
  s.blocks = null;
  s.blockCtl = null;
  s.autocompleteCtl = null;
  s.hasSlot = false;
  applyDormant(s);
}

function attachSession(
  leafId: number,
  container: HTMLDivElement,
  callbacks: Callbacks,
): void {
  const s = sessions.get(leafId);
  if (!s || s.disposed) return;
  s.callbacks = callbacks;
  s.container = container;

  if (s.visibleNow) bindLeafToSlot(leafId, s);

  if (!s.pty && !s.ptyOpening && !s.shellExited) {
    s.ptyOpening = true;
    openPtyForSession(leafId, s, s.initialCwd)
      .then((pty) => {
        s.ptyOpening = false;
        if (s.disposed) {
          pty.close();
          return;
        }
        s.pty = pty;
        applySpill(s);
        applyDormant(s);
        if (s.cols > 0 && s.rows > 0) pty.resize(s.cols, s.rows);
      })
      .catch((e) => {
        s.ptyOpening = false;
        console.error("[termul] openPty failed:", e);
      });
  }
}

function detachSession(leafId: number): void {
  const s = sessions.get(leafId);
  if (!s) return;
  unbindLeafFromSlot(leafId, s);
  s.callbacks = {};
  s.container = null;
}

export async function respawnSession(
  leafId: number,
  cwd?: string,
): Promise<void> {
  const s = sessions.get(leafId);
  if (!s || s.disposed) return;
  cancelSnapshotDebounce(leafId);
  s.pty?.close();
  s.pty = null;
  // close() doesn't run the exit callback, so clear the dead shell's
  // ssh/depth state here too (a respawn mid-ssh must not keep the pill).
  clearShellLifecycleState(s);
  s.dormant = false;
  s.snapshot = null;
  s.dormantRing = makeDormantRing();
  s.shellExited = false;
  s.pendingExit = null;
  s.altScreenAtRelease = false;

  const slot = getSlotForLeaf(leafId);
  if (slot) {
    slot.term.options.disableStdin = false;
    slot.term.clear();
    slot.term.reset();
  }

  s.ptyOpening = true;
  let pty: PtySession;
  try {
    pty = await openPtyForSession(leafId, s, cwd ?? s.initialCwd);
  } catch (e) {
    s.ptyOpening = false;
    console.error("[termul] respawn openPty failed:", e);
    return;
  }
  s.ptyOpening = false;
  if (s.disposed) {
    pty.close();
    return;
  }
  s.pty = pty;
  applySpill(s);
  applyDormant(s);
  if (s.cols > 0 && s.rows > 0) pty.resize(s.cols, s.rows);
}

export function disposeSession(leafId: number): void {
  const s = sessions.get(leafId);
  if (!s) return;
  s.disposed = true;
  unbindLeafFromSlot(leafId, s);
  // The unbind above persisted a final buffer; deleting the file for a
  // closed pane is prune's job (driven by the session-structure save).
  cancelSnapshotDebounce(leafId);
  s.snapshot = null;
  s.pty?.close();
  s.pty = null;
  sessions.delete(leafId);
  readyLeaves.delete(leafId);
  const waiters = readyWaiters.get(leafId);
  if (waiters) {
    readyWaiters.delete(leafId);
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }
}

type Options = {
  leafId: number;
  container: React.RefObject<HTMLDivElement | null>;
  visible: boolean;
  focused?: boolean;
  initialCwd?: string;
  /** Keep the full output on disk so hibernation never drops scrollback. */
  spillToDisk?: boolean;
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string, remote: boolean) => void;
  /** Host of a locally-detected `ssh <host>` while it runs; null when it ends. */
  onSshHost?: (host: string | null) => void;
};

export function useTerminalSession({
  leafId,
  container,
  visible,
  focused = true,
  initialCwd,
  spillToDisk = false,
  onSearchReady,
  onExit,
  onCwd,
  onSshHost,
}: Options) {
  const cbRef = useRef({ onSearchReady, onExit, onCwd, onSshHost });
  cbRef.current = { onSearchReady, onExit, onCwd, onSshHost };

  useEffect(() => {
    let cancelled = false;
    const s = ensureSession(leafId, initialCwd);
    s.ready.then(() => {
      if (cancelled || s.disposed) return;
      const node = container.current;
      if (!node) return;
      attachSession(leafId, node, {
        onSearchReady: (a) => cbRef.current.onSearchReady?.(a),
        onExit: (c) => cbRef.current.onExit?.(c),
        onCwd: (c, r) => cbRef.current.onCwd?.(c, r),
        onSshHost: (h) => cbRef.current.onSshHost?.(h),
      });
      if (s.visibleNow && s.focusedNow) focusSlot(leafId);
    });
    return () => {
      cancelled = true;
      detachSession(leafId);
    };
  }, [leafId, container, initialCwd]);

  const fontSize = usePreferencesStore((p) => p.terminalFontSize);
  const zoomLevel = usePreferencesStore((p) => p.zoomLevel);
  useEffect(() => {
    applyFontSize(Math.max(4, Math.round(fontSize * zoomLevel)));
  }, [fontSize, zoomLevel]);

  const fontFamily = usePreferencesStore((p) => p.terminalFontFamily);
  useEffect(() => {
    applyFontFamily(fontFamily);
  }, [fontFamily]);

  const letterSpacing = usePreferencesStore((p) => p.terminalLetterSpacing);
  useEffect(() => {
    applyLetterSpacing(letterSpacing);
  }, [letterSpacing]);

  const scrollback = usePreferencesStore((p) => p.terminalScrollback);
  useEffect(() => {
    applyScrollback(scrollback);
  }, [scrollback]);

  const webglPref = usePreferencesStore((p) => p.terminalWebglEnabled);
  useEffect(() => {
    applyWebglPreference(webglPref);
  }, [webglPref]);

  const bgActive = usePreferencesStore(
    (p) => p.backgroundKind === "image" && !!p.backgroundImageId,
  );
  useEffect(() => {
    applyBackgroundActive(bgActive);
  }, [bgActive]);

  useEffect(() => {
    const s = sessions.get(leafId);
    if (!s) return;
    s.visibleNow = visible;
    s.focusedNow = focused;
    if (visible) {
      if (s.container && !s.hasSlot) bindLeafToSlot(leafId, s);
      setSlotFocused(leafId, focused);
      if (focused) focusSlot(leafId);
    } else if (s.hasSlot) {
      unbindLeafFromSlot(leafId, s);
    }
  }, [leafId, visible, focused]);

  // Push the owning tab's "keep full output to disk" choice down to this leaf's
  // session, re-applying when it flips or the leaf changes. Runs after the
  // attach effect above, so the session already exists.
  useEffect(() => {
    setSessionSpill(leafId, spillToDisk);
  }, [leafId, spillToDisk]);

  const write = useCallback(
    (data: string) => sessions.get(leafId)?.pty?.write(data),
    [leafId],
  );

  const focus = useCallback(() => focusSlot(leafId), [leafId]);

  const getBuffer = useCallback(
    (maxLines = 200): string | null => {
      const s = sessions.get(leafId);
      if (!s) return null;
      const slot = getSlotForLeaf(leafId);
      if (slot) {
        const buf = slot.term.buffer.active;
        const total = buf.length;
        const lines: string[] = [];
        const start = Math.max(0, total - maxLines);
        for (let i = start; i < total; i++) {
          lines.push(buf.getLine(i)?.translateToString(true) ?? "");
        }
        while (lines.length && lines[lines.length - 1] === "") lines.pop();
        return lines.join("\n");
      }
      if (!s.snapshot) return "";
      const plain = stripAnsi(s.snapshot);
      const lines = plain.split(/\r?\n/);
      const tail = lines.slice(-maxLines);
      while (tail.length && tail[tail.length - 1] === "") tail.pop();
      return tail.join("\n");
    },
    [leafId],
  );

  const getSelection = useCallback((): string | null => {
    const slot = getSlotForLeaf(leafId);
    const sel = slot?.term.getSelection() ?? "";
    return sel.length > 0 ? sel : null;
  }, [leafId]);

  const readBlock = useCallback(
    (block: CommandBlock | null): CommandBlockView | null => {
      if (!block) return null;
      const slot = getSlotForLeaf(leafId);
      const output = slot ? readBlockOutput(slot, block) : "";
      return {
        command: block.command,
        output,
        exitCode: block.exitCode,
        source: block.source ?? "local",
      };
    },
    [leafId],
  );

  const getLastBlock = useCallback(
    (): CommandBlockView | null => {
      const s = sessions.get(leafId);
      return readBlock(s?.blocks?.last() ?? null);
    },
    [leafId, readBlock],
  );

  const getBlocks = useCallback((): CommandBlockView[] => {
    const s = sessions.get(leafId);
    const blocks = s?.blocks?.all() ?? [];
    const out: CommandBlockView[] = [];
    for (const b of blocks) {
      const view = readBlock(b);
      if (view) out.push(view);
    }
    return out;
  }, [leafId, readBlock]);

  // The block targeted by copy / reinput / the hover toolbar: the hovered
  // block, else the keyboard-selected one, else the most recent block.
  const getActiveBlock = useCallback((): CommandBlockView | null => {
    const ctl = sessions.get(leafId)?.blockCtl;
    if (!ctl) return null;
    return readBlock(ctl.getActiveBlock() ?? ctl.lastBlock());
  }, [leafId, readBlock]);

  const selectPrevBlock = useCallback(() => {
    sessions.get(leafId)?.blockCtl?.selectRelative(-1);
  }, [leafId]);

  const selectNextBlock = useCallback(() => {
    sessions.get(leafId)?.blockCtl?.selectRelative(1);
  }, [leafId]);

  const clearBlockSelection = useCallback(() => {
    sessions.get(leafId)?.blockCtl?.clearSelection();
  }, [leafId]);

  // Select the block under a right-click (or clear when the click misses every
  // block) so the context menu acts on it.
  const selectBlockAtClientY = useCallback((clientY: number) => {
    const ctl = sessions.get(leafId)?.blockCtl;
    if (ctl) ctl.select(ctl.blockAtClientY(clientY));
  }, [leafId]);

  // Hover the block under the cursor (pass null to clear) — drives which block
  // the overlay highlights when the mouse moves over the grid.
  const setBlockHoverAt = useCallback((clientY: number | null) => {
    const ctl = sessions.get(leafId)?.blockCtl;
    if (!ctl) return;
    ctl.setHover(clientY === null ? null : ctl.blockAtClientY(clientY));
  }, [leafId]);

  // Pin the overlay's active block as the selection so its toolbar actions
  // still resolve to it once the pointer leaves the block — e.g. moving into
  // the ⋮ dropdown, which portals outside the grid and clears the hover.
  const pinActiveBlock = useCallback(() => {
    const ctl = sessions.get(leafId)?.blockCtl;
    if (ctl) ctl.select(ctl.getActiveBlock());
  }, [leafId]);

  // Geometry + status of the block the overlay should paint, in client coords;
  // null when nothing is active or it is scrolled out of view.
  const getBlockHoverFrame = useCallback(
    (): BlockFrame | null =>
      sessions.get(leafId)?.blockCtl?.getActiveFrame() ?? null,
    [leafId],
  );

  // The bound slot's autocomplete controller, for the overlay to subscribe to;
  // null between bind/release.
  const getAutocomplete = useCallback(
    (): AutocompleteController | null =>
      sessions.get(leafId)?.autocompleteCtl ?? null,
    [leafId],
  );

  // The overlays park their rAF settle loops while there is nothing to paint;
  // these subscriptions let the bound controllers wake them on activity.
  const subscribeBlockHover = useCallback(
    (cb: () => void) => {
      blockOverlayKicks.set(leafId, cb);
      return () => {
        if (blockOverlayKicks.get(leafId) === cb)
          blockOverlayKicks.delete(leafId);
      };
    },
    [leafId],
  );

  const subscribeAutocomplete = useCallback(
    (cb: () => void) => {
      autocompleteOverlayKicks.set(leafId, cb);
      return () => {
        if (autocompleteOverlayKicks.get(leafId) === cb)
          autocompleteOverlayKicks.delete(leafId);
      };
    },
    [leafId],
  );

  const applyTheme = useCallback(() => {
    applyPoolTheme();
  }, []);

  return useMemo(
    () => ({
      write,
      focus,
      getBuffer,
      getSelection,
      getLastBlock,
      getBlocks,
      getActiveBlock,
      selectPrevBlock,
      selectNextBlock,
      clearBlockSelection,
      selectBlockAtClientY,
      setBlockHoverAt,
      pinActiveBlock,
      getBlockHoverFrame,
      getAutocomplete,
      subscribeBlockHover,
      subscribeAutocomplete,
      applyTheme,
    }),
    [
      write,
      focus,
      getBuffer,
      getSelection,
      getLastBlock,
      getBlocks,
      getActiveBlock,
      selectPrevBlock,
      selectNextBlock,
      clearBlockSelection,
      selectBlockAtClientY,
      setBlockHoverAt,
      pinActiveBlock,
      getBlockHoverFrame,
      getAutocomplete,
      subscribeBlockHover,
      subscribeAutocomplete,
      applyTheme,
    ],
  );
}

/** A command block read back into plain text, on demand. */
export type CommandBlockView = {
  command: string;
  output: string;
  exitCode: number | null;
  source: "local" | "remote";
};

/**
 * Translate a block's `[startMarker.line, endMarker.line)` range into output
 * text the same way getBuffer reads the active buffer. Markers auto-dispose
 * when their line scrolls out of scrollback (line === -1 / isDisposed), so the
 * range is clamped and disposed markers degrade to whatever is still readable.
 */
function readBlockOutput(slot: Slot, block: CommandBlock): string {
  const start = block.startMarker;
  const end = block.endMarker;
  if (!start || start.isDisposed || start.line < 0) return "";
  const buf = slot.term.buffer.active;
  const from = start.line;
  const to =
    end && !end.isDisposed && end.line >= 0
      ? Math.min(end.line, buf.length)
      : buf.length;
  const lines: string[] = [];
  for (let i = from; i < to; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

const ANSI_RE =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[78=>]|\x1bc|\x1b[NOP\]X^_]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}
