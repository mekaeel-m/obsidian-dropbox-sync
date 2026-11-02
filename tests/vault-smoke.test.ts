/**
 * Smoke test against the real test vault.
 *
 * Unlike integration.test.ts, which builds its fixtures programmatically, this
 * one takes the actual on-disk test vault produced by make-test-vault.mjs —
 * real NTFS files, real emoji and CJK filenames, real binary attachments — and
 * syncs it between two devices, then verifies the second device ends up
 * byte-identical for everything that should sync and empty-handed for
 * everything that shouldn't.
 *
 * This is the closest thing to "does it work on a real vault" that can run
 * without a Dropbox account.
 */

import fs from "fs";
import os from "os";
import path from "path";

import { AuthManager } from "../src/auth";
import { DropboxClient } from "../src/dropbox";
import { PathFilter } from "../src/paths";
import { emptySnapshot } from "../src/state";
import { SyncEngine } from "../src/sync";
import { FsAdapter, rewriteDropboxTo } from "./harness";
import { startFakeDropbox } from "./fake-dropbox-server.mjs";

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

const EXCLUSIONS = ["*.tmp"];

/** Paths we expect never to leave the device, given the settings below. */
const MUST_NOT_SYNC = [
  ".obsidian/app.json",
  ".obsidian/community-plugins.json",
  "Attachments/.DS_Store",
  "scratch.tmp",
];

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

async function main(): Promise<void> {
  const vaultSource =
    process.argv[2] ??
    path.join(os.homedir(), "Documents", "Obsidian", "dropbox-sync-testvault");

  if (!fs.existsSync(path.join(vaultSource, ".dropbox-sync-test-vault"))) {
    console.log(
      `skipped: no test vault at ${vaultSource}\n` +
        `  create one with: node tests/make-test-vault.mjs`,
    );
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbxvault-"));
  const server = await startFakeDropbox();
  rewriteDropboxTo(`http://127.0.0.1:${server.port}`);

  // Device A is a copy of the real vault; device B starts empty.
  const dirA = path.join(tmp, "A");
  copyDir(vaultSource, dirA);
  // The plugin's own build output lives in the vault; it is not vault content.
  fs.rmSync(path.join(dirA, ".obsidian", "plugins"), { recursive: true, force: true });

  const adapterA = new FsAdapter(dirA);
  const adapterB = new FsAdapter(path.join(tmp, "B"));

  const makeClient = () => {
    const settings = {
      appKey: server.appKey,
      refreshToken: server.refreshToken,
      accessToken: "",
      accessTokenExpiresAt: 0,
    };
    const auth = new AuthManager(
      () => settings,
      async (u) => {
        settings.accessToken = u.accessToken;
        settings.accessTokenExpiresAt = u.accessTokenExpiresAt;
      },
    );
    return new DropboxClient(auth, () => {}, server.endpoints);
  };

  const snapA = emptySnapshot("A");
  const snapB = emptySnapshot("B");

  const sync = (adapter: FsAdapter, snapshot: typeof snapA, name: string) =>
    new SyncEngine({
      vault: { adapter } as unknown as never,
      client: makeClient(),
      snapshot,
      filter: new PathFilter({
        patterns: EXCLUSIONS,
        syncConfigFolder: false,
        maxFileSize: 0,
      }),
      remoteRoot: "testvault",
      deviceName: name,
      concurrency: 4,
      saveSnapshot: async () => {},
      log: () => {},
    }).run();

  // ---------------------------------------------------- push the whole vault
  const up = await sync(adapterA, snapA, "A");
  eq("initial push has no errors", up.errors, []);
  eq("initial push has no conflicts", up.conflicts.length, 0);
  check("initial push uploaded files", up.uploaded > 0, `${up.uploaded}`);
  console.log(`  pushed ${up.uploaded} files from the real vault`);

  // ------------------------------------------------------- pull onto device B
  const down = await sync(adapterB, snapB, "B");
  eq("initial pull has no errors", down.errors, []);
  eq("pulled exactly what was pushed", down.downloaded, up.uploaded);

  // ------------------------------------------- byte-for-byte equality check
  const filter = new PathFilter({
    patterns: EXCLUSIONS,
    syncConfigFolder: false,
    maxFileSize: 0,
  });
  const expected = adapterA.listAll().filter((p) => !filter.excludes(p));
  const actual = adapterB.listAll().filter((p) => !p.startsWith(".trash/"));

  eq("device B holds the same file list", actual.sort(), expected.sort());

  let identical = 0;
  for (const rel of expected) {
    const a = adapterA.readBytes(rel);
    const b = adapterB.readBytes(rel);
    if (a && b && a.equals(b)) identical++;
    else failures.push(`content differs for ${rel} (${a?.length} vs ${b?.length} bytes)`);
  }
  check(`all ${expected.length} synced files are byte-identical`, identical === expected.length,
    `${identical}/${expected.length}`);
  passed += identical;
  console.log(`  verified ${identical} files byte-identical on device B`);

  // --------------------------------------------- exclusions really excluded
  for (const rel of MUST_NOT_SYNC) {
    if (!fs.existsSync(path.join(dirA, rel))) continue;
    check(`not synced: ${rel}`, adapterB.readBytes(rel) === undefined);
    check(`not on remote: ${rel}`, server.text(`/testvault/${rel}`) === undefined);
  }

  // -------------------------------------- unicode and binary spot assertions
  check("emoji filename survived the round trip",
    adapterB.read("Notes/emoji 🎉 party.md") !== undefined);
  check("CJK filename survived the round trip",
    adapterB.read("Notes/日本語のノート.md") !== undefined);
  check("accented filename survived the round trip",
    adapterB.read("Notes/café notes.md") !== undefined);

  const pngA = adapterA.readBytes("Attachments/red-dot.png");
  const pngB = adapterB.readBytes("Attachments/red-dot.png");
  check("PNG attachment is intact", Boolean(pngA && pngB && pngA.equals(pngB)));
  check("PNG still has its magic bytes",
    Boolean(pngB && pngB[0] === 0x89 && pngB.subarray(1, 4).toString() === "PNG"));

  const bytesB = adapterB.readBytes("Attachments/all-bytes.bin");
  check("all-256-bytes file is intact",
    Boolean(bytesB && bytesB.length === 256 && bytesB[0] === 0 && bytesB[255] === 255));

  // ------------------------------------------------------------- idle checks
  for (const [adapter, snapshot, name] of [
    [adapterA, snapA, "A"],
    [adapterB, snapB, "B"],
  ] as const) {
    const idle = await sync(adapter, snapshot, name);
    eq(`${name}: settled vault transfers nothing`, idle.uploaded + idle.downloaded, 0);
    eq(`${name}: settled vault deletes nothing`, idle.deletedLocal + idle.deletedRemote, 0);
    eq(`${name}: settled vault errors nothing`, idle.errors, []);
  }
  console.log("  both devices settled: idle sync is a no-op");

  // --------------------------------------------- a real conflict on real text
  const target = "Notes/Conflict target.md";
  adapterA.write(target, "# Conflict target\n\nEdited on the desktop.\n");
  adapterB.write(target, "# Conflict target\n\nEdited on the phone.\n");

  await sync(adapterA, snapA, "A");
  const conflicted = await sync(adapterB, snapB, "B");
  eq("the real conflict is detected", conflicted.conflicts.length, 1);
  eq("B keeps its own edit", adapterB.read(target), "# Conflict target\n\nEdited on the phone.\n");
  eq(
    "A's edit is preserved alongside",
    adapterB.read(conflicted.conflicts[0]),
    "# Conflict target\n\nEdited on the desktop.\n",
  );
  check("the conflict copy is still a markdown file",
    conflicted.conflicts[0].endsWith(".md"), conflicted.conflicts[0]);
  console.log(`  conflict preserved both versions as: ${conflicted.conflicts[0]}`);

  // Converge.
  await sync(adapterA, snapA, "A");
  for (const [adapter, snapshot, name] of [
    [adapterA, snapA, "A"],
    [adapterB, snapB, "B"],
  ] as const) {
    const settle = await sync(adapter, snapshot, name);
    eq(`${name}: converged after conflict`, settle.uploaded + settle.downloaded, 0);
    eq(`${name}: no repeat conflicts`, settle.conflicts.length, 0);
  }
  console.log("  converged after the conflict");

  // --------------------------------------------------- deletion is reversible
  adapterA.unlink("Notes/same-size.md");
  await sync(adapterA, snapA, "A");
  const delB = await sync(adapterB, snapB, "B");
  eq("deletion reached device B", delB.deletedLocal, 1);
  check("and is recoverable from local trash",
    adapterB.readBytes(".trash/Notes/same-size.md") !== undefined);

  await server.close();

  console.log(`\nvault smoke: ${passed} assertions passed`);
  if (failures.length > 0) {
    console.log(`\n${failures.length} FAILURE(S):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("vault smoke: all green");
  fs.rmSync(tmp, { recursive: true, force: true });
}

void main();
