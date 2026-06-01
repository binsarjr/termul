import { invoke } from "@tauri-apps/api/core";

export type SettingsTab =
  | "general"
  | "themes"
  | "shortcuts"
  | "models"
  | "agents"
  | "about";

export async function openSettingsWindow(tab?: SettingsTab): Promise<void> {
  await invoke("open_settings_window", { tab: tab ?? null });
}

export async function toggleSettingsWindow(tab?: SettingsTab): Promise<void> {
  await invoke("toggle_settings_window", { tab: tab ?? null });
}
