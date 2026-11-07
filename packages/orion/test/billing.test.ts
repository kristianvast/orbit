import { expect, test } from "bun:test";
import { startOrion } from "../src/app";
import { AccountError } from "../src/services/account";
import { BillingService } from "../src/services/billing";
import { connect, removeDir, TOKEN, tempDir } from "./helpers";

const status = {
  plan: "pen",
  interval: "month",
  status: "active",
  currentPeriodEnd: "2026-12-06T00:00:00Z",
  cancelAtPeriodEnd: false,
  usage: {
    tokensUsed: 400,
    tokenAllowance: 3000000,
    voiceSecondsUsed: 120,
    voiceSecondsAllowance: 3600,
  },
} as const;
const account = {
  cloudConnection: () => ({
    url: "https://core.test",
    headers: { authorization: "Bearer stored-session", "x-orbit-farm": "farm-1" },
  }),
};

test("billing relay authenticates every request with the stored session and farm", async () => {
  const billing = new BillingService(account, async (input, init) => {
    const headers = new Headers(init?.headers);
    if (
      headers.get("authorization") !== "Bearer stored-session" ||
      headers.get("x-orbit-farm") !== "farm-1"
    ) {
      return Response.json({ error: { message: "missing farm credentials" } }, { status: 401 });
    }
    const path = new URL(String(input)).pathname;
    if (path === "/v1/billing/status" && init?.method === "GET") return Response.json(status);
    if (
      path === "/v1/billing/checkout" &&
      init?.method === "POST" &&
      init.body === '{"plan":"barn","interval":"year"}'
    ) {
      return Response.json({ url: "https://checkout.stripe.com/test" });
    }
    if (path === "/v1/billing/portal" && init?.method === "POST") {
      return Response.json({ url: "https://billing.stripe.com/test" });
    }
    return new Response(null, { status: 400 });
  });
  expect(await billing.status()).toEqual(status);
  expect(await billing.checkout({ plan: "barn", interval: "year" })).toEqual({
    url: "https://checkout.stripe.com/test",
  });
  expect(await billing.portal()).toEqual({ url: "https://billing.stripe.com/test" });
});

test.each([
  [403, "forbidden"],
  [402, "plan_required"],
  [429, "budget_exceeded"],
] as const)("billing translates Core HTTP %i into %s", async (http, code) => {
  const billing = new BillingService(account, async () =>
    Response.json({ error: { message: "Core refusal" } }, { status: http }),
  );
  try {
    await billing.checkout({ plan: "pen", interval: "month" });
    throw new Error("checkout should be refused");
  } catch (error) {
    expect(error).toBeInstanceOf(AccountError);
    expect(error).toMatchObject({ code });
  }
});

test("signed-out protocol billing request asks the farmer to sign in", async () => {
  const dir = tempDir();
  const app = await startOrion({
    port: 0,
    token: TOKEN,
    dataDir: dir,
    mockModel: true,
    seed: true,
    gatewayUrl: null,
    appSource: null,
    coreUrl: "https://core.test",
  });
  const client = await connect(app);
  try {
    await expect(client.request("billing.status", {})).rejects.toMatchObject({
      code: "unauthorized",
    });
  } finally {
    client.close();
    await app.stop();
    removeDir(dir);
  }
});
