/**
 * A local HTTP server that speaks the real Dropbox API wire protocol.
 *
 * This exists so the integration test exercises the parts a mocked client
 * cannot: actual HTTP headers, `Dropbox-API-Arg` encoding, the metadata header
 * on downloads, Dropbox's error payload shapes, retry/backoff, and the token
 * refresh round trip.
 *
 * It is deliberately strict where real Dropbox is strict:
 *   - rejects non-ASCII bytes in `Dropbox-API-Arg` (HTTP headers are ASCII-only)
 *   - rejects a JSON content type on content endpoints
 *   - rejects "/" as a list_folder path (must be "" for the root)
 *   - enforces `mode: update` optimistic concurrency with a 409
 *   - requires a valid bearer token
 */

import http from "http";

const ACCESS_TOKEN = "test-access-token";
const REFRESH_TOKEN = "test-refresh-token";
const APP_KEY = "testappkey";

export function startFakeDropbox() {
  /** path (display case) -> { data: Buffer, rev: string, modified: string } */
  const files = new Map();
  const folders = new Set();
  let revCounter = 1;
  let tokenIssueCount = 0;

  /** Test hooks: queue up failures to exercise retry paths. */
  const faults = {
    /** Number of upcoming requests to answer with 429. */
    rateLimit: 0,
    /** Number of upcoming requests to answer with 500. */
    serverError: 0,
    /** Number of upcoming requests to answer with 401. */
    unauthorized: 0,
    /** Set true to make the access token be considered expired. */
    expireToken: false,
  };

  const stats = { requests: 0, uploads: 0, downloads: 0, listings: 0, retries: 0 };

  // Real Dropbox revs look like "0165f42141ea6d0000000033ad58c61" — ~31 hex
  // chars. Nothing treats a rev as anything but an opaque string, but matching
  // the observed shape keeps the fake honest.
  const nextRev = () =>
    `0165f42141ea6d${(revCounter++).toString(16).padStart(17, "0")}`;

  /**
   * Serialize to JSON with every non-ASCII character escaped. Real Dropbox does
   * this for the `Dropbox-API-Result` response header, because HTTP headers are
   * ASCII-only in both directions. The client relies on JSON.parse unescaping
   * it, so getting this right here is what makes the unicode test meaningful.
   */
  const asciiJson = (value) =>
    JSON.stringify(value).replace(/[\u007F-\uFFFF]/g, (c) =>
      "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
    );

  function lower(p) {
    return p.toLowerCase();
  }

  function metaFor(path) {
    const entry = files.get(path);
    return {
      ".tag": "file",
      name: path.slice(path.lastIndexOf("/") + 1),
      path_lower: lower(path),
      path_display: path,
      id: `id:${lower(path)}`,
      rev: entry.rev,
      size: entry.data.length,
      server_modified: entry.modified,
      client_modified: entry.modified,
      is_downloadable: true,
    };
  }

  function dropboxError(res, status, summary) {
    const body = JSON.stringify({
      error_summary: summary,
      error: { ".tag": summary.split("/")[0] },
    });
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  }

  /** Real Dropbox cannot receive non-ASCII in a header; neither can we. */
  function parseApiArg(res, raw) {
    if (raw === undefined) {
      dropboxError(res, 400, "missing_dropbox_api_arg");
      return null;
    }
    for (let i = 0; i < raw.length; i++) {
      if (raw.charCodeAt(i) > 127) {
        dropboxError(res, 400, "bad_request/non_ascii_header");
        return null;
      }
    }
    try {
      return JSON.parse(raw);
    } catch {
      dropboxError(res, 400, "bad_request/invalid_json_in_arg");
      return null;
    }
  }

  function authorized(req, res) {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${ACCESS_TOKEN}` || faults.expireToken) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error_summary: "expired_access_token/" }));
      return false;
    }
    return true;
  }

  /** Returns true if a queued fault was served instead of the real handler. */
  function servedFault(req, res) {
    if (faults.unauthorized > 0) {
      faults.unauthorized--;
      stats.retries++;
      // A 401 mid-sync should make the client re-mint its token and retry.
      faults.expireToken = true;
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error_summary: "expired_access_token/" }));
      return true;
    }
    if (faults.rateLimit > 0) {
      faults.rateLimit--;
      stats.retries++;
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
      res.end(JSON.stringify({ error_summary: "too_many_requests/" }));
      return true;
    }
    if (faults.serverError > 0) {
      faults.serverError--;
      stats.retries++;
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("internal server error");
      return true;
    }
    return false;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    stats.requests++;
    const url = new URL(req.url, "http://localhost");
    const route = url.pathname;
    const body = await readBody(req);

    // ---------------------------------------------------------- oauth token
    if (route === "/oauth2/token") {
      const params = new URLSearchParams(body.toString("utf8"));
      const grant = params.get("grant_type");

      if (params.get("client_id") !== APP_KEY) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_client" }));
        return;
      }

      if (grant === "authorization_code") {
        // A real PKCE exchange verifies the challenge; we only check presence,
        // since the client is what we're testing, not Dropbox's crypto.
        if (!params.get("code") || !params.get("code_verifier")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        tokenIssueCount++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: ACCESS_TOKEN,
            token_type: "bearer",
            expires_in: 14400,
            refresh_token: REFRESH_TOKEN,
            account_id: "dbid:test",
            scope: "files.content.read files.content.write",
          }),
        );
        return;
      }

      if (grant === "refresh_token") {
        if (params.get("refresh_token") !== REFRESH_TOKEN) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        tokenIssueCount++;
        faults.expireToken = false;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: ACCESS_TOKEN,
            token_type: "bearer",
            expires_in: 14400,
          }),
        );
        return;
      }

      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unsupported_grant_type" }));
      return;
    }

    if (servedFault(req, res)) return;
    if (!authorized(req, res)) return;

    // ------------------------------------------------------------ rpc: account
    if (route === "/2/users/get_current_account") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          account_id: "dbid:test",
          name: { display_name: "Test Account", given_name: "Test" },
          email: "test@example.com",
        }),
      );
      return;
    }

    // --------------------------------------------------------- rpc: list_folder
    if (route === "/2/files/list_folder" || route === "/2/files/list_folder/continue") {
      stats.listings++;
      let arg;
      try {
        arg = JSON.parse(body.toString("utf8") || "null") ?? {};
      } catch {
        return dropboxError(res, 400, "bad_request/invalid_json");
      }

      if (route === "/2/files/list_folder") {
        // Real Dropbox rejects "/" here; only "" means the root.
        if (arg.path === "/") {
          return dropboxError(res, 400, "path/malformed_path/..");
        }
        const root = (arg.path ?? "").toLowerCase();
        const entries = [];
        for (const path of files.keys()) {
          if (root && !lower(path).startsWith(`${root}/`)) continue;
          entries.push(metaFor(path));
        }
        for (const path of folders) {
          if (root && !lower(path).startsWith(`${root}/`)) continue;
          entries.push({
            ".tag": "folder",
            name: path.slice(path.lastIndexOf("/") + 1),
            path_lower: lower(path),
            path_display: path,
            id: `id:${lower(path)}`,
          });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ entries, cursor: `cursor-${revCounter}`, has_more: false }));
        return;
      }

      // continue: nothing new in this fake, but answer in the real shape.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ entries: [], cursor: arg.cursor ?? "cursor", has_more: false }));
      return;
    }

    // ------------------------------------------------------------- rpc: delete
    if (route === "/2/files/delete_v2") {
      const arg = JSON.parse(body.toString("utf8") || "{}");
      const match = [...files.keys()].find((p) => lower(p) === lower(arg.path));
      if (!match) return dropboxError(res, 409, "path_lookup/not_found/..");
      const meta = metaFor(match);
      files.delete(match);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ metadata: meta }));
      return;
    }

    // ------------------------------------------------------ rpc: create_folder
    if (route === "/2/files/create_folder_v2") {
      const arg = JSON.parse(body.toString("utf8") || "{}");
      if ([...folders].some((p) => lower(p) === lower(arg.path))) {
        return dropboxError(res, 409, "path/conflict/folder/..");
      }
      folders.add(arg.path);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          metadata: {
            ".tag": "folder",
            name: arg.path.slice(arg.path.lastIndexOf("/") + 1),
            path_lower: lower(arg.path),
            path_display: arg.path,
          },
        }),
      );
      return;
    }

    // -------------------------------------------------------- content: download
    if (route === "/2/files/download") {
      stats.downloads++;
      const contentType = req.headers["content-type"] ?? "";
      if (contentType.includes("application/json")) {
        // Real Dropbox rejects a JSON content type on content endpoints.
        return dropboxError(res, 400, "bad_request/json_content_type_on_content_endpoint");
      }
      const arg = parseApiArg(res, req.headers["dropbox-api-arg"]);
      if (!arg) return;

      const match = [...files.keys()].find((p) => lower(p) === lower(arg.path));
      if (!match) return dropboxError(res, 409, "path/not_found/..");

      const entry = files.get(match);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        // Deliberately unusual casing: the client must not assume either form.
        "dropbox-api-result": asciiJson(metaFor(match)),
      });
      res.end(entry.data);
      return;
    }

    // ---------------------------------------------------------- content: upload
    if (route === "/2/files/upload") {
      stats.uploads++;
      const arg = parseApiArg(res, req.headers["dropbox-api-arg"]);
      if (!arg) return;

      const match = [...files.keys()].find((p) => lower(p) === lower(arg.path));
      const mode = arg.mode;
      const isUpdate = mode && typeof mode === "object" && mode[".tag"] === "update";

      if (isUpdate) {
        const existing = match ? files.get(match) : null;
        if (!existing || existing.rev !== mode.update) {
          // This is the shape the engine's late-conflict path keys off.
          return dropboxError(res, 409, "path/conflict/file/..");
        }
      }

      const path = match ?? arg.path;
      if (match && match !== arg.path) files.delete(match);
      files.set(path, {
        data: body,
        rev: nextRev(),
        modified: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      });

      // Register implicit parent folders, as Dropbox does.
      const parts = path.split("/").slice(1, -1);
      let acc = "";
      for (const part of parts) {
        acc += `/${part}`;
        folders.add(acc);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(metaFor(path)));
      return;
    }

    dropboxError(res, 404, "unknown_endpoint");
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        appKey: APP_KEY,
        refreshToken: REFRESH_TOKEN,
        endpoints: {
          rpc: `http://127.0.0.1:${port}/2`,
          content: `http://127.0.0.1:${port}/2`,
        },
        tokenUrl: `http://127.0.0.1:${port}/oauth2/token`,
        files,
        folders,
        faults,
        stats,
        get tokenIssueCount() {
          return tokenIssueCount;
        },
        /** Write directly, simulating another device having uploaded. */
        put(path, text) {
          files.set(path, {
            data: Buffer.from(text, "utf8"),
            rev: nextRev(),
            modified: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
          });
        },
        text(path) {
          const entry = files.get(path);
          return entry ? entry.data.toString("utf8") : undefined;
        },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
