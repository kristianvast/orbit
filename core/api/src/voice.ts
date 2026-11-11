import type { Server, ServerWebSocket } from "bun";
import { eq } from "drizzle-orm";
import { memberRole, resolveSession } from "./auth";
import { type CoreDb, voiceUsage } from "./db";
import { entitlements, planRequired, usageThisMonth } from "./entitlements";
import { object } from "./stripe";

export interface VoiceOptions {
  readonly now?: () => Date;
  readonly project?: string;
  readonly model?: string;
  readonly location?: string;
  readonly accessToken: () => Promise<string>;
}

export interface VoiceConnection {
  readonly id: string;
  readonly farmId: string;
  readonly model: string;
  readonly allowance: number;
  readonly startedAt: number;
  readonly upstream: WebSocket;
  readonly transform?: (frame: string) => string;
  readonly pending: string[];
  timer?: ReturnType<typeof setInterval>;
  closed: boolean;
  ticking: boolean;
}

interface VoiceUpstream {
  readonly model: string;
  readonly connect: () => WebSocket;
  readonly transform?: (frame: string) => string;
}

interface RelayOptions {
  readonly now?: () => Date;
  readonly prepare: (request: Request) => Promise<VoiceUpstream | Response>;
}

export function createVoiceGateway(db: CoreDb, options: VoiceOptions) {
  return createVoiceRelay(db, {
    now: options.now,
    async prepare() {
      if (!options.project || !options.model)
        return Response.json({ error: { code: "not_configured" } }, { status: 503 });
      const location = options.location ?? "us-central1";
      const model = `projects/${options.project}/locations/${location}/publishers/google/models/${options.model}`;
      const accessToken = await options.accessToken();
      return {
        model,
        connect: () =>
          new WebSocket(
            `wss://${location}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent`,
            { headers: { authorization: `Bearer ${accessToken}` } },
          ),
        transform(message) {
          const frame = object(JSON.parse(message));
          if (frame.setup !== undefined) frame.setup = { ...object(frame.setup), model };
          return JSON.stringify(frame);
        },
      };
    },
  });
}

export function createVoiceRelay(db: CoreDb, options: RelayOptions) {
  const now = options.now ?? (() => new Date());
  const persist = (data: VoiceConnection) =>
    db
      .update(voiceUsage)
      .set({ seconds: Math.ceil((now().getTime() - data.startedAt) / 1000) })
      .where(eq(voiceUsage.id, data.id));
  return {
    async upgrade(
      request: Request,
      server: Server<VoiceConnection>,
    ): Promise<Response | undefined> {
      const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
      const user = await resolveSession(db, token, now());
      if (!user)
        return Response.json(
          { error: { code: "unauthorized", message: "Sign in first" } },
          { status: 401 },
        );
      const farmId = request.headers.get("x-orbit-farm") ?? "";
      if (!/^[0-9a-f-]{36}$/i.test(farmId))
        return Response.json(
          { error: { code: "bad_request", message: "x-orbit-farm is required" } },
          { status: 400 },
        );
      if (!(await memberRole(db, farmId, user.id)))
        return Response.json({ error: { code: "forbidden" } }, { status: 403 });
      const entitlement = await entitlements(db, farmId, now());
      if (entitlement.voiceSecondsAllowance === 0)
        return Response.json(planRequired(entitlement), { status: 402 });
      const usage = await usageThisMonth(db, farmId, entitlement.usageStart);
      if (usage.voiceSecondsUsed >= entitlement.voiceSecondsAllowance)
        return Response.json({ error: { code: "budget_exceeded" } }, { status: 429 });
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
        return new Response("WebSocket upgrade required", { status: 426 });
      const prepared = await options.prepare(request);
      if (prepared instanceof Response) return prepared;
      const id = crypto.randomUUID();
      // Failed provider preparation never creates a charge.
      await db
        .insert(voiceUsage)
        .values({ id, farmId, model: prepared.model, seconds: 0, createdAt: now().toISOString() });
      const upstream = prepared.connect();
      upstream.binaryType = "arraybuffer";
      const data: VoiceConnection = {
        id,
        farmId,
        model: prepared.model,
        allowance: entitlement.voiceSecondsAllowance,
        startedAt: now().getTime(),
        upstream,
        transform: prepared.transform,
        pending: [],
        closed: false,
        ticking: false,
      };
      if (server.upgrade(request, { data })) return undefined;
      upstream.close();
      return new Response("WebSocket upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws: ServerWebSocket<VoiceConnection>) {
        const data = ws.data;
        data.upstream.addEventListener(
          "open",
          () => {
            if (data.closed) return;
            for (const frame of data.pending) data.upstream.send(frame);
            data.pending.length = 0;
          },
          { once: true },
        );
        data.upstream.addEventListener("message", async (event) => {
          if (typeof event.data === "string") ws.send(event.data);
          else if (event.data instanceof ArrayBuffer) ws.send(new TextDecoder().decode(event.data));
          else if (event.data instanceof Blob) ws.send(await event.data.text());
          else ws.close(1011, "Unsupported upstream frame");
        });
        data.upstream.addEventListener("close", () => ws.close(1000, "Voice upstream closed"));
        data.upstream.addEventListener("error", () => ws.close(1011, "Voice upstream failed"));
        data.timer = setInterval(async () => {
          if (data.closed || data.ticking) return;
          data.ticking = true;
          try {
            await persist(data);
            const current = await entitlements(db, data.farmId, now());
            const { voiceSecondsUsed } = await usageThisMonth(db, data.farmId, current.usageStart);
            if (voiceSecondsUsed >= current.voiceSecondsAllowance)
              ws.close(4402, "Voice allowance used up");
          } catch (error) {
            if (error instanceof Error) ws.close(1011, "Voice metering failed");
            else throw error;
          } finally {
            data.ticking = false;
          }
        }, 1000);
      },
      message(ws: ServerWebSocket<VoiceConnection>, message: string | Buffer) {
        try {
          const text = typeof message === "string" ? message : message.toString();
          const frame = ws.data.transform ? ws.data.transform(text) : text;
          if (ws.data.upstream.readyState === WebSocket.CONNECTING) {
            ws.data.pending.push(frame);
            return;
          }
          if (!ws.data.closed && ws.data.upstream.readyState === WebSocket.OPEN)
            ws.data.upstream.send(frame);
        } catch (error) {
          if (error instanceof Error) ws.close(1008, "Invalid voice frame or upstream unavailable");
          else throw error;
        }
      },
      async close(ws: ServerWebSocket<VoiceConnection>) {
        ws.data.closed = true;
        clearInterval(ws.data.timer);
        ws.data.pending.length = 0;
        ws.data.upstream.close();
        await persist(ws.data);
      },
    },
  };
}
