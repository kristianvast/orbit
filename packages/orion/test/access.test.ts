import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createOrionClient, type OrionClient } from "@orbit/protocol/client";
import { AccessDenied, AccessGate } from "../src/agent/access";
import type { OrionApp } from "../src/app";
import { SettingsStore } from "../src/settings";
import { connect, record, removeDir, startApp, TOKEN, tempDir, waitFor } from "./helpers";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(): Promise<{
  dir: string;
  app: OrionApp;
  client: OrionClient;
  sessionId: string;
}> {
  const dir = tempDir();
  cleanup.push(() => removeDir(dir));
  const app = await startApp(dir, false);
  cleanup.push(() => app.stop());
  const client = await connect(app);
  cleanup.push(() => client.close());
  const { session } = await client.request("sessions.create", {});
  return { dir, app, client, sessionId: session.id };
}

async function checkGit(client: OrionClient, sessionId: string) {
  const ended = waitFor(client, "tool.end", (e) => e.sessionId === sessionId);
  const settled = waitFor(client, "agent.settled", (e) => e.sessionId === sessionId);
  await client.request("chat.prompt", { sessionId, text: "check git" });
  return { ended, settled };
}

test("the shell waits for one yes, a no refuses it, and a yes is remembered", async () => {
  const { dir, client, sessionId } = await fixture();

  const asked = waitFor(client, "access.request");
  const first = await checkGit(client, sessionId);
  const request = await asked;
  expect(request).toMatchObject({ sessionId, tool: "shell" });
  const closed = waitFor(client, "access.resolved");
  await client.request("access.respond", { requestId: request.requestId, allow: false });
  expect(await closed).toMatchObject({ requestId: request.requestId, allow: false });
  const refused = await first.ended;
  expect(refused.isError).toBe(true);
  expect(refused.result).toContain("has not given Orion access");
  await first.settled;
  expect((await client.request("settings.get")).toolAccess.shell).toBe(false);

  const askedAgain = waitFor(client, "access.request");
  const second = await checkGit(client, sessionId);
  const again = await askedAgain;
  await client.request("access.respond", { requestId: again.requestId, allow: true });
  const ran = await second.ended;
  expect(ran.isError).toBe(false);
  expect(ran.result).toContain("git version");
  await second.settled;
  expect((await client.request("settings.get")).toolAccess).toEqual({
    shell: true,
    browser: false,
    computer: false,
  });
  expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).toolAccess.shell).toBe(true);

  const events = record(client);
  const third = await checkGit(client, sessionId);
  expect((await third.ended).isError).toBe(false);
  await third.settled;
  expect(events.filter((e) => e.type === "access.request")).toEqual([]);
});

test("an open question reaches a client that connects later and is dropped when the run stops", async () => {
  const { app, client, sessionId } = await fixture();
  const asked = waitFor(client, "access.request");
  const run = await checkGit(client, sessionId);
  const request = await asked;

  const late = createOrionClient(`ws://127.0.0.1:${app.port}/ws`, TOKEN, { reconnect: false });
  cleanup.push(() => late.close());
  const resent = waitFor(late, "access.request");
  await late.ready();
  expect(await resent).toEqual(request);

  const dropped = waitFor(client, "access.resolved");
  await client.request("chat.abort", { sessionId });
  expect(await dropped).toMatchObject({ requestId: request.requestId, allow: false });
  expect((await run.ended).isError).toBe(true);
  await run.settled;
  expect(
    (await client.request("access.respond", { requestId: request.requestId, allow: true }))
      .accepted,
  ).toBe(false);
  expect((await client.request("settings.get")).toolAccess.shell).toBe(false);
});

test("each tool gets its own question, and a yes or a no for one leaves the others asking", async () => {
  const dir = tempDir();
  cleanup.push(() => removeDir(dir));
  const settings = new SettingsStore(dir);
  const asked: Array<{ type: string; tool?: string; requestId?: string }> = [];
  const gate = new AccessGate(settings, (type, body) => asked.push({ type, ...body }));
  const request = (tool: string) => {
    const found = asked.find((e) => e.type === "access.request" && e.tool === tool);
    if (!found?.requestId) throw new Error(`no question for ${tool}`);
    return found.requestId;
  };

  const shell = gate.ensure("shell", "s1");
  const browser = gate.ensure("browser", "s1");
  expect(gate.pending().map((p) => p.tool)).toEqual(["shell", "browser"]);
  gate.respond(request("shell"), true);
  await shell;
  gate.respond(request("browser"), false);
  await expect(browser).rejects.toBeInstanceOf(AccessDenied);
  expect(settings.get().toolAccess).toEqual({ shell: true, browser: false, computer: false });

  await gate.ensure("shell", "s1");
  await expect(gate.ensure("browser", "s1")).rejects.toThrow("use the web browser");
  const computer = gate.ensure("computer", "s1");
  expect(gate.pending().map((p) => p.tool)).toEqual(["computer"]);
  gate.allowed("computer");
  await computer;
  expect(settings.get().toolAccess).toEqual({ shell: true, browser: false, computer: true });
});

test("an allowed question is remembered as accepted, and turning a switch off keeps it accepted", async () => {
  const { client, sessionId } = await fixture();
  const asked = waitFor(client, "access.request");
  const run = await checkGit(client, sessionId);
  await client.request("access.respond", { requestId: (await asked).requestId, allow: true });
  await run.settled;
  expect((await client.request("settings.get")).toolAccessAccepted).toEqual({
    shell: true,
    browser: false,
    computer: false,
  });

  const off = await client.request("settings.update", { toolAccess: { shell: false } });
  expect(off.toolAccess.shell).toBe(false);
  expect(off.toolAccessAccepted.shell).toBe(true);
  const on = await client.request("settings.update", { toolAccess: { browser: true } });
  expect(on.toolAccess).toEqual({ shell: false, browser: true, computer: false });
  expect(on.toolAccessAccepted).toEqual({ shell: true, browser: true, computer: false });
});
