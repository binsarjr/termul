import type { SettingsSection } from "@/modules/settings/openSettings";
import { SettingsView } from "@/modules/settings/SettingsView";
import type { SettingsTab, Tab } from "@/modules/tabs/lib/useTabs";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSectionChange: (section: SettingsSection) => void;
  onRequestClose: () => void;
};

/** Renders the single Settings tab, mirroring the EditorStack/MarkdownStack
 * pattern. Stays mounted while the Settings tab exists; visibility is toggled
 * by the parent overlay wrapper in App. */
export function SettingsStack({
  tabs,
  activeId,
  onSectionChange,
  onRequestClose,
}: Props) {
  const tab = tabs.find((t): t is SettingsTab => t.kind === "settings");
  if (!tab) return null;
  return (
    <SettingsView
      section={tab.section}
      active={activeId === tab.id}
      onSectionChange={onSectionChange}
      onRequestClose={onRequestClose}
    />
  );
}
