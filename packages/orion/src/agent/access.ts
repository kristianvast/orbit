// The farmer's yes before Orion first runs commands, first uses the browser and first operates the
// screen: one question per tool, each asked on that tool's first use. A yes is kept in settings;
// a no lasts for the rest of the request.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AccessTool, EventBody } from "@orbit/protocol";
import type { SettingsStore } from "../settings";
import type { Emit } from "./hub";

/** Orion's tool names and the access each one needs. */
export const ACCESS_TOOLS: Readonly<Record<string, AccessTool>> = {
  bash: "shell",
  powershell: "shell",
  // These run code Orion wrote (connector code, install scripts, its own edited build), so they
  // are commands too and wait for the same yes.
  connector_run: "shell",
  connector_scaffold: "shell",
  local_ui_build: "shell",
  orbit_update: "shell",
  browser: "browser",
  computer: "computer",
};

const WHAT: Record<AccessTool, string> = {
  shell: "run commands",
  browser: "use the web browser",
  computer: "operate the screen, mouse and keyboard",
};

export class AccessDenied extends Error {
  constructor(tool: AccessTool) {
    super(
      `Not run: the farmer has not given Orion access to ${WHAT[tool]} on this computer. Do not try again in this request or work around it with other tools. Finish what you can without it, and tell the farmer in one friendly line that you can do more if they allow it (in Settings, or when you ask next time).`,
    );
  }
}

interface Ask {
  body: EventBody<"access.request">;
  waiters: number;
  done: Promise<boolean>;
  settle: (allow: boolean) => void;
}

export class AccessGate {
  private asks = new Map<AccessTool, Ask>();
  private declined = new Set<string>();

  constructor(
    private readonly settings: SettingsStore,
    private readonly emit: Emit,
  ) {}

  /** Resolves once this tool is allowed; throws AccessDenied on a no or when the wait is aborted. */
  async ensure(tool: AccessTool, sessionId: string, signal?: AbortSignal): Promise<void> {
    if (this.settings.get().toolAccess[tool]) return;
    const declineKey = `${sessionId}\n${tool}`;
    if (this.declined.has(declineKey)) throw new AccessDenied(tool);
    signal?.throwIfAborted();
    const ask = this.asks.get(tool) ?? this.open(tool, sessionId);
    ask.waiters++;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal?.reason ?? new Error("aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const allow = await Promise.race([ask.done, aborted]);
      if (!allow) {
        this.declined.add(declineKey);
        throw new AccessDenied(tool);
      }
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      ask.waiters--;
      // Nobody waits for the answer any more (every run stopped): drop the question.
      if (ask.waiters === 0 && this.asks.get(tool) === ask) this.close(tool, false);
    }
  }

  /** The farmer answered. False when the question is no longer open. */
  respond(requestId: string, allow: boolean): boolean {
    const tool = [...this.asks].find(([, ask]) => ask.body.requestId === requestId)?.[0];
    if (!tool) return false;
    if (allow) {
      const s = this.settings.get();
      this.settings.update({
        toolAccess: { ...s.toolAccess, [tool]: true },
        toolAccessAccepted: { ...s.toolAccessAccepted, [tool]: true },
      });
    }
    this.close(tool, allow);
    return true;
  }

  /** Answers the open question for a tool the farmer just allowed in Settings. */
  allowed(tool: AccessTool): void {
    const ask = this.asks.get(tool);
    if (ask) this.respond(ask.body.requestId, true);
  }

  /** The open questions, for a client that connects while Orion waits. */
  pending(): EventBody<"access.request">[] {
    return [...this.asks.values()].map((ask) => ({ ...ask.body }));
  }

  /** A new request from the farmer may be asked again after a no. */
  forgetDeclines(sessionId: string): void {
    for (const key of this.declined)
      if (key.startsWith(`${sessionId}\n`)) this.declined.delete(key);
  }

  /** Wraps the tools that need access; every other tool is returned as it is. */
  wrap(tool: ToolDefinition, sessionId: string): ToolDefinition {
    const kind = ACCESS_TOOLS[tool.name];
    if (!kind) return tool;
    const gate = this;
    return {
      ...tool,
      async execute(toolCallId, params, signal, ...rest) {
        await gate.ensure(kind, sessionId, signal);
        return tool.execute(toolCallId, params, signal, ...rest);
      },
    } as ToolDefinition;
  }

  private open(tool: AccessTool, sessionId: string): Ask {
    let settle: (allow: boolean) => void = () => {};
    const done = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    const ask: Ask = {
      body: { sessionId, requestId: `access_${crypto.randomUUID()}`, tool },
      waiters: 0,
      done,
      settle,
    };
    this.asks.set(tool, ask);
    this.emit("access.request", ask.body);
    return ask;
  }

  private close(tool: AccessTool, allow: boolean): void {
    const ask = this.asks.get(tool);
    if (!ask) return;
    this.asks.delete(tool);
    ask.settle(allow);
    this.emit("access.resolved", { requestId: ask.body.requestId, allow });
  }
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

/** Whether a file tool's path (relative, absolute, ~ or @-prefixed, as Pi accepts) is that file. */
export function isSameFile(cwd: string, raw: string, file: string): boolean {
  const bare = raw.startsWith("@") ? raw.slice(1) : raw;
  const expanded = bare === "~" || bare.startsWith("~/") ? join(homedir(), bare.slice(1)) : bare;
  const a = realPath(resolve(cwd, expanded));
  const b = realPath(file);
  return process.platform === "linux" ? a === b : a.toLowerCase() === b.toLowerCase();
}

/**
 * Pi's write and edit, refusing Orbit's settings file: it holds the farmer's switches for what
 * Orion may use, so Orion must not be able to turn them on by editing it.
 */
export function protectedFileTools(cwd: string, settingsFile: string): ToolDefinition[] {
  return [createWriteToolDefinition(cwd), createEditToolDefinition(cwd)].map((tool) => {
    const base = tool as unknown as ToolDefinition;
    return {
      ...base,
      async execute(toolCallId, params, ...rest) {
        const path = (params as { path?: unknown }).path;
        if (typeof path === "string" && isSameFile(cwd, path, settingsFile)) {
          throw new Error(
            "Not changed: this is Orbit's own settings file. It holds the farmer's choices, including what Orion may use, and only the farmer changes it in Orbit's Settings. Do not try again or work around it.",
          );
        }
        return base.execute(toolCallId, params, ...rest);
      },
    } as ToolDefinition;
  });
}
