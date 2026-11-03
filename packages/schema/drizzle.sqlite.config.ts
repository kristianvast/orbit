import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/sqlite.ts",
  out: "./drizzle/sqlite",
});
