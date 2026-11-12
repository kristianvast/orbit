import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventBody, EventType } from "@orbit/protocol";
import { createOrionClient, type OrionClient } from "@orbit/protocol/client";
import { type OrionApp, startOrion } from "../src/app";

process.env.ORION_SECRETS = "file";
process.env.ORION_MOCK_DELAY_MS = "0";

export const TOKEN = "test-token";

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "orion-test-"));
}

export function removeDir(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * For folders a browser used. Edge and Chrome keep their profile folder locked until their process
 * is gone, which on Windows is a moment after it is closed. Nothing announces that, so the delete
 * is retried while the folder is still locked, for at most ten seconds.
 */
export async function removeLockedDir(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as { code?: string }).code ?? "";
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(code) || attempt >= 100) throw error;
      await Bun.sleep(100);
    }
  }
}

export async function startApp(dataDir: string, seed = true): Promise<OrionApp> {
  return startOrion({
    port: 0,
    token: TOKEN,
    dataDir,
    mockModel: true,
    seed,
    gatewayUrl: null,
    appSource: null,
  });
}

export async function connect(app: OrionApp): Promise<OrionClient> {
  const client = createOrionClient(`ws://127.0.0.1:${app.port}/ws`, TOKEN, { reconnect: false });
  await client.ready();
  return client;
}

/** Resolves with the first matching event; subscribe BEFORE triggering the action. */
export function waitFor<E extends EventType>(
  client: OrionClient,
  type: E,
  match: (body: EventBody<E>) => boolean = () => true,
  timeoutMs = 10_000,
): Promise<EventBody<E>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${type}`));
    }, timeoutMs);
    const off = client.on(type, (event) => {
      const body = event as unknown as EventBody<E>;
      if (!match(body)) return;
      clearTimeout(timer);
      off();
      resolve(body);
    });
  });
}

export function record(client: OrionClient): Array<{ type: string } & Record<string, unknown>> {
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  client.on("*", (e) => events.push(e as unknown as { type: string } & Record<string, unknown>));
  return events;
}
