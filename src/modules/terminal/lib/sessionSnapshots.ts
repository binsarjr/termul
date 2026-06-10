import { invoke } from "@tauri-apps/api/core";
import type { SerializeOutput } from "./rendererPool";

/**
 * Cross-restart scrollback persistence for session restore: each pane's
 * serialized buffer lives in its own file (backend `session_snapshot_*`
 * commands), loaded lazily per leaf at session creation so boot never ships
 * one giant payload pre-paint.
 *
 * File format is owned here: a `TSNAP1 <cols> <rows>` header line (the dims
 * the buffer was serialized at — replaying into a default 80x24 grid re-wraps
 * badly), then raw ANSI, then a trailing CRLF so the fresh shell's prompt
 * starts on a clean line under the replayed history.
 */

const HEADER_PREFIX = "TSNAP1 ";
// Trailing quiet gap before a bound pane's buffer is captured, and the upper
// bound for continuously noisy panes (tail -f, builds) so a crash can't lose
// more than this window.
const TRAIL_MS = 2_000;
const MAX_WAIT_MS = 30_000;

export function encodeSnapshot(out: SerializeOutput): string {
  return `${HEADER_PREFIX}${out.cols} ${out.rows}\n${out.snapshot}\r\n`;
}

export type RestoredSnapshot = {
  snapshot: string;
  cols: number;
  rows: number;
};

export function decodeSnapshot(raw: string): RestoredSnapshot | null {
  if (!raw.startsWith(HEADER_PREFIX)) return null;
  const eol = raw.indexOf("\n");
  if (eol < 0) return null;
  const parts = raw.slice(HEADER_PREFIX.length, eol).split(" ");
  const cols = Number(parts[0]);
  const rows = Number(parts[1]);
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) return null;
  return { snapshot: raw.slice(eol + 1), cols, rows };
}

// Leaves whose snapshot may be replayed this boot. Take-once: an id is
// dropped on first load so an HMR remount can't replay history twice.
const restorable = new Set<number>();
// Buffers of private tabs never touch disk — that's the flag's promise.
const privateLeaves = new Set<number>();

export function setRestorableLeaves(ids: Iterable<number>): void {
  restorable.clear();
  for (const id of ids) restorable.add(id);
}

export function setPrivateLeaves(ids: Iterable<number>): void {
  privateLeaves.clear();
  for (const id of ids) privateLeaves.add(id);
}

export async function loadRestoredSnapshot(
  leafId: number,
): Promise<RestoredSnapshot | null> {
  if (!restorable.has(leafId)) return null;
  restorable.delete(leafId);
  try {
    const raw = await invoke<string | null>("session_snapshot_load", {
      leafId,
    });
    return raw ? decodeSnapshot(raw) : null;
  } catch (e) {
    console.warn("[termul] snapshot load failed:", e);
    return null;
  }
}

const inFlight = new Set<Promise<unknown>>();

export function persistSnapshot(leafId: number, out: SerializeOutput): void {
  if (privateLeaves.has(leafId)) return;
  // An alt-screen frame (vim, htop) is a dead TUI after restore — keep the
  // previous file instead of replacing it with garbage.
  if (out.altScreen || !out.snapshot) return;
  const data = encodeSnapshot(out);
  const p: Promise<unknown> = invoke("session_snapshot_save", { leafId, data })
    .catch((e) => console.warn("[termul] snapshot save failed:", e))
    .finally(() => inFlight.delete(p));
  inFlight.add(p);
}

type PendingCapture = {
  firstAt: number;
  lastAt: number;
  timer: ReturnType<typeof setTimeout>;
  serialize: () => SerializeOutput | null;
};

// One self-rearming timer per leaf, refreshed by timestamp instead of
// clearTimeout/setTimeout per chunk — PTY data arrives every ~4ms during
// sustained output and per-chunk timer churn is exactly the idle-wakeup
// pattern the perf audit removed.
const pendingCaptures = new Map<number, PendingCapture>();

export function armSnapshotDebounce(
  leafId: number,
  serialize: () => SerializeOutput | null,
): void {
  if (privateLeaves.has(leafId)) return;
  const now = performance.now();
  const pending = pendingCaptures.get(leafId);
  if (pending) {
    pending.lastAt = now;
    pending.serialize = serialize;
    return;
  }
  pendingCaptures.set(leafId, {
    firstAt: now,
    lastAt: now,
    serialize,
    timer: setTimeout(() => captureIfQuiet(leafId), TRAIL_MS),
  });
}

function captureIfQuiet(leafId: number): void {
  const pending = pendingCaptures.get(leafId);
  if (!pending) return;
  const now = performance.now();
  const quietFor = now - pending.lastAt;
  if (quietFor >= TRAIL_MS || now - pending.firstAt >= MAX_WAIT_MS) {
    pendingCaptures.delete(leafId);
    const out = pending.serialize();
    if (out) persistSnapshot(leafId, out);
    return;
  }
  pending.timer = setTimeout(() => captureIfQuiet(leafId), TRAIL_MS - quietFor);
}

export function cancelSnapshotDebounce(leafId: number): void {
  const pending = pendingCaptures.get(leafId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingCaptures.delete(leafId);
}

/** Capture every pane with a pending debounce now and wait for all writes to
 * land. Called from the window-close handler; panes whose debounce already
 * fired (or that hibernated) are on disk already. */
export async function flushAllSnapshots(): Promise<void> {
  for (const [leafId, pending] of [...pendingCaptures]) {
    clearTimeout(pending.timer);
    pendingCaptures.delete(leafId);
    const out = pending.serialize();
    if (out) persistSnapshot(leafId, out);
  }
  await Promise.all([...inFlight]);
}

export function pruneSessionSnapshots(keep: Iterable<number>): void {
  void invoke("session_snapshots_prune", { keep: [...keep] }).catch((e) =>
    console.warn("[termul] snapshot prune failed:", e),
  );
}
