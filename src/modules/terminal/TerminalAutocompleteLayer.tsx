import { detectMonoFontFamily } from "@/lib/fonts";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useEffect, useRef, useState } from "react";
import type { AutocompleteRender } from "./lib/autocompleteController";

type Props = {
  /** Only the focused, on-screen pane paints the overlay. */
  active: boolean;
  /** Live render for the bound slot's controller (re-resolved each frame so a
   * rebind after hibernation is transparent), in client coords. */
  getRender: () => AutocompleteRender | null;
  /** App zoom (`--app-zoom`). This overlay lives in the zoomed subtree while the
   * terminal is zoom-exempt, so client-px measurements are divided by it. */
  zoom: number;
};

/** Overlay-local geometry (already divided by zoom) plus the suggestion data. */
type LayerState = {
  left: number;
  top: number;
  cellHeight: number;
  ghost: string;
  dropdown: string[] | null;
  selectedIndex: number;
  /** Flip the dropdown above the cursor when it's in the lower part of the pane. */
  placeAbove: boolean;
};

/**
 * Inline shell-history autocomplete UI: ghost text continuing the command at the
 * cursor, plus a Ctrl+Space dropdown of matches. Positioned every animation
 * frame from the controller's `getRender()` (same approach as the block hover
 * layer); a single state object drives both pieces, set only when something
 * actually changes so idle panes don't re-render.
 */
export function TerminalAutocompleteLayer({ active, getRender, zoom }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  const fontFamily = usePreferencesStore(
    (s) => s.terminalFontFamily || detectMonoFontFamily(),
  );
  const fontSize = usePreferencesStore((s) => s.terminalFontSize);
  const letterSpacing = usePreferencesStore((s) => s.terminalLetterSpacing);

  const [state, setState] = useState<LayerState | null>(null);

  useEffect(() => {
    if (!active) {
      setState(null);
      return;
    }
    let raf = 0;
    let lastSig = "";
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const r = getRender();
      const root = rootRef.current;
      if (!r || !root) {
        if (lastSig !== "") {
          lastSig = "";
          setState(null);
        }
        return;
      }
      const rootRect = root.getBoundingClientRect();
      const z = zoomRef.current || 1;
      const left = (r.cursorLeft - rootRect.left) / z;
      const top = (r.cursorTop - rootRect.top) / z;
      const cellHeight = r.cellHeight / z;
      const containerH = rootRect.height / z;
      const placeAbove = top > containerH * 0.6;
      const sig = `${left}|${top}|${cellHeight}|${r.ghost}|${r.dropdown?.join("\n") ?? ""}|${r.selectedIndex}|${placeAbove}`;
      if (sig === lastSig) return;
      lastSig = sig;
      setState({
        left,
        top,
        cellHeight,
        ghost: r.ghost,
        dropdown: r.dropdown,
        selectedIndex: r.selectedIndex,
        placeAbove,
      });
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [active, getRender]);

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute inset-0 z-20"
      aria-hidden
    >
      {state?.ghost ? (
        <span
          className="absolute whitespace-pre text-muted-foreground/55"
          style={{
            left: state.left,
            top: state.top,
            height: state.cellHeight,
            lineHeight: `${state.cellHeight}px`,
            fontFamily,
            fontSize: `${fontSize}px`,
            letterSpacing: letterSpacing ? `${letterSpacing}px` : undefined,
          }}
        >
          {state.ghost}
        </span>
      ) : null}

      {state?.dropdown ? (
        <ul
          className="absolute max-h-64 min-w-40 max-w-[min(28rem,80%)] overflow-hidden rounded-md border border-border/60 bg-popover py-1 text-popover-foreground shadow-lg ring-1 ring-foreground/5"
          style={
            state.placeAbove
              ? { left: state.left, bottom: `calc(100% - ${state.top}px)` }
              : { left: state.left, top: state.top + state.cellHeight + 2 }
          }
        >
          {state.dropdown.map((cmd, i) => (
            <li
              key={`${i}-${cmd}`}
              className={`truncate px-2.5 py-1 font-mono text-[11.5px] ${
                i === state.selectedIndex
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground"
              }`}
            >
              {cmd}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
