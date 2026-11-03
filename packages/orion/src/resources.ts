// Orion's own resources, embedded into the module graph so `bun build --compile` bundles them.
// At startup they are written to <data-dir>/resources, because Pi and the connector scaffolder
// read from real directories.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import templateFixture from "../../connectors/template/fixture.csv" with { type: "text" };
import templateIndex from "../../connectors/template/index.ts" with { type: "text" };
import templateReadme from "../../connectors/template/README.md" with { type: "text" };
import agentsMd from "../resources/AGENTS.md" with { type: "text" };
import buildingFeaturesSkill from "../resources/skills/building-features/SKILL.md" with {
  type: "text",
};
import camerasSkill from "../resources/skills/cameras/SKILL.md" with { type: "text" };
import connectorsSkill from "../resources/skills/connectors/SKILL.md" with { type: "text" };
import herdDataSkill from "../resources/skills/herd-data/SKILL.md" with { type: "text" };

// The text loader yields a string, but TypeScript types a .ts import as its module shape.
const asText = (value: unknown): string => value as string;

/** Relative path inside <data-dir>/resources -> file contents. */
export const EMBEDDED_RESOURCES: Readonly<Record<string, string>> = {
  "AGENTS.md": asText(agentsMd),
  "skills/building-features/SKILL.md": asText(buildingFeaturesSkill),
  "skills/cameras/SKILL.md": asText(camerasSkill),
  "skills/connectors/SKILL.md": asText(connectorsSkill),
  "skills/herd-data/SKILL.md": asText(herdDataSkill),
  "connector-template/README.md": asText(templateReadme),
  "connector-template/fixture.csv": asText(templateFixture),
  "connector-template/index.ts": asText(templateIndex),
};

export interface MaterializedResources {
  /** Holds AGENTS.md and skills/ (Pi context file + skill paths). */
  dir: string;
  /** Connector template used by connector_scaffold. */
  connectorTemplateDir: string;
}

/** Rewrites <dataDir>/resources from the embedded copies, so an upgrade replaces stale files. */
export function materializeResources(dataDir: string): MaterializedResources {
  const dir = join(dataDir, "resources");
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(EMBEDDED_RESOURCES)) {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return { dir, connectorTemplateDir: join(dir, "connector-template") };
}
