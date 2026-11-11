import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModulesState } from "@orbit/protocol";
import { MODULES_FILE, ModulesStore } from "../src/services/modules";
import { connect, record, removeDir, startApp, tempDir, waitFor } from "./helpers";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setup(seed: boolean, dir = tempDir()) {
  const app = await startApp(dir, seed);
  const client = await connect(app);
  cleanups.push(() => removeDir(dir));
  cleanups.push(async () => {
    client.close();
    await app.stop();
  });
  return { app, client, dir };
}

const byId = (state: ModulesState) => Object.fromEntries(state.modules.map((m) => [m.id, m]));

describe("modules", () => {
  test("a fresh data dir starts with every module off and writes modules.json", async () => {
    const { client, dir } = await setup(false);
    const state = await client.request("modules.list", {});
    expect(state.modules.map((m) => m.id)).toEqual(["herd", "devices", "cameras"]);
    for (const m of state.modules) {
      expect(m).toEqual({ id: m.id, enabled: false, enabledAt: null, enabledBy: null });
    }
    expect(JSON.parse(readFileSync(join(dir, MODULES_FILE), "utf8"))).toEqual(state);
  });

  test("a data dir that already has data enables those modules automatically", async () => {
    const { client } = await setup(true);
    const m = byId(await client.request("modules.list", {}));
    expect(m.herd).toMatchObject({ enabled: true, enabledBy: "auto" });
    expect(m.devices).toMatchObject({ enabled: true, enabledBy: "auto" });
    expect(m.cameras).toMatchObject({ enabled: true, enabledBy: "auto" });
    expect(Date.parse(m.herd?.enabledAt ?? "")).not.toBeNaN();
  });

  test("enable and disable requests persist and emit modules.updated", async () => {
    const dir = tempDir();
    const firstApp = await startApp(dir, false);
    const first = { app: firstApp, client: await connect(firstApp) };
    const enabled = waitFor(
      first.client,
      "modules.updated",
      (e) => byId(e).devices?.enabled === true,
    );
    const result = await first.client.request("modules.enable", { moduleId: "devices" });
    expect(byId(result).devices).toMatchObject({ enabled: true, enabledBy: "user" });
    expect(await enabled).toMatchObject(result);

    const disabled = waitFor(first.client, "modules.updated", (e) => !byId(e).devices?.enabled);
    await first.client.request("modules.enable", { moduleId: "cameras" });
    const afterDisable = await first.client.request("modules.disable", { moduleId: "devices" });
    expect(byId(await disabled).devices).toMatchObject({ enabled: false, enabledBy: null });
    expect(byId(afterDisable).cameras).toMatchObject({ enabled: true, enabledBy: "user" });

    first.client.close();
    await first.app.stop();
    const second = await setup(false, dir);
    expect(await second.client.request("modules.list", {})).toEqual(afterDisable);
  });

  test("the first animal added through db.mutate enables the herd module", async () => {
    const { client } = await setup(false);
    const events = record(client);
    const updated = waitFor(client, "modules.updated", (e) => byId(e).herd?.enabled === true);
    await client.mutate("animals.upsert", { animal: { species: "horse", name: "Storm" } });
    expect(byId(await updated).herd).toMatchObject({ enabled: true, enabledBy: "auto" });
    const m = byId(await client.request("modules.list", {}));
    expect(m.herd?.enabled).toBe(true);
    expect(m.devices?.enabled).toBe(false);
    // A second animal while herd is on changes nothing.
    await client.mutate("animals.upsert", { animal: { species: "cattle", name: "Bella" } });
    await client.request("modules.list", {});
    expect(events.filter((e) => e.type === "modules.updated")).toHaveLength(1);
  });

  test("orbit_modules enables herd from chat (mock trigger) with enabledBy orion", async () => {
    const { client } = await setup(false);
    const events = record(client);
    const { session } = await client.request("sessions.create", {});
    const settled = waitFor(client, "agent.settled", (e) => e.sessionId === session.id);
    const updated = waitFor(client, "modules.updated", (e) => byId(e).herd?.enabled === true);
    await client.request("chat.prompt", { sessionId: session.id, text: "Help me track my herd" });
    expect(byId(await updated).herd).toMatchObject({ enabled: true, enabledBy: "orion" });
    expect((await settled).reason).toBe("completed");
    const start = events.find((e) => e.type === "tool.start");
    const end = events.find((e) => e.type === "tool.end");
    expect(start).toMatchObject({ name: "orbit_modules", args: { action: "enable", id: "herd" } });
    expect(end).toMatchObject({ isError: false });
    expect(end?.result).toContain("Enabled the herd module.");
    expect(end?.result).toContain("- devices: off");
  });
});

describe("ModulesStore", () => {
  test("list, idempotent enable, never auto-disables, rebuilds a broken file", () => {
    const dir = tempDir();
    cleanups.push(() => removeDir(dir));
    const live = new Set<string>();
    const seen: ModulesState[] = [];
    const store = new ModulesStore(
      dir,
      (t) => live.has(t),
      (s) => seen.push(s),
    );
    expect(existsSync(join(dir, MODULES_FILE))).toBe(true);

    store.noticeChange("cameras");
    expect(store.enabled("cameras")).toBe(false);
    live.add("cameras");
    store.noticeChange("observations");
    store.noticeChange("cameras");
    expect(store.list().modules[2]).toMatchObject({ id: "cameras", enabledBy: "auto" });

    store.enable("cameras", "orion");
    expect(store.list().modules[2]?.enabledBy).toBe("auto");
    live.delete("cameras");
    store.noticeChange("cameras");
    expect(store.enabled("cameras")).toBe(true);
    expect(seen).toHaveLength(1);

    writeFileSync(join(dir, MODULES_FILE), "{ not json");
    const rebuilt = new ModulesStore(dir, () => true);
    expect(rebuilt.list().modules.every((m) => m.enabled && m.enabledBy === "auto")).toBe(true);
  });
});
