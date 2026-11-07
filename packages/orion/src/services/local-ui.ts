// A farm's own build of the Orbit UI. Orion builds it from an Orbit checkout (config.appSource or
// <data-dir>/app) and serves <checkout>/apps/orbit/dist under /app/<token>/. The shipped UI hands off
// to it at startup only while the marker says a checked build exists and the last hand-off booted.
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { LocalUiStatus } from "@orbit/protocol";

export const LOCAL_UI_PREFIX = "app";
const BUILD_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_TAIL = 4000;

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

export type BuildStep = "install" | "typecheck" | "build";

export type BuildResult =
  | { ok: true; status: LocalUiStatus; output: string }
  | { ok: false; step: BuildStep | "checkout"; output: string; status: LocalUiStatus };

async function run(cmd: string[], cwd: string, signal?: AbortSignal) {
  // A compiled Orion binary acts as plain bun with BUN_BE_BUN=1; under bun itself it is ignored.
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, BUN_BE_BUN: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: BUILD_TIMEOUT_MS,
    signal,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, output: `${stdout}${stderr}`.slice(-OUTPUT_TAIL) };
}

export class LocalUiService {
  private readonly markerFile: string;

  constructor(
    dataDir: string,
    readonly checkoutDir: string,
    private readonly token: string,
    private readonly onUpdated: (status: LocalUiStatus) => void,
  ) {
    this.markerFile = join(dataDir, "local-ui.json");
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
    return this.write({ ...this.read(), enabled: false });
  }

  async build(signal?: AbortSignal): Promise<BuildResult> {
    const appDir = join(this.checkoutDir, "apps", "orbit");
    if (!existsSync(join(appDir, "package.json"))) {
      return {
        ok: false,
        step: "checkout",
        output: `No Orbit checkout at ${this.checkoutDir} (missing apps/orbit/package.json).`,
        status: this.status(),
      };
    }
    const bun = process.execPath;
    const log: string[] = [];
    if (!existsSync(join(this.checkoutDir, "node_modules"))) {
      const install = await run([bun, "install", "--frozen-lockfile"], this.checkoutDir, signal);
      log.push(install.output);
      if (install.code !== 0)
        return { ok: false, step: "install", output: install.output, status: this.status() };
    }
    const typecheck = await run([bun, "run", "typecheck"], appDir, signal);
    log.push(typecheck.output);
    // A failed typecheck leaves the previous build untouched, so the marker stays as it was.
    if (typecheck.code !== 0)
      return { ok: false, step: "typecheck", output: typecheck.output, status: this.status() };
    const build = await run([bun, "run", "build:local"], appDir, signal);
    log.push(build.output);
    if (build.code !== 0) {
      // vite empties dist before writing, so the old build may be gone: turn the local UI off.
      const status = this.write({ ...this.read(), enabled: false });
      return { ok: false, step: "build", output: build.output, status };
    }
    const head = await run(["git", "rev-parse", "HEAD"], this.checkoutDir).catch(() => null);
    const status = this.write({
      enabled: true,
      builtAt: new Date().toISOString(),
      commit: head && head.code === 0 ? head.output.trim() : null,
      launchedAt: null,
      bootedAt: null,
    });
    this.onUpdated(status);
    return { ok: true, status, output: log.join("\n").slice(-OUTPUT_TAIL) };
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
