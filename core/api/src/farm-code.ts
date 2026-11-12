import { createHash } from "node:crypto";
import {
  FARM_CODE_MAX_BYTES,
  FARM_CODE_MAX_FILE_BYTES,
  FARM_CODE_MAX_FILES,
  FarmCodePush,
  farmCodeHashes,
  farmCodePath,
  farmCodeSecret,
} from "@orbit/protocol";
import { canWriteTable } from "@orbit/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Principal } from "./auth";
import type { CoreDb } from "./db";
import { farmCodeBlobs, farmCodeCommits, farmCodeHeads } from "./farm-code-db";

const FetchBlobs = Type.Object({
  hashes: Type.Array(Type.String({ pattern: "^[a-f0-9]{64}$" }), {
    maxItems: FARM_CODE_MAX_FILES * 2,
  }),
});
class CodeConflict extends Error {}
class CodeInput extends Error {}

export function createFarmCodeRoutes(db: CoreDb) {
  const app = new Hono<{ Variables: { principal: Principal } }>();
  app.use(
    "/v1/farm-code/*",
    bodyLimit({
      maxSize: FARM_CODE_MAX_BYTES * 2,
      onError: (c) =>
        c.json({ error: { code: "bad_request", message: "farm code request is too large" } }, 413),
    }),
  );
  app.use("/v1/farm-code/*", async (c, next) => {
    if (!c.get("principal").userId)
      return c.json(
        { error: { code: "unauthorized", message: "a user session is required" } },
        401,
      );
    return next();
  });
  app.get("/v1/farm-code/head", async (c) => {
    const farmId = c.get("principal").farmId;
    const [head] = await db.select().from(farmCodeHeads).where(eq(farmCodeHeads.farmId, farmId));
    if (!head?.commitId) return c.json({ head: null });
    const [commit] = await db
      .select()
      .from(farmCodeCommits)
      .where(and(eq(farmCodeCommits.farmId, farmId), eq(farmCodeCommits.id, head.commitId)));
    return c.json({
      head: commit ? { id: commit.id, parent: commit.parent, manifest: commit.manifest } : null,
    });
  });
  app.post("/v1/farm-code/blobs/fetch", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!Value.Check(FetchBlobs, body))
      return c.json({ error: { code: "bad_request", message: "invalid blob request" } }, 400);
    const rows = body.hashes.length
      ? await db
          .select()
          .from(farmCodeBlobs)
          .where(
            and(
              eq(farmCodeBlobs.farmId, c.get("principal").farmId),
              inArray(farmCodeBlobs.hash, body.hashes),
            ),
          )
      : [];
    if (
      rows.reduce((bytes, row) => bytes + Buffer.byteLength(row.content, "base64"), 0) >
      FARM_CODE_MAX_BYTES
    )
      return c.json(
        { error: { code: "bad_request", message: "fetch fewer blobs per request" } },
        413,
      );
    return c.json({ blobs: Object.fromEntries(rows.map((row) => [row.hash, row.content])) });
  });
  app.post("/v1/farm-code/commits", async (c) => {
    const { farmId, role } = c.get("principal");
    if (!canWriteTable(role, "connectors"))
      return c.json(
        { error: { code: "forbidden", message: "this role may not change farm code" } },
        403,
      );
    const body: unknown = await c.req.json().catch(() => null);
    if (!Value.Check(FarmCodePush, body))
      return c.json({ error: { code: "bad_request", message: "invalid code commit" } }, 400);
    const { manifest, parent, blobs } = body;
    const paths = [...Object.keys(manifest.workspace), ...Object.keys(manifest.app?.files ?? {})];
    if (paths.length > FARM_CODE_MAX_FILES || !paths.every(farmCodePath))
      return c.json(
        { error: { code: "bad_request", message: "invalid paths or too many files" } },
        400,
      );
    const hashes = farmCodeHashes(manifest);
    if (Object.keys(blobs).some((hash) => !hashes.includes(hash)))
      return c.json({ error: { code: "bad_request", message: "unreferenced blob" } }, 400);
    try {
      const head = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${farmId}))`);
        // The head row is the farm's lock, including the first concurrent pushes.
        await tx.insert(farmCodeHeads).values({ farmId }).onConflictDoNothing();
        const [current] = await tx
          .select()
          .from(farmCodeHeads)
          .where(eq(farmCodeHeads.farmId, farmId))
          .for("update");
        if ((current?.commitId ?? null) !== parent) throw new CodeConflict();
        const stored = hashes.length
          ? await tx
              .select()
              .from(farmCodeBlobs)
              .where(and(eq(farmCodeBlobs.farmId, farmId), inArray(farmCodeBlobs.hash, hashes)))
          : [];
        const contents = {
          ...Object.fromEntries(stored.map((row) => [row.hash, row.content])),
          ...blobs,
        };
        for (const hash of hashes) {
          const content = contents[hash];
          if (content === undefined) throw new CodeInput("missing blob");
          const bytes = Buffer.from(content, "base64");
          if (
            bytes.toString("base64") !== content ||
            bytes.length > FARM_CODE_MAX_FILE_BYTES ||
            createHash("sha256").update(bytes).digest("hex") !== hash
          )
            throw new CodeInput("invalid or oversized blob");
          if (farmCodeSecret(bytes.toString("utf8")))
            throw new CodeInput("file looks like it contains a secret");
        }
        const references = [
          ...Object.values(manifest.workspace),
          ...Object.values(manifest.app?.files ?? {}).flatMap((file) =>
            [file.base, file.content].filter((hash): hash is string => hash !== null),
          ),
        ];
        const total = references.reduce(
          (bytes, hash) => bytes + Buffer.byteLength(contents[hash] ?? "", "base64"),
          0,
        );
        if (total > FARM_CODE_MAX_BYTES) throw new CodeInput("farm code is too large");
        for (const [hash, content] of Object.entries(blobs))
          await tx.insert(farmCodeBlobs).values({ farmId, hash, content }).onConflictDoNothing();
        const id = createHash("sha256").update(JSON.stringify({ parent, manifest })).digest("hex");
        await tx.insert(farmCodeCommits).values({ farmId, id, parent, manifest });
        await tx
          .update(farmCodeHeads)
          .set({ commitId: id })
          .where(eq(farmCodeHeads.farmId, farmId));
        return { id, parent, manifest };
      });
      return c.json({ head });
    } catch (error) {
      if (error instanceof CodeConflict)
        return c.json(
          { error: { code: "conflict", message: "farm code head changed; merge and push again" } },
          409,
        );
      if (error instanceof CodeInput)
        return c.json({ error: { code: "bad_request", message: error.message } }, 400);
      throw error;
    }
  });
  return app;
}
