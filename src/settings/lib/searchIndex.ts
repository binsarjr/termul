import type { SettingsSection } from "@/modules/settings/openSettings";

export type SettingsSearchEntry = {
  /** Stable unique id. */
  id: string;
  /** Tab the setting lives in. */
  section: SettingsSection;
  /** Group/category shown as context in the suggestion (e.g. "Terminal"). */
  group: string;
  /** Display label — usually the exact SettingRow title. */
  label: string;
  /** Longer text, shown under the label and matched against. */
  description?: string;
  /** Extra synonyms to match on (not displayed). */
  keywords?: string[];
  /**
   * Exact `data-setting-anchor` value to scroll to after switching tabs.
   * Defaults to `label`. Set `null` for group-level entries that have no
   * single row — selecting them just opens the tab.
   */
  anchor?: string | null;
};

export const SECTION_LABELS: Record<SettingsSection, string> = {
  general: "General",
  themes: "Themes",
  shortcuts: "Shortcuts",
  models: "Models",
  agents: "Agents",
  history: "History",
  about: "About",
};

/**
 * Hand-maintained index of user-facing settings. Row-level entries use their
 * exact SettingRow title as `label` (which doubles as the scroll anchor);
 * group-level entries set `anchor: null` and just open the tab.
 */
export const SETTINGS_INDEX: SettingsSearchEntry[] = [
  // ── General ───────────────────────────────────────────────
  {
    id: "appearance",
    section: "general",
    group: "Appearance",
    label: "Appearance",
    description: "System, light, or dark mode.",
    keywords: ["dark mode", "light mode", "color scheme", "theme mode", "system"],
    anchor: null,
  },
  {
    id: "zoom",
    section: "general",
    group: "Zoom",
    label: "UI zoom level",
    description: "Scale the whole interface up or down.",
    keywords: ["zoom", "scale", "ui size", "magnify"],
    anchor: null,
  },
  {
    id: "vim-mode",
    section: "general",
    group: "Editor",
    label: "Vim mode",
    description: "Enable Vim keybindings in the code editor.",
    keywords: ["vim", "keybindings", "modal editing"],
  },
  {
    id: "auto-save",
    section: "general",
    group: "Editor",
    label: "Auto save",
    description: "Automatically save files after a delay.",
    keywords: ["autosave", "save files"],
  },
  {
    id: "auto-save-delay",
    section: "general",
    group: "Editor",
    label: "Auto save delay",
    description: "Delay before unsaved changes are saved.",
    keywords: ["autosave delay", "debounce"],
  },
  {
    id: "show-hidden",
    section: "general",
    group: "Explorer",
    label: "Show hidden files",
    description: "Include dot-prefixed files in the explorer and search.",
    keywords: ["dotfiles", "hidden files", ".env", ".gitignore", "dot files"],
  },
  {
    id: "webgl",
    section: "general",
    group: "Terminal",
    label: "Use WebGL renderer",
    description: "Hardware-accelerated terminal rendering.",
    keywords: ["webgl", "gpu", "renderer", "corruption", "blank tiles"],
    anchor: "use-webgl-renderer",
  },
  {
    id: "trim-hibernated",
    section: "general",
    group: "Terminal",
    label: "Trim output for hibernated tabs",
    description: "Cap buffered output for hidden tabs to save memory.",
    keywords: ["hibernate", "background tabs", "buffer", "memory"],
  },
  {
    id: "font-family",
    section: "general",
    group: "Terminal",
    label: "Font family",
    description: "Nerd Font name for terminal text and icons.",
    keywords: ["font", "nerd font", "typeface", "monospace"],
  },
  {
    id: "letter-spacing",
    section: "general",
    group: "Terminal",
    label: "Letter spacing",
    description: "Horizontal space between characters.",
    keywords: ["letter spacing", "tracking", "kerning"],
  },
  {
    id: "font-size",
    section: "general",
    group: "Terminal",
    label: "Font size",
    description: "Terminal text size.",
    keywords: ["font size", "text size", "bigger text", "smaller text"],
  },
  {
    id: "scrollback",
    section: "general",
    group: "Terminal",
    label: "Scrollback",
    description: "Lines of history kept per terminal.",
    keywords: ["scrollback", "history lines", "buffer"],
  },
  {
    id: "max-panes",
    section: "general",
    group: "Terminal",
    label: "Max panes per tab",
    description: "How many terminals a tab can split into.",
    keywords: ["panes", "splits", "split terminal"],
  },
  {
    id: "dim-inactive",
    section: "general",
    group: "Terminal",
    label: "Dim inactive panes",
    description: "Fade panes that are not focused.",
    keywords: ["dim", "inactive", "fade", "opacity panes"],
  },
  {
    id: "agent-notifications",
    section: "general",
    group: "Agents",
    label: "Coding agent notifications",
    description: "Alert when Claude Code or Codex needs input or finishes.",
    keywords: ["notifications", "claude code", "codex", "alerts", "desktop notification"],
  },
  {
    id: "autostart",
    section: "general",
    group: "Startup",
    label: "Launch at login",
    description: "Open Termul automatically when you sign in.",
    keywords: ["autostart", "login", "startup", "boot"],
  },
  {
    id: "restore-window",
    section: "general",
    group: "Startup",
    label: "Restore window position & size",
    description: "Reopen the window where you left it.",
    keywords: ["window position", "window size", "restore window"],
  },
  {
    id: "restore-session",
    section: "general",
    group: "Startup",
    label: "Restore tabs on launch",
    description: "Reopen previous tabs, panes, and scrollback.",
    keywords: ["restore tabs", "session", "reopen tabs"],
  },
  {
    id: "confirm-quit",
    section: "general",
    group: "Startup",
    label: "Confirm before closing",
    description: "Ask before the window closes.",
    keywords: ["confirm quit", "confirm close", "prevent close"],
  },

  // ── Themes ────────────────────────────────────────────────
  {
    id: "theme",
    section: "themes",
    group: "Theme",
    label: "Theme",
    description: "Pick, create, or import a color theme.",
    keywords: ["theme", "color scheme", "colors", "adeberry", "import theme", "create theme", "presets"],
    anchor: null,
  },
  {
    id: "background-image",
    section: "themes",
    group: "Background",
    label: "Background image",
    description: "Set a background image with opacity and blur.",
    keywords: ["background", "wallpaper", "image", "opacity", "blur"],
    anchor: null,
  },

  // ── Shortcuts ─────────────────────────────────────────────
  {
    id: "shortcuts",
    section: "shortcuts",
    group: "Shortcuts",
    label: "Keyboard shortcuts",
    description: "View, rebind, or reset keyboard shortcuts.",
    keywords: ["shortcuts", "keybindings", "hotkeys", "rebind", "keymap"],
    anchor: null,
  },

  // ── Models ────────────────────────────────────────────────
  {
    id: "providers",
    section: "models",
    group: "Providers",
    label: "AI providers & API keys",
    description: "Add provider API keys (OpenAI, Anthropic, …).",
    keywords: ["api key", "openai", "anthropic", "provider", "models", "ai", "token"],
    anchor: null,
  },
  {
    id: "default-model",
    section: "models",
    group: "Defaults",
    label: "Default model",
    description: "Choose the default AI model.",
    keywords: ["default model", "model"],
    anchor: null,
  },
  {
    id: "custom-endpoints",
    section: "models",
    group: "Providers",
    label: "Custom endpoints",
    description: "OpenAI-compatible custom base URLs.",
    keywords: ["custom endpoint", "base url", "openai compatible", "local model", "ollama"],
    anchor: null,
  },

  // ── Agents ────────────────────────────────────────────────
  {
    id: "custom-instructions",
    section: "agents",
    group: "Custom instructions",
    label: "Custom instructions",
    description: "System prompt applied to agents.",
    keywords: ["instructions", "system prompt", "persona"],
    anchor: null,
  },
  {
    id: "agents",
    section: "agents",
    group: "Agents",
    label: "Agents",
    description: "Create and manage custom agents.",
    keywords: ["agent", "custom agent", "assistant"],
    anchor: null,
  },
  {
    id: "snippets",
    section: "agents",
    group: "Snippets",
    label: "Snippets",
    description: "Reusable text snippets.",
    keywords: ["snippet", "snippets", "templates"],
    anchor: null,
  },

  // ── History ───────────────────────────────────────────────
  {
    id: "inline-autocomplete",
    section: "history",
    group: "History",
    label: "Inline autocomplete",
    description: "Ghost-text suggestions from shell history.",
    keywords: ["autocomplete", "suggestions", "ghost text", "history suggestions"],
  },
  {
    id: "command-history",
    section: "history",
    group: "History",
    label: "Command history",
    description: "Browse, filter, and delete shell history.",
    keywords: ["history", "shell history", "clear history", "commands"],
    anchor: null,
  },

  // ── About ─────────────────────────────────────────────────
  {
    id: "about",
    section: "about",
    group: "About",
    label: "About Termul",
    description: "Version, updates, and links.",
    keywords: ["version", "update", "about", "github", "license", "changelog"],
    anchor: null,
  },
];

/** Resolve the DOM anchor for an entry (label unless overridden). */
export function entryAnchor(entry: SettingsSearchEntry): string | null {
  return entry.anchor === undefined ? entry.label : entry.anchor;
}

type Scored = { entry: SettingsSearchEntry; score: number };

/** Rank settings against a query. Returns best matches first. */
export function searchSettings(query: string, limit = 8): SettingsSearchEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const scored: Scored[] = [];
  for (const entry of SETTINGS_INDEX) {
    const label = entry.label.toLowerCase();
    const group = entry.group.toLowerCase();
    const desc = entry.description?.toLowerCase() ?? "";
    const section = SECTION_LABELS[entry.section].toLowerCase();
    const keywords = entry.keywords ?? [];

    let score = 0;
    if (label === q) score = 1000;
    else if (label.startsWith(q)) score = 800;
    else if (label.includes(q)) score = 600;
    else if (keywords.some((k) => k.toLowerCase().startsWith(q))) score = 450;
    else if (keywords.some((k) => k.toLowerCase().includes(q))) score = 350;
    else if (group.includes(q)) score = 250;
    else if (desc.includes(q)) score = 200;
    else if (section.includes(q)) score = 150;

    if (score > 0) scored.push({ entry, score });
  }

  scored.sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label));
  return scored.slice(0, limit).map((s) => s.entry);
}
