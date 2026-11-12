import type { FarmCodeManifest } from "@orbit/protocol";
import { jsonb, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";

export const farmCodeBlobs = pgTable(
  "farm_code_blobs",
  {
    farmId: uuid("farm_id").notNull(),
    hash: text("hash").notNull(),
    content: text("content").notNull(),
  },
  (t) => [primaryKey({ columns: [t.farmId, t.hash] })],
);
export const farmCodeCommits = pgTable(
  "farm_code_commits",
  {
    farmId: uuid("farm_id").notNull(),
    id: text("id").notNull(),
    parent: text("parent"),
    manifest: jsonb("manifest").$type<FarmCodeManifest>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.farmId, t.id] })],
);
export const farmCodeHeads = pgTable("farm_code_heads", {
  farmId: uuid("farm_id").primaryKey(),
  commitId: text("commit_id"),
});
