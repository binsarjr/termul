import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { fileIconUrl, useIconsLoaded } from "@/modules/explorer/lib/iconResolver";
import { labelFor, TabIcon, type Tab } from "@/modules/tabs";
import { useDeferredValue, useMemo, useState } from "react";

export type PaletteCommand = {
  id: string;
  label: string;
  /** Pre-rendered key tokens (e.g. ["⌘", "K"]) for the trailing shortcut. */
  bindingTokens: string[];
  run: () => void;
};

export type PaletteFile = {
  /** Absolute path, used as the open target and the unique row value. */
  path: string;
  /** Display name (basename). */
  name: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabs: Tab[];
  activeId: number;
  onSelectTab: (id: number) => void;
  commands: PaletteCommand[];
  files: PaletteFile[];
  onOpenFile: (path: string) => void;
};

/** The workspace can hold thousands of files; only ever render the top matches
 * so a keystroke never has to lay out the whole list. */
const MAX_FILE_RESULTS = 50;

/** Secondary line under a tab label: the path/cwd that disambiguates
 * same-named tabs and feeds the fuzzy filter. Mirrors TabSearch. */
function tabSubtitle(t: Tab): string {
  switch (t.kind) {
    case "terminal":
      return t.cwd ?? "";
    case "editor":
    case "markdown":
    case "pdf":
    case "image":
    case "ai-diff":
    case "git-diff":
      return t.path;
    case "git-commit-file":
      return `${t.path} @ ${t.shortSha}`;
    case "git-history":
      return t.repoRoot;
    case "settings":
      return "";
  }
}

/** Cheap match used in place of cmdk's built-in scorer so we control when
 * filtering runs (via useDeferredValue). `q` is already lowercased. Returns a
 * rank where lower is better, or -1 for no match. A contiguous substring beats
 * a scattered subsequence. */
function fuzzyScore(text: string, q: string): number {
  const t = text.toLowerCase();
  const sub = t.indexOf(q);
  if (sub !== -1) return sub;
  let ti = 0;
  for (let i = 0; i < q.length; i++) {
    // ordered subsequence match: string indexOf with an advancing offset; a Set
    // would drop the positional/order info this scorer depends on.
    // react-doctor-disable-next-line js-set-map-lookups, react-doctor/js-set-map-lookups
    ti = t.indexOf(q[i], ti);
    if (ti === -1) return -1;
    ti += 1;
  }
  return 500 + t.length;
}

function rankList<T>(items: T[], q: string, key: (item: T) => string): T[] {
  if (!q) return items;
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = fuzzyScore(key(item), q);
    if (score >= 0) scored.push({ item, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.map((s) => s.item);
}

export function CommandPalette({
  open,
  onOpenChange,
  tabs,
  activeId,
  onSelectTab,
  commands,
  files,
  onOpenFile,
}: Props) {
  const [query, setQuery] = useState("");
  useIconsLoaded();
  // Defer the query the filters read so rapid typing stays responsive: the
  // input updates immediately while the (potentially large) list re-filters in
  // a non-blocking transition. This is the debounce the search needed.
  const q = useDeferredValue(query).trim().toLowerCase();

  const visibleTabs = useMemo(
    () =>
      rankList(tabs, q, (t) => `${labelFor(t)} ${tabSubtitle(t)} ${t.kind}`),
    [tabs, q],
  );
  const visibleCommands = useMemo(
    () => rankList(commands, q, (c) => c.label),
    [commands, q],
  );
  const visibleFiles = useMemo(
    () =>
      rankList(files, q, (f) => `${f.name} ${f.path}`).slice(0, MAX_FILE_RESULTS),
    [files, q],
  );

  const isEmpty =
    visibleTabs.length === 0 &&
    visibleCommands.length === 0 &&
    visibleFiles.length === 0;

  const close = () => {
    setQuery("");
    onOpenChange(false);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setQuery("");
        onOpenChange(o);
      }}
      title="Command palette"
      description="Jump to a tab, run a command, or open a file"
    >
      {/* We filter ourselves (above) so cmdk does not re-score every row on each
          keystroke; shouldFilter={false} hands rendering of only the matches to
          cmdk. */}
      <Command shouldFilter={false}>
        <CommandInput
          placeholder="Search tabs, commands, files…"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          {isEmpty ? <CommandEmpty>No results found.</CommandEmpty> : null}

          {visibleTabs.length > 0 && (
            <CommandGroup heading="Tabs">
              {visibleTabs.map((t) => {
                const subtitle = tabSubtitle(t);
                return (
                  <CommandItem
                    key={`tab-${t.id}`}
                    value={`tab-${t.id}`}
                    onSelect={() => {
                      close();
                      onSelectTab(t.id);
                    }}
                  >
                    <TabIcon tab={t} />
                    <span className="shrink-0 truncate">{labelFor(t)}</span>
                    {subtitle ? (
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {subtitle}
                      </span>
                    ) : (
                      <span className="flex-1" />
                    )}
                    {t.id === activeId ? (
                      <CommandShortcut>current</CommandShortcut>
                    ) : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}

          {visibleCommands.length > 0 && (
            <CommandGroup heading="Commands">
              {visibleCommands.map((c) => (
                <CommandItem
                  key={`cmd-${c.id}`}
                  value={`cmd-${c.id}`}
                  onSelect={() => {
                    close();
                    c.run();
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.bindingTokens.length > 0 ? (
                    <CommandShortcut>{c.bindingTokens.join("")}</CommandShortcut>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          )}

          {visibleFiles.length > 0 && (
            <CommandGroup heading="Files">
              {visibleFiles.map((f) => (
                <CommandItem
                  key={`file-${f.path}`}
                  value={`file-${f.path}`}
                  onSelect={() => {
                    close();
                    onOpenFile(f.path);
                  }}
                >
                  <img
                    src={fileIconUrl(f.name)}
                    alt=""
                    className="size-3.5 shrink-0"
                  />
                  <span className="shrink-0 truncate">{f.name}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {f.path}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
