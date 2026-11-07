import { expect, test } from "bun:test";
import { LiveVoiceTransport } from "../src/voice/transport";

test("voice transport authenticates the Core WebSocket and delivers JSON audio", async () => {
  const core = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (
        request.headers.get("authorization") !== "Bearer stored-session" ||
        request.headers.get("x-orbit-farm") !== "farm-1"
      ) {
        return new Response(null, { status: 401 });
      }
      if (server.upgrade(request)) return undefined;
      return new Response(null, { status: 426 });
    },
    websocket: {
      message(socket, raw) {
        const frame: unknown = JSON.parse(String(raw));
        if (
          JSON.stringify(frame) ===
          '{"realtimeInput":{"audio":{"data":"AAAA","mimeType":"audio/pcm;rate=16000"}}}'
        ) {
          socket.send(
            JSON.stringify({
              serverContent: {
                modelTurn: {
                  parts: [{ inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" } }],
                },
              },
            }),
          );
        }
      },
    },
  });
  const transport = new LiveVoiceTransport({
    url: `ws://127.0.0.1:${core.port}/v1/voice/live`,
    headers: { authorization: "Bearer stored-session", "x-orbit-farm": "farm-1" },
  });
  const reply = Promise.withResolvers<unknown>();
  try {
    await transport.connect(reply.resolve, () => {});
    transport.send({
      realtimeInput: { audio: { data: "AAAA", mimeType: "audio/pcm;rate=16000" } },
    });
    expect(await reply.promise).toEqual({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" } }] },
      },
    });
  } finally {
    transport.close();
    core.stop(true);
  }
});
