import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as git from "isomorphic-git";
import { Workspace } from "../src/agent/workspace";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = fs.mkdtempSync(join(tmpdir(), "orion-workspace-"));
  dirs.push(dir);
  return new Workspace(dir);
}

function write(workspace: Workspace, path: string, content: string | Uint8Array) {
  const file = join(workspace.dir, path);
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function snapshot(workspace: Workspace, message = "Test change") {
  const result = await workspace.snapshot(message);
  if (!result) throw new Error("expected a workspace snapshot");
  return result;
}

describe("workspace snapshots", () => {
  test("initializes and snapshots with no git on PATH", async () => {
    const workspace = setup();
    const path = process.env.PATH;
    process.env.PATH = "";
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("workspace must not spawn a child process");
    });
    try {
      await workspace.init();
      for (const folder of ["connectors", "pages", "skills"])
        expect(fs.statSync(join(workspace.dir, folder)).isDirectory()).toBe(true);
      const log = await git.log({ fs, dir: workspace.dir });
      expect(log.map((entry) => entry.commit.message.trim())).toEqual(["Farm workspace created"]);
      expect(await git.listFiles({ fs, dir: workspace.dir })).toEqual([".gitignore", "AGENTS.md"]);
      expect(await workspace.snapshot("Nothing changed")).toBeNull();
      write(workspace, "pages/test/index.html", "hello");
      expect((await snapshot(workspace)).files).toEqual(["pages/test/index.html"]);
    } finally {
      spawn.mockRestore();
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
  });

  test("reopening preserves starter files and history", async () => {
    const workspace = setup();
    await workspace.init();
    write(workspace, "AGENTS.md", "Farm notes");
    const change = await snapshot(workspace);

    await new Workspace(workspace.dir).init();

    expect(fs.readFileSync(join(workspace.dir, "AGENTS.md"), "utf8")).toBe("Farm notes");
    expect(await git.resolveRef({ fs, dir: workspace.dir, ref: "HEAD" })).toBe(change.commit);
  });

  test.each(["added", "modified", "deleted"])("snapshots and reverts %s files", async (kind) => {
    const workspace = setup();
    await workspace.init();
    const file = "pages/board/data.bin";
    const original = Buffer.from([0, 255, 128, 10]);
    if (kind !== "added") {
      write(workspace, file, original);
      await snapshot(workspace, "Original");
    }
    const parent = await git.resolveRef({ fs, dir: workspace.dir, ref: "HEAD" });
    if (kind === "deleted") fs.rmSync(join(workspace.dir, file));
    else write(workspace, file, Buffer.from([0, 1, 254, 13, 10]));

    const change = await snapshot(workspace);
    expect(change.parent).toBe(parent);
    expect(change.files).toEqual([file]);
    const committed = await git.listFiles({ fs, dir: workspace.dir, ref: change.commit });
    expect(committed.includes(file)).toBe(kind !== "deleted");
    if (kind !== "deleted") {
      expect(
        Buffer.from(
          (await git.readBlob({ fs, dir: workspace.dir, oid: change.commit, filepath: file })).blob,
        ),
      ).toEqual(Buffer.from([0, 1, 254, 13, 10]));
    }
    // Unrelated later work, both committed and uncommitted, must survive undo.
    write(workspace, "skills/later.md", "later");
    const later = await snapshot(workspace, "Later");
    write(workspace, "skills/dirty.md", "unfinished");
    if (kind === "deleted") fs.rmSync(join(workspace.dir, "pages/board"), { recursive: true });

    expect(await workspace.revert(change.commit)).toEqual([file]);

    if (kind === "added") expect(fs.existsSync(join(workspace.dir, file))).toBe(false);
    else expect(fs.readFileSync(join(workspace.dir, file))).toEqual(original);
    expect(fs.readFileSync(join(workspace.dir, "skills/later.md"), "utf8")).toBe("later");
    expect(fs.readFileSync(join(workspace.dir, "skills/dirty.md"), "utf8")).toBe("unfinished");
    const [undo] = await git.log({ fs, dir: workspace.dir, depth: 1 });
    expect(undo?.commit.parent).toEqual([later.commit]);
    expect(await git.listFiles({ fs, dir: workspace.dir, ref: "HEAD" })).not.toContain(
      "skills/dirty.md",
    );
  });

  test.each(["added", "modified", "deleted"])(
    "conflicting %s files leave the entire undo untouched",
    async (kind) => {
      const workspace = setup();
      await workspace.init();
      if (kind !== "added") {
        write(workspace, "z-conflict.txt", "before");
        await snapshot(workspace);
      }
      write(workspace, "a-safe.txt", "must remain");
      if (kind === "deleted") fs.rmSync(join(workspace.dir, "z-conflict.txt"));
      else write(workspace, "z-conflict.txt", "snapshot");
      const change = await snapshot(workspace);
      write(workspace, "z-conflict.txt", "later change");
      const later = await snapshot(workspace);

      await expect(workspace.revert(change.commit)).rejects.toThrow(
        "could not undo: later changes touch the same files",
      );

      expect(fs.readFileSync(join(workspace.dir, "a-safe.txt"), "utf8")).toBe("must remain");
      expect(fs.readFileSync(join(workspace.dir, "z-conflict.txt"), "utf8")).toBe("later change");
      expect(await git.resolveRef({ fs, dir: workspace.dir, ref: "HEAD" })).toBe(later.commit);
      expect(await workspace.snapshot("No partial undo")).toBeNull();
    },
  );

  test("uncommitted overlapping changes also prevent undo", async () => {
    const workspace = setup();
    await workspace.init();
    write(workspace, "note.txt", "snapshot");
    const change = await snapshot(workspace);
    write(workspace, "note.txt", "unfinished");

    await expect(workspace.revert(change.commit)).rejects.toThrow("could not undo:");

    expect(fs.readFileSync(join(workspace.dir, "note.txt"), "utf8")).toBe("unfinished");
  });

  test("ignores large connector dependencies and nested ignore rules", async () => {
    const workspace = setup();
    await workspace.init();
    write(workspace, "connectors/vendor/.gitignore", "cache/\n*.tmp\n!keep.tmp\n");
    write(workspace, "connectors/vendor/cache/ignored.txt", "cache");
    write(workspace, "connectors/vendor/ignored.tmp", "ignored");
    write(workspace, "connectors/vendor/keep.tmp", "keep");
    write(workspace, ".env", "secret");
    write(workspace, "debug.log", "logs");
    for (let i = 0; i < 10_000; i++)
      write(workspace, `connectors/vendor/node_modules/pkg-${i}/index.js`, "dependency");
    write(workspace, "connectors/vendor/index.ts", "connector");

    const start = performance.now();
    const change = await snapshot(workspace);
    console.log(
      `workspace snapshot with 10,000 ignored files: ${(performance.now() - start).toFixed(1)} ms`,
    );

    expect(change.files).toEqual([
      "connectors/vendor/.gitignore",
      "connectors/vendor/index.ts",
      "connectors/vendor/keep.tmp",
    ]);
    expect(await workspace.snapshot("Ignored only")).toBeNull();
  }, 30_000);

  const gitBinary = Bun.which("git");
  test.skipIf(!gitBinary)(
    "reopens a real git repository with deleted and ignored tracked files",
    async () => {
      if (!gitBinary) throw new Error("git is unavailable");
      const workspace = setup();
      const cli = async (...args: string[]) => {
        const proc = Bun.spawn([gitBinary, ...args], {
          cwd: workspace.dir,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@orbit.local",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@orbit.local",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
        if (code !== 0) throw new Error(stderr);
      };
      await cli("init", "-q");
      write(workspace, "AGENTS.md", "Existing farm");
      write(workspace, ".gitignore", "node_modules/\n*.log\n");
      write(workspace, "deleted.txt", "restore me");
      write(workspace, "tracked.log", "tracked");
      await cli("add", "-A");
      await cli("add", "-f", "tracked.log");
      await cli("commit", "-qm", "Existing repository");
      // Exercise reading packed objects as well as git's index.
      await cli("gc", "--quiet");
      fs.rmSync(join(workspace.dir, "deleted.txt"));
      write(workspace, "tracked.log", "changed tracked");
      write(workspace, "ignored.log", "ignored");
      write(workspace, "node_modules/vendor/index.js", "ignored dependency");

      await workspace.init();
      const change = await snapshot(workspace);

      expect(change.files).toEqual(["deleted.txt", "tracked.log"]);
      expect(await workspace.revert(change.commit)).toEqual(["deleted.txt", "tracked.log"]);
      expect(fs.readFileSync(join(workspace.dir, "deleted.txt"), "utf8")).toBe("restore me");
      expect(fs.readFileSync(join(workspace.dir, "tracked.log"), "utf8")).toBe("tracked");
      expect(fs.readFileSync(join(workspace.dir, "AGENTS.md"), "utf8")).toBe("Existing farm");
      expect(await workspace.snapshot("Clean")).toBeNull();
    },
  );
});
