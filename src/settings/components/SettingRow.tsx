import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type Props = {
  title: ReactNode;
  description?: string;
  children: React.ReactNode;
  className?: string;
  /**
   * Scroll anchor target for settings search. Defaults to `title` when it is a
   * plain string; pass this explicitly when `title` is a ReactNode.
   */
  anchorId?: string;
};

export function SettingRow({
  title,
  description,
  children,
  className,
  anchorId,
}: Props) {
  const anchor = anchorId ?? (typeof title === "string" ? title : undefined);
  return (
    <div
      data-setting-anchor={anchor}
      className={cn(
        "flex items-start justify-between gap-4 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5",
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[12.5px] font-medium">{title}</span>
        {description ? (
          <span className="text-[10.5px] leading-relaxed text-muted-foreground">
            {description}
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}
