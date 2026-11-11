// Builds the updater feed (latest.json) for one release from the .sig files next to its
// installers. The platform builds run in parallel, so letting each of them rewrite the feed
// loses entries; the publish job runs this once instead.
// Usage: bun scripts/release-latest-json.ts <dir with *.sig> <tag> <owner/repo>
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Installer file name suffix -> updater platform keys that install from it. */
const TARGETS: ReadonlyArray<readonly [suffix: string, keys: readonly string[]]> = [
  ["_aarch64.app.tar.gz", ["darwin-aarch64", "darwin-aarch64-app"]],
  ["_x64.app.tar.gz", ["darwin-x86_64", "darwin-x86_64-app"]],
  ["_amd64.AppImage", ["linux-x86_64", "linux-x86_64-appimage"]],
  ["_amd64.deb", ["linux-x86_64-deb"]],
  ["_aarch64.AppImage", ["linux-aarch64", "linux-aarch64-appimage"]],
  ["_arm64.deb", ["linux-aarch64-deb"]],
  ["_x64_en-US.msi", ["windows-x86_64", "windows-x86_64-msi"]],
  ["_x64-setup.exe", ["windows-x86_64-nsis"]],
];

export function buildLatestJson(
  signatures: ReadonlyMap<string, string>,
  tag: string,
  repo: string,
  now = new Date(),
) {
  const platforms: Record<string, { signature: string; url: string }> = {};
  for (const [file, signature] of signatures) {
    const keys = TARGETS.find(([suffix]) => file.endsWith(suffix))?.[1];
    if (!keys) continue;
    const url = `https://github.com/${repo}/releases/download/${tag}/${file}`;
    for (const key of keys) platforms[key] = { signature, url };
  }
  return {
    version: tag.replace(/^v/, ""),
    notes: `Orbit ${tag}`,
    pub_date: now.toISOString(),
    platforms,
  };
}

if (import.meta.main) {
  const [dir, tag, repo] = process.argv.slice(2);
  if (!dir || !tag || !repo) {
    console.error("usage: bun scripts/release-latest-json.ts <dir> <tag> <owner/repo>");
    process.exit(2);
  }
  const signatures = new Map(
    readdirSync(dir)
      .filter((name) => name.endsWith(".sig"))
      .sort()
      .map((name) => [name.slice(0, -".sig".length), readFileSync(join(dir, name), "utf8").trim()]),
  );
  const feed = buildLatestJson(signatures, tag, repo);
  if (Object.keys(feed.platforms).length === 0) {
    console.error(`no signed installers found in ${dir}`);
    process.exit(1);
  }
  writeFileSync(join(dir, "latest.json"), `${JSON.stringify(feed, null, 2)}\n`);
  console.log(`latest.json: ${Object.keys(feed.platforms).sort().join(", ")}`);
}
