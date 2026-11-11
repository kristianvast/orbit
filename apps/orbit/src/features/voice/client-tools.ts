import { type OrionClient, OrionRequestError, type VoiceToolName } from "@orbit/protocol";
import { lastChat, rememberChat } from "../chat/last-chat";
import { parseAppAction, runAppAction } from "../guide";
import type { ActivityAction } from "./activity";
import type { StartVoiceOptions, VoiceClientToolCallbacks } from "./types";

export interface OpenedOrionVoiceSession {
  readonly sessionId: string;
  readonly voiceId: string;
  readonly path: string;
  readonly variables: Record<string, string>;
}

export async function openVoiceSessionOnOrion(
  client: OrionClient,
  options?: StartVoiceOptions,
): Promise<OpenedOrionVoiceSession> {
  let sessionId = options?.sessionId ?? null;
  let usedRecentCandidate = false;

  if (!sessionId && options?.resumeRecent) {
    const recent = lastChat();
    if (recent?.recent) {
      sessionId = recent.id;
      usedRecentCandidate = true;
    }
  }
  if (!sessionId) {
    const created = await client.request("sessions.create", {});
    sessionId = created.session.id;
  }

  let started: { voiceId: string; path: string; variables: Record<string, string> };
  try {
    started = await client.request("voice.start", { sessionId });
  } catch (err) {
    if (usedRecentCandidate && err instanceof OrionRequestError && err.code === "not_found") {
      const created = await client.request("sessions.create", {});
      sessionId = created.session.id;
      started = await client.request("voice.start", { sessionId });
    } else {
      throw err;
    }
  }

  rememberChat(sessionId);
  return {
    sessionId,
    voiceId: started.voiceId,
    path: started.path,
    variables: started.variables,
  };
}

export interface ClientToolsContext {
  readonly getClient: () => OrionClient | null;
  readonly getVoiceId: () => string | null;
  readonly claimToolCallId: (name: string) => string;
  readonly dispatchActivity: (action: ActivityAction) => void;
}

export function createVoiceClientTools(ctx: ClientToolsContext): VoiceClientToolCallbacks {
  const forwardToOrion = async (name: VoiceToolName, parameters: unknown): Promise<string> => {
    const toolCallId = ctx.claimToolCallId(name);
    const voiceId = ctx.getVoiceId();
    const client = ctx.getClient();
    if (!voiceId || !client) {
      throw new Error("Voice call is no longer connected.");
    }
    const res = await client.request("voice.tool", {
      voiceId,
      toolCallId,
      name,
      args: parameters ?? {},
    });
    if (res.isError) {
      throw new Error(res.result);
    }
    return res.result;
  };

  return {
    db_query: (params) => forwardToOrion("db_query", params),
    db_mutate: (params) => forwardToOrion("db_mutate", params),
    browser: (params) => forwardToOrion("browser", params),
    orion_task: (params) => forwardToOrion("orion_task", params),
    app: async (params) => {
      const toolCallId = ctx.claimToolCallId("app");
      const parsed = parseAppAction(params);
      ctx.dispatchActivity({
        type: "app.start",
        id: toolCallId,
        args: parsed ?? params,
        now: Date.now(),
      });
      if (!parsed) {
        const invalidMsg = "Not done: invalid app action parameters.";
        ctx.dispatchActivity({
          type: "app.end",
          id: toolCallId,
          result: invalidMsg,
          isError: true,
          now: Date.now(),
        });
        throw new Error(invalidMsg);
      }
      const out = await runAppAction(parsed);
      ctx.dispatchActivity({
        type: "app.end",
        id: toolCallId,
        result: out.result,
        isError: out.isError,
        now: Date.now(),
      });
      if (out.isError) {
        throw new Error(out.result);
      }
      return out.result;
    },
  };
}
