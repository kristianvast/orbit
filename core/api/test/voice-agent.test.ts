import { expect, test } from "bun:test";
import { farmSubscriptions, voiceUsage } from "../src/db";
import { billingFixture, FARM, NOW } from "./billing-fixture";
import { deferred, serveAgent, socketEvent } from "./voice-agent-fixture";

const { db, headers } = billingFixture();
async function paid() {
  await db.insert(farmSubscriptions).values({
    farmId: FARM,
    plan: "orion",
    interval: "month",
    status: "active",
  });
}

test("agent relays opaque frames in order before upstream opens and meters on client close", async () => {
  await paid();
  let clock = NOW.getTime();
  const handshake = deferred<void>();
  const upstreamClosed = deferred<void>();
  const frames = deferred<string[]>();
  const seen: string[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      await handshake.promise;
      if (server.upgrade(request)) return;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      message(ws, message) {
        seen.push(String(message));
        ws.send(String(message));
        if (seen.length === 2) frames.resolve(seen);
      },
      close() {
        upstreamClosed.resolve();
      },
    },
  });
  const gateway = serveAgent(db, {
    now: () => new Date(clock),
    fetch: async (input, init) => {
      expect(new URL(String(input)).searchParams.get("agent_id")).toBe("agent_test");
      expect(new Headers(init?.headers).get("xi-api-key")).toBe("server-secret");
      return Response.json({ signed_url: `ws://127.0.0.1:${upstream.port}/?private=signed` });
    },
  });
  const client = new WebSocket(gateway.url.replace("http:", "ws:"), { headers: headers() });
  try {
    await socketEvent(client, "open");
    const sent = [
      ' { "type": "conversation_initiation_client_data", "setup": {"model":"untouched"} } ',
      '{"user_audio_chunk":"abc"}',
    ];
    const echoes = deferred<string[]>();
    const replies: string[] = [];
    client.addEventListener("message", (event) => {
      replies.push(String(event.data));
      if (replies.length === 2) echoes.resolve(replies);
    });
    client.send(sent[0] ?? "");
    await gateway.received;
    client.send(sent[1] ?? "");
    handshake.resolve();
    expect(await frames.promise).toEqual(sent);
    expect(await echoes.promise).toEqual(sent);
    clock += 2250;
    client.close();
    await gateway.closed;
    await upstreamClosed.promise;
    expect(await db.select().from(voiceUsage)).toMatchObject([
      { farmId: FARM, model: "elevenlabs:agent_test", seconds: 3 },
    ]);
  } finally {
    client.close();
    await gateway.server.stop(true);
    await upstream.stop(true);
  }
});

test("agent persists periodic usage and closes both sockets at the shared allowance", async () => {
  await paid();
  await db.insert(voiceUsage).values({
    farmId: FARM,
    accountId: FARM,
    model: "live",
    seconds: 1799,
    createdAt: NOW.toISOString(),
  });
  let clock = NOW.getTime();
  const upstreamClosed = deferred<void>();
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      message() {},
      close() {
        upstreamClosed.resolve();
      },
    },
  });
  const gateway = serveAgent(db, {
    now: () => new Date(clock),
    fetch: async () => Response.json({ signed_url: `ws://127.0.0.1:${upstream.port}` }),
  });
  const client = new WebSocket(gateway.url.replace("http:", "ws:"), { headers: headers() });
  const closed = socketEvent(client, "close");
  try {
    await socketEvent(client, "open");
    clock += 1000;
    expect((await closed).code).toBe(4402);
    await gateway.closed;
    await upstreamClosed.promise;
    expect(await db.select().from(voiceUsage)).toMatchObject([
      { seconds: 1799 },
      { model: "elevenlabs:agent_test", seconds: 1 },
    ]);
  } finally {
    client.close();
    await gateway.server.stop(true);
    await upstream.stop(true);
  }
});

test("upstream closing ends the agent client connection", async () => {
  await paid();
  const end = deferred<void>();
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(ws) {
        void end.promise.then(() => ws.close());
      },
      message() {},
    },
  });
  const gateway = serveAgent(db, {
    now: () => NOW,
    fetch: async () => Response.json({ signed_url: `ws://127.0.0.1:${upstream.port}` }),
  });
  const client = new WebSocket(gateway.url.replace("http:", "ws:"), { headers: headers() });
  const closed = socketEvent(client, "close");
  try {
    await socketEvent(client, "open");
    end.resolve();
    expect((await closed).code).toBe(1000);
    await gateway.closed;
  } finally {
    client.close();
    await gateway.server.stop(true);
    await upstream.stop(true);
  }
});
