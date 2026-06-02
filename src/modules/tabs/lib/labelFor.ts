import type { Tab } from "./useTabs";

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
  const path = t.remoteCwd ?? t.cwd;
  if (!path) return t.title;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "/";
}
