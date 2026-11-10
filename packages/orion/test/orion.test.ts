import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
  CloseCode,
  encodeRequest,
  PROTOCOL_VERSION,
  type ToolItem,
  type UserItem,
} from "@orbit/protocol";
import { OrionRequestError } from "@orbit/protocol/client";
import { memoryFile, rememberFact } from "../src/agent/memory";
import { createFarmTools } from "../src/agent/tools";
import { type OrionApp, startOrion } from "../src/app";
import { openDatabase } from "../src/db/open";
import { EncryptedFileStore } from "../src/secrets";
import { FarmService } from "../src/services/farm";
import { LocalUiService } from "../src/services/local-ui";
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

describe("no AI model set up", () => {
  test("a prompt is refused with not_ready, nothing stays running, and abort reports nothing to stop", async () => {
    const dir = tempDir();
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const app = await startOrion({
      port: 0,
      token: TOKEN,
      dataDir: dir,
      mockModel: false,
      seed: false,
      gatewayUrl: null,
      appSource: null,
    });
    const client = await connect(app);
    cleanups.push(() => {
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
      removeDir(dir);
    });
    cleanups.push(async () => {
      client.close();
      await app.stop();
    });
    const { session } = await client.request("sessions.create", {});
    const refused = (text: string) =>
      client.request("chat.prompt", { sessionId: session.id, text }).then(
        () => null,
        (error: unknown) => error as OrionRequestError,
      );

    const noProvider = await refused("hello");
    expect(noProvider?.code).toBe("not_ready");
    expect(noProvider?.message).toContain("No AI model is set up");

    await client.request("settings.update", { provider: "anthropic", model: "claude-sonnet-4-5" });
    const noKey = await refused("hello again");
    expect(noKey?.code).toBe("not_ready");
    expect(noKey?.message).toContain("anthropic has no key or sign-in");

    const { sessions } = await client.request("sessions.list", {});
    expect(sessions.find((s) => s.id === session.id)?.streaming).toBe(false);
    expect((await client.request("chat.abort", { sessionId: session.id })).accepted).toBe(false);
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

describe("tools run without approval prompts", () => {
  test("camera_discover runs straight away", async () => {
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
    const { client } = await setup();
    const { session } = await client.request("sessions.create", {});
    const toolEnd = waitFor(client, "tool.end", (e) => e.sessionId === session.id);
    const settled = waitFor(client, "agent.settled", (e) => e.sessionId === session.id);
    await client.request("chat.prompt", { sessionId: session.id, text: "find cameras" });
    const end = await toolEnd;
    expect(end.isError).toBe(false);
    expect(end.result).toContain("Acme Barn 4K");
    expect((await settled).reason).toBe("completed");
    const opened = await client.request("sessions.open", { sessionId: session.id });
    expect(opened.items.find((i): i is ToolItem => i.kind === "tool")?.status).toBe("done");
  });
});

describe("one-wearable rule", () => {
  test("device_bind refuses a second wearable and explains why", async () => {
    const dir = tempDir();
    cleanups.push(() => removeDir(dir));
    const db = openDatabase(dir, { seed: true });
    cleanups.push(() => db.close());
    const farm = new FarmService(db.repo, new EncryptedFileStore(dir), join(dir, "workspace"));
    const localUi = new LocalUiService(dir, join(dir, "app"), TOKEN, () => {});
    const bind = createFarmTools(farm, localUi).find((t) => t.name === "device_bind");
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

describe("memory", () => {
  const ctx = {
    sessionManager: { getSessionId: () => "test-session" },
  } as unknown as ExtensionToolContext;

  test("remember and forget edit the farm and user memory files", async () => {
    const dir = tempDir();
    cleanups.push(() => removeDir(dir));
    const db = openDatabase(dir, { seed: true });
    cleanups.push(() => db.close());
    const workspace = join(dir, "workspace");
    const tools = createFarmTools(
      new FarmService(db.repo, new EncryptedFileStore(dir), workspace),
      new LocalUiService(dir, join(dir, "app"), TOKEN, () => {}),
    );
    const remember = tools.find((t) => t.name === "memory_remember");
    const forget = tools.find((t) => t.name === "memory_forget");
    const run = (t: typeof remember, args: Record<string, unknown>) =>
      t?.execute("call", args, undefined, undefined, ctx);

    await run(remember, { scope: "farm", fact: "Milking starts at 05:30." });
    const again = await run(remember, { scope: "farm", fact: "milking starts at 05:30." });
    await run(remember, { scope: "user", fact: "Prefers metric units." });
    expect(again?.details).toMatchObject({ added: false });
    const farmText = readFileSync(memoryFile(workspace, "farm"), "utf8");
    expect(farmText.match(/Milking starts at 05:30\./gi)).toHaveLength(1);
    expect(readFileSync(memoryFile(workspace, "user"), "utf8")).toContain("Prefers metric units.");

    const forgot = await run(forget, { scope: "farm", match: "05:30" });
    expect(forgot?.details).toMatchObject({ removed: ["Milking starts at 05:30."] });
    expect(readFileSync(memoryFile(workspace, "farm"), "utf8")).not.toContain("05:30");
    const missing = await run(forget, { scope: "farm", match: "05:30" });
    expect(missing?.isError).toBe(true);
  });

  test("a new session's system prompt contains both memories", async () => {
    const { app, client, dir } = await setup();
    rememberFact(join(dir, "workspace"), "farm", "The calving pen is in barn 2.");
    rememberFact(join(dir, "workspace"), "user", "Call the farmer Ingrid.");
    const { session } = await client.request("sessions.create", {});
    const settled = waitFor(client, "agent.settled", (e) => e.sessionId === session.id);
    await client.request("chat.prompt", { sessionId: session.id, text: "hello" });
    await settled;
    const live = (
      app.hub as unknown as { live: Map<string, { agent: { systemPrompt: string } | null }> }
    ).live;
    const prompt = live.get(session.id)?.agent?.systemPrompt ?? "";
    expect(prompt).toContain("The calving pen is in barn 2.");
    expect(prompt).toContain("Call the farmer Ingrid.");
  });
});

describe("snapshots", () => {
  test("a file write is snapshotted and undo reverts it", async () => {
    const { client, dir } = await setup();
    const { session } = await client.request("sessions.create", {});
    const settled = waitFor(client, "agent.settled", (e) => e.sessionId === session.id);
    await client.request("chat.prompt", { sessionId: session.id, text: "write a note" });
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

describe("custom pages", () => {
  test("a page Orion writes is listed and served only with the session token", async () => {
    const { app, client } = await setup();
    const { session } = await client.request("sessions.create", {});
    const settled = waitFor(client, "agent.settled", (e) => e.sessionId === session.id);
    await client.request("chat.prompt", { sessionId: session.id, text: "make a page" });
    await settled;

    const { pages } = await client.request("pages.list", {});
    expect(pages).toEqual([
      {
        id: "herd-count",
        title: "Herd count",
        path: `/pages/${TOKEN}/herd-count/index.html`,
      },
    ]);
    const origin = `http://127.0.0.1:${app.port}`;
    const page = await fetch(origin + pages[0]?.path);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<h1>Herd count</h1>");
    const sdk = await fetch(`${origin}/pages/${TOKEN}/_orbit.js`);
    expect(sdk.headers.get("content-type")).toContain("javascript");
    expect(await sdk.text()).toContain("window.orbit");

    expect((await fetch(`${origin}/pages/wrong-token/herd-count/index.html`)).status).toBe(401);
    const traversal = await fetch(`${origin}/pages/${TOKEN}/herd-count/..%2F..%2FAGENTS.md`);
    expect(traversal.status).toBe(404);
  });

  test("a page lists its card only when the card file is inside its own folder", async () => {
    const { client, dir } = await setup();
    const page = (id: string, files: Record<string, string>) => {
      const folder = join(dir, "workspace", "pages", id);
      mkdirSync(folder, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(folder, name), content);
      }
    };
    page("board", {
      "index.html": "<h1>Board</h1>",
      "card.html": "<p>12 cows</p>",
      "page.json": JSON.stringify({ title: "Board", card: "card.html" }),
    });
    page("borrowed", {
      "index.html": "<h1>Borrowed</h1>",
      "page.json": JSON.stringify({ title: "Borrowed", card: "../board/card.html" }),
    });
    page("cardless", {
      "index.html": "<h1>Cardless</h1>",
      "page.json": JSON.stringify({ title: "Cardless", card: "missing.html" }),
    });

    const { pages } = await client.request("pages.list", {});
    expect(pages).toEqual([
      {
        id: "board",
        title: "Board",
        path: `/pages/${TOKEN}/board/index.html`,
        card: { path: `/pages/${TOKEN}/board/card.html` },
      },
      { id: "borrowed", title: "Borrowed", path: `/pages/${TOKEN}/borrowed/index.html` },
      { id: "cardless", title: "Cardless", path: `/pages/${TOKEN}/cardless/index.html` },
    ]);
  });

  test("sandboxed pages can load their own files, the Orbit stylesheet and its fonts", async () => {
    const { app, dir } = await setup();
    const folder = join(dir, "workspace", "pages", "board");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "index.html"), "<h1>Board</h1>");
    writeFileSync(join(folder, "config.json"), '{"filters":[]}');
    const origin = `http://127.0.0.1:${app.port}`;

    // A sandboxed iframe has an opaque origin, so these are cross-origin reads.
    const config = await fetch(`${origin}/pages/${TOKEN}/board/config.json`);
    expect(config.headers.get("access-control-allow-origin")).toBe("*");
    expect(await config.json()).toEqual({ filters: [] });

    const css = await fetch(`${origin}/pages/${TOKEN}/_orbit.css`);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.headers.get("access-control-allow-origin")).toBe("*");
    const sheet = await css.text();
    const fonts = [...sheet.matchAll(/url\("(\/fonts\/[^"]+)"\)/g)].map((m) => m[1]);
    expect(fonts.length).toBeGreaterThan(0);
    for (const path of fonts) {
      const font = await fetch(origin + path);
      expect({ path, status: font.status }).toEqual({ path, status: 200 });
      expect(font.headers.get("access-control-allow-origin")).toBe("*");
    }

    expect((await fetch(`${origin}/pages/wrong-token/_orbit.css`)).status).toBe(401);
    expect((await fetch(`${origin}/fonts/..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${origin}/fonts/constructor`)).status).toBe(404);
  });
});

describe("app source editing", () => {
  test("--app-source adds the checkout and its AGENTS.md to the system prompt", async () => {
    const dir = tempDir();
    const repoRoot = resolve(import.meta.dir, "../../..");
    const app = await startOrion({
      port: 0,
      token: TOKEN,
      dataDir: dir,
      mockModel: true,
      seed: true,
      gatewayUrl: null,
      appSource: repoRoot,
    });
    const client = await connect(app);
    cleanups.push(() => removeDir(dir));
    cleanups.push(async () => {
      client.close();
      await app.stop();
    });
    const { session } = await client.request("sessions.create", {});
    const settled = waitFor(client, "agent.settled", (e) => e.sessionId === session.id);
    await client.request("chat.prompt", { sessionId: session.id, text: "hello" });
    await settled;
    const live = (
      app.hub as unknown as { live: Map<string, { agent: { systemPrompt: string } | null }> }
    ).live;
    const prompt = live.get(session.id)?.agent?.systemPrompt ?? "";
    expect(prompt).toContain(`Orbit's own source code is checked out at ${repoRoot}`);
    expect(prompt).toContain("One-wearable domain rule");
  });
});

function fakeCheckout(dataDir: string, scripts: Record<string, string>) {
  const appDir = join(dataDir, "app", "apps", "orbit");
  mkdirSync(appDir, { recursive: true });
  mkdirSync(join(dataDir, "app", "node_modules"), { recursive: true });
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "fake-orbit", scripts }));
}

const BUILD_OK =
  "mkdir -p dist/assets && echo '<!doctype html><html><head><title>local</title></head><body>local build</body></html>' > dist/index.html && echo 'console.log(1)' > dist/assets/app.js";

describe("local UI build", () => {
  test("a checked build is served under the token and a launch that never boots reads as broken", async () => {
    const dir = tempDir();
    fakeCheckout(dir, { typecheck: "true", "build:local": BUILD_OK });
    const { app, client } = await setup(dir);
    const { session } = await client.request("sessions.create", {});
    const updated = waitFor(client, "localUi.updated", () => true);
    const settled = waitFor(client, "agent.settled", (e) => e.sessionId === session.id);
    await client.request("chat.prompt", { sessionId: session.id, text: "build my orbit" });
    expect(await updated).toMatchObject({ state: "ready", path: `/app/${TOKEN}/` });
    await settled;

    const origin = `http://127.0.0.1:${app.port}`;
    const deepRoute = await fetch(`${origin}/app/${TOKEN}/herd/abc`);
    expect(deepRoute.status).toBe(200);
    expect(await deepRoute.text()).toContain(`<base href="/app/${TOKEN}/">`);
    expect((await fetch(`${origin}/app/${TOKEN}/assets/app.js`)).status).toBe(200);
    expect((await fetch(`${origin}/app/wrong-token/`)).status).toBe(401);
    expect((await fetch(`${origin}/app/${TOKEN}/..%2Fpackage.json`)).status).toBe(404);

    expect((await client.request("localUi.launched", {})).state).toBe("broken");
    expect((await client.request("localUi.status", {})).state).toBe("broken");
    expect((await client.request("localUi.booted", {})).state).toBe("ready");
    expect((await client.request("localUi.disable", {})).state).toBe("none");
    expect((await fetch(`${origin}/app/${TOKEN}/`)).status).toBe(404);
  });

  test("a failing typecheck reports the step and leaves the original app in use", async () => {
    const dir = tempDir();
    fakeCheckout(dir, { typecheck: "echo 'TS2322 nope' && exit 1", "build:local": BUILD_OK });
    const { client } = await setup(dir);
    const { session } = await client.request("sessions.create", {});
    const toolEnd = waitFor(client, "tool.end", (e) => e.sessionId === session.id);
    const settled = waitFor(client, "agent.settled", (e) => e.sessionId === session.id);
    await client.request("chat.prompt", { sessionId: session.id, text: "build my orbit" });
    const end = await toolEnd;
    await settled;
    expect(end.isError).toBe(true);
    expect(end.result).toContain("typecheck step failed");
    expect(end.result).toContain("TS2322 nope");
    expect((await client.request("localUi.status", {})).state).toBe("none");
    expect(existsSync(join(dir, "app", "apps", "orbit", "dist"))).toBe(false);
  });
});
