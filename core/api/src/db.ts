// Core-only tables (not synced to farms) plus the combined Drizzle schema used by @core/api.
import { FARM_ROLES, pg } from "@orbit/schema";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

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

/** People who sign in to Orbit. `email` is stored lower-cased; passwords only as argon2id hashes. */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name"),
    passwordHash: text("password_hash").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_unique").on(t.email)],
);

/** Signed-in sessions (an Orbit install or a browser). Only the SHA-256 of the token is stored. */
export const userSessions = pgTable(
  "user_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id").notNull(),
    deviceName: text("device_name"),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("user_sessions_user_idx").on(t.userId)],
);

export const farmMembers = pgTable(
  "farm_members",
  {
    farmId: uuid("farm_id").notNull(),
    userId: uuid("user_id").notNull(),
    role: text("role", { enum: FARM_ROLES }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.farmId, t.userId] }),
    index("farm_members_user_idx").on(t.userId),
  ],
);

/** Single-use invites bound to one email address; only the SHA-256 of the code is stored. */
export const farmInvites = pgTable(
  "farm_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    farmId: uuid("farm_id").notNull(),
    email: text("email").notNull(),
    role: text("role", { enum: FARM_ROLES }).notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedBy: uuid("invited_by").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    acceptedBy: uuid("accepted_by"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    uniqueIndex("farm_invites_token_unique").on(t.tokenHash),
    index("farm_invites_farm_idx").on(t.farmId),
  ],
);

export const coreMigrations = pgTable("__core_migrations", {
  tag: text("tag").primaryKey(),
  appliedAt: ts("applied_at").notNull().defaultNow(),
});

export const coreSchema = {
  ...pg.pgSchema,
  apiTokens,
  farmBudgets,
  llmUsage,
  users,
  userSessions,
  farmMembers,
  farmInvites,
  coreMigrations,
};

/** Any Drizzle Postgres database (bun-sql in production, PGlite in tests) over coreSchema. */
export type CoreDb = PgDatabase<PgQueryResultHKT, typeof coreSchema>;
