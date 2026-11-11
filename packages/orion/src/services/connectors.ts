import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AnimalInput } from "@orbit/protocol";
import type { Connector } from "@orbit/schema";
import {
  ANIMAL_SEX,
  ANIMAL_STATUS,
  type ConnectorKind,
  type ConnectorVendor,
  OBSERVATION_KINDS,
  type ObservationKind,
  SPECIES,
} from "@orbit/schema/enums";
import { RepoError, type Repository, type WriteOrigin } from "../db/repo";
import type { SecretStore } from "../secrets";

const BUILTIN_CONNECTOR = `// Orbit connector. Orion calls sync() once per "connector_run".
// Return the observations to import; Orbit stores them with source "connector:<id>".
// Optionally return animals to create or update, and state that comes back as ctx.state next run.
// Keep secrets out of this file: ctx.secret holds the one stored in the keychain.
export default async function sync(ctx) {
  ctx.log(\`syncing \${ctx.connector.name}\`);
  // Example: fetch from a local device and map its readings.
  // const res = await fetch(\`http://\${ctx.config.host}/api/readings\`);
  return { observations: [] };
}
`;

const BUILTIN_README = (name: string) => `# ${name}

An Orbit connector created by Orion. It starts switched off.

- \`connector.ts\` exports \`default async function sync(ctx)\`.
- \`ctx\` has \`config\` (non-secret settings), \`secret\` (from the keychain, or null), \`state\` (what
  the last successful run returned, or null), \`farmId\`, \`connector\` and \`log(message)\`.
- Return \`{ observations: [{ animalId?, nationalId?, earTag?, deviceId?, kind, ts, valueNum?, valueJson? }] }\`.
  \`kind\` is one of: ${OBSERVATION_KINDS.join(", ")}.
- Optionally also return \`animals: [{ species, nationalId?, earTagNumber?, name?, sex?, birthDate?,
  groupName?, status? }]\` (matched by national id, then ear tag) and \`state\` (any JSON).
`;

const ENTRY_CANDIDATES = ["connector.ts", "index.ts", "src/index.ts", "connector.js", "index.js"];

export interface SyncObservation {
  animalId?: string | null;
  nationalId?: string | null;
  earTag?: string | null;
  deviceId?: string | null;
  kind: ObservationKind;
  ts: string;
  valueNum?: number | null;
  valueJson?: Record<string, unknown> | null;
}

export interface SyncResult {
  animals?: unknown[];
  observations?: SyncObservation[];
  state?: unknown;
}

export interface RunResult {
  connectorId: string;
  imported: number;
  skipped: number;
  animalsCreated: number;
  animalsUpdated: number;
  logs: string[];
}

/** A connector folder shipped by an installed skill, copied by scaffold instead of the template. */
export interface ConnectorSource {
  dir: string;
  vendor: ConnectorVendor;
  kind: ConnectorKind;
  config?: Record<string, unknown>;
}

const optText = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === "string" && v.trim() ? v.trim() : undefined;

/** Keeps the AnimalInput fields a connector may set; returns null when the row is unusable. */
function toAnimalInput(raw: unknown): Omit<AnimalInput, "id"> | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  if (!(SPECIES as readonly unknown[]).includes(a.species)) return null;
  const nationalId = optText(a.nationalId);
  const earTagNumber = optText(a.earTagNumber);
  if (!nationalId && !earTagNumber) return null;
  return {
    species: a.species as AnimalInput["species"],
    nationalId,
    earTagNumber,
    name: optText(a.name),
    breed: optText(a.breed),
    birthDate: optText(a.birthDate),
    groupName: optText(a.groupName),
    sex: (ANIMAL_SEX as readonly unknown[]).includes(a.sex)
      ? (a.sex as AnimalInput["sex"])
      : undefined,
    status: (ANIMAL_STATUS as readonly unknown[]).includes(a.status)
      ? (a.status as AnimalInput["status"])
      : undefined,
  };
}

export class ConnectorService {
  constructor(
    private readonly repo: Repository,
    private readonly secrets: SecretStore,
    private readonly workspace: string,
    private readonly templateDir: string | null = null,
  ) {}

  scaffold(
    name: string,
    origin: Partial<WriteOrigin>,
    source: ConnectorSource | null = null,
  ): { id: string; path: string; usedTemplate: boolean; files: string[] } {
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(name)) {
      throw new RepoError(
        "bad_request",
        "connector name must be lowercase letters, digits, - or _ (max 48 characters)",
      );
    }
    const rel = `connectors/${name}`;
    const dest = join(this.workspace, rel);
    if (existsSync(dest))
      throw new RepoError("conflict", `a connector folder ${rel} already exists`);
    const templateDir = source?.dir ?? this.templateDir;
    const usedTemplate = templateDir !== null && existsSync(templateDir);
    if (source && !usedTemplate) {
      throw new RepoError("not_found", `the skill's connector folder ${source.dir} is missing`);
    }
    if (templateDir && usedTemplate) {
      cpSync(templateDir, dest, {
        recursive: true,
        filter: (src) => !src.includes("node_modules"),
      });
    } else {
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "connector.ts"), BUILTIN_CONNECTOR);
      writeFileSync(join(dest, "README.md"), BUILTIN_README(name));
    }
    const entry = ENTRY_CANDIDATES.find((f) => existsSync(join(dest, f))) ?? "connector.ts";
    const result = this.repo.upsertConnector(
      {
        vendor: source?.vendor ?? "custom",
        kind: source?.kind ?? "custom",
        name,
        enabled: false,
        config: { ...source?.config, path: rel, entry },
      },
      { description: `Created connector ${name}`, ...origin },
    );
    return {
      id: result.ids[0] as string,
      path: rel,
      usedTemplate,
      files: ENTRY_CANDIDATES.filter((f) => existsSync(join(dest, f))),
    };
  }

  /**
   * Installs a connector folder's npm dependencies with Orion's own Bun: a compiled Orion acts as
   * plain bun with BUN_BE_BUN=1, so farms need no separate toolchain.
   */
  async installDependencies(rel: string): Promise<{ ok: boolean; output: string }> {
    const dir = resolve(this.workspace, rel);
    if (!existsSync(join(dir, "package.json"))) return { ok: true, output: "" };
    const proc = Bun.spawn([process.execPath, "install", "--production"], {
      cwd: dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BUN_BE_BUN: "1", NO_COLOR: "1" },
      timeout: 300_000,
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { ok: code === 0, output: `${out}${err}`.trim().split("\n").slice(-15).join("\n") };
  }

  async run(id: string): Promise<RunResult> {
    const connector = this.repo.getConnector(id);
    if (!connector.enabled) {
      throw new RepoError(
        "conflict",
        `connector "${connector.name ?? connector.vendor}" is switched off; turn it on in Connections first`,
      );
    }
    const logs: string[] = [];
    try {
      const result = await this.invoke(connector, logs);
      const animals = (result.animals ?? []).map(toAnimalInput);
      const valid = animals.filter((a) => a !== null);
      const herd =
        valid.length > 0 ? this.repo.importConnectorAnimals(valid) : { created: 0, updated: 0 };
      const { rows, skipped } = this.toRows(connector, result.observations ?? []);
      const ids = rows.length > 0 ? this.repo.insertObservations(rows) : [];
      if (result.state !== undefined) this.repo.setConnectorState(id, result.state);
      this.repo.recordConnectorSync(id, null);
      return {
        connectorId: id,
        imported: ids.length,
        skipped: skipped + (animals.length - valid.length),
        animalsCreated: herd.created,
        animalsUpdated: herd.updated,
        logs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.repo.recordConnectorSync(id, message);
      throw error;
    }
  }

  private async invoke(connector: Connector, logs: string[]): Promise<SyncResult> {
    const { credentialRef, ...config } = connector.config as Record<string, unknown>;
    const secret = typeof credentialRef === "string" ? await this.secrets.get(credentialRef) : null;
    const ctx = {
      connector: {
        id: connector.id,
        name: connector.name,
        vendor: connector.vendor,
        kind: connector.kind,
      },
      config,
      secret,
      state: this.repo.getConnectorState(connector.id),
      farmId: connector.farmId,
      log: (message: string) => logs.push(String(message)),
    };
    const path = typeof config.path === "string" ? config.path : null;
    if (path) {
      const dir = resolve(this.workspace, path);
      const entry =
        (typeof config.entry === "string" ? config.entry : null) ??
        ENTRY_CANDIDATES.find((f) => existsSync(join(dir, f)));
      if (!entry || !existsSync(join(dir, entry))) {
        throw new RepoError("not_found", `connector code not found in ${path}`);
      }
      const mod = (await import(`${join(dir, entry)}?v=${Date.now()}`)) as Record<string, unknown>;
      const fn = (mod.default ?? mod.sync) as ((c: typeof ctx) => Promise<unknown>) | undefined;
      if (typeof fn !== "function") {
        throw new RepoError(
          "bad_request",
          `${path}/${entry} must export a default sync(ctx) function`,
        );
      }
      return ((await fn(ctx)) ?? {}) as SyncResult;
    }
    const pkg = "@orbit/connectors";
    let builtin: Record<string, unknown> | null = null;
    try {
      builtin = (await import(pkg)) as Record<string, unknown>;
    } catch {
      builtin = null;
    }
    const runConnector = builtin?.runConnector as
      | ((c: Connector, context: typeof ctx) => Promise<{ observations?: SyncObservation[] }>)
      | undefined;
    if (!runConnector) {
      throw new RepoError(
        "not_ready",
        `the ${connector.vendor} connector has no runnable code in this Orbit build yet`,
      );
    }
    return runConnector(connector, ctx);
  }

  private toRows(connector: Connector, items: SyncObservation[]) {
    let skipped = 0;
    const rows = [];
    for (const o of items) {
      if (!OBSERVATION_KINDS.includes(o.kind) || typeof o.ts !== "string") {
        skipped++;
        continue;
      }
      const animalId =
        o.animalId ??
        (o.nationalId ? this.repo.matchAnimal(o.nationalId, null)?.id : undefined) ??
        (o.earTag ? (this.repo.findAnimal(o.earTag)?.id ?? null) : null);
      rows.push({
        animalId,
        deviceId: o.deviceId ?? null,
        kind: o.kind,
        ts: new Date(o.ts).toISOString(),
        valueNum: o.valueNum ?? null,
        valueJson: (o.valueJson ?? null) as Record<string, unknown> | null,
        source: `connector:${connector.id}`,
      });
    }
    return { rows, skipped };
  }
}
