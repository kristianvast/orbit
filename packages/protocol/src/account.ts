// Orbit account (Core sign-in), farm members and invites. The UI never talks to Core directly:
// Orion holds the session in the OS keychain and relays these requests.
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

export const AccountStatus = Type.Object({
  state: AccountState,
  coreUrl: Type.Union([Type.String(), Type.Null()]),
  user: Type.Union([AccountUser, Type.Null()]),
  farm: Type.Union([
    Type.Object({
      id: Type.String(),
      name: Type.Union([Type.String(), Type.Null()]),
      role: FarmRole,
    }),
    Type.Null(),
  ]),
  /** Why the local farm could not be linked (e.g. it belongs to another account). */
  linkError: Type.Optional(Type.String()),
});
export type AccountStatus = Static<typeof AccountStatus>;

export const FarmMember = Type.Object({
  userId: Type.String(),
  email: Type.String(),
  name: Type.Union([Type.String(), Type.Null()]),
  role: FarmRole,
  createdAt: Type.String(),
});
export type FarmMember = Static<typeof FarmMember>;

export const FarmInvite = Type.Object({
  id: Type.String(),
  email: Type.String(),
  role: FarmRole,
  createdAt: Type.String(),
  expiresAt: Type.String(),
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
  "members.update": {
    params: Type.Object({ userId: Type.String(), role: FarmRole }),
    result: Members,
  },
  "members.remove": { params: Type.Object({ userId: Type.String() }), result: Members },
  /** The code is shown once; the invited person enters it after signing in with that email. */
  "invites.create": {
    params: Type.Object({ email: Type.String({ minLength: 3, maxLength: 200 }), role: FarmRole }),
    result: Type.Object({ invite: FarmInvite, code: Type.String() }),
  },
  "invites.revoke": { params: Type.Object({ inviteId: Type.String() }), result: Members },
} as const;

export const AccountEvents = {
  "account.updated": AccountStatus,
} as const;
