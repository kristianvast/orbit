import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledShell, shellTools } from "../src/agent/shell";

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
