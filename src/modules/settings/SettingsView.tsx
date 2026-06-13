import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { SettingsSection } from "@/modules/settings/openSettings";
import { SettingsSearch } from "@/settings/components/SettingsSearch";
import { entryAnchor, type SettingsSearchEntry } from "@/settings/lib/searchIndex";
import { AboutSection } from "@/settings/sections/AboutSection";
import { AgentsSection } from "@/settings/sections/AgentsSection";
import { GeneralSection } from "@/settings/sections/GeneralSection";
import { HistorySection } from "@/settings/sections/HistorySection";
import { ModelsSection } from "@/settings/sections/ModelsSection";
import { ShortcutsSection } from "@/settings/sections/ShortcutsSection";
import { ThemesSection } from "@/settings/sections/ThemesSection";
import {
  AiScanIcon,
  Clock01Icon,
  InformationCircleIcon,
  KeyboardIcon,
  PaintBoardIcon,
  Settings01Icon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { JSX, useCallback, useEffect, useRef } from "react";

const SECTIONS: {
  id: SettingsSection;
  label: string;
  icon: typeof Settings01Icon;
  component: () => JSX.Element;
}[] = [
  { id: "general", label: "General", icon: Settings01Icon, component: GeneralSection },
  { id: "themes", label: "Themes", icon: PaintBoardIcon, component: ThemesSection },
  { id: "shortcuts", label: "Shortcuts", icon: KeyboardIcon, component: ShortcutsSection },
  { id: "models", label: "Models", icon: AiScanIcon, component: ModelsSection },
  { id: "agents", label: "Agents", icon: UserMultiple02Icon, component: AgentsSection },
  { id: "history", label: "History", icon: Clock01Icon, component: HistorySection },
  { id: "about", label: "About", icon: InformationCircleIcon, component: AboutSection },
];

type Props = {
  section: SettingsSection;
  /** True while the Settings tab is the active tab — gates the Escape handler. */
  active: boolean;
  onSectionChange: (section: SettingsSection) => void;
  onRequestClose: () => void;
};

export function SettingsView({
  section,
  active,
  onSectionChange,
  onRequestClose,
}: Props) {
  const init = usePreferencesStore((s) => s.init);
  const ActiveSection = SECTIONS.find((s) => s.id === section)?.component;

  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void init();
  }, [init]);

  const onSearchSelect = useCallback(
    (entry: SettingsSearchEntry) => {
      onSectionChange(entry.section);
      const anchor = entryAnchor(entry);
      // Wait for the chosen section to commit, then scroll + flash. Two frames:
      // one for React to render the new section, one for layout to settle.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => scrollToSetting(mainRef.current, anchor)),
      );
    },
    [onSectionChange],
  );

  // Esc closes the Settings tab, but only while it is the active tab and the
  // user isn't typing in a field (mirrors the old settings-window behavior).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      e.preventDefault();
      onRequestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onRequestClose]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground select-none">
      <header className="flex h-11 shrink-0 items-center border-b border-border/60 bg-card/60 px-3">
        <Tabs
          value={section}
          onValueChange={(v) => onSectionChange(v as SettingsSection)}
          orientation="horizontal"
          className="flex-1 items-center"
        >
          <TabsList className="mx-auto h-7 bg-muted/40 px-2">
            {SECTIONS.map((t) => (
              <TabsTrigger
                key={t.id}
                value={t.id}
                className="h-6 gap-1.5 px-2.5 text-[11.5px]"
              >
                <HugeiconsIcon icon={t.icon} size={12} strokeWidth={1.75} />
                <span>{t.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </header>

      <main
        ref={mainRef}
        className="min-h-0 flex-1 overflow-y-auto px-8 pt-3 pb-7 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div className="mx-auto w-full max-w-160">
          <div className="sticky top-0 z-20 -mx-2 -mt-3 mb-8 bg-background/95 px-2 pt-3 pb-3 backdrop-blur-sm">
            <SettingsSearch onSelect={onSearchSelect} />
          </div>
          {ActiveSection && <ActiveSection />}
        </div>
      </main>
    </div>
  );
}

/**
 * Scroll the matching setting row into the scroll container and flash it.
 * `anchor === null` (group-level results) just scrolls back to the top.
 */
function scrollToSetting(main: HTMLElement | null, anchor: string | null): void {
  if (!main) return;
  if (!anchor) {
    main.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  const selector = `[data-setting-anchor="${anchor.replace(/"/g, '\\"')}"]`;
  const el = main.querySelector<HTMLElement>(selector);
  if (!el) {
    main.scrollTo({ top: 0, behavior: "smooth" });
    return;
  }
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  // Restart the flash animation even if the row was flashed moments ago.
  el.classList.remove("termul-setting-flash");
  void el.offsetWidth;
  el.classList.add("termul-setting-flash");
}
