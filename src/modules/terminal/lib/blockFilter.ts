export type FilterResult = {
  /** Lines that match the query (all lines when the query is empty). */
  lines: string[];
  /** Total number of lines in the block output. */
  total: number;
  /** True when `useRegex` is on and the query is not a valid RegExp. */
  invalid: boolean;
};

/**
 * Filter a block's output to the lines matching `query`, non-destructively (a
 * client-side grep — the terminal buffer is untouched). Plain queries match
 * case-insensitive substrings; with `useRegex` the query is an `i`-flag RegExp,
 * and an unparseable pattern yields no matches with `invalid: true` so the UI
 * can flag it.
 */
export function filterBlockOutput(
  output: string,
  query: string,
  useRegex: boolean,
): FilterResult {
  const all = output.length ? output.split("\n") : [];
  const trimmed = query.trim();
  if (!trimmed) return { lines: all, total: all.length, invalid: false };

  let test: (line: string) => boolean;
  if (useRegex) {
    try {
      const re = new RegExp(query, "i");
      test = (line) => re.test(line);
    } catch {
      return { lines: [], total: all.length, invalid: true };
    }
  } else {
    const needle = query.toLowerCase();
    test = (line) => line.toLowerCase().includes(needle);
  }

  return { lines: all.filter(test), total: all.length, invalid: false };
}
