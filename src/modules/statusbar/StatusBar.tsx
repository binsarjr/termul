import { useChatStore } from "@/modules/ai";
import { AgentStatusPill } from "@/modules/ai/components/AgentStatusPill";
import {
  AiOpenButton,
  AiStatusBarControls,
} from "@/modules/ai/components/AiStatusBarControls";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  CloudServerIcon,
  FolderOpenIcon,
  IncognitoIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { CwdBreadcrumb } from "./CwdBreadcrumb";
import { WorkspaceEnvSelector } from "./WorkspaceEnvSelector";
import type { WorkspaceEnv } from "@/modules/workspace";

type Props = {
  cwd: string | null;
  /** Remote (SSH) cwd of the active terminal; shown as a pill. The local
   * breadcrumb keeps tracking `cwd` — only the shell is on the remote host. */
  remoteCwd?: string | null;
  /** Host of a detected local `ssh <host>` session (stock remote shell, no
   * integration). Drives the same pill when no `remoteCwd` is known; the more
   * specific `remoteCwd` wins when both are set. */
  sshHost?: string | null;
  filePath?: string | null;
  home: string | null;
  onCd: (path: string) => void;
  onWorkspaceChange: (env: WorkspaceEnv) => void;
  /** Open the native folder picker and re-root the workspace at the choice. */
  onOpenFolder: () => void;
  onOpenMini: () => void;
  /** Only rendered when the AI panel is open and a key is loaded. */
  hasComposer: boolean;
  privateActive: boolean;
};

export function StatusBar({
  cwd,
  remoteCwd,
  sshHost,
  filePath,
  home,
  onCd,
  onWorkspaceChange,
  onOpenFolder,
  onOpenMini,
  hasComposer,
  privateActive,
}: Props) {
  const panelOpen = useChatStore((s) => s.panelOpen);
  const openPanel = useChatStore((s) => s.openPanel);

  // The pill shows the remote cwd (precise) when the remote shell emits OSC 7,
  // else the bare host of a `ssh <host>` we detected from the command line.
  const remoteLabel = remoteCwd ?? sshHost ?? null;

  return (
    <footer className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-card/60 px-3 text-[11px]">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <WorkspaceEnvSelector onSelect={onWorkspaceChange} />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onOpenFolder}
              className="flex h-6 shrink-0 items-center justify-center rounded-sm px-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus:outline-none focus-visible:outline-none focus-visible:ring-0"
              title="Open folder"
              aria-label="Open folder"
            >
              <HugeiconsIcon icon={FolderOpenIcon} size={13} strokeWidth={1.75} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-[11px]">
            Open a folder on any drive as the workspace
          </TooltipContent>
        </Tooltip>
        <CwdBreadcrumb cwd={cwd} filePath={filePath} home={home} onCd={onCd} />
        {remoteLabel ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex min-w-0 shrink cursor-default items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10.5px] font-medium text-sky-700 dark:text-sky-400">
                <HugeiconsIcon
                  icon={CloudServerIcon}
                  size={11}
                  strokeWidth={2}
                />
                <span className="truncate">{remoteLabel}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="max-w-72 text-[11px] leading-relaxed"
            >
              {remoteCwd
                ? "Remote working directory over SSH. The file explorer stays on your local machine — only this terminal's shell is on the remote host."
                : `SSH session to ${sshHost} — detected from your ssh command. The file explorer stays on your local machine.`}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {privateActive ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex shrink-0 cursor-default items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-400">
                <HugeiconsIcon icon={IncognitoIcon} size={11} strokeWidth={2} />
                <span>Private: hidden from AI</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-64 text-[11px] leading-relaxed">
              AI can't see this terminal's output. Use it for secrets, SSH, or
              anything you don't want sent to the model.
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <AgentStatusPill onClick={onOpenMini} />
        {panelOpen && hasComposer ? (
          <AiStatusBarControls />
        ) : (
          <AiOpenButton onOpen={openPanel} />
        )}
      </div>
    </footer>
  );
}
