import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startOrion } from "../src/app";
import { collectBuild } from "../src/services/feedback";
import { connect, removeDir, TOKEN, tempDir } from "./helpers";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function workspaceWith(files: Record<string, string | Uint8Array>): string {
  const dir = tempDir();
  cleanups.push(() => removeDir(dir));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

describe("collectBuild", () => {
  test("takes the text files of one page and leaves out generated, hidden and binary files", () => {
    const dir = workspaceWith({
      "pages/morning/index.html": "<h1>Morning round</h1>",
      "pages/morning/js/app.js": "render();",
      "pages/morning/node_modules/dep/index.js": "module.exports = 1;",
      "pages/morning/.env": "FARM=north",
      "pages/morning/photo.png": new Uint8Array([137, 80, 78, 71, 0, 1]),
      "pages/other/index.html": "<p>not this one</p>",
    });
    const build = collectBuild(dir, "page", "morning");
    expect(build.files.map((f) => f.path).sort()).toEqual(["index.html", "js/app.js"]);
    expect(build.skipped.map((s) => s.split(" ")[0]).sort()).toEqual([
      ".env",
      "node_modules",
      "photo.png",
    ]);
  });

  test("refuses a build that still holds a password and names the line", () => {
    const dir = workspaceWith({
      "connectors/robot/index.ts": 'const host = "10.0.0.5";\nconst password = "hunter2hunter2";\n',
    });
    expect(() => collectBuild(dir, "connector", "robot")).toThrow("index.ts:2");
  });

  test("refuses a name that would leave the workspace folder", () => {
    const dir = workspaceWith({ "pages/a/index.html": "x" });
    expect(() => collectBuild(dir, "page", "../a")).toThrow("not a valid name");
  });
});

describe("feedback over the protocol", () => {
  test("a signed-out farm's feedback reaches the cloud without credentials, with version and system", async () => {
    const received: Array<{ path: string; auth: string | null; body: Record<string, unknown> }> =
      [];
    const core = Bun.serve({
      port: 0,
      async fetch(request) {
        received.push({
          path: new URL(request.url).pathname,
          auth: request.headers.get("authorization"),
          body: (await request.json()) as Record<string, unknown>,
        });
        return Response.json({ id: "0b6f2f0e-0000-4000-8000-000000000001" }, { status: 201 });
      },
    });
    const dataDir = tempDir();
    const app = await startOrion({
      port: 0,
      token: TOKEN,
      dataDir,
      mockModel: true,
      seed: false,
      gatewayUrl: null,
      appSource: null,
      coreUrl: `http://127.0.0.1:${core.port}`,
    });
    const client = await connect(app);
    cleanups.push(() => removeDir(dataDir));
    cleanups.push(async () => {
      client.close();
      await app.stop();
      await core.stop(true);
    });

    const result = await client.request("feedback.send", {
      kind: "idea",
      message: "  A hoof-trimming calendar would help.  ",
      contactEmail: "farmer@example.test",
      locale: "en",
    });

    expect(result.id).toBe("0b6f2f0e-0000-4000-8000-000000000001");
    expect(received).toHaveLength(1);
    expect(received[0]?.path).toBe("/v1/feedback");
    expect(received[0]?.auth).toBeNull();
    expect(received[0]?.body).toMatchObject({
      kind: "idea",
      message: "A hoof-trimming calendar would help.",
      contactEmail: "farmer@example.test",
      locale: "en",
      appVersion: "0.1.0",
    });
    expect(String(received[0]?.body.os)).toContain(process.platform);
  });
});
