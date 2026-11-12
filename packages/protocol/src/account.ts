// Orbit account (Core sign-in), farm members and invites. The UI never talks to Core directly:
// Orion holds the session (encrypted in its data folder) and relays these requests.
import { FARM_ROLES } from "@orbit/schema/roles";
import { type Static, Type } from "typebox";

export const FarmRole = Type.Enum([...FARM_ROLES]);
export type FarmRole = Static<typeof FarmRole>;

/**
 * unavailable: this Orion has no Core address (fully local).
 * signed_out: Core is configured but nobody is signed in; Orbit works locally.
 * signed_in: a session exists; `farm` is set once the local farm is linked to the account.
 */
export const AccountState = Type.Enum(["unavailable", "signed_out", "signed_in"]);
export type AccountState = Static<typeof AccountState>;

export const AccountUser = Type.Object({
  id: Type.String(),
  email: Type.String(),
  name: Type.Union([Type.String(), Type.Null()]),
  /** Plans and invites need a confirmed address; the link is emailed at sign-up. */
  emailVerified: Type.Optional(Type.Boolean()),
});
export type AccountUser = Static<typeof AccountUser>;

/** farm: the member's stored choice; null picks the farm plan when allowed and it has an allowance. */
export const UsageSource = Type.Enum(["farm", "own"]);
export type UsageSource = Static<typeof UsageSource>;

/** A cloud farm the signed-in person belongs to (the farm picker lists these). */
export const AccountFarm = Type.Object({
  id: Type.String(),
  name: Type.Union([Type.String(), Type.Null()]),
  role: FarmRole,
  plan: Type.String(),
  useFarmPlan: Type.Boolean(),
  usageSource: Type.Union([UsageSource, Type.Null()]),
});
export type AccountFarm = Static<typeof AccountFarm>;

export const AccountStatus = Type.Object({
  state: AccountState,
  coreUrl: Type.Union([Type.String(), Type.Null()]),
  user: Type.Union([AccountUser, Type.Null()]),
  /** The cloud farm open on this PC; null while signed out or when this PC's farm is not in the cloud. */
  farm: Type.Union([
    Type.Object({
      id: Type.String(),
      name: Type.Union([Type.String(), Type.Null()]),
      role: FarmRole,
    }),
    Type.Null(),
  ]),
  /** Every cloud farm of the account; an account needs none. */
  farms: Type.Optional(Type.Array(AccountFarm)),
  /** This PC's own farm while it is not in the cloud (farms.create puts it there); null otherwise. */
  localFarm: Type.Optional(
    Type.Union([
      Type.Object({ id: Type.String(), name: Type.Union([Type.String(), Type.Null()]) }),
      Type.Null(),
    ]),
  ),
  /** Why the local farm could not be linked (e.g. it belongs to another account). */
  linkError: Type.Optional(Type.String()),
});
export type AccountStatus = Static<typeof AccountStatus>;

/** Tokens this calendar month (UTC) on this farm, split by who paid; voice in seconds. */
export const MemberUsage = Type.Object({
  farmTokens: Type.Number({ minimum: 0 }),
  ownTokens: Type.Number({ minimum: 0 }),
  voiceSeconds: Type.Number({ minimum: 0 }),
});
export type MemberUsage = Static<typeof MemberUsage>;

const TokenLimit = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);

export const FarmMember = Type.Object({
  userId: Type.String(),
  email: Type.String(),
  name: Type.Union([Type.String(), Type.Null()]),
  role: FarmRole,
  createdAt: Type.String(),
  /** May the member's Orion run on the farm's plan? Owners always may. */
  useFarmPlan: Type.Optional(Type.Boolean()),
  /** Farm-plan tokens the member may use per calendar month; null = no limit. */
  monthlyTokenLimit: Type.Optional(TokenLimit),
  usageSource: Type.Optional(Type.Union([UsageSource, Type.Null()])),
  /** Every member's usage for owners and managers; only your own row otherwise. */
  usage: Type.Optional(MemberUsage),
});
export type FarmMember = Static<typeof FarmMember>;

export const FarmInvite = Type.Object({
  id: Type.String(),
  email: Type.String(),
  role: FarmRole,
  createdAt: Type.String(),
  expiresAt: Type.String(),
  useFarmPlan: Type.Optional(Type.Boolean()),
  monthlyTokenLimit: Type.Optional(TokenLimit),
});
export type FarmInvite = Static<typeof FarmInvite>;

const Credentials = {
  email: Type.String({ minLength: 3, maxLength: 200 }),
  password: Type.String({ minLength: 1, maxLength: 256 }),
};
/** invites is empty for members who may not manage the farm. */
const Members = Type.Object({ members: Type.Array(FarmMember), invites: Type.Array(FarmInvite) });

export const AccountRequests = {
  "account.status": { params: Type.Object({}), result: AccountStatus },
  "account.register": {
    params: Type.Object({
      ...Credentials,
      name: Type.Optional(Type.String({ maxLength: 200 })),
      acceptTerms: Type.Literal(true),
    }),
    result: AccountStatus,
  },
  "account.login": { params: Type.Object(Credentials), result: AccountStatus },
  /**
   * Starts Google sign-in on the website in the system browser (`url`; `opened` false when Orion
   * could not open it). The site hands the result back to Orion, which then emits account.updated.
   */
  "account.googleStart": {
    params: Type.Object({}),
    result: Type.Object({ url: Type.String(), opened: Type.Boolean() }),
  },
  "account.logout": { params: Type.Object({}), result: AccountStatus },
  /** Re-reads the account from the cloud, e.g. after confirming the email or buying a plan. */
  "account.refresh": { params: Type.Object({}), result: AccountStatus },
  "account.resendVerification": { params: Type.Object({}), result: Type.Object({}) },
  /** Emails a reset link when the address has an account; the answer never tells which. */
  "account.requestPasswordReset": {
    params: Type.Object({ email: Type.String({ minLength: 3, maxLength: 200 }) }),
    result: Type.Object({}),
  },
  "account.acceptInvite": {
    params: Type.Object({ code: Type.String({ minLength: 1, maxLength: 100 }) }),
    result: AccountStatus,
  },
  "members.list": { params: Type.Object({}), result: Members },
  /** Changes any of role, farm-plan permission and monthly limit (owners and managers). */
  "members.update": {
    params: Type.Object({
      userId: Type.String(),
      role: Type.Optional(FarmRole),
      useFarmPlan: Type.Optional(Type.Boolean()),
      monthlyTokenLimit: Type.Optional(TokenLimit),
    }),
    result: Members,
  },
  "members.remove": { params: Type.Object({ userId: Type.String() }), result: Members },
  /** The code is shown once; the invited person enters it after signing in with that email. */
  "invites.create": {
    params: Type.Object({
      email: Type.String({ minLength: 3, maxLength: 200 }),
      role: FarmRole,
      useFarmPlan: Type.Optional(Type.Boolean()),
      monthlyTokenLimit: Type.Optional(TokenLimit),
    }),
    result: Type.Object({ invite: FarmInvite, code: Type.String() }),
  },
  "invites.revoke": { params: Type.Object({ inviteId: Type.String() }), result: Members },
  /** Puts this PC's own farm in the cloud, owned by the signed-in person, so others can be invited. */
  "farms.create": {
    params: Type.Object({ name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }),
    result: AccountStatus,
  },
  /**
   * Opens another of the account's farms on this PC, or "local" for this PC's own farm. Each farm
   * keeps its own data folder; Orion restarts onto it (`restarting`), and the app reconnects.
   */
  "farms.open": {
    params: Type.Object({ farmId: Type.String({ minLength: 1, maxLength: 64 }) }),
    result: Type.Object({ restarting: Type.Boolean() }),
  },
} as const;

export const AccountEvents = {
  "account.updated": AccountStatus,
  /** The chat list changed as a whole (someone else signed in on this PC); reload it. */
  "sessions.reset": Type.Object({}),
} as const;
