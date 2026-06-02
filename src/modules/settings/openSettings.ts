export type SettingsSection =
  | "general"
  | "themes"
  | "shortcuts"
  | "models"
  | "agents"
  | "history"
  | "about";

type OpenSettingsHandler = (section?: SettingsSection) => void;

// Settings lives as a tab in the main window, but several call sites
// (status bar, agent switcher, shortcuts dialog) reach for it as a free
// function and have no access to the tab store. App owns `useTabs`, so it
// registers the real implementation here on mount; everyone else calls
// `openSettings()` and stays decoupled from the tab plumbing.
let handler: OpenSettingsHandler | null = null;

export function registerOpenSettings(fn: OpenSettingsHandler | null): void {
  handler = fn;
}

/** Open (or focus) the Settings tab, optionally jumping to a section.
 * No-ops until App has registered the handler. */
export function openSettings(section?: SettingsSection): void {
  handler?.(section);
}
