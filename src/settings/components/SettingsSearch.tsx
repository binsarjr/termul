import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  SECTION_LABELS,
  searchSettings,
  type SettingsSearchEntry,
} from "@/settings/lib/searchIndex";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

type Props = {
  onSelect: (entry: SettingsSearchEntry) => void;
};

export function SettingsSearch({ onSelect }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Defer the searched query so rapid typing stays responsive: the input
  // updates immediately while ranking runs in a non-blocking transition.
  const deferredQuery = useDeferredValue(query);
  const results = useMemo(() => searchSettings(deferredQuery), [deferredQuery]);

  // Close the dropdown when clicking outside the search box.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const choose = (entry: SettingsSearchEntry) => {
    onSelect(entry);
    setOpen(false);
    setQuery("");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      // Swallow so the Settings tab's global Escape handler doesn't fire.
      e.stopPropagation();
      if (query || open) {
        e.preventDefault();
        setQuery("");
        setOpen(false);
      }
      return;
    }
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      const entry = results[active];
      if (entry) {
        e.preventDefault();
        choose(entry);
      }
    }
  };

  const showList = open && query.trim().length > 0;

  return (
    <div ref={wrapRef} className="relative w-full">
      <HugeiconsIcon
        icon={Search01Icon}
        size={13}
        strokeWidth={2}
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        value={query}
        placeholder="Search settings…"
        spellCheck={false}
        onChange={(e) => {
          // Reset the highlight to the top match as the query changes, set
          // together with the query so there is no stale-highlight frame.
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        className="h-7 pl-8 text-[12px]"
      />

      {showList && (
        <div className="absolute top-full left-0 z-50 mt-1.5 w-full overflow-hidden rounded-lg border border-border/70 bg-popover/95 shadow-lg backdrop-blur-sm">
          {results.length === 0 ? (
            <div className="px-3 py-2.5 text-[12px] text-muted-foreground">
              No settings match “{query.trim()}”.
            </div>
          ) : (
            <ul className="max-h-80 overflow-y-auto py-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {results.map((entry, i) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    // Use mousedown so it fires before the input blur closes the list.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(entry);
                    }}
                    onMouseEnter={() => setActive(i)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors",
                      i === active ? "bg-accent" : "hover:bg-accent/60",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[12.5px] font-medium">
                        {entry.label}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {SECTION_LABELS[entry.section]}
                        {entry.group !== SECTION_LABELS[entry.section]
                          ? ` › ${entry.group}`
                          : ""}
                      </span>
                    </div>
                    {entry.description ? (
                      <span className="truncate text-[10.5px] text-muted-foreground">
                        {entry.description}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
