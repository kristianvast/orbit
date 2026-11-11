import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { READY_LINE_PREFIX } from "@orbit/protocol";
import { startOrion as startApp } from "../src/app";
import { LocalOrion } from "../src/services/local-orion";
import { LocalUiService } from "../src/services/local-ui";
import { connect, removeDir, TOKEN, tempDir, waitFor } from "./helpers";

const VERSION = "9.9.9";
const MAIN = resolve(import.meta.dir, "../src/main.ts");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function temp(): string {
  const dir = tempDir();
  dirs.push(dir);
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(
    ["git", "-c", "user.name=Test", "-c", "user.email=test@orbit.local", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`);
  return out.trim();
}

/** An Orion that reports ready as `port` and stops when its stdin closes, like the real one. */
const fakeOrion = (port: number) =>
  `process.stdout.write(${JSON.stringify(READY_LINE_PREFIX)} + JSON.stringify({ port: ${port} }) + "\\n");
process.stdin.on("close", () => process.exit(0));
process.stdin.resume();
`;

/** A tagged release of a pretend Orbit: one app and one Orion, with nothing to install. */
async function release(orionSource = fakeOrion(4242)): Promise<string> {
  const repo = temp();
  const files: Record<string, string> = {
    "apps/orbit/package.json": JSON.stringify({
      name: "fake-orbit",
      scripts: {
        typecheck: "true",
        "build:local": "mkdir -p dist && echo '<html><head></head></html>' > dist/index.html",
      },
    }),
    "packages/orion/package.json": JSON.stringify({
      name: "fake-orion",
      scripts: { typecheck: "true" },
    }),
    "packages/orion/src/main.ts": orionSource,
    "node_modules/.keep": "",
    ".gitignore": "dist\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  await git(repo, "init", "--quiet", "--initial-branch", "main");
  await git(repo, "add", "-A", "--force");
  await git(repo, "commit", "--quiet", "-m", "release");
  await git(repo, "tag", `v${VERSION}`);
  return repo;
}

function service(dataDir: string, sourceUrl: string): LocalUiService {
  return new LocalUiService(dataDir, join(dataDir, "app"), TOKEN, () => {}, {
    version: VERSION,
    sourceUrl,
  });
}

describe("orbit source", () => {
  test("the first call downloads the installed version on a farm branch, the next finds it there", async () => {
    const dataDir = temp();
    const localUi = service(dataDir, await release());
    expect(await localUi.source()).toEqual({
      ok: true,
      created: true,
      path: join(dataDir, "app"),
    });
    expect(await git(join(dataDir, "app"), "branch", "--show-current")).toBe("farm");
    expect(await git(join(dataDir, "app"), "describe", "--tags")).toBe(`v${VERSION}`);
    expect(await localUi.source()).toMatchObject({ ok: true, created: false });
  });

  test("a folder that holds something else is left alone", async () => {
    const dataDir = temp();
    mkdirSync(join(dataDir, "app"));
    writeFileSync(join(dataDir, "app", "notes.txt"), "the farmer's own file");
    const result = await service(dataDir, await release()).source();
    expect(result).toMatchObject({ ok: false, step: "clone" });
    expect(readFileSync(join(dataDir, "app", "notes.txt"), "utf8")).toBe("the farmer's own file");
  });
});

describe("building Orion itself", () => {
  test("an app-only change leaves the shipped Orion in use", async () => {
    const dataDir = temp();
    const localUi = service(dataDir, await release());
    await localUi.source();
    writeFileSync(join(dataDir, "app", "apps", "orbit", "note.txt"), "a screen change");
    const built = await localUi.build(undefined, "Changed a screen");
    expect(built).toMatchObject({ ok: true, orion: "unchanged" });
    expect(localUi.orion.status().enabled).toBe(false);
    expect(await git(join(dataDir, "app"), "log", "-1", "--format=%s")).toBe("Changed a screen");
  });

  test("a changed Orion that starts is switched on, and one that cannot start is not", async () => {
    const dataDir = temp();
    const localUi = service(dataDir, await release());
    await localUi.source();
    const main = join(dataDir, "app", "packages", "orion", "src", "main.ts");

    writeFileSync(main, fakeOrion(5151));
    const built = await localUi.build(undefined, "Taught Orion something");
    expect(built).toMatchObject({ ok: true, orion: "updated" });
    const working = localUi.orion.status();
    expect(working).toMatchObject({ enabled: true, lastError: null });
    expect(working.commit).toBe(await git(join(dataDir, "app"), "rev-parse", "HEAD"));

    writeFileSync(main, "process.exit(3);\n");
    const broken = await localUi.build(undefined, "Broke Orion");
    expect(broken).toMatchObject({ ok: false, step: "orion-start" });
    // The build that worked stays the one in use.
    expect(localUi.orion.status()).toEqual(working);
  });

  test("going back to the original also stops using the farm's Orion", async () => {
    const dataDir = temp();
    const localUi = service(dataDir, await release());
    await localUi.source();
    writeFileSync(join(dataDir, "app", "packages", "orion", "src", "main.ts"), fakeOrion(5151));
    await localUi.build(undefined, "Taught Orion something");
    localUi.disable();
    expect(localUi.orion.status().enabled).toBe(false);
  });
});

/** Starts the real Orion entry point and resolves with the port in its first ready line. */
async function startOrion(dataDir: string) {
  const proc = Bun.spawn(
    [
      process.execPath,
      MAIN,
      "--port",
      "0",
      "--token",
      TOKEN,
      "--data-dir",
      dataDir,
      "--mock-model",
      "--parent-watch",
    ],
    {
      env: { ...process.env, ORION_SECRETS: "file" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let out = "";
  const decoder = new TextDecoder();
  for await (const chunk of proc.stdout) {
    out += decoder.decode(chunk, { stream: true });
    if (out.includes("\n") && out.includes(READY_LINE_PREFIX)) break;
  }
  const line = out.split("\n").find((l) => l.startsWith(READY_LINE_PREFIX)) ?? "";
  const stop = async () => {
    proc.stdin.end();
    return proc.exited;
  };
  return {
    port: (JSON.parse(line.slice(READY_LINE_PREFIX.length)) as { port: number }).port,
    stop,
  };
}

function installFarmOrion(dataDir: string, source: string): LocalOrion {
  const local = new LocalOrion(dataDir, join(dataDir, "app"));
  mkdirSync(join(local.entry, ".."), { recursive: true });
  writeFileSync(local.entry, source);
  local.enable("abc123");
  return local;
}

describe("starting Orion", () => {
  test("the shipped Orion hands over to the farm's build and ends when it ends", async () => {
    const dataDir = temp();
    installFarmOrion(dataDir, fakeOrion(4242));
    const orion = await startOrion(dataDir);
    expect(orion.port).toBe(4242);
    expect(await orion.stop()).toBe(0);
    // The shipped Orion never opened the farm's data itself.
    expect(existsSync(join(dataDir, "orbit.sqlite"))).toBe(false);
  });

  test("a farm build that does not start is switched off and the shipped Orion runs instead", async () => {
    const dataDir = temp();
    const local = installFarmOrion(dataDir, "process.exit(3);\n");
    const orion = await startOrion(dataDir);
    const health = await fetch(`http://127.0.0.1:${orion.port}/health`);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);
    expect(local.status()).toMatchObject({ enabled: false });
    expect(local.status().lastError).toContain("exit code 3");
    expect(await orion.stop()).toBe(0);
  });
});

describe("restarting after a change to Orion", () => {
  const config = (dataDir: string) => ({
    port: 0,
    token: TOKEN,
    dataDir,
    mockModel: true,
    seed: false,
    gatewayUrl: null,
    appSource: null,
  });

  test("Orion restarts once the conversation that asked for it has finished", async () => {
    let restart: () => void = () => {};
    const restarted = new Promise<void>((resolve) => {
      restart = resolve;
    });
    const app = await startApp({ ...config(temp()), restart });
    const client = await connect(app);
    const { session } = await client.request("sessions.create", { title: "Named already" });
    const settled = waitFor(client, "agent.settled", (e) => e.sessionId === session.id);
    expect(app.hub.restartWhenIdle()).toBe(true);
    await client.request("chat.prompt", { sessionId: session.id, text: "hello" });
    await settled;
    await restarted;
    client.close();
    await app.stop();
  });

  test("without a parent to start it again, Orion says it will not restart", async () => {
    const app = await startApp(config(temp()));
    expect(app.hub.restartWhenIdle()).toBe(false);
    await app.stop();
  });
});
