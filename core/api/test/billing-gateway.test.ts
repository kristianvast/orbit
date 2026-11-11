import { expect, test } from "bun:test";
import { farmBudgets, farmSubscriptions, llmUsage, voiceUsage } from "../src/db";
import { billingFixture, FARM, NOW } from "./billing-fixture";

const { app, db, headers } = billingFixture();
async function paid() {
  await db
    .insert(farmSubscriptions)
    .values({ farmId: FARM, plan: "cam2", interval: "month", status: "active" });
}
test("a free session farm gets plan_required before calling a model", async () => {
  const response = await app({
    fetch: async () => {
      throw new TypeError("Must not reach upstream");
    },
  }).request("/v1/llm/v1/chat/completions", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ model: "orbit-default" }),
  });
  expect(response.status).toBe(402);
  expect(await response.json()).toMatchObject({ error: { code: "plan_required" } });
});
test("a paid farm at its allowance gets budget_exceeded", async () => {
  await paid();
  await db.insert(llmUsage).values({
    farmId: FARM,
    path: "/v1/chat/completions",
    status: 200,
    totalTokens: 3_000_000,
    createdAt: NOW.toISOString(),
  });
  const response = await app().request("/v1/llm/v1/chat/completions", {
    method: "POST",
    headers: headers(),
    body: "{}",
  });
  expect(response.status).toBe(429);
  expect(await response.json()).toMatchObject({
    error: { code: "budget_exceeded", budget: 3_000_000 },
  });
});
test("a farm budget override wins over its paid plan allowance", async () => {
  await paid();
  await db.insert(farmBudgets).values({ farmId: FARM, monthlyTokenBudget: 4 });
  await db.insert(llmUsage).values({
    farmId: FARM,
    path: "/x",
    status: 200,
    totalTokens: 4,
    createdAt: NOW.toISOString(),
  });
  const response = await app().request("/v1/llm/v1/chat/completions", {
    method: "POST",
    headers: headers(),
    body: "{}",
  });
  expect(response.status).toBe(429);
  expect(await response.json()).toMatchObject({ error: { budget: 4 } });
});
test("Vertex thinking tokens count toward the farm allowance", async () => {
  await paid();
  const response = await app({
    fetch: async () =>
      Response.json({
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 68 },
      }),
  }).request("/v1/llm/v1/chat/completions", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ model: "gemini" }),
  });
  expect(response.status).toBe(200);
  expect(await db.select().from(llmUsage)).toMatchObject([
    { inputTokens: 8, outputTokens: 60, totalTokens: 68 },
  ]);
});
test("billing status includes metered voice usage", async () => {
  await paid();
  await db
    .insert(voiceUsage)
    .values({ farmId: FARM, seconds: 123, model: "gemini-3.8-live", createdAt: NOW.toISOString() });
  const response = await app().request("/v1/billing/status", { headers: headers() });
  expect(await response.json()).toMatchObject({
    usage: { voiceSecondsUsed: 123, voiceSecondsAllowance: 3600 },
  });
});
