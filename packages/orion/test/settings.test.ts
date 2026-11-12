import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SettingsStore } from "../src/settings";
import { removeDir, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

function dataDir(settings?: Record<string, unknown>): string {
  const dir = tempDir();
  dirs.push(dir);
  if (settings) writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
  return dir;
}

describe("thinking level", () => {
  test("a new install and an older file that stored the old off default think at medium", () => {
    expect(new SettingsStore(dataDir()).get().thinkingLevel).toBe("medium");
    const older = dataDir({
      provider: "orbit-gateway",
      model: "orbit-default",
      thinkingLevel: "off",
    });
    expect(new SettingsStore(older).get().thinkingLevel).toBe("medium");
    expect(new SettingsStore(dataDir({ thinkingLevel: "high" })).get().thinkingLevel).toBe("high");
  });

  test("off chosen after the change is kept", () => {
    const dir = dataDir({ thinkingLevel: "off" });
    new SettingsStore(dir).update({ thinkingLevel: "off" });
    expect(new SettingsStore(dir).get().thinkingLevel).toBe("off");
  });
});
