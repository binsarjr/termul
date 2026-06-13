import { PortalContainerProvider } from "@/components/ui/portal-container";
import {
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { AgentNotificationsBridge } from "@/modules/agents";
import { firePendingReviewForSession } from "@/modules/agents/lib/review";
import { useManagedAgentsStore } from "@/modules/agents/store/managedAgentsStore";
import { Toaster } from "@/components/ui/sonner";
import {
  AgentRunBridge,
  AiInputBar,
  AiInputBarConnect,
  AiMiniWindow,
  getAllKeys,
  getAllCustomEndpointKeys,
  hasAnyKey,
  LocalAgentNotificationsBridge,
  SelectionAskAi,
  useChatStore,
} from "@/modules/ai";
import { AiComposerProvider } from "@/modules/ai/lib/composer";
import { redactSensitive } from "@/modules/ai/lib/redact";
import { native } from "@/modules/ai/lib/native";
import { useAgentsStore } from "@/modules/ai/store/agentsStore";
import { useSnippetsStore } from "@/modules/ai/store/snippetsStore";
import {
  AiDiffStack,
  EditorStack,
  GitDiffStack,
  NewEditorDialog,
  type EditorPaneHandle,
} from "@/modules/editor";
import {
  GitHistoryStack,
  type GitHistorySearchHandle,
} from "@/modules/git-history";
import { getLaunchDir } from "@/lib/launchDir";
import { quoteShellArg } from "@/lib/shellQuote";
import { useLazyRef } from "@/lib/useLazyRef";
import { useZoom } from "@/lib/useZoom";
import {
  FileExplorer,
  type FileExplorerHandle,
  useSshExplorerRoot,
} from "@/modules/explorer";
import {
  listenFsChanged,
  parentDir,
  watchAdd,
  watchRemove,
} from "@/modules/explorer/lib/watch";
import {
  Header,
  type SearchInlineHandle,
  type SearchTarget,
} from "@/modules/header";
import { ImageStack, IMAGE_EXT_RE } from "@/modules/image";
import { MarkdownStack } from "@/modules/markdown";
import { PdfStack } from "@/modules/pdf";
import {
  openSettings,
  registerOpenSettings,
} from "@/modules/settings/openSettings";
import { SettingsStack } from "@/modules/settings/SettingsStack";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { onKeysChanged, setThemeId as persistThemeId } from "@/modules/settings/store";
import { flushSessionSave } from "@/modules/tabs/lib/sessionStore";
import { flushAllSnapshots } from "@/modules/terminal/lib/sessionSnapshots";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ShortcutsDialog,
  SHORTCUTS,
  getBindingTokens,
  useGlobalShortcuts,
  type ShortcutHandlers,
  type ShortcutId,
} from "@/modules/shortcuts";
import {
  CommandPalette,
  type PaletteCommand,
  type PaletteFile,
} from "@/modules/command-palette";
import { useWorkspaceFiles } from "@/modules/ai/hooks/useWorkspaceFiles";
import { SidebarRail, type SidebarViewId } from "@/modules/sidebar";
import {
  SourceControlPanel,
  useSourceControl,
} from "@/modules/source-control";
import { StatusBar } from "@/modules/statusbar";
import {
  remoteHostOf,
  TabBar,
  type TabGroupControls,
  TabSearch,
  useTabs,
  useWorkspaceCwd,
  visibleTabs,
} from "@/modules/tabs";
import {
  clearFocusedTerminal,
  disposeSession,
  findLeafCwd,
  hasLeaf,
  leafIds,
  respawnSession,
  TerminalStack,
  useTerminalFileDrop,
  whenSessionReady,
  writeToSession,
  type TerminalPaneHandle,
} from "@/modules/terminal";
import { ThemeProvider } from "@/modules/theme";
import { listCustomThemes, saveCustomTheme } from "@/modules/theme/customThemes";
import {
  isThemeFilePath,
  onThemeEdit,
  parseThemeFile,
  starterTheme,
  themeFilePath,
  writeThemeFile,
} from "@/modules/theme/themeFiles";
import { UpdaterDialog, useUpdaterStore } from "@/modules/updater";
import {
  currentWorkspaceEnv,
  getWslHome,
  isRemotePath,
  LOCAL_WORKSPACE,
  useWorkspaceEnvStore,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { SearchAddon } from "@xterm/addon-search";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

type TuiWaitResult = "ready" | "gone" | "timeout";

async function waitForClaudeTuiReady(
  readBuf: () => string | null,
  timeoutMs = 8000,
): Promise<TuiWaitResult> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const buf = readBuf();
    if (buf === null) return "gone";
    if (buf.includes("shortcuts") || buf.includes("? for")) return "ready";
    await new Promise((r) => setTimeout(r, 120));
  }
  return "timeout";
}

function dirname(path: string | null): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return normalized;
  return normalized.slice(0, idx);
}

// Sidebar min/max/default are ON-SCREEN (visual) pixels. `.zoom-content`
// applies CSS `zoom`, so a panel's visual width is its layout width times the
// zoom factor. Keeping the bounds in visual px lets the sidebar be dragged to
// the same on-screen size at any zoom level. A layout-px cap would instead pin
// the sidebar to a tiny strip when zoomed out (480 layout px is only 240 px on
// screen at zoom 0.5).
const SIDEBAR_DEFAULT_WIDTH = 260;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 480;
// Loose layout-px guard so a corrupted localStorage value cannot blow up the
// layout. The real on-screen bounds are enforced by clampSidebarVisual and the
// panel's zoom-scaled minSize/maxSize.
const SIDEBAR_LAYOUT_FLOOR = 100;
const SIDEBAR_LAYOUT_CEIL = 1200;
const SIDEBAR_WIDTH_STORAGE_KEY = "termul:sidebar.width";
const SIDEBAR_VIEW_STORAGE_KEY = "termul:sidebar.view";

// Clamp a candidate layout width so the sidebar's on-screen width stays within
// [MIN, MAX]. visualWidth = layoutWidth * zoom.
function clampSidebarVisual(layoutWidth: number, zoom: number): number {
  const visual = layoutWidth * zoom;
  const clamped = Math.min(
    SIDEBAR_MAX_WIDTH,
    Math.max(SIDEBAR_MIN_WIDTH, visual),
  );
  return Math.round(clamped / zoom);
}

function sanitizeSidebarLayoutWidth(width: number): number {
  return Math.min(
    SIDEBAR_LAYOUT_CEIL,
    Math.max(SIDEBAR_LAYOUT_FLOOR, Math.round(width)),
  );
}

function readSidebarWidth(): number {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : NaN;
    return Number.isFinite(parsed)
      ? sanitizeSidebarLayoutWidth(parsed)
      : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

// The vertical (left) tab column mirrors the sidebar's zoom-aware sizing: bounds
// are ON-SCREEN px so the column stays the same size at any zoom, with the same
// loose layout-px guard against a corrupted stored value.
const TABCOL_DEFAULT_WIDTH = 180;
const TABCOL_MIN_WIDTH = 140;
const TABCOL_MAX_WIDTH = 320;
const TABCOL_WIDTH_STORAGE_KEY = "termul:tab-column.width";

function clampTabColumnVisual(layoutWidth: number, zoom: number): number {
  const visual = layoutWidth * zoom;
  const clamped = Math.min(TABCOL_MAX_WIDTH, Math.max(TABCOL_MIN_WIDTH, visual));
  return Math.round(clamped / zoom);
}

function readTabColumnWidth(): number {
  try {
    const stored = window.localStorage.getItem(TABCOL_WIDTH_STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : NaN;
    return Number.isFinite(parsed)
      ? sanitizeSidebarLayoutWidth(parsed)
      : TABCOL_DEFAULT_WIDTH;
  } catch {
    return TABCOL_DEFAULT_WIDTH;
  }
}

function readSidebarView(): SidebarViewId {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY);
    if (stored === "explorer" || stored === "source-control") return stored;
  } catch {
    // ignore
  }
  return "explorer";
}

/** Shortcuts that don't belong in the command palette's Commands group:
 * `tab.selectByIndex` needs a digit key, `palette.open` would re-toggle the
 * palette, and the editor undo/redo entries are handled natively by CodeMirror. */
const PALETTE_EXCLUDED_SHORTCUTS = new Set<ShortcutId>([
  "tab.selectByIndex",
  "palette.open",
  "editor.undo",
  "editor.redo",
]);

export default function App() {
  const {
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
    closeAiDiffTab,
    openGitDiffTab,
    openCommitHistoryTab,
    openCommitFileDiffTab,
    openSettingsTab,
    setSettingsSection,
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
  } = useTabs(getLaunchDir() ? { cwd: getLaunchDir() } : undefined);

  const groupControls = useMemo<TabGroupControls>(
    () => ({
      groups,
      tabGroupOf,
      onCreateGroup: createGroupFromTab,
      onAssignToGroup: assignTabToGroup,
      onRemoveFromGroup: removeTabFromGroup,
      onRenameGroup: renameGroup,
      onRecolorGroup: recolorGroup,
      onToggleGroupCollapsed: toggleGroupCollapsed,
      onUngroup: ungroup,
    }),
    [
      groups,
      tabGroupOf,
      createGroupFromTab,
      assignTabToGroup,
      removeTabFromGroup,
      renameGroup,
      recolorGroup,
      toggleGroupCollapsed,
      ungroup,
    ],
  );

  // Mirror `tabs` into a ref so callbacks scheduled with `setTimeout`
  // (e.g. cdInNewTab) read the latest pane state instead of a stale closure.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // Back the free-function `openSettings(section?)` (called from the status bar,
  // agent switcher, shortcuts dialog) with the tab store App owns here.
  useEffect(() => {
    registerOpenSettings((section) => openSettingsTab(section));
    return () => registerOpenSettings(null);
  }, [openSettingsTab]);

  // Close the Settings tab. closeTab refuses to drop the last tab, so when
  // Settings is the only tab, swap in a fresh terminal instead of no-op'ing.
  const closeSettingsTab = useCallback(() => {
    const st = tabsRef.current.find((t) => t.kind === "settings");
    if (!st) return;
    if (tabsRef.current.length > 1) closeTab(st.id);
    else resetWorkspace();
  }, [closeTab, resetWorkspace]);

  const activeTerminalTab = useMemo(() => {
    const t = tabs.find((x) => x.id === activeId);
    return t && t.kind === "terminal" ? t : null;
  }, [tabs, activeId]);
  const activeLeafId = activeTerminalTab?.activeLeafId ?? null;

  const searchAddons = useLazyRef<Map<number, SearchAddon>>(() => new Map());
  const [activeSearchAddon, setActiveSearchAddon] =
    useState<SearchAddon | null>(null);
  const searchInlineRef = useRef<SearchInlineHandle | null>(null);
  const terminalRefs = useLazyRef<Map<number, TerminalPaneHandle>>(
    () => new Map(),
  );
  const editorRefs = useLazyRef<Map<number, EditorPaneHandle>>(() => new Map());
  const [activeEditorHandle, setActiveEditorHandle] =
    useState<EditorPaneHandle | null>(null);
  const [gitHistoryHandle, setGitHistoryHandle] =
    useState<GitHistorySearchHandle | null>(null);
  const { zoomIn, zoomOut, zoomReset } = useZoom();
  useTerminalFileDrop();
  const explorerRef = useRef<FileExplorerHandle>(null);
  const explorerReturnFocusRef = useRef<HTMLElement | null>(null);

  const sidebarRef = useRef<PanelImperativeHandle | null>(null);
  // Drives the zoom-scaled sidebar bounds and resize-handle hit area below.
  const sidebarZoom = usePreferencesStore((s) => s.zoomLevel) || 1;
  const sidebarWidthRef = useLazyRef(() => readSidebarWidth());
  const sidebarWidthWriteTimerRef = useRef(0);
  const [sidebarView, setSidebarViewState] = useState<SidebarViewId>(readSidebarView);
  const persistSidebarView = useCallback((view: SidebarViewId) => {
    setSidebarViewState(view);
    try {
      window.localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, view);
    } catch {
      // storage may fail in private mode
    }
  }, []);
  const toggleSidebar = useCallback(() => {
    const p = sidebarRef.current;
    if (!p) return;
    if (p.getSize().asPercentage <= 0) p.expand();
    else p.collapse();
  }, []);
  const cycleSidebarView = useCallback(
    (view: SidebarViewId) => {
      const panel = sidebarRef.current;
      const collapsed = panel ? panel.getSize().asPercentage <= 0 : false;
      if (collapsed) {
        if (panel) panel.resize(`${sidebarWidthRef.current}px`);
        if (view !== sidebarView) persistSidebarView(view);
        return;
      }
      if (view === sidebarView) {
        panel?.collapse();
        return;
      }
      persistSidebarView(view);
    },
    [persistSidebarView, sidebarView],
  );
  const persistSidebarWidth = useCallback((next: number) => {
    sidebarWidthRef.current = next;
    if (sidebarWidthWriteTimerRef.current) {
      window.clearTimeout(sidebarWidthWriteTimerRef.current);
    }
    sidebarWidthWriteTimerRef.current = window.setTimeout(() => {
      sidebarWidthWriteTimerRef.current = 0;
      try {
        window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next));
      } catch {
        // ignore
      }
    }, 200);
  }, []);
  useEffect(() => {
    return () => {
      if (sidebarWidthWriteTimerRef.current) {
        window.clearTimeout(sidebarWidthWriteTimerRef.current);
      }
    };
  }, []);

  const handleSidebarResizeStart = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const panel = sidebarRef.current;
      if (!panel) return;
      e.preventDefault();
      // `.zoom-content` uses CSS `zoom`. In this WebKit, getBoundingClientRect /
      // offsetWidth stay in unscaled layout px while pointer clientX is in
      // zoomed (on-screen) px, so the panel library's own drag math drifts by
      // the zoom factor. Convert the visual delta back to layout px (divide by
      // zoom) so the divider tracks the cursor 1:1, then drive the panel
      // imperatively.
      const zoom =
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--app-zoom",
          ),
        ) || 1;
      const startX = e.clientX;
      const startWidth = panel.getSize().inPixels || sidebarWidthRef.current;
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const onMove = (ev: PointerEvent) => {
        const next = clampSidebarVisual(
          startWidth + (ev.clientX - startX) / zoom,
          zoom,
        );
        panel.resize(`${next}px`);
      };
      const onUp = () => {
        el.releasePointerCapture?.(e.pointerId);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    },
    [sidebarWidthRef],
  );

  const tabBarPosition = usePreferencesStore((s) => s.tabBarPosition);
  // Radix overlays whose triggers live in the zoomed workspace portal into this
  // element (a child of `.zoom-content`) instead of document.body, so the popover
  // shares the trigger's zoom coordinate space and anchors correctly. See
  // PortalContainerProvider below and src/components/ui/portal-container.tsx.
  const [zoomPortalContainer, setZoomPortalContainer] =
    useState<HTMLDivElement | null>(null);
  const tabColumnRef = useRef<PanelImperativeHandle | null>(null);
  const tabColumnWidthRef = useLazyRef(() => readTabColumnWidth());
  const tabColumnWidthWriteTimerRef = useRef(0);
  const persistTabColumnWidth = useCallback((next: number) => {
    tabColumnWidthRef.current = next;
    if (tabColumnWidthWriteTimerRef.current) {
      window.clearTimeout(tabColumnWidthWriteTimerRef.current);
    }
    tabColumnWidthWriteTimerRef.current = window.setTimeout(() => {
      tabColumnWidthWriteTimerRef.current = 0;
      try {
        window.localStorage.setItem(TABCOL_WIDTH_STORAGE_KEY, String(next));
      } catch {
        // ignore
      }
    }, 200);
  }, []);
  useEffect(() => {
    return () => {
      if (tabColumnWidthWriteTimerRef.current) {
        window.clearTimeout(tabColumnWidthWriteTimerRef.current);
      }
    };
  }, []);

  // Mirrors handleSidebarResizeStart: the tab column lives inside `.zoom-content`
  // too, so the visual drag delta is divided by the CSS zoom to track the cursor.
  const handleTabColumnResizeStart = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const panel = tabColumnRef.current;
      if (!panel) return;
      e.preventDefault();
      const zoom =
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--app-zoom",
          ),
        ) || 1;
      const startX = e.clientX;
      const startWidth = panel.getSize().inPixels || tabColumnWidthRef.current;
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      const prevCursor = document.body.style.cursor;
      const prevSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const onMove = (ev: PointerEvent) => {
        const next = clampTabColumnVisual(
          startWidth + (ev.clientX - startX) / zoom,
          zoom,
        );
        panel.resize(`${next}px`);
      };
      const onUp = () => {
        el.releasePointerCapture?.(e.pointerId);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevSelect;
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    },
    [tabColumnWidthRef],
  );

  const toggleExplorerFocus = useCallback(() => {
    const explorer = explorerRef.current;
    const panel = sidebarRef.current;
    const collapsed = panel ? panel.getSize().asPercentage <= 0 : false;
    if (sidebarView !== "explorer" || collapsed) {
      if (panel && collapsed) panel.resize(`${sidebarWidthRef.current}px`);
      if (sidebarView !== "explorer") persistSidebarView("explorer");
      const active = document.activeElement;
      explorerReturnFocusRef.current =
        active instanceof HTMLElement && active !== document.body
          ? active
          : null;
      requestAnimationFrame(() => explorerRef.current?.focus());
      return;
    }
    if (!explorer) return;
    if (explorer.isFocused()) {
      const target = explorerReturnFocusRef.current;
      explorerReturnFocusRef.current = null;
      if (target && document.body.contains(target)) {
        target.focus();
      } else {
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
      return;
    }
    const active = document.activeElement;
    explorerReturnFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    explorer.focus();
  }, [persistSidebarView, sidebarView]);

  const [home, setHome] = useState<string | null>(null);
  const [pendingCloseTab, setPendingCloseTab] = useState<number | null>(null);
  const workspaceEnv = useWorkspaceEnvStore((s) => s.env);
  const setWorkspaceEnv = useWorkspaceEnvStore((s) => s.setEnv);
  const [launchCwd, setLaunchCwd] = useState<string | null>(null);
  const [launchCwdResolved, setLaunchCwdResolved] = useState(false);
  const [pendingDeleteTabs, setPendingDeleteTabs] = useState<number[] | null>(
    null,
  );
  useEffect(() => {
    homeDir()
      .then(async (p) => {
        const normalized = p.replace(/\\/g, "/");
        setHome(normalized);
        try {
          await native.workspaceAuthorize(normalized);
        } catch {
          // Bootstrap already authorizes home from Rust; ignore.
        }
      })
      .catch(() => setHome(null));
  }, []);

  const switchWorkspace = useCallback(
    async (env: WorkspaceEnv) => {
      if (
        env.kind === workspaceEnv.kind &&
        (env.kind === "local" ||
          (workspaceEnv.kind === "wsl" && env.distro === workspaceEnv.distro))
      ) {
        return;
      }
      const dirty = tabsRef.current.some((t) => t.kind === "editor" && t.dirty);
      if (dirty) {
        window.alert("Save or close unsaved editor tabs before switching workspace.");
        return;
      }

      let nextHome: string | null = null;
      try {
        if (env.kind === "wsl") {
          nextHome = await getWslHome(env.distro);
        } else {
          nextHome = (await homeDir()).replace(/\\/g, "/");
        }
      } catch (e) {
        window.alert(String(e));
        return;
      }

      for (const id of liveLeavesRef.current) disposeSession(id);
      searchAddons.current.clear();
      terminalRefs.current.clear();
      editorRefs.current.clear();
      setActiveSearchAddon(null);
      setActiveEditorHandle(null);
      setWorkspaceEnv(env.kind === "local" ? LOCAL_WORKSPACE : env);
      setHome(nextHome);
      setLaunchCwd(nextHome);
      if (nextHome) {
        try {
          await native.workspaceAuthorize(nextHome);
        } catch {
          // Non-fatal — git panel will surface "not authorized" if needed.
        }
      }
      resetWorkspace(nextHome ?? undefined);
    },
    [workspaceEnv, setWorkspaceEnv, resetWorkspace],
  );
  useEffect(() => {
    native
      .workspaceCurrentDir()
      .then(setLaunchCwd)
      .catch(() => setLaunchCwd(null))
      .finally(() => setLaunchCwdResolved(true));
  }, []);

  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [newEditorOpen, setNewEditorOpen] = useState(false);
  const [tabSearchOpen, setTabSearchOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const userShortcuts = usePreferencesStore((s) => s.shortcuts);
  const restoreSessionPref = usePreferencesStore((s) => s.restoreSession);
  const maxPanesPerTab = usePreferencesStore((s) => s.maxPanesPerTab);
  const dimInactivePanes = usePreferencesStore((s) => s.dimInactivePanes);
  const miniOpen = useChatStore((s) => s.mini.open);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const openMini = useChatStore((s) => s.openMini);
  const focusInput = useChatStore((s) => s.focusInput);
  const openPanel = useChatStore((s) => s.openPanel);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const apiKeys = useChatStore((s) => s.apiKeys);
  const setApiKeys = useChatStore((s) => s.setApiKeys);
  const setCustomEndpointKeys = useChatStore((s) => s.setCustomEndpointKeys);
  const setSelectedModelId = useChatStore((s) => s.setSelectedModelId);
  const setLive = useChatStore((s) => s.setLive);
  const respondToApproval = useChatStore((s) => s.respondToApproval);

  useEffect(() => {
    if (activeSessionId) firePendingReviewForSession(activeSessionId);
  }, [activeSessionId]);
  const lmstudioModelId = usePreferencesStore((s) => s.lmstudioModelId);
  const lmstudioBaseURL = usePreferencesStore((s) => s.lmstudioBaseURL);
  const mlxModelId = usePreferencesStore((s) => s.mlxModelId);
  const mlxBaseURL = usePreferencesStore((s) => s.mlxBaseURL);
  const ollamaModelId = usePreferencesStore((s) => s.ollamaModelId);
  const ollamaBaseURL = usePreferencesStore((s) => s.ollamaBaseURL);
  const openaiCompatibleModelId = usePreferencesStore(
    (s) => s.openaiCompatibleModelId,
  );
  const openaiCompatibleBaseURL = usePreferencesStore(
    (s) => s.openaiCompatibleBaseURL,
  );
  const customEndpoints = usePreferencesStore((s) => s.customEndpoints);
  const hasLocalModel =
    (lmstudioBaseURL.trim().length > 0 && lmstudioModelId.trim().length > 0) ||
    (mlxBaseURL.trim().length > 0 && mlxModelId.trim().length > 0) ||
    (ollamaBaseURL.trim().length > 0 && ollamaModelId.trim().length > 0) ||
    (openaiCompatibleBaseURL.trim().length > 0 &&
      openaiCompatibleModelId.trim().length > 0) ||
    customEndpoints.some((e) => e.baseURL.trim().length > 0 && e.modelId.trim().length > 0);
  const hasComposer = hasAnyKey(apiKeys) || hasLocalModel;

  const prefsHydrated = usePreferencesStore((s) => s.hydrated);
  const [keysLoaded, setKeysLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const reload = () => {
      void getAllKeys().then((keys) => {
        if (!alive) return;
        setApiKeys(keys);
        setKeysLoaded(true);
      });
      if (!prefsHydrated) return;
      void getAllCustomEndpointKeys(
        usePreferencesStore.getState().customEndpoints,
      ).then((epKeys) => {
        if (!alive) return;
        setCustomEndpointKeys(epKeys);
      });
    };
    reload();
    const unlistenP = onKeysChanged(reload);
    return () => {
      alive = false;
      void unlistenP.then((fn) => fn());
    };
  }, [setApiKeys, setCustomEndpointKeys, prefsHydrated]);

  // Hydrate the cross-window preference store and mirror the default model
  // into chatStore so the dropdown reflects what the user picked in Settings.
  const initPrefs = usePreferencesStore((s) => s.init);
  const prefDefaultModel = usePreferencesStore((s) => s.defaultModelId);
  useEffect(() => {
    void initPrefs();
  }, [initPrefs]);
  useEffect(() => {
    if (!prefsHydrated) return;
    setSelectedModelId(prefDefaultModel);
  }, [prefsHydrated, prefDefaultModel, setSelectedModelId]);

  const hydrateSessions = useChatStore((s) => s.hydrateSessions);
  useEffect(() => {
    void hydrateSessions();
    void useAgentsStore.getState().hydrate();
    void useSnippetsStore.getState().hydrate();
  }, [hydrateSessions]);

  const activeTab = tabs.find((t) => t.id === activeId);
  const isTerminalTab = activeTab?.kind === "terminal";
  const isEditorTab = activeTab?.kind === "editor";
  const isMarkdownTab = activeTab?.kind === "markdown";
  const isPdfTab = activeTab?.kind === "pdf";
  const isImageTab = activeTab?.kind === "image";
  const isAiDiffTab = activeTab?.kind === "ai-diff";
  const isGitDiffTab =
    activeTab?.kind === "git-diff" || activeTab?.kind === "git-commit-file";
  const isGitHistoryTab = activeTab?.kind === "git-history";
  const isSettingsTab = activeTab?.kind === "settings";

  // When an AI diff is approved (write_file applied to disk), reload any
  // open editor tabs for that path so the user sees the new content. We
  // track which approvalIds we've already handled to fire the reload only
  // once per applied diff.
  const appliedDiffsRef = useLazyRef<Set<string>>(() => new Set());
  useEffect(() => {
    for (const t of tabs) {
      if (t.kind !== "ai-diff") continue;
      if (t.status !== "approved") continue;
      if (appliedDiffsRef.current.has(t.approvalId)) continue;
      appliedDiffsRef.current.add(t.approvalId);
      for (const e of tabs) {
        if (e.kind !== "editor") continue;
        if (e.path !== t.path) continue;
        editorRefs.current.get(e.id)?.reload();
      }
    }
  }, [tabs]);

  useEffect(() => {
    type FileWrittenPayload = { path: string; source?: string };
    const unlistenPromise = getCurrentWebviewWindow().listen<FileWrittenPayload>(
      "fs:file-written",
      (event) => {
        if (event.payload.source === "editor") return;
        const normalizedPath = event.payload.path.replace(/\\/g, "/");
        const currentTabs = tabsRef.current;
        for (const t of currentTabs) {
          if (t.kind !== "editor") continue;
          if (t.path.replace(/\\/g, "/") === normalizedPath) {
            editorRefs.current.get(t.id)?.reload();
          }
        }
      },
    );
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, []);

  const editorWatchRef = useLazyRef<Set<string>>(() => new Set());
  useEffect(() => {
    const want = new Set<string>();
    for (const t of tabs) if (t.kind === "editor") want.add(parentDir(t.path));
    const prev = editorWatchRef.current;
    const toAdd = [...want].filter((d) => !prev.has(d));
    const toRemove = [...prev].filter((d) => !want.has(d));
    watchAdd(toAdd);
    watchRemove(toRemove);
    editorWatchRef.current = want;
  }, [tabs]);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listenFsChanged((paths) => {
      const changed = new Set(paths.map((p) => p.replace(/\\/g, "/")));
      for (const t of tabsRef.current) {
        if (t.kind !== "editor") continue;
        if (changed.has(t.path.replace(/\\/g, "/"))) {
          editorRefs.current.get(t.id)?.reload();
        }
      }
    }).then((un) => {
      if (alive) unlisten = un;
      else un();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  // Theme editing: a custom theme is materialized to a real file and edited in
  // the code editor. Saving it re-ingests into the runtime store + applies live.
  useEffect(() => {
    type FileWrittenPayload = { path: string; source?: string };
    const unlistenPromise = getCurrentWebviewWindow().listen<FileWrittenPayload>(
      "fs:file-written",
      (event) => {
        if (event.payload.source !== "editor") return;
        if (!isThemeFilePath(event.payload.path)) return;
        void (async () => {
          try {
            const res = await invoke<{ kind: string; content?: string }>(
              "fs_read_file",
              { path: event.payload.path, workspace: currentWorkspaceEnv() },
            );
            if (res.kind !== "text" || typeof res.content !== "string") return;
            const parsed = parseThemeFile(res.content);
            if (!parsed.ok) {
              console.warn("[termul] theme not applied:", parsed.error);
              return;
            }
            await saveCustomTheme(parsed.theme);
          } catch (e) {
            console.warn("[termul] theme ingest failed:", e);
          }
        })();
      },
    );
    return () => {
      void unlistenPromise.then((un) => un());
    };
  }, []);

  useEffect(() => {
    let alive = true;
    let unsub: (() => void) | undefined;
    void onThemeEdit(async (req) => {
      const theme =
        req.action === "create"
          ? starterTheme()
          : (await listCustomThemes()).find((t) => t.id === req.id);
      if (!theme) return;
      if (req.action === "create") await saveCustomTheme(theme);
      const path = await themeFilePath(theme.id);
      const open = tabsRef.current.some(
        (t) => t.kind === "editor" && t.path === path,
      );
      if (!open) await writeThemeFile(theme);
      void persistThemeId(theme.id);
      openFileTab(path);
      void getCurrentWebviewWindow().setFocus();
    }).then((fn) => {
      if (alive) unsub = fn;
      else fn();
    });
    return () => {
      alive = false;
      unsub?.();
    };
  }, [openFileTab]);

  const { explorerRoot, inheritedCwdForNewTab } = useWorkspaceCwd(
    activeTab,
    tabs,
    launchCwd ?? home,
  );

  useEffect(() => {
    setActiveSearchAddon(
      activeLeafId !== null ? (searchAddons.current.get(activeLeafId) ?? null) : null,
    );
    setActiveEditorHandle(editorRefs.current.get(activeId) ?? null);
  }, [activeId, activeLeafId]);

  const handleSearchReady = useCallback(
    (leafId: number, addon: SearchAddon) => {
      searchAddons.current.set(leafId, addon);
      if (leafId === activeLeafId) setActiveSearchAddon(addon);
    },
    [activeLeafId],
  );

  const disposeTab = useCallback(
    (id: number) => {
      // Terminal-leaf-keyed maps (terminalRefs/searchAddons) are pruned by
      // the effect below as the pane tree changes; only the tab-id-keyed
      // handles need explicit cleanup here.
      editorRefs.current.delete(id);
      closeTab(id);
    },
    [closeTab],
  );

  // Drives session disposal off the pane tree, not React lifecycles —
  // split/unsplit re-mount components but the leaf is still live.
  const liveLeavesRef = useLazyRef<Set<number>>(() => new Set());
  useEffect(() => {
    const live = new Set<number>();
    for (const t of tabs) {
      if (t.kind === "terminal") {
        for (const id of leafIds(t.paneTree)) live.add(id);
      }
    }
    for (const id of liveLeavesRef.current) {
      if (!live.has(id)) disposeSession(id);
    }
    liveLeavesRef.current = live;
    for (const k of [...terminalRefs.current.keys()])
      if (!live.has(k)) terminalRefs.current.delete(k);
    for (const k of [...searchAddons.current.keys()])
      if (!live.has(k)) searchAddons.current.delete(k);
  }, [tabs]);

  const handleClose = useCallback(
    (id: number) => {
      const t = tabsRef.current.find((x) => x.id === id);
      if (t?.kind === "editor" && t.dirty) {
        setPendingCloseTab(id);
        return;
      }
      disposeTab(id);
    },
    [disposeTab],
  );

  const confirmClose = useCallback(() => {
    if (pendingCloseTab !== null) {
      disposeTab(pendingCloseTab);
      setPendingCloseTab(null);
    }
  }, [pendingCloseTab, disposeTab]);

  const cancelClose = useCallback(() => {
    setPendingCloseTab(null);
  }, []);

  // Window close: optionally confirm (a stray click on the close button
  // shouldn't kill every shell), then flush the session (tab structure +
  // pending scrollback snapshots) before the window goes away.
  const [confirmQuitOpen, setConfirmQuitOpen] = useState(false);

  const flushSessionAndDestroy = useCallback(async () => {
    try {
      await Promise.all([flushAllSnapshots(), flushSessionSave()]);
    } catch (e) {
      console.error("[termul] session flush on close failed:", e);
    }
    // Needs core:window:allow-destroy in capabilities — without it this
    // rejects and the window silently refuses to close.
    await getCurrentWindow()
      .destroy()
      .catch((e) => console.error("[termul] window destroy failed:", e));
  }, []);

  useEffect(() => {
    // Registering this listener makes the Tauri API own the close: it awaits
    // the handler and destroys the window unless preventDefault() was called.
    // The catch is load-bearing — an uncaught throw would leave the window
    // unclosable. macOS Cmd+Q bypasses close-requested entirely; the
    // continuous debounced session saves bound that loss.
    const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
      if (usePreferencesStore.getState().confirmBeforeQuit) {
        event.preventDefault();
        setConfirmQuitOpen(true);
        return;
      }
      try {
        await Promise.all([flushAllSnapshots(), flushSessionSave()]);
      } catch (e) {
        console.error("[termul] session flush on close failed:", e);
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const cycleTab = useCallback(
    (delta: 1 | -1) => {
      // Walk the visible list so Ctrl+Tab skips members of a collapsed group.
      const vis = visibleTabs(tabs, groups, tabGroupOf);
      if (vis.length < 2) return;
      const idx = vis.findIndex((t) => t.id === activeId);
      // If the active tab is hidden (its group was just collapsed), enter the
      // visible list from the appropriate end.
      const nextIdx =
        idx === -1
          ? delta > 0
            ? 0
            : vis.length - 1
          : (idx + delta + vis.length) % vis.length;
      setActiveId(vis[nextIdx].id);
    },
    [tabs, groups, tabGroupOf, activeId, setActiveId],
  );

  const captureActiveSelection = useCallback((): string | null => {
    const t = tabs.find((x) => x.id === activeId);
    if (!t) return null;
    if (t.kind === "terminal") {
      const lid = t.activeLeafId;
      return terminalRefs.current.get(lid)?.getSelection() ?? null;
    }
    if (t.kind === "editor") {
      return editorRefs.current.get(activeId)?.getSelection() ?? null;
    }
    return null;
  }, [tabs, activeId]);

  const togglePanelAndFocus = useCallback(() => {
    if (!hasComposer) {
      openSettings("models");
      return;
    }
    if (panelOpen) {
      useChatStore.getState().closePanel();
    } else {
      openPanel();
      focusInput(null);
    }
  }, [hasComposer, panelOpen, openPanel, focusInput]);

  const attachSelection = useChatStore((s) => s.attachSelection);

  const handleAttachFileToAgent = useCallback(
    (path: string) => {
      if (!hasComposer) {
        openSettings("models");
        return;
      }
      // Dispatch a window event the composer listens for. Same pattern as
      // selections — keeps file-explorer decoupled from the AI module.
      window.dispatchEvent(
        new CustomEvent<string>("termul:ai-attach-file", { detail: path }),
      );
      openPanel();
      focusInput(null);
    },
    [hasComposer, openPanel, focusInput],
  );

  const askFromSelection = useCallback(() => {
    if (!hasComposer) {
      openSettings("models");
      return;
    }
    const selection = captureActiveSelection();
    if (!selection || !selection.trim()) {
      focusInput(null);
      return;
    }
    const source: "terminal" | "editor" =
      activeTab?.kind === "editor" ? "editor" : "terminal";
    attachSelection(selection, source);
  }, [
    hasComposer,
    captureActiveSelection,
    focusInput,
    attachSelection,
    activeTab,
  ]);

  const [askPopup, setAskPopup] = useState<{ x: number; y: number } | null>(
    null,
  );

  useEffect(() => {
    const isInsideAi = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      return !!(
        el.closest("[data-selection-ask-ai]") ||
        el.closest("[data-ai-input-bar]") ||
        el.closest("[data-ai-mini-window]")
      );
    };

    const onDown = (e: MouseEvent) => {
      if (isInsideAi(e.target)) return;
      setAskPopup(null);
    };
    const onUp = (e: MouseEvent) => {
      if (isInsideAi(e.target)) return;
      const el = e.target as HTMLElement | null;
      const inContentArea = el?.closest?.(".xterm, .cm-editor");
      if (!inContentArea) return;
      // Defer one tick so xterm/CodeMirror finalize the selection.
      setTimeout(() => {
        const text = captureActiveSelection();
        if (text && text.trim().length > 0) {
          setAskPopup({ x: e.clientX, y: e.clientY });
        } else {
          setAskPopup(null);
        }
      }, 0);
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("mouseup", onUp);
    };
  }, [captureActiveSelection]);

  const onAskFromSelection = useCallback(() => {
    askFromSelection();
    setAskPopup(null);
  }, [askFromSelection]);

  const openNewTab = useCallback(() => {
    newTab(inheritedCwdForNewTab());
    // Opportunistic update check on new-tab open; the store throttles to once
    // per 30 min, so this is effectively free and never hits the network twice.
    void useUpdaterStore.getState().check();
  }, [newTab, inheritedCwdForNewTab]);

  const openNewPrivateTab = useCallback(() => {
    newPrivateTab(inheritedCwdForNewTab());
  }, [newPrivateTab, inheritedCwdForNewTab]);

  // Low-frequency safety net so a long-lived single-tab session still notices
  // updates without opening a new tab. The 30-min store throttle means this
  // only actually reaches the network a few times a day.
  useEffect(() => {
    const SAFETY_INTERVAL_MS = 6 * 60 * 60 * 1000;
    const id = setInterval(() => {
      void useUpdaterStore.getState().check();
    }, SAFETY_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  // Refresh on refocus so returning to the window after a release went out
  // picks it up without a restart. The store's 30-min throttle keeps this from
  // hammering the network, and an already-surfaced update is left untouched.
  useEffect(() => {
    const onFocus = () => void useUpdaterStore.getState().check();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const sendCd = useCallback(
    (path: string) => {
      if (activeLeafId === null) return;
      const term = terminalRefs.current.get(activeLeafId);
      if (!term) return;
      term.write(`cd ${quoteShellArg(path)}\r`);
      term.focus();
    },
    [activeLeafId],
  );

  const copyLastCommand = useCallback(() => {
    if (activeLeafId === null) return;
    const block = terminalRefs.current.get(activeLeafId)?.getActiveBlock();
    const command = block?.command?.trim();
    if (command) void navigator.clipboard.writeText(command).catch(() => {});
  }, [activeLeafId]);

  const copyLastCommandOutput = useCallback(() => {
    if (activeLeafId === null) return;
    const block = terminalRefs.current.get(activeLeafId)?.getActiveBlock();
    if (block?.output) void navigator.clipboard.writeText(block.output).catch(() => {});
  }, [activeLeafId]);

  const copyLastCommandBoth = useCallback(() => {
    if (activeLeafId === null) return;
    const block = terminalRefs.current.get(activeLeafId)?.getActiveBlock();
    if (!block) return;
    const command = block.command.trim();
    const text = [command, block.output].filter(Boolean).join("\n");
    if (text) void navigator.clipboard.writeText(text).catch(() => {});
  }, [activeLeafId]);

  const reinputLastCommand = useCallback(() => {
    if (activeLeafId === null) return;
    const term = terminalRefs.current.get(activeLeafId);
    const command = term?.getActiveBlock()?.command.trim();
    if (!term || !command) return;
    // Type the command back at the prompt without a trailing CR so the user
    // can edit/run it — matching Warp's "reinput", not an auto re-run.
    term.write(command);
    term.focus();
  }, [activeLeafId]);

  const selectPrevBlock = useCallback(() => {
    if (activeLeafId === null) return;
    terminalRefs.current.get(activeLeafId)?.selectPrevBlock();
  }, [activeLeafId]);

  const selectNextBlock = useCallback(() => {
    if (activeLeafId === null) return;
    terminalRefs.current.get(activeLeafId)?.selectNextBlock();
  }, [activeLeafId]);

  const cdInNewTab = useCallback(
    (path: string) => {
      const tabId = newTab(path);
      setTimeout(() => {
        const tab = tabsRef.current.find((x) => x.id === tabId);
        if (!tab || tab.kind !== "terminal") return;
        const t = terminalRefs.current.get(tab.activeLeafId);
        if (!t) return;
        t.write(`cd ${quoteShellArg(path)}\r`);
        t.focus();
      }, 80);
    },
    [newTab],
  );

  const handleOpenFile = useCallback(
    (path: string, pin?: boolean) => {
      // Binary media aren't text — route them straight to their viewers
      // instead of an editor tab that would just report "binary file".
      if (/\.pdf$/i.test(path)) {
        newPdfTab(path);
        return;
      }
      if (IMAGE_EXT_RE.test(path)) {
        newImageTab(path);
        return;
      }
      // Explorer defaults to preview (pin=false); explicit actions like
      // context-menu "Open" pass pin=true for a persistent tab.
      openFileTab(path, pin ?? false);
    },
    [openFileTab, newPdfTab, newImageTab],
  );

  const handlePathRenamed = useCallback(
    (from: string, to: string) => {
      for (const t of tabs) {
        if (t.kind !== "editor") continue;
        if (t.path === from) {
          const i = to.lastIndexOf("/");
          updateTab(t.id, { path: to, title: i === -1 ? to : to.slice(i + 1) });
        } else if (t.path.startsWith(`${from}/`)) {
          const suffix = t.path.slice(from.length);
          const newPath = `${to}${suffix}`;
          const i = newPath.lastIndexOf("/");
          updateTab(t.id, {
            path: newPath,
            title: i === -1 ? newPath : newPath.slice(i + 1),
          });
        }
      }
    },
    [tabs, updateTab],
  );

  const confirmDeleteClose = useCallback(() => {
    if (pendingDeleteTabs !== null) {
      for (const id of pendingDeleteTabs) disposeTab(id);
      setPendingDeleteTabs(null);
    }
  }, [pendingDeleteTabs, disposeTab]);

  const cancelDeleteClose = useCallback(() => {
    setPendingDeleteTabs(null);
  }, []);

  const handlePathDeleted = useCallback(
    (path: string) => {
      const dirty: number[] = [];
      for (const t of tabs) {
        if (t.kind !== "editor") continue;
        if (t.path !== path && !t.path.startsWith(`${path}/`)) continue;
        if (t.dirty) {
          dirty.push(t.id);
        } else {
          disposeTab(t.id);
        }
      }
      if (dirty.length > 0) setPendingDeleteTabs(dirty);
    },
    [tabs, disposeTab],
  );

  const activeTerminalLeafCwd =
    activeTab?.kind === "terminal"
      ? (findLeafCwd(activeTab.paneTree, activeTab.activeLeafId) ??
        activeTab.cwd ??
        null)
      : null;

  // Remote (SSH) cwd of the active terminal, when the shell has roamed onto
  // another host. Display-only — feeds the status-bar remote pill.
  const activeRemoteCwd =
    activeTab?.kind === "terminal" ? (activeTab.remoteCwd ?? null) : null;

  // Host of a detected local `ssh <host>` session on the active terminal (no
  // remote shell integration needed). Feeds the same status-bar pill as
  // activeRemoteCwd, which takes precedence when both are known.
  const activeSshHost =
    activeTab?.kind === "terminal" ? (activeTab.sshHost ?? null) : null;

  // Auto-follow SSH: root the file explorer at the active tab's remote host —
  // an ssh terminal's host, OR the host of a remote (ssh://) file tab, so
  // opening a remote file keeps the tree on that host instead of snapping back
  // to local. Falls back to the local explorer root while connecting, when the
  // active tab is local, or if the connection fails. Only the explorer follows —
  // git/source-control still operate on the local workspace.
  const explorerSshHost = activeTab ? remoteHostOf(activeTab) : null;
  const {
    sshRoot: sshExplorerRoot,
    status: sshExplorerStatus,
    retry: retrySshExplorer,
  } = useSshExplorerRoot(explorerSshHost, activeRemoteCwd);
  const effectiveExplorerRoot = sshExplorerRoot ?? explorerRoot;

  const activeFilePath = (() => {
    // The breadcrumb navigates the LOCAL filesystem; a remote (ssh://) editor
    // path would render as raw `ssh:`-prefixed segments, so fall back to the
    // local cwd (the tab's host badge conveys the remote identity instead).
    if (activeTab?.kind === "editor")
      return isRemotePath(activeTab.path) ? null : activeTab.path;
    if (activeTab?.kind === "git-diff") {
      if (/^([A-Za-z]:|\/|\\)/.test(activeTab.path)) return activeTab.path;
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    if (activeTab?.kind === "git-commit-file") {
      const root = activeTab.repoRoot.replace(/[\\/]+$/, "");
      const rel = activeTab.path.replace(/^[\\/]+/, "");
      return `${root}/${rel}`;
    }
    return null;
  })();
  const workspaceFallbackPath = launchCwdResolved
    ? (launchCwd ?? home ?? null)
    : null;
  const sourceControlContextPath = (() => {
    if (activeTab?.kind === "terminal") {
      return activeTerminalLeafCwd ?? explorerRoot ?? workspaceFallbackPath;
    }
    if (activeTab?.kind === "editor") return dirname(activeTab.path);
    if (activeTab?.kind === "git-diff") return activeTab.repoRoot;
    if (activeTab?.kind === "git-commit-file") return activeTab.repoRoot;
    if (activeTab?.kind === "git-history") return activeTab.repoRoot;
    return explorerRoot ?? workspaceFallbackPath;
  })();
  const hasOpenGitTab = useMemo(
    () =>
      tabs.some(
        (t) =>
          t.kind === "git-diff" ||
          t.kind === "git-history" ||
          t.kind === "git-commit-file",
      ),
    [tabs],
  );
  const sourceControlActive =
    hasOpenGitTab || sidebarView === "source-control";
  // Stable per-session path so switching tabs / cd-ing in a shell does NOT
  // re-fire git IPC for the badge. The active panel resolves the current
  // context path on its own when the user actually opens git.
  const badgeContextPath = workspaceFallbackPath;
  const activeContextPath = sourceControlActive
    ? sourceControlContextPath
    : badgeContextPath;
  // A remote (ssh://) context has no local git backend; fall back to the stable
  // local workspace path so the panel never fires git IPC against a remote path
  // (mirrors the explorer guard in useExplorerGitStatus).
  const sourceControlPath = isRemotePath(activeContextPath ?? "")
    ? badgeContextPath
    : activeContextPath;
  const sourceControl = useSourceControl(sourceControlPath, true);

  // Mirror the source-control snapshot + context path into refs so callbacks
  // passed to memo'd children (Header/TabBar) stay referentially stable across
  // git refreshes instead of capturing the latest snapshot.
  const sourceControlRef = useRef(sourceControl);
  sourceControlRef.current = sourceControl;
  const sourceControlContextPathRef = useRef(sourceControlContextPath);
  sourceControlContextPathRef.current = sourceControlContextPath;

  const toggleSourceControl = useCallback(() => {
    cycleSidebarView("source-control");
  }, [cycleSidebarView]);

  const openGitGraphFromContext = useCallback(async () => {
    const sc = sourceControlRef.current;
    const known = sc.hasRepo ? sc.repo : null;
    if (known) {
      openCommitHistoryTab({
        repoRoot: known.repoRoot,
        branch: sc.status?.branch ?? null,
      });
      return;
    }
    const contextPath = sourceControlContextPathRef.current;
    if (!contextPath || isRemotePath(contextPath)) return;
    try {
      const repo = await native.gitResolveRepo(contextPath);
      if (!repo) return;
      openCommitHistoryTab({ repoRoot: repo.repoRoot, branch: repo.branch });
    } catch {
      /* noop */
    }
  }, [openCommitHistoryTab]);

  const openNewEditor = useCallback(() => setNewEditorOpen(true), []);

  const handleOpenSettings = useCallback(() => openSettings(), []);

  const switchToTab = useCallback(
    (id: number) => {
      setActiveId(id);
      // The palette is a Radix dialog; it restores focus to the body on close.
      // Switching tabs only flips visibility, so re-focus the target terminal
      // leaf a couple frames later (after Radix's restore) to land typing
      // straight in the terminal. Non-terminal tabs need no explicit focus.
      const t = tabsRef.current.find((x) => x.id === id);
      if (t?.kind === "terminal") {
        const leafId = t.activeLeafId;
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            terminalRefs.current.get(leafId)?.focus(),
          ),
        );
      }
    },
    [setActiveId],
  );

  const openMarkdownPreview = useCallback(
    (path: string) => {
      newMarkdownTab(path);
    },
    [newMarkdownTab],
  );

  // "Plain Text" side of the markdown view toggle: open/focus the editor tab.
  const openMarkdownEditor = useCallback(
    (path: string) => {
      openFileTab(path);
    },
    [openFileTab],
  );

  const splitActivePaneInActiveTab = useCallback(
    (dir: "row" | "col") => {
      const t = tabsRef.current.find((x) => x.id === activeId);
      if (!t || t.kind !== "terminal") return;
      splitActivePane(activeId, dir);
    },
    [activeId, splitActivePane],
  );

  const handleCloseTabOrPane = useCallback(() => {
    const t = tabsRef.current.find((x) => x.id === activeId);
    if (t?.kind === "terminal" && leafIds(t.paneTree).length > 1) {
      closeActivePane(activeId);
      return;
    }
    handleClose(activeId);
  }, [activeId, closeActivePane, handleClose]);

  const shortcutHandlers = useMemo<ShortcutHandlers>(
    () => ({
      "tab.new": openNewTab,
      "tab.newPrivate": openNewPrivateTab,
      "tab.search": () => setTabSearchOpen((v) => !v),
      "tab.newEditor": () => setNewEditorOpen(true),
      "tab.close": handleCloseTabOrPane,
      "tab.next": () => cycleTab(1),
      "tab.prev": () => cycleTab(-1),
      "tab.selectByIndex": (e) => selectByIndex(parseInt(e.key, 10) - 1),
      "pane.splitRight": () => splitActivePaneInActiveTab("row"),
      "pane.splitDown": () => splitActivePaneInActiveTab("col"),
      "pane.focusNext": () => focusNextPaneInTab(activeId, 1),
      "pane.focusPrev": () => focusNextPaneInTab(activeId, -1),
      "pane.source": toggleSourceControl,
      "terminal.clear": () => {
        clearFocusedTerminal();
      },
      "block.copyCommand": copyLastCommand,
      "block.copyOutput": copyLastCommandOutput,
      "block.copyBoth": copyLastCommandBoth,
      "block.reinput": reinputLastCommand,
      "block.selectPrev": selectPrevBlock,
      "block.selectNext": selectNextBlock,
      "search.focus": () => searchInlineRef.current?.focus(),
      "ai.toggle": togglePanelAndFocus,
      "ai.askSelection": askFromSelection,
      "palette.open": () => setPaletteOpen((v) => !v),
      "shortcuts.open": () => setShortcutsOpen((v) => !v),
      "settings.open": () => {
        const settingsTab = tabsRef.current.find((t) => t.kind === "settings");
        if (!settingsTab) openSettingsTab();
        else if (settingsTab.id === activeId) closeSettingsTab();
        else setActiveId(settingsTab.id);
      },
      "sidebar.toggle": toggleSidebar,
      "explorer.focus": toggleExplorerFocus,
      "view.zoomIn": zoomIn,
      "view.zoomOut": zoomOut,
      "view.zoomReset": zoomReset,
      "editor.undo": () => editorRefs.current.get(activeId)?.undo(),
      "editor.redo": () => editorRefs.current.get(activeId)?.redo(),
    }),
    [
      activeId,
      cycleTab,
      handleCloseTabOrPane,
      openNewTab,
      openNewPrivateTab,
      openSettingsTab,
      closeSettingsTab,
      setActiveId,
      selectByIndex,
      splitActivePaneInActiveTab,
      focusNextPaneInTab,
      toggleSourceControl,
      togglePanelAndFocus,
      askFromSelection,
      toggleSidebar,
      toggleExplorerFocus,
      copyLastCommand,
      copyLastCommandOutput,
      copyLastCommandBoth,
      reinputLastCommand,
      selectPrevBlock,
      selectNextBlock,
      zoomIn,
      zoomOut,
      zoomReset,
    ],
  );

  const shortcutsDisabled = useCallback(
    (id: ShortcutId, e: KeyboardEvent) => {
      if (id === "editor.undo" || id === "editor.redo") {
        return activeTab?.kind !== "editor";
      }
      if (id === "ai.askSelection") {
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        const inTerminal = !!(target as HTMLElement | null)?.closest?.(
          ".xterm",
        );
        if (!inTerminal) return false;
        const sel = captureActiveSelection();
        return !sel || !sel.trim();
      }
      if (id === "terminal.clear") {
        // Only intercept ⌘K while a terminal is focused; elsewhere let the key
        // fall through (we never preventDefault when disabled).
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        return !(target as HTMLElement | null)?.closest?.(".xterm");
      }
      if (id === "block.selectPrev" || id === "block.selectNext") {
        // Block navigation (Cmd+↑/↓) only applies inside a focused terminal —
        // elsewhere let the arrows behave normally (editor, AI panel, lists).
        const target =
          (e.target as HTMLElement | null) ?? document.activeElement;
        return !(target as HTMLElement | null)?.closest?.(".xterm");
      }
      return false;
    },
    [activeTab],
  );

  useGlobalShortcuts(shortcutHandlers, { isDisabled: shortcutsDisabled });

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const out: PaletteCommand[] = [];
    for (const s of SHORTCUTS) {
      if (PALETTE_EXCLUDED_SHORTCUTS.has(s.id)) continue;
      const run = shortcutHandlers[s.id];
      if (!run) continue;
      const binding = (userShortcuts[s.id] ?? s.defaultBindings)[0];
      out.push({
        id: s.id,
        label: s.label,
        bindingTokens: getBindingTokens(binding),
        run: () => {
          setPaletteOpen(false);
          // Handlers ignore the event except the excluded ones; pass a synthetic
          // keydown so the (e) => void signature is satisfied without a real key.
          run(new KeyboardEvent("keydown"));
        },
      });
    }
    return out;
  }, [shortcutHandlers, userShortcuts]);

  // Flat workspace file list for the palette's Files group. Loaded lazily when
  // the palette opens (fs_list_files caps at 2000 relative paths by default).
  const { files: paletteRelFiles } = useWorkspaceFiles(
    explorerRoot,
    paletteOpen,
  );
  const paletteFiles = useMemo<PaletteFile[]>(() => {
    if (!explorerRoot) return [];
    const root = explorerRoot.endsWith("/")
      ? explorerRoot
      : `${explorerRoot}/`;
    return paletteRelFiles.map((rel) => {
      const slash = rel.lastIndexOf("/");
      return {
        path: `${root}${rel}`,
        name: slash === -1 ? rel : rel.slice(slash + 1),
      };
    });
  }, [explorerRoot, paletteRelFiles]);

  const registerTerminalHandle = useCallback(
    (leafId: number, h: TerminalPaneHandle | null) => {
      if (h) terminalRefs.current.set(leafId, h);
      else terminalRefs.current.delete(leafId);
    },
    [],
  );

  const registerEditorHandle = useCallback(
    (id: number, h: EditorPaneHandle | null) => {
      if (h) editorRefs.current.set(id, h);
      else editorRefs.current.delete(id);
      if (id === activeId) setActiveEditorHandle(h);
    },
    [activeId],
  );

  const authorizedCwds = useLazyRef(() => new Set<string>());
  const handleTerminalCwd = useCallback(
    (leafId: number, cwd: string, remote: boolean) => {
      // A remote (SSH) cwd is for display only: reflect it on the tab, but
      // never touch the local explorer or authorize it as a local workspace —
      // the path doesn't exist on this machine.
      if (remote) {
        setRemoteCwd(leafId, cwd);
        return;
      }
      setRemoteCwd(leafId, null);
      setLeafCwd(leafId, cwd);
      if (cwd && !authorizedCwds.current.has(cwd)) {
        authorizedCwds.current.add(cwd);
        native.workspaceAuthorize(cwd).catch(() => {
          authorizedCwds.current.delete(cwd);
        });
      }
    },
    [setLeafCwd, setRemoteCwd],
  );

  const handleTerminalSshHost = useCallback(
    (leafId: number, host: string | null) => setSshHost(leafId, host),
    [setSshHost],
  );

  const handleFocusLeaf = useCallback(
    (tabId: number, leafId: number) => focusPane(tabId, leafId),
    [focusPane],
  );

  const onActivateAgent = useCallback(
    (tabId: number, leafId: number) => {
      setActiveId(tabId);
      focusPane(tabId, leafId);
    },
    [setActiveId, focusPane],
  );

  const onActivateLocalAgent = useCallback(() => {
    openPanel();
    focusInput(null);
  }, [openPanel, focusInput]);

  const handleLeafExit = useCallback(
    (leafId: number, _code: number) => {
      const all = tabsRef.current;
      const tab = all.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
      );
      if (!tab || tab.kind !== "terminal") return;
      const isLast =
        leafIds(tab.paneTree).length === 1 &&
        all.filter((t) => t.kind === "terminal").length === 1;
      if (isLast) {
        void respawnSession(leafId, tab.cwd);
      } else {
        closePaneByLeaf(leafId);
      }
    },
    [closePaneByLeaf],
  );

  const handleEditorDirty = useCallback(
    (id: number, dirty: boolean) => updateTab(id, { dirty }),
    [updateTab],
  );

  const renameTab = useCallback(
    (id: number, name: string) => updateTab(id, { customTitle: name }),
    [updateTab],
  );

  const searchTarget = useMemo<SearchTarget>(() => {
    if (isTerminalTab && activeLeafId !== null && activeSearchAddon)
      return {
        kind: "terminal",
        addon: activeSearchAddon,
        focus: () => terminalRefs.current.get(activeLeafId)?.focus(),
      };
    if (isEditorTab && activeEditorHandle)
      return {
        kind: "editor",
        handle: activeEditorHandle,
        focus: () => activeEditorHandle.focus(),
      };
    if (isGitHistoryTab && gitHistoryHandle)
      return {
        kind: "git-history",
        handle: gitHistoryHandle,
        focus: () => {},
      };
    return null;
  }, [
    isTerminalTab,
    isEditorTab,
    isGitHistoryTab,
    activeLeafId,
    activeSearchAddon,
    activeEditorHandle,
    gitHistoryHandle,
  ]);

  const activeCwd = activeTerminalLeafCwd;

  useEffect(() => {
    const findCwd = () => {
      const active = tabs.find((x) => x.id === activeId);
      if (active?.kind === "terminal") {
        return findLeafCwd(active.paneTree, active.activeLeafId) ?? active.cwd ?? null;
      }
      for (let i = tabs.length - 1; i >= 0; i--) {
        const t = tabs[i];
        if (t.kind !== "terminal") continue;
        const cwd = findLeafCwd(t.paneTree, t.activeLeafId) ?? t.cwd;
        if (cwd) return cwd;
      }
      return explorerRoot ?? launchCwd ?? home ?? null;
    };

    setLive({
      getCwd: findCwd,
      getTerminalContext: () => {
        const t = tabs.find((x) => x.id === activeId);
        if (t?.kind !== "terminal") return null;
        if (t.private) return null;
        const buf = terminalRefs.current.get(t.activeLeafId)?.getBuffer(300);
        return buf ? redactSensitive(buf) : null;
      },
      isActiveTerminalPrivate: () => {
        const t = tabs.find((x) => x.id === activeId);
        return t?.kind === "terminal" && t.private === true;
      },
      injectIntoActivePty: (text) => {
        const t = tabs.find((x) => x.id === activeId);
        if (t?.kind !== "terminal") return false;
        const term = terminalRefs.current.get(t.activeLeafId);
        if (!term) return false;
        term.write(text);
        term.focus();
        return true;
      },
      getWorkspaceRoot: () => explorerRoot ?? launchCwd ?? home ?? null,
      getActiveFile: () => {
        const t = tabs.find((x) => x.id === activeId);
        return t?.kind === "editor" ? t.path : null;
      },
      spawnManagedAgent: (prompt: string, sessionId: string) => {
        const trimmed = prompt.trim();
        if (!trimmed) return null;
        const oneLine = trimmed.replace(/\s*\r?\n\s*/g, " ");
        const cwd = findCwd();
        const short = oneLine.length > 32 ? `${oneLine.slice(0, 32)}…` : oneLine;
        const { tabId, leafId } = newAgentTab(cwd ?? undefined, `claude · ${short}`);
        useManagedAgentsStore
          .getState()
          .register({ leafId, tabId, sessionId, task: oneLine, cwd });
        const hooksReady = invoke("agent_enable_claude_hooks").catch(() => {});
        void (async () => {
          await Promise.all([whenSessionReady(leafId), hooksReady]);
          if (!writeToSession(leafId, "claude\r")) {
            useManagedAgentsStore.getState().remove(leafId);
            return;
          }
          const readBuf = () => {
            const term = terminalRefs.current.get(leafId);
            return term ? term.getBuffer(120) : null;
          };
          const result = await waitForClaudeTuiReady(readBuf);
          if (result !== "ready") {
            if (result === "timeout") {
              console.warn(
                "[termul] Claude TUI did not appear in time; aborting prompt send",
              );
            }
            useManagedAgentsStore.getState().remove(leafId);
            return;
          }
          if (!writeToSession(leafId, `\x1b[200~${trimmed}\x1b[201~`)) {
            useManagedAgentsStore.getState().remove(leafId);
            return;
          }
          setTimeout(() => writeToSession(leafId, "\r"), 120);
          useManagedAgentsStore.getState().setPhase(leafId, "working");
        })();
        return { tabId, leafId };
      },
      readLeafBuffer: (leafId: number) => {
        const buf = terminalRefs.current.get(leafId)?.getBuffer(300);
        return buf ? redactSensitive(buf) : null;
      },
    });
  }, [
    setLive,
    activeId,
    tabs,
    explorerRoot,
    launchCwd,
    home,
    newAgentTab,
  ]);

  const workspaceSurface = (
    <div className="relative h-full min-h-0">
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isTerminalTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isTerminalTab}
      >
        <TerminalStack
          tabs={tabs}
          activeId={activeId}
          dimInactivePanes={dimInactivePanes}
          registerHandle={registerTerminalHandle}
          onSearchReady={handleSearchReady}
          onCwd={handleTerminalCwd}
          onSshHost={handleTerminalSshHost}
          onExit={handleLeafExit}
          onFocusLeaf={handleFocusLeaf}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isEditorTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isEditorTab}
      >
        <EditorStack
          tabs={tabs}
          activeId={activeId}
          registerHandle={registerEditorHandle}
          onDirtyChange={handleEditorDirty}
          onCloseTab={disposeTab}
          onOpenPreview={openMarkdownPreview}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isMarkdownTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isMarkdownTab}
      >
        <MarkdownStack
          tabs={tabs}
          activeId={activeId}
          onOpenEditor={openMarkdownEditor}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isPdfTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isPdfTab}
      >
        <PdfStack tabs={tabs} activeId={activeId} />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isImageTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isImageTab}
      >
        <ImageStack tabs={tabs} activeId={activeId} />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isAiDiffTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isAiDiffTab}
      >
        <AiDiffStack
          tabs={tabs}
          activeId={activeId}
          onAccept={(id) => respondToApproval(id, true)}
          onReject={(id) => respondToApproval(id, false)}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0 px-3 pt-2 pb-2",
          !isGitDiffTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isGitDiffTab}
      >
        <GitDiffStack tabs={tabs} activeId={activeId} />
      </div>
      <div
        className={cn(
          "absolute inset-0",
          !isGitHistoryTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isGitHistoryTab}
      >
        <GitHistoryStack
          tabs={tabs}
          activeId={activeId}
          onOpenCommitFile={openCommitFileDiffTab}
          onSearchHandle={setGitHistoryHandle}
        />
      </div>
      <div
        className={cn(
          "absolute inset-0",
          !isSettingsTab && "invisible pointer-events-none",
        )}
        aria-hidden={!isSettingsTab}
      >
        <SettingsStack
          tabs={tabs}
          activeId={activeId}
          onSectionChange={setSettingsSection}
          onRequestClose={closeSettingsTab}
        />
      </div>
    </div>
  );

  const shell = (
    <ThemeProvider>
      <TooltipProvider>
        <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
          <Header
            tabs={tabs}
            activeId={activeId}
            onSelect={setActiveId}
            onNew={openNewTab}
            onNewPrivate={openNewPrivateTab}
            onNewEditor={openNewEditor}
            onNewGitGraph={openGitGraphFromContext}
            onClose={handleClose}
            onPin={pinTab}
            onRename={renameTab}
            onToggleSpill={setTabSpillToDisk}
            onReorder={reorderTab}
            groupControls={groupControls}
            onToggleSidebar={toggleSidebar}
            onSplit={splitActivePaneInActiveTab}
            canSplit={
              activeTerminalTab !== null &&
              leafIds(activeTerminalTab.paneTree).length < maxPanesPerTab
            }
            onActivateAgent={onActivateAgent}
            onActivateLocalAgent={onActivateLocalAgent}
            onOpenSettings={handleOpenSettings}
            searchTarget={searchTarget}
            searchRef={searchInlineRef}
          />

          <main className="zoom-content flex min-h-0 flex-1 flex-col">
            <PortalContainerProvider container={zoomPortalContainer}>
              {/* display:contents so it adds zero layout/paint/stacking: Radix
               * appends position:fixed overlays here, inside the zoom layer. */}
              <div ref={setZoomPortalContainer} className="contents" />
              <ResizablePanelGroup
                orientation="horizontal"
                className="min-h-0 flex-1"
              >
                {tabBarPosition === "left" && (
                  <>
                    <ResizablePanel
                      id="tab-column"
                      panelRef={tabColumnRef}
                      defaultSize={`${tabColumnWidthRef.current}px`}
                      minSize={`${Math.round(TABCOL_MIN_WIDTH / sidebarZoom)}px`}
                      maxSize={`${Math.round(TABCOL_MAX_WIDTH / sidebarZoom)}px`}
                      onResize={(size) => {
                        if (size.inPixels > 0) persistTabColumnWidth(size.inPixels);
                      }}
                    >
                      <div className="flex h-full min-h-0 flex-col border-r border-border/60 bg-card">
                        <TabBar
                          orientation="vertical"
                          tabs={tabs}
                          activeId={activeId}
                          onSelect={setActiveId}
                          onNew={openNewTab}
                          onNewPrivate={openNewPrivateTab}
                          onNewEditor={openNewEditor}
                          onNewGitGraph={openGitGraphFromContext}
                          onClose={handleClose}
                          onPin={pinTab}
                          onRename={renameTab}
                          onToggleSpill={setTabSpillToDisk}
                          onReorder={reorderTab}
                          groupControls={groupControls}
                        />
                      </div>
                    </ResizablePanel>
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="Resize tab bar"
                      onPointerDown={handleTabColumnResizeStart}
                      onDoubleClick={() =>
                        tabColumnRef.current?.resize(
                          `${Math.round(TABCOL_DEFAULT_WIDTH / sidebarZoom)}px`,
                        )
                      }
                      style={{ width: `${Math.round(10 / sidebarZoom)}px` }}
                      className="group relative z-20 flex shrink-0 cursor-col-resize touch-none select-none items-center justify-center bg-transparent"
                    >
                      <div className="pointer-events-none h-full w-px bg-border/60 transition-colors group-hover:bg-primary" />
                    </div>
                  </>
                )}
                <ResizablePanel
                  id="sidebar"
                  panelRef={sidebarRef}
                  defaultSize={`${sidebarWidthRef.current}px`}
                  minSize={`${Math.round(SIDEBAR_MIN_WIDTH / sidebarZoom)}px`}
                  maxSize={`${Math.round(SIDEBAR_MAX_WIDTH / sidebarZoom)}px`}
                  collapsible
                  collapsedSize={0}
                  onResize={(size) => {
                    if (size.inPixels > 0) persistSidebarWidth(size.inPixels);
                  }}
                >
                  <div className="flex h-full min-h-0 flex-col border-r border-border/60 bg-card">
                    <div className="min-h-0 flex-1">
                      {sidebarView === "explorer" ? (
                        <FileExplorer
                          ref={explorerRef}
                          rootPath={effectiveExplorerRoot}
                          sshStatus={sshExplorerStatus}
                          onRetrySsh={retrySshExplorer}
                          onOpenFile={handleOpenFile}
                          onPathRenamed={handlePathRenamed}
                          onPathDeleted={handlePathDeleted}
                          onRevealInTerminal={cdInNewTab}
                          onAttachToAgent={handleAttachFileToAgent}
                          onOpenMarkdownPreview={openMarkdownPreview}
                        />
                      ) : (
                        <SourceControlPanel
                          open
                          sourceControl={sourceControl}
                          onOpenDiff={openGitDiffTab}
                          onOpenGitGraph={openGitGraphFromContext}
                        />
                      )}
                    </div>
                    <SidebarRail
                      activeView={sidebarView}
                      onSelectView={persistSidebarView}
                      changedCount={sourceControl.changedCount}
                    />
                  </div>
                </ResizablePanel>
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize sidebar"
                  onPointerDown={handleSidebarResizeStart}
                  onDoubleClick={() =>
                    sidebarRef.current?.resize(
                      `${Math.round(SIDEBAR_DEFAULT_WIDTH / sidebarZoom)}px`,
                    )
                  }
                  // Hit area holds a constant ~10px on-screen width regardless of
                  // CSS `zoom`; otherwise a thin handle becomes ungrabbable when
                  // zoomed out (the pointer hit-test resolves to the panel behind
                  // it). The visible line stays slim via the inner element.
                  style={{ width: `${Math.round(10 / sidebarZoom)}px` }}
                  className="group relative z-20 flex shrink-0 cursor-col-resize touch-none select-none items-center justify-center bg-transparent"
                >
                  <div className="pointer-events-none h-full w-px bg-border/60 transition-colors group-hover:bg-primary" />
                </div>
                <ResizablePanel id="workspace" defaultSize="78%" minSize="30%">
                  <div className="flex h-full min-h-0 flex-col">
                    <div className="relative min-h-0 flex-1">
                      {workspaceSurface}
                    </div>

                    {keysLoaded ? (
                      <motion.div
                        data-ai-input-bar
                        initial={false}
                        animate={{
                          height: panelOpen ? "auto" : 0,
                          opacity: panelOpen ? 1 : 0,
                        }}
                        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                        className="overflow-hidden"
                        aria-hidden={!panelOpen}
                      >
                        {hasComposer ? (
                          <AiInputBar />
                        ) : (
                          <AiInputBarConnect
                            onAdd={() => openSettings("models")}
                          />
                        )}
                      </motion.div>
                    ) : null}
                  </div>
                </ResizablePanel>
              </ResizablePanelGroup>
            </PortalContainerProvider>
          </main>

          <StatusBar
            cwd={activeCwd}
            remoteCwd={activeRemoteCwd}
            sshHost={activeSshHost}
            filePath={activeFilePath}
            home={home}
            onCd={sendCd}
            onWorkspaceChange={switchWorkspace}
            onOpenMini={openMini}
            hasComposer={hasComposer}
            privateActive={
              activeTab?.kind === "terminal" && activeTab.private === true
            }
          />

          <AgentNotificationsBridge
            tabs={tabs}
            activeId={activeId}
            onActivate={onActivateAgent}
          />
          <Toaster position="bottom-right" />

          {hasComposer ? (
            <>
              <AgentRunBridge
                openAiDiffTab={openAiDiffTab}
                closeAiDiffTab={closeAiDiffTab}
              />
              <LocalAgentNotificationsBridge />
            </>
          ) : null}

          <AnimatePresence>
            {miniOpen && hasComposer ? <AiMiniWindow key="ai-mini" /> : null}
            {askPopup ? (
              <SelectionAskAi
                key="ask-ai-popup"
                x={askPopup.x}
                y={askPopup.y}
                onAsk={onAskFromSelection}
                onDismiss={() => setAskPopup(null)}
              />
            ) : null}
          </AnimatePresence>

          <ShortcutsDialog
            open={shortcutsOpen}
            onOpenChange={setShortcutsOpen}
          />

          <NewEditorDialog
            open={newEditorOpen}
            onOpenChange={setNewEditorOpen}
            rootPath={explorerRoot ?? home}
            onCreated={(path) => openFileTab(path)}
          />

          <UpdaterDialog />

          <TabSearch
            tabs={tabs}
            activeId={activeId}
            onSelect={switchToTab}
            open={tabSearchOpen}
            onOpenChange={setTabSearchOpen}
            onCopyLastCommand={copyLastCommand}
            onCopyLastCommandOutput={copyLastCommandOutput}
          />

          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            tabs={tabs}
            activeId={activeId}
            onSelectTab={switchToTab}
            commands={paletteCommands}
            files={paletteFiles}
            onOpenFile={(path) => openFileTab(path)}
          />

          <AlertDialog
            open={pendingCloseTab !== null}
            onOpenChange={(open) => !open && cancelClose()}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
                <AlertDialogDescription>
                  {tabs.find((t) => t.id === pendingCloseTab)?.title
                    ? `"${
                        tabs.find((t) => t.id === pendingCloseTab)?.title
                      }" has unsaved changes. Close anyway?`
                    : "This file has unsaved changes. Close anyway?"}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={cancelClose}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction onClick={confirmClose}>
                  Close Anyway
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog
            open={pendingDeleteTabs !== null}
            onOpenChange={(open) => !open && cancelDeleteClose()}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
                <AlertDialogDescription>
                  {pendingDeleteTabs?.length === 1
                    ? (() => {
                        const title = tabs.find(
                          (t) => t.id === pendingDeleteTabs[0],
                        )?.title;
                        return title
                          ? `"${title}" has unsaved changes. The file has been deleted. Close anyway?`
                          : "This file has unsaved changes. The file has been deleted. Close anyway?";
                      })()
                    : `${pendingDeleteTabs?.length ?? 0} files have unsaved changes. They have been deleted. Close all anyway?`}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={cancelDeleteClose}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction onClick={confirmDeleteClose}>
                  Close Anyway
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog open={confirmQuitOpen} onOpenChange={setConfirmQuitOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Close Termul?</AlertDialogTitle>
                <AlertDialogDescription>
                  Running processes will end.
                  {restoreSessionPref
                    ? " Your tabs and layout will reopen on the next launch."
                    : ""}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel onClick={() => setConfirmQuitOpen(false)}>
                  Cancel
                </AlertDialogCancel>
                <AlertDialogAction onClick={() => void flushSessionAndDestroy()}>
                  Close
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );

  return (
    <MotionConfig reducedMotion="user">
      <AiComposerProvider>{shell}</AiComposerProvider>
    </MotionConfig>
  );
}
