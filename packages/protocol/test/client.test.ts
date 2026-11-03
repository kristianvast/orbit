import { afterEach, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { createOrionClient, OrionRequestError } from "../src/client";
import { decodeClientMessage, encodeError, encodeEvent, encodeResult } from "../src/codec";
import { CloseCode, type SessionSummary } from "../src/model";

const session: SessionSummary = {
  id: "s1",
  title: "Herd check",
  createdAt: "2026-11-03T00:00:00Z",
  updatedAt: "2026-11-03T00:00:00Z",
  messageCount: 0,
  model: null,
  streaming: false,
  parentSessionId: null,
};

type Conn = ServerWebSocket<{ authed: boolean }>;

/** Minimal Orion-like test server. */
function startServer() {
  const sockets = new Set<Conn>();
  const connected: ((ws: Conn) => void)[] = [];
  const server = Bun.serve<{ authed: boolean }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      if (new URL(req.url).pathname === "/ws" && srv.upgrade(req, { data: { authed: false } }))
        return;
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, raw) {
        const decoded = decodeClientMessage(raw as string);
        if (!decoded.ok) return;
        const msg = decoded.value;
        if (!ws.data.authed) {
          if (msg.type !== "hello" || msg.token !== "secret") {
            ws.send(encodeError(msg.id, { code: "unauthorized", message: "bad token" }));
            ws.close(CloseCode.unauthorized, "unauthorized");
            return;
          }
          ws.data.authed = true;
          ws.send(
            encodeResult(msg.id, { protocolVersion: 1, serverVersion: "test", farmId: null }),
          );
          for (const c of connected.splice(0)) c(ws);
          return;
        }
        switch (msg.type) {
          case "sessions.list":
            ws.send(encodeResult(msg.id, { sessions: [session] }));
            break;
          case "chat.prompt":
            ws.send(encodeResult(msg.id, { accepted: true }));
            ws.send(
              encodeEvent("message.delta", {
                sessionId: msg.sessionId,
                messageId: "m1",
                text: "Bella is fine",
              }),
            );
            ws.send(
              encodeEvent("agent.settled", { sessionId: msg.sessionId, reason: "completed" }),
            );
            break;
          case "db.query":
            ws.send(encodeResult(msg.id, { rows: [], echo: msg.query }));
            break;
          case "sessions.delete":
            ws.send(encodeError(msg.id, { code: "not_found", message: "no such session" }));
            break;
          case "sessions.rename":
            ws.send(encodeResult(msg.id, { session: { id: 42 } }));
            break;
          default:
            break; // never answers: used for timeout/disconnect tests
        }
      },
    },
  });
  return {
    url: `ws://127.0.0.1:${server.port}/ws`,
    dropAll: () => {
      for (const s of sockets) s.close(1011, "drop");
    },
    nextAuthed: () => new Promise<Conn>((resolve) => connected.push(resolve)),
    stop: () => server.stop(true),
  };
}

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup) c();
  cleanup = [];
});

describe("createOrionClient", () => {
  test("hello, typed requests, queries and events", async () => {
    const srv = startServer();
    const client = createOrionClient(srv.url, "secret", { clientName: "test" });
    cleanup.push(() => client.close(), srv.stop);
    // Queued before the connection is open.
    const listing = client.request("sessions.list");
    await client.ready();
    expect(client.state).toBe("open");
    expect(client.server?.serverVersion).toBe("test");
    expect((await listing).sessions[0]?.title).toBe("Herd check");

    const deltas: string[] = [];
    const all: string[] = [];
    client.on("message.delta", (e) => deltas.push(e.text ?? ""));
    client.on("*", (e) => all.push(e.type));
    const settled = new Promise<void>((resolve) => client.on("agent.settled", () => resolve()));
    expect(await client.request("chat.prompt", { sessionId: "s1", text: "How is Bella?" })).toEqual(
      { accepted: true },
    );
    await settled;
    expect(deltas).toEqual(["Bella is fine"]);
    expect(all).toEqual(["message.delta", "agent.settled"]);

    expect(await client.query("animals.list", { species: "cattle" })).toMatchObject({ rows: [] });
  });

  test("error responses and invalid results reject with OrionRequestError", async () => {
    const srv = startServer();
    const client = createOrionClient(srv.url, "secret");
    cleanup.push(() => client.close(), srv.stop);
    const del = client.request("sessions.delete", { sessionId: "x" });
    await expect(del).rejects.toBeInstanceOf(OrionRequestError);
    await expect(del).rejects.toMatchObject({ code: "not_found" });
    await expect(
      client.request("sessions.rename", { sessionId: "s1", title: "t" }),
    ).rejects.toMatchObject({ code: "internal" });
  });

  test("request timeout", async () => {
    const srv = startServer();
    const client = createOrionClient(srv.url, "secret", { requestTimeoutMs: 50 });
    cleanup.push(() => client.close(), srv.stop);
    await expect(client.request("settings.get")).rejects.toMatchObject({ code: "timeout" });
  });

  test("bad token ends in unauthorized without reconnecting", async () => {
    const srv = startServer();
    const client = createOrionClient(srv.url, "wrong");
    cleanup.push(() => client.close(), srv.stop);
    await expect(client.ready()).rejects.toMatchObject({ code: "unauthorized" });
    expect(client.state).toBe("unauthorized");
    await expect(client.request("sessions.list")).rejects.toMatchObject({ code: "unauthorized" });
  });

  test("reconnects after a dropped connection and fails in-flight requests", async () => {
    const srv = startServer();
    const client = createOrionClient(srv.url, "secret", {
      reconnect: { minDelayMs: 10, maxDelayMs: 20 },
    });
    cleanup.push(() => client.close(), srv.stop);
    await client.ready();
    const states: string[] = [];
    client.onState((s) => states.push(s));
    const inflight = client.request("settings.get"); // server never answers
    const reauthed = srv.nextAuthed();
    await Bun.sleep(0);
    srv.dropAll();
    await expect(inflight).rejects.toMatchObject({ code: "disconnected" });
    await reauthed;
    await client.ready();
    expect(states).toEqual(["reconnecting", "open"]);
    expect((await client.request("sessions.list")).sessions).toHaveLength(1);
  });

  test("close rejects pending work and stops", async () => {
    const srv = startServer();
    const client = createOrionClient(srv.url, "secret");
    cleanup.push(srv.stop);
    await client.ready();
    const pending = client.request("settings.get");
    client.close();
    await expect(pending).rejects.toMatchObject({ code: "disconnected" });
    expect(client.state).toBe("closed");
  });
});
