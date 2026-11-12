import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppCode } from "../src/services/farm-code-app";
import { LocalUiService } from "../src/services/local-ui";
import { removeDir, TOKEN, tempDir } from "./helpers";

const dirs: string[] = [];
function temp() {
  const dir = tempDir();
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});
function file(dir: string, path: string, content: string) {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
}
async function git(dir: string, ...args: string[]) {
  const proc = Bun.spawn(
    ["git", "-c", "user.name=Test", "-c", "user.email=test@orbit.local", ...args],
    {
      cwd: dir,
      env: { ...process.env, GIT_MASTER: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}
const theme = (farm: string, release: string) =>
  [
    `export const farm = "${farm}";`,
    ...Array.from({ length: 20 }, (_, i) => `// gap ${i}`),
    `export const release = "${release}";`,
    "",
  ].join("\n");

async function fixtures() {
  const origin = temp();
  file(
    origin,
    "apps/orbit/package.json",
    JSON.stringify({
      name: "orbit-port-fixture",
      scripts: {
        typecheck:
          "bun -e \"process.exit((await Bun.file('src/theme.ts').text()).includes('BROKEN') ? 1 : 0)\"",
        "build:local":
          "bun -e \"await Bun.write('dist/index.html', '<html><head></head><body>checked farm app</body></html>')\"",
      },
    }),
  );
  file(origin, "apps/orbit/src/theme.ts", theme("default", "old"));
  file(origin, ".gitignore", "node_modules\ndist\n");
  await git(origin, "init", "--quiet", "--initial-branch", "main");
  await git(origin, "add", "-A");
  await git(origin, "commit", "--quiet", "-m", "release one");
  await git(origin, "tag", "v0.1.1");
  file(origin, "apps/orbit/src/theme.ts", theme("default", "new"));
  file(origin, "release-only.txt", "installed release two");
  await git(origin, "add", "-A");
  await git(origin, "commit", "--quiet", "-m", "release two");
  await git(origin, "tag", "v0.1.2");
  const pc = async (version: string) => {
    const data = temp();
    const checkout = join(data, "app");
    await git(data, "clone", "--quiet", "--branch", `v${version}`, origin, checkout);
    await git(checkout, "switch", "--quiet", "-c", "farm");
    mkdirSync(join(checkout, "node_modules"));
    const ui = new LocalUiService(data, checkout, TOKEN, () => {}, { version, sourceUrl: origin });
    return { data, checkout, ui, code: new AppCode(data, ui) };
  };
  return { sender: await pc("0.1.1"), receiver: await pc("0.1.2") };
}

test("ports a farm delta onto the receiver's different installed release and checks the build", async () => {
  const { sender, receiver } = await fixtures();
  file(sender.checkout, "apps/orbit/src/theme.ts", theme("farm", "old"));
  const { delta, blobs } = await sender.code.collect();
  if (!delta) throw new Error("Missing sender delta");
  await receiver.code.receive(delta, blobs);
  expect(readFileSync(join(receiver.checkout, "apps/orbit/src/theme.ts"), "utf8")).toBe(
    theme("farm", "new"),
  );
  expect(readFileSync(join(receiver.checkout, "release-only.txt"), "utf8")).toBe(
    "installed release two",
  );
  expect(receiver.ui.status()).toMatchObject({
    state: "ready",
    baseVersion: "0.1.2",
    syncError: null,
  });
  expect(await git(receiver.checkout, "merge-base", "HEAD", "v0.1.2")).toBe(
    await git(receiver.checkout, "rev-parse", "v0.1.2"),
  );
  expect(existsSync(join(receiver.checkout, "apps/orbit/dist/index.html"))).toBe(true);
}, 30_000);

test.each(["conflict", "build"] as const)(
  "retains recovery bytes and shipped UI on app port %s failure",
  async (failure) => {
    const { sender, receiver } = await fixtures();
    file(
      sender.checkout,
      "apps/orbit/src/theme.ts",
      failure === "conflict" ? theme("farm", "sender release edit") : theme("BROKEN", "old"),
    );
    const { delta, blobs } = await sender.code.collect();
    if (!delta) throw new Error("Missing sender delta");
    const before = await git(receiver.checkout, "rev-parse", "HEAD");
    await receiver.code.receive(delta, blobs);
    const status = receiver.ui.status();
    expect(status.state).toBe("none");
    expect(status.syncError).toBeTruthy();
    expect(await git(receiver.checkout, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(receiver.checkout, "apps/orbit/src/theme.ts"), "utf8")).toBe(
      theme("default", "new"),
    );
    if (!status.recoveryPath) throw new Error("Missing app recovery path");
    const saved = JSON.parse(readFileSync(join(status.recoveryPath, "delta.json"), "utf8"));
    const path = saved.delta.files["apps/orbit/src/theme.ts"];
    expect(Buffer.from(saved.blobs[path.base], "base64").toString()).toBe(theme("default", "old"));
    expect(Buffer.from(saved.blobs[path.content], "base64").toString()).toContain(
      failure === "conflict" ? "sender release edit" : "BROKEN",
    );
  },
  30_000,
);
