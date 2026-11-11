// Wires the database, secret store, Pi sessions and the WebSocket protocol server.
import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  type ClientMessage,
  CloseCode,
  decodeClientMessage,
  type ErrorCode,
  type EventBody,
  type EventType,
  encodeError,
  encodeEvent,
  encodeResult,
  PROTOCOL_VERSION,
  type Settings,
  type SettingsUpdate,
} from "@orbit/protocol";
import type { ServerWebSocket } from "bun";
import { AuthFlows, systemBrowserOpener } from "./agent/auth";
import { createBrowserTool } from "./agent/browser";
import { createComputerTool } from "./agent/computer";
import { GATEWAY_PROVIDER, HubError, SessionHub } from "./agent/hub";
import { MOCK_MODEL, MOCK_PROVIDER } from "./agent/mock-model";
import { createFarmTools, createFeedbackTools } from "./agent/tools";
import { createWebTools } from "./agent/web";
import { Workspace } from "./agent/workspace";
import type { OrionConfig } from "./config";
import { openDatabase } from "./db/open";
import { RepoError } from "./db/repo";
import { FONT_FILES, materializeResources, PAGE_KIT_CSS } from "./resources";
import { openSecretStore } from "./secrets";
import { AccountError, AccountService } from "./services/account";
import { BillingService } from "./services/billing";
import {
  assertNever,
  cameraWebSocket,
  type SocketData,
  serveCamera,
} from "./services/camera-proxy";
import { FarmService } from "./services/farm";
import { FeedbackService } from "./services/feedback";
import { LOCAL_UI_PREFIX, LocalUiService } from "./services/local-ui";
import { liveRowsIn, ModulesStore } from "./services/modules";
import { listPages, PAGE_SDK, PAGES_DIR, resolvePageFile } from "./services/pages";
import { Go2rtcRelay } from "./services/relay";
import { DEFAULT_SKILLS_URL, SkillService } from "./services/skills";
import { maskKey, SettingsStore } from "./settings";
import { VoiceSessions } from "./voice/session";

export const SERVER_VERSION = "0.1.5";

const EXAMPLE_VIEWS_SKILL = "farm-views";

/**
 * The demo farm also gets the catalog's ready-made views, so a seeded Orbit shows Home cards and
 * their panels. Only from a catalog on this computer: a demo start never waits on the network.
 */
async function addExampleViews(skills: SkillService, workspace: Workspace): Promise<void> {
  try {
    await skills.install(EXAMPLE_VIEWS_SKILL);
    for (const page of await skills.pages(EXAMPLE_VIEWS_SKILL)) {
      await skills.scaffoldPage(EXAMPLE_VIEWS_SKILL, page);
    }
    await workspace.snapshot("Example views added to the demo farm");
  } catch (error) {
    process.stderr.write(
      `orion: the demo farm has no example views (${error instanceof Error ? error.message : String(error)})\n`,
    );
  }
}

export interface OrionApp {
  port: number;
  hub: SessionHub;
  stop(): Promise<void>;
}

class RequestError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function toProtocolError(error: unknown): { code: ErrorCode; message: string; details?: unknown } {
  if (error instanceof RequestError || error instanceof RepoError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    };
  }
  if (error instanceof HubError) return { code: error.code, message: error.message };
  if (error instanceof AccountError) return { code: error.code, message: error.message };
  return { code: "internal", message: error instanceof Error ? error.message : String(error) };
}

export async function startOrion(config: OrionConfig): Promise<OrionApp> {
  mkdirSync(config.dataDir, { recursive: true });
  const workspace = new Workspace(join(config.dataDir, "workspace"));
  await workspace.init();

  const db = openDatabase(config.dataDir, { seed: config.seed });
  const repo = db.repo;
  const secrets = await openSecretStore(config.dataDir, repo.installId);
  const settings = new SettingsStore(config.dataDir);
  const sockets = new Set<ServerWebSocket<SocketData>>();

  const emit = <E extends EventType>(type: E, body: EventBody<E>) => {
    const frame = encodeEvent(type, body);
    for (const ws of sockets) {
      switch (ws.data.kind) {
        case "protocol":
          if (ws.data.authed) ws.send(frame);
          break;
        case "camera":
          break;
        default:
          assertNever(ws.data);
      }
    }
  };
  const modules = new ModulesStore(config.dataDir, liveRowsIn(repo.db), (state) =>
    emit("modules.updated", state),
  );
  const dbChanged = (table: string, ids: string[]) => {
    emit("db.changed", { table, ids });
    modules.noticeChange(table);
  };
  repo.onChange(dbChanged);

  const resources = materializeResources(config.dataDir);
  const farm = new FarmService(repo, secrets, workspace.dir, resources.connectorTemplateDir);
  const skills = new SkillService(
    config.skillsUrl ?? (config.appSource ? join(config.appSource, "skills") : DEFAULT_SKILLS_URL),
    workspace.dir,
  );
  if (db.seeded && skills.local) await addExampleViews(skills, workspace);
  const relay = new Go2rtcRelay(repo, secrets, config.dataDir);
  const localUi = new LocalUiService(
    config.dataDir,
    config.appSource ?? join(config.dataDir, "app"),
    config.token,
    (status) => emit("localUi.updated", status),
    { version: SERVER_VERSION },
  );
  const feedback = new FeedbackService(workspace.dir, SERVER_VERSION);
  const browser = createBrowserTool(config.dataDir);
  // The tools are created before the hub they ask to restart.
  let restartOrion: () => boolean = () => false;
  const hub = await SessionHub.create({
    dataDir: config.dataDir,
    workspace,
    resourcesDir: resources.dir,
    repo,
    settings,
    tools: [
      ...createFarmTools(farm, localUi, skills, modules, () => restartOrion()),
      ...createFeedbackTools(feedback),
      ...createWebTools(),
      browser.tool,
      createComputerTool(),
    ],
    emit,
    mockModel: config.mockModel,
    gatewayUrl: config.gatewayUrl,
    appSource: config.appSource,
    version: SERVER_VERSION,
    checkoutDir: localUi.checkoutDir,
    localOrionError: () => localUi.orion.status().lastError,
    ...(config.restart ? { restart: config.restart } : {}),
  });
  restartOrion = () => hub.restartWhenIdle();

  const account = new AccountService({
    dataDir: config.dataDir,
    coreUrl: config.coreUrl ?? null,
    repo,
    secrets,
    settings,
    runtime: hub.runtime,
    deviceName: `Orbit on ${hostname()}`,
    onStatus: (status) => emit("account.updated", status),
    onSync: (status) => emit("sync.status", status),
    onRemoteChange: dbChanged,
  });
  farm.guard = (mutation) => account.assertCanMutate(mutation);
  feedback.account = account;
  await account.start();
  const billing = new BillingService(account);
  const voice = new VoiceSessions({
    farm,
    account,
    billing,
    credentials: hub.credentials,
    emit,
    mockModel: config.mockModel,
  });

  const auth = new AuthFlows(hub.runtime, emit, {
    deviceIdFile: join(config.dataDir, "pi", "device-id"),
    openUrl: systemBrowserOpener(),
    hidden: new Set([MOCK_PROVIDER, GATEWAY_PROVIDER]),
  });

  const notFound = () => new Response("not found", { status: 404 });
  const noStore = { "Cache-Control": "no-store" };

  /** Splits /<prefix>/<token>/<rest...>; a 401/404 response when the token is wrong or malformed. */
  const tokenPath = (pathname: string): { segments: string[] } | Response => {
    const [, , rawToken = "", ...rest] = pathname.split("/");
    let token: string;
    let segments: string[];
    try {
      token = decodeURIComponent(rawToken);
      segments = rest.map(decodeURIComponent);
    } catch {
      return notFound();
    }
    if (!sameToken(token, config.token)) return new Response("unauthorized", { status: 401 });
    return { segments };
  };

  const serveLocalUi = (pathname: string): Response => {
    const parsed = tokenPath(pathname);
    if (parsed instanceof Response) return parsed;
    if (localUi.status().state === "none") return notFound();
    const target = localUi.resolve(parsed.segments.join("/"));
    if (!target) return notFound();
    if (target.kind === "index") {
      return new Response(localUi.indexHtml(), {
        headers: { ...noStore, "Content-Type": "text/html; charset=utf-8" },
      });
    }
    return new Response(Bun.file(target.path), { headers: noStore });
  };

  // Pages run in a sandboxed iframe, which gives them an opaque origin: their own module scripts,
  // fetch() of files in their folder and fonts are cross-origin requests and need this header.
  // Access is still decided by the session token in the path.
  const anyOrigin = { "Access-Control-Allow-Origin": "*" };

  const servePage = (pathname: string): Response => {
    const parsed = tokenPath(pathname);
    if (parsed instanceof Response) return parsed;
    const [id = "", ...rest] = parsed.segments;
    const rel = rest.join("/");
    const headers = { ...noStore, ...anyOrigin };
    if (id === "_orbit.js") {
      return new Response(PAGE_SDK, {
        headers: { ...headers, "Content-Type": "text/javascript; charset=utf-8" },
      });
    }
    if (id === "_orbit.css") {
      return new Response(PAGE_KIT_CSS, {
        headers: { ...headers, "Content-Type": "text/css; charset=utf-8" },
      });
    }
    const file = resolvePageFile(workspace.dir, id, rel);
    if (!file) return notFound();
    return new Response(Bun.file(file), { headers });
  };

  /** The app's fonts, which the page stylesheet loads from /fonts/<name>. Public, like the app's own. */
  const serveFont = (pathname: string): Response => {
    const name = pathname.slice("/fonts/".length);
    const file = Object.hasOwn(FONT_FILES, name) ? FONT_FILES[name] : undefined;
    if (!file) return notFound();
    return new Response(Bun.file(file), {
      headers: {
        ...anyOrigin,
        "Content-Type": "font/woff2",
        "Cache-Control": "public, max-age=86400",
      },
    });
  };

  const settingsView = (): Settings => {
    const s = settings.get();
    const apiKeys: Settings["apiKeys"] = {};
    for (const [provider, hint] of Object.entries(s.keyHints))
      apiKeys[provider] = { configured: true, hint };
    if (config.mockModel) apiKeys[MOCK_PROVIDER] = { configured: true };
    const useMock = config.mockModel && !(s.provider && s.model);
    return {
      provider: useMock ? MOCK_PROVIDER : s.provider,
      model: useMock ? MOCK_MODEL : s.model,
      thinkingLevel: s.thinkingLevel,
      shareAnonymousData: s.shareAnonymousData,
      ...(s.species ? { species: s.species } : {}),
      apiKeys,
      availableModels: hub.availableModels(),
    };
  };

  const updateSettings = async (u: SettingsUpdate): Promise<Settings> => {
    if (u.apiKey) {
      await hub.setApiKey(u.apiKey.provider, u.apiKey.key);
      const keyHints = { ...settings.get().keyHints };
      if (u.apiKey.key === null) delete keyHints[u.apiKey.provider];
      else keyHints[u.apiKey.provider] = maskKey(u.apiKey.key);
      settings.update({ keyHints });
    }
    const provider = u.provider !== undefined ? u.provider : settings.get().provider;
    const model = u.model !== undefined ? u.model : settings.get().model;
    if (provider && model && !hub.runtime.getModel(provider, model)) {
      throw new RequestError("bad_request", `unknown model ${provider}/${model}`);
    }
    settings.update({
      ...(u.provider !== undefined ? { provider: u.provider } : {}),
      ...(u.model !== undefined ? { model: u.model } : {}),
      ...(u.thinkingLevel ? { thinkingLevel: u.thinkingLevel } : {}),
      ...(u.shareAnonymousData !== undefined ? { shareAnonymousData: u.shareAnonymousData } : {}),
      ...(u.species ? { species: u.species } : {}),
    });
    return settingsView();
  };

  const undoSnapshot = async (snapshotId: string) => {
    const snap = repo.getSnapshot(snapshotId);
    const workspaceChange = snap.changes.find((c) => c.table === "workspace");
    if (!workspaceChange) return repo.undoDbSnapshot(snapshotId);
    if (snap.undoneAt) throw new RequestError("conflict", "this change was already undone");
    let files: string[];
    try {
      files = await workspace.revert(workspaceChange.rowId);
    } catch (error) {
      throw new RequestError("conflict", error instanceof Error ? error.message : String(error));
    }
    const snapshot = repo.markSnapshotUndone(snapshotId);
    // Files are not database rows, so nothing else tells the UI that pages may have come or gone.
    emit("db.changed", { table: "workspace", ids: files });
    return { snapshot, restored: [{ table: "workspace", ids: files }] };
  };

  const handle = async (msg: ClientMessage, owner: object): Promise<unknown> => {
    switch (msg.type) {
      case "hello":
        return {
          protocolVersion: PROTOCOL_VERSION,
          serverVersion: SERVER_VERSION,
          farmId: repo.farm()?.id ?? null,
        };
      case "sessions.list":
        return { sessions: hub.list() };
      case "sessions.create":
        return { session: hub.createSession(msg.title) };
      case "sessions.open":
        return hub.open(msg.sessionId);
      case "sessions.fork":
        return { session: hub.fork(msg.sessionId, msg.fromItemId) };
      case "sessions.rename":
        return { session: hub.rename(msg.sessionId, msg.title) };
      case "sessions.delete":
        return { deleted: await hub.delete(msg.sessionId) };
      case "chat.prompt":
        await hub.prompt(msg.sessionId, msg.text, "prompt");
        return { accepted: true };
      case "chat.steer":
        await hub.prompt(msg.sessionId, msg.text, "steer");
        return { accepted: true };
      case "chat.followUp":
        await hub.prompt(msg.sessionId, msg.text, "followUp");
        return { accepted: true };
      case "chat.abort":
        return { accepted: await hub.abort(msg.sessionId) };
      case "localUi.status":
        return localUi.status();
      case "localUi.launched":
        return localUi.launched();
      case "localUi.booted":
        return localUi.booted();
      case "localUi.disable":
        return localUi.disable();
      case "modules.list":
        return modules.list();
      case "modules.enable":
        return modules.enable(msg.moduleId, "user");
      case "modules.disable":
        return modules.disable(msg.moduleId);
      case "pages.list":
        return { pages: listPages(workspace.dir, config.token) };
      case "settings.get":
        return settingsView();
      case "settings.update": {
        const { id: _id, type: _type, ...update } = msg;
        return updateSettings(update);
      }
      case "auth.providers":
        return { providers: auth.providers() };
      case "auth.login":
        return { loginId: auth.start(msg.providerId, msg.method) };
      case "auth.respond":
        return { accepted: auth.respond(msg.loginId, msg.promptId, msg.value) };
      case "auth.cancel":
        return { accepted: auth.cancel(msg.loginId) };
      case "auth.logout":
        await auth.logout(msg.providerId);
        return { providers: auth.providers() };
      case "db.query":
        if (msg.query === "cameras.relay") return relay.status();
        return repo.query(msg.query, msg.params as never);
      case "account.status":
        return account.status();
      case "account.register":
        return account.register({
          email: msg.email,
          password: msg.password,
          name: msg.name,
          acceptTerms: msg.acceptTerms,
        });
      case "account.refresh":
        return account.refresh();
      case "account.resendVerification":
        return account.resendVerification();
      case "account.requestPasswordReset":
        return account.requestPasswordReset(msg.email);
      case "account.login":
        return account.login(msg.email, msg.password);
      case "account.logout":
        voice.dispose();
        return account.logout();
      case "billing.status":
        return billing.status();
      case "billing.plans":
        return billing.plans();
      case "billing.checkout":
        return billing.checkout({ plan: msg.plan, interval: msg.interval });
      case "billing.portal":
        return billing.portal();
      case "feedback.send":
        return feedback.send({
          kind: msg.kind,
          message: msg.message,
          contactEmail: msg.contactEmail,
          locale: msg.locale,
        });
      case "shared.list":
        return feedback.shared();
      case "voice.start":
        hub.summary(msg.sessionId);
        return voice.start(msg.sessionId, owner);
      case "voice.stop":
        return { accepted: voice.stop(msg.voiceId, owner) };
      case "voice.audio":
        return { accepted: voice.audio(msg.voiceId, owner, msg.data) };
      case "voice.text":
        return { accepted: voice.text(msg.voiceId, owner, msg.text) };
      case "account.acceptInvite":
        return account.acceptInvite(msg.code);
      case "members.list":
        return account.members();
      case "members.update":
        return account.updateMember(msg.userId, msg.role);
      case "members.remove":
        return account.removeMember(msg.userId);
      case "invites.create":
        return account.createInvite(msg.email, msg.role);
      case "invites.revoke":
        return account.revokeInvite(msg.inviteId);
      case "db.mutate":
        return farm.mutate({ mutation: msg.mutation, params: msg.params } as never);
      case "snapshots.list":
        return { snapshots: repo.listSnapshots(msg.sessionId, msg.limit) };
      case "snapshots.undo":
        return undoSnapshot(msg.snapshotId);
    }
  };

  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: config.port,
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (srv.upgrade(req, { data: { kind: "protocol", authed: false } })) return undefined;
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      if (url.pathname === "/health") return Response.json({ ok: true, version: SERVER_VERSION });
      if (url.pathname.startsWith(`/${PAGES_DIR}/`)) return servePage(url.pathname);
      if (url.pathname.startsWith("/fonts/")) return serveFont(url.pathname);
      if (url.pathname.startsWith(`/${LOCAL_UI_PREFIX}/`)) return serveLocalUi(url.pathname);
      if (url.pathname.startsWith("/camera/")) return serveCamera(req, srv, { tokenPath, relay });
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        switch (ws.data.kind) {
          case "camera":
            cameraWebSocket.open(ws, ws.data);
            break;
          case "protocol":
            break;
          default:
            assertNever(ws.data);
        }
      },
      close(ws) {
        sockets.delete(ws);
        voice.disconnect(ws);
        switch (ws.data.kind) {
          case "camera":
            cameraWebSocket.close(ws.data);
            break;
          case "protocol":
            break;
          default:
            assertNever(ws.data);
        }
      },
      async message(ws, raw) {
        switch (ws.data.kind) {
          case "camera":
            cameraWebSocket.message(ws, ws.data, raw);
            return;
          case "protocol":
            break;
          default:
            assertNever(ws.data);
        }
        const decoded = decodeClientMessage(raw as string | Uint8Array);
        if (!decoded.ok) {
          let id: unknown;
          try {
            id = (JSON.parse(String(raw)) as { id?: unknown }).id;
          } catch {
            id = undefined;
          }
          if (typeof id === "string" && id)
            ws.send(encodeError(id, { code: "bad_request", message: decoded.error }));
          else ws.send(encodeEvent("error", { code: "bad_request", message: decoded.error }));
          if (!ws.data.authed) ws.close(CloseCode.protocolError, "bad first frame");
          return;
        }
        const msg = decoded.value;
        if (!ws.data.authed) {
          if (msg.type !== "hello" || !sameToken(msg.token, config.token)) {
            ws.send(
              encodeError(msg.id, { code: "unauthorized", message: "invalid or missing token" }),
            );
            ws.close(CloseCode.unauthorized, "unauthorized");
            return;
          }
          if (msg.protocolVersion !== PROTOCOL_VERSION) {
            ws.send(
              encodeError(msg.id, {
                code: "bad_request",
                message: `protocol version ${msg.protocolVersion} not supported (server speaks ${PROTOCOL_VERSION})`,
              }),
            );
            ws.close(CloseCode.protocolError, "protocol version");
            return;
          }
          ws.data.authed = true;
          ws.send(encodeResult(msg.id, await handle(msg, ws)));
          ws.send(encodeEvent("sync.status", account.syncStatus()));
          return;
        }
        try {
          ws.send(encodeResult(msg.id, await handle(msg, ws)));
        } catch (error) {
          ws.send(encodeError(msg.id, toProtocolError(error)));
        }
      },
    },
  });

  await relay.start();

  return {
    port: server.port as number,
    hub,
    async stop() {
      voice.dispose();
      for (const ws of sockets) ws.close(CloseCode.serverShutdown, "server shutdown");
      await relay.stop();
      browser.session.close();
      auth.dispose();
      await account.stop();
      await hub.dispose();
      server.stop(true);
      db.close();
    },
  };
}
