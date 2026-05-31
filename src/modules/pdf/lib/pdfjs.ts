import * as pdfjsLib from "pdfjs-dist";
// `?url` resolves to a same-origin, fingerprinted asset in BOTH `vite dev`
// (http://localhost:1420/…) and the bundled Tauri build (tauri://localhost/…),
// so the worker satisfies the app's `worker-src 'self'` CSP without any blob.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjsLib };
export type PdfDocument = pdfjsLib.PDFDocumentProxy;

/** Parse `toolarge:<size>:<limit>` errors from the `fs_read_bytes` command. */
export function parseTooLarge(
  message: string,
): { size: number; limit: number } | null {
  const m = /^toolarge:(\d+):(\d+)$/.exec(message);
  if (!m) return null;
  return { size: Number(m[1]), limit: Number(m[2]) };
}
