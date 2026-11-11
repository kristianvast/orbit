import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EMBEDDED_RESOURCES, materializeResources } from "../src/resources";
import { connect, removeDir, startApp, tempDir, waitFor } from "./helpers";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const AGENTS_SOURCE = join(import.meta.dir, "..", "resources", "AGENTS.md");

describe("embedded resources", () => {
  test("materializeResources writes every embedded file and drops stale ones", () => {
    const dir = tempDir();
    cleanups.push(() => removeDir(dir));
    mkdirSync(join(dir, "resources", "skills", "old"), { recursive: true });
    writeFileSync(join(dir, "resources", "skills", "old", "SKILL.md"), "stale");

    const out = materializeResources(dir);

    expect(out.dir).toBe(join(dir, "resources"));
    expect(out.connectorTemplateDir).toBe(join(dir, "resources", "connector-template"));
    expect(Object.keys(EMBEDDED_RESOURCES)).toContain("skills/herd-data/SKILL.md");
    expect(Object.keys(EMBEDDED_RESOURCES)).toContain("skills/ui-design/SKILL.md");
    expect(Object.keys(EMBEDDED_RESOURCES)).toContain("connector-template/index.ts");
    for (const [rel, content] of Object.entries(EMBEDDED_RESOURCES)) {
      expect(readFileSync(join(out.dir, rel), "utf8")).toBe(content);
    }
    expect(readFileSync(join(out.dir, "AGENTS.md"), "utf8")).toBe(
      readFileSync(AGENTS_SOURCE, "utf8"),
    );
    expect(existsSync(join(out.dir, "skills", "old"))).toBe(false);
  });

  test("a session's system prompt contains the materialised AGENTS.md", async () => {
    const dir = tempDir();
    const app = await startApp(dir);
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
      app.hub as unknown as {
        live: Map<string, { agent: { systemPrompt: string } | null }>;
      }
    ).live;
    const prompt = live.get(session.id)?.agent?.systemPrompt ?? "";
    const agentsText = readFileSync(join(dir, "resources", "AGENTS.md"), "utf8").trim();
    expect(agentsText.length).toBeGreaterThan(0);
    expect(agentsText).toBe(EMBEDDED_RESOURCES["AGENTS.md"]?.trim() as string);
    expect(prompt).toContain(agentsText);
    expect(prompt).toContain("herd-data");
    expect(prompt).toContain("ui-design");
  });
});
