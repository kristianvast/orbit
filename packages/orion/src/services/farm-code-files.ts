import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  FARM_CODE_MAX_BYTES,
  FARM_CODE_MAX_FILE_BYTES,
  FARM_CODE_MAX_FILES,
  type FarmCodeBlobs,
  farmCodePath,
  farmCodeSecret,
} from "@orbit/protocol";
import { RepoError } from "../db/repo";

export const codeHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const codeEqual = isDeepStrictEqual;

/** Only regular files are shared; never follow a symlink out of either checkout. */
export function collectCode(dir: string) {
  const files: Record<string, string> = {};
  const blobs: FarmCodeBlobs = {};
  let bytes = 0;
  const walk = (prefix: string) => {
    if (!existsSync(join(dir, prefix))) return;
    for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!farmCodePath(path)) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const raw = readFileSync(join(dir, path));
        if (farmCodeSecret(raw.toString("utf8"))) continue;
        bytes += raw.length;
        if (
          raw.length > FARM_CODE_MAX_FILE_BYTES ||
          bytes > FARM_CODE_MAX_BYTES ||
          Object.keys(files).length >= FARM_CODE_MAX_FILES
        )
          throw new RepoError(
            "rule_violation",
            "Farm code exceeds the synchronization size limits.",
          );
        const hash = codeHash(raw);
        files[path] = hash;
        blobs[hash] = raw.toString("base64");
      }
    }
  };
  walk("");
  return { files, blobs };
}

/** Refuse symlinks at every ancestor as well as at the file itself. */
export function writeCode(dir: string, path: string, bytes: Uint8Array | null): void {
  if (!farmCodePath(path)) throw new RepoError("rule_violation", `Unsafe farm code path: ${path}`);
  let current = dir;
  for (const part of path.split("/")) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink())
      throw new RepoError("conflict", `Farm code would overwrite a symlink: ${path}`);
  }
  const file = join(dir, path);
  if (bytes === null) {
    if (existsSync(file)) unlinkSync(file);
  } else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
}

export function mergeCodeFiles<T>(
  base: Record<string, T>,
  local: Record<string, T>,
  remote: Record<string, T>,
  conflict: (path: string) => void,
): Record<string, T> {
  const merged: Record<string, T> = {};
  for (const path of [
    ...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]),
  ].sort()) {
    const a = local[path],
      b = remote[path],
      ancestor = base[path];
    if (!codeEqual(a, b) && !codeEqual(a, ancestor) && !codeEqual(b, ancestor)) conflict(path);
    const value = codeEqual(a, ancestor) ? b : a;
    if (value !== undefined) merged[path] = value;
  }
  return merged;
}
