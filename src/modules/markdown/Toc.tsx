import { cn } from "@/lib/utils";
import { type RefObject, useEffect, useState } from "react";

export type TocItem = { id: string; text: string; level: number };

type Props = {
  items: TocItem[];
  scrollRef: RefObject<HTMLElement | null>;
};

/** Table-of-contents sidebar with scrollspy, scoped to the preview's scroll
 * container. Heading ids are assigned by the pane before this renders. */
export function Toc({ items, scrollRef }: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || items.length === 0) return;
    const els = items
      .map((it) => root.querySelector<HTMLElement>(`[id="${it.id}"]`))
      .filter((e): e is HTMLElement => e !== null);
    if (els.length === 0) return;

    const visible = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        const top = items.find((it) => visible.has(it.id));
        if (top) setActiveId(top.id);
      },
      { root, rootMargin: "0px 0px -65% 0px", threshold: 0 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [items, scrollRef]);

  if (items.length === 0) return null;
  const minLevel = Math.min(...items.map((i) => i.level));

  const scrollTo = (id: string) => {
    const root = scrollRef.current;
    const el = root?.querySelector<HTMLElement>(`[id="${id}"]`);
    if (!root || !el) return;
    const top =
      el.getBoundingClientRect().top -
      root.getBoundingClientRect().top +
      root.scrollTop;
    root.scrollTo({ top: top - 8, behavior: "smooth" });
    setActiveId(id);
  };

  return (
    <nav className="w-56 shrink-0 overflow-auto border-l border-border/60 px-2 py-4">
      <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        On this page
      </p>
      <ul className="space-y-0.5">
        {items.map((it) => (
          <li key={it.id}>
            <button
              type="button"
              onClick={() => scrollTo(it.id)}
              style={{ paddingLeft: 8 + (it.level - minLevel) * 12 }}
              title={it.text}
              className={cn(
                "block w-full truncate rounded px-2 py-1 text-left text-[12px] text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground",
                activeId === it.id && "bg-accent/80 text-foreground",
              )}
            >
              {it.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
