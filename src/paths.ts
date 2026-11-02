/**
 * Path translation between the vault and Dropbox, plus the exclusion filter.
 *
 * Vault paths are relative with forward slashes and no leading slash:
 *   "Daily/2026-11-01.md"
 * Dropbox paths are absolute with a leading slash, and "" means the root of the
 * app folder (NOT "/" — passing "/" to list_folder is an API error):
 *   "/Daily/2026-11-01.md"
 *
 * Dropbox is case-insensitive but case-preserving. Obsidian's filesystem may be
 * either depending on platform. We therefore key every lookup table by the
 * lowercased path (matching Dropbox's own `path_lower`) while storing the
 * display-cased path for actual I/O.
 *
 * Every vault path also passes through Obsidian's `normalizePath`, which does
 * Unicode NFC normalization. That matters more than it sounds: macOS and iOS
 * store filenames decomposed (NFD), while Dropbox hands back composed (NFC).
 * Without normalizing, a note called "café.md" written on an iPhone and
 * "café.md" coming back from Dropbox are two distinct keys, and the engine
 * syncs them against each other forever.
 */

import { normalizePath } from "obsidian";

/** Strip leading/trailing slashes and collapse duplicates. */
export function normalizeFolder(folder: string): string {
  return folder
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .join("/");
}

/** Vault-relative path -> absolute Dropbox path. */
export function toRemotePath(vaultPath: string, remoteRoot: string): string {
  const root = normalizeFolder(remoteRoot);
  const rel = vaultPath.replace(/^\/+/, "");
  return root ? `/${root}/${rel}` : `/${rel}`;
}

/**
 * Absolute Dropbox path -> vault-relative path, or null when the entry sits
 * outside the configured root (which should not happen, but a stale cursor or a
 * hand-edited setting can produce it).
 */
export function toVaultPath(remotePath: string, remoteRoot: string): string | null {
  const root = normalizeFolder(remoteRoot);
  const withoutSlash = remotePath.replace(/^\/+/, "");
  if (!root) return vaultKey(withoutSlash);

  const prefix = `${root.toLowerCase()}/`;
  if (withoutSlash.toLowerCase().startsWith(prefix)) {
    return vaultKey(withoutSlash.slice(prefix.length));
  }
  return null;
}

/**
 * Canonical form for a vault path: NFC-normalized, forward slashes, no leading
 * or trailing slash. Empty input yields null so callers can skip it.
 */
export function vaultKey(path: string): string | null {
  const normalized = normalizePath(path);
  return normalized && normalized !== "/" ? normalized : null;
}

/** The `path` argument for list_folder: "" for the app-folder root. */
export function listRootArg(remoteRoot: string): string {
  const root = normalizeFolder(remoteRoot);
  return root ? `/${root}` : "";
}

/** Everything in the vault that must never be synced, for any configuration. */
const ALWAYS_EXCLUDED = [
  // Per-device UI state. Syncing these makes your phone open your desktop's
  // pane layout and fight over it forever.
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
  // Obsidian's own local trash, and this plugin's state file.
  ".trash/",
  ".obsidian/plugins/dropbox-vault-sync/data.json",
  // OS and editor noise.
  ".DS_Store",
  "Thumbs.db",
  ".git/",
];

/** Dropbox refuses these outright; no point attempting the upload. */
const DROPBOX_ILLEGAL = /[\\:?*<>"|]/;

export interface FilterOptions {
  /** User-supplied glob-ish patterns. */
  patterns: string[];
  /** Whether to sync the `.obsidian` config folder at all. */
  syncConfigFolder: boolean;
  /** Skip files at or above this size, in bytes. 0 disables the check. */
  maxFileSize: number;
}

/**
 * Translate a simple glob into a regex, following gitignore's anchoring rule:
 *
 *   - A pattern containing no `/` matches the **basename at any depth**, so
 *     `.DS_Store` catches `Attachments/.DS_Store` and `*.tmp` catches
 *     `Notes/draft.tmp`. This is load-bearing rather than a nicety: `.DS_Store`
 *     and `Thumbs.db` exist in *every* directory, so a root-only match would
 *     miss nearly all of them.
 *   - A pattern containing `/` is anchored to the vault root, so
 *     `.obsidian/workspace.json` means that exact file and not a
 *     similarly-named one nested elsewhere.
 *
 * Supports `*` (within a segment), `**` (across segments), and a trailing `/`
 * meaning "this folder and everything inside it". Anything more exotic is out
 * of scope — users who need real globs can add several patterns.
 */
function globToRegExp(pattern: string): RegExp {
  const trimmed = pattern.trim().replace(/^\/+/, "");
  const isFolder = trimmed.endsWith("/");
  const body = isFolder ? trimmed.slice(0, -1) : trimmed;

  let out = "";
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "*") {
      if (body[i + 1] === "*") {
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }

  // Unanchored patterns may begin at any path-segment boundary.
  const prefix = body.includes("/") ? "" : "(?:.*/)?";
  // A folder pattern matches the folder itself and all descendants.
  const suffix = isFolder ? "(?:/.*)?" : "";
  return new RegExp(`^${prefix}${out}${suffix}$`, "i");
}

export class PathFilter {
  private readonly rules: RegExp[];

  constructor(private readonly options: FilterOptions) {
    const patterns = [...ALWAYS_EXCLUDED, ...options.patterns.filter((p) => p.trim())];
    if (!options.syncConfigFolder) patterns.push(".obsidian/");
    this.rules = patterns.map(globToRegExp);
  }

  /** True when the path should be excluded from sync. */
  excludes(vaultPath: string): boolean {
    if (DROPBOX_ILLEGAL.test(vaultPath)) return true;
    // Dropbox silently ignores these two names anywhere in a path.
    if (/(^|\/)(\.dropbox|desktop\.ini)$/i.test(vaultPath)) return true;
    return this.rules.some((rule) => rule.test(vaultPath));
  }

  /** True when a file is too large to sync under current settings. */
  exceedsSizeLimit(size: number): boolean {
    return this.options.maxFileSize > 0 && size > this.options.maxFileSize;
  }
}

/**
 * Build the path for a conflict copy, keeping the original extension so
 * Obsidian still treats a conflicted note as a note:
 *   "Daily/2026-11-01.md" -> "Daily/2026-11-01 (conflict 2026-11-01 14-32-07 from phone).md"
 */
export function conflictPath(vaultPath: string, stamp: string, device: string): string {
  const slash = vaultPath.lastIndexOf("/");
  const dir = slash === -1 ? "" : vaultPath.slice(0, slash + 1);
  const name = slash === -1 ? vaultPath : vaultPath.slice(slash + 1);

  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";

  const suffix = device ? `conflict ${stamp} from ${device}` : `conflict ${stamp}`;
  return `${dir}${stem} (${suffix})${ext}`;
}

/** All ancestor folders of a vault path, outermost first. */
export function parentFolders(vaultPath: string): string[] {
  const parts = vaultPath.split("/");
  parts.pop();
  const out: string[] = [];
  let acc = "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    out.push(acc);
  }
  return out;
}
