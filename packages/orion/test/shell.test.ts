import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledShell } from "../src/agent/shell";

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
