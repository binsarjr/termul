import { useTheme } from "@/modules/theme";
import { useEffect, useId, useRef, useState } from "react";

type State =
  | { kind: "rendering" }
  | { kind: "done"; svg: string }
  | { kind: "error"; message: string };

/**
 * Renders a ```mermaid code block as a diagram. Streamdown bundles mermaid but
 * only routes to it from its *default* code component — which the preview
 * replaces with a Lezer-highlighting one — so we drive mermaid directly here.
 * The import is lazy so mermaid's ~500 KB only loads for docs that use it.
 */
export function MermaidDiagram({ code }: { code: string }) {
  const { resolvedMode } = useTheme();
  const baseId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const seq = useRef(0);
  const [state, setState] = useState<State>({ kind: "rendering" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "rendering" });
    const renderId = `mermaid-${baseId}-${seq.current++}`;
    (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        if (cancelled) return;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: resolvedMode === "dark" ? "dark" : "default",
        });
        const { svg } = await mermaid.render(renderId, code);
        if (!cancelled) setState({ kind: "done", svg });
      } catch (e) {
        if (!cancelled) {
          setState({
            kind: "error",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, resolvedMode, baseId]);

  if (state.kind === "error") {
    return (
      <div className="not-prose my-3 rounded border border-destructive/40 bg-destructive/5 p-3">
        <p className="mb-1 text-[11px] font-medium text-destructive">
          Mermaid error
        </p>
        <pre className="overflow-auto text-[11px] text-destructive/90">
          {state.message}
        </pre>
        <pre className="mt-2 overflow-auto border-t border-destructive/20 pt-2 text-[11px] text-muted-foreground">
          {code}
        </pre>
      </div>
    );
  }

  if (state.kind === "rendering") {
    return (
      <div className="not-prose my-3 text-[12px] text-muted-foreground">
        Rendering diagram…
      </div>
    );
  }

  return (
    <div
      className="not-prose my-3 flex justify-center overflow-auto [&_svg]:h-auto [&_svg]:max-w-full"
      // mermaid sanitizes its own output under securityLevel: "strict".
      dangerouslySetInnerHTML={{ __html: state.svg }}
    />
  );
}
