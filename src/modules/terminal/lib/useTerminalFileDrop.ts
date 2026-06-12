import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect } from "react";
import { IS_WINDOWS } from "@/lib/platform";
import { quotePathsForShell, uploadDroppedPaths } from "./remoteUpload";
import { sshHostForSession, writeToSession } from "./useTerminalSession";

const PANE_SELECTOR = "[data-pane-leaf]";
// Literal classes so Tailwind keeps them; toggled imperatively on the hovered
// pane to avoid re-rendering React on every drag-over tick.
const DROP_HIGHLIGHT = [
  "outline",
  "outline-2",
  "-outline-offset-2",
  "outline-primary/60",
];
// macOS can deliver one physical drop as two events (tauri#14134).
const DEDUPE_MS = 400;

/** Shell-quote and space-join dropped file paths for insertion into a shell. */
export function formatDropPaths(paths: string[]): string {
  return quotePathsForShell(paths);
}

type Point = { x: number; y: number };

/**
 * Tauri types drag positions as PhysicalPosition, but only Windows actually
 * delivers physical pixels (wry's webview2 runs ScreenToClient on raw screen
 * coords). macOS (wkwebview draggingLocation) and Linux (webkitgtk widget
 * coords) deliver logical points unscaled, so dividing those by
 * devicePixelRatio halves every Retina coordinate and lands all drops in the
 * top-left pane (tauri#10744).
 */
export function dragClientPoint(
  position: Point,
  windowsHost: boolean,
  devicePixelRatio: number,
): Point {
  if (!windowsHost) return { x: position.x, y: position.y };
  const dpr = devicePixelRatio || 1;
  return { x: position.x / dpr, y: position.y / dpr };
}

type DragDropPayload =
  | { type: "enter"; paths: string[]; position: Point }
  | { type: "over"; position: Point }
  | { type: "drop"; paths: string[]; position: Point }
  | { type: "leave" };

type DropAction<T> =
  | { kind: "highlight"; target: T | null }
  | { kind: "drop"; target: T; text: string; paths: string[] };

/**
 * Pure drag-drop routing: tracks the hovered target across enter/over events
 * and resolves drops to it when the drop position hit-tests to nothing, so a
 * drop can only ever land on the pane the highlight showed. Duplicate drops
 * of the same paths within DEDUPE_MS are swallowed regardless of resolved
 * target, since duplicate emits may not hit-test identically.
 */
export function createDropRouter<T>(deps: {
  hitTest: (point: Point) => T | null;
  toClient: (position: Point) => Point;
  now: () => number;
}) {
  let hover: T | null = null;
  let lastText = "";
  let lastDropAt = 0;

  return {
    handle(payload: DragDropPayload): DropAction<T> {
      if (payload.type === "leave") {
        hover = null;
        return { kind: "highlight", target: null };
      }
      const point = deps.toClient(payload.position);
      if (payload.type !== "drop") {
        hover = deps.hitTest(point);
        return { kind: "highlight", target: hover };
      }
      const target = deps.hitTest(point) ?? hover;
      hover = null;
      if (!target) return { kind: "highlight", target: null };
      const text = formatDropPaths(payload.paths);
      if (!text) return { kind: "highlight", target: null };
      const now = deps.now();
      if (text === lastText && now - lastDropAt < DEDUPE_MS) {
        return { kind: "highlight", target: null };
      }
      lastText = text;
      lastDropAt = now;
      return { kind: "drop", target, text, paths: payload.paths };
    },
  };
}

type PaneTarget = { leafId: number; host: HTMLElement };

function paneAtPoint(point: Point): PaneTarget | null {
  const el = document.elementFromPoint(point.x, point.y);
  const host = el?.closest<HTMLElement>(PANE_SELECTOR) ?? null;
  if (!host) return null;
  const leafId = Number(host.dataset.paneLeaf);
  return Number.isNaN(leafId) ? null : { leafId, host };
}

/**
 * Drop OS files onto a terminal pane. On a local shell, insert their
 * shell-quoted paths at the pane's prompt (mirrors iTerm/Terminal, and how
 * Claude Code in the pane ingests a dropped image: it reads the path). On a pane
 * that is SSHed in, upload the files to the remote first and insert the remote
 * paths instead. Drop targets the pane under the cursor, not the focused one, so
 * it works across splits.
 */
export function useTerminalFileDrop(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let highlighted: HTMLElement | null = null;

    const setHighlight = (host: HTMLElement | null) => {
      if (highlighted === host) return;
      highlighted?.classList.remove(...DROP_HIGHLIGHT);
      highlighted = host;
      host?.classList.add(...DROP_HIGHLIGHT);
    };

    const router = createDropRouter<PaneTarget>({
      hitTest: paneAtPoint,
      toClient: (position) =>
        dragClientPoint(position, IS_WINDOWS, window.devicePixelRatio),
      now: Date.now,
    });

    void getCurrentWebviewWindow()
      .onDragDropEvent((event) => {
        const action = router.handle(event.payload);
        if (action.kind === "highlight") {
          setHighlight(action.target?.host ?? null);
          return;
        }
        setHighlight(null);
        const { leafId } = action.target;
        const host = sshHostForSession(leafId);
        if (host) {
          void uploadDroppedPaths(host, action.paths).then((remote) => {
            if (remote) writeToSession(leafId, `${quotePathsForShell(remote)} `);
          });
        } else {
          writeToSession(leafId, `${action.text} `);
        }
      })
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      });

    return () => {
      disposed = true;
      setHighlight(null);
      unlisten?.();
    };
  }, []);
}
