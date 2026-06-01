import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { FilterIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { filterBlockOutput } from "./lib/blockFilter";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The command that produced the output (shown in the header). */
  command: string;
  /** The block output being filtered (read once when the dialog opens). */
  output: string;
};

/**
 * Non-destructive filter over a single block's output — a client-side grep with
 * an optional case-insensitive regex. Mirrors Warp's per-block output filter;
 * the terminal buffer is never touched.
 */
export function BlockFilterDialog({
  open,
  onOpenChange,
  command,
  output,
}: Props) {
  const [query, setQuery] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setUseRegex(false);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const result = useMemo(
    () => filterBlockOutput(output, query, useRegex),
    [output, query, useRegex],
  );

  const copyFiltered = () => {
    const text = result.lines.join("\n");
    if (text) void navigator.clipboard.writeText(text).catch(() => {});
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.75">
            <HugeiconsIcon icon={FilterIcon} size={16} strokeWidth={1.75} />
            Filter output
          </DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">
            {command.trim() || "(command)"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3">
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={useRegex ? "regex…" : "filter lines…"}
            className="flex-1"
          />
          <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Switch checked={useRegex} onCheckedChange={setUseRegex} />
            Regex
          </label>
        </div>

        <div className="text-xs text-muted-foreground">
          {result.invalid ? (
            <span className="text-destructive">Invalid regular expression</span>
          ) : (
            `${result.lines.length} of ${result.total} lines`
          )}
        </div>

        <div className="max-h-[50vh] overflow-auto rounded-md border border-border/60 bg-muted/30">
          {result.lines.length ? (
            <pre className="whitespace-pre-wrap break-words p-2 font-mono text-xs leading-relaxed">
              {result.lines.join("\n")}
            </pre>
          ) : (
            <div className="p-3 text-xs text-muted-foreground">No matches.</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={copyFiltered} disabled={!result.lines.length}>
            Copy filtered
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
