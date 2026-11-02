import { Notice, Platform, Plugin, type TAbstractFile } from "obsidian";
import { AuthManager, guessDeviceName } from "./auth";
import { DropboxClient } from "./dropbox";
import { PathFilter } from "./paths";
import { SyncSettingTab } from "./settings";
import {
  DEFAULT_SETTINGS,
  emptySnapshot,
  hydrate,
  type PluginSettings,
  type SyncSnapshot,
} from "./state";
import { SyncEngine, type Progress, type SyncReport } from "./sync";
import { debounce, errorMessage, randomId } from "./util";

export default class DropboxSyncPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  snapshot: SyncSnapshot = emptySnapshot(randomId(8));

  auth!: AuthManager;
  dropbox!: DropboxClient;

  private statusBar: HTMLElement | null = null;
  private running = false;
  /** Set when changes land mid-sync, so we immediately sync again afterwards. */
  private rerunRequested = false;
  private engine: SyncEngine | null = null;
  private changeTrigger = debounce(() => void this.sync("auto"), 10_000);
  private intervalId: number | null = null;
  private startupTimeoutId: number | null = null;

  async onload(): Promise<void> {
    await this.loadState();

    this.auth = new AuthManager(
      () => ({
        appKey: this.settings.appKey,
        refreshToken: this.settings.refreshToken,
        accessToken: this.settings.accessToken,
        accessTokenExpiresAt: this.settings.accessTokenExpiresAt,
      }),
      async (update) => {
        await this.updateSettings(update);
      },
    );
    this.dropbox = new DropboxClient(this.auth, (message) => this.log(message));

    this.addSettingTab(new SyncSettingTab(this.app, this));

    // Status bar does not render on mobile; Notices carry the feedback there.
    if (!Platform.isMobile) {
      this.statusBar = this.addStatusBarItem();
      this.setStatus("idle");
    }

    this.addRibbonIcon("refresh-cw", "Sync vault with Dropbox", () => {
      void this.sync("manual");
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.sync("manual"),
    });

    this.addCommand({
      id: "cancel-sync",
      name: "Cancel the running sync",
      checkCallback: (checking) => {
        if (checking) return this.running;
        this.engine?.cancel();
        new Notice("Stopping after the current transfers finish.");
        return true;
      },
    });

    this.registerVaultEvents();
    this.rescheduleWatchers();

    if (this.settings.syncOnStartup && this.auth.isAuthenticated) {
      // Wait for the vault to finish indexing; syncing during startup churn
      // produces a lot of spurious change events.
      this.app.workspace.onLayoutReady(() => {
        // Tracked so a plugin disabled within this window doesn't leave a timer
        // that fires against a torn-down instance.
        this.startupTimeoutId = window.setTimeout(() => {
          this.startupTimeoutId = null;
          void this.sync("startup");
        }, 4000);
      });
    }
  }

  onunload(): void {
    this.changeTrigger.cancel();
    this.engine?.cancel();
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    if (this.startupTimeoutId !== null) window.clearTimeout(this.startupTimeoutId);
  }

  // ------------------------------------------------------------- persistence

  private async loadState(): Promise<void> {
    const { settings, snapshot } = hydrate(await this.loadData(), randomId(8));
    this.settings = settings;
    this.snapshot = snapshot;

    if (!this.settings.deviceName) {
      this.settings.deviceName = guessDeviceName(Platform.isMobile);
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    await this.saveData({ settings: this.settings, snapshot: this.snapshot });
  }

  async updateSettings(patch: Partial<PluginSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    await this.persist();
  }

  async resetSnapshot(): Promise<void> {
    this.snapshot = emptySnapshot(this.snapshot.deviceId);
    await this.persist();
  }

  // ---------------------------------------------------------------- watchers

  /**
   * Registered exactly once, in onload. The handler reads current settings each
   * time it fires, so changing the schedule never needs to re-register — which
   * would silently stack duplicate listeners.
   */
  private registerVaultEvents(): void {
    const onChange = (file: TAbstractFile) => {
      if (!this.settings.autoSyncOnChange) return;
      if (this.running) {
        // Our own downloads fire these events. Rather than trying to tell them
        // apart from real edits, note that something moved and re-check once
        // the current pass is done.
        this.rerunRequested = true;
        return;
      }
      this.log(`change: ${file.path}`);
      this.changeTrigger.call();
    };

    this.registerEvent(this.app.vault.on("create", onChange));
    this.registerEvent(this.app.vault.on("modify", onChange));
    this.registerEvent(this.app.vault.on("delete", onChange));
    this.registerEvent(this.app.vault.on("rename", onChange));
  }

  /** Re-arm the debounce and interval timer after a settings change. */
  rescheduleWatchers(): void {
    this.changeTrigger.cancel();
    this.changeTrigger = debounce(
      () => void this.sync("auto"),
      this.settings.changeDebounceSeconds * 1000,
    );

    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (this.settings.intervalMinutes > 0) {
      this.intervalId = window.setInterval(
        () => void this.sync("interval"),
        this.settings.intervalMinutes * 60 * 1000,
      );
      this.registerInterval(this.intervalId);
    }
  }

  // -------------------------------------------------------------------- sync

  async sync(trigger: "manual" | "auto" | "startup" | "interval"): Promise<void> {
    if (this.running) {
      this.rerunRequested = true;
      if (trigger === "manual") new Notice("A sync is already running.");
      return;
    }

    if (!this.auth.isAuthenticated) {
      if (trigger === "manual") {
        new Notice("Connect to Dropbox in the plugin settings first.");
      }
      return;
    }

    this.running = true;
    this.rerunRequested = false;
    this.setStatus("syncing");

    const startNotice =
      trigger === "manual" ? new Notice("Syncing with Dropbox...", 0) : null;

    try {
      this.engine = new SyncEngine({
        vault: this.app.vault,
        client: this.dropbox,
        snapshot: this.snapshot,
        filter: new PathFilter({
          patterns: this.settings.exclusions,
          syncConfigFolder: this.settings.syncConfigFolder,
          maxFileSize: this.settings.maxFileSize,
        }),
        remoteRoot: this.settings.remoteFolder,
        deviceName: this.settings.deviceName,
        concurrency: this.settings.concurrency,
        saveSnapshot: () => this.persist(),
        onProgress: (progress) => this.onProgress(progress),
        log: (message) => this.log(message),
      });

      const report = await this.engine.run();
      startNotice?.hide();
      this.announce(report, trigger);
      this.setStatus("idle", report);
    } catch (err) {
      startNotice?.hide();
      this.setStatus("error");
      // Always surface failures: a sync tool that fails quietly is worse than
      // no sync tool, because you stop checking.
      new Notice(`Dropbox sync failed: ${errorMessage(err)}`, 10000);
      this.log(`sync failed: ${errorMessage(err)}`);
      // Keep whatever progress the engine did make.
      await this.persist();
    } finally {
      this.engine = null;
      this.running = false;
    }

    if (this.rerunRequested) {
      this.rerunRequested = false;
      this.changeTrigger.call();
    }
  }

  private announce(report: SyncReport, trigger: string): void {
    const parts: string[] = [];
    if (report.uploaded) parts.push(`${report.uploaded} up`);
    if (report.downloaded) parts.push(`${report.downloaded} down`);
    if (report.deletedRemote) parts.push(`${report.deletedRemote} deleted remotely`);
    if (report.deletedLocal) parts.push(`${report.deletedLocal} deleted locally`);

    // Conflicts and errors always get a notice; a clean no-op run only speaks
    // up when the user asked for it by hand.
    if (report.conflicts.length > 0) {
      new Notice(
        `Dropbox sync kept both versions of ${report.conflicts.length} file(s):\n` +
          report.conflicts.slice(0, 5).join("\n"),
        15000,
      );
    }

    if (report.errors.length > 0) {
      new Notice(
        `Dropbox sync finished with ${report.errors.length} error(s):\n` +
          report.errors.slice(0, 3).join("\n"),
        15000,
      );
      for (const error of report.errors) this.log(`error: ${error}`);
    }

    if (report.skipped.length > 0) {
      this.log(`skipped ${report.skipped.length}: ${report.skipped.join(", ")}`);
    }

    if (parts.length > 0) {
      new Notice(`Dropbox sync: ${parts.join(", ")}.`);
    } else if (trigger === "manual" && report.errors.length === 0) {
      new Notice("Dropbox sync: already up to date.");
    }
  }

  private onProgress(progress: Progress): void {
    if (progress.phase === "transferring") {
      this.setStatusText(`Dropbox: ${progress.done}/${progress.total}`);
    } else if (progress.phase === "scanning") {
      this.setStatusText("Dropbox: scanning vault");
    } else if (progress.phase === "listing") {
      this.setStatusText("Dropbox: listing remote");
    }
  }

  private setStatus(state: "idle" | "syncing" | "error", report?: SyncReport): void {
    if (state === "syncing") return this.setStatusText("Dropbox: syncing");
    if (state === "error") return this.setStatusText("Dropbox: error");

    const when = this.snapshot.lastSyncAt
      ? new Date(this.snapshot.lastSyncAt).toLocaleTimeString()
      : "never";
    const suffix = report && report.errors.length > 0 ? " (errors)" : "";
    this.setStatusText(`Dropbox: ${when}${suffix}`);
  }

  private setStatusText(text: string): void {
    this.statusBar?.setText(text);
  }

  private log(message: string): void {
    if (this.settings.verboseLogging) console.log(`[dropbox-sync] ${message}`);
  }
}
