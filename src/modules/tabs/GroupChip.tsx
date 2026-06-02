import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Delete02Icon,
  PaintBoardIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  GROUP_COLORS,
  groupColorVar,
  type GroupColorId,
  type TabGroup,
} from "./lib/groups";
import { TabRenameField } from "./TabRenameField";

type Props = {
  group: TabGroup;
  count: number;
  editing: boolean;
  onStartRename: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onToggleCollapsed: () => void;
  onRecolor: (color: GroupColorId) => void;
  onUngroup: () => void;
};

/** The pill rendered at the start of a group's contiguous tab run. Clicking it
 * collapses/expands the run; right-click exposes rename/recolor/ungroup. The
 * collapse is render-only — member tabs stay mounted so their PTYs keep
 * streaming. */
export function GroupChip({
  group,
  count,
  editing,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onToggleCollapsed,
  onRecolor,
  onUngroup,
}: Props) {
  const accent = groupColorVar(group.color);
  const tint = `color-mix(in srgb, ${accent} 16%, transparent)`;

  if (editing) {
    return (
      <div
        className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs"
        style={{ backgroundColor: tint }}
      >
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: accent }}
        />
        <TabRenameField
          initial={group.name}
          placeholder="Group"
          className="w-24 min-w-0 border-0 bg-transparent p-0 text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      </div>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          data-group-id={group.id}
          onClick={onToggleCollapsed}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onStartRename();
          }}
          title={`${group.name} · ${count} tab${count === 1 ? "" : "s"}`}
          className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-foreground/80 transition-colors hover:text-foreground"
          style={{ backgroundColor: tint }}
        >
          <span
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: accent }}
          />
          <span className="max-w-32 truncate font-medium">{group.name}</span>
          <span className="text-muted-foreground">{count}</span>
          <HugeiconsIcon
            icon={group.collapsed ? ArrowRight01Icon : ArrowDown01Icon}
            size={12}
            strokeWidth={2}
          />
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-40">
        <ContextMenuItem onSelect={onStartRename}>
          <HugeiconsIcon icon={PencilEdit02Icon} size={14} strokeWidth={1.75} />
          Rename group
        </ContextMenuItem>
        <ContextMenuItem onSelect={onToggleCollapsed}>
          <HugeiconsIcon
            icon={group.collapsed ? ArrowDown01Icon : ArrowRight01Icon}
            size={14}
            strokeWidth={1.75}
          />
          {group.collapsed ? "Expand" : "Collapse"}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <HugeiconsIcon icon={PaintBoardIcon} size={14} strokeWidth={1.75} />
            Color
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-32">
            {GROUP_COLORS.map((c) => (
              <ContextMenuItem key={c.id} onSelect={() => onRecolor(c.id)}>
                <span
                  className={
                    c.id === group.color
                      ? "size-3 shrink-0 rounded-full ring-2 ring-ring ring-offset-1 ring-offset-popover"
                      : "size-3 shrink-0 rounded-full"
                  }
                  style={{ backgroundColor: `var(${c.cssVar})` }}
                />
                <span className="flex-1">{c.label}</span>
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onUngroup}>
          <HugeiconsIcon icon={Delete02Icon} size={14} strokeWidth={1.75} />
          Ungroup
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
