// Orbit account: signs this install in to Core, links the local farm to the account, runs
// @orbit/sync with the user's session, and points the model at Core's metered cloud gateway.
// Signed out (or with no Core configured) Orbit keeps working fully locally.
// The session token lives encrypted in the data folder (account-session.enc.json), so it lasts
// exactly as long as the farm's data: an update keeps it, deleting the data signs out. It is not
// in the OS keychain, which Windows empties when an admin resets the user's password.
// account.json keeps only the non-secret view so the status survives restarts and offline starts.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  AccountStatus,
  AccountUser,
  ErrorCode,
  FarmInvite,
  FarmMember,
  FarmRole,
  SyncState,
} from "@orbit/protocol";
import { canWriteTable, type SyncedTable } from "@orbit/schema";
import { createSyncEngine, type SyncEngine, type SyncStatus } from "@orbit/sync";
import { GATEWAY_PROVIDER } from "../agent/hub";
import { GATEWAY_TITLE_MODEL } from "../agent/title";
import type { Repository } from "../db/repo";
import { EncryptedFileStore, type SecretStore } from "../secrets";
import type { SettingsStore } from "../settings";

export const GATEWAY_MODEL = "orbit-default";
const SESSION_REF = "core-session";
const SESSION_FILE = "account-session.enc.json";
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
  linkError?: string;
}

interface SyncEvent {
  state: SyncState;
  pendingOutbox: number;
  lastSyncedAt: string | null;
  error?: string;
}

export interface AccountServiceOptions {
  dataDir: string;
  coreUrl: string | null;
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
  private stored: Stored = { user: null, farm: null };
  private token: string | null = null;
  private engine: SyncEngine | null = null;
  private unsubscribe: (() => void)[] = [];
  private readonly file: string;
  private readonly session: SecretStore;
  private readonly coreUrl: string | null;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: AccountServiceOptions) {
    this.file = join(opts.dataDir, "account.json");
    this.session = new EncryptedFileStore(opts.dataDir, SESSION_FILE);
    this.coreUrl = opts.coreUrl?.replace(/\/+$/, "") ?? null;
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
    this.activate();
  }

  status(): AccountStatus {
    const state = !this.coreUrl ? "unavailable" : this.token ? "signed_in" : "signed_out";
    return {
      state,
      coreUrl: this.coreUrl,
      user: this.token ? this.stored.user : null,
      farm: this.token ? this.stored.farm : null,
      ...(this.token && this.stored.linkError ? { linkError: this.stored.linkError } : {}),
    };
  }

  syncStatus(): SyncEvent {
    if (this.engine) return this.engine.status();
    return { state: "disabled", pendingOutbox: this.opts.repo.pendingOutbox(), lastSyncedAt: null };
  }

  /** Server-only connection credentials; never included in account status or protocol frames. */
  cloudConnection(): { url: string; headers: Record<string, string> } {
    const farm = this.requireFarm();
    if (!this.coreUrl || !this.token) throw new AccountError("unauthorized", "Sign in first.");
    return {
      url: this.coreUrl,
      headers: { authorization: `Bearer ${this.token}`, [FARM_HEADER]: farm.id },
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
    this.activate();
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
    this.activate();
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

  async updateMember(userId: string, role: FarmRole) {
    const farmId = this.requireFarm().id;
    await this.call("PATCH", `/v1/farms/${farmId}/members/${encodeURIComponent(userId)}`, { role });
    if (userId === this.stored.user?.id) await this.refreshRole();
    return this.members();
  }

  async removeMember(userId: string) {
    const farmId = this.requireFarm().id;
    await this.call("DELETE", `/v1/farms/${farmId}/members/${encodeURIComponent(userId)}`);
    if (userId === this.stored.user?.id) {
      await this.clearSession();
      this.publish();
      return { members: [], invites: [] };
    }
    return this.members();
  }

  async createInvite(email: string, role: FarmRole): Promise<{ invite: FarmInvite; code: string }> {
    const farmId = this.requireFarm().id;
    return (await this.call("POST", `/v1/farms/${farmId}/invites`, { email, role })) as {
      invite: FarmInvite;
      code: string;
    };
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
    await this.link();
    this.activate();
    return this.publish();
  }

  /**
   * Links the local farm to the account: already a member -> use that role. A farm the cloud does
   * not know -> take over a cloud farm the account owns (e.g. bought on the website, paid plans
   * first) when that one is still empty; when it already holds data and this install has none of
   * its own, open the cloud farm here instead; otherwise claim the local farm as a new cloud farm.
   * Owned by someone else -> keep working locally with linkError. A fresh install without a local
   * farm adopts the account's first farm and syncs it down.
   */
  private async link(): Promise<void> {
    const me = (await this.call("GET", "/v1/me")) as {
      user: AccountUser;
      farms: { farmId: string; role: FarmRole; name: string | null; plan?: string }[];
    };
    const local = this.opts.repo.farm();
    const mine = local ? me.farms.find((f) => f.farmId === local.id) : me.farms[0];
    if (mine) {
      const name = mine.name ?? local?.name ?? null;
      this.save({ user: me.user, farm: { id: mine.farmId, name, role: mine.role } });
      return;
    }
    const farm = local ?? this.opts.repo.ensureFarm();
    const owned = me.farms
      .filter((f) => f.role === "owner")
      .sort(
        (a, b) => Number((b.plan ?? "free") !== "free") - Number((a.plan ?? "free") !== "free"),
      );
    for (const target of owned) {
      try {
        await this.call("POST", "/v1/farms", {
          id: farm.id,
          name: farm.name,
          adopt: target.farmId,
        });
        this.save({ user: me.user, farm: { id: farm.id, name: farm.name, role: "owner" } });
        return;
      } catch (error) {
        if (!(error instanceof AccountError) || error.code !== "conflict") throw error;
        if (this.opts.repo.discardEmptyFarm(farm.id)) {
          this.save({
            user: me.user,
            farm: { id: target.farmId, name: target.name, role: target.role },
          });
          return;
        }
      }
    }
    try {
      const claimed = (await this.call("POST", "/v1/farms", { id: farm.id, name: farm.name })) as {
        farm: { id: string; role: FarmRole };
      };
      this.save({ user: me.user, farm: { id: farm.id, name: farm.name, role: claimed.farm.role } });
    } catch (error) {
      if (!(error instanceof AccountError) || error.code !== "conflict") throw error;
      this.save({ user: me.user, farm: null, linkError: error.message });
    }
  }

  private async refreshRole(): Promise<void> {
    await this.link();
    this.publish();
  }

  private activate(): void {
    const farm = this.stored.farm;
    if (!this.coreUrl || !this.token || !farm) {
      void this.stopSync();
      return;
    }
    this.configureGateway(farm.id, this.token);
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

  private configureGateway(farmId: string, token: string): void {
    const { runtime, settings } = this.opts;
    runtime.registerProvider(GATEWAY_PROVIDER, {
      name: "Orbit cloud",
      baseUrl: `${this.coreUrl}/v1/llm/v1`,
      api: "openai-completions",
      headers: { [FARM_HEADER]: farmId },
      models: [
        {
          id: GATEWAY_MODEL,
          name: "Orbit (cloud)",
          reasoning: false,
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
