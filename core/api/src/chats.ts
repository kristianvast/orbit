import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { memberRole, resolveSession } from "./auth";
import { chatEntries, chatSessions } from "./chat-db";
import { date, entry, record, title, UUID } from "./chat-input";
import type { CoreDb } from "./db";

/** Private REST history, usable by native clients without an Orion process. */
export function createChatRoutes(db: CoreDb, now: () => Date) {
  const app = new Hono<{ Variables: { farmId: string; userId: string } }>();
  app.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
  app.use("*", async (c, next) => {
    const token = /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? "";
    const user = await resolveSession(db, token, now());
    if (!user)
      return c.json({ error: { code: "unauthorized", message: "user session required" } }, 401);
    const farmId = c.req.header("x-orbit-farm") ?? "";
    if (!UUID.test(farmId))
      return c.json({ error: { code: "bad_request", message: "farm header required" } }, 400);
    if (!(await memberRole(db, farmId, user.id)))
      return c.json({ error: { code: "forbidden", message: "farm membership required" } }, 403);
    const id = c.req.param("id");
    if (id && !UUID.test(id))
      return c.json({ error: { code: "bad_request", message: "invalid session id" } }, 400);
    c.set("farmId", farmId);
    c.set("userId", user.id);
    await next();
  });
  app.get("/sessions", async (c) => {
    const after = c.req.query("after");
    if (after && !UUID.test(after))
      return c.json({ error: { code: "bad_request", message: "invalid cursor" } }, 400);
    const sessions = await db
      .select({
        id: chatSessions.id,
        title: chatSessions.title,
        createdAt: chatSessions.createdAt,
        updatedAt: chatSessions.updatedAt,
        parentSessionId: chatSessions.parentSessionId,
        deletedAt: chatSessions.deletedAt,
        messageCount: sql<number>`(select count(*)::int from chat_entries e where e.farm_id = "chat_sessions"."farm_id" and e.user_id = "chat_sessions"."user_id" and e.session_id = "chat_sessions"."id" and e.entry->>'type' = 'message' and e.entry->'message'->>'role' in ('user','assistant'))`,
      })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.farmId, c.get("farmId")),
          eq(chatSessions.userId, c.get("userId")),
          after ? gt(chatSessions.id, after) : undefined,
        ),
      )
      .orderBy(asc(chatSessions.id))
      .limit(100);
    return c.json({
      sessions: sessions.map((s) => ({
        ...s,
        createdAt: new Date(s.createdAt).toISOString(),
        updatedAt: new Date(s.updatedAt).toISOString(),
        deletedAt: s.deletedAt ? new Date(s.deletedAt).toISOString() : null,
      })),
      next: sessions.length === 100 ? sessions.at(-1)?.id : null,
    });
  });
  app.get("/sessions/:id/entries", async (c) => {
    const { farmId, userId } = c.var;
    const id = c.req.param("id");
    const after = Number(c.req.query("after") ?? 0);
    if (!Number.isSafeInteger(after) || after < 0)
      return c.json({ error: { code: "bad_request", message: "invalid cursor" } }, 400);
    const [session] = await db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.farmId, farmId),
          eq(chatSessions.userId, userId),
          eq(chatSessions.id, id),
        ),
      );
    if (!session || session.deletedAt)
      return c.json({ error: { code: "not_found", message: "session not found" } }, 404);
    const rows = await db
      .select()
      .from(chatEntries)
      .where(
        and(
          eq(chatEntries.farmId, farmId),
          eq(chatEntries.userId, userId),
          eq(chatEntries.sessionId, id),
          gt(chatEntries.seq, after),
        ),
      )
      .orderBy(asc(chatEntries.seq))
      .limit(20);
    return c.json({
      header: session.header,
      entries: rows.map((r) => r.entry),
      next: rows.length === 20 ? rows.at(-1)?.seq : null,
    });
  });
  app.post("/sessions/:id/entries", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const id = c.req.param("id");
    if (
      !record(body) ||
      !record(body.session) ||
      !title(body.session.title) ||
      !date(body.session.createdAt) ||
      !date(body.session.updatedAt) ||
      !(
        body.session.parentSessionId === null ||
        (typeof body.session.parentSessionId === "string" &&
          UUID.test(body.session.parentSessionId))
      ) ||
      !record(body.header) ||
      body.header.type !== "session" ||
      body.header.id !== id ||
      body.header.version !== 3 ||
      !date(body.header.timestamp) ||
      typeof body.header.cwd !== "string" ||
      !Array.isArray(body.entries) ||
      body.entries.length > 100 ||
      !body.entries.every(entry)
    )
      return c.json(
        { error: { code: "bad_request", message: "invalid chat session or entries" } },
        400,
      );
    const { farmId, userId } = c.var;
    const session = {
      farmId,
      userId,
      id,
      title: body.session.title,
      createdAt: new Date(body.session.createdAt).toISOString(),
      updatedAt: new Date(body.session.updatedAt).toISOString(),
      parentSessionId: body.session.parentSessionId,
      header: body.header,
    };
    const entries = body.entries;
    const accepted = await db.transaction(async (tx) => {
      await tx
        .insert(chatSessions)
        .values(session)
        .onConflictDoUpdate({
          target: [chatSessions.farmId, chatSessions.userId, chatSessions.id],
          set: { title: session.title, updatedAt: session.updatedAt },
          setWhere: and(
            isNull(chatSessions.deletedAt),
            gt(sql`${session.updatedAt}::timestamptz`, chatSessions.updatedAt),
          ),
        });
      const [row] = await tx
        .select()
        .from(chatSessions)
        .where(
          and(
            eq(chatSessions.farmId, farmId),
            eq(chatSessions.userId, userId),
            eq(chatSessions.id, id),
          ),
        )
        .for("update");
      if (row?.deletedAt) return "deleted";
      const stored = await tx
        .select({ id: chatEntries.id })
        .from(chatEntries)
        .where(
          and(
            eq(chatEntries.farmId, farmId),
            eq(chatEntries.userId, userId),
            eq(chatEntries.sessionId, id),
          ),
        );
      const known = new Set(stored.map((e) => e.id));
      for (const e of entries) {
        if (known.has(e.id)) continue;
        if (e.parentId !== null && !known.has(e.parentId)) return "invalid";
        known.add(e.id);
      }
      if (entries.length)
        await tx
          .insert(chatEntries)
          .values(
            entries.map((e) => ({
              farmId,
              userId,
              sessionId: id,
              id: e.id,
              entry: e,
            })),
          )
          .onConflictDoNothing();
      return "accepted";
    });
    switch (accepted) {
      case "accepted":
        return c.json({ ok: true });
      case "deleted":
        return c.json({ error: { code: "conflict", message: "session deleted" } }, 409);
      case "invalid":
        return c.json(
          { error: { code: "bad_request", message: "entries must follow their parents" } },
          400,
        );
    }
  });
  app.patch("/sessions/:id", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!record(body) || !title(body.title) || !date(body.updatedAt))
      return c.json(
        { error: { code: "bad_request", message: "title and updatedAt required" } },
        400,
      );
    const updatedAt = new Date(body.updatedAt).toISOString();
    const rows = await db
      .update(chatSessions)
      .set({ title: body.title, updatedAt })
      .where(
        and(
          eq(chatSessions.farmId, c.get("farmId")),
          eq(chatSessions.userId, c.get("userId")),
          eq(chatSessions.id, c.req.param("id")),
          isNull(chatSessions.deletedAt),
          gt(sql`${updatedAt}::timestamptz`, chatSessions.updatedAt),
        ),
      )
      .returning({ id: chatSessions.id });
    return c.json({ updated: rows.length > 0 });
  });
  app.delete("/sessions/:id", async (c) => {
    const timestamp = now().toISOString();
    await db
      .insert(chatSessions)
      .values({
        farmId: c.get("farmId"),
        userId: c.get("userId"),
        id: c.req.param("id"),
        title: "",
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: [chatSessions.farmId, chatSessions.userId, chatSessions.id],
        set: { deletedAt: timestamp, updatedAt: timestamp },
      });
    return c.json({ ok: true });
  });
  return app;
}
