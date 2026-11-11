// Built-in Orbit modules (herd, devices, cameras). Orbit starts minimal: a module switches on when
// Orion enables it, the farmer enables it in Settings, or its data first appears. State lives in
// <data-dir>/modules.json.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MODULE_IDS,
  type ModuleEnabledBy,
  type ModuleId,
  type ModulesState,
  type OrbitModule,
} from "@orbit/protocol";
import type { LocalDb } from "@orbit/schema/local";

export const MODULES_FILE = "modules.json";

/** The table whose first live row switches each module on. */
export const MODULE_TABLES: Record<ModuleId, string> = {
  herd: "animals",
  devices: "devices",
  cameras: "cameras",
};

export type HasLiveRows = (table: string) => boolean;

/** Live-row check over Orion's SQLite; only the fixed MODULE_TABLES names are queried. */
export function liveRowsIn(db: LocalDb): HasLiveRows {
  const tables = new Set(Object.values(MODULE_TABLES));
  return (table) => {
    if (!tables.has(table)) return false;
    return (
      db.$client.query(`SELECT 1 FROM "${table}" WHERE deleted_at IS NULL LIMIT 1`).get() !== null
    );
  };
}

const off = (id: ModuleId): OrbitModule => ({
  id,
  enabled: false,
  enabledAt: null,
  enabledBy: null,
});

export function isModuleId(value: unknown): value is ModuleId {
  return typeof value === "string" && (MODULE_IDS as readonly string[]).includes(value);
}

export class ModulesStore {
  private readonly file: string;
  private modules: Map<ModuleId, OrbitModule>;

  constructor(
    dataDir: string,
    private readonly hasLiveRows: HasLiveRows,
    private readonly onChange: (state: ModulesState) => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = join(dataDir, MODULES_FILE);
    const saved = this.read();
    if (saved) {
      this.modules = saved;
    } else {
      // First start with this data dir: farms that already have data keep their screens.
      this.modules = new Map(
        MODULE_IDS.map((id) => [
          id,
          this.hasLiveRows(MODULE_TABLES[id]) ? this.on(id, "auto") : off(id),
        ]),
      );
      this.write();
    }
  }

  list(): ModulesState {
    return { modules: MODULE_IDS.map((id) => ({ ...(this.modules.get(id) ?? off(id)) })) };
  }

  enabled(id: ModuleId): boolean {
    return this.modules.get(id)?.enabled === true;
  }

  /** Switches a module on; a no-op (no event) when it already is. */
  enable(id: ModuleId, by: Exclude<ModuleEnabledBy, null>): ModulesState {
    if (this.enabled(id)) return this.list();
    this.modules.set(id, this.on(id, by));
    return this.commit();
  }

  /** Switches a module off; its data stays. A no-op (no event) when it already is off. */
  disable(id: ModuleId): ModulesState {
    if (!this.enabled(id)) return this.list();
    this.modules.set(id, off(id));
    return this.commit();
  }

  /** Called on db changes: enables (never disables) the module owning `table` once it has live rows. */
  noticeChange(table: string): void {
    const id = MODULE_IDS.find((m) => MODULE_TABLES[m] === table);
    if (!id || this.enabled(id) || !this.hasLiveRows(table)) return;
    this.enable(id, "auto");
  }

  private on(id: ModuleId, by: Exclude<ModuleEnabledBy, null>): OrbitModule {
    return { id, enabled: true, enabledAt: this.now().toISOString(), enabledBy: by };
  }

  private commit(): ModulesState {
    this.write();
    const state = this.list();
    this.onChange(state);
    return state;
  }

  private read(): Map<ModuleId, OrbitModule> | null {
    if (!existsSync(this.file)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (error) {
      process.stderr.write(
        `orion: ${this.file} is not valid JSON (${error instanceof Error ? error.message : String(error)}); rebuilding it\n`,
      );
      return null;
    }
    const saved = (parsed as { modules?: unknown }).modules;
    const map = new Map<ModuleId, OrbitModule>(MODULE_IDS.map((id) => [id, off(id)]));
    if (!Array.isArray(saved)) return map;
    for (const raw of saved as Array<Partial<OrbitModule>>) {
      if (!isModuleId(raw?.id) || raw.enabled !== true) continue;
      const by = raw.enabledBy;
      map.set(raw.id, {
        id: raw.id,
        enabled: true,
        enabledAt: typeof raw.enabledAt === "string" ? raw.enabledAt : null,
        enabledBy: by === "orion" || by === "user" || by === "auto" ? by : null,
      });
    }
    return map;
  }

  private write() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.list(), null, 2)}\n`);
    renameSync(tmp, this.file);
  }
}

/** Human-readable module states for the agent. */
export function describeModules(state: ModulesState): string {
  return state.modules
    .map(
      (m) =>
        `- ${m.id}: ${m.enabled ? `on (enabled by ${m.enabledBy ?? "unknown"}${m.enabledAt ? ` at ${m.enabledAt}` : ""})` : "off"}`,
    )
    .join("\n");
}
