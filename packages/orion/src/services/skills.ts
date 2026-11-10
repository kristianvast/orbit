// Skills Orion fetches on demand. The catalog (index.json) and the skill files live in git (the
// skills/ folder of the Orbit repository) and are installed into <workspace>/skills/<name>/ only
// when a farm needs one, so Orbit ships none of them and Orion's context holds none of them until
// they are installed. Every file is checked against the catalog's sha256 before anything is written.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONNECTOR_KINDS, CONNECTOR_VENDORS } from "@orbit/schema/enums";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { RepoError } from "../db/repo";
import { scaffoldPage } from "./pages";

export const DEFAULT_SKILLS_URL =
  "https://raw.githubusercontent.com/kristianvast/orbit/main/skills";

const NAME = "^[a-z0-9][a-z0-9-]{0,47}$";
const SHA256 = "^[a-f0-9]{64}$";

const CatalogSkill = Type.Object({
  name: Type.String({ pattern: NAME }),
  version: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  keywords: Type.Optional(Type.Array(Type.String())),
  files: Type.Array(
    Type.Object({ path: Type.String(), sha256: Type.String({ pattern: SHA256 }) }),
    {
      minItems: 1,
    },
  ),
});
export type CatalogSkill = Static<typeof CatalogSkill>;

const Catalog = Type.Object({ version: Type.Literal(1), skills: Type.Array(CatalogSkill) });
export type Catalog = Static<typeof Catalog>;

const SkillManifest = Type.Object({
  name: Type.String({ pattern: NAME }),
  version: Type.String(),
  connector: Type.Optional(
    Type.Object({
      dir: Type.String(),
      vendor: Type.Enum([...CONNECTOR_VENDORS]),
      kind: Type.Enum([...CONNECTOR_KINDS]),
      config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
  ),
  /** Ready-made pages (a panel, usually with a Home card) that page_scaffold copies into pages/. */
  pages: Type.Optional(
    Type.Array(Type.Object({ id: Type.String({ pattern: NAME }), dir: Type.String() })),
  ),
});
export type SkillManifest = Static<typeof SkillManifest>;

export interface InstalledSkill {
  name: string;
  version: string;
  dir: string;
  files: string[];
  instructions: string;
}

/** A relative file path inside a skill: no absolute paths, no "..", no backslashes or odd bytes. */
function isSafePath(path: string): boolean {
  if (path.length === 0 || path.length > 200 || path.startsWith("/")) return false;
  return path.split("/").every((seg) => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(seg));
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export class SkillService {
  /**
   * @param source http(s) base URL or local directory that holds index.json and one folder per skill
   * @param workspace farm workspace; skills are installed into <workspace>/skills
   */
  constructor(
    readonly source: string,
    private readonly workspace: string,
  ) {}

  get installDir(): string {
    return join(this.workspace, "skills");
  }

  /** True when the catalog is a folder on this computer (a checkout), not a download. */
  get local(): boolean {
    return !/^https?:\/\//.test(this.source);
  }

  private async fetchBytes(rel: string): Promise<Uint8Array> {
    if (/^https?:\/\//.test(this.source)) {
      const url = `${this.source.replace(/\/+$/, "")}/${rel}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok)
        throw new RepoError("not_found", `could not download ${url} (HTTP ${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    }
    try {
      return new Uint8Array(await readFile(join(this.source, rel)));
    } catch {
      throw new RepoError("not_found", `could not read ${join(this.source, rel)}`);
    }
  }

  async catalog(): Promise<Catalog> {
    const raw = new TextDecoder().decode(await this.fetchBytes("index.json"));
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new RepoError("bad_request", "the skill catalog is not valid JSON");
    }
    if (!Value.Check(Catalog, parsed)) {
      throw new RepoError("bad_request", "the skill catalog does not have the expected shape");
    }
    return parsed;
  }

  /** Skills whose name, description or keywords contain every word of the query (all for ""). */
  async search(query: string): Promise<CatalogSkill[]> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const { skills } = await this.catalog();
    return skills.filter((s) => {
      const hay = [s.name, s.description, ...(s.keywords ?? [])].join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }

  /** Downloads and verifies every file first, then swaps the skill folder in as a whole. */
  async install(name: string): Promise<InstalledSkill> {
    const { skills } = await this.catalog();
    const skill = skills.find((s) => s.name === name);
    if (!skill) throw new RepoError("not_found", `no skill named "${name}" in the catalog`);
    const unsafe = skill.files.find((f) => !isSafePath(f.path));
    if (unsafe)
      throw new RepoError("bad_request", `skill ${name} lists an unsafe path: ${unsafe.path}`);
    if (!skill.files.some((f) => f.path === "SKILL.md")) {
      throw new RepoError("bad_request", `skill ${name} has no SKILL.md`);
    }
    const files = new Map<string, Uint8Array>();
    for (const file of skill.files) {
      const bytes = await this.fetchBytes(`${name}/${file.path}`);
      if (sha256(bytes) !== file.sha256) {
        throw new RepoError(
          "bad_request",
          `skill ${name}: ${file.path} does not match the catalog checksum; nothing was installed`,
        );
      }
      files.set(file.path, bytes);
    }
    const dest = join(this.installDir, name);
    const staging = join(this.installDir, `.${name}.installing`);
    rmSync(staging, { recursive: true, force: true });
    for (const [path, bytes] of files) {
      const target = join(staging, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    rmSync(dest, { recursive: true, force: true });
    renameSync(staging, dest);
    return {
      name,
      version: skill.version,
      dir: dest,
      files: [...files.keys()],
      instructions: new TextDecoder().decode(files.get("SKILL.md")),
    };
  }

  installed(): string[] {
    if (!existsSync(this.installDir)) return [];
    return readdirSync(this.installDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(this.installDir, d.name, "SKILL.md")))
      .map((d) => d.name)
      .sort();
  }

  async manifest(name: string): Promise<SkillManifest | null> {
    if (!new RegExp(NAME).test(name))
      throw new RepoError("bad_request", `bad skill name "${name}"`);
    const dir = join(this.installDir, name);
    if (!existsSync(join(dir, "SKILL.md"))) {
      throw new RepoError("not_found", `skill ${name} is not installed; use skill_install first`);
    }
    const file = join(dir, "skill.json");
    if (!existsSync(file)) return null;
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (
      !Value.Check(SkillManifest, parsed) ||
      !isSafePath(parsed.connector?.dir ?? "x") ||
      !(parsed.pages ?? []).every((page) => isSafePath(page.dir))
    ) {
      throw new RepoError("bad_request", `skill ${name} has an invalid skill.json`);
    }
    return parsed;
  }

  /** Page ids an installed skill offers. */
  async pages(name: string): Promise<string[]> {
    return ((await this.manifest(name))?.pages ?? []).map((page) => page.id);
  }

  /** Copies one of an installed skill's pages into the workspace as pages/<id>/. */
  async scaffoldPage(
    name: string,
    page: string,
    id = page,
  ): Promise<{ id: string; path: string; files: string[] }> {
    const entry = (await this.manifest(name))?.pages?.find((p) => p.id === page);
    if (!entry) throw new RepoError("not_found", `skill ${name} has no page "${page}"`);
    return scaffoldPage(this.workspace, join(this.installDir, name, entry.dir), id);
  }
}
