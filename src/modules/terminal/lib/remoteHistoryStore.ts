import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { ShellHistory } from "./historyStore";

type HostHistory = {
  /** Commands most-recent-first, de-duplicated. */
  entries: string[];
  loaded: boolean;
  loading: boolean;
};

type RemoteHistoryState = {
  /** Per-host history, keyed by the full `[user@]host` connection target. */
  byHost: Record<string, HostHistory>;
  /** Fetch a host's remote shell history once (deduped per host). Cheap to call
   * repeatedly — short-circuits while loading or after the first load. */
  ensure: (host: string) => void;
  /** A host's cached entries, or [] when nothing is loaded yet. */
  entriesFor: (host: string) => string[];
  /** Promote a just-run remote command to the front so it's suggestable before
   * the remote shell flushes it to its history file. In-memory only. */
  addRecent: (host: string, command: string) => void;
};

/**
 * Remote shell history for inline autocomplete, keyed by SSH host. When a
 * terminal is SSHed into a host, the autocomplete reads that host's
 * `~/.zsh_history` / `~/.bash_history` (via `ssh_read_history`) instead of the
 * local Mac history, so suggestions reflect the shell the user is actually in.
 * Cached per host for the session; a parallel store to the local
 * {@link useHistoryStore} so the two never cross-contaminate.
 */
export const useRemoteHistoryStore = create<RemoteHistoryState>((set, get) => ({
  byHost: {},

  ensure: (host) => {
    const cur = get().byHost[host];
    if (cur?.loaded || cur?.loading) return;
    set((s) => ({
      byHost: {
        ...s.byHost,
        [host]: { entries: cur?.entries ?? [], loaded: false, loading: true },
      },
    }));
    invoke<ShellHistory>("ssh_read_history", { host })
      .then((res) => {
        set((s) => {
          // Keep any in-session commands typed before the read resolved at the
          // front, then the freshly-read remote history (deduped).
          const prev = s.byHost[host]?.entries ?? [];
          const fresh = new Set(res.entries);
          const merged = [...prev.filter((c) => !fresh.has(c)), ...res.entries];
          return {
            byHost: {
              ...s.byHost,
              [host]: { entries: merged, loaded: true, loading: false },
            },
          };
        });
      })
      .catch((e) => {
        set((s) => ({
          byHost: {
            ...s.byHost,
            [host]: {
              entries: s.byHost[host]?.entries ?? [],
              loaded: true,
              loading: false,
            },
          },
        }));
        console.warn("[its-just-terminal] ssh_read_history failed:", e);
      });
  },

  entriesFor: (host) => get().byHost[host]?.entries ?? [],

  addRecent: (host, command) => {
    const cmd = command.trim();
    if (!cmd) return;
    set((s) => {
      const cur = s.byHost[host] ?? {
        entries: [],
        loaded: false,
        loading: false,
      };
      if (cur.entries[0] === cmd) return s;
      return {
        byHost: {
          ...s.byHost,
          [host]: {
            ...cur,
            entries: [cmd, ...cur.entries.filter((c) => c !== cmd)],
          },
        },
      };
    });
  },
}));
