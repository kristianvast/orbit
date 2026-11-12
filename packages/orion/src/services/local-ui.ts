// A farm's own build of the Orbit UI. Orion builds it from an Orbit checkout (config.appSource or
// <data-dir>/app) and serves <checkout>/apps/orbit/dist under /app/<token>/. The shipped UI hands off
// to it at startup only while the marker says a checked build exists and the last hand-off booted.
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import type { LocalUiStatus } from "@orbit/protocol";
import { LocalOrion } from "./local-orion";

export const LOCAL_UI_PREFIX = "app";
const BUILD_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_TAIL = 4000;
const SOURCE_URL = "https://github.com/kristianvast/orbit.git";
/** The packages Orion runs from; a change in any of them means Orion itself changed. */
const ORION_PATHS = [
  "packages/orion",
  "packages/protocol",
  "packages/schema",
  "packages/connectors",
  "packages/sync",
];

interface Marker {
  enabled: boolean;
  builtAt: string | null;
  commit: string | null;
  launchedAt: string | null;
  bootedAt: string | null;
  /** Release the build's source sits on, e.g. "0.1.6"; absent in builds from before updates. */
  baseVersion?: string | null;
  syncError?: string | null;
  recoveryPath?: string | null;
}

const NO_MARKER: Marker = {
  enabled: false,
  builtAt: null,
  commit: null,
  launchedAt: null,
  bootedAt: null,
  baseVersion: null,
};

const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/;
/** Scratch branch an update is assembled on; the farm branch moves only when it is complete. */
const UPDATE_BRANCH = "orbit-update";

/** Compares release versions numerically: "0.1.10" is newer than "0.1.9". */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** One of the farm's own changes: a commit on the farm branch. */
export interface FarmChange {
  id: string;
  summary: string;
  files: string[];
}

export type UpdateResult =
  | {
      ok: true;
      from: string;
      to: string;
      /** The farm branch before the update, for restore(). */
      previous: string;
      carried: FarmChange[];
      alreadyIncluded: FarmChange[];
      leftOut: FarmChange[];
      dependencies: boolean;
    }
  | {
      ok: false;
      step: "checkout" | "current" | "version" | "fetch" | "clash" | "install" | "git";
      output: string;
      clash?: FarmChange;
    };

/**
 * Switches off a farm build made from an older Orbit than the installed one, before the shipped
 * Orion hands over to it, so updating without moving the farm's changes still gives the farmer the
 * new version. A build that does not say which release it sits on predates updates, so it is older.
 * Returns why it was switched off, or null when it stays.
 */
export function retireStaleFarmBuild(dataDir: string, installed: string): string | null {
  const file = join(dataDir, "local-ui.json");
  const ui: Marker | null = existsSync(file)
    ? { ...NO_MARKER, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<Marker>) }
    : null;
  const orion = new LocalOrion(dataDir, join(dataDir, "app"));
  if (!ui?.enabled && !orion.status().enabled) return null;
  const base = ui?.baseVersion ?? null;
  if (base && compareVersions(base, installed) >= 0) return null;
  const reason = `Orbit was updated to ${installed}, but the farm's own changes are on ${base ?? "an older version"}, so Orbit runs the original until they are moved over with orbit_update.`;
  if (ui) writeFileSync(file, `${JSON.stringify({ ...ui, enabled: false }, null, 2)}\n`);
  orion.disable(reason);
  return reason;
}

export type BuildStep =
  | "install"
  | "commit"
  | "typecheck"
  | "orion-typecheck"
  | "orion-start"
  | "build";

export type BuildResult =
  | {
      ok: true;
      status: LocalUiStatus;
      output: string;
      reloads: boolean;
      orion: "unchanged" | "updated";
    }
  | { ok: false; step: BuildStep | "checkout"; output: string; status: LocalUiStatus };

export type SourceResult =
  | { ok: true; created: boolean; path: string }
  | { ok: false; step: "git" | "clone" | "install"; output: string };

export interface LocalUiOptions {
  /** Installed Orbit version; its release tag is what the checkout starts from. */
  version?: string;
  sourceUrl?: string;
}

const NOT_STARTED = -1;

async function run(cmd: string[], cwd: string, signal?: AbortSignal, tail = OUTPUT_TAIL) {
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    // A compiled Orion binary acts as plain bun with BUN_BE_BUN=1; under bun itself it is ignored.
    proc = Bun.spawn(cmd, {
      cwd,
      env: { ...process.env, BUN_BE_BUN: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: BUILD_TIMEOUT_MS,
      windowsHide: true,
      signal,
    });
  } catch (error) {
    // Bun.spawn throws when the program is not on this computer (git on a bare Windows, say).
    return {
      code: NOT_STARTED,
      output: `${cmd[0]} could not be started: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: `${stdout}${stderr}`.slice(-tail) };
}

export class LocalUiService {
  onChanged: (() => void) | null = null;
  private readonly markerFile: string;
  readonly orion: LocalOrion;

  constructor(
    dataDir: string,
    readonly checkoutDir: string,
    private readonly token: string,
    private readonly onUpdated: (status: LocalUiStatus) => void,
    private readonly options: LocalUiOptions = {},
  ) {
    this.markerFile = join(dataDir, "local-ui.json");
    this.orion = new LocalOrion(dataDir, checkoutDir);
  }

  get distDir(): string {
    return join(this.checkoutDir, "apps", "orbit", "dist");
  }

  private read(): Marker {
    if (!existsSync(this.markerFile)) return { ...NO_MARKER };
    const raw = JSON.parse(readFileSync(this.markerFile, "utf8")) as Partial<Marker>;
    return { ...NO_MARKER, ...raw };
  }

  private write(marker: Marker): LocalUiStatus {
    writeFileSync(this.markerFile, `${JSON.stringify(marker, null, 2)}\n`);
    return this.status();
  }

  status(): LocalUiStatus {
    const m = this.read();
    const built = m.enabled && existsSync(join(this.distDir, "index.html"));
    const neverBooted = m.launchedAt !== null && (m.bootedAt === null || m.bootedAt < m.launchedAt);
    return {
      state: !built ? "none" : neverBooted ? "broken" : "ready",
      path: built ? `/${LOCAL_UI_PREFIX}/${encodeURIComponent(this.token)}/` : null,
      builtAt: m.builtAt,
      commit: m.commit,
      baseVersion: m.baseVersion ?? null,
      syncError: m.syncError ?? null,
      recoveryPath: m.recoveryPath ?? null,
    };
  }

  launched(): LocalUiStatus {
    return this.write({ ...this.read(), launchedAt: new Date().toISOString() });
  }

  booted(): LocalUiStatus {
    return this.write({ ...this.read(), bootedAt: new Date().toISOString() });
  }

  disable(): LocalUiStatus {
    if (this.orion.status().enabled) this.orion.disable();
    return this.write({ ...this.read(), enabled: false });
  }

  syncRecovery(reason: string | null, recoveryPath: string | null): void {
    const status = this.write({
      ...this.read(),
      ...(reason ? { enabled: false } : {}),
      syncError: reason,
      recoveryPath,
    });
    if (reason) this.orion.disable(`Farm app sync: ${reason}. Recovery: ${recoveryPath}`);
    this.onUpdated(status);
  }

  private hasCheckout(): boolean {
    return existsSync(join(this.checkoutDir, "apps", "orbit", "package.json"));
  }

  private async install(signal?: AbortSignal) {
    if (existsSync(join(this.checkoutDir, "node_modules"))) return null;
    return run([process.execPath, "install", "--frozen-lockfile"], this.checkoutDir, signal);
  }

  /** Downloads the installed version's source on its own `farm` branch and installs what it needs. */
  async source(signal?: AbortSignal): Promise<SourceResult> {
    let created = false;
    if (!this.hasCheckout()) {
      if (existsSync(this.checkoutDir) && readdirSync(this.checkoutDir).length > 0) {
        return {
          ok: false,
          step: "clone",
          output: `${this.checkoutDir} exists but does not hold Orbit's source.`,
        };
      }
      const tag = this.options.version ? ["--branch", `v${this.options.version}`] : [];
      const clone = await run(
        [
          "git",
          "clone",
          ...tag,
          "--depth",
          "50",
          this.options.sourceUrl ?? SOURCE_URL,
          this.checkoutDir,
        ],
        dirname(this.checkoutDir),
        signal,
      );
      if (clone.code !== 0) {
        return {
          ok: false,
          step: clone.code === NOT_STARTED ? "git" : "clone",
          output: clone.output,
        };
      }
      const branch = await run(["git", "switch", "-c", "farm"], this.checkoutDir, signal);
      if (branch.code !== 0) return { ok: false, step: "clone", output: branch.output };
      created = true;
    }
    const install = await this.install(signal);
    if (install && install.code !== 0)
      return { ok: false, step: "install", output: install.output };
    return { ok: true, created, path: this.checkoutDir };
  }

  /** Records the farm's edits on its branch. Null when there was nothing to record or it worked. */
  private async commit(summary: string, signal?: AbortSignal): Promise<string | null> {
    const dirty = await run(["git", "status", "--porcelain"], this.checkoutDir, signal);
    // Not a git checkout, or nothing changed since the last commit.
    if (dirty.code !== 0 || !dirty.output.trim()) return null;
    const add = await run(["git", "add", "-A"], this.checkoutDir, signal);
    if (add.code !== 0) return add.output;
    const commit = await run(
      [
        "git",
        "-c",
        "user.name=Orion",
        "-c",
        "user.email=orion@orbit.local",
        "commit",
        "--quiet",
        "-m",
        summary,
      ],
      this.checkoutDir,
      signal,
    );
    if (commit.code === 0) this.onChanged?.();
    return commit.code === 0 ? null : commit.output;
  }

  private async orionChanged(signal?: AbortSignal): Promise<boolean> {
    if (!this.options.version) return false;
    const diff = await run(
      ["git", "diff", "--quiet", `v${this.options.version}`, "--", ...ORION_PATHS],
      this.checkoutDir,
      signal,
    );
    // 0 = same as the release, 1 = differs. Anything else (no git, no such tag) cannot tell, and
    // the shipped Orion stays in use.
    return diff.code === 1;
  }

  /**
   * Checks and builds the farm's copy: the app always, and Orion too when its code differs from
   * the release. Nothing is switched on unless every step passed.
   */
  async build(signal?: AbortSignal, summary?: string): Promise<BuildResult> {
    const appDir = join(this.checkoutDir, "apps", "orbit");
    if (!this.hasCheckout()) {
      return {
        ok: false,
        step: "checkout",
        output: `No Orbit source at ${this.checkoutDir} yet. Run orbit_source first.`,
        status: this.status(),
      };
    }
    // Only the farm's own build reloads itself on a new build; the shipped app has to be switched.
    const before = this.read();
    const reloads = before.enabled && before.bootedAt !== null;
    const bun = process.execPath;
    const log: string[] = [];
    // Every failure below leaves the previous build untouched, so the markers stay as they were.
    const failed = (step: BuildStep, output: string): BuildResult => ({
      ok: false,
      step,
      output,
      status: this.status(),
    });
    const install = await this.install(signal);
    if (install) {
      log.push(install.output);
      if (install.code !== 0) return failed("install", install.output);
    }
    if (summary) {
      const commitError = await this.commit(summary, signal);
      if (commitError) return failed("commit", commitError);
    }
    const typecheck = await run([bun, "run", "typecheck"], appDir, signal);
    log.push(typecheck.output);
    if (typecheck.code !== 0) return failed("typecheck", typecheck.output);
    const orionChanged = await this.orionChanged(signal);
    if (orionChanged) {
      const orionDir = join(this.checkoutDir, "packages", "orion");
      const orionCheck = await run([bun, "run", "typecheck"], orionDir, signal);
      log.push(orionCheck.output);
      if (orionCheck.code !== 0) return failed("orion-typecheck", orionCheck.output);
      const smoke = await this.orion.smoke(signal);
      if (!smoke.ok) return failed("orion-start", smoke.output);
    }
    const build = await run([bun, "run", "build:local"], appDir, signal);
    log.push(build.output);
    if (build.code !== 0) {
      // vite empties dist before writing, so the old build may be gone: turn the local UI off.
      const status = this.write({ ...this.read(), enabled: false });
      return { ok: false, step: "build", output: build.output, status };
    }
    const head = await run(["git", "rev-parse", "HEAD"], this.checkoutDir).catch(() => null);
    const commit = head && head.code === 0 ? head.output.trim() : null;
    if (orionChanged) this.orion.enable(commit);
    // Also clears a reason left from an earlier switch-off, which no longer applies.
    else this.orion.disable();
    const status = this.write({
      enabled: true,
      builtAt: new Date().toISOString(),
      commit,
      launchedAt: null,
      bootedAt: null,
      baseVersion: await this.baseVersion(),
    });
    this.onUpdated(status);
    this.onChanged?.();
    return {
      ok: true,
      status,
      output: log.join("\n").slice(-OUTPUT_TAIL),
      reloads,
      orion: orionChanged ? "updated" : "unchanged",
    };
  }

  private git(args: string[], signal?: AbortSignal) {
    return run(
      ["git", "-c", "user.name=Orion", "-c", "user.email=orion@orbit.local", ...args],
      this.checkoutDir,
      signal,
      Number.POSITIVE_INFINITY,
    );
  }

  /** The release the farm branch sits on: its nearest release tag. */
  async baseVersion(signal?: AbortSignal): Promise<string | null> {
    const r = await this.git(["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"], signal);
    return r.code === 0 ? (RELEASE_TAG.exec(r.output.trim())?.[1] ?? null) : null;
  }

  private async newestVersion(signal?: AbortSignal): Promise<string | null> {
    const r = await this.git(["ls-remote", "--tags", "--refs", "origin", "v*"], signal);
    if (r.code !== 0) return null;
    const versions = r.output
      .split("\n")
      .map((line) => RELEASE_TAG.exec(line.split("refs/tags/")[1]?.trim() ?? "")?.[1])
      .filter((v): v is string => v !== undefined);
    return versions.sort((a, b) => compareVersions(b, a))[0] ?? null;
  }

  private async farmChanges(range: string, signal?: AbortSignal): Promise<FarmChange[] | null> {
    const r = await this.git(
      ["log", "--reverse", "--no-merges", "--format=%x00%H%x09%s", "--name-only", range],
      signal,
    );
    if (r.code !== 0) return null;
    return r.output
      .split("\0")
      .filter((chunk) => chunk.trim())
      .map((chunk) => {
        const [head = "", ...files] = chunk.split("\n");
        const [id = "", ...summary] = head.split("\t");
        return { id, summary: summary.join("\t"), files: files.filter((f) => f.trim()) };
      });
  }

  private async lockChanged(from: string, to: string): Promise<boolean> {
    return (await this.git(["diff", "--quiet", from, to, "--", "bun.lock"])).code !== 0;
  }

  /**
   * Moves the farm's changes onto a newer release: fetches its tag, applies the farm's commits on
   * top in order on a scratch branch, and moves the farm branch there only when every one applied.
   * A change that clashes stops it with the farm branch untouched. It neither builds nor switches
   * anything on: build() does that, and restore() undoes the move if the build fails.
   */
  async update(
    opts: { version?: string; leaveOut?: string[]; receivedCommit?: string } = {},
    signal?: AbortSignal,
  ): Promise<UpdateResult> {
    if (!this.hasCheckout()) {
      return {
        ok: false,
        step: "checkout",
        output: `No Orbit source at ${this.checkoutDir} yet. Run orbit_source first.`,
      };
    }
    const from = await this.baseVersion(signal);
    if (!from)
      return { ok: false, step: "version", output: "The source has no release tag to start from." };
    const to = opts.receivedCommit
      ? (this.options.version ?? from)
      : opts.version?.trim().replace(/^v/, "") || (await this.newestVersion(signal));
    if (!to)
      return {
        ok: false,
        step: "fetch",
        output: "Could not read the released versions; is the internet up?",
      };
    if (!RELEASE_TAG.test(`v${to}`))
      return { ok: false, step: "version", output: `${to} is not a release version.` };
    if (!opts.receivedCommit && compareVersions(to, from) <= 0) {
      return {
        ok: false,
        step: "current",
        output: `The farm's Orbit is on ${from}, which is not older than ${to}.`,
      };
    }
    const pending = await this.commit("Changes not built yet", signal);
    if (pending) return { ok: false, step: "git", output: pending };
    const fetched = opts.receivedCommit
      ? { code: 0, output: "" }
      : await this.git(["fetch", "--quiet", "origin", `refs/tags/v${to}:refs/tags/v${to}`], signal);
    if (fetched.code !== 0) return { ok: false, step: "fetch", output: fetched.output };
    const previous = (await this.git(["rev-parse", "HEAD"])).output.trim();
    const changes = opts.receivedCommit
      ? await this.farmChanges(`${opts.receivedCommit}^..${opts.receivedCommit}`, signal)
      : await this.farmChanges(`v${from}..HEAD`, signal);
    if (!changes)
      return {
        ok: false,
        step: "git",
        output: `Could not list the farm's changes since v${from}.`,
      };
    // Cleanup after a stop must finish even when the request was aborted, so it takes no signal.
    const backToFarm = async () => {
      await this.git(["checkout", "--quiet", "--force", "farm"]);
      await this.git(["branch", "--quiet", "-D", UPDATE_BRANCH]);
    };
    const start = await this.git(["checkout", "--quiet", "-B", UPDATE_BRANCH, `v${to}`], signal);
    if (start.code !== 0) {
      await backToFarm();
      return { ok: false, step: "git", output: start.output };
    }
    const leftOut = changes.filter((c) =>
      (opts.leaveOut ?? []).some((id) => id.length >= 4 && c.id.startsWith(id)),
    );
    const carried: FarmChange[] = [];
    const alreadyIncluded: FarmChange[] = [];
    for (const change of changes) {
      if (leftOut.includes(change)) continue;
      const pick = await this.git(["cherry-pick", change.id], signal);
      if (pick.code === 0) {
        carried.push(change);
        continue;
      }
      const picking =
        (await this.git(["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"])).code === 0;
      const unmerged = (await this.git(["diff", "--name-only", "--diff-filter=U"])).output.trim();
      if (picking && !unmerged) {
        // Nothing left to apply: the new release already contains this change.
        await this.git(["cherry-pick", "--skip"]);
        alreadyIncluded.push(change);
        continue;
      }
      if (picking) await this.git(["cherry-pick", "--abort"]);
      await backToFarm();
      return unmerged
        ? {
            ok: false,
            step: "clash",
            output: pick.output,
            clash: { ...change, files: unmerged.split("\n") },
          }
        : { ok: false, step: "git", output: pick.output };
    }
    const dependencies = await this.lockChanged(previous, "HEAD");
    const moved = await this.git(["checkout", "--quiet", "-B", "farm"]);
    await this.git(["branch", "--quiet", "-D", UPDATE_BRANCH]);
    if (moved.code !== 0) {
      await backToFarm();
      return { ok: false, step: "git", output: moved.output };
    }
    if (dependencies) {
      const install = await run(
        [process.execPath, "install", "--frozen-lockfile"],
        this.checkoutDir,
        signal,
      );
      if (install.code !== 0) {
        await this.restore(previous);
        return { ok: false, step: "install", output: install.output };
      }
    }
    return { ok: true, from, to, previous, carried, alreadyIncluded, leftOut, dependencies };
  }

  /** Puts the farm branch back where it was before an update, with what that version installs. */
  async restore(previous: string): Promise<string | null> {
    const dependencies = await this.lockChanged(previous, "HEAD");
    const back = await this.git(["checkout", "--quiet", "--force", "-B", "farm", previous]);
    if (back.code !== 0) return back.output;
    if (!dependencies) return null;
    const install = await run([process.execPath, "install", "--frozen-lockfile"], this.checkoutDir);
    return install.code === 0 ? null : install.output;
  }

  /**
   * Maps a request path below /app/<token>/ to a file in dist. Paths that escape dist (after
   * symlinks) are refused; extension-less paths fall back to the SPA entry.
   */
  resolve(rel: string): { kind: "file"; path: string } | { kind: "index" } | null {
    if (!existsSync(this.distDir)) return null;
    if (rel === "" || rel === "index.html") return { kind: "index" };
    const candidate = join(this.distDir, rel);
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      const realDist = realpathSync(this.distDir);
      return realpathSync(candidate).startsWith(realDist + sep)
        ? { kind: "file", path: candidate }
        : null;
    }
    const last = rel.split("/").at(-1) ?? "";
    return last.includes(".") ? null : { kind: "index" };
  }

  /** The SPA entry with a <base> so relative assets resolve at any route depth. */
  indexHtml(): string {
    const html = readFileSync(join(this.distDir, "index.html"), "utf8");
    const tag = `<base href="/${LOCAL_UI_PREFIX}/${encodeURIComponent(this.token)}/">`;
    return html.includes("<head>") ? html.replace("<head>", `<head>\n    ${tag}`) : tag + html;
  }
}
