import changelogRaw from "../../../CHANGELOG.md?raw";

/**
 * Extract the markdown body of a `## [version]` section from CHANGELOG.md
 * (bundled at build time). Returns null when the version has no section or the
 * section is empty, so callers can decide whether there is anything to show.
 */
export function releaseNotesFor(version: string): string | null {
  const lines = changelogRaw.split(/\r?\n/);
  const heading = `## [${version}]`;
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) return null;

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) break;
    body.push(lines[i]);
  }
  const notes = body.join("\n").trim();
  return notes.length > 0 ? notes : null;
}
