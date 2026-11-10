import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const read = (...path: string[]) => readFileSync(join(root, ...path), "utf8");

test("the herd and calendar views carry the same reproduction rules", () => {
  expect(read("pages", "calendar", "repro.js")).toBe(read("pages", "herd", "repro.js"));
});

test("every page the skill lists has its panel, its card and settings Orion can parse", () => {
  const manifest = JSON.parse(read("skill.json")) as { pages: Array<{ id: string; dir: string }> };
  expect(manifest.pages.map((page) => page.id)).toEqual(["herd", "calendar", "cameras"]);
  for (const page of manifest.pages) {
    const meta = JSON.parse(read(page.dir, "page.json")) as { title?: string; card?: string };
    expect({ page: page.id, title: typeof meta.title }).toEqual({ page: page.id, title: "string" });
    expect({ page: page.id, panel: existsSync(join(root, page.dir, "index.html")) }).toEqual({
      page: page.id,
      panel: true,
    });
    expect({ page: page.id, card: existsSync(join(root, page.dir, meta.card ?? "")) }).toEqual({
      page: page.id,
      card: true,
    });
    expect(() => JSON.parse(read(page.dir, "config.json"))).not.toThrow();
  }
});
