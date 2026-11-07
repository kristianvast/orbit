// Model provider sign-in, the same flow as Pi's /login: ModelRuntime.login drives each provider's
// OAuth or API-key setup, and its prompts and notices are relayed to the UI over the protocol.
// Credentials land in the runtime's credential store (<data-dir>/pi/auth.json); none are echoed.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthMethod, AuthNotice, AuthPromptInfo, AuthProviderInfo } from "@orbit/protocol";
import { type Emit, HubError } from "./hub";

const CANCELLED = "Login cancelled";

interface PendingPrompt {
  resolve(value: string): void;
  reject(error: Error): void;
}

interface Flow {
  providerId: string;
  abort: AbortController;
  prompts: Map<string, PendingPrompt>;
}

export type OpenUrl = (url: string) => boolean;

export interface AuthFlowOptions {
  /** Stable id of this Orion install, created on first use (some providers send it at login). */
  deviceIdFile: string;
  /** Opens a sign-in page in the system browser; null leaves it to the user (tests, headless). */
  openUrl: OpenUrl | null;
  hidden: ReadonlySet<string>;
}

/** Opens https URLs with the platform's default browser. ORION_NO_BROWSER=1 turns it off. */
export function systemBrowserOpener(): OpenUrl | null {
  if (process.env.ORION_NO_BROWSER === "1") return null;
  return (url) => {
    if (!url.startsWith("https://")) return false;
    const cmd =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["rundll32", "url.dll,FileProtocolHandler", url]
          : ["xdg-open", url];
    try {
      Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
      return true;
    } catch (error) {
      process.stderr.write(`orion: could not open the browser: ${String(error)}\n`);
      return false;
    }
  };
}

function toPromptInfo(prompt: AuthPrompt): AuthPromptInfo {
  const base = { type: prompt.type, message: prompt.message };
  if (prompt.type === "select") {
    return {
      ...base,
      options: prompt.options.map((o) => ({
        id: o.id,
        label: o.label,
        ...(o.description ? { description: o.description } : {}),
      })),
    };
  }
  return prompt.placeholder ? { ...base, placeholder: prompt.placeholder } : base;
}

export class AuthFlows {
  private flows = new Map<string, Flow>();

  constructor(
    private readonly runtime: ModelRuntime,
    private readonly emit: Emit,
    private readonly opts: AuthFlowOptions,
  ) {}

  providers(): AuthProviderInfo[] {
    return this.runtime
      .getProviders()
      .filter((p) => !this.opts.hidden.has(p.id) && (p.auth.oauth || p.auth.apiKey?.login))
      .map((p): AuthProviderInfo => {
        const status = this.runtime.getProviderAuthStatus(p.id);
        const oauth = p.auth.oauth;
        return {
          id: p.id,
          name: p.name,
          oauth: oauth
            ? {
                name: oauth.name,
                subscription: oauth.isSubscription === true,
                ...(oauth.loginLabel ? { label: oauth.loginLabel } : {}),
              }
            : null,
          apiKey: p.auth.apiKey?.login ? { name: p.auth.apiKey.name } : null,
          status: {
            configured: status.configured,
            method: status.configured
              ? this.runtime.isUsingOAuth(p.id)
                ? "oauth"
                : "api_key"
              : null,
            source: status.configured ? (status.source ?? null) : null,
          },
          modelCount: this.runtime.getModels(p.id).length,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Starts a sign-in and returns its id; a running sign-in for the same provider is cancelled. */
  start(providerId: string, method: AuthMethod): string {
    const provider = this.opts.hidden.has(providerId)
      ? undefined
      : this.runtime.getProvider(providerId);
    if (!provider) throw new HubError("not_found", `unknown provider ${providerId}`);
    if (method === "oauth" ? !provider.auth.oauth : !provider.auth.apiKey?.login) {
      throw new HubError("bad_request", `${provider.name} has no ${method} sign-in`);
    }
    for (const [id, flow] of this.flows) if (flow.providerId === providerId) this.cancel(id);

    const loginId = randomUUID();
    const flow: Flow = { providerId, abort: new AbortController(), prompts: new Map() };
    this.flows.set(loginId, flow);
    // Run after the auth.login response is sent, so the client knows the id before any event.
    setTimeout(() => void this.run(loginId, flow, method), 0);
    return loginId;
  }

  respond(loginId: string, promptId: string, value: string): boolean {
    const pending = this.flow(loginId).prompts.get(promptId);
    if (!pending) return false;
    pending.resolve(value);
    return true;
  }

  cancel(loginId: string): boolean {
    const flow = this.flows.get(loginId);
    if (!flow) return false;
    flow.abort.abort();
    for (const pending of [...flow.prompts.values()]) pending.reject(new Error(CANCELLED));
    return true;
  }

  async logout(providerId: string): Promise<void> {
    if (!this.runtime.getProvider(providerId)) {
      throw new HubError("not_found", `unknown provider ${providerId}`);
    }
    await this.runtime.logout(providerId);
  }

  dispose() {
    for (const id of [...this.flows.keys()]) this.cancel(id);
  }

  private flow(loginId: string): Flow {
    const flow = this.flows.get(loginId);
    if (!flow) throw new HubError("not_found", `no sign-in ${loginId} is running`);
    return flow;
  }

  private async run(loginId: string, flow: Flow, method: AuthMethod) {
    try {
      await this.runtime.login(
        flow.providerId,
        method,
        {
          signal: flow.abort.signal,
          prompt: (prompt) => this.ask(loginId, flow, prompt),
          notify: (event) => this.emit("auth.notice", { loginId, notice: this.notice(event) }),
        },
        { getDeviceId: () => this.deviceId() },
      );
      this.finish(loginId, flow, true);
    } catch (error) {
      this.finish(loginId, flow, false, error);
    }
  }

  private finish(loginId: string, flow: Flow, ok: boolean, error?: unknown) {
    this.flows.delete(loginId);
    const cancelled = !ok && flow.abort.signal.aborted;
    const message = error instanceof Error ? error.message : error ? String(error) : undefined;
    this.emit("auth.finished", {
      loginId,
      providerId: flow.providerId,
      ok,
      cancelled,
      ...(!ok && !cancelled && message ? { error: message } : {}),
    });
  }

  private ask(loginId: string, flow: Flow, prompt: AuthPrompt): Promise<string> {
    if (flow.abort.signal.aborted) return Promise.reject(new Error(CANCELLED));
    const promptId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const settle = () => {
        flow.prompts.delete(promptId);
        prompt.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        settle();
        reject(new Error(CANCELLED));
      };
      prompt.signal?.addEventListener("abort", onAbort, { once: true });
      flow.prompts.set(promptId, {
        resolve: (value) => {
          settle();
          resolve(value);
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
      this.emit("auth.prompt", { loginId, promptId, prompt: toPromptInfo(prompt) });
    });
  }

  private notice(event: AuthEvent): AuthNotice {
    switch (event.type) {
      case "auth_url": {
        const opened = this.opts.openUrl?.(event.url) ?? false;
        return {
          type: "auth_url",
          url: event.url,
          opened,
          ...(event.instructions ? { instructions: event.instructions } : {}),
        };
      }
      case "device_code":
        return {
          type: "device_code",
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          ...(event.expiresInSeconds ? { expiresInSeconds: event.expiresInSeconds } : {}),
        };
      case "info":
        return {
          type: "info",
          message: event.message,
          ...(event.links
            ? {
                links: event.links.map((l) => ({
                  url: l.url,
                  ...(l.label ? { label: l.label } : {}),
                })),
              }
            : {}),
        };
      case "progress":
        return { type: "progress", message: event.message };
    }
  }

  private deviceId(): string {
    const file = this.opts.deviceIdFile;
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
    const id = randomUUID();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, id, { mode: 0o600 });
    return id;
  }
}
