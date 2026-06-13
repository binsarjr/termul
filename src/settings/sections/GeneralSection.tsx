import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { TabBarPositionPref, ThemePref } from "@/modules/settings/store";
import {
  MAX_PANES_PER_TAB_MAX,
  MAX_PANES_PER_TAB_MIN,
  TERMINAL_FONT_SIZES,
  TERMINAL_SCROLLBACK_PRESETS,
  setAgentNotifications,
  setDimInactivePanes,
  setMaxPanesPerTab,
  setAutostart,
  setConfirmBeforeQuit,
  setEditorAutoSave,
  setEditorAutoSaveDelay,
  setRestoreSession,
  setRestoreWindowState,
  setShowHidden,
  setTerminalFontFamily,
  setTerminalLetterSpacing,
  setTerminalFontSize,
  setDropHibernatedOutput,
  setTerminalScrollback,
  setTerminalWebglEnabled,
  setTabBarPosition,
  setTabSshBadge,
  setTabTitleFromActivePane,
  setTruncateTabTitles,
  setVimMode,
  setZoomLevel,
} from "@/modules/settings/store";
import { clearSession } from "@/modules/tabs/lib/sessionStore";
import { useTheme } from "@/modules/theme";
import {
  ComputerIcon,
  Moon02Icon,
  Sun03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useEffect, useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { SettingRow } from "../components/SettingRow";
import { useSliderDraft } from "../lib/useSliderDraft";

const APPEARANCE: {
  id: ThemePref;
  label: string;
  icon: typeof ComputerIcon;
}[] = [
  { id: "system", label: "System", icon: ComputerIcon },
  { id: "light", label: "Light", icon: Sun03Icon },
  { id: "dark", label: "Dark", icon: Moon02Icon },
];

const LETTER_SPACINGS = [-4, -3, -2, -1, 0, 1, 2, 3, 4] as const;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.05;
const AUTO_SAVE_STEP = 100;
const AUTO_SAVE_MIN = 100;
const AUTO_SAVE_MAX = 60000;

const onToggleAutostart = async (next: boolean) => {
  try {
    if (next) await enable();
    else await disable();
    await setAutostart(next);
  } catch (e) {
    console.error("autostart toggle failed", e);
  }
};

// structural refactor deferred (settings section kept as one component)
// react-doctor-disable-next-line react-doctor/no-giant-component
export function GeneralSection() {
  const { mode, setMode } = useTheme();

  const autostart = usePreferencesStore((s) => s.autostart);
  const restoreWindowState = usePreferencesStore((s) => s.restoreWindowState);
  const restoreSession = usePreferencesStore((s) => s.restoreSession);
  const confirmBeforeQuit = usePreferencesStore((s) => s.confirmBeforeQuit);
  const vimMode = usePreferencesStore((s) => s.vimMode);
  const editorAutoSave = usePreferencesStore((s) => s.editorAutoSave);
  const editorAutoSaveDelay = usePreferencesStore((s) => s.editorAutoSaveDelay);
  const showHidden = usePreferencesStore((s) => s.showHidden);
  const terminalWebglEnabled = usePreferencesStore(
    (s) => s.terminalWebglEnabled,
  );
  const dropHibernatedOutput = usePreferencesStore(
    (s) => s.dropHibernatedOutput,
  );
  const terminalFontFamily = usePreferencesStore((s) => s.terminalFontFamily);
  const terminalLetterSpacing = usePreferencesStore(
    (s) => s.terminalLetterSpacing,
  );
  const terminalFontSize = usePreferencesStore((s) => s.terminalFontSize);
  const terminalScrollback = usePreferencesStore((s) => s.terminalScrollback);
  const maxPanesPerTab = usePreferencesStore((s) => s.maxPanesPerTab);
  const dimInactivePanes = usePreferencesStore((s) => s.dimInactivePanes);
  const tabTitleFromActivePane = usePreferencesStore(
    (s) => s.tabTitleFromActivePane,
  );
  const tabSshBadge = usePreferencesStore((s) => s.tabSshBadge);
  const truncateTabTitles = usePreferencesStore((s) => s.truncateTabTitles);
  const tabBarPosition = usePreferencesStore((s) => s.tabBarPosition);
  const zoomLevel = usePreferencesStore((s) => s.zoomLevel);
  const agentNotifications = usePreferencesStore((s) => s.agentNotifications);

  const [zoomShown, setZoomDraft] = useSliderDraft(zoomLevel);

  useEffect(() => {
    let alive = true;
    void isEnabled()
      .then((on) => {
        if (!alive) return;
        if (on !== usePreferencesStore.getState().autostart) {
          void setAutostart(on);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="General"
        description="Mode, editor, and startup."
      />

      <div className="flex flex-col gap-2">
        <Label>Appearance</Label>
        <div className="grid grid-cols-3 gap-2">
          {APPEARANCE.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setMode(o.id)}
              className={cn(
                "group flex h-20 flex-col items-center justify-center gap-1.5 rounded-lg border bg-card transition-all",
                mode === o.id
                  ? "border-foreground/60 ring-1 ring-foreground/20"
                  : "border-border/60 hover:border-border",
              )}
            >
              <HugeiconsIcon icon={o.icon} size={18} strokeWidth={1.5} />
              <span className="text-[11.5px]">{o.label}</span>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          For theme, background and customization, see the{" "}
          <strong className="font-medium text-foreground">Themes</strong> tab.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Zoom</Label>
        <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11.5px] text-muted-foreground">
              UI zoom level
            </span>
            <span className="tabular-nums text-[11px] text-muted-foreground">
              {Math.round(zoomShown * 100)}%
            </span>
          </div>
          <Slider
            value={[zoomShown]}
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={ZOOM_STEP}
            onValueChange={(v) => setZoomDraft(v[0] ?? 1)}
            onValueCommit={(v) => void setZoomLevel(v[0] ?? 1)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Editor</Label>
        <SettingRow
          title="Vim mode"
          description="Enable Vim keybindings in the code editor."
        >
          <Switch
            checked={vimMode}
            onCheckedChange={(v) => void setVimMode(v)}
          />
        </SettingRow>
        <SettingRow
          title="Auto save"
          description="Automatically save files after a delay when changes are detected."
        >
          <Switch
            checked={editorAutoSave}
            onCheckedChange={(v) => void setEditorAutoSave(v)}
          />
        </SettingRow>
        {editorAutoSave && (
          <AutoSaveDelayInput
            value={editorAutoSaveDelay}
            onChange={(v) => void setEditorAutoSaveDelay(v)}
          />
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label>Explorer</Label>
        <SettingRow
          title="Show hidden files"
          description="Include dot-prefixed files and folders (.env, .gitignore, .config) in the file explorer and search."
        >
          <Switch
            checked={showHidden}
            onCheckedChange={(v) => void setShowHidden(v)}
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Terminal</Label>
        <SettingRow
          anchorId="use-webgl-renderer"
          title={
            <span className="inline-flex items-center gap-1.5">
              Use WebGL renderer
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span
                      className="cursor-help text-[11px] text-muted-foreground/70 leading-none"
                      aria-label="More info about WebGL renderer"
                    >
                      ⓘ
                    </span>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    className="max-w-65 text-[11px]"
                  >
                    xterm's WebGL renderer caches glyphs in a GPU texture
                    atlas. On some macOS setups (especially with Nerd Fonts),
                    the atlas corrupts and terminal text becomes unreadable.
                    Turn this off as a fallback: performance dips slightly,
                    but text renders correctly via the DOM renderer.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </span>
          }
          description="Hardware-accelerated rendering. Turn off if text shows corruption or blank tiles."
        >
          <Switch
            checked={terminalWebglEnabled}
            onCheckedChange={(v) => void setTerminalWebglEnabled(v)}
          />
        </SettingRow>
        <SettingRow
          title="Trim output for hibernated tabs"
          description="Hidden tabs buffer their output capped at 256 KB; older output is dropped (shown as a notice on return). Turn off to keep everything — uses more memory for noisy background tabs."
        >
          <Switch
            checked={dropHibernatedOutput}
            onCheckedChange={(v) => void setDropHibernatedOutput(v)}
          />
        </SettingRow>
        <SettingRow
          title="Font family"
          description='Nerd Font name for icons (e.g. "CaskaydiaCove Nerd Font Mono"). Leave blank to auto-detect.'
        >
          <input
            type="text"
            aria-label="Font family"
            value={terminalFontFamily}
            placeholder="Auto-detect"
            onChange={(e) => void setTerminalFontFamily(e.target.value)}
            className="h-8 w-48 rounded-md border border-border bg-background px-2.5 text-[12px] outline-none focus:border-foreground/40"
          />
        </SettingRow>
        <SettingRow
          title="Letter spacing"
          description="Extra horizontal space between characters (px). Use negative values to tighten Nerd Fonts."
        >
          <Select
            value={String(terminalLetterSpacing)}
            onValueChange={(v) => void setTerminalLetterSpacing(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-28 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LETTER_SPACINGS.map((v) => (
                <SelectItem key={v} value={String(v)} className="text-[12px]">
                  {v > 0 ? `+${v}` : v} px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow title="Font size" description="Terminal text size.">
          <Select
            value={String(terminalFontSize)}
            onValueChange={(v) => void setTerminalFontSize(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-28 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_FONT_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)} className="text-[12px]">
                  {size} px
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="Scrollback"
          description="Lines of history kept per terminal. Higher uses more RAM (~3 KB / line)."
        >
          <Select
            value={String(terminalScrollback)}
            onValueChange={(v) => void setTerminalScrollback(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-36 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TERMINAL_SCROLLBACK_PRESETS.map((lines) => (
                <SelectItem
                  key={lines}
                  value={String(lines)}
                  className="text-[12px]"
                >
                  {lines.toLocaleString()} lines
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="Max panes per tab"
          description="How many terminals a single tab can be split into. Higher keeps more live renderers in memory."
        >
          <Select
            value={String(maxPanesPerTab)}
            onValueChange={(v) => void setMaxPanesPerTab(Number(v))}
          >
            <SelectTrigger size="sm" className="h-8 w-28 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from(
                { length: MAX_PANES_PER_TAB_MAX - MAX_PANES_PER_TAB_MIN + 1 },
                (_, i) => MAX_PANES_PER_TAB_MIN + i,
              ).map((n) => (
                <SelectItem key={n} value={String(n)} className="text-[12px]">
                  {n} panes
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          title="Dim inactive panes"
          description="Reduce opacity of panes that are not focused to visually highlight the active one."
        >
          <Switch
            checked={dimInactivePanes}
            onCheckedChange={(v) => void setDimInactivePanes(v)}
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Tabs</Label>
        <SettingRow
          title="Name tabs from active pane"
          description="Auto-name a terminal tab after its focused pane (current folder or SSH host) until you rename it. Off keeps a static title."
        >
          <Switch
            checked={tabTitleFromActivePane}
            onCheckedChange={(v) => void setTabTitleFromActivePane(v)}
          />
        </SettingRow>
        <SettingRow
          title="Show SSH host badge"
          description="Badge a terminal tab with its host when its active pane is connected over SSH."
        >
          <Switch
            checked={tabSshBadge}
            onCheckedChange={(v) => void setTabSshBadge(v)}
          />
        </SettingRow>
        <SettingRow
          title="Truncate long tab titles"
          description="Cut long tab names with an ellipsis. Off shows the full name and lets the tab strip scroll."
        >
          <Switch
            checked={truncateTabTitles}
            onCheckedChange={(v) => void setTruncateTabTitles(v)}
          />
        </SettingRow>
        <SettingRow
          title="Tab bar position"
          description="Show tabs across the top or as a resizable column to the left of the sidebar."
        >
          <Select
            value={tabBarPosition}
            onValueChange={(v) => void setTabBarPosition(v as TabBarPositionPref)}
          >
            <SelectTrigger size="sm" className="h-8 w-28 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="top" className="text-[12px]">
                Top
              </SelectItem>
              <SelectItem value="left" className="text-[12px]">
                Left
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Agents</Label>
        <SettingRow
          title="Coding agent notifications"
          description="Alert when Claude Code or Codex running in a terminal needs your input or finishes. Desktop notification when Termul is unfocused, in-app otherwise."
        >
          <Switch
            checked={agentNotifications}
            onCheckedChange={(v) => void setAgentNotifications(v)}
          />
        </SettingRow>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Startup</Label>
        <div className="flex flex-col gap-2">
          <SettingRow
            title="Launch at login"
            description="Open Termul automatically when you sign in."
          >
            <Switch
              checked={autostart}
              onCheckedChange={(v) => void onToggleAutostart(v)}
            />
          </SettingRow>
          <SettingRow
            title="Restore window position & size"
            description="Reopen the main window where you left it. Applies on next launch."
          >
            <Switch
              checked={restoreWindowState}
              onCheckedChange={(v) => void setRestoreWindowState(v)}
            />
          </SettingRow>
          <SettingRow
            title="Restore tabs on launch"
            description="Reopen the previous session's tabs, split panes, and scrollback. Turning this off deletes the saved session."
          >
            <Switch
              checked={restoreSession}
              onCheckedChange={(v) => {
                void setRestoreSession(v);
                if (!v) void clearSession();
              }}
            />
          </SettingRow>
          <SettingRow
            title="Confirm before closing"
            description="Ask before the window closes, so a stray click can't end every running shell."
          >
            <Switch
              checked={confirmBeforeQuit}
              onCheckedChange={(v) => void setConfirmBeforeQuit(v)}
            />
          </SettingRow>
        </div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
      {children}
    </span>
  );
}

function AutoSaveDelayInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  // draft is independently editable; this resyncs it to the canonical value prop, not pure derived state
  // react-doctor-disable-next-line react-doctor/no-derived-state-effect, react-doctor/no-reset-all-state-on-prop-change
  useEffect(() => {
    // react-doctor-disable-next-line react-doctor/no-derived-state
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(
      AUTO_SAVE_MAX,
      Math.max(AUTO_SAVE_MIN, Math.round(n)),
    );
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <SettingRow
      title="Auto save delay"
      description="Delay before unsaved changes are saved automatically."
    >
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={AUTO_SAVE_MIN}
          max={AUTO_SAVE_MAX}
          step={AUTO_SAVE_STEP}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            }
          }}
          className="h-8 w-20 rounded-md border border-border bg-background px-2.5 text-right text-[12px] md:text-[12px] tabular-nums outline-none focus:border-foreground/40 focus-visible:ring-0 focus-visible:border-foreground/40 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        <span className="text-[11px] text-muted-foreground">ms</span>
      </div>
    </SettingRow>
  );
}

