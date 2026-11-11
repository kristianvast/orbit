import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

test("0007 maps legacy subscriptions and replaces the plan CHECK", async () => {
  const client = new PGlite();
  try {
    await client.exec(
      await Bun.file(new URL("../migrations/0003_billing.sql", import.meta.url)).text(),
    );
    await client.exec(`INSERT INTO farm_subscriptions (farm_id, plan, status) VALUES
      ('00000000-0000-4000-8000-000000000001','pen','active'),
      ('00000000-0000-4000-8000-000000000002','barn','active'),
      ('00000000-0000-4000-8000-000000000003','free','free')`);
    await client.exec(
      await Bun.file(new URL("../migrations/0007_plan_ladder.sql", import.meta.url)).text(),
    );
    expect(
      (await client.query("SELECT plan FROM farm_subscriptions ORDER BY farm_id")).rows,
    ).toEqual([{ plan: "cam2" }, { plan: "cam6" }, { plan: "free" }]);
    await client.exec(`INSERT INTO farm_subscriptions (farm_id, plan, status) VALUES
      ('00000000-0000-4000-8000-000000000004','orion','active'),
      ('00000000-0000-4000-8000-000000000005','cam4','active')`);
    for (const plan of ["pen", "barn", "cam3"]) {
      await expect(
        client.query("INSERT INTO farm_subscriptions (farm_id, plan, status) VALUES ($1,$2,$3)", [
          "00000000-0000-4000-8000-000000000006",
          plan,
          "active",
        ]),
      ).rejects.toMatchObject({ constraint: "farm_subscriptions_plan_check" });
    }
  } finally {
    await client.close();
  }
});
