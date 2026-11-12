import { type Static, Type } from "typebox";

const Hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const NullableHash = Type.Union([Hash, Type.Null()]);
export const FarmAppDelta = Type.Object({
  baseCommit: Type.String({ pattern: "^[a-f0-9]{40}$" }),
  files: Type.Record(Type.String(), Type.Object({ base: NullableHash, content: NullableHash })),
});
export type FarmAppDelta = Static<typeof FarmAppDelta>;
export const FarmCodeManifest = Type.Object({
  workspace: Type.Record(Type.String(), Hash),
  app: Type.Union([FarmAppDelta, Type.Null()]),
});
export type FarmCodeManifest = Static<typeof FarmCodeManifest>;
export const FarmCodeHead = Type.Object({
  id: Hash,
  parent: Type.Union([Hash, Type.Null()]),
  manifest: FarmCodeManifest,
});
export type FarmCodeHead = Static<typeof FarmCodeHead>;
export const FarmCodePush = Type.Object({
  parent: Type.Union([Hash, Type.Null()]),
  manifest: FarmCodeManifest,
  blobs: Type.Record(Hash, Type.String()),
});
export type FarmCodePush = Static<typeof FarmCodePush>;
export type FarmCodeBlobs = Record<string, string>;
export const FARM_CODE_MAX_BYTES = 8 * 1024 * 1024;
export const FARM_CODE_MAX_FILE_BYTES = 1024 * 1024;
export const FARM_CODE_MAX_FILES = 2000;

// Shared with share_build: a quoted secret assignment or a known credential format.
export const SECRET_PATTERNS = [
  /\b(pass(word|wd)?|secret|api[_-]?key|token|credential)\w*["']?\s*[:=]\s*["'`][^"'`\s]{6,}["'`]/i,
  /\b(sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{30,})\b/,
];

export function farmCodePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !path.includes("\\") &&
    ![...path].some((char) => char.charCodeAt(0) < 32 || char === ":") &&
    path
      .split("/")
      .every(
        (part) =>
          part.length > 0 &&
          part.length <= 255 &&
          !part.startsWith(".") &&
          !Object.hasOwn(Object.prototype, part) &&
          !["node_modules", "dist", "build", "coverage", "target"].includes(part) &&
          !/^(credentials|auth|secrets?)(\.|$)|\.(pem|key|p12|pfx)$/i.test(part),
      )
  );
}

export function farmCodeSecret(content: string): boolean {
  return (
    content.includes("-----BEGIN ") ||
    content.split("\n").some((line) => SECRET_PATTERNS.some((pattern) => pattern.test(line)))
  );
}

export function farmCodeHashes(manifest: FarmCodeManifest): string[] {
  return [
    ...new Set([
      ...Object.values(manifest.workspace),
      ...Object.values(manifest.app?.files ?? {}).flatMap((file) =>
        [file.base, file.content].filter((hash): hash is string => hash !== null),
      ),
    ]),
  ];
}
