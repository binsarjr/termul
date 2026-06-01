import { useTheme } from "@/modules/theme";
import type { SearchAddon } from "@xterm/addon-search";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { BlockAffordance } from "./BlockAffordance";
import { BlockContextMenu } from "./BlockContextMenu";
import { BlockFilterDialog } from "./BlockFilterDialog";
import {
  type BlockSelection,
  type CommandBlockView,
  useTerminalSession,
} from "./lib/useTerminalSession";

export type TerminalPaneHandle = {
  write: (data: string) => void;
  focus: () => void;
  getBuffer: (maxLines?: number) => string | null;
  getSelection: () => string | null;
  getLastBlock: () => CommandBlockView | null;
  getBlocks: () => CommandBlockView[];
  /** Selected block when navigating, else the most recent block. */
  getActiveBlock: () => CommandBlockView | null;
  selectPrevBlock: () => void;
  selectNextBlock: () => void;
  clearBlockSelection: () => void;
  selectBlockAtClientY: (clientY: number) => void;
  getBlockSelection: () => BlockSelection | null;
};

type Props = {
  /** Stable identifier for this leaf (passed back through callbacks). */
  leafId: number;
  /** Tab containing this pane is on screen. */
  visible: boolean;
  /** This leaf is the active pane within its tab — receives auto-focus. */
  focused?: boolean;
  initialCwd?: string;
  onSearchReady?: (leafId: number, addon: SearchAddon) => void;
  onExit?: (leafId: number, code: number) => void;
  onCwd?: (leafId: number, cwd: string) => void;
};

export function TerminalPane({
  leafId,
  visible,
  focused = true,
  initialCwd,
  onSearchReady,
  onExit,
  onCwd,
  ref,
}: Props & { ref?: React.Ref<TerminalPaneHandle> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { resolvedMode, themeId, customThemes } = useTheme();

  const session = useTerminalSession({
    leafId,
    container: containerRef,
    visible,
    focused,
    initialCwd,
    onSearchReady: (a) => onSearchReady?.(leafId, a),
    onExit: (c) => onExit?.(leafId, c),
    onCwd: (c) => onCwd?.(leafId, c),
  });

  useEffect(() => {
    // Defer one frame so CSS-variable token resolution sees the new class.
    const id = requestAnimationFrame(() => session.applyTheme());
    return () => cancelAnimationFrame(id);
  }, [resolvedMode, themeId, customThemes, session]);

  useImperativeHandle(
    ref,
    () => ({
      write: (data: string) => session.write(data),
      focus: () => session.focus(),
      getBuffer: (max?: number) => session.getBuffer(max),
      getSelection: () => session.getSelection(),
      getLastBlock: () => session.getLastBlock(),
      getBlocks: () => session.getBlocks(),
      getActiveBlock: () => session.getActiveBlock(),
      selectPrevBlock: () => session.selectPrevBlock(),
      selectNextBlock: () => session.selectNextBlock(),
      clearBlockSelection: () => session.clearBlockSelection(),
      selectBlockAtClientY: (y: number) => session.selectBlockAtClientY(y),
      getBlockSelection: () => session.getBlockSelection(),
    }),
    [session],
  );

  const reinputActiveBlock = useCallback(() => {
    const command = session.getActiveBlock()?.command.trim();
    if (!command) return;
    // Type it back at the prompt without a CR — the user runs it themselves.
    session.write(command);
    session.focus();
  }, [session]);

  const copyActive = useCallback(
    (kind: "command" | "output" | "both") => {
      const block = session.getActiveBlock();
      if (!block) return;
      const command = block.command.trim();
      const text =
        kind === "command"
          ? command
          : kind === "output"
            ? block.output
            : [command, block.output].filter(Boolean).join("\n");
      if (text) void navigator.clipboard.writeText(text).catch(() => {});
    },
    [session],
  );

  // Snapshot of the block whose output the filter dialog is showing (null =
  // closed). Snapshotting at open time decouples it from the live buffer.
  const [filterTarget, setFilterTarget] = useState<CommandBlockView | null>(
    null,
  );
  const openFilter = useCallback(() => {
    const block = session.getActiveBlock();
    if (block?.output) setFilterTarget(block);
  }, [session]);

  // A primary click in the grid returns focus to the live prompt, so drop any
  // keyboard block selection. Bound imperatively (the grid is a non-semantic
  // container, not a control) and scoped so right-click keeps the selection.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const onDown = (e: MouseEvent) => {
      if (e.button === 0) session.clearBlockSelection();
    };
    node.addEventListener("mousedown", onDown);
    return () => node.removeEventListener("mousedown", onDown);
  }, [session]);

  return (
    <>
      <BlockContextMenu
        onContextMenu={(y) => session.selectBlockAtClientY(y)}
        getActiveBlock={session.getActiveBlock}
        onCopyCommand={() => copyActive("command")}
        onCopyOutput={() => copyActive("output")}
        onCopyBoth={() => copyActive("both")}
        onReinput={reinputActiveBlock}
        onFilter={openFilter}
      >
        <div
          ref={containerRef}
          className="zoom-exempt h-full w-full"
          style={{
            visibility: visible ? "visible" : "hidden",
            pointerEvents: visible ? "auto" : "none",
          }}
        />
      </BlockContextMenu>
      <BlockAffordance
        active={visible && focused}
        getActiveBlock={session.getActiveBlock}
        getSelection={session.getBlockSelection}
        onReinput={reinputActiveBlock}
      />
      <BlockFilterDialog
        open={!!filterTarget}
        onOpenChange={(o) => {
          if (!o) setFilterTarget(null);
        }}
        command={filterTarget?.command ?? ""}
        output={filterTarget?.output ?? ""}
      />
    </>
  );
}
