import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect } from "react";
import { quoteShellArg } from "@/lib/shellQuote";
import { writeToSession } from "./useTerminalSession";

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
  return paths
    .filter((path) => path.length > 0)
    .map((path) => quoteShellArg(path))
    .join(" ");
}

function paneAtPoint(
  clientX: number,
  clientY: number,
): { leafId: number; host: HTMLElement } | null {
  const el = document.elementFromPoint(clientX, clientY);
  const host = el?.closest<HTMLElement>(PANE_SELECTOR) ?? null;
  if (!host) return null;
  const leafId = Number(host.dataset.paneLeaf);
  return Number.isNaN(leafId) ? null : { leafId, host };
}

/**
 * Drop OS files onto a terminal pane to insert their shell-quoted paths at that
 * pane's prompt. This mirrors how iTerm/Terminal handle a dragged file, and is
 * how Claude Code (running in the pane) ingests a dropped image: it reads the
 * path from the prompt. Drop targets the pane under the cursor, not the focused
 * one, so it works across splits.
 */
export function useTerminalFileDrop(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let highlighted: HTMLElement | null = null;
    let lastKey = "";
    let lastDropAt = 0;

    const setHighlight = (host: HTMLElement | null) => {
      if (highlighted === host) return;
      highlighted?.classList.remove(...DROP_HIGHLIGHT);
      highlighted = host;
      host?.classList.add(...DROP_HIGHLIGHT);
    };

    const toClient = (position: { x: number; y: number }) => {
      const dpr = window.devicePixelRatio || 1;
      return { x: position.x / dpr, y: position.y / dpr };
    };

    void getCurrentWebviewWindow()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "over") {
          const { x, y } = toClient(payload.position);
          setHighlight(paneAtPoint(x, y)?.host ?? null);
          return;
        }
        if (payload.type === "leave") {
          setHighlight(null);
          return;
        }
        if (payload.type !== "drop") return;
        setHighlight(null);
        if (payload.paths.length === 0) return;
        const { x, y } = toClient(payload.position);
        const target = paneAtPoint(x, y);
        if (!target) return;
        const text = formatDropPaths(payload.paths);
        if (!text) return;
        const key = `${target.leafId}:${text}`;
        const now = Date.now();
        if (key === lastKey && now - lastDropAt < DEDUPE_MS) return;
        lastKey = key;
        lastDropAt = now;
        writeToSession(target.leafId, `${text} `);
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
