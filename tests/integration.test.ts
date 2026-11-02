/**
 * End-to-end integration test.
 *
 * Two simulated devices, each with a real on-disk vault, syncing through a
 * local HTTP server that speaks the real Dropbox protocol. The production
 * AuthManager, DropboxClient and SyncEngine all run unmodified; only Dropbox
 * itself is simulated.
 *
 * This covers what the unit tests cannot: HTTP header encoding, the download
 * metadata header, Dropbox error payload decoding, retry and backoff, token
 * refresh, binary fidelity, and real filesystem mtime behaviour.
 */

import fs from "fs";
import os from "os";
import path from "path";

import { AuthManager, PkceFlow } from "../src/auth";
import { DropboxClient } from "../src/dropbox";
import { PathFilter } from "../src/paths";
import { emptySnapshot, type SyncSnapshot } from "../src/state";
import { SyncEngine, type SyncReport } from "../src/sync";
import { FsAdapter, rewriteDropboxTo } from "./harness";
import { startFakeDropbox } from "./fake-dropbox-server.mjs";

// ----------------------------------------------------------------- harness

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function eq<T>(name: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `expected ${e}, got ${a}`);
}

type Server = Awaited<ReturnType<typeof startFakeDropbox>>;

interface Device {
  name: string;
  adapter: FsAdapter;
  client: DropboxClient;
  snapshot: SyncSnapshot;
  settings: {
    appKey: string;
    refreshToken: string;
    accessToken: string;
    accessTokenExpiresAt: number;
  };
  sync: (remoteRoot?: string, exclusions?: string[]) => Promise<SyncReport>;
}

function makeDevice(server: Server, name: string, tmp: string): Device {
  const adapter = new FsAdapter(path.join(tmp, name));
  const settings = {
    appKey: server.appKey,
    refreshToken: server.refreshToken,
    accessToken: "",
    accessTokenExpiresAt: 0,
  };

  const auth = new AuthManager(
    () => settings,
    async (update) => {
      settings.accessToken = update.accessToken;
      settings.accessTokenExpiresAt = update.accessTokenExpiresAt;
    },
  );

  const client = new DropboxClient(auth, () => {}, server.endpoints);
  const snapshot = emptySnapshot(`device-${name}`);

  const device: Device = {
    name,
    adapter,
    client,
    snapshot,
    settings,
    async sync(remoteRoot = "", exclusions = []) {
      const engine = new SyncEngine({
        vault: { adapter } as unknown as never,
        client,
        snapshot,
        filter: new PathFilter({
          patterns: exclusions,
          syncConfigFolder: false,
          maxFileSize: 0,
        }),
        remoteRoot,
        deviceName: name,
        concurrency: 3,
        saveSnapshot: async () => {},
        log: () => {},
      });
      return engine.run();
    },
  };
  return device;
}

// ------------------------------------------------------------------- tests

async function testPkceExchange(server: Server): Promise<void> {
  const flow = await PkceFlow.begin(server.appKey);

  const url = flow.authorizeUrl();
  check("authorize URL requests offline access", url.includes("token_access_type=offline"));
  check("authorize URL uses S256", url.includes("code_challenge_method=S256"));
  check("authorize URL carries no redirect_uri", !url.includes("redirect_uri"));
  check("code verifier is RFC-length", flow.verifier.length >= 43, `${flow.verifier.length}`);
  check("challenge is base64url", /^[A-Za-z0-9_-]+$/.test(flow.challenge));

  const token = await flow.exchange("fake-auth-code");
  check("exchange yields an access token", Boolean(token.access_token));
  check("exchange yields a refresh token", Boolean(token.refresh_token));
  eq("token lifetime is reported", token.expires_in, 14400);

  // A bad code must surface as an auth failure, not a silent success.
  let rejected = false;
  try {
    await (await PkceFlow.begin(server.appKey)).exchange("");
  } catch {
    rejected = true;
  }
  check("an empty code is rejected", rejected);
}

async function testAccountAndTokenRefresh(device: Device, server: Server): Promise<void> {
  const before = server.tokenIssueCount;
  const name = await device.client.currentAccountName();
  eq("account name comes back", name, "Test Account");
  check("a refresh token was exchanged for access", server.tokenIssueCount > before);

  // Second call reuses the cached access token rather than re-minting.
  const after = server.tokenIssueCount;
  await device.client.currentAccountName();
  eq("cached token is reused", server.tokenIssueCount, after);
}

async function testBasicRoundTrip(a: Device, b: Device, server: Server): Promise<void> {
  a.adapter.write("Daily/2026-11-01.md", "# Monday\n\nFirst note.");
  const up = await a.sync();
  eq("A uploads the new note", up.uploaded, 1);
  eq("no errors on A", up.errors, []);
  eq("remote holds the content", server.text("/Daily/2026-11-01.md"), "# Monday\n\nFirst note.");

  const down = await b.sync();
  eq("B downloads it", down.downloaded, 1);
  eq("no errors on B", down.errors, []);
  eq("B has identical content", b.adapter.read("Daily/2026-11-01.md"), "# Monday\n\nFirst note.");
}

async function testIdleSyncIsNoOp(a: Device, b: Device): Promise<void> {
  // The single most important health signal: a settled vault must do nothing.
  for (const device of [a, b]) {
    const report = await device.sync();
    eq(`${device.name}: idle sync uploads nothing`, report.uploaded, 0);
    eq(`${device.name}: idle sync downloads nothing`, report.downloaded, 0);
    eq(`${device.name}: idle sync deletes nothing`, report.deletedLocal + report.deletedRemote, 0);
    eq(`${device.name}: idle sync conflicts nothing`, report.conflicts.length, 0);
    eq(`${device.name}: idle sync has no errors`, report.errors, []);
  }
}

async function testOneSidedEdit(a: Device, b: Device): Promise<void> {
  b.adapter.write("Daily/2026-11-01.md", "# Monday\n\nEdited on B, now longer.");
  const upB = await b.sync();
  eq("B uploads its edit", upB.uploaded, 1);
  eq("B raises no conflict", upB.conflicts.length, 0);

  const downA = await a.sync();
  eq("A downloads the edit", downA.downloaded, 1);
  eq("A raises no conflict", downA.conflicts.length, 0);
  eq(
    "A now matches B",
    a.adapter.read("Daily/2026-11-01.md"),
    "# Monday\n\nEdited on B, now longer.",
  );
}

async function testConcurrentEditKeepsBothAndConverges(
  a: Device,
  b: Device,
  server: Server,
): Promise<void> {
  a.adapter.write("Shared.md", "A's version of the note");
  await a.sync();
  await b.sync();

  // Both edit before either syncs.
  a.adapter.write("Shared.md", "A changed this line");
  b.adapter.write("Shared.md", "B changed it differently");

  const reportA = await a.sync();
  eq("A's push is clean (it won the race)", reportA.conflicts.length, 0);

  const reportB = await b.sync();
  eq("B detects the conflict", reportB.conflicts.length, 1);

  const copy = reportB.conflicts[0];
  check("conflict copy names the device", copy.includes("from B"), copy);
  eq("B keeps its own version canonically", b.adapter.read("Shared.md"), "B changed it differently");
  eq("B preserves A's version beside it", b.adapter.read(copy), "A changed this line");
  eq("remote canonical is B's", server.text("/Shared.md"), "B changed it differently");
  eq("remote has the conflict copy too", server.text(`/${copy}`), "A changed this line");

  // Convergence: both devices must settle, and A must learn about the copy.
  const a2 = await a.sync();
  eq("A picks up both files", a2.downloaded, 2);
  eq("A's version of the copy matches", a.adapter.read(copy), "A changed this line");

  for (const device of [a, b]) {
    const settle = await device.sync();
    eq(`${device.name}: converged, nothing to upload`, settle.uploaded, 0);
    eq(`${device.name}: converged, nothing to download`, settle.downloaded, 0);
    eq(`${device.name}: converged, no new conflicts`, settle.conflicts.length, 0);
  }
}

async function testDeletePropagates(a: Device, b: Device, server: Server): Promise<void> {
  a.adapter.write("Temp/scratch.md", "delete me");
  await a.sync();
  await b.sync();
  check("B received it before deletion", b.adapter.read("Temp/scratch.md") === "delete me");

  a.adapter.unlink("Temp/scratch.md");
  const delA = await a.sync();
  eq("A propagates the delete remotely", delA.deletedRemote, 1);
  eq("remote entry is gone", server.text("/Temp/scratch.md"), undefined);

  const delB = await b.sync();
  eq("B removes it locally", delB.deletedLocal, 1);
  eq("B's copy is gone", b.adapter.read("Temp/scratch.md"), undefined);
  check(
    "B's copy went to local trash, recoverable",
    b.adapter.read(".trash/Temp/scratch.md") === "delete me",
  );
}

async function testEditBeatsDelete(a: Device, b: Device, server: Server): Promise<void> {
  a.adapter.write("Contested.md", "original");
  await a.sync();
  await b.sync();

  // A deletes; B edits without having seen the delete.
  a.adapter.unlink("Contested.md");
  await a.sync();
  eq("remote is gone after A's delete", server.text("/Contested.md"), undefined);

  b.adapter.write("Contested.md", "B kept working on this");
  const reportB = await b.sync();
  eq("B's edit resurrects the file", reportB.uploaded, 1);
  eq("remote has B's edit", server.text("/Contested.md"), "B kept working on this");

  const reportA = await a.sync();
  eq("A gets the resurrected file back", reportA.downloaded, 1);
  eq("A's content matches", a.adapter.read("Contested.md"), "B kept working on this");
}

async function testUnicodeFilenames(a: Device, b: Device, server: Server): Promise<void> {
  // This is the real test of Dropbox-API-Arg escaping: node's fetch refuses
  // non-ASCII header bytes outright, so a broken escape throws here.
  const names = [
    "Notes/café.md",
    "Notes/日本語のノート.md",
    "Notes/emoji 🎉 party.md",
    "Notes/Ünïcödé mix.md",
  ];

  for (const name of names) a.adapter.write(name, `content of ${name}`);

  const up = await a.sync();
  eq("all unicode names upload", up.uploaded, names.length);
  eq("no errors uploading unicode", up.errors, []);

  const down = await b.sync();
  eq("no errors downloading unicode", down.errors, []);
  for (const name of names) {
    eq(`round trip: ${name}`, b.adapter.read(name), `content of ${name}`);
  }
  check("remote stored the CJK name", server.text("/Notes/日本語のノート.md") !== undefined);
}

async function testBinaryFidelity(a: Device, b: Device): Promise<void> {
  // A PNG header plus every byte value, to catch any text-mode corruption.
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
    Buffer.from([0x00, 0xff, 0x00, 0xff]),
  ]);
  a.adapter.writeBytes("Attachments/image.png", bytes);

  const up = await a.sync();
  eq("binary uploads without error", up.errors, []);

  const down = await b.sync();
  eq("binary downloads without error", down.errors, []);

  const received = b.adapter.readBytes("Attachments/image.png");
  check("binary file arrives byte-identical", Boolean(received) && received!.equals(bytes),
    `${received?.length} vs ${bytes.length} bytes`);
}

async function testLargerFile(a: Device, b: Device): Promise<void> {
  // 2 MB of pseudo-random bytes: enough to span multiple TCP writes.
  const size = 2 * 1024 * 1024;
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 2654435761) & 0xff;
  a.adapter.writeBytes("Attachments/big.bin", bytes);

  const up = await a.sync();
  eq("large file uploads cleanly", up.errors, []);
  const down = await b.sync();
  eq("large file downloads cleanly", down.errors, []);

  const received = b.adapter.readBytes("Attachments/big.bin");
  check("2 MB file is intact", Boolean(received) && received!.equals(bytes));
}

async function testNestedFolders(a: Device, b: Device): Promise<void> {
  a.adapter.write("a/b/c/d/deep.md", "deeply nested");
  await a.sync();
  const down = await b.sync();
  eq("nested download has no errors", down.errors, []);
  eq("parent folders were created on B", b.adapter.read("a/b/c/d/deep.md"), "deeply nested");
}

async function testRemoteSubfolderRoot(server: Server, tmp: string): Promise<void> {
  const c = makeDevice(server, "C", tmp);
  const d = makeDevice(server, "D", tmp);

  c.adapter.write("note.md", "scoped to a subfolder");
  const up = await c.sync("myvault");
  eq("upload into subfolder succeeds", up.uploaded, 1);
  eq("remote path is prefixed", server.text("/myvault/note.md"), "scoped to a subfolder");

  const down = await d.sync("myvault");
  eq("peer with same root downloads it", down.downloaded, 1);
  eq("content matches", d.adapter.read("note.md"), "scoped to a subfolder");

  // A device pointed at the root must not see subfolder content as its own.
  const e = makeDevice(server, "E", tmp);
  const rootView = await e.sync("");
  check(
    "root-scoped device does not adopt subfolder files as top-level notes",
    !e.adapter.listAll().includes("note.md"),
    e.adapter.listAll().join(", "),
  );
  eq("root-scoped device had no errors", rootView.errors, []);
}

async function testExclusions(server: Server, tmp: string): Promise<void> {
  const f = makeDevice(server, "F", tmp);
  f.adapter.write("keep.md", "synced");
  f.adapter.write("Attachments/skip.png", "not synced");
  f.adapter.write("secret.tmp", "not synced");
  f.adapter.write(".obsidian/app.json", "{}");

  const report = await f.sync("excl", ["Attachments/", "*.tmp"]);
  eq("only the unexcluded file uploads", report.uploaded, 1);
  eq("excluded folder stayed local", server.text("/excl/Attachments/skip.png"), undefined);
  eq("excluded suffix stayed local", server.text("/excl/secret.tmp"), undefined);
  eq("config folder stayed local", server.text("/excl/.obsidian/app.json"), undefined);
  eq("the kept file made it", server.text("/excl/keep.md"), "synced");
  check("excluded files are untouched on disk", f.adapter.read("secret.tmp") === "not synced");
}

async function testRateLimitRetry(server: Server, tmp: string): Promise<void> {
  const g = makeDevice(server, "G", tmp);
  g.adapter.write("retry.md", "survives a 429");

  server.faults.rateLimit = 2;
  const before = server.stats.retries;

  const report = await g.sync("retrytest");
  eq("sync succeeds despite rate limiting", report.errors, []);
  eq("the file still uploaded", report.uploaded, 1);
  check("the server actually served 429s", server.stats.retries > before,
    `${server.stats.retries} vs ${before}`);
  eq("content arrived", server.text("/retrytest/retry.md"), "survives a 429");
}

async function testServerErrorRetry(server: Server, tmp: string): Promise<void> {
  const h = makeDevice(server, "H", tmp);
  h.adapter.write("flaky.md", "survives a 500");

  server.faults.serverError = 2;
  const report = await h.sync("flakytest");
  eq("sync succeeds despite 5xx", report.errors, []);
  eq("content arrived", server.text("/flakytest/flaky.md"), "survives a 500");
}

async function testExpiredTokenRecovery(server: Server, tmp: string): Promise<void> {
  const i = makeDevice(server, "I", tmp);
  i.adapter.write("auth.md", "survives a 401");

  // Prime a valid token, then invalidate it server-side mid-sync.
  await i.client.currentAccountName();
  server.faults.unauthorized = 1;
  const issuedBefore = server.tokenIssueCount;

  const report = await i.sync("authtest");
  eq("sync recovers from a 401", report.errors, []);
  check("the client re-minted its token", server.tokenIssueCount > issuedBefore,
    `${server.tokenIssueCount} vs ${issuedBefore}`);
  eq("content arrived", server.text("/authtest/auth.md"), "survives a 401");
}

async function testLateConflictOnOptimisticUpload(server: Server, tmp: string): Promise<void> {
  // Exercises the 409-on-update path: the engine listed a rev, then the remote
  // moved before its upload landed. It must preserve both, not clobber.
  const j = makeDevice(server, "J", tmp);
  j.adapter.write("race.md", "initial");
  await j.sync("racetest");

  // Local edit means the next sync uploads with expectedRev...
  j.adapter.write("race.md", "local edit");
  // ...but the remote changes after the listing the engine will use.
  const originalListFolder = j.client.listFolder.bind(j.client);
  (j.client as unknown as { listFolder: typeof originalListFolder }).listFolder = async (
    root: string,
  ) => {
    const listing = await originalListFolder(root);
    // Mutate the remote *after* the listing is taken, so the stored rev is stale.
    server.put("/racetest/race.md", "sneaky remote change");
    return listing;
  };

  const report = await j.sync("racetest");
  (j.client as unknown as { listFolder: typeof originalListFolder }).listFolder =
    originalListFolder;

  eq("late conflict produces no error", report.errors, []);
  eq("late conflict is reported as a conflict", report.conflicts.length, 1);
  eq("local edit survives", j.adapter.read("race.md"), "local edit");
  eq(
    "the remote change that raced us is preserved",
    j.adapter.read(report.conflicts[0]),
    "sneaky remote change",
  );
}

async function testSameSizeEdit(server: Server, tmp: string): Promise<void> {
  // Probes the mtime+size heuristic: an edit that keeps the byte length the
  // same is only detectable via mtime.
  const k = makeDevice(server, "K", tmp);
  k.adapter.write("samesize.md", "AAAA");
  await k.sync("sizetest");

  // Ensure the clock has moved past the filesystem's mtime granularity.
  await new Promise((r) => setTimeout(r, 1100));
  k.adapter.write("samesize.md", "BBBB");

  const report = await k.sync("sizetest");
  eq("a same-length edit is still detected", report.uploaded, 1);
  eq("remote got the new bytes", server.text("/sizetest/samesize.md"), "BBBB");
}

async function testDropboxErrorDecoding(device: Device): Promise<void> {
  // Downloading something that isn't there must raise a typed, inspectable
  // error rather than a generic failure.
  let caught: unknown;
  try {
    await device.client.download("/definitely/not/here.md");
  } catch (err) {
    caught = err;
  }
  check("a missing download throws", caught !== undefined);
  const error = caught as { name?: string; status?: number; isNotFound?: boolean };
  eq("it is a DropboxError", error.name, "DropboxError");
  eq("status is 409 as Dropbox sends", error.status, 409);
  check("isNotFound decodes the error_summary", error.isNotFound === true);
}

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbxsync-"));
  const server = await startFakeDropbox();
  rewriteDropboxTo(`http://127.0.0.1:${server.port}`);

  const a = makeDevice(server, "A", tmp);
  const b = makeDevice(server, "B", tmp);

  const suites: Array<[string, () => Promise<void>]> = [
    ["PKCE exchange", () => testPkceExchange(server)],
    ["account + token refresh", () => testAccountAndTokenRefresh(a, server)],
    ["basic round trip", () => testBasicRoundTrip(a, b, server)],
    ["idle sync is a no-op", () => testIdleSyncIsNoOp(a, b)],
    ["one-sided edit", () => testOneSidedEdit(a, b)],
    ["concurrent edit converges", () => testConcurrentEditKeepsBothAndConverges(a, b, server)],
    ["delete propagates", () => testDeletePropagates(a, b, server)],
    ["edit beats delete", () => testEditBeatsDelete(a, b, server)],
    ["unicode filenames", () => testUnicodeFilenames(a, b, server)],
    ["binary fidelity", () => testBinaryFidelity(a, b)],
    ["2 MB file", () => testLargerFile(a, b)],
    ["nested folders", () => testNestedFolders(a, b)],
    ["idle after everything", () => testIdleSyncIsNoOp(a, b)],
    ["remote subfolder root", () => testRemoteSubfolderRoot(server, tmp)],
    ["exclusions", () => testExclusions(server, tmp)],
    ["429 retry", () => testRateLimitRetry(server, tmp)],
    ["5xx retry", () => testServerErrorRetry(server, tmp)],
    ["401 recovery", () => testExpiredTokenRecovery(server, tmp)],
    ["late upload conflict", () => testLateConflictOnOptimisticUpload(server, tmp)],
    ["same-size edit", () => testSameSizeEdit(server, tmp)],
    ["error decoding", () => testDropboxErrorDecoding(a)],
  ];

  for (const [name, suite] of suites) {
    try {
      await suite();
    } catch (err) {
      failures.push(`${name} threw: ${err instanceof Error ? err.stack : String(err)}`);
    }
  }

  await server.close();

  console.log(`\nintegration: ${passed} assertions passed`);
  console.log(
    `server saw ${server.stats.requests} requests ` +
      `(${server.stats.uploads} uploads, ${server.stats.downloads} downloads, ` +
      `${server.stats.listings} listings, ${server.stats.retries} injected faults)`,
  );

  if (failures.length > 0) {
    console.log(`\n${failures.length} FAILURE(S):`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log("integration: all green");
  fs.rmSync(tmp, { recursive: true, force: true });
}

void main();
