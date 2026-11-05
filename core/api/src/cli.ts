// Admin CLI: `bun src/cli.ts issue-token <farm-uuid> [name]` prints a new bearer token once,
// `bun src/cli.ts set-budget <farm-uuid> <tokens>` overrides a farm's monthly LLM budget,
// `bun src/cli.ts add-member <farm-uuid> <email> <role>` gives a registered user a farm role.
import { isFarmRole } from "@orbit/schema";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { issueToken } from "./auth";
import { type CoreDb, coreSchema, farmBudgets, farmMembers, users } from "./db";
import { migrate } from "./migrate";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = drizzle(url, { schema: coreSchema }) as unknown as CoreDb;
const [command, farmId, arg, extra] = process.argv.slice(2);

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
} else if (command === "add-member" && farmId && arg && isFarmRole(extra)) {
  const [user] = await db.select().from(users).where(eq(users.email, arg.toLowerCase()));
  if (!user) throw new Error(`no user with email ${arg}`);
  await db
    .insert(farmMembers)
    .values({ farmId, userId: user.id, role: extra })
    .onConflictDoUpdate({
      target: [farmMembers.farmId, farmMembers.userId],
      set: { role: extra, updatedAt: new Date().toISOString() },
    });
  console.log(`${user.email} is ${extra} of ${farmId}`);
} else {
  console.error(
    "usage: cli.ts migrate | issue-token <farm-id> [name] | set-budget <farm-id> <tokens> | add-member <farm-id> <email> <owner|manager|worker|viewer>",
  );
  process.exit(2);
}
process.exit(0);
