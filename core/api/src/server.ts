// Production entry: `bun src/server.ts`. Configuration comes from the environment (see
// core/.env.example).
import { drizzle } from "drizzle-orm/bun-sql";
import { type CoreDb, coreSchema } from "./db";
import { migrate } from "./migrate";
import { serveCore } from "./runtime";

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

required("ELECTRIC_URL");
// A production API without email would let accounts sign up that can never verify or reset;
// set MAIL_PROVIDER=log explicitly to run without real email (local compose stacks).
required("MAIL_PROVIDER");
serveCore(db, 8080);
