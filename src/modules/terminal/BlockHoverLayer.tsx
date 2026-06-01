import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  CodeIcon,
  Copy01Icon,
  FilterIcon,
  MoreVerticalIcon,
  Tick01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import type { BlockFrame } from "./lib/blockController";

type Action = "command" | "output";

type Props = {
  /** Only the focused, on-screen pane paints the overlay. */
  active: boolean;
  /** Geometry + status of the block to highlight, in client coords, or null. */
  getFrame: () => BlockFrame | null;
  /** Copy actions return whether anything was actually copied, so the toolbar
   * only flashes a success tick when there was content. */
  onCopyCommand: () => boolean;
  onCopyOutput: () => boolean;
  onCopyBoth: () => boolean;
  onReinput: () => void;
  onFilter: () => void;
  /** Fired when the ⋮ menu opens/closes so the host can pin the active block. */
  onMenuOpenChange: (open: boolean) => void;
};

/**
 * Warp-style per-block hover affordance: a full-width tint over the block the
 * pointer (or keyboard selection) is on, plus a floating toolbar pinned to its
 * top-right. Both are positioned every animation frame from `getFrame()` — a
 * single overlay element repositioned imperatively rather than 50 xterm
 * decorations, which would vanish the moment a block's start row scrolled off.
 */
export function BlockHoverLayer({
  active,
  getFrame,
  onCopyCommand,
  onCopyOutput,
  onCopyBoth,
  onReinput,
  onFilter,
  onMenuOpenChange,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);

  // Mirror the menu's open state into a ref the rAF loop can read. While open,
  // the toolbar freezes in place so moving the pointer into the (portaled) menu
  // doesn't clear the hover and yank the anchor out from under it.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuOpenRef = useRef(false);

  const [copied, setCopied] = useState<Action | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function hide() {
      if (highlightRef.current) highlightRef.current.style.display = "none";
      if (toolbarRef.current) toolbarRef.current.style.display = "none";
    }
    function position(frame: BlockFrame, rootRect: DOMRect) {
      const hl = highlightRef.current;
      const tb = toolbarRef.current;
      if (!hl || !tb) return;
      const top = frame.top - rootRect.top;
      const left = frame.left - rootRect.left;
      const failed = frame.exitCode !== null && frame.exitCode !== 0;

      hl.style.display = "block";
      hl.style.top = `${top}px`;
      hl.style.left = `${left}px`;
      hl.style.width = `${frame.width}px`;
      hl.style.height = `${frame.height}px`;
      hl.style.background = failed
        ? "color-mix(in srgb, var(--destructive) 9%, transparent)"
        : "color-mix(in srgb, var(--foreground) 5%, transparent)";
      hl.style.boxShadow = `inset 2px 0 0 0 ${
        failed
          ? "var(--destructive)"
          : "color-mix(in srgb, var(--foreground) 22%, transparent)"
      }`;

      tb.style.display = "flex";
      tb.style.top = `${top + 4}px`;
      tb.style.right = `${rootRect.right - (frame.left + frame.width) + 8}px`;

      const dot = dotRef.current;
      if (dot) {
        dot.style.background =
          frame.exitCode === null
            ? "var(--muted-foreground)"
            : failed
              ? "#ef4444"
              : "#10b981";
      }
      const label = labelRef.current;
      if (label) {
        if (frame.selection) {
          label.style.display = "";
          label.textContent = `${frame.selection.index + 1}/${frame.selection.total}`;
        } else {
          label.style.display = "none";
        }
      }
    }

    if (!active) {
      hide();
      return;
    }
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const frame = getFrame();
      // While the ⋮ menu is open, keep the toolbar pinned (so the pointer can
      // travel into the portaled menu) — but still hide once the block scrolls
      // fully out of view, e.g. under streaming output, so it doesn't float.
      if (menuOpenRef.current) {
        if (!frame) hide();
        return;
      }
      const root = rootRef.current;
      if (!frame || !root) {
        hide();
        return;
      }
      position(frame, root.getBoundingClientRect());
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, getFrame]);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const handleMenuOpen = (open: boolean) => {
    menuOpenRef.current = open;
    setMenuOpen(open);
    onMenuOpenChange(open);
  };

  // Flash the success tick only when the copy actually had content to write.
  const run = (which: Action, fn: () => boolean) => {
    if (!fn()) return;
    setCopied(which);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(null), 1100);
  };

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
    >
      <div
        ref={highlightRef}
        className="absolute rounded-[2px] transition-[background] duration-100"
        style={{ display: "none", pointerEvents: "none" }}
      />
      <div
        ref={toolbarRef}
        className="absolute z-30 flex items-center gap-0.5 rounded-md border border-border/60 bg-background/85 px-1 py-0.5 text-muted-foreground shadow-sm backdrop-blur-sm"
        style={{ display: "none", pointerEvents: "auto" }}
        // Keep terminal focus when clicking the toolbar.
        onMouseDown={(e) => e.preventDefault()}
      >
        <span ref={dotRef} className="mx-0.5 size-2 shrink-0 rounded-full" />
        <span
          ref={labelRef}
          className="px-0.5 font-mono text-[11px] tabular-nums text-foreground/80"
          style={{ display: "none" }}
        />
        <ToolbarButton
          title="Copy command"
          icon={CodeIcon}
          flashing={copied === "command"}
          onClick={() => run("command", onCopyCommand)}
        />
        <ToolbarButton
          title="Copy output"
          icon={Copy01Icon}
          flashing={copied === "output"}
          onClick={() => run("output", onCopyOutput)}
        />
        <ToolbarButton title="Filter output" icon={FilterIcon} onClick={onFilter} />
        <DropdownMenu open={menuOpen} onOpenChange={handleMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title="More actions"
              aria-label="More actions"
              className="flex size-5 items-center justify-center rounded transition-colors hover:bg-muted"
            >
              <HugeiconsIcon icon={MoreVerticalIcon} size={13} strokeWidth={1.75} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={onCopyCommand}>
              Copy command
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onCopyOutput}>Copy output</DropdownMenuItem>
            <DropdownMenuItem onSelect={onCopyBoth}>
              Copy command &amp; output
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onReinput}>
              Reinput command
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onFilter}>Filter output…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

type ToolbarButtonProps = {
  title: string;
  icon: typeof CodeIcon;
  flashing?: boolean;
  onClick: () => void;
};

function ToolbarButton({ title, icon, flashing, onClick }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        "flex size-5 items-center justify-center rounded transition-colors hover:bg-muted",
        flashing && "text-emerald-500",
      )}
    >
      <HugeiconsIcon
        icon={flashing ? Tick01Icon : icon}
        size={13}
        strokeWidth={1.75}
      />
    </button>
  );
}
