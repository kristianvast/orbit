import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/** Windows has no bash or git of its own, so the installer ships MinGit next to the Orion sidecar. */
export function bundledShell(
  execPath = process.execPath,
  platform: string = process.platform,
): { shellPath: string; pathDirs: string[] } | null {
  if (platform !== "win32") return null;
  const root = join(dirname(execPath), "mingit");
  const shellPath = join(root, "usr", "bin", "sh.exe");
  if (!existsSync(shellPath)) return null;
  return {
    shellPath,
    pathDirs: [join(root, "cmd"), join(root, "usr", "bin"), join(root, "ucrt64", "bin")],
  };
}

/** Puts the bundled git and core tools on PATH and returns the shell Pi should run commands with. */
export function useBundledShell(): string | undefined {
  const found = bundledShell();
  if (!found) return undefined;
  const have = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  process.env.PATH = [...found.pathDirs.filter((d) => !have.includes(d)), ...have].join(delimiter);
  return found.shellPath;
}
