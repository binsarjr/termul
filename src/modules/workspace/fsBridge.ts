//! Provider-agnostic filesystem dispatch. Every UI surface that reads or writes
//! a file (explorer tree, editor, markdown preview, image/PDF viewers, the AI
//! tools) goes through these wrappers instead of calling `fs_*` directly. A
//! path that carries the `ssh://host` scheme routes to the isolated, async
//! `ssh_*` commands (which run off the main thread so the network round-trip
//! never freezes the UI); every other path keeps its exact previous behavior —
//! the local `fs_*` command tagged with `currentWorkspaceEnv()`.
//!
//! Keeping this the single dispatch point means a remote tab and a local tab
//! can coexist: correctness comes from the path, not a global mode flag.

import { invoke } from "@tauri-apps/api/core";
import { currentWorkspaceEnv } from "./env";
import { type RemoteRef, isRemotePath, parseRemoteUri } from "./remotePath";

export type DirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
};

export type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

/// Parsed remote ref for a remote path, or null for a genuine local path.
/// Throws on a malformed `ssh://` URI so a bad path can never silently fall
/// through to the local provider.
function providerOf(path: string): RemoteRef | null {
  const ref = parseRemoteUri(path);
  if (ref) return ref;
  if (isRemotePath(path)) {
    throw new Error(`malformed remote path: ${path}`);
  }
  return null;
}

export async function readDir(
  path: string,
  showHidden: boolean,
): Promise<DirEntry[]> {
  const r = providerOf(path);
  return r
    ? invoke<DirEntry[]>("ssh_read_dir", {
        host: r.host,
        path: r.path,
        showHidden,
      })
    : invoke<DirEntry[]>("fs_read_dir", {
        path,
        showHidden,
        workspace: currentWorkspaceEnv(),
      });
}

export async function readFile(path: string): Promise<ReadResult> {
  const r = providerOf(path);
  return r
    ? invoke<ReadResult>("ssh_read_file", { host: r.host, path: r.path })
    : invoke<ReadResult>("fs_read_file", {
        path,
        workspace: currentWorkspaceEnv(),
      });
}

export async function readBytes(path: string): Promise<ArrayBuffer> {
  const r = providerOf(path);
  return r
    ? invoke<ArrayBuffer>("ssh_read_bytes", { host: r.host, path: r.path })
    : invoke<ArrayBuffer>("fs_read_bytes", {
        path,
        workspace: currentWorkspaceEnv(),
      });
}

export async function writeFile(
  path: string,
  content: string,
  source?: string,
): Promise<void> {
  const r = providerOf(path);
  return r
    ? invoke<void>("ssh_write_file", {
        host: r.host,
        path: r.path,
        content,
        source,
      })
    : invoke<void>("fs_write_file", {
        path,
        content,
        source,
        workspace: currentWorkspaceEnv(),
      });
}

export async function canonicalize(path: string): Promise<string> {
  const r = providerOf(path);
  return r
    ? invoke<string>("ssh_canonicalize", { host: r.host, path: r.path })
    : invoke<string>("fs_canonicalize", {
        path,
        workspace: currentWorkspaceEnv(),
      });
}

export async function createFile(path: string): Promise<void> {
  const r = providerOf(path);
  return r
    ? invoke<void>("ssh_create_file", { host: r.host, path: r.path })
    : invoke<void>("fs_create_file", { path, workspace: currentWorkspaceEnv() });
}

export async function createDir(path: string): Promise<void> {
  const r = providerOf(path);
  return r
    ? invoke<void>("ssh_create_dir", { host: r.host, path: r.path })
    : invoke<void>("fs_create_dir", { path, workspace: currentWorkspaceEnv() });
}

export async function rename(from: string, to: string): Promise<void> {
  const a = providerOf(from);
  const b = providerOf(to);
  if (a || b) {
    // A rename is a single remote op — both ends must live on the same host.
    if (!a || !b || a.host !== b.host) {
      throw new Error("cannot rename across hosts");
    }
    return invoke<void>("ssh_rename", { host: a.host, from: a.path, to: b.path });
  }
  return invoke<void>("fs_rename", {
    from,
    to,
    workspace: currentWorkspaceEnv(),
  });
}

export async function remove(path: string): Promise<void> {
  const r = providerOf(path);
  return r
    ? invoke<void>("ssh_delete", { host: r.host, path: r.path })
    : invoke<void>("fs_delete", { path, workspace: currentWorkspaceEnv() });
}
