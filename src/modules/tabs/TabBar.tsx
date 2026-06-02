import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
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
  GitBranchIcon,
  GitCompareIcon,
  IncognitoIcon,
  PencilEdit02Icon,
  PlusSignIcon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { labelFor } from "./lib/labelFor";
import type { EditorTab, Tab } from "./lib/useTabs";

export { labelFor };

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
  /** Reorder a dragged tab before/after the target tab. */
  onReorder: (
    draggedId: number,
    targetId: number,
    place: "before" | "after",
  ) => void;
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
  onReorder,
  compact,
}: Props) {
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
            {tabs.map((t) => {
              const isPreview = t.kind === "editor" && (t as EditorTab).preview;

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
                      "flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-accent text-xs text-foreground",
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
                      className={cn(
                        "group relative h-7 shrink-0 gap-1.5 rounded-md text-xs text-muted-foreground transition-colors data-[state=active]:bg-accent data-[state=active]:text-foreground hover:text-foreground/80 justify-between",
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
                      >
                        <TabIcon tab={t} />
                        {/* Preview tabs use italic to signal the transient
                            state, matching the convention from VSCode. */}
                        <span className={cn("truncate", isPreview && "italic")}>
                          {labelFor(t)}
                        </span>
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
                  <ContextMenuContent className="min-w-36">
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
                    {tabs.length > 1 && (
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

/** Inline tab-title editor. Enter commits, Escape cancels, blur commits; an
 * empty value reverts the tab to its dynamic name. */
function TabRenameField({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter/Escape and the unmount blur can both fire; finalize only once.
  const doneRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };

  return (
    <input
      ref={inputRef}
      value={value}
      placeholder={placeholder}
      aria-label="Rename tab"
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      className="w-32 min-w-0 border-0 bg-transparent p-0 text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
    />
  );
}
