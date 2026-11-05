// Production entry: `bun src/server.ts`. Configuration comes from the environment (see
// core/.env.example).
import { drizzle } from "drizzle-orm/bun-sql";
import { createApp } from "./app";
import { createTokenResolver } from "./auth";
import { type CoreDb, coreSchema } from "./db";
import { migrate } from "./migrate";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const db = drizzle(required("DATABASE_URL"), { schema: coreSchema }) as unknown as CoreDb;
if (process.env.CORE_MIGRATE_ON_START !== "false") {
  const { applied } = await migrate(db);
  if (applied.length > 0) console.log(`migrations applied: ${applied.join(", ")}`);
}

const authHeader = process.env.LLM_UPSTREAM_AUTH === "x-api-key" ? "x-api-key" : "authorization";
const app = createApp({
  db,
  resolveToken: createTokenResolver(db, process.env.CORE_STATIC_TOKENS),
  electricUrl: required("ELECTRIC_URL"),
  electricSecret: process.env.ELECTRIC_SECRET || undefined,
  llm: {
    upstreamUrl: process.env.LLM_UPSTREAM_URL || undefined,
    upstreamApiKey: process.env.LLM_UPSTREAM_API_KEY || undefined,
    authHeader,
    defaultMonthlyTokenBudget: Number(process.env.LLM_MONTHLY_TOKEN_BUDGET ?? 2_000_000),
    defaultModel: process.env.LLM_DEFAULT_MODEL || undefined,
  },
  version: process.env.CORE_VERSION,
});

const port = Number(process.env.PORT ?? 8080);
Bun.serve({ port, fetch: app.fetch, idleTimeout: 120 });
console.log(`@core/api listening on :${port}`);
