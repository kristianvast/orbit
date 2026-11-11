import type { ServerWebSocket } from "bun";
import { AccountError, type AccountService } from "../services/account";
import type { BillingService } from "../services/billing";
import type { SocketData } from "../services/camera-proxy";
import { MockVoiceTransport } from "./mock";
import { type ToolOptions, type VoiceCall, VoiceToolRunner } from "./tool-runner";
import { LiveVoiceTransport, type VoiceTransport } from "./transport";

export interface VoiceOptions extends ToolOptions {
  readonly account: Pick<AccountService, "status" | "cloudConnection">;
  readonly billing: Pick<BillingService, "status">;
  readonly mockModel: boolean;
  readonly token: string;
  readonly transport?: () => VoiceTransport;
}
type LiveCall = {
  readonly voiceId: string;
  readonly sessionId: string;
  readonly owner: object;
  readonly transport: VoiceTransport;
  socket: VoiceSocket | null;
  connected: boolean;
  ready: boolean;
  readonly pending: string[];
};
export type VoiceSocketData = { readonly kind: "voice"; readonly voiceId: string };
type VoiceSocket = Pick<ServerWebSocket<SocketData>, "send" | "close">;

/** A call outlives its SDK socket until stop or the protocol owner disconnects. */
export class VoiceSessions {
  private readonly live = new Map<string, LiveCall>();
  private readonly pending = new WeakMap<object, object>();
  private epoch = 0;
  private readonly tools: VoiceToolRunner;
  constructor(private readonly opts: VoiceOptions) {
    this.tools = new VoiceToolRunner(opts);
  }

  async start(sessionId: string, owner: object) {
    this.opts.hub.summary(sessionId);
    this.disconnect(owner);
    const ticket = {};
    const epoch = this.epoch;
    this.pending.set(owner, ticket);
    const endpoint = await this.endpoint();
    if (this.pending.get(owner) !== ticket || epoch !== this.epoch)
      throw new AccountError("disconnected", "Voice connection was cancelled.");
    this.pending.delete(owner);
    const voiceId = crypto.randomUUID();
    const transport =
      this.opts.transport?.() ??
      (this.opts.mockModel ? new MockVoiceTransport() : new LiveVoiceTransport(endpoint));
    this.live.set(voiceId, {
      voiceId,
      sessionId,
      owner,
      transport,
      socket: null,
      connected: false,
      ready: false,
      pending: [],
    });
    return {
      voiceId,
      path: `/voice/${encodeURIComponent(this.opts.token)}/${voiceId}`,
      variables: {
        farm_name: this.opts.farm.repo.farm()?.name ?? "this farm",
        conversation_recap: this.opts.hub.voiceRecap(sessionId),
      },
    };
  }

  /** Reserves the single SDK connection before Bun upgrades it. */
  claim(voiceId: string): number | null {
    const live = this.live.get(voiceId);
    if (!live) return 404;
    if (live.connected) return 409;
    live.connected = true;
    return null;
  }

  async open(voiceId: string, socket: VoiceSocket): Promise<void> {
    const live = this.live.get(voiceId);
    if (!live) {
      socket.close();
      return;
    }
    live.socket = socket;
    try {
      await live.transport.connect(
        (frame) => live.socket?.send(frame),
        (code) => {
          if (code === 4402)
            this.opts.emit("error", {
              sessionId: live.sessionId,
              code: "budget_exceeded",
              message: "Your voice allowance is used up for this period.",
            });
          live.socket?.close(code === 4402 ? 4402 : 1000, "Voice service closed.");
        },
      );
      if (live.socket !== socket) {
        live.transport.close();
        return;
      }
      live.ready = true;
      for (const frame of live.pending.splice(0)) live.transport.send(frame);
    } catch (error) {
      if (live.socket !== socket) return;
      process.stderr.write(
        `orion: voice connection failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      socket.close(1011, "Voice service unavailable.");
      live.transport.close();
    }
  }

  message(voiceId: string, raw: string | Buffer): void {
    const live = this.live.get(voiceId);
    if (!live) return;
    const frame = String(raw);
    if (live.ready) live.transport.send(frame);
    else live.pending.push(frame);
  }

  close(voiceId: string): void {
    const live = this.live.get(voiceId);
    if (!live) return;
    live.socket = null;
    live.pending.length = 0;
    live.transport.close();
  }

  turn(voiceId: string, owner: object, role: "user" | "assistant", text: string): boolean {
    this.opts.hub.recordVoiceTurn(this.session(voiceId, owner).sessionId, role, text);
    return true;
  }
  tool(voiceId: string, owner: object, call: VoiceCall) {
    const live = this.session(voiceId, owner);
    return this.tools.run(
      {
        sessionId: live.sessionId,
        voiceId,
        active: () => this.live.get(voiceId) === live,
      },
      call,
    );
  }
  stop(voiceId: string, owner: object): boolean {
    const live = this.live.get(voiceId);
    if (!live || live.owner !== owner) return false;
    this.live.delete(voiceId);
    live.socket?.close(1000, "Voice call ended.");
    live.transport.close();
    return true;
  }
  disconnect(owner: object): void {
    this.pending.delete(owner);
    for (const live of this.live.values()) if (live.owner === owner) this.stop(live.voiceId, owner);
  }
  dispose(): void {
    this.epoch++;
    for (const live of this.live.values()) this.stop(live.voiceId, live.owner);
  }
  private session(voiceId: string, owner: object): LiveCall {
    const live = this.live.get(voiceId);
    if (!live || live.owner !== owner)
      throw new AccountError("not_found", "Voice session is closed.");
    return live;
  }

  private async endpoint(): Promise<{ url: string; headers?: Record<string, string> }> {
    if (this.opts.mockModel) return { url: "" };
    if (this.opts.account.status().state !== "signed_in")
      throw new AccountError("unauthorized", "Sign in with an Orbit plan to talk to Orion.");
    const status = await this.opts.billing.status();
    if (status.plan === "free" || !["active", "trialing"].includes(status.status))
      throw new AccountError("plan_required", "Choose an Orbit plan to talk to Orion.");
    if (status.usage.voiceSecondsUsed >= status.usage.voiceSecondsAllowance)
      throw new AccountError("budget_exceeded", "Your voice allowance is used up for this period.");
    const connection = this.opts.account.cloudConnection();
    const url = new URL(`${connection.url}/v1/voice/agent`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return { url: url.href, headers: connection.headers };
  }
}
