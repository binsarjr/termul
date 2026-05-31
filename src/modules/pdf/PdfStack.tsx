import { cn } from "@/lib/utils";
import type { PdfTab, Tab } from "@/modules/tabs";
import { PdfViewerPane } from "./PdfViewerPane";

type Props = {
  tabs: Tab[];
  activeId: number;
};

export function PdfStack({ tabs, activeId }: Props) {
  const pdfs = tabs.filter((t): t is PdfTab => t.kind === "pdf");
  if (pdfs.length === 0) return null;
  return (
    <div className="relative h-full w-full">
      {pdfs.map((t) => {
        const visible = t.id === activeId;
        return (
          <div
            key={t.id}
            className={cn(
              "absolute inset-0",
              !visible && "invisible pointer-events-none",
            )}
            aria-hidden={!visible}
          >
            <PdfViewerPane path={t.path} visible={visible} />
          </div>
        );
      })}
    </div>
  );
}
