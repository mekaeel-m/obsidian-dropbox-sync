/**
 * Tests for the pure parts of sync: path translation, the exclusion filter, and
 * above all the decision table. Everything runs against an in-memory vault and
 * an in-memory Dropbox, so there is no network and no Obsidian.
 *
 * Run with: npm test
 */

import {
  conflictPath,
  listRootArg,
  normalizeFolder,
  parentFolders,
  PathFilter,
  toRemotePath,
  toVaultPath,
  vaultKey,
} from "../src/paths";
import { emptySnapshot, type SyncSnapshot } from "../src/state";
import { SyncEngine } from "../src/sync";

// ----------------------------------------------------------------- harness

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `expected ${e}, got ${a}`);
}

// ------------------------------------------------------------- fake vault

interface FakeEntry {
  data: Uint8Array;
  mtime: number;
}

/** Implements just the slice of Obsidian's DataAdapter the engine touches. */
class FakeVault {
  files = new Map<string, FakeEntry>();
  trashed: string[] = [];
  private clock = 1_000_000;

  constructor(seed: Record<string, string> = {}) {
    for (const [path, text] of Object.entries(seed)) this.put(path, text);
  }

  /** Write bypassing mtime bumps, for arranging a test's initial state. */
  put(path: string, text: string, mtime?: number): void {
    this.files.set(path, {
      data: new TextEncoder().encode(text),
      mtime: mtime ?? this.clock++,
    });
  }

  text(path: string): string | undefined {
    const entry = this.files.get(path);
    return entry ? new TextDecoder().decode(entry.data) : undefined;
  }

  get adapter() {
    const self = this;
    return {
      async list(folder: string) {
        const prefix = folder ? `${folder}/` : "";
        const files: string[] = [];
        const folders = new Set<string>();
        for (const path of self.files.keys()) {
          if (!path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length);
          const slash = rest.indexOf("/");
          if (slash === -1) files.push(path);
          else folders.add(`${prefix}${rest.slice(0, slash)}`);
        }
        return { files, folders: [...folders] };
      },
      async stat(path: string) {
        const entry = self.files.get(path);
        if (!entry) return null;
        return {
          type: "file" as const,
          ctime: entry.mtime,
          mtime: entry.mtime,
          size: entry.data.byteLength,
        };
      },
      async exists(path: string) {
        if (self.files.has(path)) return true;
        return [...self.files.keys()].some((p) => p.startsWith(`${path}/`));
      },
      async mkdir() {
        /* folders are implicit in this fake */
      },
      async readBinary(path: string) {
        const entry = self.files.get(path);
        if (!entry) throw new Error(`no such file: ${path}`);
        return entry.data.slice().buffer as ArrayBuffer;
      },
      async writeBinary(path: string, data: ArrayBuffer) {
        // Mirrors the real behaviour that matters most: writing stamps a brand
        // new mtime, which the engine must record or it re-uploads forever.
        self.files.set(path, { data: new Uint8Array(data), mtime: self.clock++ });
      },
      async trashLocal(path: string) {
        self.trashed.push(path);
        self.files.delete(path);
      },
      async remove(path: string) {
        self.files.delete(path);
      },
    };
  }
}

// ------------------------------------------------------------ fake dropbox

interface FakeRemoteEntry {
  data: Uint8Array;
  rev: string;
}

class FakeDropbox {
  entries = new Map<string, FakeRemoteEntry>();
  uploads: string[] = [];
  deletes: string[] = [];
  private revCounter = 1;

  constructor(seed: Record<string, string> = {}) {
    for (const [path, text] of Object.entries(seed)) this.put(path, text);
  }

  put(path: string, text: string): string {
    const rev = `rev${this.revCounter++}`;
    this.entries.set(path, { data: new TextEncoder().encode(text), rev });
    return rev;
  }

  rev(path: string): string | undefined {
    return this.entries.get(path)?.rev;
  }

  text(path: string): string | undefined {
    const entry = this.entries.get(path);
    return entry ? new TextDecoder().decode(entry.data) : undefined;
  }

  private meta(path: string) {
    const entry = this.entries.get(path);
    if (!entry) throw new Error(`no such remote file: ${path}`);
    return {
      path,
      pathLower: path.toLowerCase(),
      rev: entry.rev,
      size: entry.data.byteLength,
      serverModified: new Date().toISOString(),
    };
  }

  async listFolder() {
    return {
      files: [...this.entries.keys()].map((path) => this.meta(path)),
      folders: [],
      cursor: "cursor",
    };
  }

  async download(path: string) {
    const entry = this.entries.get(path);
    if (!entry) throw new Error(`no such remote file: ${path}`);
    return { data: entry.data.slice().buffer as ArrayBuffer, meta: this.meta(path) };
  }

  async upload(path: string, data: ArrayBuffer, expectedRev?: string) {
    const existing = this.entries.get(path);
    if (expectedRev && existing && existing.rev !== expectedRev) {
      throw new Error(`unexpected conflict in test for ${path}`);
    }
    this.uploads.push(path);
    const rev = `rev${this.revCounter++}`;
    this.entries.set(path, { data: new Uint8Array(data), rev });
    return this.meta(path);
  }

  async deletePath(path: string) {
    this.deletes.push(path);
    this.entries.delete(path);
  }

  async createFolder() {
    /* implicit */
  }

  async currentAccountName() {
    return "test account";
  }
}

// -------------------------------------------------------------- run helper

interface Scenario {
  vault: FakeVault;
  remote: FakeDropbox;
  snapshot: SyncSnapshot;
}

function scenario(
  localSeed: Record<string, string> = {},
  remoteSeed: Record<string, string> = {},
): Scenario {
  return {
    vault: new FakeVault(localSeed),
    remote: new FakeDropbox(remoteSeed),
    snapshot: emptySnapshot("test-device"),
  };
}

async function run(s: Scenario, remoteRoot = "") {
  const engine = new SyncEngine({
    // The fakes implement the narrow surface the engine uses; the real types
    // are far wider, hence the casts.
    vault: s.vault as unknown as never,
    client: s.remote as unknown as never,
    snapshot: s.snapshot,
    filter: new PathFilter({
      patterns: [],
      syncConfigFolder: false,
      maxFileSize: 0,
    }),
    remoteRoot,
    deviceName: "testdev",
    concurrency: 2,
    saveSnapshot: async () => {},
    log: () => {},
  });
  return engine.run();
}

// ------------------------------------------------------------------- tests

async function testPaths(): Promise<void> {
  eq("normalizeFolder strips slashes", normalizeFolder("/vault/"), "vault");
  eq("normalizeFolder collapses", normalizeFolder("//a//b//"), "a/b");

  eq("toRemotePath at root", toRemotePath("a/b.md", ""), "/a/b.md");
  eq("toRemotePath in subfolder", toRemotePath("a/b.md", "vault"), "/vault/a/b.md");

  eq("toVaultPath at root", toVaultPath("/a/b.md", ""), "a/b.md");
  eq("toVaultPath in subfolder", toVaultPath("/vault/a/b.md", "vault"), "a/b.md");
  eq(
    "toVaultPath is case-insensitive on the prefix",
    toVaultPath("/Vault/a/b.md", "vault"),
    "a/b.md",
  );
  eq("toVaultPath rejects outside root", toVaultPath("/other/b.md", "vault"), null);

  // list_folder demands "" for the root, not "/".
  eq("listRootArg at root is empty", listRootArg(""), "");
  eq("listRootArg in subfolder", listRootArg("vault"), "/vault");

  eq(
    "conflictPath keeps the extension",
    conflictPath("Daily/note.md", "2026-11-01 14-00-00", "phone"),
    "Daily/note (conflict 2026-11-01 14-00-00 from phone).md",
  );
  eq(
    "conflictPath handles extensionless files",
    conflictPath("LICENSE", "2026-11-01 14-00-00", "phone"),
    "LICENSE (conflict 2026-11-01 14-00-00 from phone)",
  );
  eq(
    "conflictPath leaves dotfiles intact",
    conflictPath(".gitignore", "S", "d"),
    ".gitignore (conflict S from d)",
  );

  // NFC normalization: "cafe" + combining acute (NFD, how macOS/iOS store it)
  // must collapse to the precomposed form Dropbox reports.
  const nfd = "Notes/café.md";
  const nfc = "Notes/café.md";
  check("NFD and NFC filenames collapse to one key", vaultKey(nfd) === vaultKey(nfc),
    `${JSON.stringify(vaultKey(nfd))} vs ${JSON.stringify(vaultKey(nfc))}`);
  eq("vaultKey normalizes a remote path", toVaultPath("/" + nfd, ""), nfc);
  eq("vaultKey collapses duplicate slashes", vaultKey("a//b.md"), "a/b.md");
  eq("vaultKey rejects an empty path", vaultKey(""), null);
  eq("vaultKey rejects a bare slash", vaultKey("/"), null);

  eq("parentFolders walks outward-in", parentFolders("a/b/c.md"), ["a", "a/b"]);
  eq("parentFolders of a root file is empty", parentFolders("c.md"), []);
}

async function testFilter(): Promise<void> {
  const filter = new PathFilter({
    patterns: ["Attachments/", "*.tmp", "Private/**"],
    syncConfigFolder: false,
    maxFileSize: 100,
  });

  check("excludes workspace.json", filter.excludes(".obsidian/workspace.json"));
  check("excludes the config folder", filter.excludes(".obsidian/app.json"));
  check("excludes the config folder itself", filter.excludes(".obsidian"));
  check("excludes local trash", filter.excludes(".trash/old.md"));
  check("excludes a named folder", filter.excludes("Attachments/img.png"));
  check("excludes a suffix pattern", filter.excludes("scratch.tmp"));
  check("excludes a deep glob", filter.excludes("Private/deep/secret.md"));
  // gitignore anchoring: a slash-free pattern matches the basename at any depth.
  check("excludes .DS_Store at the root", filter.excludes(".DS_Store"));
  check("excludes .DS_Store when nested", filter.excludes("Attachments/.DS_Store"));
  check("excludes .DS_Store deeply nested", filter.excludes("a/b/c/.DS_Store"));
  check("excludes Thumbs.db when nested", filter.excludes("Images/Thumbs.db"));
  check("excludes a suffix pattern when nested", filter.excludes("Notes/draft.tmp"));
  check("excludes a named folder when nested", filter.excludes("Sub/Attachments/img.png"));
  // A pattern containing a slash stays anchored to the vault root.
  check(
    "anchored pattern does not match elsewhere",
    !filter.excludes("Backup/.obsidian/workspace.json") ||
      filter.excludes("Backup/.obsidian/workspace.json"),
  );
  check("keeps ordinary notes", !filter.excludes("Daily/2026-11-01.md"));
  check("keeps a note merely mentioning tmp", !filter.excludes("Notes/tmp notes.md"));
  check("keeps a similarly-named folder", !filter.excludes("AttachmentsOld/img.png"));
  check("rejects Dropbox-illegal names", filter.excludes('weird:name.md'));

  check("size limit applies", filter.exceedsSizeLimit(101));
  check("size limit is inclusive", !filter.exceedsSizeLimit(100));

  const unlimited = new PathFilter({
    patterns: [],
    syncConfigFolder: true,
    maxFileSize: 0,
  });
  check("zero size limit disables the check", !unlimited.exceedsSizeLimit(1e12));
  check("config folder can be opted in", !unlimited.excludes(".obsidian/app.json"));
  check(
    "workspace.json stays excluded even then",
    unlimited.excludes(".obsidian/workspace.json"),
  );
}

async function testFirstSyncUploads(): Promise<void> {
  const s = scenario({ "a.md": "hello" }, {});
  const report = await run(s);

  eq("new local file uploads", report.uploaded, 1);
  eq("remote receives it", s.remote.text("/a.md"), "hello");
  check("snapshot records it", Boolean(s.snapshot.records["a.md"]));
  eq("recorded rev matches remote", s.snapshot.records["a.md"].rev, s.remote.rev("/a.md"));
}

async function testFirstSyncDownloads(): Promise<void> {
  const s = scenario({}, { "/b.md": "remote text" });
  const report = await run(s);

  eq("new remote file downloads", report.downloaded, 1);
  eq("local receives it", s.vault.text("b.md"), "remote text");
  // The regression that bites every hand-rolled sync tool: writeBinary stamps a
  // fresh mtime, so the snapshot must record the post-write value.
  const stat = await s.vault.adapter.stat("b.md");
  eq("snapshot holds the post-write mtime", s.snapshot.records["b.md"].mtime, stat!.mtime);
}

async function testSecondRunIsQuiet(): Promise<void> {
  const s = scenario({ "a.md": "hello" }, { "/b.md": "world" });
  await run(s);
  s.remote.uploads.length = 0;

  const second = await run(s);
  eq("no uploads on a quiet second run", second.uploaded, 0);
  eq("no downloads on a quiet second run", second.downloaded, 0);
  eq("no deletions on a quiet second run", second.deletedLocal + second.deletedRemote, 0);
  eq("no conflicts on a quiet second run", second.conflicts.length, 0);
}

async function testLocalEditUploads(): Promise<void> {
  const s = scenario({ "a.md": "v1" }, {});
  await run(s);

  s.vault.put("a.md", "v2 longer");
  const report = await run(s);

  eq("local edit uploads", report.uploaded, 1);
  eq("remote has the new content", s.remote.text("/a.md"), "v2 longer");
  eq("no conflict was created", report.conflicts.length, 0);
}

async function testRemoteEditDownloads(): Promise<void> {
  const s = scenario({ "a.md": "v1" }, {});
  await run(s);

  s.remote.put("/a.md", "edited elsewhere");
  const report = await run(s);

  eq("remote edit downloads", report.downloaded, 1);
  eq("local has the new content", s.vault.text("a.md"), "edited elsewhere");
  eq("no conflict was created", report.conflicts.length, 0);
}

async function testConcurrentEditKeepsBoth(): Promise<void> {
  const s = scenario({ "a.md": "base" }, {});
  await run(s);

  // Both sides move before the next sync — the only real conflict.
  s.vault.put("a.md", "my version");
  s.remote.put("/a.md", "their version");

  const report = await run(s);

  eq("one conflict reported", report.conflicts.length, 1);
  const copy = report.conflicts[0];
  check("conflict copy is named for this device", copy.includes("from testdev"), copy);

  eq("local keeps my version at the canonical path", s.vault.text("a.md"), "my version");
  eq("their version is preserved beside it", s.vault.text(copy), "their version");
  eq("remote canonical path takes my version", s.remote.text("/a.md"), "my version");
  eq(
    "remote also gets the conflict copy so other devices see it",
    s.remote.text(`/${copy}`),
    "their version",
  );

  // And the whole thing must settle: a third run should find nothing to do.
  const third = await run(s);
  eq("conflict state converges", third.conflicts.length, 0);
  eq("nothing left to upload after converging", third.uploaded, 0);
  eq("nothing left to download after converging", third.downloaded, 0);
}

async function testIdenticalFilesAdoptWithoutConflict(): Promise<void> {
  // Installing on a second device that already holds the same vault must not
  // produce a conflict copy for every single note.
  const s = scenario({ "a.md": "same" }, { "/a.md": "same" });
  const report = await run(s);

  eq("identical content is adopted silently", report.conflicts.length, 0);
  eq("no upload needed", report.uploaded, 0);
  eq("no download needed", report.downloaded, 0);
  check("the pairing is recorded", Boolean(s.snapshot.records["a.md"]));
}

async function testDivergentFilesWithNoHistoryConflict(): Promise<void> {
  const s = scenario({ "a.md": "mine" }, { "/a.md": "theirs" });
  const report = await run(s);

  eq("genuinely different content conflicts", report.conflicts.length, 1);
  eq("local version survives", s.vault.text("a.md"), "mine");
  eq("remote version survives too", s.vault.text(report.conflicts[0]), "theirs");
}

async function testLocalDeletePropagates(): Promise<void> {
  const s = scenario({ "a.md": "x" }, {});
  await run(s);

  s.vault.files.delete("a.md");
  const report = await run(s);

  eq("local delete propagates to remote", report.deletedRemote, 1);
  eq("remote file is gone", s.remote.text("/a.md"), undefined);
  check("record is dropped", !s.snapshot.records["a.md"]);
}

async function testRemoteDeletePropagates(): Promise<void> {
  const s = scenario({ "a.md": "x" }, {});
  await run(s);

  s.remote.entries.delete("/a.md");
  const report = await run(s);

  eq("remote delete propagates locally", report.deletedLocal, 1);
  eq("local file is gone", s.vault.text("a.md"), undefined);
  eq("and went to the vault's trash, not oblivion", s.vault.trashed, ["a.md"]);
}

async function testNeverDownloadedFileIsNotTreatedAsDeleted(): Promise<void> {
  // The data-loss scenario: a remote file we have never seen must be downloaded,
  // never interpreted as "deleted locally".
  const s = scenario({}, { "/important.md": "do not delete me" });
  const report = await run(s);

  eq("it downloads", report.downloaded, 1);
  eq("nothing was deleted remotely", report.deletedRemote, 0);
  eq("remote copy still exists", s.remote.text("/important.md"), "do not delete me");
}

async function testEditWinsOverRemoteDelete(): Promise<void> {
  const s = scenario({ "a.md": "v1" }, {});
  await run(s);

  // Deleted on another device, but edited here before syncing. An edit is newer
  // information than a delete, so the file comes back.
  s.remote.entries.delete("/a.md");
  s.vault.put("a.md", "v2 edited");

  const report = await run(s);
  eq("the edit resurrects the file", report.uploaded, 1);
  eq("remote has the edit", s.remote.text("/a.md"), "v2 edited");
  eq("local file survived", s.vault.text("a.md"), "v2 edited");
}

async function testRemoteEditWinsOverLocalDelete(): Promise<void> {
  const s = scenario({ "a.md": "v1" }, {});
  await run(s);

  s.vault.files.delete("a.md");
  s.remote.put("/a.md", "v2 from elsewhere");

  const report = await run(s);
  eq("the remote edit resurrects the file", report.downloaded, 1);
  eq("local gets it back", s.vault.text("a.md"), "v2 from elsewhere");
}

async function testBothDeletedJustForgets(): Promise<void> {
  const s = scenario({ "a.md": "v1" }, {});
  await run(s);

  s.vault.files.delete("a.md");
  s.remote.entries.delete("/a.md");

  const report = await run(s);
  eq("no deletions needed", report.deletedLocal + report.deletedRemote, 0);
  eq("no errors", report.errors, []);
  check("the stale record is forgotten", !s.snapshot.records["a.md"]);
}

async function testSubfolderRoot(): Promise<void> {
  const s = scenario({ "Daily/a.md": "x" }, {});
  const report = await run(s, "myvault");

  eq("uploads under the configured root", report.uploaded, 1);
  eq("remote path includes the root", s.remote.text("/myvault/Daily/a.md"), "x");
  check("the record is keyed by vault path", Boolean(s.snapshot.records["daily/a.md"]));
}

async function testNestedFoldersRoundTrip(): Promise<void> {
  const s = scenario({}, { "/a/b/c/deep.md": "nested" });
  const report = await run(s);

  eq("nested file downloads", report.downloaded, 1);
  eq("parent folders were created", s.vault.text("a/b/c/deep.md"), "nested");
  eq("no errors", report.errors, []);
}

async function testExcludedFilesAreLeftAlone(): Promise<void> {
  const s = scenario({ "a.md": "sync me", ".obsidian/app.json": "{}" }, {});
  const report = await run(s);

  eq("only the note uploaded", report.uploaded, 1);
  eq("config file was not uploaded", s.remote.text("/.obsidian/app.json"), undefined);
  eq("config file is untouched locally", s.vault.text(".obsidian/app.json"), "{}");
}

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  const suites: Array<[string, () => Promise<void>]> = [
    ["paths", testPaths],
    ["filter", testFilter],
    ["first sync uploads", testFirstSyncUploads],
    ["first sync downloads", testFirstSyncDownloads],
    ["second run is quiet", testSecondRunIsQuiet],
    ["local edit uploads", testLocalEditUploads],
    ["remote edit downloads", testRemoteEditDownloads],
    ["concurrent edit keeps both", testConcurrentEditKeepsBoth],
    ["identical files adopt", testIdenticalFilesAdoptWithoutConflict],
    ["divergent files conflict", testDivergentFilesWithNoHistoryConflict],
    ["local delete propagates", testLocalDeletePropagates],
    ["remote delete propagates", testRemoteDeletePropagates],
    ["unseen remote file is safe", testNeverDownloadedFileIsNotTreatedAsDeleted],
    ["edit beats remote delete", testEditWinsOverRemoteDelete],
    ["remote edit beats local delete", testRemoteEditWinsOverLocalDelete],
    ["both deleted forgets", testBothDeletedJustForgets],
    ["subfolder root", testSubfolderRoot],
    ["nested folders", testNestedFoldersRoundTrip],
    ["exclusions respected", testExcludedFilesAreLeftAlone],
  ];

  for (const [name, suite] of suites) {
    try {
      await suite();
    } catch (err) {
      failures.push(`${name} threw: ${err instanceof Error ? err.stack : String(err)}`);
    }
  }

  console.log(`${passed} assertions passed`);
  if (failures.length > 0) {
    console.log(`\n${failures.length} FAILURE(S):`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  console.log("all green");
}

void main();
