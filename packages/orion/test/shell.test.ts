import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledShell, RepeatGuard, SAME_RESULT_LIMIT, shellTools } from "../src/agent/shell";

describe("bundledShell", () => {
  test("finds the MinGit shell next to the sidecar on Windows and nowhere else", () => {
    const dir = mkdtempSync(join(tmpdir(), "orion-shell-"));
    try {
      const exe = join(dir, "orion.exe");
      expect(bundledShell(exe, "win32")).toBeNull();
      mkdirSync(join(dir, "mingit", "usr", "bin"), { recursive: true });
      writeFileSync(join(dir, "mingit", "usr", "bin", "sh.exe"), "");
      const found = bundledShell(exe, "win32");
      expect(found?.shellPath).toBe(join(dir, "mingit", "usr", "bin", "sh.exe"));
      expect(found?.pathDirs).toContain(join(dir, "mingit", "cmd"));
      expect(bundledShell(exe, "darwin")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shellTools", () => {
  test("the shell tools ask for a plain-words description beside the command and still run it", async () => {
    const params = (t: { parameters: unknown }) =>
      t.parameters as { properties: Record<string, unknown>; required?: string[] };
    expect(shellTools("/tmp", undefined, "darwin").map((t) => t.name)).toEqual(["bash"]);
    expect(shellTools("C:\\farm", undefined, "win32").map((t) => t.name)).toEqual(["powershell"]);
    const [bash] = shellTools(tmpdir(), undefined, "darwin");
    if (!bash) throw new Error("no bash tool");
    expect(Object.keys(params(bash).properties)).toEqual(
      expect.arrayContaining(["command", "timeout", "description"]),
    );
    expect(params(bash).required ?? []).toEqual(["command"]);
    const result = await bash.execute(
      "call-1",
      { command: "echo hi", description: "Saying hi" },
      undefined,
      undefined,
      undefined as unknown as Parameters<typeof bash.execute>[4],
    );
    expect(JSON.stringify(result.content)).toContain("hi");
  });
});

describe("RepeatGuard", () => {
  test("a command that keeps giving the same result is refused, one whose result changes always runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orion-repeat-"));
    try {
      const repeats = new RepeatGuard();
      const [bash] = shellTools(dir, undefined, "darwin", repeats);
      if (!bash) throw new Error("no bash tool");
      const run = (command: string) =>
        bash.execute(
          "call",
          { command, description: "Checking" },
          undefined,
          undefined,
          undefined as unknown as Parameters<typeof bash.execute>[4],
        );
      const textOf = (r: Awaited<ReturnType<typeof run>>) => JSON.stringify(r.content);
      const runs = () => readFileSync(join(dir, "runs"), "utf8").trim().split("\n").length;

      const same = "echo x >> runs; echo done";
      expect(textOf(await run(same))).not.toContain("Same command");
      expect(textOf(await run(same))).toContain("Same command, same result");
      expect(textOf(await run(same))).toContain("will not run again");
      await expect(run(same)).rejects.toThrow("Not run");
      expect(runs()).toBe(SAME_RESULT_LIMIT);

      for (let i = 0; i < SAME_RESULT_LIMIT + 2; i++) {
        expect(textOf(await run("echo y >> count; wc -l < count"))).not.toContain("Same command");
      }

      for (let i = 0; i < SAME_RESULT_LIMIT; i++) await run("echo failed >&2; exit 3");
      await expect(run("echo failed >&2; exit 3")).rejects.toThrow("Not run");

      repeats.reset();
      await run(same);
      expect(runs()).toBe(SAME_RESULT_LIMIT + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
