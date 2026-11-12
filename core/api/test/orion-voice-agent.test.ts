import { expect, test } from "bun:test";
import { ORION_VOICE_TOOLS, syncOrionVoiceAgent } from "../src/orion-voice-agent";

interface Call {
  method: string;
  path: string;
  key: string | null;
  body: unknown;
}

function elevenLabs(routes: Record<string, (body: unknown) => unknown>) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({
      method,
      path: url.pathname,
      key: new Headers(init?.headers).get("xi-api-key"),
      body,
    });
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return new Response("no such route", { status: 404 });
    return Response.json(route(body));
  };
  return { calls, fetch };
}

const names = ORION_VOICE_TOOLS.map((tool) => tool.name);

test("without an agent id it creates every tool and then the agent that uses them", async () => {
  let made = 0;
  const api = elevenLabs({
    "POST /v1/convai/tools": () => ({ id: `tool_${++made}` }),
    "POST /v1/convai/agents/create": () => ({ agent_id: "agent_new" }),
  });
  const result = await syncOrionVoiceAgent({ apiKey: "xi-test", fetch: api.fetch });

  expect(result).toEqual({
    agentId: "agent_new",
    created: true,
    tools: Object.fromEntries(names.map((name, i) => [name, `tool_${i + 1}`])),
  });
  expect(api.calls.every((call) => call.key === "xi-test")).toBe(true);
  const agent = api.calls.at(-1)?.body as {
    conversation_config: { agent: { prompt: { tool_ids: string[] } } };
    platform_settings: { auth: { enable_auth: boolean } };
  };
  expect(agent.conversation_config.agent.prompt.tool_ids).toEqual(
    names.map((_, i) => `tool_${i + 1}`),
  );
  expect(agent.platform_settings.auth.enable_auth).toBe(true);
});

test("with an agent id it updates that agent's own tools and creates only the missing ones", async () => {
  const api = elevenLabs({
    "GET /v1/convai/agents/agent_1": () => ({
      conversation_config: { agent: { prompt: { tool_ids: ["tool_a", "tool_b"] } } },
    }),
    "GET /v1/convai/tools/tool_a": () => ({ id: "tool_a", tool_config: { name: "db_query" } }),
    "GET /v1/convai/tools/tool_b": () => ({ id: "tool_b", tool_config: { name: "app" } }),
    "PATCH /v1/convai/tools/tool_a": () => ({ id: "tool_a" }),
    "PATCH /v1/convai/tools/tool_b": () => ({ id: "tool_b" }),
    "POST /v1/convai/tools": (body) => ({
      id: `new_${(body as { tool_config: { name: string } }).tool_config.name}`,
    }),
    "PATCH /v1/convai/agents/agent_1": () => ({ agent_id: "agent_1" }),
  });
  const result = await syncOrionVoiceAgent({
    apiKey: "xi-test",
    agentId: "agent_1",
    fetch: api.fetch,
  });

  expect(result.created).toBe(false);
  expect(result.tools).toEqual({
    db_query: "tool_a",
    db_mutate: "new_db_mutate",
    app: "tool_b",
    browser: "new_browser",
    orion_task: "new_orion_task",
  });
  expect(api.calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual([
    "/v1/convai/tools",
    "/v1/convai/tools",
    "/v1/convai/tools",
  ]);
});

test("when the agent is refused, the tools made in that run are removed again", async () => {
  let made = 0;
  const api = elevenLabs({
    "POST /v1/convai/tools": () => ({ id: `tool_${++made}` }),
    ...Object.fromEntries(
      names.map((_, i) => [`DELETE /v1/convai/tools/tool_${i + 1}`, () => ({ status: "ok" })]),
    ),
  });
  await expect(syncOrionVoiceAgent({ apiKey: "xi-test", fetch: api.fetch })).rejects.toThrow(
    "ElevenLabs POST /v1/convai/agents/create answered 404",
  );
  expect(api.calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual(
    names.map((_, i) => `/v1/convai/tools/tool_${i + 1}`),
  );
});

test("a refusal from ElevenLabs stops the sync and names the request", async () => {
  const api = elevenLabs({});
  await expect(syncOrionVoiceAgent({ apiKey: "xi-test", fetch: api.fetch })).rejects.toThrow(
    "ElevenLabs POST /v1/convai/tools answered 404",
  );
  expect(api.calls).toHaveLength(1);
});
