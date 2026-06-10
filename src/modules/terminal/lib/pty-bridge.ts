import { invoke, Channel } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "@/modules/workspace";

export type PtyHandlers = {
  onData: (bytes: Uint8Array) => void;
  onExit?: (code: number) => void;
};

export type PtySession = {
  id: number;
  write: (data: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  close: () => Promise<void>;
  /** Toggle the per-tab "keep full output" disk spill for this session. When
   * enabling, `seed` (a serialized snapshot) primes the file with current
   * scrollback so pre-enable history isn't lost on the first wake. */
  setSpill: (enabled: boolean, seed?: string) => Promise<void>;
  /** While dormant (hibernated), Rust parks output in a bounded in-process
   * tail ring instead of shipping every chunk over IPC; waking splices the
   * buffered tail back into the data channel ahead of newer output. */
  setDormant: (dormant: boolean) => Promise<void>;
  /** Read back the spilled transcript tail (raw bytes) to replay on wake. */
  readSpill: () => Promise<ArrayBuffer>;
};

export async function openPty(
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  cwd?: string,
): Promise<PtySession> {
  // Raw bytes — no base64/JSON round-trip; messages arrive as ArrayBuffer.
  const onData = new Channel<ArrayBuffer>();
  const onExit = new Channel<number>();

  let released = false;
  const noop = () => {};
  const releaseHandlers = () => {
    if (released) return;
    released = true;
    onData.onmessage = noop;
    onExit.onmessage = noop;
  };

  onData.onmessage = (buf) => handlers.onData(new Uint8Array(buf));
  onExit.onmessage = (code) => {
    handlers.onExit?.(code);
    releaseHandlers();
  };

  const id = await invoke<number>("pty_open", {
    cols,
    rows,
    cwd: cwd ?? null,
    workspace: currentWorkspaceEnv(),
    onData,
    onExit,
  });

  let closed = false;

  return {
    id,
    write: (data) => invoke("pty_write", { id, data }),
    resize: (c, r) => invoke("pty_resize", { id, cols: c, rows: r }),
    setSpill: (enabled, seed) =>
      invoke("pty_set_spill", { id, enabled, seed: seed ?? null }),
    setDormant: (dormant) => invoke("pty_set_dormant", { id, dormant }),
    readSpill: () => invoke<ArrayBuffer>("pty_read_spill", { id }),
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await invoke("pty_close", { id });
      } finally {
        releaseHandlers();
      }
    },
  };
}
