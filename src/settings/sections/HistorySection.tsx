import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { useHistoryStore } from "@/modules/terminal/lib/historyStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setHistoryAutocomplete } from "@/modules/settings/store";
import { Delete02Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";

/** Cap on rendered rows. Filtering runs over the full list; only the slice is
 * mounted, so a 5000-entry history stays light. */
const MAX_ROWS = 300;

const SHELL_LABEL: Record<string, string> = {
  zsh: "Zsh",
  bash: "Bash",
  fish: "Fish",
  powershell: "PowerShell",
};

export function HistorySection() {
  const autocomplete = usePreferencesStore((s) => s.historyAutocomplete);
  const shell = useHistoryStore((s) => s.shell);
  const path = useHistoryStore((s) => s.path);
  const entries = useHistoryStore((s) => s.entries);
  const loaded = useHistoryStore((s) => s.loaded);
  const loading = useHistoryStore((s) => s.loading);
  const load = useHistoryStore((s) => s.load);
  const removeEntry = useHistoryStore((s) => s.removeEntry);
  const clearAll = useHistoryStore((s) => s.clearAll);

  const [query, setQuery] = useState("");

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((c) => c.toLowerCase().includes(q));
  }, [entries, query]);

  const shellLabel = SHELL_LABEL[shell] ?? shell;
  const shown = filtered.slice(0, MAX_ROWS);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="History"
        description="Shell command history used for inline autocomplete. Read from your platform's own history file."
      />

      <SettingRow
        title="Inline autocomplete"
        description="Suggest past commands as you type (ghost text + Ctrl+Space). Matched locally — never sent to any model."
      >
        <Switch
          checked={autocomplete}
          onCheckedChange={(v) => void setHistoryAutocomplete(v)}
        />
      </SettingRow>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <span className="text-[12.5px] font-medium">
              {shellLabel} history
            </span>
            <span className="truncate text-[10.5px] text-muted-foreground">
              {path ?? "No history file found"}
              {entries.length > 0 ? ` · ${entries.length} commands` : ""}
            </span>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                disabled={entries.length === 0}
                className="shrink-0 text-destructive hover:text-destructive"
              >
                Clear all
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear shell history?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently erases your {shellLabel} history file
                  {path ? ` (${path})` : ""}. It affects every terminal that
                  uses this shell, not just Termul. This can't be
                  undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => void clearAll()}
                  className="bg-destructive text-white hover:bg-destructive/90"
                >
                  Clear history
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        <div className="relative">
          <HugeiconsIcon
            icon={Search01Icon}
            size={13}
            strokeWidth={1.75}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter history…"
            className="h-8 pl-8 text-[12px]"
          />
        </div>

        <ScrollArea className="h-80 rounded-lg border border-border/60 bg-card/40">
          {shown.length === 0 ? (
            <div className="flex h-80 items-center justify-center px-4 text-center text-[11.5px] text-muted-foreground">
              {loading || !loaded
                ? "Loading…"
                : entries.length === 0
                  ? "No shell history found."
                  : "No commands match your filter."}
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5 p-1.5">
              {shown.map((cmd, i) => (
                <li
                  key={`${i}-${cmd}`}
                  className="group flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted/50"
                >
                  <code className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                    {cmd}
                  </code>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive"
                    title="Delete this command from history"
                    onClick={() => void removeEntry(cmd)}
                  >
                    <HugeiconsIcon
                      icon={Delete02Icon}
                      size={12}
                      strokeWidth={1.75}
                    />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
        {filtered.length > MAX_ROWS ? (
          <span className="text-[10.5px] text-muted-foreground">
            Showing first {MAX_ROWS} of {filtered.length} matches — refine the
            filter to narrow down.
          </span>
        ) : null}
      </div>
    </div>
  );
}
