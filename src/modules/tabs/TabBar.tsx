import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import {
  Cancel01Icon,
  Clock01Icon,
  ComputerTerminal02Icon,
  Database01Icon,
  FolderAddIcon,
  GitBranchIcon,
  GitCompareIcon,
  IncognitoIcon,
  PencilEdit02Icon,
  PlusSignIcon,
  RemoveSquareIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { GroupChip } from "./GroupChip";
import {
  buildTabRows,
  groupColorVar,
  type GroupColorId,
  type TabGroup,
  type TabGroupMap,
} from "./lib/groups";
import { labelFor, remoteIdentity } from "./lib/labelFor";
import type { EditorTab, Tab } from "./lib/useTabs";
import { TabRenameField } from "./TabRenameField";

export { labelFor };

/** Group state + actions the TabBar needs, bundled to keep prop-forwarding
 * (App → Header → TabBar) compact. */
export type TabGroupControls = {
  groups: TabGroup[];
  tabGroupOf: TabGroupMap;
  onCreateGroup: (tabId: number) => void;
  onAssignToGroup: (tabId: number, groupId: number) => void;
  onRemoveFromGroup: (tabId: number) => void;
  onRenameGroup: (groupId: number, name: string) => void;
  onRecolorGroup: (groupId: number, color: GroupColorId) => void;
  onToggleGroupCollapsed: (groupId: number) => void;
  onUngroup: (groupId: number) => void;
};

type Props = {
  tabs: Tab[];
  activeId: number;
  onSelect: (id: number) => void;
  onNew: () => void;
  onNewPrivate: () => void;
  onNewEditor: () => void;
  onNewGitGraph: () => void;
  onClose: (id: number) => void;
  /** Pin (promote) a preview tab to persistent on double-click. */
  onPin: (id: number) => void;
  /** Rename a terminal tab. Empty name reverts it to the dynamic cwd label. */
  onRename: (id: number, name: string) => void;
  /** Toggle a terminal tab's "keep full output to disk" spill. */
  onToggleSpill: (id: number, value: boolean) => void;
  /** Reorder a dragged tab before/after the target tab. */
  onReorder: (
    draggedId: number,
    targetId: number,
    place: "before" | "after",
  ) => void;
  /** Tab-group state and actions (membership, create/assign/recolor/collapse). */
  groupControls: TabGroupControls;
  compact?: boolean;
};

type DragOver = { id: number; place: "before" | "after" };

/** Hit-test the tab under the pointer and which half (left/right) it is over. */
function dropTargetAt(clientX: number, clientY: number): DragOver | null {
  const el = (
    document.elementFromPoint(clientX, clientY) as HTMLElement | null
  )?.closest<HTMLElement>("[data-tab-id]");
  if (!el) return null;
  const id = Number(el.dataset.tabId);
  if (Number.isNaN(id)) return null;
  const rect = el.getBoundingClientRect();
  const place = clientX < rect.left + rect.width / 2 ? "before" : "after";
  return { id, place };
}

export function TabBar({
  tabs,
  activeId,
  onSelect,
  onNew,
  onNewPrivate,
  onNewEditor,
  onNewGitGraph,
  onClose,
  onPin,
  onRename,
  onToggleSpill,
  onReorder,
  groupControls,
  compact,
}: Props) {
  const { groups, tabGroupOf } = groupControls;
  const scrollRef = useRef<HTMLDivElement>(null);
  // Pointer-based reorder. HTML5 drag-and-drop does not fire inside the Tauri
  // webview (native drag-drop is enabled for the terminal file-drop feature),
  // so the gesture is tracked with pointer events instead.
  const dragRef = useRef<{
    id: number;
    startX: number;
    pointerId: number;
    active: boolean;
  } | null>(null);
  // Swallows the click synthesized after a reorder so it does not select a tab.
  const justDraggedRef = useRef(false);
  const [dragOver, setDragOver] = useState<DragOver | null>(null);
  // Id of the terminal tab whose title is being edited inline (null = none).
  const [editingId, setEditingId] = useState<number | null>(null);
  // Id of the group whose name is being edited inline (null = none).
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);

  const startRename = (id: number) => {
    onSelect(id);
    setEditingId(id);
  };

  // Horizontal wheel scroll without holding shift.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the active tab visible after selection / open.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const active = el.querySelector<HTMLElement>(`[data-tab-id="${activeId}"]`);
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  return (
    <div
      ref={scrollRef}
      data-tauri-drag-region
      className="min-w-0 shrink overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div className="flex w-max items-center gap-0.5">
        <Tabs
          value={String(activeId)}
          onValueChange={(v) => {
            // Ignore the click synthesized at the end of a drag reorder.
            if (justDraggedRef.current) return;
            onSelect(Number(v));
          }}
        >
          <TabsList className="h-7 w-max gap-0.5 bg-transparent p-0">
            {buildTabRows(tabs, groups, tabGroupOf).map((row) => {
              if (row.kind === "group") {
                const g = row.group;
                return (
                  <GroupChip
                    key={`group-${g.id}`}
                    group={g}
                    count={row.count}
                    editing={editingGroupId === g.id}
                    onStartRename={() => setEditingGroupId(g.id)}
                    onCommitRename={(name) => {
                      groupControls.onRenameGroup(g.id, name);
                      setEditingGroupId(null);
                    }}
                    onCancelRename={() => setEditingGroupId(null)}
                    onToggleCollapsed={() =>
                      groupControls.onToggleGroupCollapsed(g.id)
                    }
                    onRecolor={(c) => groupControls.onRecolorGroup(g.id, c)}
                    onUngroup={() => groupControls.onUngroup(g.id)}
                  />
                );
              }
              const t = row.tab;
              const isPreview = t.kind === "editor" && (t as EditorTab).preview;
              const remote = remoteIdentity(t);
              const memberGroupId = tabGroupOf[t.id];
              const memberColor =
                memberGroupId != null
                  ? groups.find((g) => g.id === memberGroupId)?.color
                  : undefined;

              // Inline rename field (terminal tabs only). Rendered in place of
              // the trigger so we never nest an <input> inside a <button>.
              if (t.kind === "terminal" && editingId === t.id) {
                const dynamic = t.cwd
                  ? (t.cwd.split(/[\\/]/).filter(Boolean).pop() ?? "/")
                  : t.title;
                return (
                  <div
                    key={t.id}
                    data-tab-id={t.id}
                    className={cn(
                      "flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-foreground/15 text-xs text-foreground",
                      compact ? "px-1.5" : "px-2",
                    )}
                  >
                    <TabIcon tab={t} />
                    <TabRenameField
                      initial={t.customTitle ?? ""}
                      placeholder={dynamic}
                      onCommit={(name) => {
                        onRename(t.id, name);
                        setEditingId(null);
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  </div>
                );
              }

              return (
                <ContextMenu key={t.id}>
                  <ContextMenuTrigger asChild>
                    <TabsTrigger
                      value={String(t.id)}
                      data-tab-id={t.id}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        dragRef.current = {
                          id: t.id,
                          startX: e.clientX,
                          pointerId: e.pointerId,
                          active: false,
                        };
                      }}
                      onPointerMove={(e) => {
                        const st = dragRef.current;
                        if (!st) return;
                        if (!st.active) {
                          // Distinguish a drag from a click before capturing.
                          if (Math.abs(e.clientX - st.startX) < 4) return;
                          st.active = true;
                          e.currentTarget.setPointerCapture?.(st.pointerId);
                        }
                        const over = dropTargetAt(e.clientX, e.clientY);
                        const next = over && over.id !== st.id ? over : null;
                        setDragOver((prev) =>
                          prev?.id === next?.id && prev?.place === next?.place
                            ? prev
                            : next,
                        );
                      }}
                      onPointerUp={(e) => {
                        const st = dragRef.current;
                        dragRef.current = null;
                        if (!st?.active) return;
                        e.currentTarget.releasePointerCapture?.(st.pointerId);
                        const over = dragOver;
                        setDragOver(null);
                        if (over && over.id !== st.id) {
                          onReorder(st.id, over.id, over.place);
                        }
                        // The browser fires a click after pointerup; suppress
                        // the tab selection it would otherwise trigger.
                        justDraggedRef.current = true;
                        window.setTimeout(() => {
                          justDraggedRef.current = false;
                        }, 0);
                      }}
                      onPointerCancel={() => {
                        dragRef.current = null;
                        setDragOver(null);
                      }}
                      onDoubleClick={() => {
                        if (isPreview) onPin(t.id);
                        else if (t.kind === "terminal") startRename(t.id);
                      }}
                      onAuxClick={(e) => {
                        if (e.button === 1 && tabs.length > 1) {
                          e.preventDefault();
                          e.stopPropagation();
                          onClose(t.id);
                        }
                      }}
                      onMouseDown={(e) => {
                        if (e.button === 1) e.preventDefault();
                      }}
                      style={
                        memberColor
                          ? {
                              boxShadow: `inset 0 -2px 0 ${groupColorVar(memberColor)}`,
                            }
                          : undefined
                      }
                      // Active fill is a translucent foreground overlay, not
                      // bg-accent: the tab strip sits on the bg-card titlebar and
                      // accent (only ~1.17:1 against card) reads as flat there.
                      // foreground/15 lifts the active tab clearly in both themes.
                      className={cn(
                        "group relative h-7 shrink-0 gap-1.5 rounded-md text-xs text-muted-foreground transition-colors data-[state=active]:bg-foreground/15 data-[state=active]:text-foreground dark:data-[state=active]:bg-foreground/15 dark:data-[state=active]:text-foreground data-[state=inactive]:hover:bg-foreground/8 hover:text-foreground/80 justify-between",
                        compact
                          ? "px-1.5!"
                          : tabs.length === 1
                            ? "px-2!"
                            : "ps-2! pe-1!",
                      )}
                    >
                      {dragOver?.id === t.id && (
                        <span
                          aria-hidden
                          className={cn(
                            "pointer-events-none absolute inset-y-1 w-0.5 rounded-full bg-primary",
                            dragOver.place === "before"
                              ? "-left-px"
                              : "-right-px",
                          )}
                        />
                      )}
                      <span
                        className={cn(
                          "flex items-center gap-1.5 truncate",
                          compact ? "max-w-48" : "max-w-80",
                        )}
                        title={remote ? `${remote.host}:${remote.path}` : undefined}
                      >
                        <TabIcon tab={t} />
                        {/* Preview tabs use italic to signal the transient
                            state, matching the convention from VSCode. */}
                        <span className={cn("truncate", isPreview && "italic")}>
                          {labelFor(t)}
                        </span>
                        {/* A remote (SSH) file tab carries a small host badge so
                            it's distinguishable from a same-named local file. */}
                        {remote ? (
                          <span
                            className="shrink-0 rounded bg-muted px-1 text-[9px] leading-tight text-muted-foreground"
                            aria-label={`Remote host ${remote.host}`}
                          >
                            {remote.host}
                          </span>
                        ) : null}
                        {t.kind === "editor" && t.dirty ? (
                          <span
                            aria-label="Unsaved changes"
                            className="size-1.5 shrink-0 rounded-full bg-foreground/70"
                          />
                        ) : null}
                      </span>
                      {tabs.length > 1 && (
                        <span
                          role="button"
                          tabIndex={0}
                          aria-label="Close tab"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            onClose(t.id);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              e.stopPropagation();
                              onClose(t.id);
                            }
                          }}
                          className="rounded p-0.5 opacity-0 transition-opacity hover:bg-accent hover:opacity-100 group-hover:opacity-60"
                        >
                          <HugeiconsIcon
                            icon={Cancel01Icon}
                            size={11}
                            strokeWidth={2}
                          />
                        </span>
                      )}
                    </TabsTrigger>
                  </ContextMenuTrigger>
                  <ContextMenuContent className="min-w-44">
                    {t.kind === "terminal" && (
                      <ContextMenuItem onSelect={() => startRename(t.id)}>
                        <HugeiconsIcon
                          icon={PencilEdit02Icon}
                          size={14}
                          strokeWidth={1.75}
                        />
                        Rename
                      </ContextMenuItem>
                    )}
                    {t.kind === "terminal" && (
                      <ContextMenuCheckboxItem
                        checked={t.spillToDisk ?? false}
                        onCheckedChange={(v) =>
                          onToggleSpill(t.id, v === true)
                        }
                      >
                        <HugeiconsIcon
                          icon={Database01Icon}
                          size={14}
                          strokeWidth={1.75}
                        />
                        Keep full output (disk)
                      </ContextMenuCheckboxItem>
                    )}
                    <ContextMenuSub>
                      <ContextMenuSubTrigger>
                        <HugeiconsIcon
                          icon={FolderAddIcon}
                          size={14}
                          strokeWidth={1.75}
                        />
                        Add to group
                      </ContextMenuSubTrigger>
                      <ContextMenuSubContent className="min-w-40">
                        {groups
                          .filter((g) => g.id !== memberGroupId)
                          .map((g) => (
                            <ContextMenuItem
                              key={g.id}
                              onSelect={() =>
                                groupControls.onAssignToGroup(t.id, g.id)
                              }
                            >
                              <span
                                className="size-2.5 shrink-0 rounded-full"
                                style={{
                                  backgroundColor: groupColorVar(g.color),
                                }}
                              />
                              <span className="truncate">{g.name}</span>
                            </ContextMenuItem>
                          ))}
                        {groups.some((g) => g.id !== memberGroupId) && (
                          <ContextMenuSeparator />
                        )}
                        <ContextMenuItem
                          onSelect={() => groupControls.onCreateGroup(t.id)}
                        >
                          <HugeiconsIcon
                            icon={PlusSignIcon}
                            size={14}
                            strokeWidth={1.75}
                          />
                          New group
                        </ContextMenuItem>
                      </ContextMenuSubContent>
                    </ContextMenuSub>
                    {memberGroupId != null && (
                      <ContextMenuItem
                        onSelect={() => groupControls.onRemoveFromGroup(t.id)}
                      >
                        <HugeiconsIcon
                          icon={RemoveSquareIcon}
                          size={14}
                          strokeWidth={1.75}
                        />
                        Remove from group
                      </ContextMenuItem>
                    )}
                    {tabs.length > 1 && (
                      <>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          variant="destructive"
                          onSelect={() => onClose(t.id)}
                        >
                          <HugeiconsIcon
                            icon={Cancel01Icon}
                            size={14}
                            strokeWidth={1.75}
                          />
                          Close
                        </ContextMenuItem>
                      </>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              );
            })}
          </TabsList>
        </Tabs>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              title="New tab"
            >
              <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={2} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            <DropdownMenuItem onSelect={() => onNew()}>
              <HugeiconsIcon
                icon={ComputerTerminal02Icon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Terminal</span>
              <span className="text-xs text-muted-foreground">
                {fmtShortcut(MOD_KEY, "T")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewPrivate()}>
              <HugeiconsIcon
                icon={IncognitoIcon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Privacy</span>
              <span className="text-xs text-muted-foreground">
                {fmtShortcut(MOD_KEY, "R")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewEditor()}>
              <HugeiconsIcon
                icon={PencilEdit02Icon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1">Editor</span>
              <span className="text-xs text-muted-foreground">
                {fmtShortcut(MOD_KEY, "E")}
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onNewGitGraph()}>
              <HugeiconsIcon icon={GitBranchIcon} size={14} strokeWidth={1.75} />
              <span className="flex-1">Git Graph</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export function TabIcon({ tab }: { tab: Tab }) {
  if (
    tab.kind === "editor" ||
    tab.kind === "markdown" ||
    tab.kind === "pdf" ||
    tab.kind === "image"
  ) {
    const url = fileIconUrl(tab.title);
    return url ? <img src={url} alt="" className="size-3.5 shrink-0" /> : null;
  }
  if (tab.kind === "ai-diff") {
    return (
      <HugeiconsIcon
        icon={GitCompareIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "terminal" && tab.private) {
    return (
      <HugeiconsIcon
        icon={IncognitoIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "git-diff" || tab.kind === "git-commit-file") {
    return (
      <HugeiconsIcon
        icon={GitCompareIcon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "git-history") {
    return (
      <HugeiconsIcon
        icon={Clock01Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  if (tab.kind === "settings") {
    return (
      <HugeiconsIcon
        icon={Settings01Icon}
        size={14}
        strokeWidth={2}
        className="shrink-0"
      />
    );
  }
  return (
    <HugeiconsIcon
      icon={ComputerTerminal02Icon}
      size={14}
      strokeWidth={2}
      className="shrink-0"
    />
  );
}
