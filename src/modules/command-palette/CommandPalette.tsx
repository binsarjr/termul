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
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import { labelFor, TabIcon, type Tab } from "@/modules/tabs";

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
  }
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
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Jump to a tab, run a command, or open a file"
    >
      <Command>
        <CommandInput placeholder="Search tabs, commands, files…" />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>

          <CommandGroup heading="Tabs">
            {tabs.map((t) => {
              const subtitle = tabSubtitle(t);
              return (
                <CommandItem
                  key={`tab-${t.id}`}
                  // cmdk fuzzy-matches the query against this value; the `#id`
                  // suffix keeps it unique so duplicate labels stay selectable.
                  value={`tab ${labelFor(t)} ${subtitle} ${t.kind} #${t.id}`}
                  onSelect={() => {
                    onOpenChange(false);
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

          <CommandGroup heading="Commands">
            {commands.map((c) => (
              <CommandItem
                key={`cmd-${c.id}`}
                value={`command ${c.label} #${c.id}`}
                onSelect={() => {
                  onOpenChange(false);
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

          <CommandGroup heading="Files">
            {files.map((f) => (
              <CommandItem
                key={`file-${f.path}`}
                value={`file ${f.name} ${f.path} #${f.path}`}
                onSelect={() => {
                  onOpenChange(false);
                  onOpenFile(f.path);
                }}
              >
                <img src={fileIconUrl(f.name)} alt="" className="size-3.5 shrink-0" />
                <span className="shrink-0 truncate">{f.name}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {f.path}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
