import { cn } from "@/lib/utils";

type Props = {
  mode: "editor" | "preview";
  onPlainText: () => void;
  onPreview: () => void;
};

/**
 * Segmented "Plain Text | Preview" switch shown top-right of a markdown file.
 * The active mode is highlighted; clicking the other segment opens/focuses the
 * sibling tab (editor <-> preview), making preview discoverable without the
 * explorer right-click menu.
 */
export function MarkdownViewToggle({ mode, onPlainText, onPreview }: Props) {
  return (
    <div className="flex h-6 items-center gap-0.5 rounded-md bg-muted/60 p-0.5 text-[11px]">
      <Segment active={mode === "editor"} onClick={onPlainText}>
        Plain Text
      </Segment>
      <Segment active={mode === "preview"} onClick={onPreview}>
        Preview
      </Segment>
    </div>
  );
}

function Segment({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={active ? undefined : onClick}
      className={cn(
        "rounded px-2 py-0.5 transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
