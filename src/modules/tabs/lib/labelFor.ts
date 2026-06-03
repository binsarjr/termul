import { parseRemoteUri, type RemoteRef } from "@/modules/workspace";
import type { Tab } from "./useTabs";

/**
 * The remote (SSH) identity of a file-backed tab whose path is an `ssh://host`
 * URI — editor / markdown / pdf / image opened from a remote explorer — else
 * null. Lets the TabBar badge the tab with its host so a remote `notes.txt` is
 * distinguishable from a local one of the same name.
 */
export function remoteIdentity(t: Tab): RemoteRef | null {
  if (
    t.kind === "editor" ||
    t.kind === "markdown" ||
    t.kind === "pdf" ||
    t.kind === "image"
  ) {
    return parseRemoteUri(t.path);
  }
  return null;
}

/**
 * The remote SSH host a tab belongs to, for the explorer's auto-follow: a
 * terminal's detected `sshHost`, or the host of a remote (`ssh://`) file tab —
 * so opening a remote file keeps the explorer rooted on that host instead of
 * snapping back to the local tree. Null for local tabs.
 */
export function remoteHostOf(t: Tab): string | null {
  if (t.kind === "terminal") return t.sshHost ?? null;
  return remoteIdentity(t)?.host ?? null;
}

/**
 * Display label for a tab. Terminal tabs show their user-pinned `customTitle`
 * when set; otherwise the dynamic basename of their cwd — the remote (SSH) cwd
 * when the shell has roamed onto another host, else the local cwd (falling back
 * to the stored title). Clearing the custom title reverts to the dynamic name.
 */
export function labelFor(t: Tab): string {
  if (t.kind === "editor") return t.title;
  if (t.kind === "markdown") return t.title;
  if (t.kind === "pdf") return t.title;
  if (t.kind === "image") return t.title;
  if (t.kind === "ai-diff") return t.title;
  if (t.kind === "git-diff") return t.title;
  if (t.kind === "git-history") return t.title;
  if (t.kind === "git-commit-file") return t.title;
  if (t.kind === "settings") return t.title;
  // terminal: a user-pinned name wins over the dynamic cwd-based label.
  if (t.customTitle) return t.customTitle;
  // A detected `ssh <host>` session with no remote cwd shows the bare host, so
  // the tab visibly changes the moment the user connects.
  if (t.sshHost && !t.remoteCwd) return t.sshHost;
  const path = t.remoteCwd ?? t.cwd;
  if (!path) return t.title;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "/";
}
