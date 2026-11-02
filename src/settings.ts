/** Settings tab and the connect-to-Dropbox modal. */

import { App, Modal, Notice, PluginSettingTab, Setting, type TextComponent } from "obsidian";
import { PkceFlow, REQUIRED_SCOPES } from "./auth";
import type DropboxSyncPlugin from "./main";
import { errorMessage, formatBytes } from "./util";

export class SyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: DropboxSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderConnection(containerEl);
    this.renderScope(containerEl);
    this.renderSchedule(containerEl);
    this.renderAdvanced(containerEl);
    this.renderMaintenance(containerEl);
  }

  // ------------------------------------------------------------- connection

  private renderConnection(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Dropbox connection").setHeading();

    const connected = this.plugin.auth.isAuthenticated;
    const status = new Setting(containerEl)
      .setName("Status")
      .setDesc(connected ? "Connected." : "Not connected.");

    if (connected) {
      status.addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          button.setDisabled(true);
          try {
            const name = await this.plugin.dropbox.currentAccountName();
            status.setDesc(`Connected as ${name}.`);
            new Notice(`Dropbox: connected as ${name}.`);
          } catch (err) {
            status.setDesc(`Connection failed: ${errorMessage(err)}`);
            new Notice(`Dropbox test failed: ${errorMessage(err)}`);
          } finally {
            button.setDisabled(false);
          }
        }),
      );
      status.addButton((button) =>
        button
          .setButtonText("Disconnect")
          .setWarning()
          .onClick(async () => {
            await this.plugin.updateSettings({
              refreshToken: "",
              accessToken: "",
              accessTokenExpiresAt: 0,
            });
            new Notice("Disconnected from Dropbox. Local files were not touched.");
            this.display();
          }),
      );
    }

    new Setting(containerEl)
      .setName("App key")
      .setDesc(
        createFragment((frag) => {
          frag.appendText("From your own Dropbox app at ");
          frag.createEl("a", {
            text: "dropbox.com/developers/apps",
            href: "https://www.dropbox.com/developers/apps",
          });
          frag.appendText(
            ". Create a Scoped App with App folder access, enable the scopes listed in the README, then paste the app key here. This is not a secret.",
          );
        }),
      )
      .addText((text) =>
        text
          .setPlaceholder("abc123def456xyz")
          .setValue(this.plugin.settings.appKey)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ appKey: value.trim() });
          }),
      );

    if (!connected) {
      new Setting(containerEl)
        .setName("Connect")
        .setDesc("Authorise this vault to use your Dropbox app folder.")
        .addButton((button) =>
          button
            .setButtonText("Connect to Dropbox")
            .setCta()
            .onClick(() => {
              if (!this.plugin.settings.appKey) {
                new Notice("Enter your Dropbox app key first.");
                return;
              }
              new ConnectModal(this.app, this.plugin, () => this.display()).open();
            }),
        );
    }
  }

  // ------------------------------------------------------------------ scope

  private renderScope(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("What gets synced").setHeading();

    new Setting(containerEl)
      .setName("Remote subfolder")
      .setDesc(
        "Folder inside your Dropbox app folder. Leave empty to use its root. Every device sharing a vault must use the same value.",
      )
      .addText((text) =>
        text
          .setPlaceholder("(app folder root)")
          .setValue(this.plugin.settings.remoteFolder)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ remoteFolder: value.trim() });
          }),
      );

    new Setting(containerEl)
      .setName("Sync the .obsidian config folder")
      .setDesc(
        "Shares themes, hotkeys and plugin settings between devices. Workspace layout is always excluded. Leave this off unless you want it: plugin binaries differ between desktop and mobile, so syncing config can break plugins on one platform.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncConfigFolder)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ syncConfigFolder: value });
          }),
      );

    new Setting(containerEl)
      .setName("Exclusions")
      .setDesc(
        "One pattern per line, matched like a .gitignore. A pattern without a slash matches anywhere in the vault (*.tmp also catches Notes/draft.tmp); a pattern with a slash is anchored to the vault root. Trailing / means a whole folder. Example: Attachments/, *.excalidraw, Private/**",
      )
      .addTextArea((area) => {
        area
          .setPlaceholder("Attachments/\n*.tmp")
          .setValue(this.plugin.settings.exclusions.join("\n"))
          .onChange(async (value) => {
            await this.plugin.updateSettings({
              exclusions: value
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0),
            });
          });
        area.inputEl.rows = 5;
        area.inputEl.addClass("dropbox-sync-textarea");
      });

    new Setting(containerEl)
      .setName("Maximum file size")
      .setDesc(
        `Files larger than this are skipped and reported. Dropbox's single-request upload limit is ${formatBytes(150 * 1024 * 1024)}; chunked upload is not implemented yet.`,
      )
      .addText((text) =>
        text
          .setValue(String(Math.round(this.plugin.settings.maxFileSize / (1024 * 1024))))
          .onChange(async (value) => {
            const mb = Number(value);
            if (!Number.isFinite(mb) || mb < 0) return;
            await this.plugin.updateSettings({
              maxFileSize: Math.min(mb, 150) * 1024 * 1024,
            });
          })
          .inputEl.setAttribute("type", "number"),
      );
  }

  // --------------------------------------------------------------- schedule

  private renderSchedule(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("When to sync").setHeading();

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Run one sync shortly after the vault opens.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
          await this.plugin.updateSettings({ syncOnStartup: value });
        }),
      );

    new Setting(containerEl)
      .setName("Sync after edits")
      .setDesc("Run a sync once editing goes quiet.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoSyncOnChange)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ autoSyncOnChange: value });
            this.plugin.rescheduleWatchers();
            this.display();
          }),
      );

    if (this.plugin.settings.autoSyncOnChange) {
      new Setting(containerEl)
        .setName("Quiet period")
        .setDesc("Seconds of no edits before an automatic sync starts.")
        .addSlider((slider) =>
          slider
            .setLimits(2, 120, 1)
            .setValue(this.plugin.settings.changeDebounceSeconds)
            .setDynamicTooltip()
            .onChange(async (value) => {
              await this.plugin.updateSettings({ changeDebounceSeconds: value });
              this.plugin.rescheduleWatchers();
            }),
        );
    }

    new Setting(containerEl)
      .setName("Periodic sync")
      .setDesc("Minutes between background syncs. Set to 0 to disable.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 120, 5)
          .setValue(this.plugin.settings.intervalMinutes)
          .setDynamicTooltip()
          .onChange(async (value) => {
            await this.plugin.updateSettings({ intervalMinutes: value });
            this.plugin.rescheduleWatchers();
          }),
      );
  }

  // --------------------------------------------------------------- advanced

  private renderAdvanced(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Advanced").setHeading();

    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Used in conflict filenames, so you can tell which device wrote what.")
      .addText((text) =>
        text
          .setPlaceholder("laptop")
          .setValue(this.plugin.settings.deviceName)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ deviceName: value.trim() });
          }),
      );

    new Setting(containerEl)
      .setName("Parallel transfers")
      .setDesc("Higher is faster until Dropbox starts rate-limiting. 4 is a good default.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 12, 1)
          .setValue(this.plugin.settings.concurrency)
          .setDynamicTooltip()
          .onChange(async (value) => {
            await this.plugin.updateSettings({ concurrency: value });
          }),
      );

    new Setting(containerEl)
      .setName("Verbose logging")
      .setDesc("Write detailed sync decisions to the developer console.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.verboseLogging).onChange(async (value) => {
          await this.plugin.updateSettings({ verboseLogging: value });
        }),
      );
  }

  // ------------------------------------------------------------ maintenance

  private renderMaintenance(containerEl: HTMLElement): void {
    new Setting(containerEl).setName("Maintenance").setHeading();

    const records = Object.keys(this.plugin.snapshot.records).length;
    const lastSync = this.plugin.snapshot.lastSyncAt
      ? new Date(this.plugin.snapshot.lastSyncAt).toLocaleString()
      : "never";

    new Setting(containerEl)
      .setName("Sync state")
      .setDesc(`Tracking ${records} files. Last sync: ${lastSync}.`)
      .addButton((button) =>
        button
          .setButtonText("Reset state")
          .setWarning()
          .onClick(async () => {
            await this.plugin.resetSnapshot();
            new Notice(
              "Sync state cleared. The next sync treats every file as new and compares content before flagging conflicts.",
            );
            this.display();
          }),
      );

    containerEl.createEl("p", {
      text: "Resetting deletes no files. It only forgets what this device believed was already in sync, which is the right move after restoring a backup or changing the remote subfolder.",
      cls: "setting-item-description",
    });
  }
}

/**
 * Walks through the PKCE flow. Dropbox shows the user a code to paste back,
 * which avoids any redirect handling and so behaves identically on mobile.
 */
class ConnectModal extends Modal {
  private flow: PkceFlow | null = null;
  private codeInput: TextComponent | null = null;

  constructor(
    app: App,
    private readonly plugin: DropboxSyncPlugin,
    private readonly onDone: () => void,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Connect to Dropbox" });

    this.flow = await PkceFlow.begin(this.plugin.settings.appKey);
    const url = this.flow.authorizeUrl();

    contentEl.createEl("p", {
      text: "Step 1 — open the authorisation page and approve access. Dropbox will show you a code.",
    });

    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText("Open Dropbox authorisation")
        .setCta()
        .onClick(() => window.open(url, "_blank")),
    );

    const details = contentEl.createEl("details");
    details.createEl("summary", { text: "Or copy the link manually" });
    details.createEl("code", { text: url, cls: "dropbox-sync-url" });

    contentEl.createEl("p", { text: "Step 2 — paste the code here." });

    new Setting(contentEl).setName("Authorisation code").addText((text) => {
      this.codeInput = text;
      text.setPlaceholder("paste the code from Dropbox");
      text.inputEl.addClass("dropbox-sync-wide-input");
    });

    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText("Finish")
        .setCta()
        .onClick(() => void this.finish(button.setDisabled.bind(button))),
    );

    contentEl.createEl("p", {
      text: `Scopes requested: ${REQUIRED_SCOPES}`,
      cls: "setting-item-description",
    });
  }

  private async finish(setDisabled: (value: boolean) => void): Promise<void> {
    const code = this.codeInput?.getValue().trim();
    if (!this.flow || !code) {
      new Notice("Paste the authorisation code first.");
      return;
    }

    setDisabled(true);
    try {
      const token = await this.flow.exchange(code);
      if (!token.refresh_token) {
        // Without offline access the connection would die in four hours; better
        // to fail loudly now than mysteriously later.
        throw new Error(
          "Dropbox did not return a refresh token. Make sure the app key belongs to a Scoped App and try again.",
        );
      }

      await this.plugin.updateSettings({
        refreshToken: token.refresh_token,
        accessToken: token.access_token,
        accessTokenExpiresAt: Date.now() + token.expires_in * 1000,
      });

      const name = await this.plugin.dropbox.currentAccountName();
      new Notice(`Connected to Dropbox as ${name}.`);
      this.close();
      this.onDone();
    } catch (err) {
      new Notice(`Could not connect: ${errorMessage(err)}`, 10000);
      setDisabled(false);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
