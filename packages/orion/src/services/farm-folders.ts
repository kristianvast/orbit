// Which farm this PC has open. This PC's own farm lives in the data folder itself (as it always
// has); another cloud farm the person belongs to gets its own folder under farms/<farmId>/ with its
// own database, workspace and chats. farms.json remembers the open one; Orion restarts to switch.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE = "farms.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface FarmFolders {
  /** The cloud farm opened in its own folder; null = this PC's own farm (the data folder). */
  active: string | null;
  /** This PC's own farm, remembered while another farm is open so the picker can go back. */
  root: { id: string; name: string | null } | null;
}

export function readFarmFolders(dataDir: string): FarmFolders {
  const file = join(dataDir, FILE);
  if (!existsSync(file)) return { active: null, root: null };
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<FarmFolders>;
  const active =
    typeof parsed.active === "string" && UUID.test(parsed.active) ? parsed.active : null;
  return { active, root: parsed.root ?? null };
}

export function writeFarmFolders(dataDir: string, folders: FarmFolders): void {
  writeFileSync(join(dataDir, FILE), `${JSON.stringify(folders, null, 2)}\n`);
}

/** The folder holding the open farm's database, workspace, screens and chats. */
export function farmDir(dataDir: string, folders = readFarmFolders(dataDir)): string {
  if (!folders.active) return dataDir;
  const dir = join(dataDir, "farms", folders.active);
  mkdirSync(dir, { recursive: true });
  return dir;
}
