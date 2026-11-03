#!/usr/bin/env bun
import { READY_LINE_PREFIX } from "@orbit/protocol";
import { startOrion } from "./app";
import { ConfigError, parseConfig } from "./config";

try {
  const config = parseConfig(process.argv.slice(2));
  const app = await startOrion(config);
  process.stdout.write(`${READY_LINE_PREFIX}${JSON.stringify({ port: app.port })}\n`);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  process.stderr.write(`orion: ${error instanceof ConfigError ? error.message : String(error)}\n`);
  process.exit(error instanceof ConfigError ? 2 : 1);
}
