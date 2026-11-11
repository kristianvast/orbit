import { decodeClientMessage } from "@orbit/protocol";
import { RepoError } from "../db/repo";
import type { FarmService } from "../services/farm";

/** ElevenLabs declares params as JSON text; local callers may pass an object. */
function parameters(raw: unknown): object {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = value.trim() ? JSON.parse(value) : {};
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new RepoError("bad_request", "The parameters must contain valid JSON for an object.");
    }
  }
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new RepoError("bad_request", "The parameters must be a JSON object.");
  return value;
}

export async function runVoiceTool(
  farm: FarmService,
  call: { readonly id: string; readonly name: string; readonly args: unknown },
  sessionId: string,
): Promise<unknown> {
  if (typeof call.args !== "object" || call.args === null || Array.isArray(call.args))
    throw new RepoError("bad_request", "Voice tool arguments must be an object.");
  const args = {
    ...call.args,
    params: parameters("params" in call.args ? call.args.params : undefined),
  };
  switch (call.name) {
    case "db_query": {
      const decoded = decodeClientMessage(
        JSON.stringify({ ...args, id: call.id, type: "db.query" }),
      );
      if (!decoded.ok || decoded.value.type !== "db.query")
        throw new RepoError("bad_request", "Invalid farm query.");
      return farm.repo.query(decoded.value.query, decoded.value.params);
    }
    case "db_mutate": {
      const decoded = decodeClientMessage(
        JSON.stringify({ ...args, id: call.id, type: "db.mutate" }),
      );
      if (!decoded.ok || decoded.value.type !== "db.mutate")
        throw new RepoError("bad_request", "Invalid farm mutation.");
      return farm.mutate(decoded.value, { sessionId, toolCallId: call.id });
    }
    default:
      throw new RepoError("bad_request", `Unknown voice tool ${call.name}.`);
  }
}
