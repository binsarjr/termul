import { Download01Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useUpdaterStore } from "./updaterStore";

/** Compact header affordance shown to the LEFT of the Search pill when an update
 * is waiting. Clicking it (re)opens the UpdaterDialog — so dismissing the dialog
 * with "Later" leaves this as the way back in. Hidden when nothing is pending. */
export function UpdateIndicator() {
  const status = useUpdaterStore((s) => s.status);
  const openDialog = useUpdaterStore((s) => s.openDialog);

  const ready = status.kind === "ready";
  const show =
    ready ||
    status.kind === "available" ||
    status.kind === "manual-available";
  if (!show) return null;

  const label = ready ? "Restart to update" : "Update available";
  return (
    <button
      type="button"
      onClick={openDialog}
      title={label}
      aria-label={label}
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-primary/10 px-2 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
    >
      <HugeiconsIcon
        icon={ready ? Refresh01Icon : Download01Icon}
        size={14}
        strokeWidth={2}
      />
      <span className="hidden md:inline">{ready ? "Restart" : "Update"}</span>
    </button>
  );
}
