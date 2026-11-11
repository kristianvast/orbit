import { describe, expect, test } from "bun:test";
import {
  decodeClientMessage,
  decodeServerMessage,
  encodeRequest,
  validateResult,
} from "../src/codec";

describe("billing and voice wire contracts", () => {
  test.each([
    { type: "billing.checkout", plan: "orion", interval: "year" },
    { type: "billing.checkout", plan: "cam2", interval: "month" },
    { type: "billing.checkout", plan: "cam4", interval: "year" },
    { type: "billing.checkout", plan: "cam6", interval: "month" },
    { type: "billing.plans" },
    { type: "billing.portal" },
    { type: "billing.status" },
    { type: "voice.start", sessionId: "s" },
    { type: "voice.audio", voiceId: "v", data: "AAAA" },
    { type: "voice.stop", voiceId: "v" },
    { type: "voice.text", voiceId: "v", text: "How is the herd?" },
  ])("accepts $type requests", (frame) => {
    expect(decodeClientMessage(JSON.stringify({ id: "1", ...frame })).ok).toBe(true);
  });

  test.each([
    { type: "billing.checkout", plan: "free", interval: "month" },
    { type: "billing.checkout", plan: "pen", interval: "month" },
    { type: "billing.checkout", plan: "barn", interval: "month" },
    { type: "billing.checkout", plan: "cam2", interval: "week" },
    { type: "voice.audio", voiceId: "v", data: "not audio!" },
    { type: "voice.audio", voiceId: "v", data: "A".repeat(87388) },
    { type: "voice.start" },
  ])("rejects malformed $type", (frame) => {
    expect(decodeClientMessage(JSON.stringify({ id: "1", ...frame })).ok).toBe(false);
  });

  test("validates billing status usage and nullable subscription fields", () => {
    const status = {
      plan: "free",
      interval: null,
      status: "free",
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      usage: { tokensUsed: 0, tokenAllowance: 0, voiceSecondsUsed: 0, voiceSecondsAllowance: 0 },
    };
    expect(validateResult("billing.status", status).ok).toBe(true);
    expect(validateResult("billing.status", { ...status, trialEndsAt: 30 }).ok).toBe(false);
    for (const plan of ["free", "orion", "cam2", "cam4", "cam6"]) {
      for (const trialEndsAt of ["2026-12-01T00:00:00Z", null]) {
        expect(validateResult("billing.status", { ...status, plan, trialEndsAt }).ok).toBe(true);
      }
    }
    expect(
      validateResult("billing.status", { ...status, usage: { ...status.usage, tokensUsed: -1 } })
        .ok,
    ).toBe(false);
  });

  test.each([false, true])("validates the billing catalogue when locked=%s", (locked) => {
    const catalogue = {
      currency: "eur",
      locked,
      trialDays: 30,
      plans: [
        {
          id: "orion",
          name: "Orion",
          cameras: 0,
          orionTokens: 2000000,
          voiceMinutes: 30,
          ...(locked ? {} : { monthly: 20, yearly: 200 }),
        },
      ],
      hardware: [{ id: "box", name: "Pecorva box", ...(locked ? {} : { price: 920 }) }],
    };
    expect(validateResult("billing.plans", catalogue).ok).toBe(true);
    expect(validateResult("billing.plans", { ...catalogue, plans: [{ id: "orion" }] }).ok).toBe(
      false,
    );
    expect(
      validateResult("billing.plans", {
        ...catalogue,
        hardware: [{ id: "box", name: "Box", price: "920" }],
      }).ok,
    ).toBe(false);
  });

  test.each([
    { type: "voice.state", state: "listening" },
    { type: "voice.audio", data: "AAAA", sampleRate: 24000 },
    { type: "voice.transcript", role: "user", text: "Herd?", final: true },
    { type: "voice.tool", toolCallId: "t", name: "db_query", state: "done", result: "{}" },
  ])("accepts $type events", (frame) => {
    expect(decodeServerMessage(JSON.stringify({ sessionId: "s", voiceId: "v", ...frame })).ok).toBe(
      true,
    );
  });

  test("uses the named observation mutation codec", () => {
    const raw = encodeRequest("1", "db.mutate", {
      mutation: "observations.add",
      params: { kind: "weight", ts: "2026-11-06T12:00:00Z", valueNum: 510 },
    });
    expect(decodeClientMessage(raw).ok).toBe(true);
  });
});
