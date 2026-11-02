# Submitting to the Obsidian community plugin directory

## Where this stands

**Verified by automated tests** — 266 assertions across three suites, all green:

| Layer | What it proves |
| --- | --- |
| `test:unit` (102) | The full decision table, including the data-loss cases: unseen remote files, resurrect-on-edit, conflict convergence |
| `test:integration` (116) | Real HTTP: header encoding, download metadata header, Dropbox error payloads, 429/5xx/401 retry, PKCE exchange and refresh, 2 MB binary fidelity |
| `test:vault` (48) | The real on-disk test vault synced between two devices, byte-identical, with exclusions honoured |

Also verified by inspection:

- the shipped bundle imports **only** `obsidian` — no Node or Electron, nothing
  that would fail on mobile (checked against the built `main.js`)
- no regex lookbehind anywhere (unsupported on older iOS WebKit)
- every `requestUrl`, `DataAdapter`, `Stat` and `DataWriteOptions` assumption
  checked against `obsidian.d.ts` rather than memory
- both test suites mutation-tested: deliberately breaking the download-mtime
  invariant, the `Dropbox-API-Arg` escaping, and the retry handler each make the
  suites fail, so they have real teeth

**Still unverified — and this is the gate.** Nothing has ever talked to real
Dropbox. The local server is faithful to the documented protocol and strict
where Dropbox is strict, but it is still a model of Dropbox, not Dropbox:

- real OAuth: the actual consent screen, the real pasted code, real scope
  enforcement (`missing_scope` if the Permissions tab wasn't configured first)
- real `rev` semantics and real `server_modified` values
- real rate-limit thresholds and `Retry-After` values under genuine load
- real Obsidian UI: the settings tab, the connect modal, the status bar, and
  how `adapter.write` interacts with Obsidian's own file watcher
- actual mobile runtime behaviour on iOS and Android

Do not submit a **sync** plugin before closing that gap. Reviewers install and
run submissions, and the failure mode for sync bugs is other people's lost
notes.

---

## Stage 1 — live-test against real Dropbox

A throwaway vault is already set up for this:

```bash
node tests/make-test-vault.mjs      # creates ~/Documents/Obsidian/dropbox-sync-testvault
npm run build
node install.mjs "C:/Users/<you>/Documents/Obsidian/dropbox-sync-testvault"
```

Open it in Obsidian with **File → Open folder as vault**, enable the plugin
under Community plugins, then follow README step 1 to create your Dropbox app
and connect.

The vault is seeded with exactly the content that breaks sync tools:

| Seeded file | What it probes |
| --- | --- |
| `Notes/café notes.md` | Unicode header escaping, and NFD/NFC if you touch it from iOS |
| `Notes/日本語のノート.md` | Multi-byte filenames |
| `Notes/emoji 🎉 party.md` | Astral-plane codepoints (surrogate pairs) |
| `Notes/same-size.md` | An edit that keeps byte length identical — only mtime reveals it |
| `Attachments/red-dot.png` | A real binary, must open as an image afterwards |
| `Attachments/all-bytes.bin` | All 256 byte values, catches text-mode corruption |
| `Notes/Deep/Deeper/Deepest/` | Parent-folder creation on download |
| `Notes/Conflict target.md` | The file to deliberately fight over |
| `scratch.tmp`, `Attachments/.DS_Store` | Exclusions, including the nested-basename case |

Work through this with two devices. Everything here is already covered against
the fake server; you are confirming real Dropbox agrees.

| Scenario | Expected |
| --- | --- |
| **Click Test in settings** | Shows your account name — this alone validates PKCE, scopes and auth |
| New note on A, sync both | Appears on B |
| Edit on A only | B gets it, no conflict file |
| Edit on B only | A gets it, no conflict file |
| Edit both before syncing | Both kept, copy named for the device |
| Sync twice more after that conflict | Settles; stops transferring |
| Delete on A | Gone on B, recoverable from B's `.trash` |
| Delete on A, edit on B | File survives with B's edit |
| Install on a device already holding the vault | No conflict storm |
| Edit `same-size.md` to another 4 characters | Still detected and uploaded |
| Open `red-dot.png` on B | Renders as an image |
| `scratch.tmp` | Never appears in Dropbox |
| Airplane mode mid-sync | Clear error, no corruption, recovers next run |
| Leave it idle 10 minutes | Verbose log shows `plan: nothing to do` every time |

**The one signal that matters most:** an idle vault must produce an empty plan.
Turn on Verbose logging and watch. If it repeatedly uploads or downloads the
same file, the snapshot is not recording what the filesystem actually did, and
nothing downstream can be trusted. The automated suites assert this, but only
against a model of Dropbox.

Then use it as your real sync for **two weeks** before submitting.

## Stage 2 — repository

Needs to be a public GitHub repo with the plugin at its **root**
(`manifest.json` at the top level, not in a subfolder). Required at root:
`README.md`, `LICENSE`, `manifest.json` — all three present.

```bash
git init
git add -A
git commit -m "Dropbox Vault Sync 0.1.0"
git branch -M main
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/obsidian-dropbox-sync.git
git push -u origin main
```

Then replace the placeholder in `manifest.json` → `authorUrl` with your GitHub
profile URL.

`main.js` is gitignored deliberately: it is a build artifact, attached to
releases rather than committed.

## Stage 3 — first release

The release tag must **exactly equal** `manifest.json`'s version, with no `v`
prefix. `0.1.0`, never `v0.1.0` — Obsidian looks up the release by that string.

```bash
git tag 0.1.0
git push --follow-tags
```

`.github/workflows/release.yml` runs all three test suites, builds, verifies the
tag matches the manifest, and attaches the assets individually (not zipped):

- `main.js`
- `manifest.json`
- `styles.css`

Check the release page shows all three as separate downloads before continuing.

## Stage 4 — submit

**This changed, and older guides are wrong about it.** Submission is no longer a
pull request against `obsidian-releases`; that repo now just points at the docs.

1. Sign in at **[community.obsidian.md](https://community.obsidian.md)** with
   your Obsidian account.
2. Link your GitHub account, so ownership of the repo can be verified.
3. Add your plugin through the directory UI.

Rules enforced on the way through:

- `id` must be unique across all published plugins and **cannot contain
  `obsidian`** — ours is `dropbox-vault-sync`, which is fine
- `id`, `name`, `author` and `description` should match `manifest.json`
- version must be semver `x.y.z`

An automated review runs and reports problems. You fix them by pushing changes
and **publishing a new release with an incremented version** — not by editing
the existing release in place. A human review follows; expect weeks to months,
and expect change requests.

## Compliance status

Checked against the current plugin guidelines, every item verified in the source
rather than assumed:

| Requirement | Status |
| --- | --- |
| No `innerHTML` / `outerHTML` / `insertAdjacentHTML` | Clean — DOM built with `createEl` |
| No hardcoded inline styles; CSS classes + Obsidian variables | Clean — all in `styles.css` |
| No Node or Electron APIs (required for mobile) | Clean — bundle imports only `obsidian` |
| No regex lookbehind | Clean |
| `this.app`, never the global `app` | Clean |
| No `any` casts in `src/` | Clean |
| `normalizePath()` on constructed and external paths | Clean |
| `registerEvent` / `registerInterval` for listeners | Clean |
| All timers cleared in `onunload` | Clean |
| Don't detach leaves in `onunload` | N/A — no custom views |
| `setHeading()` for sections, not HTML headings | Clean |
| No "settings" in section heading text | Clean |
| Sentence case throughout the UI | Clean |
| No default hotkeys | Clean — none assigned |
| `callback` / `checkCallback` used correctly | Clean — `checkCallback` for cancel |
| `const`/`let`, no `var`; async/await over chains | Clean |
| Placeholder class names renamed | Clean |
| Minimal console logging by default | Clean — behind an opt-in toggle |
| `README.md`, `LICENSE`, `manifest.json` at root | Clean |
| Manifest id/name/description conventions | Clean — verified by script |
| `isDesktopOnly: false` and genuinely mobile-capable | Clean |

### Two things a reviewer will likely raise

**1. `vault.adapter` instead of the `Vault` API.** The guidelines do say "prefer
Vault API over Adapter API", so expect this. The defence: the engine needs
`stat()` for mtimes, which the `Vault` API does not expose, and it needs to
reach files Obsidian does not track as `TFile` — dotfiles, and `.obsidian`
contents when config sync is enabled. The guidelines also say "avoid iterating
all files", which a sync engine cannot honour by definition. Remotely Save does
the same for the same reasons. The real tradeoff is that `adapter.write`
bypasses Obsidian's metadata cache; Obsidian's own file watcher reconciles it.

**2. Users must create their own Dropbox app.** Shipping a shared app key would
mean either embedding a secret in readable source, or routing every user's notes
through one developer-owned app — and a Dropbox app in development status is
capped at 50 linked users, so a shared key would need production approval and
make you custodian of everyone's access. Per-user apps avoid all of it.
Precedent: Remotely Save.

## Before you submit

- [ ] Two weeks of real use across all three devices, no data loss
- [ ] An idle vault reliably logs `plan: nothing to do`
- [ ] Every Stage 1 scenario confirmed against real Dropbox
- [ ] Confirmed working on iOS **and** Android, not just desktop
- [ ] `npm test` green (all three suites), `npm run build` clean
- [ ] `authorUrl` placeholder replaced
- [ ] Release `0.1.0` published with all three assets attached separately
- [ ] Read the
      [guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
      and
      [submission docs](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)
      yourself — they change, and this file is a snapshot taken 2026-11-01

## Worth deciding before you invest

**Support load.** Sync plugins generate the most demanding issue queue of any
category: every report is urgent and involves data you cannot see. Decide how
much of that you want to own.

**The field is crowded.** Remotely Save covers Dropbox, S3, OneDrive and WebDAV;
Self-hosted LiveSync does real-time via CouchDB. A reviewer may reasonably ask
what this adds. The honest answer is the conflict handling — keeping both
versions and provably converging, rather than picking a winner by timestamp —
plus a small, readable, well-tested codebase. State that up front in the
submission rather than waiting to be asked.
