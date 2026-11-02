// Bundles each test entry and runs it.
//
//   unit        — `obsidian` aliased to a shim that forbids HTTP
//   integration — shim that performs real HTTP against the local fake Dropbox
//   vault       — same, but driven from the real on-disk test vault
//   plugin      — loads the built main.js itself, with a jsdom-backed mock
//
// `packages: "external"` keeps node_modules (jsdom) out of the bundle; the
// `obsidian` alias points at a local file, so it still gets bundled in.
import esbuild from "esbuild";
import { execFileSync } from "child_process";
import path from "path";

const only = process.argv[2];

const suites = [
  { name: "unit", entry: "tests/engine.test.ts", shim: "tests/obsidian-shim.ts" },
  { name: "integration", entry: "tests/integration.test.ts", shim: "tests/obsidian-shim-http.ts" },
  { name: "vault", entry: "tests/vault-smoke.test.ts", shim: "tests/obsidian-shim-http.ts" },
  { name: "plugin", entry: "tests/plugin-load.test.mjs", shim: "tests/obsidian-shim-http.ts" },
];

let failed = false;

for (const suite of suites) {
  if (only && only !== suite.name) continue;

  const out = path.join("tests", `.built-${suite.name}.cjs`);
  await esbuild.build({
    entryPoints: [suite.entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: out,
    packages: "external",
    alias: { obsidian: path.resolve(suite.shim) },
    logLevel: "warning",
  });

  console.log(`--- ${suite.name} ---`);
  try {
    execFileSync(process.execPath, [out], { stdio: "inherit" });
  } catch {
    failed = true;
    if (only) process.exit(1);
  }
}

if (failed) process.exit(1);
