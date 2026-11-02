/**
 * Live conformance check against real Dropbox.
 *
 * This is the one thing the automated suites cannot do: confirm that real
 * Dropbox agrees with every assumption the client makes. It drives the actual
 * production `PkceFlow`, `AuthManager` and `DropboxClient` — no mocks, no local
 * server — against a scratch folder inside your own app folder.
 *
 * Two phases, because OAuth needs a human at the consent screen:
 *
 *   npm run live:url -- <app-key>          # prints a URL to visit
 *   npm run live:verify -- <code>          # completes auth, runs the checks
 *
 * The PKCE verifier is held in a local scratch file between the two, and the
 * refresh token is never written to disk.
 *
 * Everything it creates lives under /__livecheck__/ and is deleted afterwards.
 */

import fs from "fs";
import os from "os";
import path from "path";

import { AuthManager, PkceFlow, type TokenResponse } from "../src/auth";
import { DropboxClient, DropboxError } from "../src/dropbox";
import { apiArg } from "../src/util";

const STATE_FILE = path.join(os.tmpdir(), "dropbox-sync-livecheck.json");
const SCRATCH = "/__livecheck__";

let passed = 0;
const failures: string[] = [];
const notes: string[] = [];

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? `  (${detail})` : ""}`);
  }
}

function note(text: string): void {
  notes.push(text);
  console.log(`  note  ${text}`);
}

// ----------------------------------------------------------------- phase one

async function printUrl(appKey: string): Promise<void> {
  if (!/^[a-z0-9]{10,}$/i.test(appKey)) {
    console.error(`"${appKey}" does not look like a Dropbox app key.`);
    process.exit(1);
  }

  const flow = await PkceFlow.begin(appKey);
  const url = flow.authorizeUrl();

  // Persist only the verifier and key; nothing sensitive long-lived.
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ appKey, verifier: flow.verifier, created: Date.now() }, null, 2),
  );

  // Ask Dropbox whether it accepts this client_id and these scopes *before*
  // sending a human to the page. A bad key or a misspelled scope shows up here
  // as a 400 rather than as a confusing error on the consent screen.
  console.log("\nChecking the app key and scopes against Dropbox...");
  const probe = await fetch(url, { redirect: "manual" });
  const body = probe.status < 400 ? await probe.text() : await probe.text();

  if (probe.status >= 400 || /invalid_request|invalid_client|error/i.test(body.slice(0, 600))) {
    console.log(`  FAIL  Dropbox rejected the authorize request (HTTP ${probe.status})`);
    console.log(`\n${body.slice(0, 800)}\n`);
    console.log("Likely causes: wrong app key, or the scopes on the app's");
    console.log("Permissions tab do not include the ones this plugin requests.");
    process.exit(1);
  }
  console.log(`  ok    Dropbox accepted the app key and scopes (HTTP ${probe.status})`);

  console.log("\n" + "=".repeat(72));
  console.log("Open this URL, approve access, and copy the code Dropbox shows:\n");
  console.log(url);
  console.log("\nThen run:\n");
  console.log("  npm run live:verify -- <the-code>");
  console.log("=".repeat(72) + "\n");
}

// ----------------------------------------------------------------- phase two

async function verify(code: string): Promise<void> {
  if (!fs.existsSync(STATE_FILE)) {
    console.error("No pending flow. Run `npm run live:url -- <app-key>` first.");
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as {
    appKey: string;
    verifier: string;
  };

  // Rebuild the flow with the stored verifier so the PKCE proof matches.
  const flow = Object.assign(Object.create(PkceFlow.prototype) as PkceFlow, {
    verifier: state.verifier,
    challenge: "",
    appKey: state.appKey,
  });

  console.log("\nExchanging the authorization code...");
  let token: TokenResponse;
  try {
    token = await flow.exchange(code);
  } catch (err) {
    console.log(`  FAIL  ${err instanceof Error ? err.message : String(err)}`);
    console.log("\nCodes are single-use and short-lived. Re-run live:url for a fresh one.");
    process.exit(1);
  }

  check("code exchange returns an access token", Boolean(token.access_token));
  check(
    "code exchange returns a refresh token (offline access works)",
    Boolean(token.refresh_token),
    "without this, sync dies after four hours",
  );
  note(`access token lifetime: ${token.expires_in}s (${(token.expires_in / 3600).toFixed(1)}h)`);

  // --- Wire up the real client, exactly as the plugin does.
  const settings = {
    appKey: state.appKey,
    refreshToken: token.refresh_token ?? "",
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
  const client = new DropboxClient(auth, (m) => void m);

  console.log("\nRefresh-token flow:");
  // Deliberately start with no access token, forcing a refresh.
  const name = await client.currentAccountName();
  check("refresh token mints a working access token", Boolean(settings.accessToken));
  check("account info decodes", typeof name === "string" && name.length > 0, name);
  note(`authenticated as: ${name}`);

  console.log("\nUpload and metadata:");
  const text = `live check ${new Date().toISOString()}\n`;
  const encoded = new TextEncoder().encode(text);
  const meta = await client.upload(
    `${SCRATCH}/plain.md`,
    encoded.buffer.slice(0, encoded.byteLength) as ArrayBuffer,
  );
  check("upload returns a rev", Boolean(meta.rev), meta.rev);
  check("upload returns the display path", meta.path === `${SCRATCH}/plain.md`, meta.path);
  check("upload reports the byte size", meta.size === encoded.byteLength,
    `${meta.size} vs ${encoded.byteLength}`);
  check("upload reports server_modified", Boolean(meta.serverModified), meta.serverModified);
  note(`rev format: ${meta.rev}`);

  console.log("\nDownload and the metadata header:");
  const got = await client.download(`${SCRATCH}/plain.md`);
  check("download returns the exact bytes",
    new TextDecoder().decode(got.data) === text);
  check("Dropbox-API-Result header was found and parsed", Boolean(got.meta.rev));
  check("download rev matches upload rev", got.meta.rev === meta.rev,
    `${got.meta.rev} vs ${meta.rev}`);

  console.log("\nNon-ASCII filenames (Dropbox-API-Arg escaping):");
  const unicodeName = `${SCRATCH}/café 日本語 🎉.md`;
  note(`escaped header: ${apiArg({ path: unicodeName }).slice(0, 80)}...`);
  const uniMeta = await client.upload(
    unicodeName,
    new TextEncoder().encode("unicode body").buffer as ArrayBuffer,
  );
  check("a unicode filename uploads", Boolean(uniMeta.rev));
  check("Dropbox echoes the name back intact", uniMeta.path === unicodeName, uniMeta.path);
  const uniBack = await client.download(unicodeName);
  check("and it downloads intact", new TextDecoder().decode(uniBack.data) === "unicode body");
  // Dropbox normalizes unicode; record which form it returns.
  note(
    `returned path is ${uniMeta.path === uniMeta.path.normalize("NFC") ? "NFC" : "not NFC"}` +
      `${uniMeta.path === uniMeta.path.normalize("NFD") ? " (also NFD-equal)" : ""}`,
  );

  console.log("\nBinary fidelity:");
  const bytes = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
  await client.upload(`${SCRATCH}/all-bytes.bin`, bytes.buffer as ArrayBuffer);
  const binBack = await client.download(`${SCRATCH}/all-bytes.bin`);
  const roundTripped = new Uint8Array(binBack.data);
  check("all 256 byte values survive a round trip",
    roundTripped.length === 256 && roundTripped.every((b, i) => b === i),
    `${roundTripped.length} bytes`);

  console.log("\nListing:");
  const listing = await client.listFolder(SCRATCH);
  check("list_folder returns the uploaded files", listing.files.length >= 4,
    `${listing.files.length} files`);
  check("list_folder returns a cursor", Boolean(listing.cursor));
  const listedUnicode = listing.files.find((f) => f.path === unicodeName);
  check("the unicode file appears in the listing with its name intact",
    Boolean(listedUnicode), listing.files.map((f) => f.path).join(", "));

  console.log("\nListing the app-folder root (the \"\" vs \"/\" rule):");
  try {
    const root = await client.listFolder("");
    check('path "" lists the app folder root', Array.isArray(root.files));
    note(`app folder root holds ${root.files.length} files total`);
  } catch (err) {
    check('path "" lists the app folder root', false,
      err instanceof Error ? err.message : String(err));
  }

  console.log("\nOptimistic concurrency (mode: update):");
  // Correct rev should succeed.
  const updated = await client.upload(
    `${SCRATCH}/plain.md`,
    new TextEncoder().encode("second version\n").buffer as ArrayBuffer,
    meta.rev,
  );
  check("update with the correct rev succeeds", Boolean(updated.rev));
  check("the rev changes after a write", updated.rev !== meta.rev,
    `${meta.rev} -> ${updated.rev}`);

  // Stale rev must be rejected, and must be recognisable as a conflict.
  let conflictError: unknown;
  try {
    await client.upload(
      `${SCRATCH}/plain.md`,
      new TextEncoder().encode("third version\n").buffer as ArrayBuffer,
      meta.rev, // deliberately stale now
    );
  } catch (err) {
    conflictError = err;
  }
  check("update with a stale rev is rejected", conflictError !== undefined,
    "without this, concurrent edits silently overwrite");
  if (conflictError instanceof DropboxError) {
    check("the rejection is HTTP 409", conflictError.status === 409, String(conflictError.status));
    check("isUploadConflict recognises it", conflictError.isUploadConflict === true,
      `error_summary: ${conflictError.summary}`);
    note(`conflict error_summary: ${conflictError.summary}`);
  } else {
    check("the rejection is a DropboxError", false, String(conflictError));
  }

  console.log("\nNot-found decoding:");
  let notFound: unknown;
  try {
    await client.download(`${SCRATCH}/does-not-exist.md`);
  } catch (err) {
    notFound = err;
  }
  if (notFound instanceof DropboxError) {
    check("a missing file raises 409", notFound.status === 409, String(notFound.status));
    check("isNotFound recognises it", notFound.isNotFound === true,
      `error_summary: ${notFound.summary}`);
    note(`not-found error_summary: ${notFound.summary}`);
  } else {
    check("a missing file raises a DropboxError", false, String(notFound));
  }

  console.log("\nDelete:");
  await client.deletePath(`${SCRATCH}/plain.md`);
  let goneConfirmed = false;
  try {
    await client.download(`${SCRATCH}/plain.md`);
  } catch {
    goneConfirmed = true;
  }
  check("delete_v2 removes the file", goneConfirmed);
  // Deleting twice must be idempotent, since sync may retry.
  let doubleDeleteThrew = false;
  try {
    await client.deletePath(`${SCRATCH}/plain.md`);
  } catch {
    doubleDeleteThrew = true;
  }
  check("deleting an already-deleted path is a no-op", !doubleDeleteThrew);

  // ---------------------------------------------------------------- cleanup
  console.log("\nCleaning up:");
  try {
    await client.deletePath(SCRATCH);
    console.log(`  ok    removed ${SCRATCH}`);
  } catch (err) {
    console.log(`  warn  could not remove ${SCRATCH}: ${err instanceof Error ? err.message : err}`);
    console.log("        delete it by hand from your Dropbox app folder");
  }
  fs.rmSync(STATE_FILE, { force: true });

  // ----------------------------------------------------------------- report
  console.log("\n" + "=".repeat(72));
  console.log(`live check: ${passed} assertions passed`);
  if (notes.length > 0) {
    console.log("\nObserved from real Dropbox:");
    for (const n of notes) console.log(`  - ${n}`);
  }
  if (failures.length > 0) {
    console.log(`\n${failures.length} FAILURE(S):`);
    for (const f of failures) console.log(`  - ${f}`);
    console.log("\nThe plugin is NOT ready to submit. Fix these first.");
    process.exit(1);
  }
  console.log("\nEvery client assumption matches real Dropbox.");
  console.log("Your refresh token was not written to disk; nothing to clean up locally.");
  console.log("=".repeat(72));
}

// --------------------------------------------------------------------- main

const [command, argument] = process.argv.slice(2);

if (command === "url" && argument) {
  void printUrl(argument);
} else if (command === "verify" && argument) {
  void verify(argument);
} else {
  console.log(`Live Dropbox conformance check.

  npm run live:url -- <app-key>    print an authorization URL to visit
  npm run live:verify -- <code>    complete auth and run the checks

Creates and then deletes ${SCRATCH} inside your Dropbox app folder.
Nothing else in your Dropbox is touched.`);
  process.exit(1);
}
