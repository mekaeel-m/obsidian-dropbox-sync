/**
 * Creates (or resets) a throwaway Obsidian vault for manual testing, seeded
 * with content chosen to exercise the cases that break sync tools.
 *
 *   node tests/make-test-vault.mjs                      # default location
 *   node tests/make-test-vault.mjs "D:/path/to/vault"   # custom
 *   node tests/make-test-vault.mjs --reset              # wipe and recreate
 *
 * Never point this at a vault you care about: --reset deletes it.
 */

import fs from "fs";
import os from "os";
import path from "path";

const args = process.argv.slice(2);
const reset = args.includes("--reset");
const target =
  args.find((a) => !a.startsWith("--")) ??
  path.join(os.homedir(), "Documents", "Obsidian", "dropbox-sync-testvault");

if (reset && fs.existsSync(target)) {
  // Guard against a mistyped path taking out something real.
  const marker = path.join(target, ".dropbox-sync-test-vault");
  if (!fs.existsSync(marker)) {
    console.error(
      `Refusing to --reset ${target}: it has no .dropbox-sync-test-vault marker,\n` +
        `so it was not created by this script. Delete it by hand if you really mean to.`,
    );
    process.exit(1);
  }
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`Wiped ${target}`);
}

const write = (rel, content) => {
  const full = path.join(target, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};

fs.mkdirSync(target, { recursive: true });
write(".dropbox-sync-test-vault", "Marker file. Safe to delete this whole vault.\n");

// --- Minimal but valid Obsidian config, so this opens as a real vault.
write(
  ".obsidian/app.json",
  JSON.stringify({ attachmentFolderPath: "Attachments", alwaysUpdateLinks: true }, null, 2),
);
write(".obsidian/appearance.json", JSON.stringify({ theme: "obsidian" }, null, 2));
write(".obsidian/core-plugins.json", JSON.stringify(["file-explorer", "global-search"], null, 2));
write(".obsidian/community-plugins.json", JSON.stringify(["dropbox-vault-sync"], null, 2));

// --- Ordinary notes, including frontmatter and wikilinks.
write(
  "Start here.md",
  `---
tags: [test, sync]
created: 2026-11-01
---

# Start here

A throwaway vault for testing [[Dropbox Vault Sync]].

## What to try

1. Sync once and confirm the status bar shows a timestamp.
2. Edit this line on another device and sync both.
3. Edit it on *both* devices before syncing — you should get a conflict copy.

See [[Notes/Conflict target]] for the file to fight over.
`,
);

write(
  "Dropbox Vault Sync.md",
  `# Dropbox Vault Sync

Notes on the plugin under test. Linked from [[Start here]].

- Expected: an idle vault logs \`plan: nothing to do\`
- Expected: deletions land in \`.trash\`, not oblivion
`,
);

// --- The file to deliberately conflict on.
write(
  "Notes/Conflict target.md",
  `# Conflict target

Edit this on two devices before syncing either one.

Original content.
`,
);

// --- Nested folders, to test parent creation on download.
write("Notes/Deep/Deeper/Deepest/buried.md", "# Buried\n\nFour levels down.\n");

// --- Unicode filenames: the Dropbox-API-Arg escaping path.
write("Notes/café notes.md", "# Café\n\nAccented filename (may be NFD on macOS).\n");
write("Notes/日本語のノート.md", "# 日本語\n\nCJK filename.\n");
write("Notes/emoji 🎉 party.md", "# Emoji\n\nAstral-plane codepoint in the filename.\n");

// --- A same-length file, where only mtime can reveal an edit.
write("Notes/same-size.md", "AAAA");

// --- A real binary attachment: a valid 1x1 red PNG.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);
fs.mkdirSync(path.join(target, "Attachments"), { recursive: true });
fs.writeFileSync(path.join(target, "Attachments", "red-dot.png"), png);

// --- Every byte value, to catch any text-mode corruption.
fs.writeFileSync(
  path.join(target, "Attachments", "all-bytes.bin"),
  Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
);

// --- Files that must NOT sync, to verify exclusions.
write("Attachments/.DS_Store", "mac noise");
write("scratch.tmp", "should be excluded by the *.tmp example pattern");

console.log(`Test vault ready at:\n  ${target}\n`);
console.log("Contents:");
const walk = (dir, prefix = "") => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    else console.log(`  ${rel}`);
  }
};
walk(target);
console.log(`\nNext: node install.mjs "${target.replace(/\\/g, "/")}"`);
console.log("Then open it in Obsidian with File -> Open folder as vault.");
