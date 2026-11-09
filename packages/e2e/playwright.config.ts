import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { E2E_ORION_PORT, E2E_TOKEN, E2E_VITE_PORT } from "./src/index";

const repoRoot = resolve(import.meta.dirname, "../..");
const isCI = Boolean(process.env.CI);

// Workers re-evaluate this file; the env var makes them reuse the main process's data dir.
process.env.ORBIT_E2E_DATA_DIR ??= mkdtempSync(join(tmpdir(), "orbit-e2e-"));
const dataDir = process.env.ORBIT_E2E_DATA_DIR;

// Second, unseeded Orion + Vite pair for the minimal-first spec: a fresh install with no farm data.
process.env.ORBIT_E2E_FRESH_DATA_DIR ??= mkdtempSync(join(tmpdir(), "orbit-e2e-fresh-"));
const freshDataDir = process.env.ORBIT_E2E_FRESH_DATA_DIR;
const FRESH_ORION_PORT = E2E_ORION_PORT + 1;
const FRESH_VITE_PORT = E2E_VITE_PORT + 1;
const FRESH_TOKEN = "e2e-fresh";
const FRESH_SPEC = /minimal-first\.spec\.ts/;

export default defineConfig({
  testDir: "./web",
  // One Orion instance and one data dir are shared, so specs run one at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: isCI
    ? [["list"], ["html", { open: "never" }], ["junit", { outputFile: "test-results/junit.xml" }]]
    : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${E2E_VITE_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: FRESH_SPEC,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "fresh",
      testMatch: FRESH_SPEC,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://127.0.0.1:${FRESH_VITE_PORT}`,
        viewport: { width: 1280, height: 820 },
      },
    },
  ],
  webServer: [
    {
      name: "orion",
      command: `bun packages/orion/src/main.ts --port ${E2E_ORION_PORT} --token ${E2E_TOKEN} --mock-model --seed --data-dir "${dataDir}" --app-source "${repoRoot}"`,
      cwd: repoRoot,
      url: `http://127.0.0.1:${E2E_ORION_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ORION_SECRETS: "file",
        ORION_MOCK_DELAY_MS: "5",
        ORION_FAKE_CAMERAS: "[]",
      },
    },
    {
      name: "vite",
      command: `bunx vite --host 127.0.0.1 --port ${E2E_VITE_PORT} --strictPort`,
      cwd: join(repoRoot, "apps/orbit"),
      url: `http://127.0.0.1:${E2E_VITE_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        VITE_ORION_URL: `ws://127.0.0.1:${E2E_ORION_PORT}/ws`,
        VITE_ORION_TOKEN: E2E_TOKEN,
        VITE_LOCAL_UI_HANDOFF: "1",
      },
    },
    {
      // No --seed: a fresh install. --mock-model stays on because there is no real model in e2e.
      name: "orion-fresh",
      command: `bun packages/orion/src/main.ts --port ${FRESH_ORION_PORT} --token ${FRESH_TOKEN} --mock-model --data-dir "${freshDataDir}" --app-source "${repoRoot}"`,
      cwd: repoRoot,
      url: `http://127.0.0.1:${FRESH_ORION_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ORION_SECRETS: "file",
        ORION_MOCK_DELAY_MS: "5",
        ORION_FAKE_CAMERAS: "[]",
      },
    },
    {
      name: "vite-fresh",
      command: `bunx vite --host 127.0.0.1 --port ${FRESH_VITE_PORT} --strictPort`,
      cwd: join(repoRoot, "apps/orbit"),
      url: `http://127.0.0.1:${FRESH_VITE_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        VITE_ORION_URL: `ws://127.0.0.1:${FRESH_ORION_PORT}/ws`,
        VITE_ORION_TOKEN: FRESH_TOKEN,
      },
    },
  ],
});
