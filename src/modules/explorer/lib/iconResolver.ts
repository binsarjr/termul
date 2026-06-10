import { useSyncExternalStore } from "react";
import { EXT_TO_LANGUAGE_ID } from "./constants";
import * as fileIconsMod from "./fileIcons";
import * as folderIconsMod from "./folderIcons";

const catFileNames = fileIconsMod.fileNames as Record<string, string>;
const catFileExtensions = fileIconsMod.fileExtensions as Record<string, string>;
const catLanguageIds = fileIconsMod.languageIds as Record<string, string>;
const catFolderNames = folderIconsMod.folderNames as Record<string, string>;

type IconifySet = {
  icons: Record<string, { body: string }>;
  aliases?: Record<string, { parent: string }>;
  width?: number;
  height?: number;
};

// The full Catppuccin set (~310 KB of JSON) is loaded lazily on first icon
// use so it stays out of the main chunk.
let cat: IconifySet | null = null;
let CAT_W = 16;
let CAT_H = 16;

const DEFAULT_FILE = "file";
const DEFAULT_FOLDER = "folder";
const DEFAULT_FOLDER_OPEN = "folder-open";

// Verbatim copies of the set's own default bodies, so lookups resolve to
// pixel-identical placeholders until the chunk lands.
const FALLBACK_BODIES: Record<string, string> = {
  [DEFAULT_FILE]:
    '<path fill="none" stroke="#cad3f5" stroke-linecap="round" stroke-linejoin="round" d="M13.5 6.5v6a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h4.01m-.01 0l5 5h-4a1 1 0 0 1-1-1z"/>',
  [DEFAULT_FOLDER]:
    '<path fill="none" stroke="#cad3f5" stroke-linecap="round" stroke-linejoin="round" d="M4.5 4.5H12c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1"/>',
  [DEFAULT_FOLDER_OPEN]:
    '<path fill="none" stroke="#cad3f5" stroke-linecap="round" stroke-linejoin="round" d="m1.87 8l.7-2.74a1 1 0 0 1 .96-.76h10.94a1 1 0 0 1 .97 1.24l-1.75 7a1 1 0 0 1-.97.76H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1"/>',
};

const dataUrlCache = new Map<string, string>();

let loadStarted = false;
const loadListeners = new Set<() => void>();

function ensureIconsLoaded(): void {
  if (loadStarted) return;
  loadStarted = true;
  import("@iconify-json/catppuccin/icons.json").then(
    (mod) => {
      cat = mod.default as unknown as IconifySet;
      CAT_W = cat.width ?? 16;
      CAT_H = cat.height ?? 16;
      for (const listener of loadListeners) listener();
    },
    () => {
      loadStarted = false;
    },
  );
}

function subscribeIconsLoaded(listener: () => void): () => void {
  loadListeners.add(listener);
  return () => loadListeners.delete(listener);
}

function getIconsLoaded(): boolean {
  return cat !== null;
}

// Components that render icon urls subscribe here so rows painted with the
// fallback icons re-render once the real set can resolve.
export function useIconsLoaded(): boolean {
  return useSyncExternalStore(subscribeIconsLoaded, getIconsLoaded);
}

// Catppuccin's manifest emits names like `folder_src`/`typescript-react`, but
// the iconify export normalizes everything to hyphenated slugs.
function toIconifySlug(name: string): string {
  return name.replace(/_/g, "-");
}

function catBody(iconName: string): string | null {
  const slug = toIconifySlug(iconName);
  if (!cat) return FALLBACK_BODIES[slug] ?? null;
  const direct = cat.icons[slug];
  if (direct) return direct.body;
  const alias = cat.aliases?.[slug];
  if (alias) {
    const parent = cat.icons[alias.parent];
    if (parent) return parent.body;
  }
  return null;
}

function buildDataUrl(iconName: string): string | null {
  ensureIconsLoaded();
  const cached = dataUrlCache.get(iconName);
  if (cached !== undefined) return cached || null;
  const body = catBody(iconName);
  if (!body) {
    if (cat) dataUrlCache.set(iconName, "");
    return null;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CAT_W} ${CAT_H}">${body}</svg>`;
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  dataUrlCache.set(iconName, url);
  return url;
}

function extOf(name: string): string {
  const lower = name.toLowerCase();
  const dot = lower.indexOf(".");
  if (dot === -1 || dot === lower.length - 1) return "";
  return lower.slice(dot + 1);
}

export function fileIconUrl(name: string): string {
  const lower = name.toLowerCase();

  const byName = catFileNames[lower];
  if (byName) {
    const url = buildDataUrl(byName);
    if (url) return url;
  }

  let ext = extOf(lower);
  while (ext) {
    const iconName = catFileExtensions[ext];
    if (iconName) {
      const url = buildDataUrl(iconName);
      if (url) return url;
    }
    const langId = EXT_TO_LANGUAGE_ID[ext];
    if (langId) {
      const iconByLang = catLanguageIds[langId];
      if (iconByLang) {
        const url = buildDataUrl(iconByLang);
        if (url) return url;
      }
    }
    const nextDot = ext.indexOf(".");
    if (nextDot === -1) break;
    ext = ext.slice(nextDot + 1);
  }

  return buildDataUrl(DEFAULT_FILE) ?? "";
}

export function folderIconUrl(name: string, expanded: boolean): string {
  const lower = name.toLowerCase();

  const mapped = catFolderNames[lower];
  if (mapped) {
    const slug = toIconifySlug(mapped);
    const target = expanded ? `${slug}-open` : slug;
    const url = buildDataUrl(target);
    if (url) return url;
  }

  return buildDataUrl(expanded ? DEFAULT_FOLDER_OPEN : DEFAULT_FOLDER) ?? "";
}
