import { useEffect } from "react";
import { useUpdaterStore } from "./updaterStore";

export type { ManualUpdateInfo, UpdaterStatus } from "./updaterStore";

interface HookOptions {
  /** When false, the hook does not run an automatic check on mount. */
  autoCheck?: boolean;
}

/** Thin view over the shared {@link useUpdaterStore}. Multiple mounts are safe —
 * they share one status and the on-mount check is throttled/deduped in the
 * store, so the header indicator, dialog, and About page never diverge. */
export function useUpdater({ autoCheck = true }: HookOptions = {}) {
  const status = useUpdaterStore((s) => s.status);
  const check = useUpdaterStore((s) => s.check);
  const install = useUpdaterStore((s) => s.install);
  const restart = useUpdaterStore((s) => s.restart);
  const closeDialog = useUpdaterStore((s) => s.closeDialog);

  useEffect(() => {
    if (!autoCheck) return;
    void check();
  }, [autoCheck, check]);

  return { status, check, install, restart, dismiss: closeDialog };
}
