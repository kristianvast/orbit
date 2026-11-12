// Core-only tables (not synced to farms) plus the combined Drizzle schema used by @core/api.
import { FARM_ROLES, pg } from "@orbit/schema";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { chatEntries, chatSessions } from "./chat-db";

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
    farmId: uuid("farm_id"),
    userId: uuid("user_id"),
    accountId: uuid("account_id").notNull(),
    model: text("model"),
    path: text("path").notNull(),
    status: integer("status").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("llm_usage_farm_created_idx").on(t.farmId, t.createdAt),
    index("llm_usage_account_created_idx").on(t.accountId, t.createdAt),
    index("llm_usage_member_created_idx").on(t.farmId, t.userId, t.createdAt),
  ],
);

/** People who sign in to Orbit. `email` is stored lower-cased; passwords only as argon2id hashes. */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name"),
    passwordHash: text("password_hash"),
    googleSub: text("google_sub"),
    createdAt: ts("created_at").notNull().defaultNow(),
    emailVerifiedAt: ts("email_verified_at"),
    termsVersion: text("terms_version"),
    termsAcceptedAt: ts("terms_accepted_at"),
    dataConsentAt: ts("data_consent_at"),
  },
  (t) => [
    uniqueIndex("users_email_unique").on(t.email),
    uniqueIndex("users_google_sub_unique").on(t.googleSub),
  ],
);

/** Single-use email links (verify address, reset password). Only the SHA-256 of the code is stored. */
export const emailTokens = pgTable(
  "email_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id").notNull(),
    purpose: text("purpose", { enum: ["verify", "reset"] }).notNull(),
    email: text("email").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
  },
  (t) => [index("email_tokens_user_idx").on(t.userId, t.purpose, t.createdAt)],
);

export const loginFailures = pgTable(
  "login_failures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [index("login_failures_email_at_idx").on(t.email, t.at)],
);

/** Signed-in sessions (an Orbit install or a browser). Only the SHA-256 of the token is stored. */
export const userSessions = pgTable(
  "user_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    id: uuid("id").notNull().defaultRandom(),
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
    useFarmPlan: boolean("use_farm_plan").notNull().default(true),
    monthlyTokenLimit: bigint("monthly_token_limit", { mode: "number" }),
    usageSource: text("usage_source", { enum: ["farm", "own"] }),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.farmId, t.userId] }),
    index("farm_members_user_idx").on(t.userId),
    check("farm_members_usage_source_check", sql`${t.usageSource} in ('farm', 'own')`),
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
    useFarmPlan: boolean("use_farm_plan").notNull().default(false),
    monthlyTokenLimit: bigint("monthly_token_limit", { mode: "number" }),
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

/** Billing account key: farm UUID, or user UUID for personal plans (disjoint UUID spaces). */
export const billingCustomers = pgTable("billing_customers", {
  farmId: uuid("farm_id").primaryKey(),
  stripeCustomerId: text("stripe_customer_id").notNull().unique(),
});

/** `farm_id` also stores the user UUID for a personal subscription, matching Stripe metadata. */
export const farmSubscriptions = pgTable("farm_subscriptions", {
  farmId: uuid("farm_id").primaryKey(),
  plan: text("plan", { enum: ["free", "orion", "cam2", "cam4", "cam6"] }).notNull(),
  interval: text("interval", { enum: ["month", "year"] }),
  status: text("status").notNull(),
  stripeSubscriptionId: text("stripe_subscription_id").unique(),
  currentPeriodEnd: ts("current_period_end"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  /** `created` of the Stripe event last applied; older events never overwrite newer state. */
  stripeEventAt: ts("stripe_event_at"),
});

export const stripeEvents = pgTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  receivedAt: ts("received_at").notNull().defaultNow(),
});

export const hardwareOrders = pgTable("hardware_orders", {
  stripeCheckoutSessionId: text("stripe_checkout_session_id").primaryKey(),
  email: text("email"),
  boxes: integer("boxes").notNull().default(0),
  cameras: integer("cameras").notNull().default(0),
  status: text("status").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  userId: uuid("user_id"),
  shipping: jsonb("shipping"),
  amountTotal: integer("amount_total"),
  currency: text("currency"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const voiceUsage = pgTable(
  "voice_usage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    farmId: uuid("farm_id"),
    userId: uuid("user_id"),
    accountId: uuid("account_id").notNull(),
    seconds: integer("seconds").notNull(),
    model: text("model").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("voice_usage_farm_created_idx").on(t.farmId, t.createdAt),
    index("voice_usage_account_created_idx").on(t.accountId, t.createdAt),
    index("voice_usage_member_created_idx").on(t.farmId, t.userId, t.createdAt),
  ],
);

/**
 * Website voice demo calls, one row per minted ElevenLabs credential. `visitor` is an HMAC of the
 * client IP (IPv6 by /64), never the raw address. `charged_seconds` stays null until the real call
 * length is known; until then the call counts as `reserved_seconds`.
 */
export const voiceDemoSessions = pgTable(
  "voice_demo_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    visitor: text("visitor").notNull(),
    conversationId: text("conversation_id"),
    reservedSeconds: integer("reserved_seconds").notNull(),
    chargedSeconds: integer("charged_seconds"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("voice_demo_sessions_visitor_created_idx").on(t.visitor, t.createdAt),
    index("voice_demo_sessions_created_idx").on(t.createdAt),
  ],
);

export const feedback = pgTable("feedback", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id"),
  farmId: uuid("farm_id"),
  kind: text("kind").notNull(),
  message: text("message").notNull(),
  contactEmail: text("contact_email"),
  appVersion: text("app_version"),
  os: text("os"),
  locale: text("locale"),
  diagnostics: text("diagnostics"),
  status: text("status").notNull().default("new"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const submissions = pgTable(
  "submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    farmId: uuid("farm_id"),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    appVersion: text("app_version"),
    files: jsonb("files").$type<{ path: string; content: string }[]>().notNull(),
    bytes: integer("bytes").notNull(),
    status: text("status").notNull().default("pending"),
    reviewNote: text("review_note"),
    createdAt: ts("created_at").notNull().defaultNow(),
    reviewedAt: ts("reviewed_at"),
  },
  (t) => [index("submissions_user_created_idx").on(t.userId, t.createdAt)],
);

/** Rolling feedback limits survive restarts; no raw anonymous IP is retained. */
export const feedbackRateEvents = pgTable(
  "feedback_rate_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identity: text("identity").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("feedback_rate_events_identity_created_idx").on(t.identity, t.createdAt)],
);

export const coreSchema = {
  ...pg.pgSchema,
  chatEntries,
  chatSessions,
  apiTokens,
  farmBudgets,
  llmUsage,
  users,
  emailTokens,
  loginFailures,
  userSessions,
  farmMembers,
  farmInvites,
  coreMigrations,
  billingCustomers,
  farmSubscriptions,
  stripeEvents,
  hardwareOrders,
  voiceUsage,
  voiceDemoSessions,
  feedback,
  submissions,
  feedbackRateEvents,
};

/** Any Drizzle Postgres database (bun-sql in production, PGlite in tests) over coreSchema. */
export type CoreDb = PgDatabase<PgQueryResultHKT, typeof coreSchema>;
