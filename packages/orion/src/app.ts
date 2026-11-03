// Wires the database, secret store, approval gate, Pi sessions and the WebSocket protocol server.
import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
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
import { ApprovalGate } from "./agent/gate";
import { HubError, SessionHub } from "./agent/hub";
import { MOCK_MODEL, MOCK_PROVIDER } from "./agent/mock-model";
import { createFarmTools } from "./agent/tools";
import { Workspace } from "./agent/workspace";
import type { OrionConfig } from "./config";
import { openDatabase } from "./db/open";
import { RepoError } from "./db/repo";
import { materializeResources } from "./resources";
import { openSecretStore } from "./secrets";
import { FarmService } from "./services/farm";
import { maskKey, SettingsStore } from "./settings";

export const SERVER_VERSION = "0.1.0";

interface SocketData {
  authed: boolean;
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
  return { code: "internal", message: error instanceof Error ? error.message : String(error) };
}

export async function startOrion(config: OrionConfig): Promise<OrionApp> {
  mkdirSync(config.dataDir, { recursive: true });
  const workspace = new Workspace(join(config.dataDir, "workspace"));
  await workspace.init();
  if (!workspace.available) {
    process.stderr.write("orion: git not found; workspace snapshots are unavailable\n");
  }

  const db = openDatabase(config.dataDir, { seed: config.seed });
  const repo = db.repo;
  const secrets = await openSecretStore(config.dataDir, repo.installId);
  const settings = new SettingsStore(config.dataDir);
  const sockets = new Set<ServerWebSocket<SocketData>>();

  const emit = <E extends EventType>(type: E, body: EventBody<E>) => {
    const frame = encodeEvent(type, body);
    for (const ws of sockets) if (ws.data.authed) ws.send(frame);
  };
  repo.onChange((table, ids) => emit("db.changed", { table, ids }));

  const gate = new ApprovalGate(workspace.dir, settings, join(config.dataDir, "audit.log"), emit);
  const resources = materializeResources(config.dataDir);
  const farm = new FarmService(repo, secrets, workspace.dir, resources.connectorTemplateDir);
  const hub = await SessionHub.create({
    dataDir: config.dataDir,
    workspace,
    resourcesDir: resources.dir,
    repo,
    settings,
    gate,
    tools: createFarmTools(farm),
    emit,
    mockModel: config.mockModel,
    gatewayUrl: config.gatewayUrl,
  });

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
      approvalMode: s.approvalMode,
      apiKeys,
      alwaysAllow: s.alwaysAllow,
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
      ...(u.approvalMode ? { approvalMode: u.approvalMode } : {}),
      ...(u.alwaysAllow ? { alwaysAllow: u.alwaysAllow } : {}),
    });
    return settingsView();
  };

  const undoSnapshot = async (snapshotId: string) => {
    const snap = repo.getSnapshot(snapshotId);
    const workspaceChange = snap.changes.find((c) => c.table === "workspace");
    if (!workspaceChange) return repo.undoDbSnapshot(snapshotId);
    if (snap.undoneAt) throw new RequestError("conflict", "this change was already undone");
    if (!workspace.available) {
      throw new RequestError("not_ready", "snapshots are unavailable because git is not installed");
    }
    let files: string[];
    try {
      files = await workspace.revert(workspaceChange.rowId);
    } catch (error) {
      throw new RequestError("conflict", error instanceof Error ? error.message : String(error));
    }
    return {
      snapshot: repo.markSnapshotUndone(snapshotId),
      restored: [{ table: "workspace", ids: files }],
    };
  };

  const handle = async (msg: ClientMessage): Promise<unknown> => {
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
      case "approval.respond":
        return { accepted: gate.respond(msg.approvalId, msg.decision) };
      case "settings.get":
        return settingsView();
      case "settings.update": {
        const { id: _id, type: _type, ...update } = msg;
        return updateSettings(update);
      }
      case "db.query":
        return repo.query(msg.query, msg.params as never);
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
        if (srv.upgrade(req, { data: { authed: false } })) return undefined;
        return new Response("WebSocket upgrade required", { status: 426 });
      }
      if (url.pathname === "/health") return Response.json({ ok: true, version: SERVER_VERSION });
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      async message(ws, raw) {
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
          ws.send(encodeResult(msg.id, await handle(msg)));
          ws.send(
            encodeEvent("sync.status", {
              state: "disabled",
              pendingOutbox: repo.pendingOutbox(),
              lastSyncedAt: null,
            }),
          );
          return;
        }
        try {
          ws.send(encodeResult(msg.id, await handle(msg)));
        } catch (error) {
          ws.send(encodeError(msg.id, toProtocolError(error)));
        }
      },
    },
  });

  return {
    port: server.port as number,
    hub,
    async stop() {
      for (const ws of sockets) ws.close(CloseCode.serverShutdown, "server shutdown");
      await hub.dispose();
      server.stop(true);
      db.close();
    },
  };
}
