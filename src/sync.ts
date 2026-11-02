/**
 * The sync engine.
 *
 * One pass is: scan local -> list remote -> diff all three views (local, remote,
 * last-synced snapshot) -> execute a plan -> persist the new snapshot.
 *
 * The snapshot is what makes this sync rather than mirroring. For any path we
 * know three things, and the *pair* of changes tells us the direction:
 *
 *   local changed?  remote changed?   action
 *   ---------------------------------------------------------
 *   no              no                nothing
 *   yes             no                upload
 *   no              yes               download
 *   yes             yes               conflict (keep both)
 *
 * Deletions are the same table with "gone" as a kind of change, and they are
 * where naive sync tools lose data: a file missing locally means "deleted here"
 * only because a snapshot record proves we once had it. Without that record,
 * missing-locally is indistinguishable from never-downloaded, and the tool
 * cheerfully deletes your vault off the server.
 */

import type { DataAdapter, Vault } from "obsidian";
import { DropboxError, type DropboxClient, type RemoteFile } from "./dropbox";
import {
  conflictPath,
  listRootArg,
  parentFolders,
  PathFilter,
  toRemotePath,
  toVaultPath,
  vaultKey,
} from "./paths";
import type { FileRecord, SyncSnapshot } from "./state";
import { conflictStamp, errorMessage, formatBytes, pool } from "./util";

export interface LocalFile {
  path: string;
  mtime: number;
  size: number;
}

export type Operation =
  | { kind: "upload"; path: string; local: LocalFile; expectedRev?: string }
  | { kind: "download"; path: string; remote: RemoteFile }
  | { kind: "delete-local"; path: string }
  | { kind: "delete-remote"; path: string }
  | { kind: "conflict"; path: string; local: LocalFile; remote: RemoteFile }
  | { kind: "adopt"; path: string; local: LocalFile; remote: RemoteFile }
  | { kind: "forget"; path: string };

export interface SyncReport {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: string[];
  skipped: string[];
  errors: string[];
  durationMs: number;
}

export interface Progress {
  phase: "scanning" | "listing" | "planning" | "transferring" | "done";
  done: number;
  total: number;
  label?: string;
}

export interface EngineDeps {
  vault: Vault;
  client: DropboxClient;
  snapshot: SyncSnapshot;
  filter: PathFilter;
  remoteRoot: string;
  deviceName: string;
  concurrency: number;
  saveSnapshot: () => Promise<void>;
  onProgress?: (progress: Progress) => void;
  log: (message: string) => void;
}

export class SyncEngine {
  private readonly adapter: DataAdapter;
  private cancelled = false;

  constructor(private readonly deps: EngineDeps) {
    this.adapter = deps.vault.adapter;
  }

  cancel(): void {
    this.cancelled = true;
  }

  async run(): Promise<SyncReport> {
    const startedAt = Date.now();
    const report: SyncReport = {
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      conflicts: [],
      skipped: [],
      errors: [],
      durationMs: 0,
    };

    this.report({ phase: "scanning", done: 0, total: 0 });
    const local = await this.scanLocal(report);

    this.report({ phase: "listing", done: 0, total: 0 });
    const listing = await this.deps.client.listFolder(listRootArg(this.deps.remoteRoot));
    const remote = this.indexRemote(listing.files, report);

    this.report({ phase: "planning", done: 0, total: 0 });
    const plan = this.plan(local, remote);
    this.deps.log(`plan: ${describePlan(plan)}`);

    await this.execute(plan, report);

    this.deps.snapshot.lastSyncAt = Date.now();
    await this.deps.saveSnapshot();

    report.durationMs = Date.now() - startedAt;
    this.report({ phase: "done", done: 1, total: 1 });
    return report;
  }

  // ---------------------------------------------------------------- scanning

  /** Walk the vault with the DataAdapter, which works on desktop and mobile. */
  private async scanLocal(report: SyncReport): Promise<Map<string, LocalFile>> {
    const found = new Map<string, LocalFile>();
    const queue: string[] = [""];

    while (queue.length > 0) {
      const folder = queue.pop() as string;
      let entries: { files: string[]; folders: string[] };
      try {
        entries = await this.adapter.list(folder);
      } catch (err) {
        report.errors.push(`list ${folder || "/"}: ${errorMessage(err)}`);
        continue;
      }

      for (const sub of entries.folders) {
        // Pruning here (rather than filtering files later) means we never even
        // descend into .obsidian or .trash when they're excluded.
        if (!this.deps.filter.excludes(sub)) queue.push(sub);
      }

      for (const file of entries.files) {
        if (this.deps.filter.excludes(file)) continue;

        const stat = await this.adapter.stat(file);
        if (!stat || stat.type !== "file") continue;

        if (this.deps.filter.exceedsSizeLimit(stat.size)) {
          report.skipped.push(`${file} (${formatBytes(stat.size)}, over size limit)`);
          continue;
        }

        // Normalize here too, so an NFD filename on iOS keys identically to the
        // NFC form Dropbox reports for the same file.
        const key = vaultKey(file);
        if (!key) continue;
        found.set(key.toLowerCase(), { path: key, mtime: stat.mtime, size: stat.size });
      }
    }

    this.deps.log(`local scan: ${found.size} files`);
    return found;
  }

  private indexRemote(files: RemoteFile[], report: SyncReport): Map<string, RemoteFile> {
    const indexed = new Map<string, RemoteFile>();

    for (const file of files) {
      const vaultPath = toVaultPath(file.path, this.deps.remoteRoot);
      if (!vaultPath) continue;
      if (this.deps.filter.excludes(vaultPath)) continue;

      if (this.deps.filter.exceedsSizeLimit(file.size)) {
        report.skipped.push(`${vaultPath} (${formatBytes(file.size)}, over size limit)`);
        continue;
      }

      indexed.set(vaultPath.toLowerCase(), file);
    }

    return indexed;
  }

  // ---------------------------------------------------------------- planning

  private plan(
    local: Map<string, LocalFile>,
    remote: Map<string, RemoteFile>,
  ): Operation[] {
    const records = this.deps.snapshot.records;
    const keys = new Set([
      ...local.keys(),
      ...remote.keys(),
      ...Object.keys(records),
    ]);

    const operations: Operation[] = [];

    for (const key of keys) {
      const l = local.get(key);
      const r = remote.get(key);
      const s = records[key] as FileRecord | undefined;
      const path = l?.path ?? toVaultPath(r?.path ?? "", this.deps.remoteRoot) ?? s?.path;
      if (!path) continue;

      // --- No prior record: this path is new to us on at least one side.
      if (!s) {
        if (l && !r) operations.push({ kind: "upload", path, local: l });
        else if (!l && r) operations.push({ kind: "download", path, remote: r });
        else if (l && r) {
          // Both sides have it with no shared history — the classic "I installed
          // the plugin on a second device that already had the vault" case.
          // Same size is a strong hint they're identical, but only comparing
          // bytes proves it, so defer the decision to execution time.
          operations.push({ kind: "adopt", path, local: l, remote: r });
        }
        continue;
      }

      // --- Both sides deleted it. Nothing to do but forget it.
      if (!l && !r) {
        operations.push({ kind: "forget", path });
        continue;
      }

      // --- Deleted locally.
      if (!l && r) {
        if (r.rev !== s.rev) {
          // Someone else edited it after our delete. Their edit is newer
          // information than our deletion, so bring it back.
          operations.push({ kind: "download", path, remote: r });
        } else {
          operations.push({ kind: "delete-remote", path });
        }
        continue;
      }

      // --- Deleted remotely.
      if (l && !r) {
        if (l.mtime !== s.mtime || l.size !== s.size) {
          operations.push({ kind: "upload", path, local: l });
        } else {
          operations.push({ kind: "delete-local", path });
        }
        continue;
      }

      // --- Present on both sides: the main table.
      if (!l || !r) continue;
      const localChanged = l.mtime !== s.mtime || l.size !== s.size;
      const remoteChanged = r.rev !== s.rev;

      if (localChanged && remoteChanged) {
        operations.push({ kind: "conflict", path, local: l, remote: r });
      } else if (localChanged) {
        operations.push({ kind: "upload", path, local: l, expectedRev: s.rev });
      } else if (remoteChanged) {
        operations.push({ kind: "download", path, remote: r });
      }
    }

    return operations;
  }

  // --------------------------------------------------------------- execution

  private async execute(operations: Operation[], report: SyncReport): Promise<void> {
    if (operations.length === 0) return;

    let completed = 0;
    const total = operations.length;

    const tasks = operations.map((operation) => async () => {
      if (this.cancelled) return;
      try {
        await this.apply(operation, report);
      } catch (err) {
        report.errors.push(`${operation.kind} ${operation.path}: ${errorMessage(err)}`);
        this.deps.log(`FAILED ${operation.kind} ${operation.path}: ${errorMessage(err)}`);
      } finally {
        completed++;
        this.report({
          phase: "transferring",
          done: completed,
          total,
          label: operation.path,
        });
      }
    });

    await pool(this.deps.concurrency, tasks);
  }

  private async apply(operation: Operation, report: SyncReport): Promise<void> {
    switch (operation.kind) {
      case "upload":
        await this.doUpload(operation.path, operation.local, operation.expectedRev, report);
        return;

      case "download":
        await this.doDownload(operation.path, operation.remote);
        report.downloaded++;
        return;

      case "delete-local":
        await this.deleteLocal(operation.path);
        delete this.deps.snapshot.records[operation.path.toLowerCase()];
        report.deletedLocal++;
        return;

      case "delete-remote":
        await this.deps.client.deletePath(
          toRemotePath(operation.path, this.deps.remoteRoot),
        );
        delete this.deps.snapshot.records[operation.path.toLowerCase()];
        report.deletedRemote++;
        return;

      case "adopt":
        await this.doAdopt(operation.path, operation.local, operation.remote, report);
        return;

      case "conflict":
        await this.doConflict(operation.path, operation.local, operation.remote, report);
        return;

      case "forget":
        delete this.deps.snapshot.records[operation.path.toLowerCase()];
        return;
    }
  }

  private async doUpload(
    path: string,
    local: LocalFile,
    expectedRev: string | undefined,
    report: SyncReport,
  ): Promise<void> {
    const data = await this.adapter.readBinary(path);
    const remotePath = toRemotePath(path, this.deps.remoteRoot);

    let meta: RemoteFile;
    try {
      meta = await this.deps.client.upload(remotePath, data, expectedRev);
    } catch (err) {
      if (err instanceof DropboxError && err.isUploadConflict) {
        // The remote moved between our listing and our upload. Rather than
        // clobbering it, re-read the remote and run the conflict path.
        this.deps.log(`late conflict on ${path}; preserving both versions`);
        const { meta: fresh } = await this.deps.client.download(remotePath);
        await this.doConflict(path, local, fresh, report);
        return;
      }
      throw err;
    }

    // Re-stat: the read didn't change mtime, but recording the value we
    // actually observed keeps the snapshot honest if anything touched the file.
    const stat = await this.adapter.stat(path);
    this.deps.snapshot.records[path.toLowerCase()] = {
      path,
      mtime: stat?.mtime ?? local.mtime,
      size: stat?.size ?? local.size,
      rev: meta.rev,
    };
    report.uploaded++;
  }

  private async doDownload(path: string, remote: RemoteFile): Promise<void> {
    const { data, meta } = await this.deps.client.download(
      toRemotePath(path, this.deps.remoteRoot),
    );

    await this.ensureParentFolders(path);
    await this.adapter.writeBinary(path, data);

    // Critical: writing the file gives it a brand-new mtime. Record *that*
    // value, or the very next scan will see a local change and upload it back.
    const stat = await this.adapter.stat(path);
    this.deps.snapshot.records[path.toLowerCase()] = {
      path,
      mtime: stat?.mtime ?? Date.now(),
      size: stat?.size ?? data.byteLength,
      rev: meta.rev || remote.rev,
    };
  }

  /**
   * A path present on both sides with no shared history. Compare bytes: if they
   * already match, just record the pairing silently. Only genuinely divergent
   * content becomes a conflict.
   */
  private async doAdopt(
    path: string,
    local: LocalFile,
    remote: RemoteFile,
    report: SyncReport,
  ): Promise<void> {
    if (local.size === remote.size) {
      const [localData, { data: remoteData, meta }] = await Promise.all([
        this.adapter.readBinary(path),
        this.deps.client.download(toRemotePath(path, this.deps.remoteRoot)),
      ]);

      if (sameBytes(localData, remoteData)) {
        this.deps.snapshot.records[path.toLowerCase()] = {
          path,
          mtime: local.mtime,
          size: local.size,
          rev: meta.rev || remote.rev,
        };
        return;
      }
    }

    await this.doConflict(path, local, remote, report);
  }

  /**
   * Keep both versions, always.
   *
   * Local content stays at the canonical path and is pushed to Dropbox; the
   * remote version is written beside it as a clearly-named copy, then uploaded
   * too, so every device ends up holding both and you can resolve the
   * difference wherever you happen to be. No silent last-write-wins, because
   * the cost of being wrong is a lost note.
   */
  private async doConflict(
    path: string,
    local: LocalFile,
    remote: RemoteFile,
    report: SyncReport,
  ): Promise<void> {
    const remotePath = toRemotePath(path, this.deps.remoteRoot);
    const { data: remoteData } = await this.deps.client.download(remotePath);

    const copyPath = conflictPath(path, conflictStamp(), this.deps.deviceName);
    await this.ensureParentFolders(copyPath);
    await this.adapter.writeBinary(copyPath, remoteData);

    // Push the conflict copy so other devices see it on their next sync.
    const copyMeta = await this.deps.client.upload(
      toRemotePath(copyPath, this.deps.remoteRoot),
      remoteData,
    );
    const copyStat = await this.adapter.stat(copyPath);
    this.deps.snapshot.records[copyPath.toLowerCase()] = {
      path: copyPath,
      mtime: copyStat?.mtime ?? Date.now(),
      size: copyStat?.size ?? remoteData.byteLength,
      rev: copyMeta.rev,
    };

    // Force the local version into the canonical path, overriding the rev check
    // we already know would fail.
    const localData = await this.adapter.readBinary(path);
    const meta = await this.deps.client.upload(remotePath, localData);
    const stat = await this.adapter.stat(path);
    this.deps.snapshot.records[path.toLowerCase()] = {
      path,
      mtime: stat?.mtime ?? local.mtime,
      size: stat?.size ?? local.size,
      rev: meta.rev,
    };

    report.conflicts.push(copyPath);
    report.uploaded += 2;
  }

  private async ensureParentFolders(path: string): Promise<void> {
    for (const folder of parentFolders(path)) {
      if (await this.adapter.exists(folder)) continue;
      try {
        await this.adapter.mkdir(folder);
      } catch {
        // Another worker in the pool may have created it between the check and
        // the call; a failure here surfaces on the write anyway.
      }
    }
  }

  /**
   * Prefer the vault's local trash over an outright delete. Sync bugs are
   * inevitable; recoverable ones are survivable.
   */
  private async deleteLocal(path: string): Promise<void> {
    try {
      await this.adapter.trashLocal(path);
    } catch {
      await this.adapter.remove(path);
    }
  }

  private report(progress: Progress): void {
    this.deps.onProgress?.(progress);
  }
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) return false;
  }
  return true;
}

function describePlan(operations: Operation[]): string {
  const counts = new Map<string, number>();
  for (const operation of operations) {
    counts.set(operation.kind, (counts.get(operation.kind) ?? 0) + 1);
  }
  if (counts.size === 0) return "nothing to do";
  return [...counts.entries()].map(([kind, n]) => `${n} ${kind}`).join(", ");
}
