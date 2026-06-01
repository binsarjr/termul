import { cn } from "@/lib/utils";
import { CodeIcon, Copy01Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import type { CommandBlockView } from "./lib/useTerminalSession";

type Props = {
  /** Reads the most recent command block for this pane on demand. */
  getLastBlock: () => CommandBlockView | null;
  /** Only the focused, on-screen pane shows the pill. */
  active: boolean;
};

const POLL_MS = 600;

/**
 * Corner-pinned pill on the focused terminal pane showing the last command's
 * exit-status dot plus copy-command / copy-output buttons. This is the MVP
 * affordance: a robust top-right overlay rather than a per-prompt-line overlay,
 * which would have to track marker->pixel positions across reflow and scroll.
 *
 * Block data only changes on OSC 133 C/D events, so we poll the lazy accessor
 * on a slow interval rather than threading a subscription through the slot pool.
 */
export function BlockAffordance({ getLastBlock, active }: Props) {
  const [block, setBlock] = useState<CommandBlockView | null>(null);
  const [copied, setCopied] = useState<"command" | "output" | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!active) {
      setBlock(null);
      return;
    }
    const tick = () => setBlock(getLastBlock());
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [active, getLastBlock]);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  if (!active || !block || (!block.command.trim() && !block.output)) return null;

  const flash = (which: "command" | "output") => {
    setCopied(which);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(null), 1200);
  };

  const copyCommand = () => {
    const cmd = block.command.trim();
    if (!cmd) return;
    void navigator.clipboard
      .writeText(cmd)
      .then(() => flash("command"))
      .catch(() => {});
  };

  const copyOutput = () => {
    if (!block.output) return;
    void navigator.clipboard
      .writeText(block.output)
      .then(() => flash("output"))
      .catch(() => {});
  };

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
      <PillButton
        title="Copy last command"
        disabled={!block.command.trim()}
        onClick={copyCommand}
        flashing={copied === "command"}
        icon={CodeIcon}
      />
      <PillButton
        title="Copy last command output"
        disabled={!block.output}
        onClick={copyOutput}
        flashing={copied === "output"}
        icon={Copy01Icon}
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
