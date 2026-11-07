// Orion's long-term memory: two markdown files in the farm workspace, one about the farm and one
// about the person using Orbit. Orion writes them without asking; workspace snapshots keep undo.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const MEMORY_SCOPES = ["farm", "user"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

const HEADERS: Record<MemoryScope, string> = {
  farm: "# Farm memory\n\nFacts Orion remembers about this farm: animals, routines, barn layout, devices.\n",
  user: "# User memory\n\nWhat Orion remembers about the person using Orbit: preferences, units, how they like answers.\n",
};

const MAX_FACT_LENGTH = 500;

export function memoryFile(workspaceDir: string, scope: MemoryScope): string {
  return join(workspaceDir, "memory", `${scope}.md`);
}

function load(file: string, scope: MemoryScope): string {
  return existsSync(file) ? readFileSync(file, "utf8") : HEADERS[scope];
}

function factOf(line: string): string | null {
  const m = /^- (?:\[[^\]]*\] )?(.*)$/.exec(line);
  return m ? (m[1] ?? "").trim() : null;
}

/** Appends one fact as a dated bullet; returns false when the same fact is already stored. */
export function rememberFact(workspaceDir: string, scope: MemoryScope, fact: string): boolean {
  const clean = fact.replace(/\s+/g, " ").trim().slice(0, MAX_FACT_LENGTH);
  if (!clean) throw new Error("the fact is empty");
  const file = memoryFile(workspaceDir, scope);
  const content = load(file, scope);
  const exists = content.split("\n").some((l) => factOf(l)?.toLowerCase() === clean.toLowerCase());
  if (exists) return false;
  const date = new Date().toISOString().slice(0, 10);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${content.replace(/\n*$/, "\n")}- [${date}] ${clean}\n`);
  return true;
}

/** Removes every stored fact containing `match` (case-insensitive); returns the removed facts. */
export function forgetFacts(workspaceDir: string, scope: MemoryScope, match: string): string[] {
  const needle = match.trim().toLowerCase();
  const file = memoryFile(workspaceDir, scope);
  if (!needle || !existsSync(file)) return [];
  const removed: string[] = [];
  const kept = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => {
      const fact = factOf(line);
      if (fact === null || !fact.toLowerCase().includes(needle)) return true;
      removed.push(fact);
      return false;
    });
  if (removed.length > 0) writeFileSync(file, kept.join("\n"));
  return removed;
}
