// Orbit account: signs this install in to Core, links the open farm to the account, runs
// @orbit/sync with the user's session, and points the model at Core's metered cloud gateway.
// Signed out (or with no Core configured) Orbit keeps working fully locally. An account needs no
// farm: signing in never puts this PC's farm in the cloud; createFarm does, on request.
// The session token lives encrypted in the data folder (account-session.enc.json), so it lasts
// exactly as long as the farm's data: an update keeps it, deleting the data signs out. It is not
// in the OS keychain, which Windows empties when an admin resets the user's password.
// account.json keeps only the non-secret view so the status survives restarts and offline starts.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  AccountFarm,
  AccountStatus,
  AccountUser,
  ErrorCode,
  FarmInvite,
  FarmMember,
  FarmRole,
  SyncState,
  UsageSource,
} from "@orbit/protocol";
import { canWriteTable, type SyncedTable } from "@orbit/schema";
import { createSyncEngine, type SyncEngine, type SyncStatus } from "@orbit/sync";
import { GATEWAY_PROVIDER } from "../agent/hub";
import { GATEWAY_TITLE_MODEL } from "../agent/title";
import type { Repository } from "../db/repo";
import { EncryptedFileStore, type SecretStore } from "../secrets";
import type { SettingsStore } from "../settings";
import type { FarmCodeSync } from "./farm-code";
import type { FarmFolders } from "./farm-folders";

export const GATEWAY_MODEL = "orbit-default";
const SESSION_REF = "core-session";
const SESSION_FILE = "account-session.enc.json";
const DEFAULT_SITE_URL = "https://pecorva.com";
const GOOGLE_LOGIN_TTL_MS = 10 * 60_000;
const FARM_HEADER = "x-orbit-farm";

export class AccountError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface Stored {
  user: AccountUser | null;
  farm: AccountStatus["farm"];
  farms?: AccountFarm[];
  linkError?: string;
}

interface MeFarm {
  farmId: string;
  role: FarmRole;
  name: string | null;
  plan?: string;
  useFarmPlan?: boolean;
  usageSource?: UsageSource | null;
}

const accountFarm = (f: MeFarm): AccountFarm => ({
  id: f.farmId,
  name: f.name,
  role: f.role,
  plan: f.plan ?? "free",
  useFarmPlan: f.useFarmPlan ?? true,
  usageSource: f.usageSource ?? null,
});

interface SyncEvent {
  state: SyncState;
  pendingOutbox: number;
  lastSyncedAt: string | null;
  error?: string;
}

export interface AccountServiceOptions {
  dataDir: string;
  /** Which farm folder is open (this PC's own farm when `active` is null). */
  folders?: FarmFolders;
  coreUrl: string | null;
  /** Website that runs Google sign-in for the app; https://pecorva.com when null or unset. */
  siteUrl?: string | null;
  repo: Repository;
  secrets: SecretStore;
  settings: SettingsStore;
  runtime: ModelRuntime;
  deviceName: string;
  onStatus(status: AccountStatus): void;
  onSync(status: SyncEvent): void;
  onRemoteChange(table: string, ids: string[]): void;
  fetch?: typeof fetch;
  syncIntervalMs?: number;
}

const HTTP_CODES: Record<number, ErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  410: "conflict",
  429: "busy",
};

const MUTATION_TABLE: Record<string, SyncedTable> = {
  "animals.upsert": "animals",
  "devices.upsert": "devices",
  "bindings.set": "device_bindings",
  "bindings.clear": "device_bindings",
  "connectors.upsert": "connectors",
  "connectors.syncNow": "connectors",
  "cameras.upsert": "cameras",
  "cameraLayout.save": "camera_layouts",
  "observations.add": "observations",
  "farm.update": "farms",
};

export class AccountService {
  codeSync: FarmCodeSync | null = null;
  private stored: Stored = { user: null, farm: null };
  private token: string | null = null;
  private engine: SyncEngine | null = null;
  private unsubscribe: (() => void)[] = [];
  private readonly file: string;
  private readonly session: SecretStore;
  private readonly coreUrl: string | null;
  private readonly siteUrl: string;
  private readonly doFetch: typeof fetch;
  /** Google sign-ins started from this Orbit: state -> expiry (ms). Each state works once. */
  private readonly googleLogins = new Map<string, number>();

  constructor(private readonly opts: AccountServiceOptions) {
    this.file = join(opts.dataDir, "account.json");
    this.session = new EncryptedFileStore(opts.dataDir, SESSION_FILE);
    this.coreUrl = opts.coreUrl?.replace(/\/+$/, "") ?? null;
    this.siteUrl = (opts.siteUrl ?? DEFAULT_SITE_URL).replace(/\/+$/, "");
    this.doFetch = opts.fetch ?? fetch;
    if (existsSync(this.file)) {
      this.stored = { ...this.stored, ...(JSON.parse(readFileSync(this.file, "utf8")) as Stored) };
    }
  }

  async start(): Promise<void> {
    if (!this.coreUrl) return;
    this.token = await this.readSession();
    if (!this.token) {
      if (this.stored.user) this.save({ user: null, farm: null });
      return;
    }
    try {
      await this.link();
    } catch (error) {
      if (error instanceof AccountError && error.code === "unauthorized") {
        await this.clearSession();
        return;
      }
      // Core unreachable or answering oddly: keep the cached account and let sync retry; a
      // broken cloud must never stop the farm PC from starting.
      process.stderr.write(`orion: account refresh failed: ${(error as Error).message}\n`);
    }
    await this.activate();
  }

  status(): AccountStatus {
    const state = !this.coreUrl ? "unavailable" : this.token ? "signed_in" : "signed_out";
    const farm = this.token ? this.stored.farm : null;
    const farms = this.token ? (this.stored.farms ?? []) : [];
    return {
      state,
      coreUrl: this.coreUrl,
      user: this.token ? this.stored.user : null,
      farm,
      farms,
      localFarm: this.localFarm(farm, farms),
      ...(this.token && this.stored.linkError ? { linkError: this.stored.linkError } : {}),
    };
  }

  /** This PC's own farm when the picker should offer it: not open as, or listed as, a cloud farm. */
  private localFarm(
    open: AccountStatus["farm"],
    farms: AccountFarm[],
  ): { id: string; name: string | null } | null {
    const folders = this.opts.folders;
    const local = folders?.active ? folders.root : this.opts.repo.farm();
    if (!local || local.id === open?.id || farms.some((f) => f.id === local.id)) return null;
    return { id: local.id, name: local.name };
  }

  /** Where `farms.open` should point the farm folders, or null when that farm is already open. */
  openTarget(farmId: string): FarmFolders | null {
    const folders = this.opts.folders ?? { active: null, root: null };
    const here = folders.active ? folders.root : this.opts.repo.farm();
    const root = here ? { id: here.id, name: here.name } : null;
    if (farmId === "local" || farmId === root?.id) {
      return folders.active ? { active: null, root } : null;
    }
    if (farmId === folders.active) return null;
    if (!(this.token ? (this.stored.farms ?? []) : []).some((f) => f.id === farmId)) {
      throw new AccountError("not_found", "You are not a member of that farm.");
    }
    return { active: farmId, root };
  }

  syncStatus(): SyncEvent {
    if (this.engine) return this.engine.status();
    return { state: "disabled", pendingOutbox: this.opts.repo.pendingOutbox(), lastSyncedAt: null };
  }

  /** Server-only connection credentials; never included in account status or protocol frames. */
  cloudConnection(): { url: string; headers: Record<string, string> } {
    this.requireSession();
    if (!this.coreUrl || !this.token) throw new AccountError("unauthorized", "Sign in first.");
    // Without a farm the request runs on the person's own plan.
    const farm = this.stored.farm;
    return {
      url: this.coreUrl,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(farm ? { [FARM_HEADER]: farm.id } : {}),
      },
    };
  }

  /** For other cloud features. "optional" also works signed out, without credentials. */
  request(
    method: string,
    path: string,
    body?: unknown,
    session: "required" | "optional" = "required",
  ): Promise<unknown> {
    return this.call(method, path, body, { anonymous: session === "optional" && !this.token });
  }

  assertCanMutate(mutation: string): void {
    const farm = this.token ? this.stored.farm : null;
    const table = MUTATION_TABLE[mutation];
    if (!farm || !table || canWriteTable(farm.role, table)) return;
    throw new AccountError("forbidden", `as ${farm.role} on this farm you may not change ${table}`);
  }

  async register(params: {
    email: string;
    password: string;
    name?: string;
    acceptTerms: true;
  }): Promise<AccountStatus> {
    const body = { ...params, deviceName: this.opts.deviceName };
    return this.signIn(await this.call("POST", "/v1/auth/register", body, { anonymous: true }));
  }

  async refresh(): Promise<AccountStatus> {
    this.requireSession();
    await this.link();
    await this.activate();
    return this.publish();
  }

  async resendVerification(): Promise<Record<string, never>> {
    this.requireSession();
    await this.call("POST", "/v1/auth/resend-verification");
    return {};
  }

  async requestPasswordReset(email: string): Promise<Record<string, never>> {
    await this.call("POST", "/v1/auth/password-reset", { email }, { anonymous: true });
    return {};
  }

  async login(email: string, password: string): Promise<AccountStatus> {
    const body = { email, password, deviceName: this.opts.deviceName };
    return this.signIn(await this.call("POST", "/v1/auth/login", body, { anonymous: true }));
  }

  /**
   * Google sign-in runs on the website (Google refuses embedded app windows): it sends the Google
   * credential back to `callbackOrigin`/account/google/<state>, which calls googleFinish.
   */
  googleStart(callbackOrigin: string): { url: string; state: string } {
    if (!this.coreUrl) throw new AccountError("not_ready", "this Orbit has no cloud address");
    const now = Date.now();
    for (const [state, expires] of this.googleLogins) {
      if (expires <= now) this.googleLogins.delete(state);
    }
    const state = randomBytes(24).toString("base64url");
    this.googleLogins.set(state, now + GOOGLE_LOGIN_TTL_MS);
    const callback = `${callbackOrigin}/account/google/${state}`;
    return { url: `${this.siteUrl}/account/app/?${new URLSearchParams({ callback })}`, state };
  }

  hasGoogleLogin(state: string): boolean {
    return (this.googleLogins.get(state) ?? 0) > Date.now();
  }

  async googleFinish(state: string, credential: string): Promise<AccountStatus> {
    const expires = this.googleLogins.get(state) ?? 0;
    this.googleLogins.delete(state);
    if (expires <= Date.now()) {
      throw new AccountError("not_found", "This sign-in has expired. Start again from Orbit.");
    }
    const body = { credential, acceptTerms: true, deviceName: this.opts.deviceName };
    return this.signIn(await this.call("POST", "/v1/auth/google", body, { anonymous: true }));
  }

  async logout(): Promise<AccountStatus> {
    if (this.token) {
      await this.call("POST", "/v1/auth/logout").catch((error: unknown) => {
        // Signing out must work offline; the server session then simply expires.
        if (!(error instanceof AccountError)) throw error;
      });
    }
    await this.clearSession();
    return this.publish();
  }

  async acceptInvite(code: string): Promise<AccountStatus> {
    this.requireSession();
    await this.call("POST", "/v1/invites/accept", { code: code.trim() });
    await this.link();
    await this.activate();
    return this.publish();
  }

  async members(): Promise<{ members: FarmMember[]; invites: FarmInvite[] }> {
    const farmId = this.requireFarm().id;
    const { members } = (await this.call("GET", `/v1/farms/${farmId}/members`)) as {
      members: FarmMember[];
    };
    const role = this.stored.farm?.role;
    const invites =
      role === "owner" || role === "manager"
        ? ((await this.call("GET", `/v1/farms/${farmId}/invites`)) as { invites: FarmInvite[] })
            .invites
        : [];
    return { members, invites };
  }

  async updateMember(
    userId: string,
    patch: { role?: FarmRole; useFarmPlan?: boolean; monthlyTokenLimit?: number | null },
  ) {
    const farmId = this.requireFarm().id;
    await this.call("PATCH", `/v1/farms/${farmId}/members/${encodeURIComponent(userId)}`, patch);
    if (userId === this.stored.user?.id) await this.refreshRole();
    return this.members();
  }

  /** Removing yourself leaves the farm: you stay signed in, and the farm closes on this PC. */
  async removeMember(userId: string): Promise<{ members: FarmMember[]; invites: FarmInvite[] }> {
    const farmId = this.requireFarm().id;
    await this.call("DELETE", `/v1/farms/${farmId}/members/${encodeURIComponent(userId)}`);
    if (userId === this.stored.user?.id) {
      await this.link();
      await this.activate();
      this.publish();
      return { members: [], invites: [] };
    }
    return this.members();
  }

  async createInvite(
    email: string,
    role: FarmRole,
    extra: { useFarmPlan?: boolean; monthlyTokenLimit?: number | null } = {},
  ): Promise<{ invite: FarmInvite; code: string }> {
    const farmId = this.requireFarm().id;
    return (await this.call("POST", `/v1/farms/${farmId}/invites`, {
      email,
      role,
      ...extra,
    })) as { invite: FarmInvite; code: string };
  }

  /** Chooses whether this person's Orion runs on the open farm's plan or their own. */
  async setUsageSource(source: UsageSource | null): Promise<void> {
    const farmId = this.requireFarm().id;
    await this.call("PATCH", `/v1/farms/${farmId}/me`, { usageSource: source });
    await this.link();
    this.publish();
  }

  /**
   * Puts this PC's own farm in the cloud, owned by the signed-in person, so others can be invited.
   * An empty cloud farm the person already owns (a plan bought on the website before Orbit was
   * installed) is taken over, with its plan, instead of starting a second farm.
   */
  async createFarm(name?: string): Promise<AccountStatus> {
    this.requireSession();
    if (this.opts.folders?.active) {
      throw new AccountError("not_ready", "Open this PC's own farm first.");
    }
    if (this.stored.farm) throw new AccountError("conflict", "This farm is already in the cloud.");
    const me = (await this.call("GET", "/v1/me")) as { user: AccountUser; farms: MeFarm[] };
    const trimmed = name?.trim();
    if (trimmed) this.opts.repo.updateFarm({ name: trimmed });
    const farm = this.opts.repo.ensureFarm();
    const owned = me.farms
      .filter((f) => f.role === "owner")
      .sort(
        (a, b) => Number((b.plan ?? "free") !== "free") - Number((a.plan ?? "free") !== "free"),
      );
    let claimed = false;
    for (const target of owned) {
      try {
        await this.call("POST", "/v1/farms", {
          id: farm.id,
          name: farm.name,
          adopt: target.farmId,
        });
        claimed = true;
        break;
      } catch (error) {
        if (!(error instanceof AccountError) || error.code !== "conflict") throw error;
      }
    }
    if (!claimed) await this.call("POST", "/v1/farms", { id: farm.id, name: farm.name });
    await this.link();
    await this.activate();
    return this.publish();
  }

  async revokeInvite(inviteId: string) {
    const farmId = this.requireFarm().id;
    await this.call("DELETE", `/v1/farms/${farmId}/invites/${encodeURIComponent(inviteId)}`);
    return this.members();
  }

  async stop(): Promise<void> {
    await this.stopSync();
  }

  // ------------------------------------------------------------------ internals

  private requireSession(): void {
    if (!this.coreUrl) throw new AccountError("not_ready", "this Orbit has no cloud address");
    if (!this.token) throw new AccountError("unauthorized", "sign in first");
  }

  private requireFarm(): NonNullable<AccountStatus["farm"]> {
    this.requireSession();
    const farm = this.stored.farm;
    if (!farm) {
      throw new AccountError("not_ready", this.stored.linkError ?? "this farm is not linked yet");
    }
    return farm;
  }

  private async signIn(result: unknown): Promise<AccountStatus> {
    const { user, session } = result as { user: AccountUser; session: { token: string } };
    if (this.stored.user && this.stored.user.id !== user.id) await this.stopSync();
    await this.session.set(SESSION_REF, session.token);
    this.token = session.token;
    this.save({ user, farm: null });
    // Hide the previous author's chats immediately, including when linking fails or is offline.
    this.publish();
    await this.link();
    await this.activate();
    return this.publish();
  }

  /**
   * Finds which of the account's farms is open here. A farm opened in its own folder -> that
   * membership (gone -> linkError). This PC's own farm -> its membership when it is in the cloud,
   * else no farm (it stays local until createFarm). A fresh install with no farm of its own opens
   * the account's first farm and syncs it down. Nothing is ever created in the cloud here.
   */
  private async link(): Promise<void> {
    const me = (await this.call("GET", "/v1/me")) as { user: AccountUser; farms: MeFarm[] };
    const active = this.opts.folders?.active ?? null;
    const local = this.opts.repo.farm();
    // The cloud learns a farm's name from its first sync; until then this PC knows it.
    const farms = me.farms.map((f) =>
      accountFarm(f.name || f.farmId !== local?.id ? f : { ...f, name: local.name }),
    );
    if (active) {
      const mine = me.farms.find((f) => f.farmId === active);
      if (!mine) {
        this.save({
          user: me.user,
          farm: null,
          farms,
          linkError: "You are no longer a member of this farm.",
        });
        return;
      }
      this.opts.repo.placeCloudFarm(mine.farmId, mine.name);
      const name = mine.name ?? local?.name ?? null;
      this.save({ user: me.user, farm: { id: mine.farmId, name, role: mine.role }, farms });
      return;
    }
    const mine = local ? me.farms.find((f) => f.farmId === local.id) : me.farms[0];
    if (!mine) {
      this.save({ user: me.user, farm: null, farms });
      return;
    }
    const name = mine.name ?? local?.name ?? null;
    this.save({ user: me.user, farm: { id: mine.farmId, name, role: mine.role }, farms });
  }

  private async refreshRole(): Promise<void> {
    await this.link();
    this.publish();
  }

  private async activate(): Promise<void> {
    const farm = this.stored.farm;
    if (!this.coreUrl || !this.token) {
      void this.stopSync();
      return;
    }
    this.configureGateway(farm?.id ?? null, this.token);
    if (!farm) {
      void this.stopSync();
      return;
    }
    await this.codeSync?.start();
    if (this.engine) {
      this.engine.setToken(this.token);
      return;
    }
    const engine = createSyncEngine({
      db: this.opts.repo.db,
      farmId: farm.id,
      coreUrl: this.coreUrl,
      token: this.token,
      headers: { [FARM_HEADER]: farm.id },
      hlc: this.opts.repo.hlc,
      fetch: this.doFetch,
      intervalMs: this.opts.syncIntervalMs,
    });
    this.unsubscribe = [
      engine.on("status", (s: SyncStatus) => this.opts.onSync(s)),
      engine.on("changes", (c) => this.opts.onRemoteChange(c.table, c.ids)),
      this.opts.repo.onChange(() => engine.notifyLocalWrite()),
    ];
    this.engine = engine;
    engine.start();
  }

  /** Without a farm Core bills the person's own plan. */
  private configureGateway(farmId: string | null, token: string): void {
    const { runtime, settings } = this.opts;
    runtime.registerProvider(GATEWAY_PROVIDER, {
      name: "Orbit cloud",
      baseUrl: `${this.coreUrl}/v1/llm/v1`,
      api: "openai-completions",
      headers: farmId ? { [FARM_HEADER]: farmId } : {},
      models: [
        {
          id: GATEWAY_MODEL,
          name: "Orbit (cloud)",
          // Sends the thinking level as reasoning_effort; the default is medium.
          reasoning: true,
          // Without "image" Pi strips screenshots, and the computer tool would act blind.
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8192,
        },
        {
          id: GATEWAY_TITLE_MODEL,
          name: "Orbit (small)",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8192,
        },
      ],
    });
    void runtime.setRuntimeApiKey(GATEWAY_PROVIDER, token);
    const s = settings.get();
    if (!s.provider || !s.model)
      settings.update({ provider: GATEWAY_PROVIDER, model: GATEWAY_MODEL });
  }

  private async stopSync(): Promise<void> {
    await this.codeSync?.stop();
    for (const off of this.unsubscribe.splice(0)) off();
    const engine = this.engine;
    this.engine = null;
    if (engine) await engine.stop();
    this.opts.onSync(this.syncStatus());
  }

  /** The saved session; one an older Orbit kept in the secret store moves to the data folder. */
  private async readSession(): Promise<string | null> {
    let token: string | null;
    try {
      token = await this.session.get(SESSION_REF);
    } catch (error) {
      // An unreadable file (e.g. its key was deleted) means signing in again, not a crashed start.
      process.stderr.write(`orion: saved sign-in unreadable: ${(error as Error).message}\n`);
      return null;
    }
    if (token) return token;
    const legacy = await this.opts.secrets.get(SESSION_REF);
    if (!legacy) return null;
    await this.session.set(SESSION_REF, legacy);
    await this.opts.secrets.delete(SESSION_REF);
    return legacy;
  }

  private async clearSession(): Promise<void> {
    await this.stopSync();
    await this.session.delete(SESSION_REF);
    await this.opts.secrets.delete(SESSION_REF);
    this.token = null;
    await this.opts.runtime.removeRuntimeApiKey(GATEWAY_PROVIDER).catch(() => undefined);
    const s = this.opts.settings.get();
    if (s.provider === GATEWAY_PROVIDER) this.opts.settings.update({ provider: null, model: null });
    this.save({ user: null, farm: null });
    rmSync(this.file, { force: true });
  }

  private save(next: Stored): void {
    this.stored = next;
    writeFileSync(this.file, `${JSON.stringify(next, null, 2)}\n`);
  }

  private publish(): AccountStatus {
    const status = this.status();
    this.opts.onStatus(status);
    return status;
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    { anonymous = false } = {},
  ): Promise<unknown> {
    if (!this.coreUrl) throw new AccountError("not_ready", "this Orbit has no cloud address");
    if (!anonymous && !this.token) throw new AccountError("unauthorized", "sign in first");
    let res: Response;
    try {
      res = await this.doFetch(`${this.coreUrl}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(anonymous ? {} : { authorization: `Bearer ${this.token}` }),
          ...(!anonymous && this.stored.farm ? { [FARM_HEADER]: this.stored.farm.id } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new AccountError(
        "not_ready",
        `Orbit cloud unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as { error?: { message?: string } }) : null;
    if (!res.ok) {
      const code = HTTP_CODES[res.status] ?? (res.status >= 500 ? "not_ready" : "internal");
      throw new AccountError(code, parsed?.error?.message ?? `Orbit cloud answered ${res.status}`);
    }
    return parsed;
  }
}
