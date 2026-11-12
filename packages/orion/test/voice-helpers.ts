import { afterEach, spyOn } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { startOrion } from "../src/app";
import type { VoiceOptions } from "../src/voice/session";
import { connect, removeLockedDir, TOKEN, tempDir } from "./helpers";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

export async function voiceFixture(options: Pick<VoiceOptions, "transport" | "toolBudgetMs"> = {}) {
  const dir = tempDir();
  cleanup.push(() => removeLockedDir(dir));
  const app = await startOrion(
    {
      port: 0,
      token: TOKEN,
      dataDir: dir,
      mockModel: true,
      seed: true,
      gatewayUrl: null,
      appSource: null,
    },
    options,
  );
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await app.stop();
  };
  cleanup.push(stop);
  const client = await connect(app);
  cleanup.push(() => client.close());
  const { session } = await client.request("sessions.create", { title: "Voice test" });
  const call = await client.request("voice.start", { sessionId: session.id });
  return { dir, app, client, stop, sessionId: session.id, ...call };
}

export function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Voice test event timed out.")), 10000);
    }),
  ]).finally(() => clearTimeout(timer));
}

const Frame = Type.Record(Type.String(), Type.Unknown());
export class VoicePeer {
  readonly socket: WebSocket;
  readonly opened: Promise<void>;
  readonly closed: Promise<number>;
  private readonly frames: Record<string, unknown>[] = [];
  private readonly waiting = new Map<string, (frame: Record<string, unknown>) => void>();
  constructor(url: string) {
    this.socket = new WebSocket(url);
    cleanup.push(() => this.socket.close());
    this.opened = bounded(
      new Promise((resolve, reject) => {
        this.socket.onopen = () => resolve();
        this.socket.onerror = () => reject(new Error("Could not open voice peer."));
      }),
    );
    this.closed = new Promise((resolve) => {
      this.socket.onclose = (event) => resolve(event.code);
    });
    this.socket.onmessage = (event) => {
      const frame: unknown = JSON.parse(String(event.data));
      if (!Value.Check(Frame, frame) || typeof frame.type !== "string")
        throw new Error("Invalid mock frame");
      const waiter = this.waiting.get(frame.type);
      if (waiter) {
        this.waiting.delete(frame.type);
        waiter(frame);
      } else this.frames.push(frame);
    };
  }
  next(type: string): Promise<Record<string, unknown>> {
    const index = this.frames.findIndex((frame) => frame.type === type);
    if (index >= 0) {
      const frame = this.frames.splice(index, 1)[0];
      if (frame) return Promise.resolve(frame);
    }
    return bounded(new Promise((resolve) => this.waiting.set(type, resolve)));
  }
  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }
}

/** Intercept the real runtime boundary while retaining the registered mock provider. */
export function holdModel(runtime: ModelRuntime) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = runtime.streamSimple.bind(runtime);
  const spy = spyOn(runtime, "streamSimple").mockImplementation((model, context, options) => {
    const output = createAssistantMessageEventStream();
    entered.resolve();
    void release.promise.then(async () => {
      const source = original(model, context, options);
      for await (const event of source) output.push(event);
      output.end();
    });
    return output;
  });
  cleanup.push(() => {
    release.resolve();
    spy.mockRestore();
  });
  return { entered: bounded(entered.promise), release: () => release.resolve() };
}
