import { usePreferencesStore } from "@/modules/settings/preferences";
import { useTheme } from "@/modules/theme";
import type { SearchAddon } from "@xterm/addon-search";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { BlockContextMenu } from "./BlockContextMenu";
import { BlockFilterDialog } from "./BlockFilterDialog";
import { BlockHoverLayer } from "./BlockHoverLayer";
import { TerminalAutocompleteLayer } from "./TerminalAutocompleteLayer";
import {
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
  /** Hovered block when the pointer is over one, else the keyboard-selected
   * block, else the most recent block. */
  getActiveBlock: () => CommandBlockView | null;
  selectPrevBlock: () => void;
  selectNextBlock: () => void;
  clearBlockSelection: () => void;
  selectBlockAtClientY: (clientY: number) => void;
};

type Props = {
  /** Stable identifier for this leaf (passed back through callbacks). */
  leafId: number;
  /** Tab containing this pane is on screen. */
  visible: boolean;
  /** This leaf is the active pane within its tab — receives auto-focus. */
  focused?: boolean;
  initialCwd?: string;
  /** Keep this terminal's full output on disk (per-tab "keep full output"). */
  spillToDisk?: boolean;
  onSearchReady?: (leafId: number, addon: SearchAddon) => void;
  onExit?: (leafId: number, code: number) => void;
  onCwd?: (leafId: number, cwd: string, remote: boolean) => void;
  /** A local `ssh <host>` started (host) or ended (null) in this pane. */
  onSshHost?: (leafId: number, host: string | null) => void;
};

export function TerminalPane({
  leafId,
  visible,
  focused = true,
  initialCwd,
  spillToDisk,
  onSearchReady,
  onExit,
  onCwd,
  onSshHost,
  ref,
}: Props & { ref?: React.Ref<TerminalPaneHandle> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { resolvedMode, themeId, customThemes } = useTheme();
  // The hover overlay lives in the zoomed subtree (the terminal itself is
  // zoom-exempt), so it needs the zoom factor to keep its geometry aligned.
  const zoom = usePreferencesStore((p) => p.zoomLevel);

  const session = useTerminalSession({
    leafId,
    container: containerRef,
    visible,
    focused,
    initialCwd,
    spillToDisk,
    onSearchReady: (a) => onSearchReady?.(leafId, a),
    onExit: (c) => onExit?.(leafId, c),
    onCwd: (c, r) => onCwd?.(leafId, c, r),
    onSshHost: (h) => onSshHost?.(leafId, h),
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

  // Returns whether anything was actually copied, so the hover toolbar only
  // flashes its success tick when there was content (a no-output command like
  // `cd /tmp` shouldn't pretend it copied something).
  const copyActive = useCallback(
    (kind: "command" | "output" | "both"): boolean => {
      const block = session.getActiveBlock();
      if (!block) return false;
      const command = block.command.trim();
      const text =
        kind === "command"
          ? command
          : kind === "output"
            ? block.output
            : [command, block.output].filter(Boolean).join("\n");
      if (!text) return false;
      void navigator.clipboard.writeText(text).catch(() => {});
      return true;
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

  // Pointer wiring, bound to the wrapper (which contains both the xterm grid and
  // the overlay) so moving onto the floating toolbar keeps the block hovered.
  // Hover hit-testing is throttled to one rAF; a primary click drops the
  // keyboard selection back to the live prompt.
  useEffect(() => {
    const node = wrapperRef.current;
    if (!node) return;
    let pendingY: number | null = null;
    let raf = 0;
    const flush = () => {
      raf = 0;
      if (pendingY !== null) session.setBlockHoverAt(pendingY);
    };
    const onMove = (e: MouseEvent) => {
      pendingY = e.clientY;
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const onLeave = () => {
      pendingY = null;
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      session.setBlockHoverAt(null);
    };
    const onDown = (e: MouseEvent) => {
      if (e.button === 0) session.clearBlockSelection();
    };
    node.addEventListener("mousemove", onMove);
    node.addEventListener("mouseleave", onLeave);
    node.addEventListener("mousedown", onDown);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      node.removeEventListener("mousemove", onMove);
      node.removeEventListener("mouseleave", onLeave);
      node.removeEventListener("mousedown", onDown);
    };
  }, [session]);

  // Re-resolve the controller each frame so a rebind after hibernation is
  // transparent; stable identity keeps the overlay's rAF effect from resetting.
  const getAutocompleteRender = useCallback(
    () => session.getAutocomplete()?.getRender() ?? null,
    [session],
  );

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
        <div ref={wrapperRef} className="relative h-full w-full">
          <div
            ref={containerRef}
            className="zoom-exempt h-full w-full"
            style={{
              visibility: visible ? "visible" : "hidden",
              pointerEvents: visible ? "auto" : "none",
            }}
          />
          <BlockHoverLayer
            active={visible && focused}
            zoom={zoom}
            getFrame={session.getBlockHoverFrame}
            onCopyCommand={() => copyActive("command")}
            onCopyOutput={() => copyActive("output")}
            onCopyBoth={() => copyActive("both")}
            onReinput={reinputActiveBlock}
            onFilter={openFilter}
            onMenuOpenChange={(open) => {
              if (open) session.pinActiveBlock();
            }}
          />
          <TerminalAutocompleteLayer
            active={visible && focused}
            zoom={zoom}
            getRender={getAutocompleteRender}
          />
        </div>
      </BlockContextMenu>
      {filterTarget ? (
        <BlockFilterDialog
          open
          onOpenChange={(o) => {
            if (!o) setFilterTarget(null);
          }}
          command={filterTarget.command}
          output={filterTarget.output}
        />
      ) : null}
    </>
  );
}
