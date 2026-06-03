import { useEffect, useRef, useState } from "react";
import { native, type GitStatusSnapshot } from "@/modules/ai/lib/native";
import { isRemotePath } from "@/modules/workspace";
import {
  fileStatusCode,
  moreProminentStatus,
} from "@/modules/source-control/statusDecoration";
import { listenFsChanged } from "./watch";

export type GitDecorations = {
  /** Absolute forward-slash path -> canonical status code (U/M/A/D/R). */
  fileCode: Map<string, string>;
  /** Ancestor directory (abs, forward-slash) -> most prominent child status. */
  dirCode: Map<string, string>;
};

const EMPTY: GitDecorations = { fileCode: new Map(), dirCode: new Map() };
const REFRESH_DEBOUNCE_MS = 250;

function normalize(path: string): string {
  return path.replace(/\\/g, "/");
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "" : path.slice(0, i);
}

/**
 * Map a git status snapshot to explorer decorations. Git paths are relative to
 * the repo root; the explorer keys entries by absolute forward-slash path, so we
 * join them and roll changes up into every ancestor directory inside the tree.
 */
export function buildGitDecorations(
  status: GitStatusSnapshot | null,
  rootPath: string,
): GitDecorations {
  if (!status) return EMPTY;
  const root = normalize(rootPath);
  const repoRoot = normalize(status.repoRoot);
  const fileCode = new Map<string, string>();
  const dirCode = new Map<string, string>();

  const underRoot = (p: string) => p === root || p.startsWith(`${root}/`);

  for (const file of status.changedFiles) {
    const abs = normalize(`${repoRoot}/${file.path}`);
    if (!underRoot(abs)) continue;
    const code = fileStatusCode(file);
    fileCode.set(abs, code);

    let dir = parentOf(abs);
    while (dir && underRoot(dir)) {
      const prev = dirCode.get(dir);
      dirCode.set(dir, prev ? moreProminentStatus(code, prev) : code);
      if (dir === root) break;
      dir = parentOf(dir);
    }
  }

  return { fileCode, dirCode };
}

/**
 * Resolve the explorer root's repo once, then keep git decorations fresh on
 * working-tree changes. The always-on source control summary only refreshes on
 * window focus, which is too slow for the explorer to reflect a save/stage; this
 * debounces a lightweight git_status against the resolved repo root instead.
 */
export function useExplorerGitStatus(rootPath: string | null): GitDecorations {
  const [decorations, setDecorations] = useState<GitDecorations>(EMPTY);
  const repoRootRef = useRef<string | null>(null);

  useEffect(() => {
    // No local git for a remote (SSH) root — skip resolution entirely so we
    // don't fire a failing git_panel_snapshot on every remote tree refresh.
    if (!rootPath || isRemotePath(rootPath)) {
      repoRootRef.current = null;
      setDecorations(EMPTY);
      return;
    }

    let alive = true;
    let timer = 0;
    repoRootRef.current = null;

    const fetchNow = async () => {
      try {
        let status: GitStatusSnapshot | null;
        if (repoRootRef.current) {
          status = await native.gitStatus(repoRootRef.current);
        } else {
          const snapshot = await native.gitPanelSnapshot(rootPath);
          repoRootRef.current =
            snapshot.status?.repoRoot ?? snapshot.repo?.repoRoot ?? null;
          status = snapshot.status ?? null;
        }
        if (!alive) return;
        setDecorations(buildGitDecorations(status, rootPath));
      } catch {
        // Repo may have been removed or the path went away; re-resolve next tick.
        repoRootRef.current = null;
        if (alive) setDecorations(EMPTY);
      }
    };

    void fetchNow();

    let unlisten: (() => void) | undefined;
    void listenFsChanged(() => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = 0;
        void fetchNow();
      }, REFRESH_DEBOUNCE_MS);
    }).then((un) => {
      if (alive) unlisten = un;
      else un();
    });

    const onFocus = () => void fetchNow();
    window.addEventListener("focus", onFocus);

    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
      unlisten?.();
      window.removeEventListener("focus", onFocus);
    };
  }, [rootPath]);

  return decorations;
}
