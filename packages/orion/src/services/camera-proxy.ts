import type { Server, ServerWebSocket } from "bun";
import type { Go2rtcRelay } from "./relay";

export type CameraSocketData = {
  readonly kind: "camera";
  readonly url: string;
  upstream: WebSocket | null;
  readonly pending: (string | Buffer)[];
  pendingBytes: number;
};

export type SocketData = { readonly kind: "protocol"; authed: boolean } | CameraSocketData;

export function assertNever(value: never): never {
  throw new TypeError("unknown socket kind", { cause: value });
}

type TokenPath = (pathname: string) => { segments: string[] } | Response;

/** Uses Orion's token parser before checking availability or opening any upstream connection. */
export async function serveCamera(
  request: Request,
  server: Server<SocketData>,
  context: {
    readonly tokenPath: TokenPath;
    readonly relay: Pick<Go2rtcRelay, "status" | "has" | "url">;
  },
): Promise<Response | undefined> {
  const parsed = context.tokenPath(new URL(request.url).pathname);
  if (parsed instanceof Response) return parsed;
  const [cameraId, endpoint] = parsed.segments;
  if (!cameraId || parsed.segments.length !== 2 || !["frame.jpeg", "ws"].includes(endpoint ?? ""))
    return new Response("not found", { status: 404 });
  if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
  const status = context.relay.status();
  if (!status.available) return new Response(status.reason, { status: 503 });
  if (!context.relay.has(cameraId)) return new Response("unknown camera", { status: 404 });
  if (endpoint === "ws") {
    if (
      server.upgrade(request, {
        data: {
          kind: "camera",
          url: context.relay.url(cameraId, "ws").href,
          upstream: null,
          pending: [],
          pendingBytes: 0,
        },
      })
    )
      return undefined;
    return new Response("WebSocket upgrade required", { status: 426 });
  }
  try {
    const response = await fetch(context.relay.url(cameraId, "frame.jpeg"), {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
    });
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return new Response("go2rtc unavailable", { status: 503 });
  }
}

export const cameraWebSocket = {
  open(ws: ServerWebSocket<SocketData>, data: CameraSocketData) {
    const upstream = new WebSocket(data.url);
    data.upstream = upstream;
    upstream.binaryType = "arraybuffer";
    upstream.onopen = () => {
      for (const frame of data.pending) upstream.send(frame);
      data.pending.length = 0;
      data.pendingBytes = 0;
    };
    upstream.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      ws.send(event.data);
    };
    upstream.onclose = () => ws.close(1011, "camera upstream closed");
    upstream.onerror = () => {
      upstream.close();
      ws.close(1011, "camera upstream unavailable");
    };
  },
  message(ws: ServerWebSocket<SocketData>, data: CameraSocketData, raw: string | Buffer) {
    const upstream = data.upstream;
    if (upstream?.readyState === WebSocket.OPEN) {
      upstream.send(raw);
      return;
    }
    data.pendingBytes += Buffer.byteLength(raw);
    if (data.pendingBytes > 1024 * 1024) {
      ws.close(1009, "camera startup buffer exceeded");
      upstream?.close();
      return;
    }
    data.pending.push(raw);
  },
  close(data: CameraSocketData) {
    data.pending.length = 0;
    data.upstream?.close();
  },
};
