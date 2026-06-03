import { cn } from "@/lib/utils";
import { fsBridge } from "@/modules/workspace";
import GithubSlugger from "github-slugger";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { useEffect, useRef, useState } from "react";
import { Streamdown, type PluginConfig } from "streamdown";
import { MarkdownViewToggle } from "./MarkdownViewToggle";
import { PreviewCode } from "./PreviewCode";
import { Toc, type TocItem } from "./Toc";
import "katex/dist/katex.min.css";

type Status =
  | { kind: "loading" }
  | { kind: "ready"; content: string }
  | { kind: "binary" }
  | { kind: "toolarge"; size: number; limit: number }
  | { kind: "error"; message: string };

type Props = {
  path: string;
  visible: boolean;
  /** Open/focus the editor for this file (top-right "Plain Text" toggle). */
  onOpenEditor: () => void;
};

const components = { code: PreviewCode };
// Math via Streamdown's dedicated slot: it appends rehype-katex *after* its
// `harden` sanitize step, so KaTeX markup survives (raw rehypePlugins would
// replace Streamdown's defaults and lose harden + GFM).
const plugins: PluginConfig = {
  math: {
    name: "katex",
    type: "math",
    remarkPlugin: remarkMath,
    rehypePlugin: rehypeKatex,
  },
};

export function MarkdownPreviewPane({ path, visible, onOpenEditor }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [toc, setToc] = useState<TocItem[]>([]);
  const [showToc, setShowToc] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus({ kind: "loading" });
    fsBridge
      .readFile(path)
      .then((res) => {
        if (cancelled) return;
        if (res.kind === "text") {
          setStatus({ kind: "ready", content: res.content });
        } else if (res.kind === "binary") {
          setStatus({ kind: "binary" });
        } else {
          setStatus({
            kind: "toolarge",
            size: res.size,
            limit: res.limit,
          });
        }
      })
      .catch((e) => {
        if (!cancelled) setStatus({ kind: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  // After the markdown commits, assign slug ids to headings (Streamdown adds
  // none) and build the outline. A fresh slugger per scan keeps ids — including
  // de-dupe suffixes — stable and idempotent across re-runs.
  useEffect(() => {
    if (status.kind !== "ready") {
      setToc([]);
      return;
    }
    const root = scrollRef.current;
    if (!root) return;
    const raf = requestAnimationFrame(() => {
      const slugger = new GithubSlugger();
      const items: TocItem[] = [];
      root
        .querySelectorAll<HTMLHeadingElement>("h1, h2, h3, h4, h5, h6")
        .forEach((el) => {
          const text = el.textContent?.trim() ?? "";
          if (!text) return;
          const id = slugger.slug(text);
          el.id = id;
          items.push({ id, text, level: Number(el.tagName[1]) });
        });
      setToc(items);
    });
    return () => cancelAnimationFrame(raf);
  }, [status]);

  const hasToc = toc.length > 0;

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-md border border-border/60 bg-background",
        !visible && "pointer-events-none",
      )}
    >
      <div className="flex h-8 shrink-0 items-center justify-end gap-1 border-b border-border/60 px-2">
        {hasToc && (
          <button
            type="button"
            onClick={() => setShowToc((v) => !v)}
            className="rounded px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
          >
            {showToc ? "Hide outline" : "Outline"}
          </button>
        )}
        <MarkdownViewToggle
          mode="preview"
          onPlainText={onOpenEditor}
          onPreview={() => {}}
        />
      </div>
      <div className="flex min-h-0 flex-1">
        <div ref={scrollRef} className="relative flex-1 overflow-auto px-6 py-4">
          {status.kind === "loading" && (
            <p className="text-[12px] text-muted-foreground">Loading…</p>
          )}
          {status.kind === "error" && (
            <p className="text-[12px] text-destructive">
              Failed to read file: {status.message}
            </p>
          )}
          {status.kind === "binary" && (
            <p className="text-[12px] text-muted-foreground">
              Binary file: cannot render as markdown.
            </p>
          )}
          {status.kind === "toolarge" && (
            <p className="text-[12px] text-muted-foreground">
              File is {status.size} bytes; limit {status.limit}.
            </p>
          )}
          {status.kind === "ready" && (
            <Streamdown
              className="select-text prose-sm [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
              components={components}
              plugins={plugins}
            >
              {status.content}
            </Streamdown>
          )}
        </div>
        {hasToc && showToc && <Toc items={toc} scrollRef={scrollRef} />}
      </div>
    </div>
  );
}
