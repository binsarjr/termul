import type { GitChangedFile } from "@/modules/ai/lib/native";

/**
 * Pure git-status presentation helpers shared by the source control panel and
 * the file explorer decorations. One place owns the porcelain-char to canonical
 * code mapping and the per-status colors so both surfaces stay in sync.
 */

export function normalizeStatusCode(status: string): string {
  const code = status.trim().toUpperCase();
  switch (code) {
    case "?":
      return "U";
    case "A":
      return "A";
    case "M":
      return "M";
    case "D":
      return "D";
    case "R":
    case "C":
      return "R";
    case "U":
      return "U";
    default:
      return code || "M";
  }
}

export function statusCodeForMode(
  mode: "+" | "-",
  file: GitChangedFile,
): string {
  if (mode === "-" && file.untracked) return "U";
  const primary = mode === "+" ? file.indexStatus : file.worktreeStatus;
  const fallback = mode === "+" ? file.worktreeStatus : file.indexStatus;
  return normalizeStatusCode(primary !== " " ? primary : fallback);
}

/** Single status code for a file in a flat (merged staged/unstaged) listing. */
export function fileStatusCode(file: GitChangedFile): string {
  return file.unstaged
    ? statusCodeForMode("-", file)
    : statusCodeForMode("+", file);
}

/** Background accent (solid swatch / dot) for a status code. */
export function statusAccentClass(code: string): string {
  switch (code) {
    case "A":
      return "bg-emerald-500/85";
    case "U":
      return "bg-teal-500/85";
    case "M":
      return "bg-amber-500/85";
    case "D":
      return "bg-rose-500/85";
    case "R":
      return "bg-sky-500/85";
    default:
      return "bg-muted-foreground/40";
  }
}

/** Foreground tint (filename / badge letter) for a status code. */
export function statusTextClass(code: string): string {
  switch (code) {
    case "A":
      return "text-emerald-500";
    case "U":
      return "text-teal-500";
    case "M":
      return "text-amber-500";
    case "D":
      return "text-rose-500";
    case "R":
      return "text-sky-500";
    default:
      return "text-muted-foreground";
  }
}

// Higher rank wins when a folder contains several different changes; it picks
// the most prominent child status for the folder's roll-up indicator.
const STATUS_RANK: Record<string, number> = { M: 5, D: 4, R: 3, A: 2, U: 1 };

export function moreProminentStatus(a: string, b: string): string {
  return (STATUS_RANK[a] ?? 0) >= (STATUS_RANK[b] ?? 0) ? a : b;
}
