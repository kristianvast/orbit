import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = process.platform === "win32" ? "orbit-desktop.exe" : "orbit-desktop";
const application =
  process.env.ORBIT_APP_PATH ??
  resolve(import.meta.dirname, "../../../apps/orbit/src-tauri/target/debug", exe);

const logPath = join(tmpdir(), `tauri-driver-${process.pid}.log`);
let logFd: number | undefined;
let tauriDriver: ChildProcess | undefined;

function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, rejectPromise) => {
    const tryOnce = () => {
      const sock = createConnection({ host: "127.0.0.1", port });
      sock.once("connect", () => {
        sock.destroy();
        resolvePromise();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() >= deadline) {
          rejectPromise(new Error(`tauri-driver did not listen on 127.0.0.1:${port}`));
        } else {
          setTimeout(tryOnce, 100);
        }
      });
    };
    tryOnce();
  });
}

function stopTauriDriver() {
  if (logFd !== undefined) {
    try {
      closeSync(logFd);
    } catch {}
    logFd = undefined;
  }
  if (tauriDriver?.pid) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(tauriDriver.pid)], { stdio: "ignore" });
      spawnSync(
        "taskkill",
        ["/F", "/IM", "orbit-desktop.exe", "/IM", "orion.exe", "/IM", "msedgedriver.exe"],
        { stdio: "ignore" },
      );
    } else {
      tauriDriver.kill();
    }
    tauriDriver = undefined;
  }
  if (existsSync(logPath)) {
    try {
      console.log(`--- tauri-driver.log ---\n${readFileSync(logPath, "utf8").slice(-4000)}`);
    } catch {}
  }
}

export const config: WebdriverIO.Config = {
  runner: "local",
  hostname: "127.0.0.1",
  port: 4444,
  specs: ["./specs/**/*.e2e.ts"],
  maxInstances: 1,
  capabilities: [
    {
      "wdio:enforceWebDriverClassic": true,
      "tauri:options": { application },
    } as WebdriverIO.Capabilities,
  ],
  logLevel: "warn",
  connectionRetryCount: 4,
  connectionRetryTimeout: 60_000,
  waitforTimeout: 45_000,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 90_000 },

  onPrepare() {
    if (!existsSync(application)) {
      throw new Error(
        `Orbit debug build not found at ${application}; run tauri build --debug first.`,
      );
    }
  },

  async beforeSession() {
    const args: string[] = [];
    if (process.env.TAURI_NATIVE_DRIVER)
      args.push("--native-driver", process.env.TAURI_NATIVE_DRIVER);
    logFd = openSync(logPath, "w");
    tauriDriver = spawn(process.env.TAURI_DRIVER_PATH ?? "tauri-driver", args, {
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        ORION_MOCK_MODEL: "1",
        ORION_SEED: "1",
        ORION_SECRETS: "file",
      },
    });
    tauriDriver.unref();
    tauriDriver.on("error", (err) => {
      console.error("tauri-driver failed to start:", err);
      process.exit(1);
    });
    await waitForPort(4444);
  },

  afterSession() {
    stopTauriDriver();
  },
};
