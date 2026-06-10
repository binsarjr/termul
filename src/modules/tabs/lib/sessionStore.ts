import { invoke } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { readRestoreSessionPref } from "@/modules/settings/store";
import { leafIds, type PaneNode } from "@/modules/terminal/lib/panes";
import {
  pruneSessionSnapshots,
  setPrivateLeaves,
  setRestorableLeaves,
} from "@/modules/terminal/lib/sessionSnapshots";
import type { TabGroup, TabGroupMap } from "./groups";
import type { Tab, TerminalTab } from "./useTabs";

/**
 * Session persistence: the open-tab structure (tabs, split-pane trees, groups,
 * active tab, per-pane cwds) saved across app restarts so a relaunch reopens
 * where the user left off. Scrollback snapshots are persisted separately
 * (per-leaf files via the snapshots backend); this store holds structure only,
 * so the JSON stays small enough to read pre-render.
 */

const SESSION_KEY = "session";
const SESSION_VERSION = 1;

const store = new LazyStore("termul-session.json", {
  defaults: {},
  autoSave: 200,
});

export type SessionSnapshot = {
  tabs: Tab[];
  activeId: number;
  groups: TabGroup[];
  tabGroupOf: TabGroupMap;
};

type PersistedSession = SessionSnapshot & { version: typeof SESSION_VERSION };

export type BootState = SessionSnapshot & { nextId: number };

/** Tab kinds that survive a restart. ai-diff (one-shot approval), git-diff /
 * git-commit-file (stale against a moving repo) and settings (singleton)
 * are intentionally transient. */
function persistTab(tab: Tab): Tab | null {
  switch (tab.kind) {
    case "terminal":
      return {
        id: tab.id,
        kind: "terminal",
        title: tab.title,
        cwd: tab.cwd,
        paneTree: tab.paneTree,
        activeLeafId: tab.activeLeafId,
        private: tab.private,
        customTitle: tab.customTitle,
      };
    case "editor":
      // Preview tabs are transient by definition; dirty buffers can't be
      // recovered, so a restored editor tab always reloads clean from disk.
      if (tab.preview) return null;
      return {
        id: tab.id,
        kind: "editor",
        title: tab.title,
        path: tab.path,
        dirty: false,
        preview: false,
      };
    case "markdown":
    case "pdf":
    case "image":
      return { id: tab.id, kind: tab.kind, title: tab.title, path: tab.path };
    case "git-history":
      return {
        id: tab.id,
        kind: "git-history",
        title: tab.title,
        repoRoot: tab.repoRoot,
      };
    default:
      return null;
  }
}

export function sanitizeForSave(snapshot: SessionSnapshot): PersistedSession {
  const tabs = snapshot.tabs
    .map(persistTab)
    .filter((t): t is Tab => t !== null);
  const kept = new Set(tabs.map((t) => t.id));
  const tabGroupOf: TabGroupMap = {};
  for (const [tabId, groupId] of Object.entries(snapshot.tabGroupOf)) {
    if (kept.has(Number(tabId))) tabGroupOf[Number(tabId)] = groupId;
  }
  const usedGroups = new Set(Object.values(tabGroupOf));
  const groups = snapshot.groups.filter((g) => usedGroups.has(g.id));
  const activeId = kept.has(snapshot.activeId)
    ? snapshot.activeId
    : (tabs[0]?.id ?? 1);
  return { version: SESSION_VERSION, tabs, activeId, groups, tabGroupOf };
}

function terminalLeafIds(tabs: Tab[], onlyPrivate = false): number[] {
  return tabs
    .filter(
      (t): t is TerminalTab =>
        t.kind === "terminal" && (!onlyPrivate || t.private === true),
    )
    .flatMap((t) => leafIds(t.paneTree));
}

// Keep the scrollback side in sync with the structure: private panes must
// never hit disk, and snapshot files of closed panes get pruned — but only
// when the pane set actually changed (title/cwd updates fire saves at prompt
// rate; re-pruning for those is pointless IPC).
let lastLeafKey = "";
function syncSnapshotLeaves(tabs: Tab[]): void {
  setPrivateLeaves(terminalLeafIds(tabs, true));
  const ids = terminalLeafIds(tabs);
  const key = ids.join(",");
  if (key === lastLeafKey) return;
  lastLeafKey = key;
  pruneSessionSnapshots(ids);
}

// Trailing throttle: the first change arms one timer; the latest snapshot wins
// when it fires. Bounded latency without per-keystroke IPC — the store's
// autoSave batches the actual disk write on top.
const SAVE_DELAY_MS = 250;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave: SessionSnapshot | null = null;

export function saveSession(snapshot: SessionSnapshot): void {
  pendingSave = snapshot;
  if (saveTimer !== null) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const snap = pendingSave;
    pendingSave = null;
    if (snap) {
      void store.set(SESSION_KEY, sanitizeForSave(snap));
      syncSnapshotLeaves(snap.tabs);
    }
  }, SAVE_DELAY_MS);
}

/** Write any pending snapshot immediately and flush the store to disk.
 * Used by the window-close handler. */
export async function flushSessionSave(): Promise<void> {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const snap = pendingSave;
  pendingSave = null;
  if (snap) await store.set(SESSION_KEY, sanitizeForSave(snap));
  await store.save();
}

export async function clearSession(): Promise<void> {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  pendingSave = null;
  await store.delete(SESSION_KEY);
  await store.save();
  // Turning restore off is a privacy choice — drop the scrollback files too.
  lastLeafKey = "";
  pruneSessionSnapshots([]);
}

function isPaneNode(n: unknown): n is PaneNode {
  if (typeof n !== "object" || n === null) return false;
  const node = n as Record<string, unknown>;
  if (typeof node.id !== "number") return false;
  if (node.kind === "leaf") {
    return node.cwd === undefined || typeof node.cwd === "string";
  }
  if (node.kind === "split") {
    return (
      (node.dir === "row" || node.dir === "col") &&
      Array.isArray(node.children) &&
      node.children.length > 0 &&
      node.children.every(isPaneNode)
    );
  }
  return false;
}

function isValidTab(t: unknown): t is Tab {
  if (typeof t !== "object" || t === null) return false;
  const tab = t as Record<string, unknown>;
  if (typeof tab.id !== "number" || typeof tab.title !== "string") return false;
  switch (tab.kind) {
    case "terminal":
      return (
        isPaneNode(tab.paneTree) &&
        typeof tab.activeLeafId === "number" &&
        leafIds(tab.paneTree as PaneNode).includes(tab.activeLeafId as number)
      );
    case "editor":
    case "markdown":
    case "pdf":
    case "image":
      return typeof tab.path === "string";
    case "git-history":
      return typeof tab.repoRoot === "string";
    default:
      return false;
  }
}

/** Structural validation of a stored payload. Anything off (corrupt file,
 * future schema, empty session) degrades to "no session" — never a crash. */
export function validateSession(raw: unknown): PersistedSession | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  if (s.version !== SESSION_VERSION) return null;
  if (!Array.isArray(s.tabs) || !s.tabs.every(isValidTab)) return null;
  const tabs = s.tabs as Tab[];
  if (tabs.length === 0) return null;
  const ids = new Set(tabs.map((t) => t.id));
  if (ids.size !== tabs.length) return null;
  if (typeof s.activeId !== "number") return null;
  const groups = Array.isArray(s.groups)
    ? (s.groups as TabGroup[]).filter(
        (g) =>
          typeof g === "object" &&
          g !== null &&
          typeof g.id === "number" &&
          typeof g.name === "string",
      )
    : [];
  const tabGroupOf: TabGroupMap = {};
  if (typeof s.tabGroupOf === "object" && s.tabGroupOf !== null) {
    const groupIds = new Set(groups.map((g) => g.id));
    for (const [tabId, groupId] of Object.entries(s.tabGroupOf)) {
      if (ids.has(Number(tabId)) && typeof groupId === "number" && groupIds.has(groupId)) {
        tabGroupOf[Number(tabId)] = groupId;
      }
    }
  }
  return {
    version: SESSION_VERSION,
    tabs,
    activeId: ids.has(s.activeId) ? s.activeId : tabs[0].id,
    groups,
    tabGroupOf,
  };
}

const CHECK_TIMEOUT_MS = 300;

function timeoutAs(value: boolean): Promise<boolean> {
  return new Promise((resolve) =>
    setTimeout(() => resolve(value), CHECK_TIMEOUT_MS),
  );
}

function stripCwds(tree: PaneNode, dead: Set<string>): PaneNode {
  if (tree.kind === "leaf") {
    return tree.cwd !== undefined && dead.has(tree.cwd)
      ? { ...tree, cwd: undefined }
      : tree;
  }
  return { ...tree, children: tree.children.map((c) => stripCwds(c, dead)) };
}

/**
 * Validate the session against the live filesystem before hydration:
 * - `workspace_authorize` every unique terminal cwd. The backend registry is
 *   rebuilt each process and `pty_open` errors out (dead pane, no shell) for
 *   unauthorized or deleted cwds — stripping a failed cwd instead lets the
 *   shell fall back to the launch dir/home.
 * - `fs_stat` every path-backed tab; drop tabs whose file vanished. A slow
 *   check (network mount) keeps the tab — the viewer surfaces its own error.
 */
async function reviveSession(
  session: PersistedSession,
): Promise<PersistedSession> {
  const cwds = new Set<string>();
  const paths = new Map<number, string>();
  const collectCwds = (n: PaneNode): void => {
    if (n.kind === "leaf") {
      if (n.cwd) cwds.add(n.cwd);
    } else n.children.forEach(collectCwds);
  };
  for (const tab of session.tabs) {
    if (tab.kind === "terminal") {
      if (tab.cwd) cwds.add(tab.cwd);
      collectCwds(tab.paneTree);
    } else if (tab.kind === "git-history") {
      paths.set(tab.id, tab.repoRoot);
    } else if (
      tab.kind === "editor" ||
      tab.kind === "markdown" ||
      tab.kind === "pdf" ||
      tab.kind === "image"
    ) {
      paths.set(tab.id, tab.path);
    }
  }

  const workspace = currentWorkspaceEnv();
  const cwdList = [...cwds];
  const pathList = [...paths.entries()];
  const [cwdOk, pathOk] = await Promise.all([
    Promise.all(
      cwdList.map((path) =>
        // Timeout counts as dead: an unauthorized cwd means a dead pane,
        // a stripped one just falls back to home.
        Promise.race([
          invoke<string>("workspace_authorize", { path, workspace }).then(
            () => true,
            () => false,
          ),
          timeoutAs(false),
        ]),
      ),
    ),
    Promise.all(
      pathList.map(([, path]) =>
        Promise.race([
          invoke("fs_stat", { path }).then(
            () => true,
            () => false,
          ),
          timeoutAs(true),
        ]),
      ),
    ),
  ]);

  const deadCwds = new Set(cwdList.filter((_, i) => !cwdOk[i]));
  const deadTabs = new Set(
    pathList.filter((_, i) => !pathOk[i]).map(([id]) => id),
  );

  const tabs = session.tabs
    .filter((t) => !deadTabs.has(t.id))
    .map((t) => {
      if (t.kind !== "terminal" || deadCwds.size === 0) return t;
      const next: TerminalTab = {
        ...t,
        cwd: t.cwd && deadCwds.has(t.cwd) ? undefined : t.cwd,
        paneTree: stripCwds(t.paneTree, deadCwds),
      };
      return next;
    });
  if (tabs.length === 0) return { ...session, tabs: [] };
  return sanitizeForSave({ ...session, tabs });
}

let restored: PersistedSession | null = null;

/** Pre-render boot step (awaited from main.tsx before React mounts): decides
 * whether a previous session exists and is safe to hydrate. Never throws —
 * any failure means a default fresh boot. */
export async function initSessionRestore(): Promise<void> {
  try {
    if (!(await readRestoreSessionPref())) return;
    const session = validateSession(await store.get<unknown>(SESSION_KEY));
    if (!session) return;
    const revived = await reviveSession(session);
    restored = revived.tabs.length > 0 ? revived : null;
    if (restored) {
      // Mark which panes may replay a persisted scrollback (before any
      // terminal renders → before the first ensureSession), seed the
      // private-pane guard, and clean up files of panes that didn't survive.
      setRestorableLeaves(terminalLeafIds(restored.tabs));
      syncSnapshotLeaves(restored.tabs);
    }
  } catch (e) {
    console.warn("[termul] session restore skipped:", e);
    restored = null;
  }
}

export function getRestoredSession(): PersistedSession | null {
  return restored;
}

function maxId(session: PersistedSession): number {
  let max = 0;
  const visit = (n: PaneNode): void => {
    max = Math.max(max, n.id);
    if (n.kind === "split") n.children.forEach(visit);
  };
  for (const tab of session.tabs) {
    max = Math.max(max, tab.id);
    if (tab.kind === "terminal") visit(tab.paneTree);
  }
  for (const g of session.groups) max = Math.max(max, g.id);
  return max;
}

/**
 * The initial useTabs state for this boot. Pure. With no restored session this
 * reproduces the historical default (tab 1 / leaf 2 / next id 3). An explicit
 * CLI launch dir appends a fresh active tab there on top of the restored set —
 * restoring history must not swallow "open a terminal HERE".
 */
export function buildBootState(
  initial: Partial<TerminalTab> | undefined,
  session: PersistedSession | null,
  explicitLaunchCwd: string | undefined,
): BootState {
  if (!session) {
    return {
      tabs: [
        {
          id: 1,
          kind: "terminal",
          title: initial?.title ?? "shell",
          cwd: initial?.cwd,
          paneTree: { kind: "leaf", id: 2, cwd: initial?.cwd },
          activeLeafId: 2,
        },
      ],
      activeId: 1,
      groups: [],
      tabGroupOf: {},
      nextId: 3,
    };
  }
  let nextId = maxId(session) + 1;
  const tabs = [...session.tabs];
  let activeId = session.activeId;
  if (explicitLaunchCwd) {
    const tabId = nextId++;
    const leafId = nextId++;
    tabs.push({
      id: tabId,
      kind: "terminal",
      title: "shell",
      cwd: explicitLaunchCwd,
      paneTree: { kind: "leaf", id: leafId, cwd: explicitLaunchCwd },
      activeLeafId: leafId,
    });
    activeId = tabId;
  }
  return {
    tabs,
    activeId,
    groups: session.groups,
    tabGroupOf: session.tabGroupOf,
    nextId,
  };
}
