import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Connector } from "@orbit/schema";
import { OBSERVATION_KINDS, type ObservationKind } from "@orbit/schema/enums";
import { RepoError, type Repository, type WriteOrigin } from "../db/repo";
import type { SecretStore } from "../secrets";

const BUILTIN_CONNECTOR = `// Orbit connector. Orion calls sync() once per "connector_run".
// Return the observations to import; Orbit stores them with source "connector:<id>".
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
- \`ctx\` has \`config\` (non-secret settings), \`secret\` (from the keychain, or null), \`farmId\`,
  \`connector\` and \`log(message)\`.
- Return \`{ observations: [{ animalId?, earTag?, deviceId?, kind, ts, valueNum?, valueJson? }] }\`.
  \`kind\` is one of: ${OBSERVATION_KINDS.join(", ")}.
`;

const ENTRY_CANDIDATES = ["connector.ts", "index.ts", "src/index.ts", "connector.js", "index.js"];

export interface SyncObservation {
  animalId?: string | null;
  earTag?: string | null;
  deviceId?: string | null;
  kind: ObservationKind;
  ts: string;
  valueNum?: number | null;
  valueJson?: Record<string, unknown> | null;
}

export interface RunResult {
  connectorId: string;
  imported: number;
  skipped: number;
  logs: string[];
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
    const templateDir = this.templateDir;
    const usedTemplate = templateDir !== null && existsSync(templateDir);
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
      { vendor: "custom", kind: "custom", name, enabled: false, config: { path: rel, entry } },
      { description: `Created connector ${name}`, ...origin },
    );
    return {
      id: result.ids[0] as string,
      path: rel,
      usedTemplate,
      files: ENTRY_CANDIDATES.filter((f) => existsSync(join(dest, f))),
    };
  }

  async run(id: string): Promise<RunResult> {
    const connector = this.repo.getConnector(id);
    if (!connector.enabled) {
      throw new RepoError(
        "conflict",
        `connector "${connector.name ?? connector.vendor}" is switched off; turn it on in Settings > Connectors first`,
      );
    }
    const logs: string[] = [];
    try {
      const result = await this.invoke(connector, logs);
      const { rows, skipped } = this.toRows(connector, result.observations ?? []);
      const ids = rows.length > 0 ? this.repo.insertObservations(rows) : [];
      this.repo.recordConnectorSync(id, null);
      return { connectorId: id, imported: ids.length, skipped, logs };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.repo.recordConnectorSync(id, message);
      throw error;
    }
  }

  private async invoke(
    connector: Connector,
    logs: string[],
  ): Promise<{ observations?: SyncObservation[] }> {
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
      return ((await fn(ctx)) ?? {}) as { observations?: SyncObservation[] };
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
        o.animalId ?? (o.earTag ? (this.repo.findAnimal(o.earTag)?.id ?? null) : null);
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
