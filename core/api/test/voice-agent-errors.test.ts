import { expect, test } from "bun:test";
import { farmSubscriptions, voiceUsage } from "../src/db";
import { billingFixture, FARM, NOW } from "./billing-fixture";
import { serveAgent } from "./voice-agent-fixture";

const { db, headers } = billingFixture();
async function paid() {
  await db.insert(farmSubscriptions).values({
    farmId: FARM,
    plan: "orion",
    interval: "month",
    status: "active",
  });
}

test.each([
  { name: "missing session", headers: {}, paid: false, used: 0, status: 401, code: "unauthorized" },
  {
    name: "bad session",
    headers: { authorization: "Bearer invalid" },
    paid: false,
    used: 0,
    status: 401,
    code: "unauthorized",
  },
  {
    name: "missing farm",
    headers: { "x-orbit-farm": "" },
    paid: false,
    used: 0,
    status: 400,
    code: "bad_request",
  },
  {
    name: "nonmember farm",
    headers: { "x-orbit-farm": "00000000-0000-4000-8000-000000000099" },
    paid: false,
    used: 0,
    status: 403,
    code: "forbidden",
  },
  { name: "no allowance", headers: null, paid: false, used: 0, status: 402, code: "plan_required" },
  {
    name: "spent allowance",
    headers: null,
    paid: true,
    used: 1800,
    status: 429,
    code: "budget_exceeded",
  },
])("agent refuses $name before upgrading", async (row) => {
  if (row.paid) await paid();
  if (row.used)
    await db.insert(voiceUsage).values({
      farmId: FARM,
      model: "live",
      seconds: row.used,
      createdAt: NOW.toISOString(),
    });
  const gateway = serveAgent(db, {
    now: () => NOW,
    fetch: async () => {
      throw new TypeError("Must not reach provider");
    },
  });
  try {
    const response = await fetch(gateway.url, {
      headers: row.name === "missing session" ? {} : { ...headers(), ...row.headers },
    });
    expect(response.status).toBe(row.status);
    expect(await response.json()).toMatchObject({ error: { code: row.code } });
  } finally {
    await gateway.server.stop(true);
  }
});

test.each([
  { name: "missing agent id", agentId: "", apiKey: "secret", status: 503, code: "not_configured" },
  { name: "missing API key", agentId: "agent", apiKey: "", status: 503, code: "not_configured" },
  {
    name: "provider rejection",
    response: () => new Response("denied", { status: 403 }),
    status: 502,
    code: "upstream_error",
  },
  {
    name: "missing signed URL",
    response: () => Response.json({}),
    status: 502,
    code: "upstream_error",
  },
  {
    name: "malformed provider JSON",
    response: () => new Response("{"),
    status: 502,
    code: "upstream_error",
  },
  {
    name: "provider unreachable",
    response: () => {
      throw new TypeError("offline");
    },
    status: 502,
    code: "upstream_error",
  },
])("agent returns $status for $name without charging", async (row) => {
  await paid();
  const gateway = serveAgent(db, {
    now: () => NOW,
    ...("agentId" in row ? { agentId: row.agentId, apiKey: row.apiKey } : {}),
    fetch: async () => {
      if ("response" in row && row.response) return row.response();
      throw new TypeError("Must not reach provider");
    },
  });
  try {
    const response = await fetch(gateway.url, { headers: { ...headers(), upgrade: "websocket" } });
    expect(response.status).toBe(row.status);
    expect(await response.json()).toEqual({ error: { code: row.code } });
    expect(await db.select().from(voiceUsage)).toEqual([]);
  } finally {
    await gateway.server.stop(true);
  }
});

test("agent requires a WebSocket upgrade after entitlement checks", async () => {
  await paid();
  const gateway = serveAgent(db, { now: () => NOW });
  try {
    const response = await fetch(gateway.url, { headers: headers() });
    expect(response.status).toBe(426);
    expect(await response.text()).toBe("WebSocket upgrade required");
  } finally {
    await gateway.server.stop(true);
  }
});
