import { getVersion } from "@tauri-apps/api/app";
import { create } from "zustand";
import { releaseNotesFor } from "./changelog";

const LAST_SEEN_KEY = "termul:whats-new:last-seen-version";

type WhatsNewState = {
  open: boolean;
  version: string;
  notes: string;
  /** Show this version's notes once, the first launch after an update. */
  checkOnLaunch: () => Promise<void>;
  dismiss: () => void;
};

function readLastSeen(): string | null {
  try {
    return window.localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    return null;
  }
}

function writeLastSeen(version: string): void {
  try {
    window.localStorage.setItem(LAST_SEEN_KEY, version);
  } catch {
    // ignore
  }
}

export const useWhatsNewStore = create<WhatsNewState>((set, get) => ({
  open: false,
  version: "",
  notes: "",
  checkOnLaunch: async () => {
    if (get().open) return;
    let current: string;
    try {
      current = await getVersion();
    } catch {
      return;
    }
    if (readLastSeen() === current) return;

    const notes = releaseNotesFor(current);
    if (!notes) {
      // Nothing to show for this version; record it so launches stay quiet.
      writeLastSeen(current);
      return;
    }
    set({ open: true, version: current, notes });
  },
  dismiss: () => {
    const { version } = get();
    if (version) writeLastSeen(version);
    set({ open: false });
  },
}));
