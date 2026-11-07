import { DbMutateRequest, DbQueryRequest, decodeClientMessage } from "@orbit/protocol";
import { RepoError } from "../db/repo";
import type { FarmService } from "../services/farm";

export const voiceTools = [
  {
    functionDeclarations: [
      {
        name: "db_query",
        description:
          "Read farm records using a named query: herd list, animal detail, observations, devices and bindings. Never invent farm data.",
        parametersJsonSchema: DbQueryRequest,
      },
      {
        name: "db_mutate",
        description:
          "Change farm records with a named mutation. Farm roles, one wearable per animal and undo snapshots are enforced. Use observations.add to record an observation.",
        parametersJsonSchema: DbMutateRequest,
      },
    ],
  },
];

export async function runVoiceTool(
  farm: FarmService,
  call: { readonly id: string; readonly name: string; readonly args: unknown },
  sessionId: string,
): Promise<unknown> {
  if (typeof call.args !== "object" || call.args === null) {
    throw new RepoError("bad_request", "Voice tool arguments must be an object.");
  }
  switch (call.name) {
    case "db_query": {
      const decoded = decodeClientMessage(
        JSON.stringify({ ...call.args, id: call.id, type: "db.query" }),
      );
      if (!decoded.ok || decoded.value.type !== "db.query")
        throw new RepoError("bad_request", "Invalid farm query.");
      return farm.repo.query(decoded.value.query, decoded.value.params);
    }
    case "db_mutate": {
      const decoded = decodeClientMessage(
        JSON.stringify({ ...call.args, id: call.id, type: "db.mutate" }),
      );
      if (!decoded.ok || decoded.value.type !== "db.mutate")
        throw new RepoError("bad_request", "Invalid farm mutation.");
      return farm.mutate(decoded.value, { sessionId, toolCallId: call.id });
    }
    default:
      throw new RepoError("bad_request", `Unknown voice tool ${call.name}.`);
  }
}
