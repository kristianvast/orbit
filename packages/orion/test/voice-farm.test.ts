import { expect, spyOn, test } from "bun:test";
import { canWriteTable } from "@orbit/schema/roles";
import { AccessGate } from "../src/agent/access";
import { BrowserSession } from "../src/agent/browser";
import type { Emit } from "../src/agent/hub";
import { openDatabase } from "../src/db/open";
import { EncryptedFileStore } from "../src/secrets";
import { AccountError } from "../src/services/account";
import { FarmService } from "../src/services/farm";
import { SettingsStore } from "../src/settings";
import { VoiceSessions } from "../src/voice/session";
import type { VoiceTransport } from "../src/voice/transport";
import { bounded, voiceFixture } from "./voice-helpers";

async function farmFixture(transport?: VoiceTransport) {
  const f = await voiceFixture();
  const db = openDatabase(f.dir, { seed: false });
  const farm = new FarmService(db.repo, new EncryptedFileStore(f.dir), f.dir);
  const ended = Promise.withResolvers<void>();
  const noted = Promise.withResolvers<void>();
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  const emit: Emit = (type, body) => {
    events.push({ type, ...body });
    if (type === "tool.end") ended.resolve();
    if (type === "voice.note") noted.resolve();
  };
  const browser = new BrowserSession(`${f.dir}/browser-test`);
  const sessions = new VoiceSessions({
    farm,
    hub: f.app.hub,
    browser,
    access: new AccessGate(new SettingsStore(f.dir), emit),
    emit,
    token: "test",
    mockModel: true,
    toolBudgetMs: 1,
    ...(transport ? { transport: () => transport } : {}),
    account: {
      status: () => ({ state: "signed_out", coreUrl: null, user: null, farm: null }),
      cloudConnection: () => {
        throw new AccountError("unauthorized", "Sign in first.");
      },
    },
    billing: {
      status: async () => {
        throw new AccountError("unauthorized", "Sign in first.");
      },
    },
  });
  const owner = {};
  const { voiceId } = await sessions.start(f.sessionId, owner);
  return {
    ...f,
    db,
    farm,
    sessions,
    voiceId,
    owner,
    events,
    ended,
    noted,
    close: () => {
      sessions.dispose();
      browser.close();
      db.close();
    },
  };
}

test("worker voice writes cannot change cameras", async () => {
  const f = await farmFixture();
  try {
    f.farm.guard = (mutation) => {
      if (mutation === "cameras.upsert" && !canWriteTable("worker", "cameras"))
        throw new AccountError("forbidden", "Workers cannot change cameras.");
    };
    const answer = await f.sessions.tool(f.voiceId, f.owner, {
      toolCallId: "camera-write",
      name: "db_mutate",
      args: {
        mutation: "cameras.upsert",
        params: { camera: { name: "Forbidden camera", status: "offline" } },
      },
    });
    expect(answer).toEqual({ result: "Not done: Workers cannot change cameras.", isError: true });
    expect(
      f.db.repo
        .query("cameras.list", undefined)
        .rows.find((row) => row.name === "Forbidden camera"),
    ).toBeUndefined();
  } finally {
    f.close();
  }
});

test("client frames received before the upstream opens are flushed in their original order", async () => {
  const connected = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const sent: string[] = [];
  const transport: VoiceTransport = {
    connect() {
      connected.resolve();
      return ready.promise;
    },
    send(frame) {
      sent.push(frame);
    },
    close() {},
  };
  const f = await farmFixture(transport);
  try {
    const opening = f.sessions.open(f.voiceId, {
      send() {
        return 1;
      },
      close() {},
    });
    await bounded(connected.promise);
    f.sessions.message(f.voiceId, ' {"first":1} ');
    f.sessions.message(f.voiceId, ' {"second":2} ');
    expect(sent).toEqual([]);
    ready.resolve();
    await bounded(opening);
    expect(sent).toEqual([' {"first":1} ', ' {"second":2} ']);
  } finally {
    ready.resolve();
    f.close();
  }
});

test("voice observation writes keep the shared mutation undo snapshot", async () => {
  const f = await farmFixture();
  try {
    const answer = await f.sessions.tool(f.voiceId, f.owner, {
      toolCallId: "observation",
      name: "db_mutate",
      args: {
        mutation: "observations.add",
        params: { kind: "weight", ts: "2999-01-01T00:00:00Z", valueNum: 515 },
      },
    });
    // This fixture uses the tiny deadline; wait on completion before inspecting the write.
    await bounded(f.ended.promise);
    const snapshot = f.db.repo
      .listSnapshots(f.sessionId)
      .find((row) => row.toolCallId === "observation");
    if (!snapshot) throw new Error("Voice write did not create a snapshot");
    const rowId = f.db.repo.getSnapshot(snapshot.id).changes[0]?.rowId;
    expect(
      f.db.repo.query("observations.recent", {}).rows.find((row) => row.id === rowId)?.valueNum,
    ).toBe(515);
    f.db.repo.undoDbSnapshot(snapshot.id);
    expect(
      f.db.repo.query("observations.recent", {}).rows.find((row) => row.id === rowId),
    ).toBeUndefined();
    expect(answer.isError).toBe(false);
  } finally {
    f.close();
  }
});

test("voice binding tools refuse a second wearable on the same animal", async () => {
  const f = await farmFixture();
  try {
    const animal = await f.farm.mutate({
      mutation: "animals.upsert",
      params: { animal: { species: "cattle", name: "One wearable" } },
    });
    const collar = await f.farm.mutate({
      mutation: "devices.upsert",
      params: { device: { kind: "collar" } },
    });
    const bolus = await f.farm.mutate({
      mutation: "devices.upsert",
      params: { device: { kind: "bolus" } },
    });
    const animalId = animal.ids[0],
      collarId = collar.ids[0],
      bolusId = bolus.ids[0];
    if (!animalId || !collarId || !bolusId) throw new Error("Missing fixture records");
    await f.farm.mutate({ mutation: "bindings.set", params: { animalId, deviceId: collarId } });
    const answer = await f.sessions.tool(f.voiceId, f.owner, {
      toolCallId: "second-wearable",
      name: "db_mutate",
      args: { mutation: "bindings.set", params: { animalId, deviceId: bolusId } },
    });
    expect(answer.isError).toBe(true);
    expect(answer.result).toStartWith("Not done: ");
    expect(f.db.repo.query("bindings.list", { animalId }).rows.map((row) => row.deviceId)).toEqual([
      collarId,
    ]);
  } finally {
    f.close();
  }
});

test("a slow tool answers within its budget and later emits its real result and a voice note", async () => {
  const f = await farmFixture();
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const original = f.farm.mutate.bind(f.farm);
  const spy = spyOn(f.farm, "mutate").mockImplementation(async (mutation, context) => {
    entered.resolve();
    await release.promise;
    return original(mutation, context);
  });
  try {
    const pending = f.sessions.tool(f.voiceId, f.owner, {
      toolCallId: "slow",
      name: "db_mutate",
      args: {
        mutation: "animals.upsert",
        params: { animal: { species: "horse", name: "Slow horse" } },
      },
    });
    await bounded(entered.promise);
    expect(await bounded(pending)).toEqual({
      result: "Still working on it. I will tell you when it is ready.",
      isError: false,
    });
    expect(f.events.filter((event) => event.type === "tool.end")).toEqual([]);
    release.resolve();
    await bounded(f.ended.promise);
    await bounded(f.noted.promise);
    expect(f.events).toContainEqual(
      expect.objectContaining({ type: "tool.end", toolCallId: "slow", isError: false }),
    );
    expect(f.events).toContainEqual(
      expect.objectContaining({ type: "voice.note", text: expect.stringMatching(/^Done: /) }),
    );
    expect(
      f.db.repo.query("animals.list", {}).rows.find((row) => row.name === "Slow horse")?.species,
    ).toBe("horse");
  } finally {
    release.resolve();
    spy.mockRestore();
    f.close();
  }
});
