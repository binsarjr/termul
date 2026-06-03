import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { isRemotePath } from "@/modules/workspace";

export async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Best-effort; ignore in environments without clipboard permission.
  }
}

export function relativePath(rootPath: string, path: string): string {
  if (path === rootPath) return ".";
  if (path.startsWith(`${rootPath}/`)) return path.slice(rootPath.length + 1);
  return path;
}

export async function revealInFinder(path: string): Promise<void> {
  // A remote (ssh://) path has no local Finder/Explorer entry to reveal.
  if (isRemotePath(path)) return;
  try {
    await revealItemInDir(path);
  } catch (e) {
    console.error("revealItemInDir failed:", e);
  }
}
