// Owns every conversation: one Pi AgentSession per Orbit session, persisted as JSONL under
// <data-dir>/sessions, with Pi events translated into @orbit/protocol events.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { EventBody, EventType, SessionSummary, TranscriptItem } from "@orbit/protocol";
import type { Repository } from "../db/repo";
import type { SettingsStore } from "../settings";
import { billingError } from "./billing-error";
import { FileCredentialStore } from "./credentials";
import { MEMORY_SCOPES, memoryFile } from "./memory";
import { MOCK_MODEL, MOCK_PROVIDER, registerMockProvider } from "./mock-model";
import { assistantItem, buildTranscript, contentText, toolStatus, userItem } from "./transcript";
import type { Workspace } from "./workspace";

export type Emit = <E extends EventType>(type: E, body: EventBody<E>) => void;

export class HubError extends Error {
  constructor(
    readonly code: "not_found" | "busy" | "not_ready" | "bad_request",
    message: string,
  ) {
    super(message);
  }
}

interface IndexEntry {
  id: string;
  title: string;
  titleSet: boolean;
  createdAt: string;
  updatedAt: string;
  file: string;
  parentSessionId: string | null;
}

interface LiveSession {
  id: string;
  sm: SessionManager;
  agent: AgentSession | null;
  unsubscribe: (() => void) | null;
  streaming: boolean;
  settledEmitted: boolean;
  currentAssistantId: string | null;
  pendingEnds: Array<{ message: Record<string, unknown>; messageId: string }>;
  toolStarts: Map<string, number>;
}

export interface HubOptions {
  dataDir: string;
  workspace: Workspace;
  resourcesDir: string;
  repo: Repository;
  settings: SettingsStore;
  tools: ToolDefinition[];
  emit: Emit;
  mockModel: boolean;
  gatewayUrl: string | null;
  appSource: string | null;
}

export const GATEWAY_PROVIDER = "orbit-gateway";
const ABORT_SETTLE_MS = 3_000;

const ORION_SYSTEM_PROMPT = `You are Orion, the assistant inside Orbit, a farm app running on the farmer's own computer.
You help a farmer with cattle (dairy and beef) and horses: herd records, sensors, robots, cameras and small features built in the farm workspace.
Use the farm tools to read and change farm data. You also have the full file and shell tools: your working directory is the farm workspace, and you may work anywhere on this computer when the job needs it.
With the computer tool you can see the screen and use the mouse and keyboard to work in other programs on this computer, such as a vendor herd or robot program that has no connector.
Speak plainly and keep answers short. Before anything risky or hard to undo (deleting files, installing software, changing system or network settings, touching files outside the farm workspace, contacting devices on the network), say what you will do and why, and wait for the farmer to say yes in the chat. Routine reads and small, undoable changes need no permission; just say what you did.
When you learn a lasting fact about the farm or about the farmer, save it with memory_remember right away, without asking; fix wrong or outdated facts with memory_forget. Do not save one-off details or secrets.
To add a screen to Orbit, build a custom page in pages/<id>/ (see the custom-pages skill); it appears in the app's menu. To change Orbit's existing screens, follow the editing-orbit skill and finish with local_ui_build.
Orbit starts minimal: a fresh install shows only Home, Chat and Settings, and you build out what this farm needs. The built-in Herd, Devices and Cameras screens are modules; when the farmer starts using one of those areas (for example adding animals or setting up a sensor), enable that module with orbit_modules. For anything else the farmer asks to see, build a custom page. Never pile on screens or modules the farmer did not ask for or is not using.
When the farmer runs into a problem with Orbit, wishes it could do something it cannot, or wants to tell the people who make Orbit something, offer to pass it on with feedback_send. When the farmer is pleased with a page, connector or skill you built together, you may offer once to share it with other farms using share_build; it is reviewed by the Orbit team first. Both need the farmer's yes.
The Orbit account, the free trial, plans and usage are in Settings; you cannot change them, so point the farmer there.`;

function appSourcePrompt(dir: string): string {
  return `

Orbit's own source code is checked out at ${dir}, and you may change the app itself there.
The UI is in ${join(dir, "apps/orbit/src")} (React + Vite; the running dev app reloads on save). Orion, the agent you are, is in ${join(dir, "packages/orion")} and restarts on save in dev.
Follow that checkout's AGENTS.md. After a change, run \`bun run typecheck\` and the affected package's tests from ${dir}, and fix what you broke. Never run cargo, tauri or other heavy builds there. Prefer a custom page when the farmer only needs a new screen.`;
}

function sameMessage(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return a === b || (a.role === b.role && a.timestamp === b.timestamp);
}

export class SessionHub {
  readonly runtime: ModelRuntime;
  readonly credentials: FileCredentialStore;
  private readonly sessionsDir: string;
  private readonly indexFile: string;
  private readonly agentDir: string;
  private index = new Map<string, IndexEntry>();
  private live = new Map<string, LiveSession>();

  private constructor(
    private readonly opts: HubOptions,
    runtime: ModelRuntime,
    credentials: FileCredentialStore,
  ) {
    this.runtime = runtime;
    this.credentials = credentials;
    this.sessionsDir = join(opts.dataDir, "sessions");
    this.indexFile = join(this.sessionsDir, "index.json");
    this.agentDir = join(opts.dataDir, "pi");
    mkdirSync(this.sessionsDir, { recursive: true });
    if (existsSync(this.indexFile)) {
      for (const e of JSON.parse(readFileSync(this.indexFile, "utf8")) as IndexEntry[]) {
        this.index.set(e.id, e);
      }
    }
  }

  static async create(opts: HubOptions): Promise<SessionHub> {
    const agentDir = join(opts.dataDir, "pi");
    mkdirSync(agentDir, { recursive: true });
    const credentials = new FileCredentialStore(join(agentDir, "auth.json"));
    const runtime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      refreshOnCreate: false,
    });
    if (opts.mockModel) registerMockProvider(runtime);
    if (opts.gatewayUrl) {
      runtime.registerProvider(GATEWAY_PROVIDER, {
        name: "Orbit subscription",
        baseUrl: opts.gatewayUrl,
        api: "openai-completions",
        models: [
          {
            id: "orbit-default",
            name: "Orbit (subscription)",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 8192,
          },
        ],
      });
    }
    return new SessionHub(opts, runtime, credentials);
  }

  // ------------------------------------------------------------------ model

  resolveModel(): Model<never> | null {
    const s = this.opts.settings.get();
    if (s.provider && s.model) {
      return (this.runtime.getModel(s.provider, s.model) as Model<never> | undefined) ?? null;
    }
    if (this.opts.mockModel) {
      return (this.runtime.getModel(MOCK_PROVIDER, MOCK_MODEL) as Model<never> | undefined) ?? null;
    }
    return null;
  }

  availableModels(): { provider: string; id: string; name: string }[] {
    const seen = new Set<string>();
    const out: { provider: string; id: string; name: string }[] = [];
    const extra = [MOCK_PROVIDER, GATEWAY_PROVIDER].flatMap((p) => this.runtime.getModels(p));
    for (const m of [...extra, ...this.runtime.getAvailableSnapshot()]) {
      const key = `${m.provider}/${m.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ provider: m.provider, id: m.id, name: m.name });
    }
    return out;
  }

  async setApiKey(provider: string, key: string | null) {
    if (key === null) {
      await this.credentials.delete(provider);
      await this.runtime.removeRuntimeApiKey(provider).catch(() => undefined);
    } else {
      await this.credentials.modify(provider, async () => ({ type: "api_key", key }));
      await this.runtime.setRuntimeApiKey(provider, key);
    }
  }

  // ------------------------------------------------------------------ index

  private saveIndex() {
    writeFileSync(this.indexFile, JSON.stringify([...this.index.values()], null, 2));
  }

  private entry(id: string): IndexEntry {
    const e = this.index.get(id);
    if (!e) throw new HubError("not_found", `session ${id} not found`);
    return e;
  }

  private countMessages(sm: SessionManager): number {
    return sm
      .getBranch()
      .filter(
        (e) =>
          e.type === "message" &&
          ((e.message as { role?: string }).role === "user" ||
            (e.message as { role?: string }).role === "assistant"),
      ).length;
  }

  summary(id: string): SessionSummary {
    const e = this.entry(id);
    const live = this.live.get(id);
    let messageCount = 0;
    if (live) messageCount = this.countMessages(live.sm);
    else if (existsSync(e.file))
      messageCount = this.countMessages(SessionManager.open(e.file, this.sessionsDir));
    const model = live?.agent?.model ?? this.resolveModel();
    return {
      id: e.id,
      title: e.title,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      messageCount,
      model: model ? `${model.provider}/${model.id}` : null,
      streaming: live?.streaming ?? false,
      parentSessionId: e.parentSessionId,
    };
  }

  list(): SessionSummary[] {
    return [...this.index.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((e) => this.summary(e.id));
  }

  private touch(id: string, patch: Partial<IndexEntry> = {}) {
    const e = this.entry(id);
    Object.assign(e, patch, { updatedAt: new Date().toISOString() });
    this.saveIndex();
    this.opts.emit("session.updated", { sessionId: id, session: this.summary(id) });
  }

  // ------------------------------------------------------------------ lifecycle

  createSession(
    title?: string,
    parentSessionId: string | null = null,
    sm?: SessionManager,
  ): SessionSummary {
    const manager = sm ?? SessionManager.create(this.opts.workspace.dir, this.sessionsDir);
    const id = manager.getSessionId();
    const now = new Date().toISOString();
    this.index.set(id, {
      id,
      title: title?.trim() || "New conversation",
      titleSet: Boolean(title?.trim()),
      createdAt: now,
      updatedAt: now,
      file: manager.getSessionFile() as string,
      parentSessionId,
    });
    this.live.set(id, this.newLive(id, manager));
    this.saveIndex();
    return this.summary(id);
  }

  private newLive(id: string, sm: SessionManager): LiveSession {
    return {
      id,
      sm,
      agent: null,
      unsubscribe: null,
      streaming: false,
      settledEmitted: true,
      currentAssistantId: null,
      pendingEnds: [],
      toolStarts: new Map(),
    };
  }

  private getLive(id: string): LiveSession {
    const existing = this.live.get(id);
    if (existing) return existing;
    const e = this.entry(id);
    const sm = existsSync(e.file)
      ? SessionManager.open(e.file, this.sessionsDir, this.opts.workspace.dir)
      : SessionManager.create(this.opts.workspace.dir, this.sessionsDir, { id });
    if (sm.getSessionFile() !== e.file) {
      e.file = sm.getSessionFile() as string;
      this.saveIndex();
    }
    const live = this.newLive(id, sm);
    this.live.set(id, live);
    return live;
  }

  open(id: string): { session: SessionSummary; items: TranscriptItem[] } {
    const live = this.getLive(id);
    const labels = new Map(this.opts.tools.map((t) => [t.name, t.label]));
    const items = buildTranscript(
      live.sm.getBranch(),
      (name) => labels.get(name) ?? live.agent?.getToolDefinition(name)?.label ?? name,
      live.streaming,
    );
    return { session: this.summary(id), items };
  }

  rename(id: string, title: string): SessionSummary {
    const live = this.getLive(id);
    live.sm.appendSessionInfo(title);
    this.touch(id, { title, titleSet: true });
    return this.summary(id);
  }

  async delete(id: string): Promise<boolean> {
    const e = this.index.get(id);
    if (!e) return false;
    const live = this.live.get(id);
    if (live) {
      if (live.agent) {
        await live.agent.abort().catch(() => undefined);
        live.unsubscribe?.();
        live.agent.dispose();
      }
      this.live.delete(id);
    }
    rmSync(e.file, { force: true });
    this.index.delete(id);
    this.saveIndex();
    return true;
  }

  fork(id: string, fromItemId?: string): SessionSummary {
    const source = this.entry(id);
    const title = `${source.title} (copy)`;
    if (!existsSync(source.file)) return this.createSession(title, id);
    if (fromItemId) {
      const sm = SessionManager.open(source.file, this.sessionsDir, this.opts.workspace.dir);
      const target = sm.getEntry(fromItemId);
      if (target?.type !== "message" || (target.message as { role?: string }).role !== "user") {
        throw new HubError(
          "bad_request",
          `item ${fromItemId} is not a user message in this session`,
        );
      }
      const path = sm.createBranchedSession(fromItemId);
      if (!path) throw new HubError("not_ready", "could not create the fork");
      return this.createSession(
        title,
        id,
        SessionManager.open(path, this.sessionsDir, this.opts.workspace.dir),
      );
    }
    const forked = SessionManager.forkFrom(source.file, this.opts.workspace.dir, this.sessionsDir, {
      parentSession: source.file,
    });
    return this.createSession(title, id, forked);
  }

  // ------------------------------------------------------------------ agent

  private async ensureAgent(live: LiveSession): Promise<AgentSession> {
    const model = this.resolveModel();
    if (!model) {
      throw new HubError(
        "not_ready",
        "No AI model is set up yet. Choose a model and add a key in Settings.",
      );
    }
    if (
      model.provider !== MOCK_PROVIDER &&
      model.provider !== GATEWAY_PROVIDER &&
      !this.runtime.getProviderAuthStatus(model.provider).configured
    ) {
      throw new HubError(
        "not_ready",
        `No AI model is set up yet: ${model.provider} has no key or sign-in. Add one in Settings.`,
      );
    }
    if (live.agent) {
      const current = live.agent.model;
      if (!current || current.provider !== model.provider || current.id !== model.id) {
        await live.agent.setModel(model);
      }
      return live.agent;
    }
    const agentsFile = join(this.opts.resourcesDir, "AGENTS.md");
    const workspaceAgents = join(this.opts.workspace.dir, "AGENTS.md");
    const loader = new DefaultResourceLoader({
      cwd: this.opts.workspace.dir,
      agentDir: this.agentDir,
      systemPrompt:
        ORION_SYSTEM_PROMPT + (this.opts.appSource ? appSourcePrompt(this.opts.appSource) : ""),
      // Bundled skills, then the ones this farm installed from the catalog (skill_install).
      additionalSkillPaths: [
        join(this.opts.resourcesDir, "skills"),
        join(this.opts.workspace.dir, "skills"),
      ],
      agentsFilesOverride: () => ({
        agentsFiles: [
          agentsFile,
          workspaceAgents,
          ...(this.opts.appSource ? [join(this.opts.appSource, "AGENTS.md")] : []),
          ...MEMORY_SCOPES.map((s) => memoryFile(this.opts.workspace.dir, s)),
        ]
          .filter((p) => existsSync(p))
          .map((p) => ({ path: p, content: readFileSync(p, "utf8") })),
      }),
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: this.opts.workspace.dir,
      agentDir: this.agentDir,
      modelRuntime: this.runtime,
      model,
      thinkingLevel: this.opts.settings.get().thinkingLevel,
      resourceLoader: loader,
      sessionManager: live.sm,
      // Pi owns retries so terminal cloud allowance errors reach Orion before HTTP retries.
      settingsManager: SettingsManager.inMemory({ retry: { provider: { maxRetries: 0 } } }),
      customTools: this.opts.tools,
    });
    live.agent = session;
    live.unsubscribe = session.subscribe((event) => this.onEvent(live, event));
    return session;
  }

  private onEvent(live: LiveSession, event: AgentSessionEvent) {
    const emit = this.opts.emit;
    const sessionId = live.id;
    if ("parentToolCallId" in event && event.parentToolCallId) return;
    switch (event.type) {
      case "message_start": {
        const message = event.message as unknown as Record<string, unknown>;
        if (message.role === "assistant") {
          const messageId = `msg_${crypto.randomUUID()}`;
          live.currentAssistantId = messageId;
          emit("message.start", { sessionId, messageId, role: "assistant" });
        }
        return;
      }
      case "message_update": {
        const messageId = live.currentAssistantId;
        if (!messageId) return;
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta") emit("message.delta", { sessionId, messageId, text: e.delta });
        else if (e.type === "thinking_delta")
          emit("message.delta", { sessionId, messageId, thinking: e.delta });
        return;
      }
      case "message_end": {
        const message = event.message as unknown as Record<string, unknown>;
        if (
          message.role === "assistant" &&
          live.agent?.model?.provider === GATEWAY_PROVIDER &&
          typeof message.errorMessage === "string" &&
          billingError(message.errorMessage)
        ) {
          live.agent.setAutoRetryEnabled(false);
        }
        let messageId: string;
        if (message.role === "user") {
          messageId = `msg_${crypto.randomUUID()}`;
          emit("message.start", { sessionId, messageId, role: "user" });
        } else if (message.role === "assistant") {
          messageId = live.currentAssistantId ?? `msg_${crypto.randomUUID()}`;
          live.currentAssistantId = null;
        } else {
          return;
        }
        const entry = this.findEntry(live, message);
        if (entry) this.emitMessageEnd(live, { message, messageId }, entry.id, entry.timestamp);
        else live.pendingEnds.push({ message, messageId });
        return;
      }
      case "entry_appended": {
        if (event.entry.type !== "message") return;
        const appended = event.entry.message as unknown as Record<string, unknown>;
        const idx = live.pendingEnds.findIndex((p) => sameMessage(p.message, appended));
        if (idx < 0) return;
        const [pending] = live.pendingEnds.splice(idx, 1);
        if (pending) this.emitMessageEnd(live, pending, event.entry.id, event.entry.timestamp);
        return;
      }
      case "tool_execution_start": {
        live.toolStarts.set(event.toolCallId, Date.now());
        const label =
          live.agent?.getToolDefinition(event.toolName)?.label ??
          this.opts.tools.find((t) => t.name === event.toolName)?.label ??
          event.toolName;
        emit("tool.start", {
          sessionId,
          toolCallId: event.toolCallId,
          name: event.toolName,
          label,
          args: event.args ?? {},
        });
        return;
      }
      case "tool_execution_update": {
        const partial = contentText(
          (event.partialResult as { content?: unknown } | undefined)?.content,
        );
        emit("tool.update", { sessionId, toolCallId: event.toolCallId, partial });
        return;
      }
      case "tool_execution_end": {
        const started = live.toolStarts.get(event.toolCallId) ?? Date.now();
        live.toolStarts.delete(event.toolCallId);
        const result = event.result as { content?: unknown; details?: unknown } | undefined;
        emit("tool.end", {
          sessionId,
          toolCallId: event.toolCallId,
          result: contentText(result?.content),
          details: result?.details ?? null,
          isError: event.isError,
          durationMs: event.durationMs ?? Date.now() - started,
        });
        return;
      }
      case "agent_settled":
        void this.settle(live, event.aborted);
        return;
      default:
        return;
    }
  }

  private findEntry(live: LiveSession, message: Record<string, unknown>) {
    const branch = live.sm.getBranch();
    for (let i = branch.length - 1; i >= 0 && i >= branch.length - 20; i--) {
      const e = branch[i];
      if (
        e?.type === "message" &&
        sameMessage(message, e.message as unknown as Record<string, unknown>)
      ) {
        return e;
      }
    }
    return null;
  }

  private emitMessageEnd(
    live: LiveSession,
    pending: { message: Record<string, unknown>; messageId: string },
    itemId: string,
    ts: string,
  ) {
    const item =
      pending.message.role === "user"
        ? userItem(itemId, pending.message as never, ts)
        : assistantItem(itemId, pending.message as never, ts);
    this.opts.emit("message.end", { sessionId: live.id, messageId: pending.messageId, item });
  }

  private async settle(live: LiveSession, aborted: boolean, errorMessage?: string) {
    if (live.settledEmitted) return;
    live.settledEmitted = true;
    for (const pending of live.pendingEnds.splice(0)) {
      const entry = this.findEntry(live, pending.message);
      this.emitMessageEnd(
        live,
        pending,
        entry?.id ?? pending.messageId,
        entry?.timestamp ?? new Date().toISOString(),
      );
    }
    const last = [...(live.agent?.messages ?? [])].reverse().find((m) => m.role === "assistant") as
      | { stopReason?: string; errorMessage?: string }
      | undefined;
    const failed =
      errorMessage ??
      (last?.stopReason === "error" ? (last.errorMessage ?? "the model failed") : undefined);
    const planError =
      failed && live.agent?.model?.provider === GATEWAY_PROVIDER ? billingError(failed) : null;
    if (planError && !aborted) this.opts.emit("error", { sessionId: live.id, ...planError });
    const entry = this.index.get(live.id);
    try {
      const snap = await this.opts.workspace.snapshot(`Orion: ${entry?.title ?? live.id}`);
      if (snap) {
        this.opts.repo.recordWorkspaceSnapshot({
          ...snap,
          sessionId: live.id,
          description: `Changed ${snap.files.length} file${snap.files.length === 1 ? "" : "s"} in the farm workspace`,
        });
      }
    } catch (error) {
      process.stderr.write(`orion: workspace snapshot failed: ${String(error)}\n`);
    }
    live.streaming = false;
    if (entry) this.touch(live.id);
    this.opts.emit("agent.settled", {
      sessionId: live.id,
      reason: aborted ? "aborted" : failed ? "error" : "completed",
      ...(failed && !aborted ? { errorMessage: failed } : {}),
    });
  }

  async prompt(id: string, text: string, mode: "prompt" | "steer" | "followUp" = "prompt") {
    const live = this.getLive(id);
    if (live.streaming) {
      if (mode === "prompt")
        throw new HubError("busy", "Orion is still working on this conversation");
      const agent = live.agent as AgentSession;
      if (mode === "steer") await agent.steer(text);
      else await agent.followUp(text);
      return;
    }
    const agent = await this.ensureAgent(live);
    agent.setAutoRetryEnabled(true);
    const entry = this.entry(id);
    live.streaming = true;
    live.settledEmitted = false;
    if (!entry.titleSet && entry.title === "New conversation") {
      entry.title = text.trim().replace(/\s+/g, " ").slice(0, 60);
    }
    this.touch(id);
    agent.prompt(text).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (live.agent?.model?.provider !== GATEWAY_PROVIDER || !billingError(message)) {
        this.opts.emit("error", { sessionId: id, code: "internal", message });
      }
      void this.settle(live, false, message);
    });
  }

  async abort(id: string) {
    const live = this.live.get(id);
    if (!live?.agent || !live.streaming) return false;
    // A provider call stuck in a retry or a hung socket must not keep the farmer's Stop waiting.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      live.agent.abort().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ABORT_SETTLE_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!live.settledEmitted) await this.settle(live, true);
    return true;
  }

  async dispose() {
    for (const live of this.live.values()) {
      live.unsubscribe?.();
      live.agent?.dispose();
    }
    this.live.clear();
  }

  isStreaming(id: string) {
    return this.live.get(id)?.streaming ?? false;
  }

  toolStatus = toolStatus;
}
