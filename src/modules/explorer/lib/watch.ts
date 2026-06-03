import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentWorkspaceEnv, parseRemoteUri } from "@/modules/workspace";

const FS_CHANGED_EVENT = "fs:changed";

type FsChangedPayload = { paths: string[] };

/// Split a watch batch into the local paths and the remote paths grouped by
/// host, so each provider's watch command gets exactly the paths it owns.
function byProvider(paths: string[]): {
  local: string[];
  remote: Map<string, string[]>;
} {
  const local: string[] = [];
  const remote = new Map<string, string[]>();
  for (const p of paths) {
    const r = parseRemoteUri(p);
    if (!r) {
      local.push(p);
      continue;
    }
    const group = remote.get(r.host);
    if (group) group.push(r.path);
    else remote.set(r.host, [r.path]);
  }
  return { local, remote };
}

export function watchAdd(paths: string[]): void {
  if (paths.length === 0) return;
  const { local, remote } = byProvider(paths);
  if (local.length > 0) {
    void invoke("fs_watch_add", {
      paths: local,
      workspace: currentWorkspaceEnv(),
    }).catch(() => {});
  }
  for (const [host, hostPaths] of remote) {
    void invoke("ssh_watch_add", { host, paths: hostPaths }).catch(() => {});
  }
}

export function watchRemove(paths: string[]): void {
  if (paths.length === 0) return;
  const { local, remote } = byProvider(paths);
  if (local.length > 0) {
    void invoke("fs_watch_remove", {
      paths: local,
      workspace: currentWorkspaceEnv(),
    }).catch(() => {});
  }
  for (const [host, hostPaths] of remote) {
    void invoke("ssh_watch_remove", { host, paths: hostPaths }).catch(() => {});
  }
}

export function listenFsChanged(
  handler: (paths: string[]) => void,
): Promise<() => void> {
  return getCurrentWebviewWindow().listen<FsChangedPayload>(
    FS_CHANGED_EVENT,
    (e) => handler(e.payload.paths),
  );
}

export function parentDir(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i <= 0) return path.slice(0, i + 1) || path;
  return path.slice(0, i);
}
