import { accessSync, constants } from "node:fs";
import { dirname, join } from "node:path";
import type { CameraRelayStatus } from "@orbit/protocol";
import type { Subprocess } from "bun";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Repository } from "../db/repo";
import type { SecretStore } from "../secrets";

/** Search only executable files, in the same order in development and packaged Orion. */
export function resolveRelayBinary(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  execPath = process.execPath,
): string | null {
  const name = process.platform === "win32" ? "go2rtc.exe" : "go2rtc";
  const candidates = [
    env.ORION_GO2RTC_BIN,
    join(dirname(execPath), name),
    join(dataDir, "bin", name),
    Bun.which(name, { PATH: env.PATH ?? "" }),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  }
  return null;
}

const Credentials = Type.Object({ username: Type.String(), password: Type.String() });

/** Owns one optional go2rtc process. Its config has no streams or file path. */
export class Go2rtcRelay {
  private child: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  private state: CameraRelayStatus = { available: false, reason: "go2rtc has not started" };
  private baseUrl = "";
  private readonly streams = new Map<string, string>();
  private readonly logs: string[] = [];
  private pending = Promise.resolve();
  private readonly lifetime = new AbortController();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly repo: Repository,
    private readonly secrets: SecretStore,
    private readonly dataDir: string,
  ) {}

  status(): CameraRelayStatus {
    return { ...this.state };
  }

  /** Only registered camera ids may reach go2rtc, whose `src` also accepts arbitrary sources. */
  has(cameraId: string): boolean {
    return this.streams.has(cameraId);
  }

  url(cameraId: string, endpoint: "frame.jpeg" | "ws"): URL {
    const url = new URL(`/api/${endpoint}`, this.baseUrl);
    url.searchParams.set("src", cameraId);
    if (endpoint === "ws") url.protocol = "ws:";
    return url;
  }

  async start(): Promise<void> {
    const binary = resolveRelayBinary(this.dataDir);
    if (!binary) {
      this.state = { available: false, reason: "go2rtc binary not found" };
      return;
    }
    // Reserve an OS-selected loopback port, then release it for the child to bind.
    const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = reservation.port;
    reservation.stop(true);
    this.baseUrl = `http://127.0.0.1:${port}`;
    const config = JSON.stringify({
      api: { listen: `127.0.0.1:${port}` },
      rtsp: { listen: "" },
      webrtc: { listen: "" },
      srtp: { listen: "" },
      log: { level: "warn", output: "stdout" },
    });
    try {
      const child = Bun.spawn([binary, "-config", config], {
        env: process.env,
        cwd: this.dataDir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      this.child = child;
      void this.capture(child.stdout);
      void this.capture(child.stderr);
      void child.exited.then((code) => {
        this.state = { available: false, reason: `go2rtc exited (${code})` };
        this.lifetime.abort();
      });
      const deadline = Date.now() + 5000;
      let ready = false;
      while (Date.now() < deadline && child.exitCode === null) {
        try {
          const response = await fetch(`${this.baseUrl}/api`, {
            signal: AbortSignal.timeout(300),
          });
          ready = response.ok;
          await response.body?.cancel();
          if (ready) break;
        } catch (error) {
          if (!(error instanceof Error)) throw error;
        }
        await Bun.sleep(50);
      }
      if (!ready || child.exitCode !== null) {
        this.state = { available: false, reason: "go2rtc startup failed" };
        child.kill();
        await child.exited;
        return;
      }
      this.state = { available: true, reason: null };
      await this.sync();
      this.unsubscribe = this.repo.onChange((table) => {
        if (table === "cameras") void this.sync();
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.state = { available: false, reason: "go2rtc startup failed" };
      if (this.child) {
        this.child.kill();
        await this.child.exited;
      }
    }
  }

  /** Serializing reconciliations prevents an older credential update winning a race. */
  sync(): Promise<void> {
    this.pending = this.pending.then(async () => {
      if (!this.state.available) return;
      try {
        const desired = new Map<string, string>();
        for (const camera of this.repo.query("cameras.list", {}).rows) {
          if (!camera.rtspUrl) continue;
          const url = new URL(camera.rtspUrl);
          if (url.protocol !== "rtsp:" && url.protocol !== "rtsps:") continue;
          if (camera.credentialRef) {
            const secret = await this.secrets.get(camera.credentialRef);
            if (secret) {
              const credentials: unknown = JSON.parse(secret);
              if (!Value.Check(Credentials, credentials))
                throw new TypeError("invalid credentials");
              url.username = encodeURIComponent(credentials.username);
              url.password = encodeURIComponent(credentials.password);
            }
          }
          desired.set(camera.id, url.href);
        }
        for (const [id, src] of desired) {
          if (this.streams.get(id) === src) continue;
          await this.updateStream("PUT", new URLSearchParams({ name: id, src }));
          this.streams.set(id, src);
        }
        for (const id of this.streams.keys()) {
          if (desired.has(id)) continue;
          await this.updateStream("DELETE", new URLSearchParams({ src: id }));
          this.streams.delete(id);
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        this.state = { available: false, reason: "go2rtc stream synchronization failed" };
      }
    });
    return this.pending;
  }

  private async updateStream(method: "PUT" | "DELETE", params: URLSearchParams) {
    const response = await fetch(`${this.baseUrl}/api/streams?${params}`, {
      method,
      signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(3000)]),
    });
    const body = await response.text();
    // go2rtc applies the in-memory change before attempting persistence. With inline-only
    // configuration, the pinned release explicitly reports that persistence is disabled.
    if (!response.ok && !(response.status === 400 && body.trim() === "config file disabled")) {
      throw new TypeError(`go2rtc stream API returned ${response.status}`);
    }
  }

  private async capture(stream: ReadableStream<Uint8Array>) {
    try {
      for await (const chunk of stream) {
        // Keep diagnostics bounded and in memory; upstream errors may contain camera URLs.
        this.logs.push(new TextDecoder().decode(chunk).slice(-2048));
        if (this.logs.length > 8) this.logs.shift();
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.lifetime.abort();
    this.state = { available: false, reason: "go2rtc stopped" };
    if (this.child) {
      this.child.kill();
      await this.child.exited;
    }
    await this.pending;
    this.streams.clear();
    this.logs.length = 0;
  }
}
