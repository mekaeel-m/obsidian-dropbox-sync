// Copies the built plugin into a vault: node install.mjs "C:/path/to/vault"
import fs from "fs";
import path from "path";

const vault = process.argv[2];
if (!vault) {
  console.error('usage: node install.mjs "C:/path/to/your/vault"');
  process.exit(1);
}
if (!fs.existsSync(path.join(vault, ".obsidian"))) {
  console.error(`Not an Obsidian vault (no .obsidian folder): ${vault}`);
  process.exit(1);
}
if (!fs.existsSync("main.js")) {
  console.error("main.js is missing — run `npm run build` first.");
  process.exit(1);
}

const id = JSON.parse(fs.readFileSync("manifest.json", "utf8")).id;
const dest = path.join(vault, ".obsidian", "plugins", id);
fs.mkdirSync(dest, { recursive: true });

for (const file of ["main.js", "manifest.json", "styles.css"]) {
  if (!fs.existsSync(file)) continue;
  fs.copyFileSync(file, path.join(dest, file));
  console.log(`  ${file} -> ${path.join(dest, file)}`);
}

console.log("\nInstalled. Reload Obsidian, then enable it in Community plugins.");
console.log("Your data.json (tokens, sync state) is left untouched.");
