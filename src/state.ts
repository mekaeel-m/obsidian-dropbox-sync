/**
 * Persistent sync state: settings, OAuth tokens, and the snapshot that makes
 * real two-way sync possible.
 *
 * The snapshot is the whole trick. Comparing local against remote only tells
 * you they differ, not *who* changed. Comparing both against "what I last saw
 * agreed" tells you the direction — and tells you when both sides moved, which
 * is the only honest definition of a conflict.
 */

export interface FileRecord {
  /** Vault-relative, display-cased. */
  path: string;
  /** Local mtime observed immediately after the last successful sync of this file. */
  mtime: number;
  /** Local size at that moment. */
  size: number;
  /** Dropbox `rev` at that moment. Changes on every remote write. */
  rev: string;
}

export interface PluginSettings {
  /** Dropbox app key. Not a secret: PKCE apps have no client secret. */
  appKey: string;
  refreshToken: string;
  /** Cached short-lived token; re-minted from the refresh token as needed. */
  accessToken: string;
  accessTokenExpiresAt: number;
  /** Subfolder inside the Dropbox app folder. Empty = app-folder root. */
  remoteFolder: string;
  /** Human-readable name for this device, used in conflict filenames. */
  deviceName: string;
  autoSyncOnChange: boolean;
  /** Debounce before an edit triggers a sync, in seconds. */
  changeDebounceSeconds: number;
  /** Periodic sync interval in minutes. 0 disables it. */
  intervalMinutes: number;
  syncOnStartup: boolean;
  syncConfigFolder: boolean;
  exclusions: string[];
  /** Bytes; files larger than this are skipped. */
  maxFileSize: number;
  concurrency: number;
  verboseLogging: boolean;
}

export interface SyncSnapshot {
  version: number;
  /** Keyed by lowercased vault path. */
  records: Record<string, FileRecord>;
  lastSyncAt: number;
  /** Stable per-install id, so one device never mistakes itself for another. */
  deviceId: string;
}

export interface PersistedData {
  settings: PluginSettings;
  snapshot: SyncSnapshot;
}

export const SNAPSHOT_VERSION = 1;

/** 150 MB — Dropbox's single-request upload ceiling. */
export const SINGLE_SHOT_UPLOAD_LIMIT = 150 * 1024 * 1024;

export const DEFAULT_SETTINGS: PluginSettings = {
  appKey: "",
  refreshToken: "",
  accessToken: "",
  accessTokenExpiresAt: 0,
  remoteFolder: "",
  deviceName: "",
  autoSyncOnChange: true,
  changeDebounceSeconds: 10,
  intervalMinutes: 15,
  syncOnStartup: true,
  syncConfigFolder: false,
  exclusions: [],
  maxFileSize: SINGLE_SHOT_UPLOAD_LIMIT,
  concurrency: 4,
  verboseLogging: false,
};

export function emptySnapshot(deviceId: string): SyncSnapshot {
  return { version: SNAPSHOT_VERSION, records: {}, lastSyncAt: 0, deviceId };
}

/**
 * Merge whatever was on disk with defaults. Obsidian hands back `null` on first
 * run, and older builds may be missing fields.
 */
export function hydrate(raw: unknown, newDeviceId: string): PersistedData {
  const data = (raw ?? {}) as Partial<PersistedData>;

  const settings: PluginSettings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };
  // Guard against hand-edited nonsense that would wedge the engine.
  settings.concurrency = clamp(settings.concurrency, 1, 16);
  settings.changeDebounceSeconds = clamp(settings.changeDebounceSeconds, 2, 600);
  settings.intervalMinutes = clamp(settings.intervalMinutes, 0, 1440);
  if (!Array.isArray(settings.exclusions)) settings.exclusions = [];

  const stored = data.snapshot;
  const snapshot: SyncSnapshot =
    stored && stored.version === SNAPSHOT_VERSION && stored.records
      ? { ...emptySnapshot(stored.deviceId || newDeviceId), ...stored }
      : emptySnapshot(stored?.deviceId || newDeviceId);

  return { settings, snapshot };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
