import { Value } from "typebox/value";
import type { FileCredentialStore } from "../agent/credentials";
import type { Emit } from "../agent/hub";
import { AccountError, type AccountService } from "../services/account";
import type { BillingService } from "../services/billing";
import type { FarmService } from "../services/farm";
import { MockVoiceTransport } from "./mock";
import { receiveVoiceFrame } from "./receive";
import type { VoiceSessionState } from "./state";
import { voiceTools } from "./tools";
import { LiveVoiceTransport, type VoiceTransport } from "./transport";
import { VoiceFrame } from "./wire";

export interface VoiceOptions {
  readonly farm: FarmService;
  readonly account: Pick<AccountService, "status" | "cloudConnection">;
  readonly billing: Pick<BillingService, "status">;
  readonly credentials: Pick<FileCredentialStore, "read">;
  readonly emit: Emit;
  readonly mockModel: boolean;
  readonly transport?: () => VoiceTransport;
}

/** Owns authenticated voice sessions and executes tools beside the single local database writer. */
export class VoiceSessions {
  private readonly live = new Map<string, VoiceSessionState>();
  private readonly pending = new WeakMap<object, object>();
  private epoch = 0;
  constructor(private readonly opts: VoiceOptions) {}

  async start(sessionId: string, owner: object): Promise<{ voiceId: string }> {
    this.disconnect(owner);
    const ticket = {};
    const epoch = this.epoch;
    this.pending.set(owner, ticket);
    const transport = this.opts.transport?.() ?? (await this.transport());
    if (this.pending.get(owner) !== ticket || epoch !== this.epoch) {
      transport.close();
      throw new AccountError("disconnected", "Voice connection was cancelled.");
    }
    const voiceId = crypto.randomUUID();
    const live: VoiceSessionState = {
      voiceId,
      sessionId,
      owner,
      transport,
      cancelled: new Set(),
      ready: false,
      active: true,
      queue: Promise.resolve(),
    };
    this.live.set(voiceId, live);
    this.opts.emit("voice.state", { voiceId, sessionId, state: "connecting" });
    try {
      await transport.connect(
        (frame) => {
          if (Value.Check(VoiceFrame, frame) && frame.toolCallCancellation) {
            for (const id of frame.toolCallCancellation.ids) live.cancelled.add(id);
          }
          live.queue = live.queue
            .then(() => receiveVoiceFrame(live, frame, this.opts))
            .catch((error: unknown) => {
              this.fail(live, error instanceof Error ? error.message : String(error));
            });
        },
        (code) => {
          if (code === 4402) {
            this.opts.emit("error", {
              sessionId,
              code: "budget_exceeded",
              message:
                "Your voice allowance is used up for this period. Use your own Gemini key or manage your plan.",
            });
          }
          this.stop(voiceId, owner);
        },
      );
      if (!this.live.has(voiceId)) throw new AccountError("not_ready", "Voice connection closed.");
      const farm = this.opts.farm.repo.farm();
      transport.send({
        setup: {
          model: `models/${process.env.ORION_VOICE_MODEL ?? "gemini-3.8-live"}`,
          generationConfig: { responseModalities: ["AUDIO"] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: {
            parts: [
              {
                text: `You are Orion, a concise voice assistant for ${farm?.name ?? "this farm"} (farm id ${farm?.id ?? "local"}). Help with cattle and horses. Query farm records before answering questions about the herd. Use db_query and db_mutate for farm data. Never invent records. An animal wears one wearable: collar OR bolus OR ear tag sensor. Routine writes have undo snapshots. Explain a risky change and ask before doing it. Never request or repeat secrets. Speak in the farmer's language.`,
              },
            ],
          },
          tools: voiceTools,
        },
      });
      return { voiceId };
    } catch (error) {
      this.stop(voiceId, owner);
      throw error;
    }
  }

  audio(voiceId: string, owner: object, data: string): boolean {
    const live = this.session(voiceId, owner);
    const bytes = Buffer.from(data, "base64");
    if (bytes.length % 2 !== 0 || bytes.toString("base64") !== data) {
      throw new AccountError("bad_request", "Voice audio must be base64 PCM16.");
    }
    if (!live.ready) return false;
    live.transport.send({ realtimeInput: { audio: { data, mimeType: "audio/pcm;rate=16000" } } });
    return true;
  }

  text(voiceId: string, owner: object, text: string): boolean {
    const live = this.session(voiceId, owner);
    if (!live.ready) return false;
    live.transport.send({ realtimeInput: { text } });
    return true;
  }

  stop(voiceId: string, owner: object): boolean {
    const live = this.live.get(voiceId);
    if (!live || live.owner !== owner) return false;
    live.active = false;
    this.live.delete(voiceId);
    live.transport.close();
    this.opts.emit("voice.state", { voiceId, sessionId: live.sessionId, state: "stopped" });
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

  private session(voiceId: string, owner: object): VoiceSessionState {
    const live = this.live.get(voiceId);
    if (!live || live.owner !== owner)
      throw new AccountError("not_found", "Voice session is closed.");
    return live;
  }

  private async transport(): Promise<VoiceTransport> {
    if (this.opts.mockModel) return new MockVoiceTransport();
    const credential = await this.opts.credentials.read("google");
    if (credential?.type === "api_key" && credential.key) {
      const url = new URL(
        "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
      );
      url.searchParams.set("key", credential.key);
      return new LiveVoiceTransport({ url: url.toString() });
    }
    if (this.opts.account.status().state !== "signed_in") {
      throw new AccountError(
        "unauthorized",
        "Sign in with a paid plan, or add your Gemini API key in Providers to talk to Orion.",
      );
    }
    const status = await this.opts.billing.status();
    if (status.plan === "free" || !["active", "trialing"].includes(status.status)) {
      throw new AccountError(
        "plan_required",
        "Choose a plan or add your Gemini API key in Providers to talk to Orion.",
      );
    }
    if (status.usage.voiceSecondsUsed >= status.usage.voiceSecondsAllowance) {
      throw new AccountError("budget_exceeded", "Your voice allowance is used up for this period.");
    }
    const connection = this.opts.account.cloudConnection();
    const url = new URL(`${connection.url}/v1/voice/live`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new LiveVoiceTransport({ url: url.toString(), headers: connection.headers });
  }

  private fail(live: VoiceSessionState, error: string): void {
    if (!this.live.has(live.voiceId)) return;
    this.opts.emit("voice.state", {
      voiceId: live.voiceId,
      sessionId: live.sessionId,
      state: "stopped",
      error,
    });
    this.live.delete(live.voiceId);
    live.active = false;
    live.transport.close();
  }
}
