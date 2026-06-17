import { open } from "@tauri-apps/plugin-dialog";

/**
 * Native OS folder picker. Lets the user browse to any drive/folder (e.g.
 * `D:\code`, `E:\work`) instead of being stuck on the home-dir fallback.
 *
 * Returns the chosen absolute path, forward-slash normalized to match the
 * convention used everywhere else in the app, or `null` if the user cancelled.
 */
export async function pickDirectory(
  defaultPath?: string,
): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Open Folder",
    defaultPath: defaultPath || undefined,
  });
  // `directory: true, multiple: false` resolves to a single path or null.
  if (typeof selected !== "string") return null;
  return selected.replace(/\\/g, "/");
}
