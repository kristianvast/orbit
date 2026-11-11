import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { type AppOptions, createApp } from "../src/app";
import { createSession } from "../src/auth";
import { type CoreDb, coreSchema, farmMembers, feedback, submissions, users } from "../src/db";
import { createLogMailer } from "../src/mailer";
import { migrate } from "../src/migrate";

const FARM = "00000000-0000-4000-8000-0000000000b1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const ADMIN = "test-admin-secret";
const START = Date.parse("2026-11-11T12:00:00Z");
const mail = createLogMailer(() => {});
const client = new PGlite();
const db: CoreDb = drizzle({ client, schema: coreSchema });
let clock = START;
let userId = "";
let token = "";

beforeAll(async () => {
  await migrate(db);
}, 60_000);
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  clock = START;
  mail.sent.length = 0;
  await db.execute(
    sql`truncate feedback, submissions, feedback_rate_events, users, user_sessions, farm_members cascade`,
  );
  const [user] = await db.insert(users).values({ email: "farmer@example.test" }).returning();
  if (!user) throw new TypeError("user fixture failed");
  userId = user.id;
  token = (await createSession(db, userId, null, new Date(clock))).token;
  await db.insert(farmMembers).values({ farmId: FARM, userId, role: "owner" });
});
function app(extra: Partial<AppOptions> = {}) {
  return createApp({
    db,
    resolveToken: async () => null,
    electricUrl: "http://electric",
    mailer: mail,
    now: () => new Date(clock),
    ...extra,
  });
}
const auth = () => ({ authorization: `Bearer ${token}`, "x-orbit-farm": FARM });
const admin = { authorization: `Bearer ${ADMIN}` };
async function call(
  a: ReturnType<typeof app>,
  method: string,
  path: string,
  body?: unknown,
  headers = {},
) {
  const response = await a.request(path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const build = () => ({
  kind: "page",
  name: "herd-overview",
  title: "Herd overview",
  description: "A shared farm view",
  appVersion: "0.1.0",
  files: [{ path: "pages/herd.ts", content: "export const title = 'Herd';" }],
});

describe("feedback", () => {
  test.each([false, true])("stores feedback with optional session: %s", async (signedIn) => {
    const response = await call(
      app(),
      "POST",
      "/v1/feedback",
      {
        kind: "issue",
        message: "The list is empty",
        contactEmail: "contact@example.test",
        appVersion: "1.2.3",
        os: "Windows",
        locale: "en",
        diagnostics: "trace",
      },
      signedIn ? auth() : { "x-orbit-farm": FARM },
    );
    expect(response.status).toBe(201);
    const [row] = await db.select().from(feedback).where(eq(feedback.id, response.body.id));
    expect(row).toMatchObject({
      userId: signedIn ? userId : null,
      farmId: signedIn ? FARM : null,
      kind: "issue",
      message: "The list is empty",
      contactEmail: "contact@example.test",
      appVersion: "1.2.3",
      os: "Windows",
      locale: "en",
      diagnostics: "trace",
      status: "new",
    });
    expect(new Date(row?.createdAt ?? "").getTime()).toBe(START);
  });
  test.each([OTHER, "not-a-uuid"])("ignores a farm the user cannot act on: %s", async (farm) => {
    const response = await call(
      app(),
      "POST",
      "/v1/feedback",
      { kind: "idea", message: "Try this" },
      { ...auth(), "x-orbit-farm": farm },
    );
    expect(response.status).toBe(201);
    const [row] = await db.select().from(feedback);
    expect(row?.farmId).toBeNull();
    expect(row?.userId).toBe(userId);
  });
  test.each([
    null,
    [],
    {},
    { kind: "bug", message: "x" },
    { kind: "issue", message: "" },
    { kind: "issue", message: "x".repeat(5001) },
    { kind: "idea", message: "x", diagnostics: "x".repeat(20001) },
    { kind: "other", message: "x", contactEmail: "invalid" },
    { kind: "other", message: "x", os: 42 },
    { kind: "other", message: "x", locale: null },
  ])("rejects invalid feedback %#", async (body) => {
    const response = await call(app(), "POST", "/v1/feedback", body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("bad_request");
    expect(await db.select().from(feedback)).toHaveLength(0);
  });
  test("malformed JSON returns the error envelope", async () => {
    const response = await app().request("/v1/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "bad_request" } });
  });
  test.each([false, true])(
    "enforces rolling persistent limits, including parallel calls: %s",
    async (signedIn) => {
      const a = app();
      const headers = signedIn ? auth() : { "x-forwarded-for": "spoofed, 192.0.2.1" };
      const results = await Promise.all(
        Array.from({ length: 21 }, () =>
          call(a, "POST", "/v1/feedback", { kind: "other", message: "test" }, headers),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(20);
      expect(results.filter((r) => r.status === 429)).toHaveLength(1);
      const blocked = await call(
        app(),
        "POST",
        "/v1/feedback",
        { kind: "idea", message: "test" },
        headers,
      );
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe("rate_limited");
      const independent = await call(
        a,
        "POST",
        "/v1/feedback",
        { kind: "idea", message: "test" },
        { "x-forwarded-for": "192.0.2.2" },
      );
      expect(independent.status).toBe(201);
      clock += 86_400_000 - 1;
      expect(
        (await call(a, "POST", "/v1/feedback", { kind: "idea", message: "test" }, headers)).status,
      ).toBe(429);
      clock++;
      expect(
        (await call(a, "POST", "/v1/feedback", { kind: "idea", message: "test" }, headers)).status,
      ).toBe(201);
    },
  );
  test("changing a client supplied forwarded hop cannot bypass the IP limit", async () => {
    const a = app();
    for (let n = 0; n < 20; n++) {
      expect(
        (
          await call(
            a,
            "POST",
            "/v1/feedback",
            { kind: "idea", message: "x" },
            { "x-forwarded-for": `192.0.2.${n}, 198.51.100.1` },
          )
        ).status,
      ).toBe(201);
    }
    expect(
      (
        await call(
          a,
          "POST",
          "/v1/feedback",
          { kind: "idea", message: "x" },
          { "x-forwarded-for": "another-spoof, 198.51.100.1" },
        )
      ).status,
    ).toBe(429);
  });
});

describe("submissions", () => {
  test.each([undefined, "legacy-farm-token", "orb_s_invalid"])(
    "requires a valid session: %s",
    async (value) => {
      const headers = value ? { authorization: `Bearer ${value}` } : {};
      const a = app({ resolveToken: async () => FARM });
      expect((await call(a, "POST", "/v1/submissions", build(), headers)).status).toBe(401);
      expect((await call(a, "GET", "/v1/submissions", undefined, headers)).status).toBe(401);
    },
  );
  test("stores UTF-8 bytes and the member farm", async () => {
    const input = { ...build(), files: [{ path: "_src/page.ts", content: "ø🐄" }] };
    const response = await call(app(), "POST", "/v1/submissions", input, auth());
    expect(response.status).toBe(201);
    expect(response.body.status).toBe("pending");
    const [row] = await db.select().from(submissions);
    expect(row).toMatchObject({
      userId,
      farmId: FARM,
      bytes: 6,
      files: input.files,
      status: "pending",
    });
  });
  test.each([
    "/absolute.ts",
    "../secret",
    "src/../secret",
    "src//file",
    "./file",
    "C:/file",
    "src\\file",
    "-file",
    "src/.hidden",
    "src/file..ts",
    "x".repeat(201),
    "src/",
  ])("rejects unsafe file paths: %s", async (path) => {
    const response = await call(
      app(),
      "POST",
      "/v1/submissions",
      { ...build(), files: [{ path, content: "text" }] },
      auth(),
    );
    expect(response.status).toBe(400);
    expect(await db.select().from(submissions)).toHaveLength(0);
  });
  test.each([
    { name: "Uppercase" },
    { name: "x".repeat(49) },
    { title: "" },
    { title: "x".repeat(121) },
    { description: "" },
    { description: "x".repeat(2001) },
    { kind: "unknown" },
    { files: [] },
    { files: Array.from({ length: 61 }, () => ({ path: "x", content: "" })) },
    { files: [{ path: "x", content: 123 }] },
    { files: [{ path: "x", content: "\ud800" }] },
  ])("rejects invalid builds %#", async (invalid) => {
    expect(
      (await call(app(), "POST", "/v1/submissions", { ...build(), ...invalid }, auth())).status,
    ).toBe(400);
  });
  test("accepts exactly 512 KiB and rejects larger UTF-8 content across files", async () => {
    const a = app();
    expect(
      (
        await call(
          a,
          "POST",
          "/v1/submissions",
          {
            ...build(),
            files: [{ path: "a", content: "ø".repeat(256 * 1024) }],
          },
          auth(),
        )
      ).status,
    ).toBe(201);
    const response = await call(
      a,
      "POST",
      "/v1/submissions",
      {
        ...build(),
        files: [
          { path: "a", content: "ø".repeat(256 * 1024) },
          { path: "b", content: "x" },
        ],
      },
      auth(),
    );
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe("too_large");
    expect(await db.select().from(submissions)).toHaveLength(1);
  });
  test("lists only the caller's own submissions newest first without bodies", async () => {
    const a = app();
    const first = await call(a, "POST", "/v1/submissions", build(), auth());
    clock += 1000;
    const second = await call(a, "POST", "/v1/submissions", { ...build(), name: "second" }, auth());
    const [other] = await db.insert(users).values({ email: "other@example.test" }).returning();
    if (!other) throw new TypeError("other user fixture failed");
    const otherToken = (await createSession(db, other.id, null, new Date(clock))).token;
    await call(
      a,
      "POST",
      "/v1/submissions",
      { ...build(), name: "private" },
      { authorization: `Bearer ${otherToken}` },
    );
    const response = await call(a, "GET", "/v1/submissions", undefined, auth());
    expect(response.status).toBe(200);
    expect(response.body.submissions).toEqual([
      {
        id: second.body.id,
        kind: "page",
        name: "second",
        title: "Herd overview",
        status: "pending",
        reviewNote: null,
        createdAt: new Date(clock).toISOString(),
        reviewedAt: null,
      },
      {
        id: first.body.id,
        kind: "page",
        name: "herd-overview",
        title: "Herd overview",
        status: "pending",
        reviewNote: null,
        createdAt: new Date(START).toISOString(),
        reviewedAt: null,
      },
    ]);
  });
});

describe("owner review", () => {
  const paths = [
    ["GET", "/v1/admin/feedback"],
    ["PATCH", `/v1/admin/feedback/${FARM}`],
    ["GET", "/v1/admin/submissions"],
    ["GET", `/v1/admin/submissions/${FARM}`],
    ["PATCH", `/v1/admin/submissions/${FARM}`],
  ];
  test.each(paths)("disabled admin returns 404: %s %s", async (method, path) => {
    const response = await call(app(), method ?? "", path ?? "", { status: "done" }, admin);
    expect(response.status).toBe(404);
  });
  test.each(paths)("wrong admin token returns 401: %s %s", async (method, path) => {
    expect(
      (
        await call(app({ adminToken: ADMIN }), method ?? "", path ?? "", undefined, {
          authorization: "Bearer wrong",
        })
      ).status,
    ).toBe(401);
  });
  test("admin HTML is disabled without a token and served without assets when enabled", async () => {
    expect((await app().request("/admin")).status).toBe(404);
    const response = await app({ adminToken: ADMIN }).request("/admin");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  test("lists feedback, changes status and filters the result", async () => {
    const a = app({ adminToken: ADMIN });
    const created = await call(a, "POST", "/v1/feedback", {
      kind: "idea",
      message: "A better view",
    });
    const listed = await call(a, "GET", "/v1/admin/feedback", undefined, admin);
    expect(listed.body.feedback).toHaveLength(1);
    expect(listed.body.feedback[0]).toMatchObject({
      id: created.body.id,
      message: "A better view",
      status: "new",
    });
    const updated = await call(
      a,
      "PATCH",
      `/v1/admin/feedback/${created.body.id}`,
      { status: "done" },
      admin,
    );
    expect(updated.status).toBe(200);
    expect(updated.body.status).toBe("done");
    expect(
      (await call(a, "GET", "/v1/admin/feedback?status=new", undefined, admin)).body.feedback,
    ).toEqual([]);
    expect(
      (await call(a, "GET", "/v1/admin/feedback?status=done", undefined, admin)).body.feedback,
    ).toHaveLength(1);
  });
  test("reviews builds with metadata lists and file bodies only in detail", async () => {
    const a = app({ adminToken: ADMIN });
    const created = await call(a, "POST", "/v1/submissions", build(), auth());
    const path = `/v1/admin/submissions/${created.body.id}`;
    const listed = await call(a, "GET", "/v1/admin/submissions?status=pending", undefined, admin);
    expect(listed.body.submissions).toHaveLength(1);
    expect(listed.body.submissions[0]).not.toHaveProperty("files");
    const detail = await call(a, "GET", path, undefined, admin);
    expect(detail.body.files).toEqual(build().files);
    clock += 2000;
    const reviewed = await call(
      a,
      "PATCH",
      path,
      { status: "approved", reviewNote: "Ready to share" },
      admin,
    );
    expect(reviewed.status).toBe(200);
    expect(reviewed.body).toMatchObject({
      status: "approved",
      reviewNote: "Ready to share",
      reviewedAt: new Date(clock).toISOString(),
    });
    const own = await call(a, "GET", "/v1/submissions", undefined, auth());
    expect(own.body.submissions[0].reviewNote).toBe("Ready to share");
    expect(
      (await call(a, "GET", "/v1/admin/submissions?status=pending", undefined, admin)).body
        .submissions,
    ).toEqual([]);
    const pending = await call(a, "PATCH", path, { status: "pending" }, admin);
    expect(pending.body).toMatchObject({
      status: "pending",
      reviewNote: "Ready to share",
      reviewedAt: null,
    });
    const rejected = await call(a, "PATCH", path, { status: "rejected", reviewNote: "" }, admin);
    expect(rejected.body).toMatchObject({
      status: "rejected",
      reviewNote: "",
      reviewedAt: new Date(clock).toISOString(),
    });
  });
  test("rejects invalid review input and missing resources", async () => {
    const a = app({ adminToken: ADMIN });
    expect(
      (await call(a, "PATCH", `/v1/admin/feedback/${FARM}`, { status: "approved" }, admin)).status,
    ).toBe(400);
    expect(
      (await call(a, "PATCH", `/v1/admin/submissions/${FARM}`, { status: "done" }, admin)).status,
    ).toBe(400);
    expect(
      (
        await call(
          a,
          "PATCH",
          `/v1/admin/submissions/${FARM}`,
          { status: "approved", reviewNote: 12 },
          admin,
        )
      ).status,
    ).toBe(400);
    expect(
      (await call(a, "GET", "/v1/admin/feedback?status=unknown", undefined, admin)).status,
    ).toBe(400);
    expect((await call(a, "GET", "/v1/admin/submissions/not-uuid", undefined, admin)).status).toBe(
      400,
    );
    expect((await call(a, "GET", `/v1/admin/submissions/${FARM}`, undefined, admin)).status).toBe(
      404,
    );
    expect(
      (await call(a, "PATCH", `/v1/admin/feedback/${FARM}`, { status: "done" }, admin)).status,
    ).toBe(404);
    expect(
      (await call(a, "PATCH", `/v1/admin/submissions/${FARM}`, { status: "approved" }, admin))
        .status,
    ).toBe(404);
  });
});

test("sends notifications through the log mailer without submission file bodies", async () => {
  const a = app({ feedbackEmail: "review@example.test" });
  await call(
    a,
    "POST",
    "/v1/feedback",
    { kind: "issue", message: "Help with this", appVersion: "2.3", os: "Windows" },
    auth(),
  );
  await call(a, "POST", "/v1/submissions", build(), auth());
  expect(mail.sent.map((m) => m.template)).toEqual(["feedback_received", "submission_received"]);
  expect(mail.sent.every((m) => m.to === "review@example.test")).toBe(true);
  expect(mail.sent[0]?.text).toContain("Help with this");
  expect(mail.sent[0]?.text).toContain("farmer@example.test");
  expect(mail.sent[0]?.text).toContain("2.3");
  expect(mail.sent[0]?.text).toContain("Windows");
  expect(mail.sent[1]?.text).toContain("pages/herd.ts");
  expect(mail.sent[1]?.text).not.toContain(build().files[0]?.content ?? "");
});
test("a failed notification still persists and accepts both requests", async () => {
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const a = app({
      feedbackEmail: "review@example.test",
      mailer: {
        async send() {
          throw new Error("mail unavailable");
        },
      },
    });
    expect(
      (await call(a, "POST", "/v1/feedback", { kind: "other", message: "hello" })).status,
    ).toBe(201);
    expect((await call(a, "POST", "/v1/submissions", build(), auth())).status).toBe(201);
    expect(await db.select().from(feedback)).toHaveLength(1);
    expect(await db.select().from(submissions)).toHaveLength(1);
    expect(warning).toHaveBeenCalledTimes(2);
  } finally {
    warning.mockRestore();
  }
});
test.each(["/v1/feedback", "/v1/submissions"])("allows website CORS on %s", async (path) => {
  const response = await app().request(path, {
    method: "OPTIONS",
    headers: {
      origin: "http://localhost:3000",
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type,x-orbit-farm",
    },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  expect(response.headers.get("access-control-allow-headers")).toContain("x-orbit-farm");
});
