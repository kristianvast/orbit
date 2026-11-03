// Parses every GitHub Actions workflow and checks the basic shape. Usage: bun scripts/check-workflows.ts
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

export function checkWorkflow(source: string): string[] {
  const doc = parse(source, { strict: true, uniqueKeys: true }) as Record<string, unknown> | null;
  const problems: string[] = [];
  if (!doc || typeof doc !== "object") return ["not a YAML mapping"];
  if (!("on" in doc)) problems.push('missing "on"');
  const jobs = doc.jobs as Record<string, { "runs-on"?: unknown; steps?: unknown }> | undefined;
  if (!jobs || Object.keys(jobs).length === 0) problems.push('missing "jobs"');
  for (const [name, job] of Object.entries(jobs ?? {})) {
    if (!job["runs-on"]) problems.push(`job ${name}: missing runs-on`);
    if (!Array.isArray(job.steps)) problems.push(`job ${name}: missing steps`);
  }
  return problems;
}

if (import.meta.main) {
  const dir = resolve(import.meta.dirname, "../../../.github/workflows");
  let failed = false;
  for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    let problems: string[];
    try {
      problems = checkWorkflow(readFileSync(join(dir, file), "utf8"));
    } catch (err) {
      problems = [err instanceof Error ? err.message : String(err)];
    }
    console.log(
      `${problems.length ? "FAIL" : "ok  "} ${file}${problems.length ? `: ${problems.join("; ")}` : ""}`,
    );
    if (problems.length) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
