import type { CoreDb } from "../src/db";
import type { VoiceConnection } from "../src/voice";
import { createVoiceAgentGateway, type VoiceAgentOptions } from "../src/voice-agent";

/** A deadline bounds an event subscription; it never supplies the event itself. */
export function deferred<T>() {
  const result = Promise.withResolvers<T>();
  const timer = setTimeout(() => result.reject(new TypeError("Voice event timed out")), 5000);
  result.promise.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer),
  );
  return result;
}

type SocketEvents = { readonly open: Event; readonly close: CloseEvent };

export function socketEvent<K extends keyof SocketEvents>(socket: WebSocket, type: K) {
  const event = deferred<SocketEvents[K]>();
  socket.addEventListener(type, (value) => event.resolve(value), { once: true });
  return event.promise;
}

export function serveAgent(db: CoreDb, options: VoiceAgentOptions = {}) {
  const gateway = createVoiceAgentGateway(db, {
    apiKey: "server-secret",
    agentId: "agent_test",
    ...options,
  });
  const closed = deferred<void>();
  const received = deferred<void>();
  const server = Bun.serve<VoiceConnection>({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) => gateway.upgrade(request, server),
    websocket: {
      ...gateway.websocket,
      message(ws, frame) {
        gateway.websocket.message(ws, frame);
        received.resolve();
      },
      async close(ws) {
        try {
          await gateway.websocket.close(ws);
          closed.resolve();
        } catch (error) {
          closed.reject(error);
        }
      },
    },
  });
  // HTTP-only tests never open a socket, so they do not await lifecycle events.
  void closed.promise.catch(() => {});
  void received.promise.catch(() => {});
  return {
    server,
    closed: closed.promise,
    received: received.promise,
    url: `http://127.0.0.1:${server.port}/v1/voice/agent`,
  };
}
