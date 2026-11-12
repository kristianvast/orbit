// The farmer's one-time yes before Orion first runs commands, uses the browser or operates the
// screen. One question covers all three; the yes is kept in settings, a no lasts for the request.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AccessTool, EventBody } from "@orbit/protocol";
import type { SettingsStore } from "../settings";
import type { Emit } from "./hub";

/** Orion's tool names and the access each one needs. */
export const ACCESS_TOOLS: Readonly<Record<string, AccessTool>> = {
  bash: "shell",
  powershell: "shell",
  browser: "browser",
  computer: "computer",
};

export class AccessDenied extends Error {
  constructor() {
    super(
      "Not run: the farmer has not given Orion access to run commands, use the browser or operate the screen on this computer. Do not try again in this request or work around it with other tools. Finish what you can without it, and tell the farmer in one friendly line that you can do more if they allow it (in Settings, or when you ask next time).",
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
  private ask: Ask | null = null;
  private declined = new Set<string>();

  constructor(
    private readonly settings: SettingsStore,
    private readonly emit: Emit,
  ) {}

  /** Resolves once access is granted; throws AccessDenied on a no or when the wait is aborted. */
  async ensure(tool: AccessTool, sessionId: string, signal?: AbortSignal): Promise<void> {
    if (this.settings.get().computerAccess) return;
    if (this.declined.has(sessionId)) throw new AccessDenied();
    signal?.throwIfAborted();
    const ask = this.ask ?? this.open(tool, sessionId);
    ask.waiters++;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal?.reason ?? new Error("aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const allow = await Promise.race([ask.done, aborted]);
      if (!allow) {
        this.declined.add(sessionId);
        throw new AccessDenied();
      }
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      ask.waiters--;
      // Nobody waits for the answer any more (every run stopped): drop the question.
      if (ask.waiters === 0 && this.ask === ask) this.close(false);
    }
  }

  /** The farmer answered. False when the question is no longer open. */
  respond(requestId: string, allow: boolean): boolean {
    if (this.ask?.body.requestId !== requestId) return false;
    if (allow) this.settings.update({ computerAccess: true });
    this.close(allow);
    return true;
  }

  /** The open question, for a client that connects while Orion waits. */
  pending(): EventBody<"access.request"> | null {
    return this.ask ? { ...this.ask.body } : null;
  }

  /** A new request from the farmer may be asked again after a no. */
  forgetDecline(sessionId: string): void {
    this.declined.delete(sessionId);
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
    this.ask = ask;
    this.emit("access.request", ask.body);
    return ask;
  }

  private close(allow: boolean): void {
    const ask = this.ask;
    if (!ask) return;
    this.ask = null;
    ask.settle(allow);
    this.emit("access.resolved", { requestId: ask.body.requestId, allow });
  }
}
