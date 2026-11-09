import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { createFarmTools } from "../src/agent/tools";
import { openDatabase } from "../src/db/open";
import { RepoError } from "../src/db/repo";
import { EncryptedFileStore } from "../src/secrets";
import { FarmService } from "../src/services/farm";
import { LocalUiService } from "../src/services/local-ui";
import { SkillService } from "../src/services/skills";
import { removeDir, TOKEN, tempDir } from "./helpers";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

const ctx = {
  sessionManager: { getSessionId: () => "test-session" },
} as unknown as ExtensionToolContext;

const textOf = (result: { content: Array<{ type: string; text?: string }> } | undefined) =>
  result?.content[0]?.text ?? "";

const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

interface SkillSpec {
  name: string;
  files: Record<string, string>;
  /** Catalog entries that differ from the real files (tampering, traversal). */
  listed?: Array<{ path: string; sha256: string }>;
}

function writeCatalog(dir: string, skills: SkillSpec[]) {
  for (const s of skills) {
    for (const [path, content] of Object.entries(s.files)) {
      const file = join(dir, s.name, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  }
  const index = {
    version: 1,
    skills: skills.map((s) => ({
      name: s.name,
      version: "1.0.0",
      description: `${s.name} skill`,
      keywords: ["demo vendor"],
      files:
        s.listed ??
        Object.entries(s.files).map(([path, content]) => ({ path, sha256: sha(content) })),
    })),
  };
  writeFileSync(join(dir, "index.json"), JSON.stringify(index));
}

function setup() {
  const dir = tempDir();
  cleanups.push(() => removeDir(dir));
  const catalog = join(dir, "catalog");
  const workspace = join(dir, "workspace");
  mkdirSync(catalog, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const db = openDatabase(dir, { seed: false });
  cleanups.push(() => db.close());
  const farm = new FarmService(db.repo, new EncryptedFileStore(dir), workspace);
  const skills = new SkillService(catalog, workspace);
  const tools = createFarmTools(
    farm,
    new LocalUiService(dir, join(dir, "app"), TOKEN, () => {}),
    skills,
  );
  const call = (name: string, args: Record<string, unknown>) =>
    tools.find((t) => t.name === name)?.execute("call", args, undefined, undefined, ctx);
  return { dir, catalog, workspace, db, farm, skills, call };
}

const SKILL_MD =
  "---\nname: demo\ndescription: Demo vendor\n---\n\n# Demo\n\nFollow these steps.\n";

describe("skill catalog", () => {
  test("search finds a skill by keyword and install returns its instructions", async () => {
    const { catalog, workspace, skills, call } = setup();
    writeCatalog(catalog, [{ name: "demo", files: { "SKILL.md": SKILL_MD, "a/b.txt": "x" } }]);

    const found = await call("skill_search", { query: "demo vendor" });
    expect(found?.details).toMatchObject({ skills: [{ name: "demo", installed: false }] });
    expect((await call("skill_search", { query: "lely" }))?.details).toEqual({ skills: [] });

    const installed = await call("skill_install", { name: "demo" });
    expect(installed?.isError).toBeUndefined();
    expect(textOf(installed)).toContain("Follow these steps.");
    expect(existsSync(join(workspace, "skills", "demo", "a", "b.txt"))).toBe(true);
    expect(skills.installed()).toEqual(["demo"]);
  });

  test("a file that does not match its checksum installs nothing", async () => {
    const { catalog, skills } = setup();
    writeCatalog(catalog, [
      {
        name: "demo",
        files: { "SKILL.md": SKILL_MD, "run.ts": "tampered" },
        listed: [
          { path: "SKILL.md", sha256: sha(SKILL_MD) },
          { path: "run.ts", sha256: sha("original") },
        ],
      },
    ]);
    const error = await skills.install("demo").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RepoError);
    expect((error as RepoError).message).toContain("checksum");
    expect(existsSync(skills.installDir) ? readdirSync(skills.installDir) : []).toEqual([]);
  });

  test("a path that leaves the skill folder is refused before any download", async () => {
    const { catalog, skills, dir } = setup();
    writeCatalog(catalog, [
      {
        name: "demo",
        files: { "SKILL.md": SKILL_MD },
        listed: [
          { path: "SKILL.md", sha256: sha(SKILL_MD) },
          { path: "../../escape.txt", sha256: sha("x") },
        ],
      },
    ]);
    const error = await skills.install("demo").catch((e: unknown) => e);
    expect((error as RepoError).code).toBe("bad_request");
    expect(existsSync(join(dir, "escape.txt"))).toBe(false);
    expect(existsSync(skills.installDir) ? readdirSync(skills.installDir) : []).toEqual([]);
  });

  test("the repository catalog matches the skill files", async () => {
    const root = resolve(import.meta.dir, "../../..");
    const proc = Bun.spawn([process.execPath, "scripts/build-skills-index.ts", "--check"], {
      cwd: root,
      env: process.env,
      stdin: "ignore",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(err).toBe("");
    expect(code).toBe(0);
  });
});

// A stand-in connector that follows the same contract as the DelPro one: it reports the herd and
// only the milkings after the cursor it returned last time.
const CONNECTOR = `export default async function sync(ctx) {
  const after = ctx.state?.cursor ?? 0;
  const milkings = [
    { id: 1, nationalId: "NAT-1", kg: 12.5, at: "2026-11-01T05:00:00Z" },
    { id: 2, nationalId: "NAT-2", kg: 9.75, at: "2026-11-01T05:10:00Z" },
  ].filter((m) => m.id > after);
  ctx.log(\`host \${ctx.config.host}, secret \${ctx.secret ? "set" : "missing"}\`);
  return {
    animals: [
      { species: "cattle", nationalId: "NAT-1", earTagNumber: "101", name: "Bella", sex: "female" },
      { species: "cattle", nationalId: "NAT-2", earTagNumber: "102", status: "sold" },
      { species: "goat", nationalId: "NAT-3" },
    ],
    observations: milkings.map((m) => ({
      nationalId: m.nationalId,
      kind: "milking",
      ts: m.at,
      valueNum: m.kg,
      valueJson: { unit: "kg" },
    })),
    state: { cursor: Math.max(after, ...milkings.map((m) => m.id)) },
  };
}
`;

describe("connector from a skill", () => {
  test("scaffold copies the skill's connector and runs import the herd once and milkings incrementally", async () => {
    const { catalog, skills, db, farm, call } = setup();
    const manifest = JSON.stringify({
      name: "demo",
      version: "1.0.0",
      connector: { dir: "connector", vendor: "delaval", kind: "local_db", config: { port: 1433 } },
    });
    writeCatalog(catalog, [
      {
        name: "demo",
        files: {
          "SKILL.md": SKILL_MD,
          "skill.json": manifest,
          "connector/connector.ts": CONNECTOR,
        },
      },
    ]);
    await skills.install("demo");

    const scaffolded = await call("connector_scaffold", { name: "demo-feed", fromSkill: "demo" });
    expect(scaffolded?.isError).toBeUndefined();
    const id = (scaffolded?.details as { id?: string } | undefined)?.id ?? "";
    const connector = db.repo.getConnector(id);
    expect(connector).toMatchObject({ vendor: "delaval", kind: "local_db", enabled: false });
    expect(connector.config).toMatchObject({ port: 1433, path: "connectors/demo-feed" });

    const refused = await call("connector_configure", { id, config: { password: "hunter2" } });
    expect(refused?.isError).toBe(true);
    await call("connector_configure", { id, config: { host: "delpro-pc" } });
    await farm.mutate({
      mutation: "connectors.upsert",
      params: {
        connector: { id, vendor: "delaval", kind: "local_db", enabled: true, secret: "pw" },
      },
    });

    const first = await farm.connectors.run(id);
    expect(first).toMatchObject({ imported: 2, skipped: 1, animalsCreated: 2, animalsUpdated: 0 });
    expect(first.logs).toEqual(["host delpro-pc, secret set"]);
    const bella = db.repo.matchAnimal("NAT-1", null);
    expect(bella).toMatchObject({ name: "Bella", earTagNumber: "101", status: "active" });
    expect(db.repo.matchAnimal(null, "102")?.status).toBe("sold");
    const milkings = db.repo.recentObservations({ kind: "milking", limit: 10 });
    expect(milkings.find((o) => o.valueNum === 12.5)?.animalId).toBe(bella?.id);
    expect(milkings.every((o) => o.source === `connector:${id}`)).toBe(true);

    const second = await farm.connectors.run(id);
    expect(second).toMatchObject({ imported: 0, animalsCreated: 0, animalsUpdated: 2 });
    expect(db.repo.recentObservations({ kind: "milking", limit: 10 })).toHaveLength(2);
  });

  test("the DelPro skill's mapping imports through Orion with LIV-shaped rows", async () => {
    const { catalog, skills, db, farm, call } = setup();
    const payload = resolve(
      import.meta.dir,
      "../../../skills/delaval-delpro/connector/connector.ts",
    );
    const wrapper = `import { syncWith } from ${JSON.stringify(payload)};
const animal = { oid: 7, number: 1234, regNo: "NO-1234", name: "Dagros", birthDate: "2021-04-02", sex: 2, groupName: "Lact", exitDate: null };
const milking = { oid: 501, number: 1234, regNo: "NO-1234", endTime: "2026-07-01 06:10:00", beginTime: "2026-07-01 06:02:00", previousEndTime: null, totalYield: 12.78, avgConductivity: 5126, occ: 90, occAverage: 85, milkingDevice: 2, destination: 1, milkType: 0, incomplete: 0, kickoff: 0 };
const source = { animals: async () => [animal], milkings: async (since) => (since ?? 0) < 501 ? [milking] : [], daily: async () => [], close: async () => {} };
export default (ctx) => syncWith(source, ctx);
`;
    const manifest = JSON.stringify({
      name: "demo",
      version: "1.0.0",
      connector: { dir: "connector", vendor: "delaval", kind: "local_db" },
    });
    writeCatalog(catalog, [
      {
        name: "demo",
        files: { "SKILL.md": SKILL_MD, "skill.json": manifest, "connector/connector.ts": wrapper },
      },
    ]);
    await skills.install("demo");
    const scaffolded = await call("connector_scaffold", { name: "delpro", fromSkill: "demo" });
    const id = (scaffolded?.details as { id?: string } | undefined)?.id ?? "";
    await call("connector_configure", { id, config: { timezone: "America/Chicago" } });
    db.repo.upsertConnector({ id, vendor: "delaval", kind: "local_db", enabled: true });

    expect(await farm.connectors.run(id)).toMatchObject({ imported: 1, animalsCreated: 1 });
    const cow = db.repo.matchAnimal("NO-1234", null);
    expect(cow).toMatchObject({ earTagNumber: "1234", name: "Dagros", sex: "female" });
    const [milkingRow] = db.repo.recentObservations({ kind: "milking", limit: 5 });
    expect(milkingRow).toMatchObject({ animalId: cow?.id, valueNum: 12.78 });
    expect(milkingRow?.ts).toBe("2026-07-01T11:10:00.000Z");
    expect(milkingRow?.valueJson).toMatchObject({ conductivity: 5.126, scc: 85, durationSec: 480 });
    expect(await farm.connectors.run(id)).toMatchObject({ imported: 0, animalsUpdated: 1 });
  });

  test("scaffold refuses a skill that is not installed", async () => {
    const { call } = setup();
    const result = await call("connector_scaffold", { name: "x", fromSkill: "missing" });
    expect(result?.isError).toBe(true);
    expect(textOf(result)).toContain("not installed");
  });
});
