import { expect, test } from "bun:test";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { connect, record, waitFor } from "./helpers";
import { bounded, holdModel, VoicePeer, voiceFixture } from "./voice-helpers";

const Call = Type.Object({
  tool_name: Type.Literal("db_query"),
  tool_call_id: Type.String(),
  parameters: Type.Unknown(),
});

test("a real mock voice socket greets and answers a herd question using the actual animal count", async () => {
  const f = await voiceFixture();
  const peer = new VoicePeer(`ws://127.0.0.1:${f.app.port}${f.path}`);
  await peer.opened;
  const greeting = peer.next("agent_response");
  peer.send({ type: "conversation_initiation_client_data", dynamic_variables: f.variables });
  expect(await peer.next("conversation_initiation_metadata")).toMatchObject({
    conversation_initiation_metadata_event: { conversation_id: expect.stringMatching(/^mock-/) },
  });
  expect(await greeting).toMatchObject({
    agent_response_event: { agent_response: "Hello, Orion here. How can I help?" },
  });
  const tool = peer.next("client_tool_call");
  peer.send({ type: "user_message", text: "Who is in my herd?" });
  const call = (await tool).client_tool_call;
  if (!Value.Check(Call, call)) throw new Error("Expected herd query");
  const answer = await f.client.request("voice.tool", {
    voiceId: f.voiceId,
    toolCallId: call.tool_call_id,
    name: call.tool_name,
    args: call.parameters,
  });
  const response = peer.next("agent_response");
  peer.send({
    type: "client_tool_result",
    tool_call_id: call.tool_call_id,
    result: answer.result,
    is_error: answer.isError,
  });
  const herd = await f.client.request("db.query", { query: "animals.list", params: {} });
  if (!Value.Check(Type.Object({ total: Type.Number() }), herd))
    throw new Error("Missing herd count");
  expect(await response).toMatchObject({
    agent_response_event: {
      agent_response: `There are ${herd.total} animals in your herd. I checked the records on this computer.`,
    },
  });
});

test.each([
  ['{"species":"cattle"}', false],
  ["{invalid", true],
  ["[]", true],
  ["", false],
  [undefined, false],
])(
  "database tool parses params %p and reports invalid input in plain words",
  async (params, isError) => {
    const f = await voiceFixture();
    const answer = await f.client.request("voice.tool", {
      voiceId: f.voiceId,
      toolCallId: "params",
      name: "db_query",
      args: { query: "animals.list", params },
    });
    expect(answer.isError).toBe(isError);
    if (isError) expect(answer.result).toStartWith("Not done: ");
    else expect(JSON.parse(answer.result)).toMatchObject({ total: params ? 24 : 28 });
  },
);

test("another protocol socket cannot report turns or tools for a call", async () => {
  const f = await voiceFixture();
  const other = await connect(f.app);
  try {
    await expect(
      other.request("voice.turn", {
        voiceId: f.voiceId,
        role: "user",
        text: "Injected",
      }),
    ).rejects.toMatchObject({ code: "not_found", message: "Voice session is closed." });
    await expect(
      other.request("voice.tool", {
        voiceId: f.voiceId,
        toolCallId: "injected",
        name: "db_query",
        args: { query: "animals.list" },
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  } finally {
    other.close();
  }
});

test("closing the SDK socket still accepts final reports until stop", async () => {
  const f = await voiceFixture();
  const peer = new VoicePeer(`ws://127.0.0.1:${f.app.port}${f.path}`);
  await peer.opened;
  peer.socket.close();
  await bounded(peer.closed);
  expect(
    await f.client.request("voice.turn", { voiceId: f.voiceId, role: "user", text: "Last turn" }),
  ).toEqual({ accepted: true });
  expect(
    (
      await f.client.request("voice.tool", {
        voiceId: f.voiceId,
        toolCallId: "last",
        name: "db_query",
        args: { query: "animals.list" },
      })
    ).isError,
  ).toBe(false);
  await f.client.request("voice.stop", { voiceId: f.voiceId });
  await expect(
    f.client.request("voice.turn", { voiceId: f.voiceId, role: "user", text: "Too late" }),
  ).rejects.toMatchObject({ code: "not_found" });
});

test("orion_task answers Started while streaming and later ends its tool and sends a voice note", async () => {
  const f = await voiceFixture();
  const gate = holdModel(f.app.hub.runtime);
  const events = record(f.client);
  const settled = waitFor(f.client, "agent.settled");
  const ended = waitFor(f.client, "tool.end", (event) => event.toolCallId === "task");
  const note = waitFor(f.client, "voice.note");
  const answer = await f.client.request("voice.tool", {
    voiceId: f.voiceId,
    toolCallId: "task",
    name: "orion_task",
    args: { request: "Help me plan today" },
  });
  await gate.entered;
  expect(answer).toEqual({ result: "Started. I will tell you when it is ready.", isError: false });
  expect(f.app.hub.isStreaming(f.sessionId)).toBe(true);
  expect(events.filter((event) => event.type === "tool.end")).toEqual([]);
  const busy = await f.client.request("voice.tool", {
    voiceId: f.voiceId,
    toolCallId: "busy",
    name: "orion_task",
    args: { request: "Another job" },
  });
  expect(busy).toEqual({
    result: "Not done: Orion is already working on something in this conversation.",
    isError: true,
  });
  gate.release();
  await settled;
  expect(await ended).toMatchObject({ isError: false });
  expect((await note).text).toStartWith("Done: ");
});

test("a stopped orion_task is saved as stopped and the voice agent is told", async () => {
  const f = await voiceFixture();
  const gate = holdModel(f.app.hub.runtime);
  const ended = waitFor(f.client, "tool.end", (event) => event.toolCallId === "task");
  const note = waitFor(f.client, "voice.note");
  await f.client.request("voice.tool", {
    voiceId: f.voiceId,
    toolCallId: "task",
    name: "orion_task",
    args: { request: "Help me plan today" },
  });
  await gate.entered;
  const stopping = f.app.hub.abort(f.sessionId);
  gate.release();
  expect(await stopping).toBe(true);
  expect(await ended).toMatchObject({ result: "It was stopped.", isError: false });
  expect((await note).text).toBe("It was stopped.");
  const { items } = await f.client.request("sessions.open", { sessionId: f.sessionId });
  expect(items.filter((item) => item.kind === "tool")).toEqual([
    expect.objectContaining({ toolCallId: "task", status: "aborted" }),
  ]);
});
