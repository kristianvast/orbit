// Admin CLI: `bun src/cli.ts issue-token <farm-uuid> [name]` prints a new bearer token once,
// `bun src/cli.ts set-budget <farm-uuid> <tokens>` overrides a farm's monthly LLM budget.
import { drizzle } from "drizzle-orm/bun-sql";
import { issueToken } from "./auth";
import { type CoreDb, coreSchema, farmBudgets } from "./db";
import { migrate } from "./migrate";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = drizzle(url, { schema: coreSchema }) as unknown as CoreDb;
const [command, farmId, arg] = process.argv.slice(2);

if (command === "migrate") {
  console.log(await migrate(db));
} else if (command === "issue-token" && farmId) {
  console.log(await issueToken(db, farmId, arg));
} else if (command === "set-budget" && farmId && arg) {
  const monthlyTokenBudget = Number(arg);
  await db
    .insert(farmBudgets)
    .values({ farmId, monthlyTokenBudget })
    .onConflictDoUpdate({ target: farmBudgets.farmId, set: { monthlyTokenBudget } });
  console.log(`budget for ${farmId} = ${monthlyTokenBudget}`);
} else {
  console.error(
    "usage: cli.ts migrate | issue-token <farm-id> [name] | set-budget <farm-id> <tokens>",
  );
  process.exit(2);
}
process.exit(0);
