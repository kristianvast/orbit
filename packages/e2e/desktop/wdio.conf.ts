// Desktop smoke via tauri-driver (https://v2.tauri.app/develop/tests/webdriver/).
// Runs in CI on Windows and Linux only: tauri-driver has no macOS (WKWebView) driver.
// The app must already be built: `tauri build --debug` in apps/orbit (CI job "desktop").
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const exe = process.platform === "win32" ? "orbit-desktop.exe" : "orbit-desktop";
const application =
  process.env.ORBIT_APP_PATH ??
  resolve(import.meta.dirname, "../../../apps/orbit/src-tauri/target/debug", exe);

let tauriDriver: ChildProcess | undefined;

export const config: WebdriverIO.Config = {
  runner: "local",
  hostname: "127.0.0.1",
  port: 4444,
  specs: ["./specs/**/*.e2e.ts"],
  maxInstances: 1,
  capabilities: [
    {
      // No browserName (as in the Tauri docs) and WebDriver classic: WebdriverIO v9 otherwise
      // requests BiDi (webSocketUrl), which tauri-driver rejects with "Failed to match capabilities".
      "wdio:enforceWebDriverClassic": true,
      "tauri:options": { application },
    } as WebdriverIO.Capabilities,
  ],
  logLevel: "warn",
  connectionRetryCount: 10,
  connectionRetryTimeout: 120_000,
  waitforTimeout: 60_000,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 180_000 },

  onPrepare() {
    if (!existsSync(application)) {
      throw new Error(
        `Orbit debug build not found at ${application}; run tauri build --debug first.`,
      );
    }
  },

  beforeSession() {
    const args: string[] = [];
    // Windows: CI passes the msedgedriver that matches the installed Edge/WebView2.
    if (process.env.TAURI_NATIVE_DRIVER)
      args.push("--native-driver", process.env.TAURI_NATIVE_DRIVER);
    tauriDriver = spawn(process.env.TAURI_DRIVER_PATH ?? "tauri-driver", args, {
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        // Read by apps/orbit/src-tauri/src/lib.rs and turned into --mock-model / --seed.
        ORION_MOCK_MODEL: "1",
        ORION_SEED: "1",
        ORION_SECRETS: "file",
      },
    });
    tauriDriver.on("error", (err) => {
      console.error("tauri-driver failed to start:", err);
      process.exit(1);
    });
  },

  afterSession() {
    tauriDriver?.kill();
  },
};
