import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PortalContainerProvider } from "@/components/ui/portal-container";
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

// Error-accent bar geometry, in px. The bar lives in the terminal's left gutter
// (the padding on .xterm): WIDTH wide, GAP from the first glyph, INSET in from
// the band's top/bottom edges.
const ACCENT_WIDTH = 3;
const ACCENT_GAP = 4;
const ACCENT_INSET = 2;

type Props = {
  /** Only the focused, on-screen pane paints the overlay. */
  active: boolean;
  /** Geometry + status of the block to highlight, in client coords, or null. */
  getFrame: () => BlockFrame | null;
  /** Wakes the parked positioning loop when hover/selection/scroll may have
   * given it a frame to track again; returns an unsubscribe. */
  subscribe: (cb: () => void) => () => void;
  /** Copy actions return whether anything was actually copied, so the toolbar
   * only flashes a success tick when there was content. */
  onCopyCommand: () => boolean;
  onCopyOutput: () => boolean;
  onCopyBoth: () => boolean;
  onReinput: () => void;
  onFilter: () => void;
  /** Fired when the ⋮ menu opens/closes so the host can pin the active block. */
  onMenuOpenChange: (open: boolean) => void;
  /** App zoom (`--app-zoom`). Geometry needs no zoom math — the root is
   * zoom-exempt, same effective scale as the terminal — but the toolbar's
   * CONTENT visually scales with the UI zoom via a transform. */
  zoom: number;
};

/**
 * Warp-style per-block hover affordance: a full-width tint over the block the
 * pointer (or keyboard selection) is on, plus a floating toolbar pinned to its
 * top-right. Both are positioned each animation frame from `getFrame()` while
 * a block is tracked — a single overlay element repositioned imperatively
 * rather than 50 xterm decorations, which would vanish the moment a block's
 * start row scrolled off. With no tracked geometry the loop parks entirely and
 * the controller wakes it through `subscribe`, so an idle pane costs no frames.
 */
export function BlockHoverLayer({
  active,
  getFrame,
  subscribe,
  onCopyCommand,
  onCopyOutput,
  onCopyBoth,
  onReinput,
  onFilter,
  onMenuOpenChange,
  zoom,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const accentRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLSpanElement>(null);
  const remoteRef = useRef<HTMLSpanElement>(null);
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
      if (accentRef.current) accentRef.current.style.display = "none";
      if (toolbarRef.current) toolbarRef.current.style.display = "none";
    }
    function position(frame: BlockFrame, rootRect: DOMRect) {
      const hl = highlightRef.current;
      const accent = accentRef.current;
      const tb = toolbarRef.current;
      if (!hl || !accent || !tb) return;
      // `frame`/`rootRect` are real screen px, and the zoom-exempt root puts
      // this overlay in the same effective scale as the terminal grid — both
      // rects live in one coordinate space, so raw deltas position exactly.
      // (No `--app-zoom` division: engines report client rects inconsistently
      // inside `zoom`ed subtrees, which mispositioned everything at zoom ≠ 1.)
      const px = (v: number) => `${v}px`;
      const top = frame.top - rootRect.top;
      // The terminal has a left gutter (padding on .xterm), so .xterm-screen's
      // left edge sits a few px in from the wrapper. The band fills from the
      // wrapper's left edge through the text so it reads as one block, and the
      // accent bar lives in that gutter — never on top of the first glyph.
      const gutter = Math.max(0, frame.left - rootRect.left);
      const failed = frame.exitCode !== null && frame.exitCode !== 0;

      hl.style.display = "block";
      hl.style.top = px(top);
      hl.style.left = "0px";
      hl.style.width = px(gutter + frame.width);
      hl.style.height = px(frame.height);
      hl.style.background = failed
        ? "color-mix(in srgb, var(--destructive) 7%, transparent)"
        : "color-mix(in srgb, var(--foreground) 5%, transparent)";

      // Warp shows the colored left bar only for failed commands.
      if (failed) {
        accent.style.display = "block";
        accent.style.top = px(top + ACCENT_INSET);
        accent.style.left = px(Math.max(2, gutter - ACCENT_GAP - ACCENT_WIDTH));
        accent.style.width = px(ACCENT_WIDTH);
        accent.style.height = px(Math.max(0, frame.height - ACCENT_INSET * 2));
      } else {
        accent.style.display = "none";
      }

      tb.style.display = "flex";
      tb.style.top = px(top + 4);
      tb.style.right = px(rootRect.right - (frame.left + frame.width) + 8);

      const dot = dotRef.current;
      if (dot) {
        dot.style.background =
          frame.exitCode === null
            ? "var(--muted-foreground)"
            : failed
              ? "#ef4444"
              : "#10b981";
      }
      const remote = remoteRef.current;
      if (remote) {
        remote.style.display = frame.source === "remote" ? "" : "none";
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
      raf = 0;
      const frame = getFrame();
      // While the ⋮ menu is open, keep the toolbar pinned (so the pointer can
      // travel into the portaled menu) — but still hide once the block scrolls
      // fully out of view, e.g. under streaming output, so it doesn't float.
      // The loop stays scheduled for the menu's (transient) lifetime so the
      // toolbar resumes following the moment it closes.
      if (menuOpenRef.current) {
        raf = requestAnimationFrame(tick);
        if (!frame) hide();
        return;
      }
      const root = rootRef.current;
      if (!frame || !root) {
        hide();
        return; // parked — the controller kicks when there's a frame again
      }
      raf = requestAnimationFrame(tick);
      position(frame, root.getBoundingClientRect());
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const unsubscribe = subscribe(kick);
    kick();
    return () => {
      unsubscribe();
      cancelAnimationFrame(raf);
    };
  }, [active, getFrame, subscribe]);

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
      className="zoom-exempt pointer-events-none absolute inset-0 z-20 overflow-hidden"
    >
      <div
        ref={highlightRef}
        className="absolute rounded-[3px] transition-[background] duration-100"
        style={{ display: "none", pointerEvents: "none" }}
      />
      <div
        ref={accentRef}
        className="absolute rounded-full"
        style={{
          display: "none",
          pointerEvents: "none",
          background: "var(--destructive)",
        }}
      />
      <div
        ref={toolbarRef}
        className="absolute z-30 flex items-center gap-0.5 rounded-md border border-border/60 bg-background/85 px-1 py-0.5 text-muted-foreground shadow-sm backdrop-blur-sm"
        style={{
          display: "none",
          pointerEvents: "auto",
          // The zoom-exempt root opts out of the UI's CSS zoom, so the toolbar
          // scales with the app zoom via a transform instead. Transforms don't
          // touch layout, so the rAF-written top/right stay real px, and the
          // top-right origin keeps it pinned to the block's corner.
          transform: zoom !== 1 ? `scale(${zoom})` : undefined,
          transformOrigin: "top right",
        }}
        // Keep terminal focus when clicking the toolbar.
        onMouseDown={(e) => e.preventDefault()}
      >
        <span ref={dotRef} className="mx-0.5 size-2 shrink-0 rounded-full" />
        <span
          ref={remoteRef}
          title="Ran inside the SSH session"
          className="px-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
          style={{ display: "none" }}
        >
          remote
        </span>
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
        {/* This toolbar lives in the zoom-exempt overlay (net zoom 1, same as
         * the body), so the menu portals to body, not the zoom-content layer. */}
        <PortalContainerProvider container={null}>
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
        </PortalContainerProvider>
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
