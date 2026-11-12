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

/** How many times one request may get the same result from the same command before it is refused. */
export const SAME_RESULT_LIMIT = 3;

/**
 * Remembers, per request, what each shell command returned. A command is refused only after it gave
 * the same result SAME_RESULT_LIMIT times, so reruns that can show something new (tests after an
 * edit, a build that now passes) always run. The hub resets it when a new request starts.
 */
export class RepeatGuard {
  private runs = new Map<string, { outcome: string; count: number }>();

  reset(): void {
    this.runs.clear();
  }

  wrap(tool: ToolDefinition): ToolDefinition {
    const runs = this.runs;
    return {
      ...tool,
      async execute(toolCallId, params, ...rest) {
        const { description: _description, ...call } = params as Record<string, unknown>;
        const key = `${tool.name}\n${JSON.stringify(call)}`;
        const seen = runs.get(key);
        if (seen && seen.count >= SAME_RESULT_LIMIT) {
          throw new Error(
            `Not run: this exact command already gave the same result ${seen.count} times in this request, so running it again will not help. Use that result, try a different approach, or tell the farmer plainly what is blocking you.`,
          );
        }
        let result: Awaited<ReturnType<ToolDefinition["execute"]>> | undefined;
        let failure: unknown;
        let outcome: string;
        try {
          result = await tool.execute(toolCallId, params, ...rest);
          outcome = `ok\n${JSON.stringify(result.content)}`;
        } catch (error) {
          failure = error;
          outcome = `error\n${error instanceof Error ? error.message : String(error)}`;
        }
        const count = seen?.outcome === outcome ? seen.count + 1 : 1;
        runs.set(key, { outcome, count });
        const note =
          count > 1
            ? `[Same command, same result as before (${count} times in this request).${count >= SAME_RESULT_LIMIT ? " It will not run again in this request." : ""}]`
            : "";
        if (failure !== undefined) {
          if (note && failure instanceof Error) failure.message += `\n\n${note}`;
          throw failure;
        }
        if (!result) throw new Error("the shell tool returned nothing");
        return note
          ? { ...result, content: [...result.content, { type: "text", text: note }] }
          : result;
      },
    } as ToolDefinition;
  }
}

/** Replaces Pi's built-in bash/powershell (same names) with copies that also take a description. */
export function shellTools(
  cwd: string,
  shellPath: string | undefined,
  platform: string = process.platform,
  repeats: RepeatGuard = new RepeatGuard(),
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  if (platform !== "win32" || shellPath) {
    tools.push(withDescription(createBashToolDefinition(cwd, { shellPath }) as ToolDefinition));
  }
  if (platform === "win32") {
    tools.push(withDescription(createPowerShellToolDefinition(cwd) as ToolDefinition));
  }
  return tools.map((tool) => repeats.wrap(tool));
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
