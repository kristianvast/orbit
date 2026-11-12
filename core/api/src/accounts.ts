import type { Hono } from "hono";
import { registerDeleteRoute } from "./account-delete";
import { registerEmailRoutes } from "./account-email";
import { registerFarmRoutes } from "./account-farms";
import type { AccountEnv, AccountOptions } from "./account-input";
import { registerInviteRoutes } from "./account-invites";
import { registerMemberRoutes } from "./account-members";
import { registerProfileRoute } from "./account-profile";
import { createAccountRuntime } from "./account-runtime";
import { registerSessionRoutes } from "./account-sessions";
import { registerSignInRoutes } from "./account-sign-in";
import type { CoreDb } from "./db";

export type { AccountOptions } from "./account-input";
export {
  INVITE_PREFIX,
  INVITE_TTL_MS,
  PASSWORD_MIN,
  RESET_TTL_MS,
  TERMS_VERSION,
  VERIFY_TTL_MS,
} from "./account-input";
export function registerAccountRoutes(app: Hono, db: CoreDb, options: AccountOptions) {
  const runtime = createAccountRuntime(db, options);
  const routes = app as unknown as Hono<AccountEnv>;
  registerSignInRoutes(routes, db, runtime);
  registerProfileRoute(routes, db, runtime);
  registerEmailRoutes(routes, db, runtime);
  registerSessionRoutes(routes, db, runtime);
  registerDeleteRoute(routes, db, runtime);
  registerFarmRoutes(routes, db, runtime);
  registerMemberRoutes(routes, db, runtime);
  registerInviteRoutes(routes, db, runtime);
}
