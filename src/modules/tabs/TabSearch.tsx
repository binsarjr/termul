import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { labelFor, TabIcon } from "./TabBar";
import type { Tab } from "./lib/useTabs";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSelect: (id: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Secondary line shown under the tab label — the path/cwd that disambiguates
 * same-named tabs, and the text the fuzzy filter matches against. */
function subtitleFor(t: Tab): string {
  switch (t.kind) {
    case "terminal":
      return t.cwd ?? "";
    case "editor":
    case "markdown":
    case "ai-diff":
    case "git-diff":
      return t.path;
    case "git-commit-file":
      return `${t.path} @ ${t.shortSha}`;
    case "git-history":
      return t.repoRoot;
  }
}

export function TabSearch({
  tabs,
  activeId,
  onSelect,
  open,
  onOpenChange,
}: Props) {
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search tabs"
      description="Switch to an open tab"
    >
      <Command>
        <CommandInput placeholder="Search tabs…" />
        <CommandList>
          <CommandEmpty>No tabs found.</CommandEmpty>
          {tabs.map((t) => {
            const subtitle = subtitleFor(t);
            return (
              <CommandItem
                key={t.id}
                // cmdk fuzzy-matches the query against this value; the `#id`
                // suffix keeps it unique so duplicate labels stay selectable.
                value={`${labelFor(t)} ${subtitle} ${t.kind} #${t.id}`}
                onSelect={() => {
                  onSelect(t.id);
                  onOpenChange(false);
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
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
