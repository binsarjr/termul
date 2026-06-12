import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { quoteShellArg } from "@/lib/shellQuote";

/** Shell-quote and space-join paths for insertion at a shell prompt. */
export function quotePathsForShell(paths: string[]): string {
  return paths
    .reduce<string[]>((acc, p) => {
      if (p.length > 0) acc.push(quoteShellArg(p));
      return acc;
    }, [])
    .join(" ");
}

function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

function extFromMime(mime: string): string {
  const sub = (mime.split("/")[1] ?? "").toLowerCase();
  if (sub === "jpeg") return "jpg";
  const clean = sub.replace(/[^a-z0-9]/g, "");
  return clean || "png";
}

// Encode in chunks: String.fromCharCode(...wholeArray) overflows the call stack
// for multi-MB images.
function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Upload local files to `~/.termul-uploads/` on `host` over its ControlMaster,
 * with a progress toast. Returns the remote absolute paths, or null when the
 * upload failed (the toast shows the error) or there was nothing to upload.
 */
export async function uploadDroppedPaths(
  host: string,
  paths: string[],
): Promise<string[] | null> {
  const files = paths.filter((p) => p.length > 0);
  if (files.length === 0) return null;
  const label =
    files.length === 1 ? lastSegment(files[0]) : `${files.length} files`;
  const toastId = toast.loading(`Uploading ${label} to ${host}…`);
  try {
    const remote: string[] = [];
    for (const localPath of files) {
      remote.push(await invoke<string>("ssh_upload_file", { host, localPath }));
    }
    toast.success(`Uploaded ${label} → ${host}`, { id: toastId });
    return remote;
  } catch (e) {
    toast.error(`Upload to ${host} failed: ${errText(e)}`, { id: toastId });
    return null;
  }
}

/**
 * Materialize a pasted image to a local temp file, then — when `host` is set —
 * upload it to that SSH host. Returns the path to insert at the prompt (the
 * remote path when uploaded, else the local temp path), or null on failure.
 * Manages its own progress toast.
 */
export async function pasteImage(opts: {
  host: string | null;
  blob: Blob;
  mime: string;
}): Promise<string | null> {
  const { host, blob, mime } = opts;
  const toastId = toast.loading(
    host ? `Uploading pasted image to ${host}…` : "Saving pasted image…",
  );
  try {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const localPath = await invoke<string>("materialize_paste_image", {
      dataB64: base64FromBytes(buf),
      ext: extFromMime(mime),
    });
    if (!host) {
      toast.success("Pasted image saved", { id: toastId });
      return localPath;
    }
    const remotePath = await invoke<string>("ssh_upload_file", {
      host,
      localPath,
    });
    toast.success(`Uploaded pasted image → ${host}`, { id: toastId });
    return remotePath;
  } catch (e) {
    toast.error(`Paste image failed: ${errText(e)}`, { id: toastId });
    return null;
  }
}
