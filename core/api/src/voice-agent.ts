import type { CoreDb } from "./db";
import type { FetchLike } from "./shape";
import { object } from "./stripe";
import { createVoiceRelay } from "./voice";

export interface VoiceAgentOptions {
  readonly apiKey?: string;
  readonly agentId?: string;
  readonly apiBase?: string;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
}

export function createVoiceAgentGateway(db: CoreDb, options: VoiceAgentOptions) {
  const doFetch = options.fetch ?? fetch;
  return createVoiceRelay(db, {
    now: options.now,
    async prepare(request) {
      const { apiKey, agentId } = options;
      if (!apiKey || !agentId)
        return Response.json({ error: { code: "not_configured" } }, { status: 503 });
      try {
        const url = new URL(
          "/v1/convai/conversation/get-signed-url",
          options.apiBase ?? "https://api.elevenlabs.io",
        );
        url.searchParams.set("agent_id", agentId);
        const response = await doFetch(url, {
          headers: { "xi-api-key": apiKey },
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
        });
        if (!response.ok)
          return Response.json({ error: { code: "upstream_error" } }, { status: 502 });
        const data = object(await response.json());
        if (typeof data.signed_url !== "string" || !data.signed_url)
          return Response.json({ error: { code: "upstream_error" } }, { status: 502 });
        const signedUrl = new URL(data.signed_url);
        if (signedUrl.protocol !== "wss:" && signedUrl.protocol !== "ws:")
          return Response.json({ error: { code: "upstream_error" } }, { status: 502 });
        return {
          model: `elevenlabs:${agentId}`,
          connect: () => new WebSocket(signedUrl),
        };
      } catch (error) {
        if (error instanceof Error)
          return Response.json({ error: { code: "upstream_error" } }, { status: 502 });
        throw error;
      }
    },
  });
}
