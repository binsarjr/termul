/** True for paths the markdown preview can render (.md / .markdown / .mdx). */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}
