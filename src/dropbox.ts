/**
 * Minimal Dropbox client built on Obsidian's `requestUrl`.
 *
 * `requestUrl` rather than `fetch` for two reasons: it bypasses CORS (the
 * browser-facing Dropbox endpoints would otherwise reject the preflight from
 * Obsidian's origin), and it is the only HTTP primitive available on mobile,
 * where there is no Node and no Electron net stack.
 */

import { requestUrl, type RequestUrlResponse } from "obsidian";
import { AuthError, type AuthManager } from "./auth";
import { apiArg, errorMessage, sleep } from "./util";

export const DROPBOX_RPC_BASE = "https://api.dropboxapi.com/2";
export const DROPBOX_CONTENT_BASE = "https://content.dropboxapi.com/2";

/** Overridable so an integration test can point the client at a local server. */
export interface Endpoints {
  rpc: string;
  content: string;
}

/**
 * Dropbox's documented trick for content endpoints: they must not carry a JSON
 * content type, and this exact value is whitelisted. Sending
 * `application/json` instead produces a baffling 400.
 */
const CORS_HACK_CONTENT_TYPE = "text/plain; charset=dropbox-cors-hack";

const MAX_ATTEMPTS = 4;

/**
 * Header lookup that ignores case. `requestUrl` types headers as a plain
 * record, and the casing it hands back depends on the platform's HTTP stack
 * (Electron's net on desktop, Capacitor on mobile), so neither spelling can be
 * assumed. Dropbox sends `Dropbox-API-Result` and `Retry-After`, both of which
 * we would silently miss if we guessed wrong.
 */
function header(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

export interface RemoteFile {
  /** Display-cased absolute Dropbox path. */
  path: string;
  pathLower: string;
  rev: string;
  size: number;
  serverModified: string;
}

export interface RemoteFolder {
  path: string;
  pathLower: string;
}

export interface RemoteListing {
  files: RemoteFile[];
  folders: RemoteFolder[];
  cursor: string;
}

/** An error carrying Dropbox's machine-readable `error` payload. */
export class DropboxError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly summary: string,
    readonly tag: string,
  ) {
    super(message);
    this.name = "DropboxError";
  }

  /** True when the remote file changed under us during an `update`-mode upload. */
  get isUploadConflict(): boolean {
    return this.status === 409 && this.tag.includes("conflict");
  }

  /** True when the path simply isn't there. */
  get isNotFound(): boolean {
    return this.status === 409 && this.tag.includes("not_found");
  }
}

type RawEntry = {
  ".tag": "file" | "folder" | "deleted";
  name: string;
  path_display?: string;
  path_lower?: string;
  rev?: string;
  size?: number;
  server_modified?: string;
};

export class DropboxClient {
  private readonly endpoints: Endpoints;

  constructor(
    private readonly auth: AuthManager,
    private readonly log: (message: string) => void = () => {},
    endpoints?: Partial<Endpoints>,
  ) {
    this.endpoints = {
      rpc: endpoints?.rpc ?? DROPBOX_RPC_BASE,
      content: endpoints?.content ?? DROPBOX_CONTENT_BASE,
    };
  }

  /** Verify credentials and return the account's display name. */
  async currentAccountName(): Promise<string> {
    const account = await this.rpc<{ name?: { display_name?: string }; email?: string }>(
      "/users/get_current_account",
      null,
    );
    return account?.name?.display_name ?? account?.email ?? "unknown account";
  }

  /**
   * Full recursive listing of the sync root. `path` must be "" for the app
   * folder root — "/" is rejected.
   */
  async listFolder(root: string): Promise<RemoteListing> {
    const files: RemoteFile[] = [];
    const folders: RemoteFolder[] = [];

    let page = await this.rpc<{
      entries: RawEntry[];
      cursor: string;
      has_more: boolean;
    }>("/files/list_folder", {
      path: root,
      recursive: true,
      include_deleted: false,
      include_media_info: false,
      include_mounted_folders: true,
      limit: 2000,
    });

    for (;;) {
      for (const entry of page.entries) collect(entry, files, folders);
      if (!page.has_more) break;
      page = await this.rpc("/files/list_folder/continue", { cursor: page.cursor });
    }

    this.log(`remote listing: ${files.length} files, ${folders.length} folders`);
    return { files, folders, cursor: page.cursor };
  }

  /**
   * Incremental listing from a previously saved cursor. Returns null when the
   * cursor has been invalidated (Dropbox resets them after long gaps or when
   * the app folder is relocated), signalling the caller to fall back to a full
   * listing.
   *
   * Unlike `listFolder`, this one reports deletions, which is exactly why it is
   * worth the extra code path.
   */
  async listFolderContinue(
    cursor: string,
  ): Promise<{ listing: RemoteListing; deleted: string[] } | null> {
    const files: RemoteFile[] = [];
    const folders: RemoteFolder[] = [];
    const deleted: string[] = [];
    let current = cursor;

    for (;;) {
      let page: { entries: RawEntry[]; cursor: string; has_more: boolean };
      try {
        page = await this.rpc("/files/list_folder/continue", { cursor: current });
      } catch (err) {
        if (err instanceof DropboxError && err.tag.includes("reset")) {
          this.log("remote cursor was reset; falling back to a full listing");
          return null;
        }
        throw err;
      }

      for (const entry of page.entries) {
        if (entry[".tag"] === "deleted") {
          if (entry.path_lower) deleted.push(entry.path_lower);
          continue;
        }
        collect(entry, files, folders);
      }

      current = page.cursor;
      if (!page.has_more) break;
    }

    return { listing: { files, folders, cursor: current }, deleted };
  }

  async download(path: string): Promise<{ data: ArrayBuffer; meta: RemoteFile }> {
    const response = await this.request({
      url: `${this.endpoints.content}/files/download`,
      headers: {
        "Dropbox-API-Arg": apiArg({ path }),
        "Content-Type": CORS_HACK_CONTENT_TYPE,
      },
    });

    // Metadata for a download comes back in a header, not the body.
    const result = header(response.headers, "Dropbox-API-Result");
    if (!result) throw new Error(`Dropbox omitted result metadata for ${path}`);

    return {
      data: response.arrayBuffer,
      meta: toRemoteFile(JSON.parse(result) as RawEntry),
    };
  }

  /**
   * Upload with optimistic concurrency. Passing `expectedRev` makes Dropbox
   * reject the write if the remote moved since we listed it — turning a silent
   * overwrite into a conflict we can handle honestly. Omit it to force.
   */
  async upload(
    path: string,
    data: ArrayBuffer,
    expectedRev?: string,
  ): Promise<RemoteFile> {
    const mode = expectedRev
      ? { ".tag": "update", update: expectedRev }
      : { ".tag": "overwrite" };

    const response = await this.request({
      url: `${this.endpoints.content}/files/upload`,
      headers: {
        "Dropbox-API-Arg": apiArg({
          path,
          mode,
          autorename: false,
          mute: true,
          strict_conflict: Boolean(expectedRev),
        }),
        "Content-Type": "application/octet-stream",
      },
      body: data,
    });

    return toRemoteFile(response.json as RawEntry);
  }

  async deletePath(path: string): Promise<void> {
    try {
      await this.rpc("/files/delete_v2", { path });
    } catch (err) {
      // Already gone is a success for our purposes.
      if (err instanceof DropboxError && err.isNotFound) return;
      throw err;
    }
  }

  async createFolder(path: string): Promise<void> {
    try {
      await this.rpc("/files/create_folder_v2", { path, autorename: false });
    } catch (err) {
      if (err instanceof DropboxError && err.tag.includes("conflict")) return;
      throw err;
    }
  }

  private async rpc<T>(endpoint: string, body: unknown): Promise<T> {
    const response = await this.request({
      url: `${this.endpoints.rpc}${endpoint}`,
      headers: { "Content-Type": "application/json" },
      // `null` is the documented way to call parameterless RPC endpoints.
      body: JSON.stringify(body),
    });
    return response.json as T;
  }

  /**
   * Single place where auth, retries, and error decoding live.
   *
   * Retries cover the three transient failures Dropbox actually produces:
   * 429 rate limiting (which carries a `Retry-After` we must honour), 5xx, and
   * a 401 from an access token that expired mid-flight.
   */
  private async request(options: {
    url: string;
    headers: Record<string, string>;
    body?: string | ArrayBuffer;
  }): Promise<RequestUrlResponse> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const token = await this.auth.getAccessToken();

      let response: RequestUrlResponse;
      try {
        response = await requestUrl({
          url: options.url,
          method: "POST",
          headers: { ...options.headers, Authorization: `Bearer ${token}` },
          body: options.body,
          throw: false,
        });
      } catch (err) {
        // Network-level failure: no response at all.
        lastError = err;
        if (attempt === MAX_ATTEMPTS) break;
        await sleep(backoffMs(attempt));
        continue;
      }

      if (response.status < 400) return response;

      if (response.status === 401) {
        // Token died early. Drop it and let the next attempt re-mint.
        await this.auth.invalidate();
        lastError = new AuthError("Dropbox rejected the access token.");
        if (attempt === MAX_ATTEMPTS) break;
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(header(response.headers, "Retry-After") ?? 0);
        lastError = decodeError(response);
        if (attempt === MAX_ATTEMPTS) break;
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);
        this.log(`${response.status} from Dropbox; retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      // 4xx other than 401/429 are our fault and will not improve on retry.
      throw decodeError(response);
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Dropbox request failed: ${errorMessage(lastError)}`);
  }
}

function backoffMs(attempt: number): number {
  // 500ms, 1s, 2s — plus jitter so parallel workers don't resynchronise.
  return 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

function decodeError(response: RequestUrlResponse): DropboxError {
  let summary = response.text?.slice(0, 300) ?? "";
  let tag = "";

  try {
    const parsed = JSON.parse(response.text) as {
      error_summary?: string;
      error?: Record<string, unknown>;
    };
    summary = parsed.error_summary ?? summary;
    // error_summary looks like "path/conflict/file/..." — good enough to match on.
    tag = parsed.error_summary ?? JSON.stringify(parsed.error ?? {});
  } catch {
    /* non-JSON body; keep the raw text */
  }

  return new DropboxError(
    `Dropbox ${response.status}: ${summary || "unknown error"}`,
    response.status,
    summary,
    tag,
  );
}

function collect(entry: RawEntry, files: RemoteFile[], folders: RemoteFolder[]): void {
  if (entry[".tag"] === "file") {
    files.push(toRemoteFile(entry));
  } else if (entry[".tag"] === "folder" && entry.path_display && entry.path_lower) {
    folders.push({ path: entry.path_display, pathLower: entry.path_lower });
  }
}

function toRemoteFile(entry: RawEntry): RemoteFile {
  return {
    path: entry.path_display ?? "",
    pathLower: entry.path_lower ?? (entry.path_display ?? "").toLowerCase(),
    rev: entry.rev ?? "",
    size: entry.size ?? 0,
    serverModified: entry.server_modified ?? "",
  };
}
