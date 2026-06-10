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
  /** Wakes the parked settle loop when input/geometry may have changed;
   * returns an unsubscribe. */
  subscribe: (cb: () => void) => () => void;
  /** Accept a dropdown row by index — the mouse-click path. */
  onPick?: (index: number) => void;
};

/** Overlay-local geometry plus the suggestion data. */
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
 * cursor, plus a Ctrl+Space dropdown of matches. Positioned each animation
 * frame from the controller's `getRender()` while something is showing; with
 * nothing to paint the loop parks entirely and the controller wakes it through
 * `subscribe`, so an idle pane costs no frames. A single state object drives
 * both pieces, set only when something actually changes so idle panes don't
 * re-render.
 *
 * The root is `zoom-exempt`, putting the overlay in the SAME effective scale as
 * the terminal grid (net 1). Both rects then live in one coordinate space, so
 * raw client-px deltas position the ghost exactly and the terminal font prefs
 * apply unscaled — no `--app-zoom` math, which engines report inconsistently
 * for `zoom`ed subtrees (WebKit vs Chromium getBoundingClientRect behavior).
 */
export function TerminalAutocompleteLayer({
  active,
  getRender,
  subscribe,
  onPick,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);

  const fontFamily = usePreferencesStore(
    (s) => s.terminalFontFamily || detectMonoFontFamily(),
  );
  const fontSize = usePreferencesStore((s) => s.terminalFontSize);
  const letterSpacing = usePreferencesStore((s) => s.terminalLetterSpacing);
  // The zoom-exempt terminal scales with app zoom by bumping its xterm
  // fontSize (rendererPool applyFontSize: round(fontSize × zoom), spacing
  // unscaled) — mirror the exact formula or the ghost drifts from the cells.
  const zoomLevel = usePreferencesStore((s) => s.zoomLevel);
  const ghostFontSize = Math.max(4, Math.round(fontSize * (zoomLevel || 1)));

  const [state, setState] = useState<LayerState | null>(null);

  useEffect(() => {
    if (!active) {
      setState(null);
      return;
    }
    let raf = 0;
    let lastSig = "";
    const tick = () => {
      raf = 0;
      const r = getRender();
      const root = rootRef.current;
      if (!r || !root) {
        if (lastSig !== "") {
          lastSig = "";
          setState(null);
        }
        return; // parked — the controller kicks when something changes
      }
      raf = requestAnimationFrame(tick);
      const rootRect = root.getBoundingClientRect();
      const left = r.cursorLeft - rootRect.left;
      const top = r.cursorTop - rootRect.top;
      const cellHeight = r.cellHeight;
      const placeAbove = top > rootRect.height * 0.6;
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
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const unsubscribe = subscribe(kick);
    tick();
    return () => {
      unsubscribe();
      cancelAnimationFrame(raf);
    };
  }, [active, getRender, subscribe]);

  return (
    <div
      ref={rootRef}
      className="zoom-exempt pointer-events-none absolute inset-0 z-20 overflow-hidden"
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
            fontSize: `${ghostFontSize}px`,
            letterSpacing: letterSpacing ? `${letterSpacing}px` : undefined,
          }}
        >
          {state.ghost}
        </span>
      ) : null}

      {state?.dropdown ? (
        <ul
          className="pointer-events-auto absolute max-h-64 min-w-40 max-w-[min(28rem,80%)] overflow-hidden rounded-md border border-border/60 bg-popover py-1 text-popover-foreground shadow-lg ring-1 ring-foreground/5"
          style={{
            // The zoom-exempt overlay opts out of the UI's CSS zoom, so the
            // dropdown scales with the app zoom explicitly.
            fontSize: `${11.5 * (zoomLevel || 1)}px`,
            ...(state.placeAbove
              ? { left: state.left, bottom: `calc(100% - ${state.top}px)` }
              : { left: state.left, top: state.top + state.cellHeight + 2 }),
          }}
        >
          {state.dropdown.map((cmd, i) => (
            <li key={`${i}-${cmd}`}>
              <button
                type="button"
                // Out of the tab order: the terminal owns keyboard focus and
                // the whole overlay is aria-hidden (it mirrors terminal state).
                tabIndex={-1}
                // mousedown (not click) so the terminal never loses focus.
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick?.(i);
                }}
                className={`block w-full cursor-pointer truncate px-2.5 py-1 text-left font-mono ${
                  i === state.selectedIndex
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50"
                }`}
              >
                {cmd}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
