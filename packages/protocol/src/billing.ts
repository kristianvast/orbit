import { type Static, Type } from "typebox";

export const BillingStatus = Type.Object({
  plan: Type.Enum(["free", "pen", "barn"]),
  interval: Type.Union([Type.Enum(["month", "year"]), Type.Null()]),
  status: Type.String(),
  currentPeriodEnd: Type.Union([Type.String(), Type.Null()]),
  cancelAtPeriodEnd: Type.Boolean(),
  usage: Type.Object({
    tokensUsed: Type.Number({ minimum: 0 }),
    tokenAllowance: Type.Number({ minimum: 0 }),
    voiceSecondsUsed: Type.Number({ minimum: 0 }),
    voiceSecondsAllowance: Type.Number({ minimum: 0 }),
  }),
});
export type BillingStatus = Static<typeof BillingStatus>;

export const BillingRequests = {
  "billing.status": { params: Type.Object({}), result: BillingStatus },
  "billing.checkout": {
    params: Type.Object({
      plan: Type.Enum(["pen", "barn"]),
      interval: Type.Enum(["month", "year"]),
    }),
    result: Type.Object({ url: Type.String() }),
  },
  "billing.portal": {
    params: Type.Object({}),
    result: Type.Object({ url: Type.String() }),
  },
} as const;
