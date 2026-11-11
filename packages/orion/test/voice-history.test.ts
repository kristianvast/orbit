import { expect, spyOn, test } from "bun:test";
import type { Context } from "@earendil-works/pi-ai";
import { connect, record, startApp, waitFor } from "./helpers";
import { holdModel, voiceFixture } from "./voice-helpers";

test("spoken turns and finished voice tools survive reopening with voice markers", async () => {
  const f = await voiceFixture();
  await f.client.request("voice.turn", {
    voiceId: f.voiceId,
    role: "user",
    text: "Daisy needs attention",
  });
  await f.client.request("voice.turn", {
    voiceId: f.voiceId,
    role: "assistant",
    text: "I will check Daisy",
  });
  await f.client.request("voice.tool", {
    voiceId: f.voiceId,
    toolCallId: "saved-query",
    name: "db_query",
    args: { query: "animals.list" },
  });
  const before = await f.client.request("sessions.open", { sessionId: f.sessionId });
  f.client.close();
  await f.stop();
  const reopened = await startApp(f.dir);
  const client = await connect(reopened);
  try {
    const after = await client.request("sessions.open", { sessionId: f.sessionId });
    expect(after.items).toEqual(before.items);
    expect(after.items).toMatchObject([
      { kind: "user", text: "Daisy needs attention", voice: true },
      { kind: "assistant", text: "I will check Daisy", voice: true },
      { kind: "tool", toolCallId: "saved-query", status: "done" },
    ]);
  } finally {
    client.close();
    await reopened.stop();
  }
});

test("voice start returns earlier chat and spoken turns in conversation_recap", async () => {
  const f = await voiceFixture();
  const settled = waitFor(f.client, "agent.settled");
  await f.client.request("chat.prompt", { sessionId: f.sessionId, text: "Morning plans" });
  await settled;
  await f.client.request("voice.turn", { voiceId: f.voiceId, role: "user", text: "Check Daisy" });
  await f.client.request("voice.turn", {
    voiceId: f.voiceId,
    role: "assistant",
    text: "Daisy is in the herd",
  });
  const restarted = await f.client.request("voice.start", { sessionId: f.sessionId });
  expect(restarted.variables.conversation_recap).toStartWith("Farmer: Morning plans\nOrion: ");
  expect(restarted.variables.conversation_recap).toEndWith(
    "Farmer: Check Daisy\nOrion: Daisy is in the herd",
  );
});

test("a chat continuation sees spoken turns in the real mock model context and excludes tool history", async () => {
  const f = await voiceFixture();
  const first = waitFor(f.client, "agent.settled");
  await f.client.request("chat.prompt", { sessionId: f.sessionId, text: "Before the call" });
  await first;
  await f.client.request("voice.turn", {
    voiceId: f.voiceId,
    role: "user",
    text: "Daisy is in pen seven",
  });
  await f.client.request("voice.turn", {
    voiceId: f.voiceId,
    role: "assistant",
    text: "I remember pen seven",
  });
  await f.client.request("voice.tool", {
    voiceId: f.voiceId,
    toolCallId: "not-model-context",
    name: "db_query",
    args: { query: "animals.list" },
  });
  const contexts: Context[] = [];
  const original = f.app.hub.runtime.streamSimple.bind(f.app.hub.runtime);
  const spy = spyOn(f.app.hub.runtime, "streamSimple").mockImplementation(
    (model, context, options) => {
      contexts.push(structuredClone(context));
      return original(model, context, options);
    },
  );
  try {
    const settled = waitFor(f.client, "agent.settled");
    await f.client.request("chat.prompt", { sessionId: f.sessionId, text: "Continue" });
    await settled;
    const context = JSON.stringify(contexts.at(-1)?.messages);
    expect(context).toContain("Daisy is in pen seven");
    expect(context).toContain("I remember pen seven");
    expect(context).not.toContain("not-model-context");
  } finally {
    spy.mockRestore();
  }
});

test("a turn recorded during streaming emits immediately and is persisted before agent.settled", async () => {
  const f = await voiceFixture();
  const gate = holdModel(f.app.hub.runtime);
  const events = record(f.client);
  const settled = waitFor(f.client, "agent.settled");
  await f.client.request("chat.prompt", { sessionId: f.sessionId, text: "Working now" });
  await gate.entered;
  await f.client.request("voice.turn", {
    voiceId: f.voiceId,
    role: "user",
    text: "While you work",
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "message.end",
      item: expect.objectContaining({ text: "While you work", voice: true }),
    }),
  );
  expect(
    f.app.hub.open(f.sessionId).items.filter((item) => item.kind === "user" && item.voice),
  ).toEqual([]);
  gate.release();
  await settled;
  f.client.close();
  await f.stop();
  const reopened = await startApp(f.dir);
  try {
    expect(reopened.hub.open(f.sessionId).items).toContainEqual(
      expect.objectContaining({
        kind: "user",
        text: "While you work",
        voice: true,
      }),
    );
  } finally {
    await reopened.stop();
  }
});

test("whitespace-only turns leave history and title unchanged and first speech titles a conversation", async () => {
  const f = await voiceFixture();
  const { session } = await f.client.request("sessions.create", {});
  const call = await f.client.request("voice.start", { sessionId: session.id });
  expect(call.variables.conversation_recap).toBe("");
  await f.client.request("voice.turn", { voiceId: call.voiceId, role: "user", text: " \n\t " });
  expect(f.app.hub.open(session.id).items).toEqual([]);
  expect(f.app.hub.summary(session.id).title).toBe("New conversation");
  const changed = waitFor(f.client, "session.updated", (event) => event.sessionId === session.id);
  await f.client.request("voice.turn", {
    voiceId: call.voiceId,
    role: "user",
    text: "  Check   Daisy ",
  });
  expect((await changed).session.title).toBe("Check Daisy");
});

test("recap drops the oldest complete turns to stay under four thousand characters", async () => {
  const f = await voiceFixture();
  f.app.hub.recordVoiceTurn(f.sessionId, "user", "old".repeat(1000));
  f.app.hub.recordVoiceTurn(f.sessionId, "assistant", "recent".repeat(300));
  expect(f.app.hub.voiceRecap(f.sessionId)).toBe(`Orion: ${"recent".repeat(300)}`);
});

test("recap retains the end of an oversized latest turn with its speaker label", async () => {
  const f = await voiceFixture();
  f.app.hub.recordVoiceTurn(f.sessionId, "user", `${"earlier ".repeat(700)}latest detail`);
  const recap = f.app.hub.voiceRecap(f.sessionId);
  expect(recap).toStartWith("Farmer: ");
  expect(recap).toEndWith("latest detail");
  expect(recap.length).toBe(4000);
});
