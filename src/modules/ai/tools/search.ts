import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { checkReadable, checkReadableCanonical } from "../lib/security";
import { resolvePath, type ToolContext } from "./context";

function resolveRoot(
  rawRoot: string | undefined,
  ctx: ToolContext,
): { ok: true; path: string } | { ok: false; error: string } {
  if (rawRoot && rawRoot.trim().length > 0) {
    try {
      return { ok: true, path: resolvePath(rawRoot, ctx.getCwd()) };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  const ws = ctx.getWorkspaceRoot();
  if (ws) return { ok: true, path: ws };
  const cwd = ctx.getCwd();
  if (cwd) return { ok: true, path: cwd };
  return {
    ok: false,
    error: "no workspace root or active cwd; pass `root` explicitly.",
  };
}

const MAX_LINE_LEN = 160;

function clipLine(s: string): string {
  if (s.length <= MAX_LINE_LEN) return s;
  return `${s.slice(0, MAX_LINE_LEN)}…[+${s.length - MAX_LINE_LEN}]`;
}

// grep/glob auto-execute (no approval), so a matched secret file would stream
// its contents to the model unguarded. The root is checked, but the walker
// only skips dot-hidden / gitignored files — a tracked `*.tfstate` or
// `service-account.json` is not hidden. Drop any hit whose own path fails the
// read deny-list, and report how many were withheld.
function partitionSecrets<T extends { path: string }>(
  hits: T[],
): { visible: T[]; redacted: number } {
  const visible: T[] = [];
  let redacted = 0;
  for (const h of hits) {
    if (checkReadable(h.path).ok) visible.push(h);
    else redacted += 1;
  }
  return { visible, redacted };
}

export function buildSearchTools(ctx: ToolContext) {
  return {
    grep: tool({
      description:
        "Search file contents in the workspace using a regular expression. Honors .gitignore. Returns up to `max_results` (default 30, max 500) `{path, line, text}` hits, with a `truncated` flag when more existed. Long match lines are clipped to 160 chars. Use this for code navigation — do NOT brute-force read_file across the tree. Narrow with `glob` when you can; raise `max_results` only if the first batch truly isn't enough.",
      inputSchema: z.object({
        pattern: z
          .string()
          .describe(
            "Regex pattern (Rust ripgrep dialect). Anchor and escape literal characters as needed.",
          ),
        root: z
          .string()
          .optional()
          .describe(
            "Root to search under. Defaults to workspace root, then active cwd.",
          ),
        glob: z
          .array(z.string())
          .optional()
          .describe(
            "Optional include-globs over relative paths, e.g. ['**/*.ts', 'src/**/*.tsx'].",
          ),
        case_insensitive: z.boolean().optional(),
        max_results: z.number().int().min(1).max(500).optional(),
      }),
      execute: async ({
        pattern,
        root,
        glob,
        case_insensitive,
        max_results,
      }) => {
        const r = resolveRoot(root, ctx);
        if (!r.ok) return { error: r.error };
        const safety = await checkReadableCanonical(r.path, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, root: r.path };
        r.path = safety.canonical;
        const cap = Math.min(max_results ?? 30, 500);
        try {
          const res = await native.grep({
            pattern,
            root: r.path,
            glob,
            caseInsensitive: case_insensitive,
            maxResults: cap,
          });
          const { visible, redacted } = partitionSecrets(res.hits);
          return {
            root: r.path,
            hits: visible.map((h) => ({
              path: h.path,
              rel: h.rel,
              line: h.line,
              text: clipLine(h.text),
            })),
            truncated: res.truncated,
            files_scanned: res.files_scanned,
            ...(redacted > 0 ? { redacted_secret_files: redacted } : {}),
          };
        } catch (e) {
          return { error: String(e), root: r.path };
        }
      },
    }),

    glob: tool({
      description:
        "Find files by path pattern (gitignore-aware). Use over `list_directory` when you want all matches recursively. Patterns use globset syntax: `**/*.ts`, `src/**/test_*.py`. Returns up to `max_results` matches.",
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern over relative paths."),
        root: z.string().optional(),
        max_results: z.number().int().min(1).max(2000).optional(),
      }),
      execute: async ({ pattern, root, max_results }) => {
        const r = resolveRoot(root, ctx);
        if (!r.ok) return { error: r.error };
        const safety = await checkReadableCanonical(r.path, native.canonicalize);
        if (!safety.ok) return { error: safety.reason, root: r.path };
        r.path = safety.canonical;
        try {
          const res = await native.glob({
            pattern,
            root: r.path,
            maxResults: max_results,
          });
          const { visible, redacted } = partitionSecrets(res.hits);
          return {
            root: r.path,
            hits: visible,
            truncated: res.truncated,
            ...(redacted > 0 ? { redacted_secret_files: redacted } : {}),
          };
        } catch (e) {
          return { error: String(e), root: r.path };
        }
      },
    }),
  } as const;
}
