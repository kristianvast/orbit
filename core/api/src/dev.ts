import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { type CoreDb, coreSchema } from "./db";
import { migrate } from "./migrate";
import { serveCore } from "./runtime";

const client = new PGlite(new URL("../.dev-data/", import.meta.url).pathname);
const db: CoreDb = drizzle({ client, schema: coreSchema });
await migrate(db);
const server = serveCore(db, 8787);
async function shutdown() {
  await server.stop(true);
  await client.close();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
