// Orbit's approval gate. Pi has no permission system, so every tool call passes through classify()
// and decide() from a Pi `tool_call` hook before it runs.
import { appendFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ApprovalDecision, EventBody, Risk } from "@orbit/protocol";
import type { SettingsStore } from "../settings";

export const DENIED_PREFIX = "Not allowed:";

export interface Classification {
  risk: Risk;
  title: string;
  plainLanguage: string;
  command?: string;
}

const SAFE_FARM_TOOLS = new Set([
  "herd_query",
  "devices_list",
  "observations_query",
  "connectors_list",
]);
const READ_TOOLS = new Set(["read", "ls", "find", "grep"]);

const ASK_TOOL_TEXT: Record<
  string,
  { title: string; plain: (a: Record<string, unknown>) => string }
> = {
  herd_upsert_animal: {
    title: "Change herd records",
    plain: (a) =>
      `Orion wants to ${a.id ? "update" : "add"} the animal ${String(a.name ?? a.earTagNumber ?? a.id ?? "")} in your herd records.`,
  },
  device_bind: {
    title: "Change which sensor an animal wears",
    plain: (a) =>
      a.action === "unbind"
        ? `Orion wants to take device ${String(a.deviceId)} off its animal.`
        : `Orion wants to record that device ${String(a.deviceId)} is worn by animal ${String(a.animalId)}.`,
  },
  connector_scaffold: {
    title: "Create a new connector",
    plain: (a) =>
      `Orion wants to create a connector called "${String(a.name)}" in your farm workspace. It starts switched off.`,
  },
  connector_run: {
    title: "Run a connector",
    plain: (a) =>
      `Orion wants to run connector ${String(a.id)} once. It may contact the device or service it connects to and import data.`,
  },
  camera_discover: {
    title: "Look for cameras on your network",
    plain: () =>
      "Orion wants to send a discovery message on your local network to find ONVIF cameras. Nothing is changed on the cameras.",
  },
  camera_add: {
    title: "Add a camera",
    plain: (a) =>
      `Orion wants to save camera "${String(a.name)}"${a.password ? " and store its password in the system keychain" : ""}.`,
  },
};

const DELETE_RE =
  /(^|[\s;&|(])(rm|rmdir|del|erase|unlink|shred|rd)(\s|$)|git\s+(clean|reset\s+--hard)|Remove-Item/i;
const NETWORK_RE =
  /(^|[\s;&|(])(iptables|ip6tables|nft|ufw|firewall-cmd|pfctl|netsh|networksetup|route|ifconfig|ip\s+(addr|route|link)|New-NetFirewallRule|Set-NetFirewallRule)(\s|$)/i;
const INSTALL_RE =
  /(^|[\s;&|(])((npm|pnpm|yarn|bun)\s+(i|install|add)|pip3?\s+install|brew\s+install|apt(-get)?\s+install|dnf\s+install|yum\s+install|choco\s+install|winget\s+install|cargo\s+install|gem\s+install)(\s|$)|curl[^|]*\|\s*(ba|z)?sh|sudo(\s|$)/i;

export class ApprovalGate {
  private pending = new Map<
    string,
    { resolve: (d: ApprovalDecision, by: "user" | "abort" | "timeout") => void; sessionId: string }
  >();

  constructor(
    private readonly workspace: string,
    private readonly settings: SettingsStore,
    private readonly auditFile: string,
    private readonly emit: <E extends "approval.request" | "approval.resolved">(
      type: E,
      body: EventBody<E>,
    ) => void,
    private readonly timeoutMs = 30 * 60_000,
  ) {}

  inWorkspace(path: string): boolean {
    const abs = isAbsolute(path) ? resolve(path) : resolve(this.workspace, path);
    const rel = relative(this.workspace, abs);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }

  private bashTouchesOutside(command: string): boolean {
    if (/(^|\s)~|\$HOME|%USERPROFILE%|(^|[\s/])\.\.(\/|\\|\s|$)/.test(command)) return true;
    const paths = command.match(/(?:^|[\s='"])(\/[^\s'";|&]*|[A-Za-z]:\\[^\s'";|&]*)/g) ?? [];
    return paths
      .map((p) => p.replace(/^[\s='"]/, ""))
      .filter((p) => p !== "/dev/null")
      .some((p) => !this.inWorkspace(p));
  }

  classify(toolName: string, input: Record<string, unknown>): Classification {
    if (SAFE_FARM_TOOLS.has(toolName)) {
      return { risk: "safe", title: "Read farm data", plainLanguage: "Reads your farm records." };
    }
    if (READ_TOOLS.has(toolName)) {
      const path = String(input.path ?? input.file_path ?? ".");
      if (this.inWorkspace(path)) {
        return {
          risk: "safe",
          title: "Read a file",
          plainLanguage: `Reads ${path} in the farm workspace.`,
        };
      }
      return {
        risk: "always_ask",
        title: "Read a file outside the farm workspace",
        plainLanguage: `Orion wants to read ${path}, which is outside the farm workspace. Only allow this if you know what that file is.`,
      };
    }
    if (toolName === "write" || toolName === "edit") {
      const path = String(input.path ?? input.file_path ?? "");
      if (!this.inWorkspace(path)) {
        return {
          risk: "always_ask",
          title: "Change a file outside the farm workspace",
          plainLanguage: `Orion wants to ${toolName === "write" ? "write" : "edit"} ${path}, which is outside the farm workspace. This could affect other programs on this computer.`,
        };
      }
      return {
        risk: "ask",
        title: toolName === "write" ? "Write a file" : "Edit a file",
        plainLanguage: `Orion wants to ${toolName === "write" ? "create or overwrite" : "change"} ${path} in the farm workspace. You can undo this afterwards.`,
      };
    }
    if (toolName === "bash" || toolName === "powershell") {
      const command = String(input.command ?? "");
      if (DELETE_RE.test(command)) {
        return {
          risk: "always_ask",
          title: "Delete files",
          plainLanguage:
            "Orion wants to run a command that deletes files. Deleted files may not come back.",
          command,
        };
      }
      if (NETWORK_RE.test(command)) {
        return {
          risk: "always_ask",
          title: "Change network or firewall settings",
          plainLanguage:
            "Orion wants to change network or firewall settings on this computer. This can cut off devices such as the milking robot.",
          command,
        };
      }
      if (INSTALL_RE.test(command)) {
        return {
          risk: "always_ask",
          title: "Install software",
          plainLanguage:
            "Orion wants to install software or run a command with administrator rights.",
          command,
        };
      }
      if (this.bashTouchesOutside(command)) {
        return {
          risk: "always_ask",
          title: "Run a command outside the farm workspace",
          plainLanguage: "Orion wants to run a command that reaches outside the farm workspace.",
          command,
        };
      }
      return {
        risk: "ask",
        title: "Run a command",
        plainLanguage: "Orion wants to run a command in the farm workspace on this computer.",
        command,
      };
    }
    const known = ASK_TOOL_TEXT[toolName];
    if (known) return { risk: "ask", title: known.title, plainLanguage: known.plain(input) };
    return {
      risk: "ask",
      title: `Use tool ${toolName}`,
      plainLanguage: `Orion wants to use the tool "${toolName}".`,
    };
  }

  private audit(entry: Record<string, unknown>) {
    appendFileSync(
      this.auditFile,
      `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
    );
  }

  /**
   * Resolves to a block reason, or null to allow. Prompts through approval.request when the tier
   * and mode require it and waits for respond(); an abort signal resolves as deny.
   */
  async decide(input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<string | null> {
    const c = this.classify(input.toolName, input.args);
    const { approvalMode, alwaysAllow } = this.settings.get();
    const base = {
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      risk: c.risk,
      ...(c.command ? { command: c.command } : {}),
    };
    if (c.risk === "safe") {
      this.audit({ ...base, decision: "allow_once", by: "policy", rule: "safe" });
      return null;
    }
    if (approvalMode === "read_only") {
      this.audit({ ...base, decision: "deny", by: "policy", rule: "read_only" });
      return `${DENIED_PREFIX} Orbit is in read-only mode, so ${c.title.toLowerCase()} is switched off.`;
    }
    if (c.risk === "ask" && (approvalMode === "auto" || alwaysAllow.includes(input.toolName))) {
      this.audit({
        ...base,
        decision: "allow_once",
        by: "policy",
        rule: approvalMode === "auto" ? "auto_mode" : "always_allow",
      });
      return null;
    }

    const approvalId = crypto.randomUUID();
    const result = await new Promise<{
      decision: ApprovalDecision;
      by: "user" | "abort" | "timeout";
    }>((resolvePromise) => {
      let settled = false;
      const finish = (decision: ApprovalDecision, by: "user" | "abort" | "timeout") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(approvalId);
        resolvePromise({ decision, by });
      };
      const onAbort = () => finish("deny", "abort");
      const timer = setTimeout(() => finish("deny", "timeout"), this.timeoutMs);
      this.pending.set(approvalId, { resolve: finish, sessionId: input.sessionId });
      if (input.signal?.aborted) return onAbort();
      input.signal?.addEventListener("abort", onAbort, { once: true });
      this.emit("approval.request", {
        sessionId: input.sessionId,
        approvalId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        title: c.title,
        plainLanguage: c.plainLanguage,
        ...(c.command ? { command: c.command } : {}),
        risk: c.risk,
      });
    });
    let decision = result.decision;
    if (decision === "always_allow") {
      if (c.risk === "ask") this.settings.allowAlways(input.toolName);
      else decision = "allow_once";
    }
    this.audit({ ...base, approvalId, decision, by: result.by });
    this.emit("approval.resolved", {
      sessionId: input.sessionId,
      approvalId,
      decision,
      by: result.by,
    });
    if (decision === "deny") {
      return result.by === "user"
        ? `${DENIED_PREFIX} the farmer said no to "${c.title}". Do not retry; ask what they would like instead.`
        : `${DENIED_PREFIX} the approval for "${c.title}" was ${result.by === "abort" ? "cancelled" : "not answered in time"}.`;
    }
    return null;
  }

  respond(approvalId: string, decision: ApprovalDecision): boolean {
    const p = this.pending.get(approvalId);
    if (!p) return false;
    p.resolve(decision, "user");
    return true;
  }

  /** Denies every open approval of a session (used when the run is aborted). */
  cancelSession(sessionId: string) {
    for (const [, p] of this.pending) if (p.sessionId === sessionId) p.resolve("deny", "abort");
  }
}
