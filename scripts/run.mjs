// Bundles scripts/live-check.ts (with `obsidian` aliased to the real-HTTP
// shim, since the live check genuinely talks to Dropbox) and runs it.
import esbuild from "esbuild";
import { execFileSync } from "child_process";
import path from "path";

const out = path.join("scripts", ".live-check.cjs");

await esbuild.build({
  entryPoints: ["scripts/live-check.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: out,
  packages: "external",
  alias: { obsidian: path.resolve("tests/obsidian-shim-http.ts") },
  logLevel: "warning",
});

try {
  execFileSync(process.execPath, [out, ...process.argv.slice(2)], { stdio: "inherit" });
} catch {
  process.exit(1);
}
