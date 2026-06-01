import { cn } from "@/lib/utils";
import {
  ArrowTurnBackwardIcon,
  ClipboardIcon,
  CodeIcon,
  Copy01Icon,
  Tick01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import type {
  BlockSelection,
  CommandBlockView,
} from "./lib/useTerminalSession";

type Props = {
  /** Reads the active block (keyboard-selected, else most recent) on demand. */
  getActiveBlock: () => CommandBlockView | null;
  /** Reads the current keyboard selection, or null when none. */
  getSelection: () => BlockSelection | null;
  /** Types the active block's command back at the prompt (no auto-run). */
  onReinput: () => void;
  /** Only the focused, on-screen pane shows the pill. */
  active: boolean;
};

const POLL_MS = 600;

type Action = "command" | "output" | "both" | "reinput";

/**
 * Corner-pinned pill on the focused terminal pane. Reflects the active command
 * block — the keyboard-selected one when navigating with Cmd+↑/↓, otherwise the
 * most recent — showing its exit-status dot, a selection counter, and copy /
 * reinput actions. A robust top-right overlay rather than a per-prompt-line
 * frame, which would have to track marker→pixel positions across reflow.
 *
 * Block data changes only on OSC 133 C/D events, so we poll the lazy accessors
 * on a slow interval rather than threading a subscription through the slot pool.
 */
export function BlockAffordance({
  getActiveBlock,
  getSelection,
  onReinput,
  active,
}: Props) {
  const [view, setView] = useState<{
    block: CommandBlockView | null;
    selection: BlockSelection | null;
  }>({ block: null, selection: null });
  const [copied, setCopied] = useState<Action | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // No polling while hidden; the render guard below handles display, and the
    // first tick on re-activation refreshes any stale block.
    if (!active) return;
    const tick = () =>
      setView({ block: getActiveBlock(), selection: getSelection() });
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [active, getActiveBlock, getSelection]);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const { block, selection } = view;
  if (!active || !block || (!block.command.trim() && !block.output))
    return null;

  const flash = (which: Action) => {
    setCopied(which);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(null), 1200);
  };

  const copy = (which: Action, text: string) => {
    if (!text) return;
    void navigator.clipboard
      .writeText(text)
      .then(() => flash(which))
      .catch(() => {});
  };

  const command = block.command.trim();
  const both = [command, block.output].filter(Boolean).join("\n");

  const exit = block.exitCode;
  const dotClass =
    exit === null
      ? "bg-muted-foreground/50"
      : exit === 0
        ? "bg-emerald-500"
        : "bg-red-500";
  const dotTitle =
    exit === null
      ? "Exit status unknown"
      : exit === 0
        ? "Exited 0"
        : `Exited ${exit}`;

  return (
    <div
      className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded-md border border-border/60 bg-background/80 px-1.5 py-1 text-muted-foreground shadow-sm backdrop-blur-sm"
      // Don't steal focus from the terminal grid when clicking the pill.
      onMouseDown={(e) => e.preventDefault()}
    >
      <span
        className={cn("h-2 w-2 shrink-0 rounded-full", dotClass)}
        title={dotTitle}
        aria-label={dotTitle}
      />
      {selection ? (
        <span
          className="shrink-0 px-0.5 font-mono text-[11px] tabular-nums text-foreground/80"
          title={`Block ${selection.index + 1} of ${selection.total} selected`}
        >
          {selection.index + 1}/{selection.total}
        </span>
      ) : null}
      <PillButton
        title="Copy command"
        disabled={!command}
        onClick={() => copy("command", command)}
        flashing={copied === "command"}
        icon={CodeIcon}
      />
      <PillButton
        title="Copy output"
        disabled={!block.output}
        onClick={() => copy("output", block.output)}
        flashing={copied === "output"}
        icon={Copy01Icon}
      />
      <PillButton
        title="Copy command and output"
        disabled={!both}
        onClick={() => copy("both", both)}
        flashing={copied === "both"}
        icon={ClipboardIcon}
      />
      <PillButton
        title="Reinput command at prompt"
        disabled={!command}
        onClick={() => {
          onReinput();
          flash("reinput");
        }}
        flashing={copied === "reinput"}
        icon={ArrowTurnBackwardIcon}
      />
    </div>
  );
}

type PillButtonProps = {
  title: string;
  disabled: boolean;
  flashing: boolean;
  onClick: () => void;
  icon: typeof CodeIcon;
};

function PillButton({
  title,
  disabled,
  flashing,
  onClick,
  icon,
}: PillButtonProps) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded transition-colors",
        "hover:bg-muted disabled:cursor-default disabled:opacity-40",
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
