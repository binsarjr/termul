import { cn } from "@/lib/utils";
import { currentWorkspaceEnv } from "@/modules/workspace";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Download01Icon,
  MinusSignIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { RenderingCancelledException, TextLayer } from "pdfjs-dist";
import type { RenderTask } from "pdfjs-dist/types/src/display/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseTooLarge, pdfjsLib, type PdfDocument } from "./lib/pdfjs";
import "pdfjs-dist/web/pdf_viewer.css";

type PageSize = { w: number; h: number };

type Status =
  | { kind: "loading" }
  | { kind: "ready"; pdf: PdfDocument; sizes: PageSize[] }
  | { kind: "toolarge"; size: number; limit: number }
  | { kind: "error"; message: string };

type Props = {
  path: string;
  visible: boolean;
};

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

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

export function PdfViewerPane({ path, visible }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [currentPage, setCurrentPage] = useState(1);
  // Manual zoom is tracked separately from fit-to-width so toggling fit back on
  // restores the responsive scale without losing the user's last manual value.
  const [fitWidth, setFitWidth] = useState(true);
  const [manualScale, setManualScale] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);

  const scale = fitWidth ? fitScale : manualScale;

  // Load the document bytes via the binary IPC command, then collect each
  // page's intrinsic size (scale 1) so we can pre-size wrappers before render.
  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;
    let doc: PdfDocument | null = null;
    setStatus({ kind: "loading" });
    setCurrentPage(1);
    (async () => {
      try {
        const buf = await invoke<ArrayBuffer>("fs_read_bytes", {
          path,
          workspace: currentWorkspaceEnv(),
        });
        if (cancelled) return;
        loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buf) });
        doc = await loadingTask.promise;
        if (cancelled) return;
        const sizes: PageSize[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          if (cancelled) return;
          const vp = page.getViewport({ scale: 1 });
          sizes.push({ w: vp.width, h: vp.height });
        }
        setStatus({ kind: "ready", pdf: doc, sizes });
      } catch (e) {
        if (cancelled) return;
        const message = String(e instanceof Error ? e.message : e);
        const tl = parseTooLarge(message);
        setStatus(tl ? { kind: "toolarge", ...tl } : { kind: "error", message });
      }
    })();
    return () => {
      cancelled = true;
      // Destroying the loading task tears down the document and its worker;
      // PDFDocumentProxy itself has no destroy() in pdf.js v6.
      void loadingTask?.destroy();
    };
  }, [path]);

  // Fit-to-width: derive the scale from the scroll container width and the
  // first page's intrinsic width; keep it live on resize.
  useEffect(() => {
    if (status.kind !== "ready") return;
    const el = scrollRef.current;
    if (!el) return;
    const baseW = status.sizes[0]?.w ?? 612;
    const compute = () => {
      const avail = el.clientWidth - 32; // horizontal padding + scrollbar slack
      if (avail > 0) setFitScale(clampScale(avail / baseW));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [status]);

  // Track the page under the viewport midline for the toolbar indicator.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const mid = el.scrollTop + el.clientHeight / 2;
    const pages = el.querySelectorAll<HTMLElement>("[data-page]");
    let current = 1;
    for (const p of pages) {
      if (p.offsetTop <= mid) current = Number(p.dataset.page);
      else break;
    }
    setCurrentPage(current);
  }, []);

  const goToPage = useCallback((n: number) => {
    const el = scrollRef.current;
    const target = el?.querySelector<HTMLElement>(`[data-page="${n}"]`);
    if (el && target) el.scrollTo({ top: target.offsetTop - 8, behavior: "smooth" });
  }, []);

  const applyZoom = useCallback(
    (factor: number) => {
      setManualScale(clampScale(scale * factor));
      setFitWidth(false);
    },
    [scale],
  );

  const numPages = status.kind === "ready" ? status.pdf.numPages : 0;

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
            label="Previous page"
            disabled={currentPage <= 1}
            onClick={() => goToPage(Math.max(1, currentPage - 1))}
            icon={ArrowUp01Icon}
          />
          <ToolbarButton
            label="Next page"
            disabled={currentPage >= numPages}
            onClick={() => goToPage(Math.min(numPages, currentPage + 1))}
            icon={ArrowDown01Icon}
          />
          <span className="px-1 tabular-nums">
            {currentPage} / {numPages}
          </span>
          <div className="mx-1 h-4 w-px bg-border/60" />
          <ToolbarButton
            label="Zoom out"
            onClick={() => applyZoom(1 / 1.2)}
            icon={MinusSignIcon}
          />
          <span className="w-10 text-center tabular-nums">
            {Math.round(scale * 100)}%
          </span>
          <ToolbarButton
            label="Zoom in"
            onClick={() => applyZoom(1.2)}
            icon={PlusSignIcon}
          />
          <button
            type="button"
            onClick={() => setFitWidth(true)}
            className={cn(
              "ml-1 rounded px-1.5 py-0.5 transition-colors hover:bg-accent/70",
              fitWidth && "bg-accent text-foreground",
            )}
          >
            Fit width
          </button>
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
        onScroll={handleScroll}
        data-pdf-scroll
        className="relative flex-1 overflow-auto bg-muted/30 px-4 py-3"
      >
        {status.kind === "loading" && (
          <p className="text-[12px] text-muted-foreground">Loading PDF…</p>
        )}
        {status.kind === "error" && (
          <p className="text-[12px] text-destructive">
            Failed to open PDF: {status.message}
          </p>
        )}
        {status.kind === "toolarge" && (
          <div className="flex flex-col items-start gap-2 text-[12px] text-muted-foreground">
            <p>
              This PDF is {formatBytes(status.size)} (limit{" "}
              {formatBytes(status.limit)}): too large to preview inline.
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
        {status.kind === "ready" &&
          status.sizes.map((size, i) => (
            <PdfPage
              key={i}
              pdf={status.pdf}
              pageNumber={i + 1}
              size={size}
              scale={scale}
            />
          ))}
      </div>
    </div>
  );
}

function ToolbarButton({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded transition-colors hover:bg-accent/70 disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <HugeiconsIcon icon={icon} size={15} strokeWidth={1.75} />
    </button>
  );
}

function PdfPage({
  pdf,
  pageNumber,
  size,
  scale,
}: {
  pdf: PdfDocument;
  pageNumber: number;
  size: PageSize;
  scale: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  // Render lazily: only pages within ~2 viewports of the scroll position get a
  // canvas; pages that scroll far away are cleared to bound memory on big docs.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => setInView(entries[0]?.isIntersecting ?? false),
      { root: el.closest("[data-pdf-scroll]"), rootMargin: "200% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const textDiv = textRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !textDiv || !wrap) return;

    if (!inView) {
      canvas.width = 0;
      canvas.height = 0;
      textDiv.replaceChildren();
      return;
    }

    let cancelled = false;
    let task: RenderTask | null = null;
    (async () => {
      const page = await pdf.getPage(pageNumber);
      if (cancelled) return;
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale });
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Back the canvas at device resolution for crisp text; lay it out at CSS
      // px. dpr goes into the render transform only — never the viewport, or the
      // text layer (which uses the viewport geometry) drifts.
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      wrap.style.setProperty("--scale-factor", String(scale));
      wrap.style.setProperty("--total-scale-factor", String(scale));

      task = page.render({
        canvas,
        canvasContext: ctx,
        viewport,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      try {
        await task.promise;
      } catch (e) {
        if (e instanceof RenderingCancelledException) return;
        throw e;
      }
      if (cancelled) return;

      const textContent = await page.getTextContent();
      if (cancelled) return;
      textDiv.replaceChildren();
      const textLayer = new TextLayer({
        textContentSource: textContent,
        container: textDiv,
        viewport,
      });
      await textLayer.render();
    })();

    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [inView, scale, pdf, pageNumber]);

  return (
    <div
      ref={wrapRef}
      data-page={pageNumber}
      style={{ width: size.w * scale, height: size.h * scale }}
      className="relative mx-auto mb-3 bg-white shadow-sm ring-1 ring-black/10"
    >
      <canvas ref={canvasRef} className="absolute inset-0" />
      <div ref={textRef} className="textLayer" />
    </div>
  );
}
