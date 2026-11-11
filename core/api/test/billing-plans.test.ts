import { expect, test } from "bun:test";
import { billingFixture } from "./billing-fixture";

const { app, headers } = billingFixture();
const catalog = [
  { id: "free", name: "Free", cameras: 0, monthly: 0, yearly: 0, orionTokens: 0, voiceMinutes: 0 },
  {
    id: "orion",
    name: "Orion",
    cameras: 0,
    monthly: 20,
    yearly: 200,
    orionTokens: 2_000_000,
    voiceMinutes: 30,
  },
  {
    id: "cam2",
    name: "2 cameras",
    cameras: 2,
    monthly: 49,
    yearly: 490,
    orionTokens: 3_000_000,
    voiceMinutes: 60,
  },
  {
    id: "cam4",
    name: "4 cameras",
    cameras: 4,
    monthly: 75,
    yearly: 750,
    orionTokens: 5_000_000,
    voiceMinutes: 100,
  },
  {
    id: "cam6",
    name: "6 cameras",
    cameras: 6,
    monthly: 95,
    yearly: 950,
    orionTokens: 8_000_000,
    voiceMinutes: 150,
  },
] as const;

test.each([undefined, "Bearer unknown", "Bearer orb_s_unknown", "Bearer legacy-farm-token"])(
  "plans return the complete EUR catalog publicly without requiring a session (%s)",
  async (authorization) => {
    const response = await app().request("/v1/billing/plans", {
      headers: { origin: "http://localhost:3000", ...(authorization ? { authorization } : {}) },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(await response.json()).toEqual({
      currency: "eur",
      locked: false,
      trialDays: 30,
      plans: catalog,
      hardware: [
        { id: "box", name: "Pecorva box", price: 920 },
        { id: "camera", name: "Tested camera", price: 150 },
      ],
    });
  },
);

test("a signed-in account receives the same EUR catalog without a farm header", async () => {
  const response = await app().request("/v1/billing/plans", {
    headers: { authorization: headers().authorization },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    currency: "eur",
    locked: false,
    trialDays: 30,
    plans: catalog,
    hardware: [
      { id: "box", name: "Pecorva box", price: 920 },
      { id: "camera", name: "Tested camera", price: 150 },
    ],
  });
});
