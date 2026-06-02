import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

/** Mirror of the Rust `ShellHistory` payload. `entries` are most-recent-first
 * and de-duplicated. */
export type ShellHistory = {
  shell: string;
  path: string | null;
  entries: string[];
};

type HistoryState = {
  shell: string;
  path: string | null;
  /** Commands most-recent-first, de-duplicated. */
  entries: string[];
  loaded: boolean;
  loading: boolean;
  /** Read the platform shell-history file. Cached after the first load; pass
   * `force` to re-read (e.g. after the user clears it elsewhere). */
  load: (force?: boolean) => Promise<void>;
  /** Promote a just-run command to the front of the in-memory list so it's
   * suggestable immediately, without waiting for the shell to flush it to disk.
   * In-memory only — the shell owns the file. */
  addRecent: (command: string) => void;
  /** Remove one command from both the in-memory list and the real history
   * file. Optimistic; re-syncs from disk if the backend write fails. */
  removeEntry: (command: string) => Promise<void>;
  /** Truncate the real shell-history file. Optimistic. */
  clearAll: () => Promise<void>;
};

export const useHistoryStore = create<HistoryState>((set, get) => ({
  shell: "unknown",
  path: null,
  entries: [],
  loaded: false,
  loading: false,

  load: async (force = false) => {
    const s = get();
    if (s.loading || (s.loaded && !force)) return;
    set({ loading: true });
    try {
      const res = await invoke<ShellHistory>("read_shell_history", {
        limit: null,
      });
      set({
        shell: res.shell,
        path: res.path,
        entries: res.entries,
        loaded: true,
        loading: false,
      });
    } catch (e) {
      // Mark loaded so the UI shows an empty state rather than a stuck spinner.
      set({ loading: false, loaded: true });
      console.warn("[its-just-terminal] read_shell_history failed:", e);
    }
  },

  addRecent: (command) => {
    const cmd = command.trim();
    if (!cmd) return;
    set((s) => {
      if (s.entries[0] === cmd) return s;
      return { entries: [cmd, ...s.entries.filter((c) => c !== cmd)] };
    });
  },

  removeEntry: async (command) => {
    set((s) => ({ entries: s.entries.filter((c) => c !== command) }));
    try {
      await invoke("delete_shell_history_entry", { command });
    } catch (e) {
      console.warn("[its-just-terminal] delete_shell_history_entry failed:", e);
      await get().load(true);
    }
  },

  clearAll: async () => {
    set({ entries: [] });
    try {
      await invoke("clear_shell_history");
    } catch (e) {
      console.warn("[its-just-terminal] clear_shell_history failed:", e);
      await get().load(true);
    }
  },
}));
