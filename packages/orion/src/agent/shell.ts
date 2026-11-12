import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import {
  createBashToolDefinition,
  createPowerShellToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type TObject, Type } from "typebox";

const COMMAND_DESCRIPTION = Type.Optional(
  Type.String({
    description:
      'A few plain words for the farmer on what this does, in their language, e.g. "Checking that git is installed". The chat shows this instead of the command, so no commands, paths or code.',
  }),
);

/** Pi's shell tool with a plain-words `description` the chat shows in place of the raw command. */
function withDescription(tool: ToolDefinition): ToolDefinition {
  const params = tool.parameters as unknown as TObject;
  return {
    ...tool,
    parameters: Type.Object({ ...params.properties, description: COMMAND_DESCRIPTION }),
  } as ToolDefinition;
}

/** Replaces Pi's built-in bash/powershell (same names) with copies that also take a description. */
export function shellTools(
  cwd: string,
  shellPath: string | undefined,
  platform: string = process.platform,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  if (platform !== "win32" || shellPath) {
    tools.push(withDescription(createBashToolDefinition(cwd, { shellPath }) as ToolDefinition));
  }
  if (platform === "win32") {
    tools.push(withDescription(createPowerShellToolDefinition(cwd) as ToolDefinition));
  }
  return tools;
}

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
