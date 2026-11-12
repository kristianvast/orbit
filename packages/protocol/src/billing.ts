import { type Static, Type } from "typebox";
import { UsageSource } from "./account";

const PlanId = Type.Enum(["free", "orion", "cam2", "cam4", "cam6"]);

/** One billing account's allowance: the farm's plan or the person's own plan. */
export const AccountAllowance = Type.Object({
  plan: PlanId,
  trialEndsAt: Type.Union([Type.String(), Type.Null()]),
  tokensUsed: Type.Number({ minimum: 0 }),
  tokenAllowance: Type.Number({ minimum: 0 }),
});
export type AccountAllowance = Static<typeof AccountAllowance>;

export const BillingAccount = Type.Enum(["farm", "personal"]);
export type BillingAccount = Static<typeof BillingAccount>;

/** The plan that pays for this person's Orion right now (`account`), plus both sides for the switch. */
export const BillingStatus = Type.Object({
  plan: PlanId,
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
  account: Type.Optional(BillingAccount),
  /** The member's stored choice; null = automatic (farm plan when allowed and it has an allowance). */
  usageSource: Type.Optional(Type.Union([UsageSource, Type.Null()])),
  /** False without a farm, or when the farm's owners have not allowed this member. */
  farmPlanAllowed: Type.Optional(Type.Boolean()),
  /** This member's farm-plan tokens this calendar month and the owner's limit; null without a farm. */
  member: Type.Optional(
    Type.Union([
      Type.Object({
        tokensUsed: Type.Number({ minimum: 0 }),
        tokenLimit: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
      }),
      Type.Null(),
    ]),
  ),
  personal: Type.Optional(AccountAllowance),
  farm: Type.Optional(Type.Union([AccountAllowance, Type.Null()])),
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
  /** Switches this person between the farm's plan and their own plan on the open farm. */
  "billing.setSource": {
    params: Type.Object({ source: Type.Union([UsageSource, Type.Null()]) }),
    result: BillingStatus,
  },
  /** account: whose plan to buy; the farm's by default when a farm is open and you manage it. */
  "billing.checkout": {
    params: Type.Object({
      plan: Type.Enum(["orion", "cam2", "cam4", "cam6"]),
      interval: Type.Enum(["month", "year"]),
      account: Type.Optional(BillingAccount),
    }),
    result: Type.Object({ url: Type.String() }),
  },
  "billing.portal": {
    params: Type.Object({ account: Type.Optional(BillingAccount) }),
    result: Type.Object({ url: Type.String() }),
  },
} as const;
