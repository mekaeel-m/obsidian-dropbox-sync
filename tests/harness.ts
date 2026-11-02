/**
 * Integration harness: a real `requestUrl` over real HTTP, and a real
 * filesystem-backed DataAdapter.
 *
 * Together with tests/fake-dropbox-server.mjs this runs the production code
 * paths end to end — the only thing still simulated is Dropbox itself.
 */

import fs from "fs";
import path from "path";

// ------------------------------------------------------------- requestUrl

export interface ShimResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: unknown;
  text: string;
}

export interface ShimParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  throw?: boolean;
}

/**
 * Redirects production Dropbox hostnames at the HTTP layer to a local test
 * server. Rewriting here rather than adding an override inside `src/` means
 * production code carries no test seam and no mutable module state: the plugin
 * always points at the real Dropbox, and only the harness lies to it.
 */
let rewrite: ((url: string) => string) | null = null;

export function setUrlRewrite(fn: ((url: string) => string) | null): void {
  rewrite = fn;
}

/** Point every known Dropbox host at `origin` (e.g. "http://127.0.0.1:1234"). */
export function rewriteDropboxTo(origin: string): void {
  setUrlRewrite((url) =>
    url
      .replace("https://api.dropboxapi.com/2", `${origin}/2`)
      .replace("https://content.dropboxapi.com/2", `${origin}/2`)
      .replace("https://api.dropboxapi.com/oauth2", `${origin}/oauth2`),
  );
}

/**
 * Matches Obsidian's documented `requestUrl` contract: headers as a plain
 * record, eager `arrayBuffer`/`json`/`text`, and `throw` defaulting to true.
 *
 * Uses node's fetch, which — like Electron's net and the mobile webview —
 * refuses to send non-ASCII header values. That makes this shim a genuine test
 * of the `Dropbox-API-Arg` escaping rather than a rubber stamp.
 */
export async function httpRequestUrl(param: ShimParam): Promise<ShimResponse> {
  const target = rewrite ? rewrite(param.url) : param.url;
  const response = await fetch(target, {
    method: param.method ?? "GET",
    headers: param.headers,
    body: param.body as BodyInit | undefined,
  });

  const buffer = await response.arrayBuffer();
  const text = new TextDecoder().decode(buffer);

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }

  const shaped: ShimResponse = {
    status: response.status,
    headers,
    arrayBuffer: buffer,
    json,
    text,
  };

  if (param.throw !== false && response.status >= 400) {
    throw new Error(`Request failed, status ${response.status}`);
  }
  return shaped;
}

// ----------------------------------------------------------- fs adapter

export interface Stat {
  type: "file" | "folder";
  ctime: number;
  mtime: number;
  size: number;
}

/**
 * Implements the slice of Obsidian's DataAdapter the sync engine uses, over a
 * real directory. Real mtimes, real byte round-trips, real path separators.
 */
export class FsAdapter {
  constructor(readonly root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  private abs(vaultPath: string): string {
    return path.join(this.root, vaultPath);
  }

  async list(folder: string): Promise<{ files: string[]; folders: string[] }> {
    const dir = folder ? this.abs(folder) : this.root;
    const files: string[] = [];
    const folders: string[] = [];

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // Vault paths always use forward slashes, regardless of platform.
      const rel = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) folders.push(rel);
      else if (entry.isFile()) files.push(rel);
    }
    return { files, folders };
  }

  async stat(vaultPath: string): Promise<Stat | null> {
    try {
      const s = fs.statSync(this.abs(vaultPath));
      return {
        type: s.isDirectory() ? "folder" : "file",
        ctime: Math.floor(s.ctimeMs),
        mtime: Math.floor(s.mtimeMs),
        size: s.size,
      };
    } catch {
      return null;
    }
  }

  async exists(vaultPath: string): Promise<boolean> {
    return fs.existsSync(this.abs(vaultPath));
  }

  async mkdir(vaultPath: string): Promise<void> {
    fs.mkdirSync(this.abs(vaultPath), { recursive: true });
  }

  async readBinary(vaultPath: string): Promise<ArrayBuffer> {
    const buf = fs.readFileSync(this.abs(vaultPath));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }

  async writeBinary(vaultPath: string, data: ArrayBuffer): Promise<void> {
    const target = this.abs(vaultPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(data));
  }

  async trashLocal(vaultPath: string): Promise<void> {
    const target = this.abs(vaultPath);
    const trash = path.join(this.root, ".trash", vaultPath);
    fs.mkdirSync(path.dirname(trash), { recursive: true });
    fs.renameSync(target, trash);
  }

  async remove(vaultPath: string): Promise<void> {
    fs.rmSync(this.abs(vaultPath), { force: true });
  }

  // --- test conveniences

  write(vaultPath: string, text: string): void {
    const target = this.abs(vaultPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, "utf8");
  }

  writeBytes(vaultPath: string, bytes: Buffer): void {
    const target = this.abs(vaultPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }

  read(vaultPath: string): string | undefined {
    try {
      return fs.readFileSync(this.abs(vaultPath), "utf8");
    } catch {
      return undefined;
    }
  }

  readBytes(vaultPath: string): Buffer | undefined {
    try {
      return fs.readFileSync(this.abs(vaultPath));
    } catch {
      return undefined;
    }
  }

  unlink(vaultPath: string): void {
    fs.rmSync(this.abs(vaultPath), { force: true });
  }

  listAll(): string[] {
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else out.push(rel);
      }
    };
    walk(this.root, "");
    return out.sort();
  }
}
