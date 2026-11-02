# Dropbox Vault Sync

> **Status: unreleased.** 308 automated assertions pass across four suites,
> including an integration suite over real HTTP against a local server that
> speaks the Dropbox protocol, and a suite that loads the shipped `main.js`
> itself. Real-Dropbox conformance is checked by `npm run live:url` /
> `live:verify`, which needs your own app key and one trip through the consent
> screen. Until you have run that, use a throwaway vault. See
> [SUBMISSION.md](SUBMISSION.md) for exactly what is and isn't verified.

An Obsidian plugin that syncs a vault between desktop and mobile through your own
Dropbox app folder. Two-way, with genuine change detection and conflict copies
instead of last-write-wins.

Works on Windows, macOS, Linux, iOS and Android — the same bundle, because it
uses only APIs available in Obsidian's mobile runtime.

## How it decides what to do

Comparing local against remote only tells you they differ, not which side moved.
So the plugin keeps a third view: a snapshot of what it last saw in agreement,
one record per file holding the local mtime/size and the Dropbox `rev` at that
moment. The pair of changes gives the direction:

| local changed | remote changed | action |
| --- | --- | --- |
| no | no | nothing |
| yes | no | upload |
| no | yes | download |
| yes | yes | **conflict — keep both** |

Deletions run through the same table, with "gone" as a kind of change:

| local | remote | action |
| --- | --- | --- |
| deleted | unchanged | delete remote |
| unchanged | deleted | move local to the vault's `.trash` |
| deleted | edited | download — an edit is newer information than a delete |
| edited | deleted | upload — same reasoning, other direction |
| deleted | deleted | forget the record |

That snapshot is also the safety mechanism. A file missing locally means
"deleted here" *only* because a record proves we once had it. Without that
record, missing-locally is indistinguishable from never-downloaded — which is
exactly how hand-rolled sync scripts wipe a vault off the server on first run.

**Conflicts never overwrite.** Your local version stays at the canonical path;
the remote version is written beside it as
`note (conflict 2026-11-01 14-32-07 from phone).md` and uploaded too, so every
device ends up holding both and you can resolve it wherever you are.

## Setup

### 1. Create a Dropbox app

You use your own Dropbox app, so your notes are never routed through anyone
else's credentials or servers.

1. Go to [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps)
   and click **Create app**.
2. Choose **Scoped access**, then **App folder** — this confines the plugin to
   `Apps/<your app name>/` and nothing else in your Dropbox.
3. Name it anything (`obsidian-sync`).
4. On the **Permissions** tab, tick these and click **Submit**:
   - `account_info.read`
   - `files.metadata.read`
   - `files.metadata.write`
   - `files.content.read`
   - `files.content.write`
5. On the **Settings** tab, copy the **App key**.

> Set the permissions *before* connecting. Scopes are baked into the token at
> authorisation time, so adding them later means reconnecting.

### 2. Install the plugin

```bash
npm install
npm run build
```

Then copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/dropbox-vault-sync/`, or use the helper:

```bash
node install.mjs "C:/path/to/your/vault"
```

Enable it under **Settings → Community plugins** (Restricted mode must be off).

### 3. Connect

In the plugin's settings, paste the app key, click **Connect to Dropbox**,
approve access in the browser, and paste the code Dropbox shows you back into
Obsidian.

The paste step exists on purpose. OAuth normally uses a redirect URI, which is
straightforward in desktop Electron and genuinely awkward inside Obsidian's
mobile webview. Omitting the redirect makes Dropbox display the code instead, so
one code path works identically on every platform. The flow uses PKCE, so the
plugin holds no client secret — which it couldn't keep anyway, being readable
source on every device that installs it.

### 4. Repeat on each device

Install, connect, and set the **same remote subfolder** on every device. The
first sync on a second device that already holds the vault compares content
before flagging anything, so identical files are adopted silently rather than
generating a conflict copy per note.

## Settings worth knowing

| Setting | Why you'd change it |
| --- | --- |
| **Remote subfolder** | Keep several vaults in one Dropbox app folder. Must match across devices. |
| **Sync the .obsidian config folder** | Off by default. Shares themes and hotkeys, but plugin binaries differ between desktop and mobile, so this can break plugins on one platform. Workspace layout is always excluded regardless. |
| **Exclusions** | One pattern per line, matched like a `.gitignore`: a pattern with no slash matches anywhere in the vault, one with a slash is anchored to the root. `*` within a segment, `**` across segments, trailing `/` for a whole folder. |
| **Maximum file size** | Files over this are skipped and reported. Capped at 150 MB — Dropbox's single-request upload limit. |
| **Quiet period** | Seconds of no edits before an automatic sync fires. Lower means fresher, and more API calls. |
| **Parallel transfers** | 4 is a good default. Higher is faster until Dropbox starts rate-limiting. |

Always excluded, no matter what: `.obsidian/workspace.json`,
`.obsidian/workspace-mobile.json`, `.trash/`, `.git/`, this plugin's own
`data.json`, and `.DS_Store` / `Thumbs.db`.

## Development

```bash
npm run dev               # watch build
npm run typecheck         # tsc --noEmit
npm test                  # all four suites (run npm run build first)
npm run test:unit         # decision table, in-memory, no HTTP
npm run test:integration  # real HTTP against a local fake Dropbox
npm run test:vault        # the real test vault, synced between two devices
npm run test:plugin       # loads the shipped main.js in a jsdom Obsidian mock

node tests/make-test-vault.mjs          # create a throwaway vault to test with
node tests/make-test-vault.mjs --reset  # wipe and recreate it

npm run live:url -- <app-key>   # conformance check against real Dropbox
npm run live:verify -- <code>   # ...after approving at the printed URL
```

Four layers, deliberately:

**Unit** (`tests/engine.test.ts`) runs the real `SyncEngine` against an
in-memory vault and Dropbox, covering the whole decision table plus the cases
that lose data when they're wrong — unseen remote files, resurrect-on-edit, and
conflict convergence. The fake vault stamps a new mtime on every write, because
that's the detail that makes naive implementations re-upload a file forever
after downloading it.

**Integration** (`tests/integration.test.ts`) starts a local HTTP server that
speaks the real Dropbox wire protocol (`tests/fake-dropbox-server.mjs`) and
drives the production `AuthManager`, `DropboxClient` and `SyncEngine` against it
over actual HTTP, with two simulated devices and real files on disk. This is
what covers header encoding, the download metadata header, Dropbox error
payloads, 429/5xx/401 retry paths, PKCE token exchange and refresh, and binary
fidelity up to 2 MB. The server is strict where Dropbox is strict — it rejects
non-ASCII header bytes, rejects a JSON content type on content endpoints, and
enforces `mode: update` concurrency with a 409.

**Vault smoke** (`tests/vault-smoke.test.ts`) takes the actual on-disk test
vault — real NTFS files, emoji and CJK filenames, a real PNG — syncs it between
two devices, and asserts every synced file is byte-identical while every
excluded file stayed home. This is the layer that caught a real bug the unit
tests missed: `.DS_Store` was only excluded at the vault root, when the whole
point of `.DS_Store` is that it appears in every directory.

**Plugin load** (`tests/plugin-load.test.mjs`) is the only suite that runs the
**build artifact** rather than the sources. It loads the real `main.js` with
`obsidian` resolved to a jsdom-backed mock, calls `onload`, renders the settings
tab, drives a sync through the plugin class itself, round-trips state through
`saveData`/`loadData` to prove a restart doesn't re-upload the vault, and runs
the whole thing again with `Platform.isMobile` true. This covers `main.ts` and
`settings.ts` — about 700 lines whose only failure mode is throwing at runtime,
which typechecking cannot catch and which users experience as "the plugin won't
load" or "the settings tab is blank".

**Live conformance** (`scripts/live-check.ts`) is not part of `npm test` because
it needs credentials. It drives the production `PkceFlow`, `AuthManager` and
`DropboxClient` against **real Dropbox**, creating and then deleting a
`/__livecheck__/` folder inside your app folder. It verifies the things only
Dropbox can confirm: that offline access really yields a refresh token, that
`rev` changes on write, that a stale `rev` is rejected with a recognisable 409,
that `Dropbox-API-Arg` escaping survives a real round trip, that all 256 byte
values come back intact, and which Unicode normalization form Dropbox returns.

### Layout

| File | Role |
| --- | --- |
| `src/main.ts` | Plugin lifecycle, commands, scheduling, status bar |
| `src/sync.ts` | The engine: scan, list, diff, execute |
| `src/dropbox.ts` | Dropbox API over `requestUrl`, with retries |
| `src/auth.ts` | PKCE flow and access-token lifecycle |
| `src/paths.ts` | Vault ↔ Dropbox path translation, exclusion filter |
| `src/state.ts` | Settings and snapshot persistence |
| `src/settings.ts` | Settings tab and connect modal |

## Limitations

- **Files over 150 MB are skipped.** Dropbox requires a chunked upload session
  above that; not implemented yet.
- **Empty folders don't sync.** Both Dropbox listings and the vault scan are
  file-oriented.
- **Renames are a delete plus an add.** The content re-uploads rather than
  moving server-side.
- **No scheduled sync while Obsidian is closed.** A plugin only runs when the
  app does — on mobile, sync happens when you open Obsidian, not in the
  background.
- **Polling, not push.** Dropbox supports a long-poll endpoint for near-instant
  remote change detection; this uses the interval and the quiet-period trigger
  instead.
- **Tokens sit in plaintext** in `.obsidian/plugins/dropbox-vault-sync/data.json`,
  like every other Obsidian plugin that stores credentials. Anyone with your
  vault files can read them. The app-folder scope limits the blast radius to that
  one folder.
- **Case-sensitivity.** Paths are matched case-insensitively to match Dropbox's
  own semantics. Two notes differing only in case will collide.

## Safety notes

Back the vault up before the first sync on a second device. The engine is
conservative — it trashes rather than deletes, keeps both sides of a conflict,
and uses optimistic concurrency on uploads so a file that changed underneath it
turns into a conflict instead of an overwrite — but it is new code holding your
notes, and the first run across two devices is where any configuration mistake
(a mismatched remote subfolder, especially) shows up.

**Reset state** in the settings forgets the snapshot without deleting any files.
Use it after restoring a backup or changing the remote subfolder; the next sync
re-pairs everything by comparing content.
