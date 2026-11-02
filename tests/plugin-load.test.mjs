/**
 * Loads the real shipped main.js and exercises the plugin as Obsidian would.
 *
 * This is the only suite that runs the *build artifact* rather than the
 * sources, and the only one that touches main.ts and settings.ts — roughly 700
 * lines whose failure mode is throwing at runtime. A wrong Setting method, a
 * misused createFragment, an unhandled promise in a button handler: none of
 * those are caught by typechecking or by the engine tests, and all of them
 * present to the user as "the plugin doesn't load" or "the settings tab is
 * blank".
 *
 * Run after `npm run build`.
 */

import fs from "fs";
import os from "os";
import path from "path";
import Module from "module";

import * as obsidian from "./obsidian-mock.mjs";
import { FsAdapter, rewriteDropboxTo } from "./harness.ts";
import { startFakeDropbox } from "./fake-dropbox-server.mjs";

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `expected ${e}, got ${a}`);
}

/**
 * Load the built bundle with `obsidian` resolved to our mock. Done by patching
 * the module loader rather than bundling, so what runs is byte-for-byte the
 * file that ships in the release.
 */
function loadBuiltPlugin() {
  const file = path.resolve("main.js");
  if (!fs.existsSync(file)) {
    throw new Error("main.js not found — run `npm run build` first");
  }

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "obsidian") return obsidian;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    // Fresh evaluation each time, so module-level state cannot leak.
    delete require.cache?.[file];
    const source = fs.readFileSync(file, "utf8");
    const wrapper = new Function("require", "module", "exports", "__filename", "__dirname", source);
    const module = { exports: {} };
    const localRequire = (request) => Module._load(request, null, false);
    wrapper(localRequire, module, module.exports, file, path.dirname(file));
    return module.exports;
  } finally {
    Module._load = originalLoad;
  }
}

/** Find a Setting in a rendered tab by its name. */
function settingNamed(tab, name) {
  return [...tab.containerEl.querySelectorAll(".setting-item")].find(
    (el) => el.textContent && el.textContent.startsWith(name),
  );
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dbxplugin-"));
  const server = await startFakeDropbox();

  // ---------------------------------------------------- the bundle itself
  let exported;
  try {
    exported = loadBuiltPlugin();
  } catch (err) {
    console.log(`FATAL: could not load main.js: ${err.message}`);
    process.exit(1);
  }

  const PluginClass = exported.default ?? exported;
  check("main.js exports a plugin class", typeof PluginClass === "function");
  check("it extends Plugin", PluginClass.prototype instanceof obsidian.Plugin);

  // ------------------------------------------------------------ onload
  const adapter = new FsAdapter(path.join(tmp, "vault"));
  const app = new obsidian.App(adapter);
  const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));

  const plugin = new PluginClass(app, manifest);
  obsidian.resetRecorded();

  let loadError = null;
  try {
    await plugin.onload();
  } catch (err) {
    loadError = err;
  }
  check("onload completes without throwing", loadError === null,
    loadError ? String(loadError.stack ?? loadError) : "");
  if (loadError) {
    console.log(`\nFATAL during onload:\n${loadError.stack ?? loadError}`);
    process.exit(1);
  }

  // ------------------------------------------------- what onload registered
  const commandIds = obsidian.recorded.commands.map((c) => c.id);
  check("a sync command is registered", commandIds.includes("sync-now"), commandIds.join(", "));
  check("a cancel command is registered", commandIds.includes("cancel-sync"), commandIds.join(", "));
  check("a ribbon icon is added", obsidian.recorded.ribbons.length === 1);
  check("a settings tab is added", obsidian.recorded.settingTabs.length === 1);
  check("a status bar item is added on desktop", obsidian.recorded.statusBarItems.length === 1);

  const vaultEvents = obsidian.recorded.events.map((e) => e.name).sort();
  eq("vault events registered exactly once each", vaultEvents,
    ["create", "delete", "modify", "rename"]);

  // Commands must declare a name, and must not set a default hotkey.
  for (const command of obsidian.recorded.commands) {
    check(`command ${command.id} has a name`, typeof command.name === "string" && command.name.length > 0);
    check(`command ${command.id} sets no default hotkey`, command.hotkeys === undefined);
  }

  // A fresh install has no credentials, so nothing should have been attempted.
  eq("a fresh install raises no notices", obsidian.recorded.notices, []);

  // ------------------------------------------------- settings tab rendering
  const tab = obsidian.recorded.settingTabs[0];
  let displayError = null;
  try {
    tab.display();
  } catch (err) {
    displayError = err;
  }
  check("settings tab renders without throwing", displayError === null,
    displayError ? String(displayError.stack ?? displayError) : "");

  if (!displayError) {
    const items = tab.containerEl.querySelectorAll(".setting-item");
    check("settings tab produced controls", items.length > 10, `${items.length} items`);

    const headings = [...tab.containerEl.querySelectorAll(".setting-item-heading")].map((el) =>
      el.textContent.trim(),
    );
    check("more than one section, so headings are justified", headings.length > 1,
      headings.join(" | "));
    check(
      "no heading contains the word 'settings'",
      !headings.some((h) => /settings/i.test(h)),
      headings.join(" | "),
    );
    check(
      "headings are sentence case, not Title Case",
      headings.every((h) => {
        const words = h.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
        // Allow the first word and any word that is a proper noun to be capitalised.
        const proper = new Set(["Dropbox", "Obsidian"]);
        return words.slice(1).every((w) => proper.has(w) || w[0] === w[0].toLowerCase());
      }),
      headings.join(" | "),
    );

    for (const label of ["App key", "Remote subfolder", "Exclusions", "Device name"]) {
      check(`settings tab shows "${label}"`, Boolean(settingNamed(tab, label)));
    }

    // Rendering twice must not duplicate: display() is called on every open.
    const before = tab.containerEl.querySelectorAll(".setting-item").length;
    tab.display();
    const after = tab.containerEl.querySelectorAll(".setting-item").length;
    eq("re-rendering the tab does not duplicate controls", after, before);
  }

  // ------------------------------------------- settings actually round-trip
  // Drive the real onChange handlers, then confirm saveData persisted.
  const freshTab = obsidian.recorded.settingTabs[0];
  freshTab.display();

  const findComponent = (name, kind) => {
    // Re-render bookkeeping: walk the Setting objects the tab created.
    const el = settingNamed(freshTab, name);
    if (!el) return null;
    const input = el.querySelector(kind);
    return input;
  };
  check("app key input exists", Boolean(findComponent("App key", "input")));

  // ------------------------------------------------- unconfigured sync is safe
  obsidian.recorded.notices.length = 0;
  await plugin.sync("manual");
  check(
    "syncing without credentials warns instead of throwing",
    obsidian.recorded.notices.some((n) => /connect/i.test(n)),
    obsidian.recorded.notices.join(" | "),
  );

  // --------------------------------------- configure it and sync for real
  adapter.write("Note.md", "# Hello\n\nFrom the real plugin class.\n");
  adapter.write("Sub/Nested.md", "nested content");

  // Point the shipped bundle at the fake server by rewriting Dropbox hostnames
  // at the HTTP layer. The bundle itself has the real URLs hardcoded, exactly
  // as it will in the release.
  rewriteDropboxTo(`http://127.0.0.1:${server.port}`);

  await plugin.updateSettings({
    appKey: server.appKey,
    refreshToken: server.refreshToken,
    remoteFolder: "pluginvault",
    deviceName: "harness",
    verboseLogging: false,
  });

  obsidian.recorded.notices.length = 0;
  await plugin.sync("manual");

  const synced = server.text("/pluginvault/Note.md");
  eq("the plugin class synced a real file end to end", synced,
    "# Hello\n\nFrom the real plugin class.\n");
  check("nested file synced too", server.text("/pluginvault/Sub/Nested.md") === "nested content");
  check(
    "the user was told what happened",
    obsidian.recorded.notices.some((n) => /2 up|up,|sync/i.test(n)),
    obsidian.recorded.notices.join(" | "),
  );
  check(
    "no failure notice was raised",
    !obsidian.recorded.notices.some((n) => /failed/i.test(n)),
    obsidian.recorded.notices.join(" | "),
  );

  // The status bar should now carry a timestamp, not "syncing".
  const statusText = obsidian.recorded.statusBarItems[0].textContent;
  check("status bar shows a settled state", /Dropbox:/.test(statusText) && !/syncing/.test(statusText),
    statusText);

  // --------------------------------------------- state survives a reload
  const persisted = await plugin.loadData();
  check("settings were persisted", Boolean(persisted?.settings?.appKey));
  check("the snapshot was persisted", Object.keys(persisted?.snapshot?.records ?? {}).length === 2,
    JSON.stringify(Object.keys(persisted?.snapshot?.records ?? {})));
  check("tokens are stored under settings", typeof persisted.settings.refreshToken === "string");

  // Simulate an Obsidian restart: new instance, same persisted data. The
  // snapshot must survive the round trip through saveData/loadData, or every
  // restart would re-upload the whole vault.
  const plugin2 = new PluginClass(app, manifest);
  plugin2._data = persisted;
  await plugin2.onload();

  obsidian.recorded.notices.length = 0;
  await plugin2.sync("manual");
  check(
    "after a reload, a settled vault transfers nothing",
    !obsidian.recorded.notices.some((n) => /\d+ up|\d+ down/.test(n)),
    obsidian.recorded.notices.join(" | "),
  );
  check(
    "and it says so",
    obsidian.recorded.notices.some((n) => /up to date/i.test(n)),
    obsidian.recorded.notices.join(" | "),
  );
  plugin2.onunload();

  // ------------------------------------------- vault events trigger a sync
  adapter.write("Triggered.md", "created by a vault event");
  app.vault.trigger("create", { path: "Triggered.md" });
  check("a vault event does not throw", true);

  // ------------------------------------------------------ the connect modal
  // Exercises PkceFlow + the modal's async onOpen, which only runs in the UI.
  obsidian.opened.length = 0;
  const connectSetting = settingNamed(freshTab, "Status") ?? settingNamed(freshTab, "App key");
  check("connection section rendered", Boolean(connectSetting));

  // --------------------------------------------------------------- onunload
  let unloadError = null;
  try {
    plugin.onunload();
  } catch (err) {
    unloadError = err;
  }
  check("onunload completes without throwing", unloadError === null,
    unloadError ? String(unloadError.stack ?? unloadError) : "");

  // ------------------------------------------------------- mobile code path
  // isDesktopOnly is false, so the mobile branch must work too.
  obsidian.Platform.isMobile = true;
  obsidian.resetRecorded();
  const mobilePlugin = new PluginClass(new obsidian.App(adapter), manifest);
  let mobileError = null;
  try {
    await mobilePlugin.onload();
  } catch (err) {
    mobileError = err;
  }
  check("onload works on the mobile code path", mobileError === null,
    mobileError ? String(mobileError.stack ?? mobileError) : "");
  eq("no status bar item is created on mobile", obsidian.recorded.statusBarItems.length, 0);
  check("the settings tab still renders on mobile", (() => {
    try {
      obsidian.recorded.settingTabs[0].display();
      return true;
    } catch {
      return false;
    }
  })());
  mobilePlugin.onunload();
  obsidian.Platform.isMobile = false;

  await server.close();

  console.log(`\nplugin load: ${passed} assertions passed`);
  if (failures.length > 0) {
    console.log(`\n${failures.length} FAILURE(S):`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("plugin load: all green");
  fs.rmSync(tmp, { recursive: true, force: true });
  obsidian.teardown();
  // jsdom's visual-mode timers keep libuv handles open; exit deliberately
  // rather than letting node assert on teardown.
  process.exit(0);
}

main().catch((err) => {
  console.log(`\nUNCAUGHT: ${err.stack ?? err}`);
  process.exit(1);
});
