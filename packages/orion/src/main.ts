#!/usr/bin/env bun
import { join } from "node:path";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { READY_LINE_PREFIX } from "@orbit/protocol";
import { SERVER_VERSION, startOrion } from "./app";
import { ConfigError, parseConfig } from "./config";
import { LocalOrion } from "./services/local-orion";
import { retireStaleFarmBuild } from "./services/local-ui";

// pi-ai loads OAuth flows through a variable import that `bun build --compile` cannot embed.
registerBunOAuthFlows();

try {
  const argv = process.argv.slice(2);
  const config = parseConfig(argv);
  // A dev checkout (--app-source) already runs from source, so only an installed Orion hands over.
  const local = config.appSource
    ? null
    : new LocalOrion(config.dataDir, join(config.dataDir, "app"));
  // After an update that did not move the farm's changes, the farm build would hide the new version.
  if (local) retireStaleFarmBuild(config.dataDir, SERVER_VERSION);
  if (local?.shouldStart()) await local.supervise(argv);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await app.stop();
    process.exit(0);
  };
  // The desktop shell (--parent-watch) starts Orion again whenever it exits, so a clean exit is a restart.
  const app = await startOrion(config.parentWatch ? { ...config, restart: shutdown } : config);
  process.stdout.write(`${READY_LINE_PREFIX}${JSON.stringify({ port: app.port })}\n`);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (config.parentWatch) {
    process.stdin.on("end", shutdown);
    process.stdin.on("close", shutdown);
    process.stdin.resume();
  }
} catch (error) {
  process.stderr.write(`orion: ${error instanceof ConfigError ? error.message : String(error)}\n`);
  process.exit(error instanceof ConfigError ? 2 : 1);
}
