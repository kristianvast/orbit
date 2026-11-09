// Builds skills/index.json, the catalog Orion's skill_search and skill_install read. Each skill
// folder needs a SKILL.md with name and description front matter; skill.json may add version and
// keywords. Tests, lockfiles and node_modules are not published.
// Usage: bun scripts/build-skills-index.ts [--check]
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP = /(^|\/)(node_modules|bun\.lock|[^/]+\.test\.ts|fixtures)(\/|$)/;

function files(dir: string, root = dir): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      const rel = relative(root, path);
      if (SKIP.test(rel)) return [];
      return statSync(path).isDirectory() ? files(path, root) : [rel];
    })
    .sort();
}

function frontMatter(md: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? "";
  return Object.fromEntries(
    block
      .split("\n")
      .map((line) => /^(\w+):\s*(.*)$/.exec(line))
      .filter((m) => m !== null)
      .map((m) => [m[1], m[2]]),
  );
}

export function buildIndex(skillsDir: string) {
  const skills = readdirSync(skillsDir)
    .filter((name) => statSync(join(skillsDir, name)).isDirectory())
    .sort()
    .map((name) => {
      const dir = join(skillsDir, name);
      const meta = frontMatter(readFileSync(join(dir, "SKILL.md"), "utf8"));
      if (meta.name !== name || !meta.description) {
        throw new Error(`${name}/SKILL.md needs name: ${name} and a description`);
      }
      let manifest: { version?: string; keywords?: string[] } = {};
      try {
        manifest = JSON.parse(readFileSync(join(dir, "skill.json"), "utf8"));
      } catch {}
      return {
        name,
        version: manifest.version ?? "0.0.0",
        description: meta.description,
        ...(manifest.keywords ? { keywords: manifest.keywords } : {}),
        files: files(dir).map((path) => ({
          path,
          sha256: new Bun.CryptoHasher("sha256")
            .update(readFileSync(join(dir, path)))
            .digest("hex"),
        })),
      };
    });
  return `${JSON.stringify({ version: 1, skills }, null, 2)}\n`;
}

if (import.meta.main) {
  const dir = join(import.meta.dir, "..", "skills");
  const next = buildIndex(dir);
  const file = join(dir, "index.json");
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(file, "utf8");
    } catch {}
    if (current !== next) {
      console.error("skills/index.json is stale; run bun scripts/build-skills-index.ts");
      process.exit(1);
    }
  } else {
    writeFileSync(file, next);
  }
}
