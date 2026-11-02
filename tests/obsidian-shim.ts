/** Stands in for the `obsidian` module when running the engine under node. */

export function requestUrl(): never {
  throw new Error("requestUrl should never be called in tests; inject a fake client");
}

/**
 * Mirrors Obsidian's own normalizePath: collapse separators, strip leading and
 * trailing slashes, and normalize to Unicode NFC.
 */
export function normalizePath(path: string): string {
  const cleaned = path.replace(/[\/]+/g, "/").replace(/^\/+|\/+$/g, "");
  return (cleaned === "" ? "/" : cleaned).normalize("NFC");
}

export type RequestUrlResponse = unknown;
export type DataAdapter = unknown;
export type Vault = unknown;
