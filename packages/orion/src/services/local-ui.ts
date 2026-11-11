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
}

const NO_MARKER: Marker = {
  enabled: false,
  builtAt: null,
  commit: null,
  launchedAt: null,
  bootedAt: null,
};

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

async function run(cmd: string[], cwd: string, signal?: AbortSignal) {
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
  return { code, output: `${stdout}${stderr}`.slice(-OUTPUT_TAIL) };
}

export class LocalUiService {
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
    else if (this.orion.status().enabled) this.orion.disable();
    const status = this.write({
      enabled: true,
      builtAt: new Date().toISOString(),
      commit,
      launchedAt: null,
      bootedAt: null,
    });
    this.onUpdated(status);
    return {
      ok: true,
      status,
      output: log.join("\n").slice(-OUTPUT_TAIL),
      reloads,
      orion: orionChanged ? "updated" : "unchanged",
    };
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
