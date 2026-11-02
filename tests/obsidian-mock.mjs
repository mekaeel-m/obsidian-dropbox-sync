/**
 * A headless implementation of the slice of Obsidian's runtime API that this
 * plugin touches, backed by jsdom.
 *
 * This exists to load and exercise the **actual shipped main.js** — not the
 * TypeScript sources — so the settings tab, the connect modal and the plugin
 * lifecycle all get executed. Those are several hundred lines of UI code whose
 * only failure mode is throwing at runtime, which no amount of typechecking
 * catches: `new Setting(el).setFoo()` compiles fine against a wrong method name
 * only if the types are wrong too, and a misused `createFragment` throws only
 * when a user opens the settings tab.
 *
 * Where Obsidian's real behaviour matters we mirror it; where it doesn't, we
 * record the call so tests can assert on it.
 */

import { JSDOM } from "jsdom";
import { httpRequestUrl } from "./harness.ts";

// --------------------------------------------------------------- dom setup

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

export const window = dom.window;
export const document = window.document;

/**
 * Obsidian augments HTMLElement with these helpers globally. Plugins use them
 * constantly, so the mock has to provide them or everything throws.
 */
function installDomHelpers(win) {
  const proto = win.HTMLElement.prototype;
  const docProto = win.Document.prototype;
  const fragProto = win.DocumentFragment.prototype;

  function applyInfo(el, info) {
    if (!info) return el;
    if (typeof info === "string") {
      el.className = info;
      return el;
    }
    if (info.cls) el.className = Array.isArray(info.cls) ? info.cls.join(" ") : info.cls;
    if (info.text !== undefined) el.textContent = String(info.text);
    if (info.attr) for (const [k, v] of Object.entries(info.attr)) el.setAttribute(k, String(v));
    if (info.href !== undefined) el.setAttribute("href", info.href);
    if (info.title !== undefined) el.setAttribute("title", info.title);
    if (info.type !== undefined) el.setAttribute("type", info.type);
    if (info.placeholder !== undefined) el.setAttribute("placeholder", info.placeholder);
    if (info.value !== undefined) el.value = info.value;
    return el;
  }

  const createEl = function (tag, info) {
    const el = win.document.createElement(tag);
    applyInfo(el, info);
    this.appendChild(el);
    return el;
  };

  for (const target of [proto, fragProto]) {
    target.createEl = createEl;
    target.createDiv = function (info) {
      return createEl.call(this, "div", info);
    };
    target.createSpan = function (info) {
      return createEl.call(this, "span", info);
    };
    target.empty = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
      return this;
    };
    target.appendText = function (text) {
      this.appendChild(win.document.createTextNode(text));
      return this;
    };
  }

  proto.addClass = function (...cls) {
    this.classList.add(...cls.filter(Boolean));
    return this;
  };
  proto.removeClass = function (...cls) {
    this.classList.remove(...cls.filter(Boolean));
    return this;
  };
  proto.toggleClass = function (cls, on) {
    this.classList.toggle(cls, on);
    return this;
  };
  proto.setText = function (text) {
    this.textContent = String(text);
    return this;
  };
  proto.setAttr = function (name, value) {
    this.setAttribute(name, String(value));
    return this;
  };
  proto.detach = function () {
    this.remove();
    return this;
  };
  proto.show = function () {
    this.style.display = "";
    return this;
  };
  proto.hide = function () {
    this.style.display = "none";
    return this;
  };

  docProto.createEl = createEl;
  docProto.createDiv = function (info) {
    return createEl.call(this.body, "div", info);
  };

  win.createFragment = function (callback) {
    const frag = win.document.createDocumentFragment();
    if (callback) callback(frag);
    return frag;
  };
  win.createEl = function (tag, info) {
    return createEl.call(win.document.body, tag, info);
  };
  win.createDiv = function (info) {
    return createEl.call(win.document.body, "div", info);
  };
}

installDomHelpers(window);

// Expose the globals the bundle expects to find on the global object.
globalThis.window = window;
globalThis.document = document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.createFragment = window.createFragment;
globalThis.createEl = window.createEl;
globalThis.createDiv = window.createDiv;
globalThis.setTimeout = setTimeout;
globalThis.clearTimeout = clearTimeout;
globalThis.setInterval = setInterval;
globalThis.clearInterval = clearInterval;
window.setTimeout = setTimeout;
window.clearTimeout = clearTimeout;
window.setInterval = setInterval;
window.clearInterval = clearInterval;

/** Records every window.open call so the connect flow can be asserted on. */
export const opened = [];
window.open = (url) => {
  opened.push(url);
  return null;
};

// ---------------------------------------------------------- recorded state

export const recorded = {
  commands: [],
  ribbons: [],
  statusBarItems: [],
  notices: [],
  events: [],
  intervals: [],
  settingTabs: [],
};

export function resetRecorded() {
  for (const key of Object.keys(recorded)) recorded[key].length = 0;
  opened.length = 0;
}

// ------------------------------------------------------------- obsidian api

export class Notice {
  constructor(message, timeout) {
    this.message = message;
    this.timeout = timeout;
    recorded.notices.push(String(message));
  }
  hide() {
    this.hidden = true;
  }
  setMessage(message) {
    this.message = message;
    return this;
  }
}

export const Platform = {
  isMobile: false,
  isDesktop: true,
  isDesktopApp: true,
  isMobileApp: false,
  isIosApp: false,
  isAndroidApp: false,
};

export function normalizePath(path) {
  const cleaned = String(path).replace(/[\\/]+/g, "/").replace(/^\/+|\/+$/g, "");
  return (cleaned === "" ? "/" : cleaned).normalize("NFC");
}

export const requestUrl = httpRequestUrl;

export class Events {
  constructor() {
    this._handlers = new Map();
  }
  on(name, handler) {
    if (!this._handlers.has(name)) this._handlers.set(name, []);
    this._handlers.get(name).push(handler);
    const ref = { name, handler };
    recorded.events.push(ref);
    return ref;
  }
  off(name, handler) {
    const list = this._handlers.get(name) ?? [];
    const i = list.indexOf(handler);
    if (i >= 0) list.splice(i, 1);
  }
  /** Test helper: fire an event as Obsidian would. */
  trigger(name, ...args) {
    for (const handler of this._handlers.get(name) ?? []) handler(...args);
  }
}

/** Minimal Component lifecycle: register/unregister. */
class Component {
  constructor() {
    this._registered = [];
    this._intervals = [];
  }
  registerEvent(ref) {
    this._registered.push(ref);
    return ref;
  }
  registerInterval(id) {
    this._intervals.push(id);
    recorded.intervals.push(id);
    return id;
  }
  registerDomEvent(el, type, handler) {
    el.addEventListener(type, handler);
  }
  register(cb) {
    this._registered.push(cb);
  }
}

export class Plugin extends Component {
  constructor(app, manifest) {
    super();
    this.app = app;
    this.manifest = manifest;
    this._data = null;
  }
  addSettingTab(tab) {
    recorded.settingTabs.push(tab);
    this._settingTab = tab;
  }
  addRibbonIcon(icon, title, callback) {
    const el = document.createElement("div");
    recorded.ribbons.push({ icon, title, callback, el });
    return el;
  }
  addCommand(command) {
    recorded.commands.push(command);
    return command;
  }
  addStatusBarItem() {
    const el = document.createElement("div");
    document.body.appendChild(el);
    recorded.statusBarItems.push(el);
    return el;
  }
  async loadData() {
    return this._data;
  }
  async saveData(data) {
    // Round-trip through JSON exactly as Obsidian does, so anything
    // unserialisable (a Map, a class instance, undefined) surfaces here.
    this._data = JSON.parse(JSON.stringify(data));
  }
  onload() {}
  onunload() {}
}

export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement("div");
    document.body.appendChild(this.containerEl);
  }
  display() {}
  hide() {}
}

export class Modal {
  constructor(app) {
    this.app = app;
    this.containerEl = document.createElement("div");
    this.contentEl = document.createElement("div");
    this.containerEl.appendChild(this.contentEl);
    this.titleEl = document.createElement("div");
    this.isOpen = false;
  }
  open() {
    this.isOpen = true;
    document.body.appendChild(this.containerEl);
    const result = this.onOpen?.();
    // onOpen may be async; surface rejections rather than swallowing them.
    if (result && typeof result.then === "function") {
      this._opening = result;
    }
    return this;
  }
  close() {
    this.isOpen = false;
    this.onClose?.();
    this.containerEl.remove();
  }
  onOpen() {}
  onClose() {}
}

// --------------------------------------------------------- setting builders

class ValueComponent {
  constructor(el) {
    this.el = el;
    this._value = undefined;
    this.disabled = false;
    this._onChange = null;
  }
  setValue(value) {
    this._value = value;
    if (this.inputEl) this.inputEl.value = String(value);
    return this;
  }
  getValue() {
    return this._value;
  }
  onChange(cb) {
    this._onChange = cb;
    return this;
  }
  setDisabled(disabled) {
    this.disabled = disabled;
    return this;
  }
  setPlaceholder(text) {
    if (this.inputEl) this.inputEl.setAttribute("placeholder", text);
    return this;
  }
  /** Test helper: simulate the user changing this control. */
  async simulate(value) {
    this._value = value;
    if (this.inputEl) this.inputEl.value = String(value);
    if (this._onChange) await this._onChange(value);
    return this;
  }
}

class TextComponent extends ValueComponent {
  constructor(parent) {
    super(parent);
    this.inputEl = document.createElement("input");
    this.inputEl.type = "text";
    parent.appendChild(this.inputEl);
  }
}

class TextAreaComponent extends ValueComponent {
  constructor(parent) {
    super(parent);
    this.inputEl = document.createElement("textarea");
    parent.appendChild(this.inputEl);
  }
}

class ToggleComponent extends ValueComponent {
  constructor(parent) {
    super(parent);
    this.toggleEl = document.createElement("div");
    parent.appendChild(this.toggleEl);
  }
}

class SliderComponent extends ValueComponent {
  constructor(parent) {
    super(parent);
    this.sliderEl = document.createElement("input");
    this.sliderEl.type = "range";
    parent.appendChild(this.sliderEl);
    this.limits = null;
  }
  setLimits(min, max, step) {
    this.limits = { min, max, step };
    return this;
  }
  setDynamicTooltip() {
    return this;
  }
}

class ButtonComponent {
  constructor(parent) {
    this.buttonEl = document.createElement("button");
    parent.appendChild(this.buttonEl);
    this.disabled = false;
    this._onClick = null;
  }
  setButtonText(text) {
    this.buttonEl.textContent = text;
    this.text = text;
    return this;
  }
  setCta() {
    this.buttonEl.classList.add("mod-cta");
    return this;
  }
  setWarning() {
    this.buttonEl.classList.add("mod-warning");
    return this;
  }
  setIcon(icon) {
    this.icon = icon;
    return this;
  }
  setTooltip(tip) {
    this.tooltip = tip;
    return this;
  }
  setDisabled(disabled) {
    this.disabled = disabled;
    return this;
  }
  onClick(cb) {
    this._onClick = cb;
    this.buttonEl.addEventListener("click", () => void cb());
    return this;
  }
  /** Test helper: click it and await whatever the handler returns. */
  async click() {
    if (this._onClick) await this._onClick();
  }
}

export class Setting {
  constructor(containerEl) {
    this.settingEl = document.createElement("div");
    this.settingEl.className = "setting-item";
    this.infoEl = document.createElement("div");
    this.nameEl = document.createElement("div");
    this.descEl = document.createElement("div");
    this.controlEl = document.createElement("div");
    this.infoEl.append(this.nameEl, this.descEl);
    this.settingEl.append(this.infoEl, this.controlEl);
    containerEl.appendChild(this.settingEl);

    this.components = [];
    this.isHeading = false;
  }
  setName(name) {
    this.name = typeof name === "string" ? name : name?.textContent ?? "";
    this.nameEl.textContent = this.name;
    return this;
  }
  setDesc(desc) {
    if (typeof desc === "string") {
      this.desc = desc;
      this.descEl.textContent = desc;
    } else {
      // A DocumentFragment, as createFragment produces.
      this.descEl.textContent = "";
      this.descEl.appendChild(desc);
      this.desc = this.descEl.textContent;
    }
    return this;
  }
  setHeading() {
    this.isHeading = true;
    this.settingEl.classList.add("setting-item-heading");
    return this;
  }
  setClass(cls) {
    this.settingEl.classList.add(cls);
    return this;
  }
  setTooltip(tip) {
    this.tooltip = tip;
    return this;
  }
  addText(cb) {
    const c = new TextComponent(this.controlEl);
    this.components.push(c);
    cb(c);
    return this;
  }
  addTextArea(cb) {
    const c = new TextAreaComponent(this.controlEl);
    this.components.push(c);
    cb(c);
    return this;
  }
  addToggle(cb) {
    const c = new ToggleComponent(this.controlEl);
    this.components.push(c);
    cb(c);
    return this;
  }
  addSlider(cb) {
    const c = new SliderComponent(this.controlEl);
    this.components.push(c);
    cb(c);
    return this;
  }
  addButton(cb) {
    const c = new ButtonComponent(this.controlEl);
    this.components.push(c);
    cb(c);
    return this;
  }
  addExtraButton(cb) {
    return this.addButton(cb);
  }
  addDropdown(cb) {
    const c = new ValueComponent(this.controlEl);
    c.addOption = () => c;
    c.addOptions = () => c;
    this.components.push(c);
    cb(c);
    return this;
  }
}

// ----------------------------------------------------------------- the app

export class Workspace extends Events {
  constructor() {
    super();
    this._layoutReady = [];
  }
  onLayoutReady(cb) {
    this._layoutReady.push(cb);
  }
  /** Test helper: fire the layout-ready callbacks as Obsidian would. */
  triggerLayoutReady() {
    for (const cb of this._layoutReady) cb();
  }
  getActiveViewOfType() {
    return null;
  }
}

export class Vault extends Events {
  constructor(adapter) {
    super();
    this.adapter = adapter;
  }
  getName() {
    return "test-vault";
  }
}

export class App {
  constructor(adapter) {
    this.vault = new Vault(adapter);
    this.workspace = new Workspace();
    this.metadataCache = new Events();
  }
}

/** Release jsdom's timers and handles so node can exit cleanly. */
export function teardown() {
  try {
    window.close();
  } catch {
    /* already closed */
  }
}

// Types that only exist at compile time in the real module.
export const TAbstractFile = class {};
export const TFile = class extends TAbstractFile {};
export const TFolder = class extends TAbstractFile {};
export const FileSystemAdapter = class {};
export const MarkdownView = class {};
export const Component_ = Component;
