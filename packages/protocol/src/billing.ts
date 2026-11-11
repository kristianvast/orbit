import { type Static, Type } from "typebox";

export const BillingStatus = Type.Object({
  plan: Type.Enum(["free", "orion", "cam2", "cam4", "cam6"]),
  interval: Type.Union([Type.Enum(["month", "year"]), Type.Null()]),
  status: Type.String(),
  currentPeriodEnd: Type.Union([Type.String(), Type.Null()]),
  trialEndsAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  cancelAtPeriodEnd: Type.Boolean(),
  usage: Type.Object({
    tokensUsed: Type.Number({ minimum: 0 }),
    tokenAllowance: Type.Number({ minimum: 0 }),
    voiceSecondsUsed: Type.Number({ minimum: 0 }),
    voiceSecondsAllowance: Type.Number({ minimum: 0 }),
  }),
});
export type BillingStatus = Static<typeof BillingStatus>;

export const BillingPlans = Type.Object({
  currency: Type.Literal("eur"),
  locked: Type.Boolean(),
  trialDays: Type.Number({ minimum: 0 }),
  plans: Type.Array(
    Type.Object({
      id: Type.Enum(["free", "orion", "cam2", "cam4", "cam6"]),
      name: Type.String(),
      cameras: Type.Number({ minimum: 0 }),
      monthly: Type.Optional(Type.Number({ minimum: 0 })),
      yearly: Type.Optional(Type.Number({ minimum: 0 })),
      orionTokens: Type.Number({ minimum: 0 }),
      voiceMinutes: Type.Number({ minimum: 0 }),
    }),
  ),
  hardware: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.String(),
      price: Type.Optional(Type.Number({ minimum: 0 })),
    }),
  ),
});
export type BillingPlans = Static<typeof BillingPlans>;

export const BillingRequests = {
  "billing.plans": { params: Type.Object({}), result: BillingPlans },
  "billing.status": { params: Type.Object({}), result: BillingStatus },
  "billing.checkout": {
    params: Type.Object({
      plan: Type.Enum(["orion", "cam2", "cam4", "cam6"]),
      interval: Type.Enum(["month", "year"]),
    }),
    result: Type.Object({ url: Type.String() }),
  },
  "billing.portal": {
    params: Type.Object({}),
    result: Type.Object({ url: Type.String() }),
  },
} as const;
