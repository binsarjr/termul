import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { type ReactNode, useState } from "react";
import type { CommandBlockView } from "./lib/useTerminalSession";

type Props = {
  /** Hit-test + select the block under the right-click before the menu opens. */
  onContextMenu: (clientY: number) => void;
  /** Reads the block the actions will operate on (the one just selected). */
  getActiveBlock: () => CommandBlockView | null;
  onCopyCommand: () => void;
  onCopyOutput: () => void;
  onCopyBoth: () => void;
  onReinput: () => void;
  onFilter?: () => void;
  children: ReactNode;
};

/**
 * Right-click menu for the terminal's command blocks. On open it selects the
 * block under the cursor (via `onContextMenu` hit-testing) and snapshots which
 * actions apply, so items disable themselves when there's no command/output.
 */
export function BlockContextMenu({
  onContextMenu,
  getActiveBlock,
  onCopyCommand,
  onCopyOutput,
  onCopyBoth,
  onReinput,
  onFilter,
  children,
}: Props) {
  const [avail, setAvail] = useState({ command: false, output: false });

  const onTrigger = (clientY: number) => {
    onContextMenu(clientY);
    const block = getActiveBlock();
    setAvail({
      command: !!block?.command.trim(),
      output: !!block?.output,
    });
  };

  const hasEither = avail.command || avail.output;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={(e) => onTrigger(e.clientY)}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem disabled={!avail.command} onSelect={onCopyCommand}>
          Copy command
        </ContextMenuItem>
        <ContextMenuItem disabled={!avail.output} onSelect={onCopyOutput}>
          Copy output
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasEither} onSelect={onCopyBoth}>
          Copy command &amp; output
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!avail.command} onSelect={onReinput}>
          Reinput command
        </ContextMenuItem>
        {onFilter ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem disabled={!avail.output} onSelect={onFilter}>
              Filter output…
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
