import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import {
  assertNever,
  cameraWebSocket,
  type SocketData,
  serveCamera,
} from "../src/services/camera-proxy";

test("camera proxy preserves upstream HTTP responses and MSE text and binary frames", async () => {
  let upstreamClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    upstreamClosed = resolve;
  });
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/api/ws" && server.upgrade(request)) return undefined;
      return new Response(`frame:${url.searchParams.get("src")}`, {
        status: 418,
        headers: { "Content-Type": "image/jpeg" },
      });
    },
    websocket: {
      message(ws, message) {
        ws.send(message);
        if (typeof message === "string") ws.send(new Uint8Array([0, 1, 127, 255]));
      },
      close() {
        upstreamClosed?.();
      },
    },
  });
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const proxy = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      return serveCamera(request, server, {
        tokenPath: (pathname) => ({
          segments: pathname.split("/").slice(3).map(decodeURIComponent),
        }),
        relay: {
          status: () => ({ available: true, reason: null }),
          has: (id) => id === "barn",
          url(id, endpoint) {
            const url = new URL(`/api/${endpoint}?src=${encodeURIComponent(id)}`, upstream.url);
            if (endpoint === "ws") url.protocol = "ws:";
            return url;
          },
        },
      });
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
      message(ws, raw) {
        switch (ws.data.kind) {
          case "camera":
            cameraWebSocket.message(ws, ws.data, raw);
            break;
          case "protocol":
            break;
          default:
            assertNever(ws.data);
        }
      },
      close(ws) {
        sockets.delete(ws);
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
    },
  });
  const ws = new WebSocket(
    new URL("/camera/token/barn/ws", proxy.url).href.replace("http:", "ws:"),
  );
  ws.binaryType = "arraybuffer";
  try {
    const frames = new Promise<(string | number[])[]>((resolve, reject) => {
      const received: (string | number[])[] = [];
      const timer = setTimeout(() => reject(new TypeError("camera frames timed out")), 3000);
      ws.onopen = () => {
        ws.send('{"type":"mse","value":"avc1.640029"}');
        ws.send(new Uint8Array([4, 3, 2, 1]));
      };
      ws.onerror = () => reject(new TypeError("camera socket failed"));
      ws.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
        received.push(
          typeof event.data === "string" ? event.data : [...new Uint8Array(event.data)],
        );
        if (received.length === 3) {
          clearTimeout(timer);
          resolve(received);
        }
      };
    });

    expect(await frames).toEqual([
      '{"type":"mse","value":"avc1.640029"}',
      [0, 1, 127, 255],
      [4, 3, 2, 1],
    ]);
    const frame = await fetch(new URL("/camera/token/barn/frame.jpeg", proxy.url));
    expect(frame.status).toBe(418);
    expect(frame.headers.get("content-type")).toBe("image/jpeg");
    expect(await frame.text()).toBe("frame:barn");
    const unregistered = await fetch(
      new URL(`/camera/token/${encodeURIComponent("exec:id")}/frame.jpeg`, proxy.url),
    );
    expect(unregistered.status).toBe(404);
    ws.close();
    await Promise.race([
      closed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new TypeError("upstream stayed open")), 3000),
      ),
    ]);
  } finally {
    ws.close();
    for (const socket of sockets) socket.close();
    proxy.stop(true);
    upstream.stop(true);
  }
});
