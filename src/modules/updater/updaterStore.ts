import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check as checkUpdate, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { IS_LINUX } from "@/lib/platform";

const LAST_CHECK_KEY = "termul:updater:last-check";
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const GITHUB_LATEST_RELEASE =
  "https://api.github.com/repos/binsarjr/termul/releases/latest";

export interface ManualUpdateInfo {
  version: string;
  currentVersion: string;
  body: string;
  releaseUrl: string;
}

export type UpdaterStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "available"; update: Update }
  | { kind: "manual-available"; info: ManualUpdateInfo }
  | { kind: "downloading"; downloaded: number; contentLength: number | null }
  | { kind: "ready" }
  | { kind: "error"; message: string };

function parseVersion(v: string): number[] {
  return v
    .replace(/^v/, "")
    .split("-")[0]
    .split(".")
    .map((p) => Number.parseInt(p, 10) || 0);
}

function isNewer(remote: string, current: string): boolean {
  const a = parseVersion(remote);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

async function checkLinuxRelease(): Promise<ManualUpdateInfo | null> {
  const [current, res] = await Promise.all([
    getVersion(),
    fetch(GITHUB_LATEST_RELEASE, {
      headers: { Accept: "application/vnd.github+json" },
    }),
  ]);
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}`);
  }
  const data = (await res.json()) as {
    tag_name: string;
    body?: string;
    html_url: string;
  };
  const remote = data.tag_name.replace(/^v/, "");
  if (!isNewer(remote, current)) return null;
  return {
    version: remote,
    currentVersion: current,
    body: data.body ?? "",
    releaseUrl: data.html_url,
  };
}

interface CheckOptions {
  /** Skip the time-based throttle (for explicit user-initiated checks). */
  manual?: boolean;
}

interface UpdaterState {
  status: UpdaterStatus;
  /** Whether the update dialog is currently shown. Decoupled from `status` so
   * dismissing the dialog keeps the "update available" state (and the header
   * indicator) alive until the user restarts or a fresh check supersedes it. */
  dialogOpen: boolean;
  check: (opts?: CheckOptions) => Promise<void>;
  /** Download + stage the update. Does NOT relaunch — that waits for an
   * explicit `restart()` so the user can decline closing their tabs. */
  install: () => Promise<void>;
  /** Relaunch into the staged update (closes all windows/tabs). */
  restart: () => Promise<void>;
  openDialog: () => void;
  closeDialog: () => void;
}

/** Single shared updater state so the header indicator and the dialog never run
 * two independent checks or disagree on status. */
export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  status: { kind: "idle" },
  dialogOpen: false,

  check: async ({ manual = false } = {}) => {
    const cur = get().status.kind;
    // Never interrupt an in-flight download/check, and don't re-check away an
    // update we've already surfaced (unless the user asked explicitly).
    if (cur === "checking" || cur === "downloading") return;
    if (
      !manual &&
      (cur === "available" || cur === "manual-available" || cur === "ready")
    ) {
      return;
    }
    if (!manual) {
      const last = Number(localStorage.getItem(LAST_CHECK_KEY) ?? 0);
      if (Date.now() - last < CHECK_INTERVAL_MS) return;
    }
    set({ status: { kind: "checking" } });
    try {
      if (IS_LINUX) {
        const info = await checkLinuxRelease();
        if (info) {
          set({ status: { kind: "manual-available", info }, dialogOpen: true });
        } else {
          localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
          set({ status: { kind: "uptodate" } });
        }
        return;
      }
      const update = await checkUpdate();
      if (update) {
        set({ status: { kind: "available", update }, dialogOpen: true });
      } else {
        localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
        set({ status: { kind: "uptodate" } });
      }
    } catch (err) {
      set({ status: { kind: "error", message: String(err) } });
    }
  },

  install: async () => {
    const s = get().status;
    if (s.kind !== "available") return;
    const { update } = s;
    let total: number | null = null;
    let downloaded = 0;
    set({
      status: { kind: "downloading", downloaded: 0, contentLength: null },
      dialogOpen: true,
    });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? null;
          set({
            status: { kind: "downloading", downloaded: 0, contentLength: total },
          });
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          set({
            status: { kind: "downloading", downloaded, contentLength: total },
          });
        } else if (event.event === "Finished") {
          // Staged, but wait for an explicit restart so the user can keep
          // their tabs open and restart on their own terms.
          set({ status: { kind: "ready" }, dialogOpen: true });
        }
      });
    } catch (err) {
      set({ status: { kind: "error", message: String(err) } });
    }
  },

  restart: async () => {
    try {
      await relaunch();
    } catch (err) {
      set({ status: { kind: "error", message: String(err) } });
    }
  },

  openDialog: () => set({ dialogOpen: true }),
  closeDialog: () => set({ dialogOpen: false }),
}));
