/**
 * `obsidian` module shim for the integration test: a real HTTP requestUrl.
 * Unlike the unit-test shim, this one actually performs network calls (to the
 * local fake Dropbox server), so production code paths run unmodified.
 */
export { httpRequestUrl as requestUrl } from "./harness";

export function normalizePath(path: string): string {
  const cleaned = path.replace(/[\/]+/g, "/").replace(/^\/+|\/+$/g, "");
  return (cleaned === "" ? "/" : cleaned).normalize("NFC");
}

export type RequestUrlResponse = unknown;
export type DataAdapter = unknown;
export type Vault = unknown;
