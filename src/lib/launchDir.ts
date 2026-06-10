import { invoke } from "@tauri-apps/api/core";

type LaunchInfo = {
  launchDir: string | null;
  workspaceDir: string | null;
};

let cached: string | undefined;
let explicit: string | undefined;

export async function initLaunchDir(): Promise<void> {
  const info = await invoke<LaunchInfo>("get_launch_info").catch(() => null);
  const dir = info?.launchDir ?? info?.workspaceDir;
  cached = dir ? dir.replace(/\\/g, "/") : undefined;
  explicit = info?.launchDir ? info.launchDir.replace(/\\/g, "/") : undefined;
}

export function getLaunchDir(): string | undefined {
  return cached;
}

/** The directory the user explicitly launched Termul with (CLI arg), if any.
 * Unlike {@link getLaunchDir} this has no workspace/home fallback, so it only
 * fires when the user expressed intent — session restore uses it to decide
 * whether to append a fresh tab at that directory. */
export function getExplicitLaunchDir(): string | undefined {
  return explicit;
}
