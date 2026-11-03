import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
  CloseCode,
  encodeRequest,
  PROTOCOL_VERSION,
  type ToolItem,
  type UserItem,
} from "@orbit/protocol";
import { OrionRequestError } from "@orbit/protocol/client";
import { createFarmTools } from "../src/agent/tools";
import type { OrionApp } from "../src/app";
import { openDatabase } from "../src/db/open";
import { EncryptedFileStore } from "../src/secrets";
import { FarmService } from "../src/services/farm";
import { connect, record, removeDir, startApp, TOKEN, tempDir, waitFor } from "./helpers";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setup(dir = tempDir()) {
  const app = await startApp(dir);
  const client = await connect(app);
  cleanups.push(() => removeDir(dir));
  cleanups.push(async () => {
    client.close();
    await app.stop();
  });
  return { app, client, dir };
}

describe("protocol handshake", () => {
  test("hello with the right token returns server info", async () => {
    const { client } = await setup();
    expect(client.server?.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(client.server?.farmId).toBeString();
  });

  test("a wrong token gets unauthorized and close code 4401", async () => {
    const { app } = await setup();
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`);
    const frames: string[] = [];
    ws.onmessage = (e) => frames.push(String(e.data));
    const closed = new Promise<number>((resolve) => {
      ws.onclose = (e) => resolve(e.code);
    });
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    ws.send(
      encodeRequest("1", "hello", { token: `${TOKEN}-wrong`, protocolVersion: PROTOCOL_VERSION }),
    );
    expect(await closed).toBe(CloseCode.unauthorized);
    const reply = JSON.parse(frames[0] as string);
    expect(reply).toMatchObject({
      type: "response",
      id: "1",
      ok: false,
      error: { code: "unauthorized" },
    });
  });
});

describe("sessions", () => {
  test("create, list and fork persist across a restart", async () => {
    const dir = tempDir();
    cleanups.push(() => removeDir(dir));
    let app: OrionApp = await startApp(dir);
    let client = await connect(app);
    const { session } = await client.request("sessions.create", { title: "Morning check" });
    const settled = waitFor(client, "agent.settled", (e) => e.sessionId === session.id);
    await client.request("chat.prompt", { sessionId: session.id, text: "hello orion" });
    expect((await settled).reason).toBe("completed");
    const opened = await client.request("sessions.open", { sessionId: session.id });
    const user = opened.items.find((i): i is UserItem => i.kind === "user");
    expect(user?.text).toBe("hello orion");
    const { session: fork } = await client.request("sessions.fork", {
      sessionId: session.id,
      fromItemId: user?.id,
    });
    expect(fork.parentSessionId).toBe(session.id);
    client.close();
    await app.stop();

    app = await startApp(dir);
    client = await connect(app);
    cleanups.push(async () => {
      client.close();
      await app.stop();
    });
    const { sessions } = await client.request("sessions.list", {});
    expect(sessions.map((s) => s.id).sort()).toEqual([session.id, fork.id].sort());
    expect(sessions.find((s) => s.id === session.id)?.title).toBe("Morning check");
    const reopened = await client.request("sessions.open", { sessionId: fork.id });
    expect(
      reopened.items.filter((i) => i.kind === "user").map((i) => (i as UserItem).text),
    ).toEqual(["hello orion"]);
  });
});

describe("mock model", () => {
  test("a prompt streams message.delta and ends with agent.settled", async () => {
    const { client } = await setup();
    const events = record(client);
    const { session } = await client.request("sessions.create", {});
    const settled = waitFor(client, "agent.settled", (e) => e.sessionId === session.id);
    await client.request("chat.prompt", { sessionId: session.id, text: "good morning" });
    expect((await settled).reason).toBe("completed");
    const types = events.map((e) => e.type);
    const deltas = events.filter((e) => e.type === "message.delta");
    expect(deltas.length).toBeGreaterThan(1);
    expect(types.indexOf("message.delta")).toBeLessThan(types.lastIndexOf("agent.settled"));
    const end = events.find(
      (e) => e.type === "message.end" && (e.item as { kind: string }).kind === "assistant",
    );
    const finalText = (end?.item as { text?: string } | undefined)?.text;
    expect(finalText).toBe(deltas.map((d) => d.text).join(""));
    expect(finalText).toContain("good morning");
  });

  test("'list cows' emits herd_query tool events and summarizes the result", async () => {
    const { client } = await setup();
    const events = record(client);
    const { session } = await client.request("sessions.create", {});
    const settled = waitFor(client, "agent.settled", (e) => e.sessionId === session.id);
    await client.request("chat.prompt", { sessionId: session.id, text: "please list cows" });
    await settled;
    const start = events.find((e) => e.type === "tool.start");
    const end = events.find((e) => e.type === "tool.end");
    expect(start).toMatchObject({ name: "herd_query", args: { species: "cattle" } });
    expect(end).toMatchObject({ toolCallId: start?.toolCallId, isError: false });
    expect(end?.result).toStartWith("24 animals found.");
    const opened = await client.request("sessions.open", { sessionId: session.id });
    const tool = opened.items.find((i): i is ToolItem => i.kind === "tool");
    expect(tool?.status).toBe("done");
    expect(opened.items.at(-1)).toMatchObject({ kind: "assistant" });
  });
});

describe("approval gate", () => {
  test("camera_discover waits for approval and runs once allowed", async () => {
    process.env.ORION_FAKE_CAMERAS = JSON.stringify([
      {
        urn: "urn:uuid:cam-1",
        xaddr: "http://192.168.1.20/onvif/device_service",
        host: "192.168.1.20",
        manufacturer: "Acme",
        model: "Barn 4K",
        name: "Acme",
      },
    ]);
    cleanups.push(() => {
      delete process.env.ORION_FAKE_CAMERAS;
    });
    const { client, dir } = await setup();
    const events = record(client);
    const { session } = await client.request("sessions.create", {});
    const request = waitFor(client, "approval.request", (e) => e.sessionId === session.id);
    await client.request("chat.prompt", { sessionId: session.id, text: "find cameras" });
    const approval = await request;
    expect(approval).toMatchObject({ toolName: "camera_discover", risk: "ask" });
    expect(approval.plainLanguage.length).toBeGreaterThan(10);
    expect(events.some((e) => e.type === "tool.end")).toBe(false);

    const toolEnd = waitFor(client, "tool.end", (e) => e.sessionId === session.id);
    const settled = waitFor(client, "agent.settled", (e) => e.sessionId === session.id);
    await client.request("approval.respond", {
      approvalId: approval.approvalId,
      decision: "allow_once",
    });
    const end = await toolEnd;
    expect(end.isError).toBe(false);
    expect(end.result).toContain("Acme Barn 4K");
    await settled;
    const audit = readFileSync(join(dir, "audit.log"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(audit.at(-1)).toMatchObject({
      toolName: "camera_discover",
      decision: "allow_once",
      by: "user",
    });
  });

  test("deny blocks the tool", async () => {
    const { client } = await setup();
    const { session } = await client.request("sessions.create", {});
    const request = waitFor(client, "approval.request", (e) => e.sessionId === session.id);
    await client.request("chat.prompt", { sessionId: session.id, text: "find cameras" });
    const approval = await request;
    const toolEnd = waitFor(client, "tool.end", (e) => e.sessionId === session.id);
    const resolved = waitFor(
      client,
      "approval.resolved",
      (e) => e.approvalId === approval.approvalId,
    );
    const settled = waitFor(client, "agent.settled", (e) => e.sessionId === session.id);
    await client.request("approval.respond", { approvalId: approval.approvalId, decision: "deny" });
    expect(await resolved).toMatchObject({ decision: "deny", by: "user" });
    const end = await toolEnd;
    expect(end.isError).toBe(true);
    expect(end.result).toContain("Not allowed");
    expect((await settled).reason).toBe("completed");
    const opened = await client.request("sessions.open", { sessionId: session.id });
    expect(opened.items.find((i): i is ToolItem => i.kind === "tool")?.status).toBe("denied");
  });
});

describe("one-wearable rule", () => {
  test("device_bind refuses a second wearable and explains why", async () => {
    const dir = tempDir();
    cleanups.push(() => removeDir(dir));
    const db = openDatabase(dir, { seed: true });
    cleanups.push(() => db.close());
    const farm = new FarmService(db.repo, new EncryptedFileStore(dir), join(dir, "workspace"));
    const bind = createFarmTools(farm).find((t) => t.name === "device_bind");
    const wearing = db.repo.listAnimals({ limit: 100 }).rows.find((a) => a.wearable);
    const spare = db.repo
      .listDevices()
      .rows.find((d) => ["collar", "bolus", "ear_tag_sensor"].includes(d.kind) && !d.boundAnimalId);
    expect(wearing && spare && bind).toBeTruthy();
    const ctx = {
      sessionManager: { getSessionId: () => "test-session" },
    } as unknown as ExtensionToolContext;
    const result = await bind?.execute(
      "call-1",
      { deviceId: spare?.id, animalId: wearing?.id },
      undefined,
      undefined,
      ctx,
    );
    expect(result?.isError).toBe(true);
    const text = (result?.content[0] as { text?: string } | undefined)?.text;
    expect(text).toContain("never more than one");
    expect(result?.details).toMatchObject({
      ruleViolation: { existingDeviceId: wearing?.wearable?.deviceId },
    });
    expect(db.repo.listBindings({ deviceId: spare?.id }).rows).toHaveLength(0);
  });

  test("db.mutate bindings.set returns rule_violation", async () => {
    const { client } = await setup();
    const animals = await client.query("animals.list", { limit: 100 });
    const wearing = animals.rows.find((a) => a.wearable);
    const devices = await client.query("devices.list", {});
    const spare = devices.rows.find(
      (d) => ["collar", "bolus", "ear_tag_sensor"].includes(d.kind) && !d.boundAnimalId,
    );
    const error = await client
      .mutate("bindings.set", { deviceId: spare?.id as string, animalId: wearing?.id as string })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrionRequestError);
    expect((error as OrionRequestError).code).toBe("rule_violation");
  });
});

describe("snapshots", () => {
  test("an approved file write is snapshotted and undo reverts it", async () => {
    const { client, dir } = await setup();
    const { session } = await client.request("sessions.create", {});
    const request = waitFor(client, "approval.request", (e) => e.sessionId === session.id);
    await client.request("chat.prompt", { sessionId: session.id, text: "write a note" });
    const approval = await request;
    expect(approval).toMatchObject({ toolName: "write", risk: "ask" });
    const settled = waitFor(client, "agent.settled", (e) => e.sessionId === session.id);
    await client.request("approval.respond", {
      approvalId: approval.approvalId,
      decision: "allow_once",
    });
    await settled;
    const note = join(dir, "workspace", "notes", "orion-note.md");
    expect(existsSync(note)).toBe(true);

    const { snapshots } = await client.request("snapshots.list", { sessionId: session.id });
    const snap = snapshots.find((s) => s.tables.includes("workspace"));
    expect(snap).toBeDefined();
    const undone = await client.request("snapshots.undo", { snapshotId: snap?.id as string });
    expect(undone.snapshot.undoneAt).toBeString();
    expect(undone.restored).toEqual([{ table: "workspace", ids: ["notes/orion-note.md"] }]);
    expect(existsSync(note)).toBe(false);
  });

  test("undo of a database write restores the previous row", async () => {
    const { client } = await setup();
    const animals = await client.query("animals.list", { limit: 1 });
    const animal = animals.rows[0];
    const changed = waitFor(client, "db.changed", (e) => e.table === "animals");
    const result = await client.mutate("animals.upsert", {
      animal: { id: animal?.id, species: animal?.species ?? "cattle", name: "Renamed" },
    });
    await changed;
    expect((await client.query("animals.get", { id: animal?.id as string })).animal.name).toBe(
      "Renamed",
    );
    await client.request("snapshots.undo", { snapshotId: result.snapshotId as string });
    expect((await client.query("animals.get", { id: animal?.id as string })).animal.name).toBe(
      animal?.name ?? null,
    );
  });
});
