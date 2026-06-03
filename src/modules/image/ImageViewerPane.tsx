import { cn } from "@/lib/utils";
import { fsBridge } from "@/modules/workspace";
import {
  Download01Icon,
  MinusSignIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openPath } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useRef, useState } from "react";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

const MIN_SCALE = 0.05;
const MAX_SCALE = 16;
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

const CHECKERBOARD: React.CSSProperties = {
  backgroundImage:
    "linear-gradient(45deg, rgba(128,128,128,0.18) 25%, transparent 25%), linear-gradient(-45deg, rgba(128,128,128,0.18) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(128,128,128,0.18) 75%), linear-gradient(-45deg, transparent 75%, rgba(128,128,128,0.18) 75%)",
  backgroundSize: "20px 20px",
  backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px",
};

type Status =
  | { kind: "loading" }
  | { kind: "ready"; url: string; w: number; h: number }
  | { kind: "toolarge"; size: number; limit: number }
  | { kind: "error"; message: string };

type Props = {
  path: string;
  visible: boolean;
};

function parseTooLarge(message: string): { size: number; limit: number } | null {
  const m = /^toolarge:(\d+):(\d+)$/.exec(message);
  return m ? { size: Number(m[1]), limit: Number(m[2]) } : null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function ImageViewerPane({ path, visible }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [fit, setFit] = useState(true);
  const [manualScale, setManualScale] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scale = fit ? fitScale : manualScale;

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setStatus({ kind: "loading" });
    setFit(true);
    (async () => {
      try {
        const buf = await fsBridge.readBytes(path);
        if (cancelled) return;
        const ext = path.split(".").pop()?.toLowerCase() ?? "";
        const blob = new Blob([buf], {
          type: MIME[ext] ?? "application/octet-stream",
        });
        url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          if (cancelled) return;
          setStatus({
            kind: "ready",
            url: url as string,
            w: img.naturalWidth || 0,
            h: img.naturalHeight || 0,
          });
        };
        img.onerror = () => {
          if (!cancelled) {
            setStatus({ kind: "error", message: "Could not decode image." });
          }
        };
        img.src = url;
      } catch (e) {
        if (cancelled) return;
        const message = String(e instanceof Error ? e.message : e);
        const tl = parseTooLarge(message);
        setStatus(tl ? { kind: "toolarge", ...tl } : { kind: "error", message });
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);

  // Fit-to-window: shrink large images to fit, but never upscale past 100%.
  useEffect(() => {
    if (status.kind !== "ready" || !status.w || !status.h) return;
    const el = scrollRef.current;
    if (!el) return;
    const compute = () => {
      const cw = el.clientWidth - 24;
      const ch = el.clientHeight - 24;
      if (cw <= 0 || ch <= 0) return;
      setFitScale(Math.min(cw / status.w, ch / status.h, 1));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [status]);

  const applyZoom = useCallback(
    (factor: number) => {
      setManualScale(clampScale(scale * factor));
      setFit(false);
    },
    [scale],
  );

  const setActualSize = useCallback(() => {
    setManualScale(1);
    setFit(false);
  }, []);

  // Ctrl/Cmd + wheel zooms; plain wheel scrolls the overflow natively.
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      applyZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    },
    [applyZoom],
  );

  // Drag-to-pan when the scaled image overflows the viewport.
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(
    null,
  );
  const onPointerDown = (e: React.PointerEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)
      return;
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      left: el.scrollLeft,
      top: el.scrollTop,
    };
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const el = scrollRef.current;
    if (!el || !drag.current) return;
    el.scrollLeft = drag.current.left - (e.clientX - drag.current.x);
    el.scrollTop = drag.current.top - (e.clientY - drag.current.y);
  };
  const endDrag = (e: React.PointerEvent) => {
    drag.current = null;
    scrollRef.current?.releasePointerCapture(e.pointerId);
  };

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-md border border-border/60 bg-background",
        !visible && "pointer-events-none",
      )}
    >
      {status.kind === "ready" && (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2 text-[12px] text-muted-foreground">
          <ToolbarButton
            label="Zoom out"
            onClick={() => applyZoom(1 / 1.2)}
            icon={MinusSignIcon}
          />
          <span className="w-12 text-center tabular-nums">
            {Math.round(scale * 100)}%
          </span>
          <ToolbarButton
            label="Zoom in"
            onClick={() => applyZoom(1.2)}
            icon={PlusSignIcon}
          />
          <button
            type="button"
            onClick={() => setFit(true)}
            className={cn(
              "ml-1 rounded px-1.5 py-0.5 transition-colors hover:bg-accent/70",
              fit && "bg-accent text-foreground",
            )}
          >
            Fit
          </button>
          <button
            type="button"
            onClick={setActualSize}
            className={cn(
              "rounded px-1.5 py-0.5 transition-colors hover:bg-accent/70",
              !fit && manualScale === 1 && "bg-accent text-foreground",
            )}
          >
            100%
          </button>
          {status.w > 0 && (
            <span className="px-1 tabular-nums">
              {status.w} × {status.h}
            </span>
          )}
          <div className="flex-1" />
          <ToolbarButton
            label="Open in system viewer"
            onClick={() => void openPath(path)}
            icon={Download01Icon}
          />
        </div>
      )}

      <div
        ref={scrollRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => (fit ? setActualSize() : setFit(true))}
        className="relative flex-1 overflow-auto"
      >
        {status.kind !== "ready" ? (
          <div className="flex h-full w-full items-center justify-center p-4">
            {status.kind === "loading" && (
              <p className="text-[12px] text-muted-foreground">Loading image…</p>
            )}
            {status.kind === "error" && (
              <p className="text-[12px] text-destructive">{status.message}</p>
            )}
            {status.kind === "toolarge" && (
              <div className="flex flex-col items-center gap-2 text-[12px] text-muted-foreground">
                <p>
                  This image is {formatBytes(status.size)} (limit{" "}
                  {formatBytes(status.limit)}).
                </p>
                <button
                  type="button"
                  onClick={() => void openPath(path)}
                  className="rounded border border-border/60 px-2 py-1 text-foreground transition-colors hover:bg-accent/70"
                >
                  Open in system viewer
                </button>
              </div>
            )}
          </div>
        ) : (
          // min-w/h-full centers small images; the wrapper grows to the scaled
          // image when larger, so overflow stays fully scrollable (no flex clip).
          <div className="flex min-h-full min-w-full items-center justify-center p-3">
            <div
              style={
                status.w
                  ? { ...CHECKERBOARD, width: status.w * scale, height: status.h * scale }
                  : CHECKERBOARD
              }
              className="shrink-0 cursor-grab active:cursor-grabbing"
            >
              <img
                src={status.url}
                alt={path}
                draggable={false}
                className="block h-full w-full max-w-none select-none"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolbarButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded transition-colors hover:bg-accent/70"
    >
      <HugeiconsIcon icon={icon} size={15} strokeWidth={1.75} />
    </button>
  );
}
