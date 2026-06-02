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
import { labelFor, TabIcon } from "./TabBar";
import type { Tab } from "./lib/useTabs";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSelect: (id: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCopyLastCommand?: () => void;
  onCopyLastCommandOutput?: () => void;
};

/** Secondary line shown under the tab label — the path/cwd that disambiguates
 * same-named tabs, and the text the fuzzy filter matches against. */
function subtitleFor(t: Tab): string {
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

export function TabSearch({
  tabs,
  activeId,
  onSelect,
  open,
  onOpenChange,
  onCopyLastCommand,
  onCopyLastCommandOutput,
}: Props) {
  const hasCommands = !!(onCopyLastCommand || onCopyLastCommandOutput);
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
          <CommandEmpty>No results found.</CommandEmpty>
          {hasCommands ? (
            <CommandGroup heading="Commands">
              {onCopyLastCommand ? (
                <CommandItem
                  value="Copy last command #cmd-copy-command"
                  onSelect={() => {
                    onCopyLastCommand();
                    onOpenChange(false);
                  }}
                >
                  <span className="shrink-0 truncate">Copy last command</span>
                  <span className="flex-1" />
                </CommandItem>
              ) : null}
              {onCopyLastCommandOutput ? (
                <CommandItem
                  value="Copy last command output #cmd-copy-output"
                  onSelect={() => {
                    onCopyLastCommandOutput();
                    onOpenChange(false);
                  }}
                >
                  <span className="shrink-0 truncate">
                    Copy last command output
                  </span>
                  <span className="flex-1" />
                </CommandItem>
              ) : null}
            </CommandGroup>
          ) : null}
          <CommandGroup heading="Tabs">
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
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
