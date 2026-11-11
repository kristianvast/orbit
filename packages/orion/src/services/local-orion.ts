// The farm's own build of Orion. Orion is not compiled again: the shipped binary is also a Bun
// runtime, so it starts <checkout>/packages/orion/src/main.ts in its own place while the marker says a
// checked build exists. A build that does not start, or that crashes, switches the marker off, and
// the shipped Orion runs again from the next start.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READY_LINE_PREFIX } from "@orbit/protocol";

const CHILD_ENV = "ORION_LOCAL_CHILD";
const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;
const OUTPUT_TAIL = 4000;

interface Marker {
  enabled: boolean;
  builtAt: string | null;
  commit: string | null;
  lastError: string | null;
}

const NO_MARKER: Marker = { enabled: false, builtAt: null, commit: null, lastError: null };

function childEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  // A compiled Orion binary acts as plain bun with BUN_BE_BUN=1; under bun itself it is ignored.
  return { ...process.env, BUN_BE_BUN: "1", [CHILD_ENV]: "1", ...extra };
}

function wait(ms: number): { done: Promise<"timeout">; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return { done, cancel: () => clearTimeout(timer) };
}

export class LocalOrion {
  private readonly markerFile: string;

  constructor(
    dataDir: string,
    readonly checkoutDir: string,
  ) {
    this.markerFile = join(dataDir, "local-orion.json");
  }

  get entry(): string {
    return join(this.checkoutDir, "packages", "orion", "src", "main.ts");
  }

  status(): Marker {
    if (!existsSync(this.markerFile)) return { ...NO_MARKER };
    return { ...NO_MARKER, ...(JSON.parse(readFileSync(this.markerFile, "utf8")) as object) };
  }

  shouldStart(): boolean {
    return !process.env[CHILD_ENV] && this.status().enabled && existsSync(this.entry);
  }

  private write(marker: Marker) {
    writeFileSync(this.markerFile, `${JSON.stringify(marker, null, 2)}\n`);
  }

  enable(commit: string | null) {
    this.write({ enabled: true, builtAt: new Date().toISOString(), commit, lastError: null });
  }

  disable(lastError: string | null = null) {
    this.write({ ...this.status(), enabled: false, lastError });
  }

  /**
   * Starts the checkout's Orion on a throwaway data folder and waits until it reports ready, so a
   * build that cannot start is never switched on.
   */
  async smoke(signal?: AbortSignal): Promise<{ ok: true } | { ok: false; output: string }> {
    const dataDir = mkdtempSync(join(tmpdir(), "orion-smoke-"));
    const proc = Bun.spawn(
      [
        process.execPath,
        this.entry,
        "--port",
        "0",
        "--token",
        "smoke",
        "--data-dir",
        dataDir,
        "--mock-model",
        "--parent-watch",
      ],
      {
        cwd: this.checkoutDir,
        env: childEnv({ ORION_SECRETS: "file" }),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        ...(signal ? { signal } : {}),
      },
    );
    let out = "";
    let ready: () => void = () => {};
    const becameReady = new Promise<"ready">((resolve) => {
      ready = () => resolve("ready");
    });
    const collect = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        out += decoder.decode(chunk, { stream: true });
        if (out.includes(READY_LINE_PREFIX)) ready();
      }
    };
    const reading = Promise.all([collect(proc.stdout), collect(proc.stderr)]);
    const startLimit = wait(START_TIMEOUT_MS);
    const outcome = await Promise.race([becameReady, proc.exited, startLimit.done]);
    startLimit.cancel();
    // Closing stdin asks for the clean shutdown that also stops the camera relay it started.
    proc.stdin.end();
    const stopLimit = wait(STOP_TIMEOUT_MS);
    if ((await Promise.race([proc.exited, stopLimit.done])) === "timeout") proc.kill();
    stopLimit.cancel();
    await proc.exited;
    await reading;
    rmSync(dataDir, { recursive: true, force: true });
    if (outcome === "ready") return { ok: true };
    const why =
      outcome === "timeout"
        ? `It did not report ready within ${START_TIMEOUT_MS / 1000} seconds.`
        : `It stopped with exit code ${outcome}.`;
    return { ok: false, output: `${why}\n${out.slice(-OUTPUT_TAIL)}`.trim() };
  }

  /**
   * Runs the farm's build in this process's place and never returns while it works: this process
   * only passes its output on and exits with its exit code. Returns when the build never became
   * ready, so the caller can start the shipped Orion instead.
   */
  async supervise(argv: string[]): Promise<void> {
    const child = Bun.spawn([process.execPath, this.entry, ...argv], {
      cwd: this.checkoutDir,
      env: childEnv(),
      // The desktop shell's pipes go straight through, so its stdin watch and its kill still work.
      stdin: "inherit",
      stdout: "pipe",
      stderr: "inherit",
      windowsHide: true,
    });
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
    let ready = false;
    let seen = "";
    const forwarding = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stdout) {
        process.stdout.write(chunk);
        if (ready) continue;
        seen = (seen + decoder.decode(chunk, { stream: true })).slice(-OUTPUT_TAIL);
        ready = seen.includes(READY_LINE_PREFIX);
      }
    })();
    const startLimit = wait(START_TIMEOUT_MS);
    void startLimit.done.then(() => {
      if (!ready) child.kill();
    });
    const code = await child.exited;
    startLimit.cancel();
    await forwarding;
    if (!ready) {
      this.disable(`It did not start (exit code ${code}).`);
      process.stderr.write(
        "orion: the farm's own build of Orion did not start; using the original\n",
      );
      return;
    }
    if (code !== 0) this.disable(`It stopped with exit code ${code}.`);
    process.exit(code);
  }
}
