import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type FarmCodeBlobs,
  FarmCodeHead,
  type FarmCodeManifest,
  farmCodeHashes,
} from "@orbit/protocol";
import { canWriteTable } from "@orbit/schema";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { WORKSPACE_AGENTS, type Workspace } from "../agent/workspace";
import type { Repository } from "../db/repo";
import { AccountError, type AccountService } from "./account";
import { AppCode } from "./farm-code-app";
import { codeEqual, codeHash, collectCode, mergeCodeFiles, writeCode } from "./farm-code-files";
import type { LocalUiService } from "./local-ui";

interface SyncBase {
  head: FarmCodeHead | null;
  /** The receiving release's ported delta, to detect new local edits without bouncing bases. */
  appLocal: FarmCodeManifest["app"];
}
interface Options {
  dataDir: string;
  /** The open farm's folder: its sync base belongs with the workspace it describes. */
  stateDir: string;
  workspace: Workspace;
  repo: Repository;
  account: AccountService;
  localUi: LocalUiService;
  busy(): boolean;
  changed(files: string[]): void;
}
const HeadResponse = Type.Object({ head: Type.Union([FarmCodeHead, Type.Null()]) });

/** One serialized reconciliation per install. Remote heads are the persistent three-way base. */
export class FarmCodeSync {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private dirty = false;
  private active = false;
  private readonly app: AppCode;
  readonly noteFile: string;
  constructor(private readonly opts: Options) {
    this.app = new AppCode(opts.dataDir, opts.localUi);
    this.noteFile = join(opts.stateDir, "farm-code", "notice.txt");
  }
  notice(): string | null {
    return existsSync(this.noteFile) ? readFileSync(this.noteFile, "utf8") : null;
  }
  async start(): Promise<void> {
    this.active = true;
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.sync();
      }, 30_000);
      this.timer.unref();
    }
    await this.sync();
  }
  async stop(): Promise<void> {
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
  async settled(): Promise<void> {
    await this.running;
  }
  /** Resolves after a pass that started after this call, so the caller's changes are included. */
  sync(): Promise<void> {
    this.dirty = true;
    if (this.running) return this.running;
    if (!this.active || this.opts.busy()) return Promise.resolve();
    this.running = (async () => {
      while (this.dirty && this.active) {
        this.dirty = false;
        try {
          await this.reconcile();
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          this.note(`Farm code sync needs attention: ${error.message}`);
        }
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private note(text: string): void {
    mkdirSync(join(this.opts.stateDir, "farm-code"), { recursive: true });
    writeFileSync(this.noteFile, text);
    this.opts.changed([]);
  }
  private async reconcile(): Promise<void> {
    const { account, workspace, repo } = this.opts;
    const status = account.status();
    if (status.state !== "signed_in" || !status.farm) return;
    const farmId = status.farm.id;
    const root = join(this.opts.stateDir, "farm-code", farmId);
    mkdirSync(root, { recursive: true });
    const stateFile = join(root, "base.json");
    const saved: SyncBase = existsSync(stateFile)
      ? JSON.parse(readFileSync(stateFile, "utf8"))
      : { head: null, appLocal: null };
    const response = await account.request("GET", "/v1/farm-code/head");
    if (!Value.Check(HeadResponse, response))
      throw new AccountError("internal", "Invalid farm code head.");
    const remote = response.head;
    const local = collectCode(workspace.dir);
    const exported = await this.app.collect();
    const appLocal = codeEqual(exported.delta, saved.appLocal)
      ? (saved.head?.manifest.app ?? null)
      : exported.delta;
    const blobs: FarmCodeBlobs = { ...local.blobs, ...exported.blobs };
    const needed = remote
      ? farmCodeHashes(remote.manifest).filter((hash) => blobs[hash] === undefined)
      : [];
    if (needed.length) {
      const fetched = await account.request("POST", "/v1/farm-code/blobs/fetch", {
        hashes: needed,
      });
      const schema = Type.Object({ blobs: Type.Record(Type.String(), Type.String()) });
      if (!Value.Check(schema, fetched))
        throw new AccountError("internal", "Invalid farm code blobs.");
      Object.assign(blobs, fetched.blobs);
      for (const hash of needed)
        if (blobs[hash] === undefined || codeHash(Buffer.from(blobs[hash], "base64")) !== hash)
          throw new AccountError("internal", "Missing or corrupt farm code blob.");
    }
    if (!this.active || this.opts.busy() || account.status().farm?.id !== farmId) return;
    const conflicts: string[] = [];
    const baseWorkspace = saved.head?.manifest.workspace ?? {
      "AGENTS.md": codeHash(Buffer.from(WORKSPACE_AGENTS)),
    };
    const incoming = remote?.manifest.workspace ?? {};
    const merged = remote
      ? mergeCodeFiles(baseWorkspace, local.files, incoming, (p) => conflicts.push(p))
      : local.files;
    // Compare local app edits to the locally ported baseline, remote edits to the cloud baseline.
    // Release changes alone must not count as farm edits on this machine.
    const appFiles = remote
      ? mergeCodeFiles(
          saved.head?.manifest.app?.files ?? {},
          Object.fromEntries(
            [
              ...new Set([
                ...Object.keys(saved.head?.manifest.app?.files ?? {}),
                ...Object.keys(exported.delta?.files ?? {}),
                ...Object.keys(saved.appLocal?.files ?? {}),
              ]),
            ].flatMap((path) => {
              const unchanged = codeEqual(exported.delta?.files[path], saved.appLocal?.files[path]);
              const value = unchanged
                ? saved.head?.manifest.app?.files[path]
                : exported.delta?.files[path];
              return value === undefined ? [] : [[path, value]];
            }),
          ),
          remote.manifest.app?.files ?? {},
          (p) => conflicts.push(`app/${p}`),
        )
      : (appLocal?.files ?? {});
    const appDelta = Object.keys(appFiles).length
      ? {
          baseCommit: appLocal?.baseCommit ?? remote?.manifest.app?.baseCommit ?? "",
          files: appFiles,
        }
      : null;
    if (conflicts.length) {
      const recovery = join(root, "conflicts", remote?.id ?? "local");
      mkdirSync(recovery, { recursive: true });
      writeFileSync(
        join(recovery, "versions.json"),
        JSON.stringify(
          {
            base: saved.head,
            local: { workspace: local.files, app: appLocal },
            remote,
            blobs,
          },
          null,
          2,
        ),
      );
      this.note(
        `Farm code conflicts in ${conflicts.join(", ")}. Local edits were kept; other versions are recoverable at ${recovery}. Tell the farmer before resolving them.`,
      );
    }
    // Snapshot dirty local files first, so undoing the pull cannot undo unsaved local work.
    const before = await workspace.snapshot("Local changes before farm code sync");
    if (before)
      repo.recordWorkspaceSnapshot({
        ...before,
        sessionId: null,
        description: "Local changes before farm code sync",
      });
    // An editor outside Orion may have changed files while HTTP or Git was in flight. Keep the
    // old base and reconcile again rather than overwriting a version we did not compare.
    if (!codeEqual(collectCode(workspace.dir).files, local.files)) {
      this.dirty = true;
      return;
    }
    for (const path of new Set([...Object.keys(local.files), ...Object.keys(merged)])) {
      if (local.files[path] === merged[path]) continue;
      const hash = merged[path];
      writeCode(workspace.dir, path, hash ? Buffer.from(blobs[hash] ?? "", "base64") : null);
    }
    const snap = await workspace.snapshot("Farm code synchronized");
    if (snap) {
      repo.recordWorkspaceSnapshot({
        ...snap,
        sessionId: null,
        description: "Farm code synchronized",
      });
      this.opts.changed(snap.files);
    }
    if (!codeEqual(appDelta, appLocal)) {
      await this.app.receive(appDelta, blobs);
      const appError = this.opts.localUi.status().syncError;
      if (appError)
        this.note(
          `Farm app sync failed: ${appError}. Recovery: ${this.opts.localUi.status().recoveryPath}. The shipped UI is in use; tell the farmer.`,
        );
    }
    const afterApp = await this.app.collect();
    Object.assign(blobs, afterApp.blobs);
    const manifest: FarmCodeManifest = {
      workspace: merged,
      // A locally edited app is published against this install's release after the port, so all
      // base versions describe the sender's real release. A pure pull keeps the received delta.
      app:
        !codeEqual(exported.delta, saved.appLocal) && !this.opts.localUi.status().syncError
          ? afterApp.delta
          : appDelta,
    };
    let head = remote;
    if (!codeEqual(manifest, remote?.manifest) && canWriteTable(status.farm.role, "connectors")) {
      // Only referenced, missing blobs cross the wire; identical content never creates a commit.
      const known = new Set(remote ? farmCodeHashes(remote.manifest) : []);
      const upload = Object.fromEntries(
        farmCodeHashes(manifest)
          .filter((h) => !known.has(h))
          .map((h) => [h, blobs[h]]),
      );
      try {
        const pushed = await account.request("POST", "/v1/farm-code/commits", {
          parent: remote?.id ?? null,
          manifest,
          blobs: upload,
        });
        if (!Value.Check(HeadResponse, pushed))
          throw new AccountError("internal", "Invalid code push response.");
        head = pushed.head;
      } catch (error) {
        // Keep the old base on a CAS race; the next reconciliation merges the new head.
        if (!(error instanceof AccountError) || error.code !== "conflict") throw error;
        return;
      }
    }
    writeFileSync(stateFile, JSON.stringify({ head, appLocal: afterApp.delta } satisfies SyncBase));
  }
}
