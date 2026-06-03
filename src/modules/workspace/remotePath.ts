//! Scheme helpers for the remote (SSH) file provider.
//!
//! A remote file's identity is the URI `ssh://<host><abs-path>` — `host` is
//! whatever the user types after `ssh` in a terminal (a `~/.ssh/config` alias,
//! `user@host`, an IP, …) and the path is always absolute (leading `/`).
//! Carrying the provider *inside the path* (rather than reading a global
//! "current workspace") is what lets a remote editor tab save back to the right
//! host even after the explorer has followed a different tab to somewhere else.
//!
//! These helpers are pure (no Tauri, no I/O) so they stay unit-testable; the
//! command dispatch that consumes them lives in `fsBridge.ts`.

export const REMOTE_SCHEME = "ssh://";

export type RemoteRef = { host: string; path: string };

export function isRemotePath(path: string): boolean {
  return path.startsWith(REMOTE_SCHEME);
}

/// Split `ssh://host/abs/path` into `{ host, path: "/abs/path" }`. The host is
/// the run between the scheme and the first `/`; the remainder (including that
/// slash) is the absolute remote path. Returns null for a non-remote or
/// malformed URI so callers can fall back to the local provider or surface a
/// clear error rather than silently mishandling it.
export function parseRemoteUri(uri: string): RemoteRef | null {
  if (!isRemotePath(uri)) return null;
  const rest = uri.slice(REMOTE_SCHEME.length);
  const slash = rest.indexOf("/");
  // Need a non-empty host AND an absolute path after it.
  if (slash <= 0) return null;
  const host = rest.slice(0, slash);
  const path = rest.slice(slash);
  if (!host || !path.startsWith("/")) return null;
  return { host, path };
}

export function makeRemoteUri(host: string, path: string): string {
  return `${REMOTE_SCHEME}${host}${path}`;
}
