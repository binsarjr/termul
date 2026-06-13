import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { IS_LINUX } from "@/lib/platform";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { useUpdater } from "./useUpdater";
import { useUpdaterStore } from "./updaterStore";

type DistroKey = "arch" | "debian" | "fedora";

function distroCommand(key: DistroKey, version: string): string {
  switch (key) {
    case "arch":
      return "yay -S termul-bin";
    case "debian":
      return `sudo apt install ./termul_${version}_amd64.deb`;
    case "fedora":
      return `sudo dnf install ./termul-${version}-1.x86_64.rpm`;
  }
}

const DISTROS: { key: DistroKey; label: string }[] = [
  { key: "arch", label: "Arch" },
  { key: "debian", label: "Debian / Ubuntu" },
  { key: "fedora", label: "Fedora / RHEL" },
];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdaterDialog() {
  // useUpdater drives the on-mount auto-check; dialogOpen/restart come straight
  // from the shared store so dismissing here doesn't drop the update state that
  // keeps the header indicator alive.
  const { status, check, install, restart, dismiss } = useUpdater();
  const dialogOpen = useUpdaterStore((s) => s.dialogOpen);
  const [copied, setCopied] = useState(false);
  const [distro, setDistro] = useState<DistroKey>("arch");
  const manualVersion =
    status.kind === "manual-available" ? status.info.version : "";
  const activeCommand = distroCommand(distro, manualVersion);

  // "checking" stays showable so a recheck triggered from inside the dialog
  // doesn't flash it closed; dialogOpen still gates the very first auto-check.
  const showable =
    status.kind === "available" ||
    status.kind === "manual-available" ||
    status.kind === "downloading" ||
    status.kind === "ready" ||
    status.kind === "checking";
  const open = dialogOpen && showable;

  if (!open) return null;

  const update = status.kind === "available" ? status.update : null;
  const manual = status.kind === "manual-available" ? status.info : null;
  const downloading = status.kind === "downloading";
  const ready = status.kind === "ready";
  const checking = status.kind === "checking";

  const copyCommand = async () => {
    if (!navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(activeCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };
  const progress =
    downloading && status.contentLength
      ? Math.min(100, (status.downloaded / status.contentLength) * 100)
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        // Allow closing any time except mid-download; closing keeps the update
        // state (and the header indicator) so it can be reopened later.
        if (!o && status.kind !== "downloading") dismiss();
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            {checking
              ? "Checking for updates…"
              : ready
                ? "Update ready"
                : downloading
                  ? "Downloading update…"
                  : manual
                    ? `Termul v${manual.version} is available`
                    : `Termul v${update?.version} is available`}
          </DialogTitle>
          <DialogDescription>
            {checking
              ? "Looking for the latest release…"
              : ready
                ? "Update downloaded. Restart now to finish installing — this closes all open tabs."
                : downloading
                  ? progress !== null
                    ? `${progress.toFixed(0)}% — ${formatBytes(status.downloaded)}`
                    : formatBytes(status.downloaded)
                  : manual
                    ? IS_LINUX
                      ? `You're on v${manual.currentVersion}. Pick your distro and run the command, or grab the package from GitHub.`
                      : `You're on v${manual.currentVersion}. Grab the latest package from GitHub to update.`
                    : update?.body || "A new version is ready to install."}
          </DialogDescription>
        </DialogHeader>

        {downloading && progress !== null && (
          <Progress value={progress} className="mt-2" />
        )}
        {downloading && progress === null && (
          <Progress value={undefined} className="mt-2 animate-pulse" />
        )}

        {manual && IS_LINUX && (
          <div className="mt-2 flex flex-col gap-2">
            <div className="flex gap-1 rounded-md bg-muted/40 p-1">
              {DISTROS.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => setDistro(d.key)}
                  className={`flex-1 rounded px-2 py-1 text-[11px] transition-colors ${
                    distro === d.key
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 font-mono text-[12px]">
              <span className="flex-1 select-all">$ {activeCommand}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => void copyCommand()}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          {checking && (
            <Button variant="ghost" size="sm" disabled>
              Checking…
            </Button>
          )}
          {status.kind === "available" && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="mr-auto"
                onClick={() => void check({ manual: true })}
              >
                Check again
              </Button>
              <Button variant="ghost" size="sm" onClick={dismiss}>
                Later
              </Button>
              <Button size="sm" onClick={() => void install()}>
                Download &amp; install
              </Button>
            </>
          )}
          {ready && (
            <>
              <Button variant="ghost" size="sm" onClick={dismiss}>
                Later
              </Button>
              <Button size="sm" onClick={() => void restart()}>
                Restart now
              </Button>
            </>
          )}
          {manual && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="mr-auto"
                onClick={() => void check({ manual: true })}
              >
                Check again
              </Button>
              <Button variant="ghost" size="sm" onClick={dismiss}>
                Later
              </Button>
              <Button
                size="sm"
                onClick={() => void openUrl(manual.releaseUrl)}
              >
                Download package
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
