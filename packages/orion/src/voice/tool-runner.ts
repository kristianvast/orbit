import type { ToolItem, VoiceToolName } from "@orbit/protocol";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { BrowserError, type BrowserSession } from "../agent/browser";
import { type Emit, HubError, type SessionHub } from "../agent/hub";
import type { TaskOutcome } from "../agent/voice-history";
import { RepoError } from "../db/repo";
import { AccountError } from "../services/account";
import { assertNever } from "../services/camera-proxy";
import type { FarmService } from "../services/farm";
import { voiceResult } from "./result";
import { runVoiceTool } from "./tools";

export type VoiceCall = {
  readonly toolCallId: string;
  readonly name: VoiceToolName;
  readonly args: unknown;
};
export type ToolAnswer = { readonly result: string; readonly isError: boolean };
export type ToolContext = {
  readonly sessionId: string;
  readonly voiceId: string;
  readonly active: () => boolean;
};
export type ToolOptions = {
  readonly farm: FarmService;
  readonly hub: SessionHub;
  readonly browser: BrowserSession;
  readonly emit: Emit;
  readonly toolBudgetMs?: number;
};
const Task = Type.Object({ request: Type.String({ minLength: 1 }) });

function failure(error: unknown): ToolAnswer {
  if (
    !(error instanceof RepoError) &&
    !(error instanceof AccountError) &&
    !(error instanceof HubError) &&
    !(error instanceof BrowserError)
  ) {
    process.stderr.write(
      `orion: voice tool failed: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
  }
  return {
    result: `Not done: ${error instanceof Error ? error.message : String(error)}`,
    isError: true,
  };
}

function outcomeNote(outcome: TaskOutcome): string {
  switch (outcome.reason) {
    case "completed":
      return `Done: ${outcome.text.slice(0, 800)}`;
    case "error":
      return `It did not work: ${outcome.text.slice(0, 800)}`;
    case "aborted":
      return "It was stopped.";
    default:
      return assertNever(outcome.reason);
  }
}

/** Owns tool row lifetime independently of the SDK's answer deadline. */
export class VoiceToolRunner {
  constructor(private readonly opts: ToolOptions) {}

  async run(context: ToolContext, call: VoiceCall): Promise<ToolAnswer> {
    const { sessionId } = context;
    const started = Date.now();
    const label = {
      db_query: "Read farm records",
      db_mutate: "Change farm records",
      browser: "Use a web browser",
      orion_task: "Ask Orion to work",
    }[call.name];
    this.opts.emit("tool.start", { sessionId, ...call, label });
    const finish = (answer: ToolAnswer, stopped = false) => {
      const durationMs = Date.now() - started;
      const item: ToolItem = {
        kind: "tool",
        id: call.toolCallId,
        ts: new Date(started).toISOString(),
        ...call,
        label,
        status: stopped ? "aborted" : answer.isError ? "error" : "done",
        ...answer,
        details: null,
        durationMs,
      };
      this.opts.emit("tool.end", {
        sessionId,
        toolCallId: call.toolCallId,
        ...answer,
        details: item.details,
        durationMs,
      });
      this.opts.hub.recordVoiceTool(sessionId, item);
    };
    const note = (text: string) => {
      if (context.active())
        this.opts.emit("voice.note", {
          sessionId,
          voiceId: context.voiceId,
          text,
        });
    };
    if (call.name === "orion_task") {
      if (!Value.Check(Task, call.args)) {
        const answer = failure(new RepoError("bad_request", "Give Orion a request to work on."));
        finish(answer);
        return answer;
      }
      if (this.opts.hub.isStreaming(sessionId)) {
        const answer = {
          result: "Not done: Orion is already working on something in this conversation.",
          isError: true,
        };
        finish(answer);
        return answer;
      }
      void this.opts.hub.runTask(sessionId, call.args.request).then(
        (outcome) => {
          const text = outcomeNote(outcome);
          finish(
            { result: text, isError: outcome.reason === "error" },
            outcome.reason === "aborted",
          );
          note(text);
        },
        (error: unknown) => {
          const answer = failure(error);
          finish(answer);
          note(`It did not work: ${answer.result.slice(10, 810)}`);
        },
      );
      return { result: "Started. I will tell you when it is ready.", isError: false };
    }
    const work = this.execute(context, call).catch(failure);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.opts.toolBudgetMs ?? 12000);
    });
    const answer = await Promise.race([work, deadline]);
    clearTimeout(timer);
    if (answer !== null) {
      finish(answer);
      return answer;
    }
    void work.then((late) => {
      finish(late);
      note(
        late.isError
          ? `It did not work: ${late.result.slice(10, 810)}`
          : `Done: ${late.result.slice(0, 800)}`,
      );
    });
    return { result: "Still working on it. I will tell you when it is ready.", isError: false };
  }

  private async execute(context: ToolContext, call: VoiceCall): Promise<ToolAnswer> {
    switch (call.name) {
      case "db_query":
      case "db_mutate": {
        const result = voiceResult(
          await runVoiceTool(
            this.opts.farm,
            {
              id: call.toolCallId,
              name: call.name,
              args: call.args,
            },
            context.sessionId,
          ),
        );
        return {
          result,
          isError: false,
        };
      }
      case "browser": {
        const { result, view } = await this.opts.browser.runVoice(call.args);
        this.opts.emit("browser.view", { sessionId: context.sessionId, ...view });
        return { result, isError: false };
      }
      case "orion_task":
        throw new HubError("bad_request", "Task must run through the task handler.");
      default:
        return assertNever(call.name);
    }
  }
}
