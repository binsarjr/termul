import { useCallback, useEffect, useRef, useState } from "react";
import {
  findLeafCwd,
  hasLeaf,
  leafIds,
  nextLeafId,
  removeLeaf,
  setLeafCwd as setLeafCwdInTree,
  siblingLeafOf,
  splitLeaf,
  type PaneNode,
  type SplitDir,
} from "@/modules/terminal/lib/panes";
import { disposeSession } from "@/modules/terminal/lib/useTerminalSession";
import type { SettingsSection } from "@/modules/settings/openSettings";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  assignTabToGroup as assignTabToGroupPure,
  detachTabFromGroup,
  nextGroupColor,
  visibleTabs,
  type GroupColorId,
  type TabGroup,
  type TabGroupMap,
} from "./groups";

export type TerminalTab = {
  id: number;
  kind: "terminal";
  title: string;
  cwd?: string;
  /**
   * Remote (SSH) working directory of the active pane, when the shell has
   * roamed onto another host via OSC 7. Display-only: it drives the tab label
   * and a status-bar pill, but never the local file explorer (which stays at
   * the last local `cwd`). Cleared when the shell returns to a local cwd.
   */
  remoteCwd?: string;
  /**
   * Host of an in-progress local `ssh <host>` command, detected from the OSC
   * 133 C command line (independent of {@link remoteCwd}, which only fires when
   * the remote shell itself emits OSC 7). Set while the ssh session runs and
   * cleared when it ends. Display-only: drives the tab label and the status-bar
   * pill when no `remoteCwd` is known. When both are set, `remoteCwd` (the more
   * specific path) wins for display.
   */
  sshHost?: string;
  paneTree: PaneNode;
  activeLeafId: number;
  /** AI agent cannot read buffer / context of this terminal. */
  private?: boolean;
  /**
   * Keep this terminal's full output on disk (spill) so hibernation never drops
   * scrollback, without holding it in RAM. Off by default; toggled from the tab
   * context menu. Applies to every pane (leaf) in the tab; not persisted.
   */
  spillToDisk?: boolean;
  /**
   * User-pinned name. When set it overrides the dynamic cwd-based label
   * (see `labelFor`); cleared (empty rename) reverts to the dynamic name.
   */
  customTitle?: string;
};

export type EditorTab = {
  id: number;
  kind: "editor";
  title: string;
  path: string;
  dirty: boolean;
  /**
   * True while the tab is in the transient "preview" state — opened by a
   * single-click in the explorer and not yet pinned by the user. A preview tab
   * is replaced by the next single-click rather than accumulating.
   */
  preview: boolean;
};

export type MarkdownTab = {
  id: number;
  kind: "markdown";
  title: string;
  path: string;
};

export type PdfTab = {
  id: number;
  kind: "pdf";
  title: string;
  path: string;
};

export type ImageTab = {
  id: number;
  kind: "image";
  title: string;
  path: string;
};

export type AiDiffStatus = "pending" | "approved" | "rejected";

export type AiDiffTab = {
  id: number;
  kind: "ai-diff";
  title: string;
  path: string;
  /** "" for newly created files. */
  originalContent: string;
  proposedContent: string;
  /** Tool-call approval id used to resolve the AI SDK approval. */
  approvalId: string;
  status: AiDiffStatus;
  isNewFile: boolean;
};

export type GitDiffTab = {
  id: number;
  kind: "git-diff";
  title: string;
  path: string;
  repoRoot: string;
  mode: "-" | "+";
  originalPath: string | null;
};

export type GitHistoryTab = {
  id: number;
  kind: "git-history";
  title: string;
  repoRoot: string;
};

export type GitCommitFileDiffTab = {
  id: number;
  kind: "git-commit-file";
  title: string;
  repoRoot: string;
  sha: string;
  shortSha: string;
  subject: string;
  path: string;
  originalPath: string | null;
};

export type SettingsTab = {
  id: number;
  kind: "settings";
  title: string;
  section: SettingsSection;
};

export type Tab =
  | TerminalTab
  | EditorTab
  | MarkdownTab
  | PdfTab
  | ImageTab
  | AiDiffTab
  | GitDiffTab
  | GitHistoryTab
  | GitCommitFileDiffTab
  | SettingsTab;

export type TabPatch = Partial<{
  title: string;
  cwd: string;
  path: string;
  dirty: boolean;
  /** Terminal tabs only. Empty/whitespace clears it (reverts to dynamic name). */
  customTitle: string;
}>;

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

/** Returns a new array with the element at `from` moved to index `to`.
 * No-op (returns the original array) when indices are equal or out of range. */
export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (from === to) return arr;
  if (from < 0 || from >= arr.length || to < 0 || to >= arr.length) return arr;
  const next = arr.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function useTabs(initial?: Partial<TerminalTab>) {
  const [tabs, setTabs] = useState<Tab[]>(() => {
    const tabId = 1;
    const leafId = 2;
    return [
      {
        id: tabId,
        kind: "terminal",
        title: initial?.title ?? "shell",
        cwd: initial?.cwd,
        paneTree: { kind: "leaf", id: leafId, cwd: initial?.cwd },
        activeLeafId: leafId,
      },
    ];
  });
  const [activeId, setActiveId] = useState(1);
  const nextIdRef = useRef(3);
  const tabsRef = useRef(tabs);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  // Live per-tab pane cap from preferences, mirrored to a ref so the stable
  // splitActivePane callback reads the current value without re-creating.
  const maxPanesPerTab = usePreferencesStore((s) => s.maxPanesPerTab);
  const maxPanesPerTabRef = useRef(maxPanesPerTab);
  useEffect(() => {
    maxPanesPerTabRef.current = maxPanesPerTab;
  }, [maxPanesPerTab]);

  // Tab groups: lightweight metadata + a tabId->groupId map kept beside `tabs`
  // (the Tab union is untouched). Refs mirror them so actions that reorder on
  // assignment can read current values synchronously, like `tabsRef`.
  const [groups, setGroups] = useState<TabGroup[]>([]);
  const [tabGroupOf, setTabGroupOf] = useState<TabGroupMap>({});
  const groupsRef = useRef(groups);
  const tabGroupOfRef = useRef(tabGroupOf);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);
  useEffect(() => {
    tabGroupOfRef.current = tabGroupOf;
  }, [tabGroupOf]);

  const newTab = useCallback((cwd?: string) => {
    const tabId = nextIdRef.current++;
    const leafId = nextIdRef.current++;
    setTabs((t) => [
      ...t,
      {
        id: tabId,
        kind: "terminal",
        title: "shell",
        cwd,
        paneTree: { kind: "leaf", id: leafId, cwd },
        activeLeafId: leafId,
      },
    ]);
    setActiveId(tabId);
    return tabId;
  }, []);

  const newAgentTab = useCallback(
    (cwd: string | undefined, title: string) => {
      const tabId = nextIdRef.current++;
      const leafId = nextIdRef.current++;
      setTabs((t) => [
        ...t,
        {
          id: tabId,
          kind: "terminal",
          title,
          cwd,
          paneTree: { kind: "leaf", id: leafId, cwd },
          activeLeafId: leafId,
        },
      ]);
      setActiveId(tabId);
      return { tabId, leafId };
    },
    [],
  );

  const newPrivateTab = useCallback((cwd?: string) => {
    const tabId = nextIdRef.current++;
    const leafId = nextIdRef.current++;
    setTabs((t) => [
      ...t,
      {
        id: tabId,
        kind: "terminal",
        title: "private",
        cwd,
        paneTree: { kind: "leaf", id: leafId, cwd },
        activeLeafId: leafId,
        private: true,
      },
    ]);
    setActiveId(tabId);
    return tabId;
  }, []);

  /**
   * Opens a file in an editor tab.
   *
   * - `pin = true` (default) — opens or activates a **persistent** tab.
   *   If the path is currently in the preview slot it is promoted in-place.
   *   Use this for programmatic opens (AI diff, New File dialog, etc.).
   * - `pin = false` — VSCode-style **preview** tab. A single shared slot is
   *   reused: if a persistent tab for the path already exists it is activated;
   *   otherwise the current preview slot is replaced with the new path.
   */
  const openFileTab = useCallback((path: string, pin = true) => {
    let targetId: number | null = null;
    setTabs((curr) => {
      if (pin) {
        // Persistent open: find any existing editor tab, pin it if needed.
        const existing = curr.find(
          (t) => t.kind === "editor" && t.path === path,
        );
        if (existing) {
          targetId = existing.id;
          if ((existing as EditorTab).preview) {
            return curr.map((t) =>
              t.id === existing.id ? { ...t, preview: false } : t,
            );
          }
          return curr;
        }
        const id = nextIdRef.current++;
        targetId = id;
        return [
          ...curr,
          {
            id,
            kind: "editor",
            title: basename(path),
            path,
            dirty: false,
            preview: false,
          } satisfies EditorTab,
        ];
      } else {
        // Preview open: persistent tab for this path takes priority.
        const persistent = curr.find(
          (t) =>
            t.kind === "editor" && t.path === path && !(t as EditorTab).preview,
        );
        if (persistent) {
          targetId = persistent.id;
          return curr;
        }
        // Reuse the slot if it already shows the same path.
        const existingPreview = curr.find(
          (t) =>
            t.kind === "editor" && t.path === path && (t as EditorTab).preview,
        );
        if (existingPreview) {
          targetId = existingPreview.id;
          return curr;
        }
        // Replace the current preview slot, or append a new one.
        const previewIdx = curr.findIndex(
          (t) => t.kind === "editor" && (t as EditorTab).preview,
        );
        const id = nextIdRef.current++;
        targetId = id;
        const tab: EditorTab = {
          id,
          kind: "editor",
          title: basename(path),
          path,
          dirty: false,
          preview: true,
        };
        if (previewIdx === -1) return [...curr, tab];
        const next = [...curr];
        next[previewIdx] = tab;
        return next;
      }
    });
    if (targetId !== null) setActiveId(targetId);
    return targetId as number | null;
  }, []);

  /**
   * Promotes a preview tab to a persistent one. Called on double-click of the
   * tab title in the tab bar. Dirty edits also auto-promote (see `updateTab`).
   */
  const pinTab = useCallback((id: number) => {
    setTabs((curr) =>
      curr.map((t) =>
        t.id === id && t.kind === "editor" ? { ...t, preview: false } : t,
      ),
    );
  }, []);

  const openAiDiffTab = useCallback(
    (input: {
      path: string;
      originalContent: string;
      proposedContent: string;
      approvalId: string;
      isNewFile: boolean;
    }) => {
      let targetId: number | null = null;
      setTabs((curr) => {
        const existing = curr.find(
          (t) => t.kind === "ai-diff" && t.approvalId === input.approvalId,
        );
        if (existing) {
          targetId = existing.id;
          return curr;
        }
        const id = nextIdRef.current++;
        targetId = id;
        const title = `${basename(input.path)} (AI diff)`;
        return [
          ...curr,
          {
            id,
            kind: "ai-diff",
            title,
            path: input.path,
            originalContent: input.originalContent,
            proposedContent: input.proposedContent,
            approvalId: input.approvalId,
            status: "pending",
            isNewFile: input.isNewFile,
          },
        ];
      });
      if (targetId !== null) setActiveId(targetId);
      return targetId as number | null;
    },
    [],
  );

  const setAiDiffStatus = useCallback(
    (approvalId: string, status: AiDiffStatus) => {
      setTabs((curr) =>
        curr.map((t) =>
          t.kind === "ai-diff" && t.approvalId === approvalId
            ? { ...t, status }
            : t,
        ),
      );
    },
    [],
  );

  const closeAiDiffTab = useCallback((approvalId: string) => {
    setTabs((curr) => {
      const target = curr.find(
        (t) => t.kind === "ai-diff" && t.approvalId === approvalId,
      );
      if (!target || curr.length <= 1) {
        if (!target) return curr;
        return curr.map((t) =>
          t.kind === "ai-diff" && t.approvalId === approvalId
            ? { ...t, status: "approved" as AiDiffStatus }
            : t,
        );
      }
      const idx = curr.findIndex((t) => t.id === target.id);
      const next = curr.filter((t) => t.id !== target.id);
      setActiveId((active) =>
        target.id === active ? next[Math.max(0, idx - 1)].id : active,
      );
      return next;
    });
  }, []);

  const newMarkdownTab = useCallback((path: string) => {
    let targetId: number | null = null;
    setTabs((curr) => {
      const existing = curr.find(
        (t) => t.kind === "markdown" && t.path === path,
      );
      if (existing) {
        targetId = existing.id;
        return curr;
      }
      const id = nextIdRef.current++;
      targetId = id;
      return [...curr, { id, kind: "markdown", title: basename(path), path }];
    });
    if (targetId !== null) setActiveId(targetId);
    return targetId;
  }, []);

  const newPdfTab = useCallback((path: string) => {
    let targetId: number | null = null;
    setTabs((curr) => {
      const existing = curr.find((t) => t.kind === "pdf" && t.path === path);
      if (existing) {
        targetId = existing.id;
        return curr;
      }
      const id = nextIdRef.current++;
      targetId = id;
      return [...curr, { id, kind: "pdf", title: basename(path), path }];
    });
    if (targetId !== null) setActiveId(targetId);
    return targetId;
  }, []);

  const newImageTab = useCallback((path: string) => {
    let targetId: number | null = null;
    setTabs((curr) => {
      const existing = curr.find((t) => t.kind === "image" && t.path === path);
      if (existing) {
        targetId = existing.id;
        return curr;
      }
      const id = nextIdRef.current++;
      targetId = id;
      return [...curr, { id, kind: "image", title: basename(path), path }];
    });
    if (targetId !== null) setActiveId(targetId);
    return targetId;
  }, []);

  const openGitDiffTab = useCallback(
    (input: {
      path: string;
      repoRoot: string;
      mode: "-" | "+";
      originalPath?: string | null;
      title?: string;
    }) => {
      const curr = tabsRef.current;
      const existing = curr.find(
        (t) =>
          t.kind === "git-diff" &&
          t.repoRoot === input.repoRoot &&
          t.path === input.path &&
          t.mode === input.mode,
      );
      const computedTitle =
        input.title ?? `${basename(input.path)} (${input.mode})`;
      const originalPath = input.originalPath ?? null;

      if (existing) {
        const nextTabs = curr.map((t) =>
          t.id === existing.id
            ? { ...t, title: computedTitle, originalPath }
            : t,
        );
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        setActiveId(existing.id);
        return existing.id;
      }

      const id = nextIdRef.current++;
      const nextTabs = [
        ...curr,
        {
          id,
          kind: "git-diff",
          title: computedTitle,
          path: input.path,
          repoRoot: input.repoRoot,
          mode: input.mode,
          originalPath,
        } satisfies GitDiffTab,
      ];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActiveId(id);
      return id;
    },
    [],
  );

  const openCommitHistoryTab = useCallback(
    (input: { repoRoot: string; branch?: string | null }) => {
      const curr = tabsRef.current;
      const existing = curr.find(
        (t) => t.kind === "git-history" && t.repoRoot === input.repoRoot,
      );
      const title = input.branch
        ? `History · ${input.branch}`
        : "Git History";
      if (existing) {
        const nextTabs = curr.map((t) =>
          t.id === existing.id ? { ...t, title } : t,
        );
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        setActiveId(existing.id);
        return existing.id;
      }
      const id = nextIdRef.current++;
      const nextTabs = [
        ...curr,
        {
          id,
          kind: "git-history",
          title,
          repoRoot: input.repoRoot,
        } satisfies GitHistoryTab,
      ];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActiveId(id);
      return id;
    },
    [],
  );

  const openCommitFileDiffTab = useCallback(
    (input: {
      repoRoot: string;
      sha: string;
      shortSha: string;
      subject: string;
      path: string;
      originalPath: string | null;
    }) => {
      const curr = tabsRef.current;
      const existing = curr.find(
        (t) =>
          t.kind === "git-commit-file" &&
          t.repoRoot === input.repoRoot &&
          t.sha === input.sha &&
          t.path === input.path,
      );
      const title = `${basename(input.path)} @ ${input.shortSha}`;
      if (existing) {
        const nextTabs = curr.map((t) =>
          t.id === existing.id
            ? {
                ...t,
                title,
                subject: input.subject,
                originalPath: input.originalPath,
              }
            : t,
        );
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        setActiveId(existing.id);
        return existing.id;
      }
      const id = nextIdRef.current++;
      const nextTabs = [
        ...curr,
        {
          id,
          kind: "git-commit-file",
          title,
          repoRoot: input.repoRoot,
          sha: input.sha,
          shortSha: input.shortSha,
          subject: input.subject,
          path: input.path,
          originalPath: input.originalPath,
        } satisfies GitCommitFileDiffTab,
      ];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActiveId(id);
      return id;
    },
    [],
  );

  // Singleton: focus the existing Settings tab (re-pointing its section when a
  // section is requested) or create it. Modeled on openCommitHistoryTab.
  const openSettingsTab = useCallback((section?: SettingsSection) => {
    const curr = tabsRef.current;
    const existing = curr.find(
      (t): t is SettingsTab => t.kind === "settings",
    );
    if (existing) {
      if (section && section !== existing.section) {
        const nextTabs = curr.map((t) =>
          t.id === existing.id ? { ...t, section } : t,
        );
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
      }
      setActiveId(existing.id);
      return existing.id;
    }
    const id = nextIdRef.current++;
    const nextTabs = [
      ...curr,
      {
        id,
        kind: "settings",
        title: "Settings",
        section: section ?? "general",
      } satisfies SettingsTab,
    ];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    setActiveId(id);
    return id;
  }, []);

  const setSettingsSection = useCallback((section: SettingsSection) => {
    setTabs((curr) => {
      const target = curr.find(
        (t): t is SettingsTab => t.kind === "settings",
      );
      if (!target || target.section === section) return curr;
      const next = curr.map((t) =>
        t.kind === "settings" ? { ...t, section } : t,
      );
      tabsRef.current = next;
      return next;
    });
  }, []);

  const closeTab = useCallback((id: number) => {
    if (tabsRef.current.length <= 1) return;
    let toDispose: number[] = [];
    setTabs((curr) => {
      if (curr.length <= 1) return curr;
      const idx = curr.findIndex((t) => t.id === id);
      const target = curr[idx];
      if (target && target.kind === "terminal") {
        toDispose = leafIds(target.paneTree);
      }
      const next = curr.filter((t) => t.id !== id);
      setActiveId((active) =>
        id === active ? next[Math.max(0, idx - 1)].id : active,
      );
      return next;
    });
    // Drop the closed tab from its group, deleting the group if it emptied.
    const { groupOf, emptiedGroupId } = detachTabFromGroup(
      tabsRef.current,
      tabGroupOfRef.current,
      id,
    );
    if (groupOf !== tabGroupOfRef.current) {
      tabGroupOfRef.current = groupOf;
      setTabGroupOf(groupOf);
      if (emptiedGroupId != null) {
        setGroups((gs) => gs.filter((g) => g.id !== emptiedGroupId));
      }
    }
    for (const lid of toDispose) disposeSession(lid);
  }, []);

  const updateTab = useCallback((id: number, patch: TabPatch) => {
    setTabs((t) =>
      t.map((x) => {
        if (x.id !== id) return x;
        if (x.kind === "terminal") {
          return {
            ...x,
            ...(patch.title !== undefined && { title: patch.title }),
            ...(patch.cwd !== undefined && { cwd: patch.cwd }),
            ...(patch.customTitle !== undefined && {
              customTitle: patch.customTitle.trim() || undefined,
            }),
          };
        }
        if (x.kind === "markdown" || x.kind === "pdf" || x.kind === "image") {
          return {
            ...x,
            ...(patch.title !== undefined && { title: patch.title }),
          };
        }
        // editor tab: auto-promote from preview the moment the file becomes dirty.
        const autoPin =
          patch.dirty === true && (x as EditorTab).preview
            ? { preview: false }
            : {};
        return {
          ...x,
          ...autoPin,
          ...(patch.title !== undefined && { title: patch.title }),
          ...(patch.dirty !== undefined && { dirty: patch.dirty }),
          ...(patch.path !== undefined && { path: patch.path }),
        };
      }),
    );
  }, []);

  const selectByIndex = useCallback(
    (idx: number) => {
      // Index into the visible list so digit shortcuts skip tabs hidden inside
      // a collapsed group.
      const t = visibleTabs(tabs, groups, tabGroupOf)[idx];
      if (t) setActiveId(t.id);
    },
    [tabs, groups, tabGroupOf],
  );

  // Auto-expand a collapsed group when one of its members becomes active (via
  // the command palette, a programmatic open, etc.). Keyed on `activeId` only,
  // so deliberately collapsing the active tab's own group is respected — the
  // expand fires only when navigation moves *into* a collapsed group.
  useEffect(() => {
    const gid = tabGroupOfRef.current[activeId];
    if (gid == null) return;
    const g = groupsRef.current.find((x) => x.id === gid);
    if (g?.collapsed) {
      setGroups((gs) =>
        gs.map((x) => (x.id === gid ? { ...x, collapsed: false } : x)),
      );
    }
  }, [activeId]);

  /** Update a leaf's cwd; mirror to the tab's `cwd` when the leaf is active.
   * Bails out without setTabs when nothing actually changed — shell integration
   * re-emits OSC 7 on every prompt, including empty Enters, so this fires at
   * keystroke rate. Always-setTabs there cascades a paneTree re-render across
   * every open tab. */
  const setLeafCwd = useCallback((leafId: number, cwd: string) => {
    setTabs((curr) => {
      let changed = false;
      const next = curr.map((t) => {
        if (t.kind !== "terminal" || !hasLeaf(t.paneTree, leafId)) return t;
        const paneTree = setLeafCwdInTree(t.paneTree, leafId, cwd);
        const isActive = t.activeLeafId === leafId;
        const cwdChanged = isActive && t.cwd !== cwd;
        if (paneTree === t.paneTree && !cwdChanged) return t;
        changed = true;
        return { ...t, paneTree, ...(cwdChanged && { cwd }) };
      });
      return changed ? next : curr;
    });
  }, []);

  /** Reflect the active pane's remote (SSH) cwd on its tab. Display-only — the
   * explorer keeps using `cwd` (the last local dir). Passing null/"" clears it
   * (shell returned home). Same keystroke-rate guard as setLeafCwd: bail when
   * nothing changed, and only the active leaf drives the tab. */
  const setRemoteCwd = useCallback(
    (leafId: number, remoteCwd: string | null) => {
      const nextRemote = remoteCwd || undefined;
      setTabs((curr) => {
        let changed = false;
        const next = curr.map((t) => {
          if (
            t.kind !== "terminal" ||
            t.activeLeafId !== leafId ||
            !hasLeaf(t.paneTree, leafId)
          )
            return t;
          if (t.remoteCwd === nextRemote) return t;
          changed = true;
          return { ...t, remoteCwd: nextRemote };
        });
        return changed ? next : curr;
      });
    },
    [],
  );

  /** Reflect a detected `ssh <host>` session on the active pane's tab. Set when
   * the local ssh command starts (OSC 133 C) and cleared (null) when it ends
   * (OSC 133 D). Display-only and independent of {@link setRemoteCwd}. Same
   * keystroke-rate guard: bail when nothing changed; only the active leaf
   * drives the tab. Stored as undefined when cleared so tab objects stay clean. */
  const setSshHost = useCallback((leafId: number, host: string | null) => {
    const nextHost = host || undefined;
    setTabs((curr) => {
      let changed = false;
      const next = curr.map((t) => {
        if (
          t.kind !== "terminal" ||
          t.activeLeafId !== leafId ||
          !hasLeaf(t.paneTree, leafId)
        )
          return t;
        if (t.sshHost === nextHost) return t;
        changed = true;
        return { ...t, sshHost: nextHost };
      });
      return changed ? next : curr;
    });
  }, []);

  /** Toggle a terminal tab's "keep full output to disk" spill. Applies to every
   * pane in the tab; the sessions pick it up via a prop-driven effect. Stored
   * as undefined when off so tab objects stay clean. */
  const setTabSpillToDisk = useCallback((tabId: number, value: boolean) => {
    setTabs((curr) =>
      curr.map((t) =>
        t.id === tabId &&
        t.kind === "terminal" &&
        (t.spillToDisk ?? false) !== value
          ? { ...t, spillToDisk: value || undefined }
          : t,
      ),
    );
  }, []);

  const focusPane = useCallback((tabId: number, leafId: number) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.id !== tabId || t.kind !== "terminal") return t;
        if (!hasLeaf(t.paneTree, leafId)) return t;
        if (t.activeLeafId === leafId) return t;
        const cwd = findLeafCwd(t.paneTree, leafId);
        return {
          ...t,
          activeLeafId: leafId,
          ...(cwd !== undefined && { cwd }),
        };
      }),
    );
  }, []);

  const focusNextPaneInTab = useCallback((tabId: number, delta: 1 | -1) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.id !== tabId || t.kind !== "terminal") return t;
        const next = nextLeafId(t.paneTree, t.activeLeafId, delta);
        if (next === t.activeLeafId) return t;
        const cwd = findLeafCwd(t.paneTree, next);
        return { ...t, activeLeafId: next, ...(cwd !== undefined && { cwd }) };
      }),
    );
  }, []);

  /** Split the active leaf of `tabId` along `dir`. Returns the new leaf id. */
  const splitActivePane = useCallback(
    (tabId: number, dir: SplitDir): number | null => {
      let newLeafId: number | null = null;
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "terminal") return t;
          if (leafIds(t.paneTree).length >= maxPanesPerTabRef.current) return t;
          const splitId = nextIdRef.current++;
          const leafId = nextIdRef.current++;
          newLeafId = leafId;
          const paneTree = splitLeaf(
            t.paneTree,
            t.activeLeafId,
            splitId,
            leafId,
            dir,
            t.cwd,
          );
          return { ...t, paneTree, activeLeafId: leafId };
        }),
      );
      return newLeafId;
    },
    [],
  );

  const closePaneByLeaf = useCallback((leafId: number): void => {
    let didRemove = false;
    setTabs((curr) => {
      const tab = curr.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
      );
      if (!tab || tab.kind !== "terminal") return curr;
      const newTree = removeLeaf(tab.paneTree, leafId);
      if (newTree === null) {
        if (curr.length <= 1) return curr;
        const idx = curr.findIndex((x) => x.id === tab.id);
        const next = curr.filter((x) => x.id !== tab.id);
        setActiveId((active) =>
          active === tab.id ? next[Math.max(0, idx - 1)].id : active,
        );
        didRemove = true;
        return next;
      }
      const remaining = leafIds(newTree);
      let newActive = tab.activeLeafId;
      if (tab.activeLeafId === leafId) {
        const sib = siblingLeafOf(tab.paneTree, leafId);
        newActive = sib && remaining.includes(sib) ? sib : remaining[0];
      }
      didRemove = true;
      return curr.map((x) =>
        x.id === tab.id
          ? { ...x, paneTree: newTree, activeLeafId: newActive }
          : x,
      );
    });
    if (didRemove) disposeSession(leafId);
  }, []);

  const closeActivePane = useCallback((tabId: number): boolean => {
    let closedTab = false;
    let removedLeaf: number | null = null;
    setTabs((curr) => {
      const t = curr.find((x) => x.id === tabId);
      if (!t || t.kind !== "terminal") return curr;
      const target = t.activeLeafId;
      const newTree = removeLeaf(t.paneTree, target);
      if (newTree === null) {
        if (curr.length <= 1) return curr;
        const idx = curr.findIndex((x) => x.id === tabId);
        const next = curr.filter((x) => x.id !== tabId);
        setActiveId((active) =>
          active === tabId ? next[Math.max(0, idx - 1)].id : active,
        );
        closedTab = true;
        removedLeaf = target;
        return next;
      }
      const remaining = leafIds(newTree);
      const sib = siblingLeafOf(t.paneTree, target);
      const newActive =
        sib && remaining.includes(sib) ? sib : remaining[0];
      removedLeaf = target;
      return curr.map((x) =>
        x.id === tabId
          ? { ...x, paneTree: newTree, activeLeafId: newActive }
          : x,
      );
    });
    if (removedLeaf !== null) disposeSession(removedLeaf);
    return closedTab;
  }, []);

  /** Reorder `draggedId` to sit before/after `targetId`. Order-only change:
   * `activeId` is keyed by id, so the active tab is preserved. */
  const reorderTab = useCallback(
    (draggedId: number, targetId: number, place: "before" | "after") => {
      if (draggedId === targetId) return;
      setTabs((curr) => {
        const from = curr.findIndex((t) => t.id === draggedId);
        const targetIdx = curr.findIndex((t) => t.id === targetId);
        if (from === -1 || targetIdx === -1) return curr;
        let to = place === "after" ? targetIdx + 1 : targetIdx;
        // Removing the dragged tab first shifts every later index down by one.
        if (from < to) to -= 1;
        return moveItem(curr, from, to);
      });
    },
    [],
  );

  // --- Tab groups ------------------------------------------------------------

  /** Create a one-member group around `tabId`, cleaning up any group it leaves
   * empty. Returns the new group id. */
  const createGroupFromTab = useCallback((tabId: number, name?: string) => {
    const groupId = nextIdRef.current++;
    const prevGid = tabGroupOfRef.current[tabId];
    setGroups((gs) => {
      let next = gs;
      if (prevGid != null) {
        const stillUsed = tabsRef.current.some(
          (t) => t.id !== tabId && tabGroupOfRef.current[t.id] === prevGid,
        );
        if (!stillUsed) next = next.filter((g) => g.id !== prevGid);
      }
      return [
        ...next,
        {
          id: groupId,
          name: name?.trim() || `Group ${next.length + 1}`,
          color: nextGroupColor(next),
          collapsed: false,
        },
      ];
    });
    const nextMap = { ...tabGroupOfRef.current, [tabId]: groupId };
    tabGroupOfRef.current = nextMap;
    setTabGroupOf(nextMap);
    return groupId;
  }, []);

  /** Add a tab to an existing group, moving it adjacent to keep the run contiguous. */
  const assignTabToGroup = useCallback((tabId: number, groupId: number) => {
    const res = assignTabToGroupPure(
      tabsRef.current,
      tabGroupOfRef.current,
      tabId,
      groupId,
    );
    tabsRef.current = res.tabs;
    tabGroupOfRef.current = res.groupOf;
    setTabs(res.tabs);
    setTabGroupOf(res.groupOf);
  }, []);

  const removeTabFromGroup = useCallback((tabId: number) => {
    const { groupOf, emptiedGroupId } = detachTabFromGroup(
      tabsRef.current,
      tabGroupOfRef.current,
      tabId,
    );
    if (groupOf === tabGroupOfRef.current) return;
    tabGroupOfRef.current = groupOf;
    setTabGroupOf(groupOf);
    if (emptiedGroupId != null) {
      setGroups((gs) => gs.filter((g) => g.id !== emptiedGroupId));
    }
  }, []);

  const renameGroup = useCallback((groupId: number, name: string) => {
    setGroups((gs) =>
      gs.map((g) =>
        g.id === groupId ? { ...g, name: name.trim() || g.name } : g,
      ),
    );
  }, []);

  const recolorGroup = useCallback((groupId: number, color: GroupColorId) => {
    setGroups((gs) =>
      gs.map((g) => (g.id === groupId ? { ...g, color } : g)),
    );
  }, []);

  const toggleGroupCollapsed = useCallback((groupId: number) => {
    setGroups((gs) =>
      gs.map((g) =>
        g.id === groupId ? { ...g, collapsed: !g.collapsed } : g,
      ),
    );
  }, []);

  /** Dissolve a group, keeping its member tabs (just ungrouped). */
  const ungroup = useCallback((groupId: number) => {
    setTabGroupOf((m) => {
      const next: TabGroupMap = {};
      for (const key of Object.keys(m)) {
        const tid = Number(key);
        if (m[tid] !== groupId) next[tid] = m[tid];
      }
      tabGroupOfRef.current = next;
      return next;
    });
    setGroups((gs) => gs.filter((g) => g.id !== groupId));
  }, []);

  const resetWorkspace = useCallback((cwd?: string) => {
    const tabId = nextIdRef.current++;
    const leafId = nextIdRef.current++;
    let toDispose: number[] = [];
    setTabs((curr) => {
      toDispose = curr.flatMap((t) =>
        t.kind === "terminal" ? leafIds(t.paneTree) : [],
      );
      return [
        {
          id: tabId,
          kind: "terminal",
          title: "shell",
          cwd,
          paneTree: { kind: "leaf", id: leafId, cwd },
          activeLeafId: leafId,
        },
      ];
    });
    setActiveId(tabId);
    tabGroupOfRef.current = {};
    groupsRef.current = [];
    setTabGroupOf({});
    setGroups([]);
    for (const lid of toDispose) disposeSession(lid);
  }, []);

  return {
    tabs,
    activeId,
    setActiveId,
    newTab,
    newAgentTab,
    newPrivateTab,
    openFileTab,
    pinTab,
    newMarkdownTab,
    newPdfTab,
    newImageTab,
    openAiDiffTab,
    openGitDiffTab,
    openCommitHistoryTab,
    openCommitFileDiffTab,
    openSettingsTab,
    setSettingsSection,
    setAiDiffStatus,
    closeAiDiffTab,
    closeTab,
    updateTab,
    selectByIndex,
    setLeafCwd,
    setRemoteCwd,
    setSshHost,
    setTabSpillToDisk,
    focusPane,
    focusNextPaneInTab,
    splitActivePane,
    closeActivePane,
    closePaneByLeaf,
    reorderTab,
    resetWorkspace,
    groups,
    tabGroupOf,
    createGroupFromTab,
    assignTabToGroup,
    removeTabFromGroup,
    renameGroup,
    recolorGroup,
    toggleGroupCollapsed,
    ungroup,
  };
}
