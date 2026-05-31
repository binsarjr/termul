import { MarkdownCode } from "@/components/ai-elements/markdown-code";
import type { ReactNode } from "react";
import { MermaidDiagram } from "./MermaidDiagram";

/**
 * Streamdown `components.code` override for the preview pane: render
 * ```mermaid fences as diagrams, and delegate every other fenced/inline block
 * to the shared Lezer-highlighting `MarkdownCode`.
 */
export function PreviewCode({
  className,
  children,
  ...rest
}: {
  className?: string;
  children?: ReactNode;
}) {
  const lang = className?.match(/language-(\w+)/)?.[1];
  if (lang === "mermaid") {
    return <MermaidDiagram code={String(children ?? "").replace(/\n$/, "")} />;
  }
  return (
    <MarkdownCode className={className} {...rest}>
      {children}
    </MarkdownCode>
  );
}
