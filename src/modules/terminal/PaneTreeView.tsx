import { Fragment, type PointerEvent as ReactPointerEvent, useRef } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import type { SearchAddon } from "@xterm/addon-search";
import { ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";
import type { PaneNode } from "./lib/panes";

type LeafBundle = {
  setRef: (h: TerminalPaneHandle | null) => void;
  onSearch: (addon: SearchAddon) => void;
  onCwd: (cwd: string, remote: boolean) => void;
  onSshHost: (host: string | null) => void;
  onExit: (code: number) => void;
};

type Props = {
  node: PaneNode;
  tabVisible: boolean;
  activeLeafId: number;
  /** Tab-level "keep full output to disk"; applies to every pane in the tab. */
  spillToDisk: boolean;
  dimInactivePanes: boolean;
  onFocusLeaf: (leafId: number) => void;
  getBundle: (leafId: number) => LeafBundle;
};

// Replaces the library's built-in Separator drag, which breaks under the CSS
// `zoom` on `.zoom-content`: in this WebKit the panel library measures layout
// px (offsetWidth) while pointer coords are in on-screen px, so its drag math
// drifts by the zoom factor and its thin hit region hit-tests to the terminal
// behind it. This handle reads the live zoom, converts the visual delta back to
// layout px, and resizes the preceding pane imperatively. The library pivots
// that resize against the next sibling pane, which is exactly a divider drag.
function SplitResizeHandle({
  orientation,
  getPrevPanel,
}: {
  orientation: "horizontal" | "vertical";
  getPrevPanel: () => PanelImperativeHandle | null;
}) {
  const zoom = usePreferencesStore((s) => s.zoomLevel) || 1;
  const horizontal = orientation === "horizontal";

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const panel = getPrevPanel();
    if (!panel) return;
    e.preventDefault();
    const z =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--app-zoom",
        ),
      ) || zoom;
    const start = horizontal ? e.clientX : e.clientY;
    const startSize = panel.getSize().inPixels;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = horizontal ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: PointerEvent) => {
      const cur = horizontal ? ev.clientX : ev.clientY;
      panel.resize(`${Math.round(startSize + (cur - start) / z)}px`);
    };
    const onUp = () => {
      el.releasePointerCapture?.(e.pointerId);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  };

  // Hold a constant ~10px on-screen hit width so the divider stays grabbable at
  // any zoom; the visible line stays thin via the inner element.
  const thickness = Math.round(10 / zoom);
  return (
    <div
      role="separator"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      onPointerDown={onPointerDown}
      style={
        horizontal ? { width: `${thickness}px` } : { height: `${thickness}px` }
      }
      className={cn(
        "group relative z-20 flex shrink-0 touch-none select-none items-center justify-center bg-transparent",
        horizontal ? "cursor-col-resize" : "cursor-row-resize",
      )}
    >
      <div
        className={cn(
          "pointer-events-none bg-border/60 transition-colors group-hover:bg-primary",
          horizontal ? "h-full w-px" : "h-px w-full",
        )}
      />
    </div>
  );
}

export function PaneTreeView({
  node,
  tabVisible,
  activeLeafId,
  spillToDisk,
  dimInactivePanes,
  onFocusLeaf,
  getBundle,
}: Props) {
  // Imperative handle per child pane, keyed by id so it survives index shifts
  // when panes are split or closed. A divider resizes its preceding sibling.
  const panelHandles = useRef(new Map<number, PanelImperativeHandle | null>());

  if (node.kind === "leaf") {
    const focused = node.id === activeLeafId;
    const b = getBundle(node.id);
    return (
      <div
        onMouseDownCapture={() => {
          if (!focused) onFocusLeaf(node.id);
        }}
        // Catches focus from Tab, programmatic focus, or any path that
        // skips mousedown, keeping activeLeafId in sync with DOM focus.
        onFocus={() => {
          if (!focused) onFocusLeaf(node.id);
        }}
        data-pane-leaf={node.id}
        className="relative h-full w-full transition-opacity duration-150"
        style={dimInactivePanes && !focused ? { opacity: 0.4 } : undefined}
      >
        <TerminalPane
          leafId={node.id}
          visible={tabVisible}
          focused={focused}
          initialCwd={node.cwd}
          spillToDisk={spillToDisk}
          ref={b.setRef}
          onSearchReady={(_id, addon) => b.onSearch(addon)}
          onCwd={(_id, cwd, remote) => b.onCwd(cwd, remote)}
          onSshHost={(_id, host) => b.onSshHost(host)}
          onExit={(_id, code) => b.onExit(code)}
        />
      </div>
    );
  }

  const horizontal = node.dir === "row";
  return (
    <ResizablePanelGroup orientation={horizontal ? "horizontal" : "vertical"}>
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && (
            <SplitResizeHandle
              orientation={horizontal ? "horizontal" : "vertical"}
              getPrevPanel={() =>
                panelHandles.current.get(node.children[i - 1].id) ?? null
              }
            />
          )}
          <ResizablePanel
            id={`pane-${child.id}`}
            minSize="10%"
            panelRef={(h) => {
              if (h) panelHandles.current.set(child.id, h);
              else panelHandles.current.delete(child.id);
            }}
          >
            <PaneTreeView
              node={child}
              tabVisible={tabVisible}
              activeLeafId={activeLeafId}
              spillToDisk={spillToDisk}
              dimInactivePanes={dimInactivePanes}
              onFocusLeaf={onFocusLeaf}
              getBundle={getBundle}
            />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
}
