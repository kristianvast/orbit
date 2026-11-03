// Core-only tables (not synced to farms) plus the combined Drizzle schema used by @core/api.
import { pg } from "@orbit/schema";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { bigint, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

/** Bearer tokens issued to Orbit installs. Only the SHA-256 of the token is stored. */
export const apiTokens = pgTable(
  "api_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    farmId: uuid("farm_id").notNull(),
    name: text("name"),
    createdAt: ts("created_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("api_tokens_farm_idx").on(t.farmId)],
);

/** Per-farm override of the default monthly LLM token budget. */
export const farmBudgets = pgTable("farm_budgets", {
  farmId: uuid("farm_id").primaryKey(),
  monthlyTokenBudget: bigint("monthly_token_budget", { mode: "number" }).notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** One row per LLM gateway request; the input for future billing. */
export const llmUsage = pgTable(
  "llm_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    farmId: uuid("farm_id").notNull(),
    model: text("model"),
    path: text("path").notNull(),
    status: integer("status").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("llm_usage_farm_created_idx").on(t.farmId, t.createdAt)],
);

export const coreMigrations = pgTable("__core_migrations", {
  tag: text("tag").primaryKey(),
  appliedAt: ts("applied_at").notNull().defaultNow(),
});

export const coreSchema = { ...pg.pgSchema, apiTokens, farmBudgets, llmUsage, coreMigrations };

/** Any Drizzle Postgres database (bun-sql in production, PGlite in tests) over coreSchema. */
export type CoreDb = PgDatabase<PgQueryResultHKT, typeof coreSchema>;
