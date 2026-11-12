import { expect, test } from "bun:test";
import { voiceRefusal } from "../src/voice/session";
import type { VoiceTransport } from "../src/voice/transport";
import { LiveVoiceTransport } from "../src/voice/transport";
import { TOKEN, waitFor } from "./helpers";
import { bounded, VoicePeer, voiceFixture } from "./voice-helpers";

const freePlanWith = (voiceSecondsUsed: number, voiceSecondsAllowance: number) => ({
  plan: "free" as const,
  interval: null,
  status: "free",
  currentPeriodEnd: null,
  trialEndsAt: voiceSecondsAllowance > 0 ? "2026-12-11T00:00:00.000Z" : null,
  cancelAtPeriodEnd: false,
  usage: { tokensUsed: 0, tokenAllowance: 2_000_000, voiceSecondsUsed, voiceSecondsAllowance },
});

test("a farm in its free month may start a call although its plan is still free", () => {
  expect(voiceRefusal(freePlanWith(0, 1800))).toBeNull();
});

test.each([
  ["no voice allowance", 0, 0, "plan_required"],
  ["a used-up voice allowance", 1800, 1800, "budget_exceeded"],
] as const)("%s refuses the call", (_name, used, allowance, code) => {
  expect(voiceRefusal(freePlanWith(used, allowance))?.code).toBe(code);
});

test("live transport authenticates Core and relays text bytes verbatim", async () => {
  const core = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (
        request.headers.get("authorization") !== "Bearer stored-session" ||
        request.headers.get("x-orbit-farm") !== "farm-1"
      )
        return new Response(null, { status: 401 });
      if (server.upgrade(request)) return undefined;
      return new Response(null, { status: 426 });
    },
    websocket: {
      message(socket, raw) {
        socket.send(raw);
      },
    },
  });
  const transport = new LiveVoiceTransport({
    url: `ws://127.0.0.1:${core.port}/v1/voice/agent`,
    headers: { authorization: "Bearer stored-session", "x-orbit-farm": "farm-1" },
  });
  const reply = Promise.withResolvers<string>();
  try {
    await transport.connect(reply.resolve, () => {});
    const raw = ' { "opaque" : true, "duplicates":1, "duplicates":2 } ';
    transport.send(raw);
    expect(await bounded(reply.promise)).toBe(raw);
  } finally {
    transport.close();
    core.stop(true);
  }
});

class DeferredUpstream implements VoiceTransport {
  readonly opened = Promise.withResolvers<void>();
  readonly connected = Promise.withResolvers<void>();
  readonly received = Promise.withResolvers<void>();
  readonly sent: string[] = [];
  receive: (frame: string) => void = () => {};
  closed: (code: number) => void = () => {};
  didClose = false;
  connect(receive: (frame: string) => void, closed: (code: number) => void) {
    this.receive = receive;
    this.closed = closed;
    this.connected.resolve();
    return this.opened.promise;
  }
  send(frame: string): void {
    this.sent.push(frame);
    if (this.sent.length === 2) this.received.resolve();
  }
  close(): void {
    this.didClose = true;
  }
}

test("local relay forwards opaque frames and budget close 4402 through a real WebSocket", async () => {
  const upstream = new DeferredUpstream();
  const f = await voiceFixture({ transport: () => upstream });
  const socket = new WebSocket(`ws://127.0.0.1:${f.app.port}${f.path}`);
  const opened = bounded(
    new Promise<void>((resolve) => {
      socket.onopen = () => resolve();
    }),
  );
  const reply = Promise.withResolvers<string>();
  socket.onmessage = (event) => reply.resolve(String(event.data));
  const closed = bounded(
    new Promise<number>((resolve) => {
      socket.onclose = (event) => resolve(event.code);
    }),
  );
  try {
    await opened;
    await bounded(upstream.connected.promise);
    const first = ' {"type":"user_message", "text":"early"} ';
    const second = "unparsed non-json frame";
    socket.send(first);
    socket.send(second);
    upstream.opened.resolve();
    await bounded(upstream.received.promise);
    expect(upstream.sent).toEqual([first, second]);
    upstream.receive(' { "server" : "opaque" } ');
    expect(await bounded(reply.promise)).toBe(' { "server" : "opaque" } ');
    const error = waitFor(f.client, "error", (event) => event.code === "budget_exceeded");
    upstream.closed(4402);
    expect(await error).toMatchObject({ sessionId: f.sessionId, code: "budget_exceeded" });
    expect(await closed).toBe(4402);
    expect(upstream.didClose).toBe(true);
  } finally {
    socket.close();
  }
});

test("voice socket paths enforce token call existence and one connection", async () => {
  const f = await voiceFixture();
  const base = `http://127.0.0.1:${f.app.port}`;
  const upgrade = {
    headers: {
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": "MDEyMzQ1Njc4OWFiY2RlZg==",
      "sec-websocket-version": "13",
    },
  };
  expect((await fetch(`${base}/voice/wrong/${f.voiceId}`, upgrade)).status).toBe(401);
  expect((await fetch(`${base}/voice/${TOKEN}/missing`, upgrade)).status).toBe(404);
  const peer = new VoicePeer(`${base.replace("http:", "ws:")}${f.path}`);
  await peer.opened;
  expect((await fetch(`${base}${f.path}`, upgrade)).status).toBe(409);
  await f.client.request("voice.stop", { voiceId: f.voiceId });
  await bounded(peer.closed);
  expect((await fetch(`${base}${f.path}`, upgrade)).status).toBe(404);
});
