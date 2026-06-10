import { invoke } from "@tauri-apps/api/core";

type LaunchInfo = {
  launchDir: string | null;
  workspaceDir: string | null;
};

let cached: string | undefined;

export async function initLaunchDir(): Promise<void> {
  const info = await invoke<LaunchInfo>("get_launch_info").catch(() => null);
  const dir = info?.launchDir ?? info?.workspaceDir;
  cached = dir ? dir.replace(/\\/g, "/") : undefined;
}

export function getLaunchDir(): string | undefined {
  return cached;
}
