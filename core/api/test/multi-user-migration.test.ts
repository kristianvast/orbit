import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

test("multi-user migration preserves existing access and backfills both billing ledgers", async () => {
  const client = new PGlite();
  const farm = "00000000-0000-4000-8000-000000000001";
  try {
    await client.exec(`
      CREATE TABLE farm_members (farm_id uuid NOT NULL);
      CREATE TABLE farm_invites (farm_id uuid NOT NULL);
      CREATE TABLE llm_usage (farm_id uuid NOT NULL, created_at timestamptz DEFAULT now());
      CREATE TABLE voice_usage (farm_id uuid NOT NULL, created_at timestamptz DEFAULT now());
      INSERT INTO farm_members VALUES ('${farm}');
      INSERT INTO farm_invites VALUES ('${farm}');
      INSERT INTO llm_usage (farm_id) VALUES ('${farm}');
      INSERT INTO voice_usage (farm_id) VALUES ('${farm}');
    `);
    const migration = await Bun.file(
      new URL("../migrations/0009_multi_user.sql", import.meta.url),
    ).text();
    await client.exec(migration);
    expect(
      (
        await client.query(
          "SELECT use_farm_plan, monthly_token_limit, usage_source FROM farm_members",
        )
      ).rows,
    ).toEqual([{ use_farm_plan: true, monthly_token_limit: null, usage_source: null }]);
    expect(
      (await client.query("SELECT use_farm_plan, monthly_token_limit FROM farm_invites")).rows,
    ).toEqual([{ use_farm_plan: false, monthly_token_limit: null }]);
    for (const ledger of ["llm_usage", "voice_usage"]) {
      expect(
        (await client.query(`SELECT farm_id, account_id, user_id FROM ${ledger}`)).rows,
      ).toEqual([{ farm_id: farm, account_id: farm, user_id: null }]);
      await client.query(
        `INSERT INTO ${ledger} (farm_id, user_id, account_id) VALUES (NULL, $1, $1)`,
        [farm],
      );
    }
    expect(
      (
        await client.query(
          "SELECT indexname FROM pg_indexes WHERE indexname IN ('llm_usage_account_created_idx', 'llm_usage_member_created_idx', 'voice_usage_account_created_idx', 'voice_usage_member_created_idx') ORDER BY indexname",
        )
      ).rows,
    ).toEqual([
      { indexname: "llm_usage_account_created_idx" },
      { indexname: "llm_usage_member_created_idx" },
      { indexname: "voice_usage_account_created_idx" },
      { indexname: "voice_usage_member_created_idx" },
    ]);
  } finally {
    await client.close();
  }
}, 60_000);
