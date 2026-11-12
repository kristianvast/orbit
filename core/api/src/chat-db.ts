import { bigint, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const chatSessions = pgTable(
  "chat_sessions",
  {
    farmId: uuid("farm_id").notNull(),
    userId: uuid("user_id").notNull(),
    id: uuid("id").notNull(),
    title: text("title").notNull(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
    parentSessionId: uuid("parent_session_id"),
    header: jsonb("header").$type<Record<string, unknown>>(),
    deletedAt: ts("deleted_at"),
  },
  (t) => [primaryKey({ columns: [t.farmId, t.userId, t.id] })],
);

export const chatEntries = pgTable(
  "chat_entries",
  {
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
    farmId: uuid("farm_id").notNull(),
    userId: uuid("user_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    id: text("id").notNull(),
    entry: jsonb("entry").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.farmId, t.userId, t.sessionId, t.id] })],
);
