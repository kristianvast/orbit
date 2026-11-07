import { afterEach, beforeEach, expect, test } from "bun:test";
import { canWriteTable } from "@orbit/schema/roles";
import { openDatabase } from "../src/db/open";
import { EncryptedFileStore } from "../src/secrets";
import { AccountError } from "../src/services/account";
import { FarmService } from "../src/services/farm";
import { MockVoiceTransport } from "../src/voice/mock";
import { VoiceSessions } from "../src/voice/session";
import { removeDir, tempDir } from "./helpers";

let dir: string;
let db: ReturnType<typeof openDatabase>;
let farm: FarmService;
let sessions: VoiceSessions;
const owner = {};
let mock: MockVoiceTransport;
let events: Array<{ type: string } & Record<string, unknown>>;
let done: ReturnType<typeof Promise.withResolvers<void>>;
let ready: ReturnType<typeof Promise.withResolvers<void>>;

beforeEach(() => {
  dir = tempDir();
  db = openDatabase(dir, { seed: true });
  farm = new FarmService(db.repo, new EncryptedFileStore(dir), dir);
  mock = new MockVoiceTransport();
  events = [];
  done = Promise.withResolvers<void>();
  ready = Promise.withResolvers<void>();
  sessions = new VoiceSessions({
    farm,
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
    credentials: { read: async () => undefined },
    mockModel: true,
    transport: () => mock,
    emit: (type, body) => {
      events.push({ type, ...body });
      if (type === "voice.tool" && "state" in body && body.state === "done") done.resolve();
      if (type === "voice.state" && "state" in body && body.state === "listening") ready.resolve();
      if (type === "voice.state" && "error" in body && typeof body.error === "string")
        done.reject(new Error(body.error));
    },
  });
});
afterEach(() => {
  sessions.dispose();
  db.close();
  removeDir(dir);
});

test("a spoken herd question runs the farm query and sends Gemini a toolResponse", async () => {
  await farm.mutate({
    mutation: "animals.upsert",
    params: { animal: { species: "cattle", name: "Voice cow" } },
  });
  const { voiceId } = await sessions.start("conversation", owner);
  await ready.promise;
  sessions.text(voiceId, owner, "Who is in my herd?");
  await done.promise;
  expect(mock.sent).toContainEqual({
    toolResponse: {
      functionResponses: [
        expect.objectContaining({
          name: "db_query",
          response: {
            result: {
              total: expect.any(Number),
              rows: expect.arrayContaining([expect.objectContaining({ name: "Voice cow" })]),
            },
          },
        }),
      ],
    },
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "voice.tool",
      name: "db_query",
      state: "done",
      isError: false,
    }),
  );
});

test("worker voice writes cannot change cameras", async () => {
  farm.guard = (mutation) => {
    if (mutation === "cameras.upsert" && !canWriteTable("worker", "cameras")) {
      throw new AccountError("forbidden", "Workers cannot change cameras.");
    }
  };
  await sessions.start("conversation", owner);
  await ready.promise;
  mock.deliver({
    toolCall: {
      functionCalls: [
        {
          id: "camera-write",
          name: "db_mutate",
          args: {
            mutation: "cameras.upsert",
            params: { camera: { name: "Forbidden camera", status: "offline" } },
          },
        },
      ],
    },
  });
  await done.promise;
  expect(mock.sent).toContainEqual({
    toolResponse: {
      functionResponses: [
        {
          id: "camera-write",
          name: "db_mutate",
          response: { error: { code: "forbidden", message: "Workers cannot change cameras." } },
        },
      ],
    },
  });
  expect(
    db.repo
      .query("cameras.list", undefined)
      .rows.find((camera) => camera.name === "Forbidden camera"),
  ).toBeUndefined();
});

test("voice observation writes create an undo snapshot through the shared mutation layer", async () => {
  await sessions.start("conversation", owner);
  await ready.promise;
  mock.deliver({
    toolCall: {
      functionCalls: [
        {
          id: "observation",
          name: "db_mutate",
          args: {
            mutation: "observations.add",
            // Newer than any seeded observation, so observations.recent (newest 100) lists it.
            params: { kind: "weight", ts: "2999-01-01T00:00:00Z", valueNum: 515 },
          },
        },
      ],
    },
  });
  await done.promise;
  const snapshot = db.repo
    .listSnapshots("conversation")
    .find((s) => s.toolCallId === "observation");
  expect(snapshot?.id).toBeString();
  if (!snapshot) throw new Error("voice write did not create a snapshot");
  const rowId = db.repo.getSnapshot(snapshot.id).changes[0]?.rowId;
  expect(
    db.repo.query("observations.recent", {}).rows.find((row) => row.id === rowId)?.valueNum,
  ).toBe(515);
  db.repo.undoDbSnapshot(snapshot.id);
  expect(
    db.repo.query("observations.recent", {}).rows.find((row) => row.id === rowId),
  ).toBeUndefined();
});

test("a different connection cannot inject audio into an existing voice session", async () => {
  const { voiceId } = await sessions.start("conversation", owner);
  await ready.promise;
  expect(() => sessions.audio(voiceId, {}, "AAAA")).toThrow("Voice session is closed.");
});

test("voice binding tools refuse a second wearable on the same animal", async () => {
  const animal = await farm.mutate({
    mutation: "animals.upsert",
    params: { animal: { species: "cattle", name: "One wearable" } },
  });
  const collar = await farm.mutate({
    mutation: "devices.upsert",
    params: { device: { kind: "collar" } },
  });
  const bolus = await farm.mutate({
    mutation: "devices.upsert",
    params: { device: { kind: "bolus" } },
  });
  const animalId = animal.ids[0];
  const collarId = collar.ids[0];
  const bolusId = bolus.ids[0];
  if (!animalId || !collarId || !bolusId) throw new Error("fixture records were not created");
  await farm.mutate({
    mutation: "bindings.set",
    params: { animalId, deviceId: collarId },
  });
  await sessions.start("conversation", owner);
  await ready.promise;
  mock.deliver({
    toolCall: {
      functionCalls: [
        {
          id: "second-wearable",
          name: "db_mutate",
          args: { mutation: "bindings.set", params: { animalId, deviceId: bolusId } },
        },
      ],
    },
  });
  await done.promise;
  expect(mock.sent).toContainEqual({
    toolResponse: {
      functionResponses: [
        {
          id: "second-wearable",
          name: "db_mutate",
          response: { error: { code: "rule_violation", message: expect.any(String) } },
        },
      ],
    },
  });
  expect(db.repo.query("bindings.list", { animalId }).rows.map((row) => row.deviceId)).toEqual([
    collarId,
  ]);
});
