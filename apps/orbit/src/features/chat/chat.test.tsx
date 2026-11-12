import {
  type AuthProviderInfo,
  type ConnectionState,
  MODULE_IDS,
  type ModulesState,
  type OrionClient,
  type RequestParams,
  type RequestResult,
  type RequestType,
  type ServerEvent,
  type SessionSummary,
  type Settings,
  type SnapshotSummary,
  type ToolItem,
} from "@orbit/protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../../app/providers";
import SettingsPage from "../settings";
import ChatPage, {
  buildTurnBlocks,
  buildTurns,
  chatReducer,
  collapseToolRuns,
  createInitialChatState,
  summarizeToolArgs,
  summarizeToolGroup,
  Timeline,
  ToolCard,
  turnDurationMs,
} from "./index";
import { lastChat, RESUME_WINDOW_MS, rememberChat } from "./last-chat";

const baseSession: SessionSummary = {
  id: "sess-1",
  title: "Morning barn check",
  createdAt: "2026-11-03T07:00:00.000Z",
  updatedAt: "2026-11-03T07:05:00.000Z",
  messageCount: 2,
  model: "orion-mock/mock-1",
  streaming: false,
  parentSessionId: null,
};

function createMockClient(
  extraSessions: SessionSummary[] = [],
  options: { promptNeverResolves?: boolean; abortAccepted?: boolean } = {},
) {
  const currentState: ConnectionState = "open";
  const listeners = new Map<string, Set<(ev: ServerEvent) => void>>();

  const sessions: SessionSummary[] = [baseSession, ...extraSessions];
  let settings: Settings = {
    provider: "orion-mock",
    model: "mock-1",
    thinkingLevel: "off",
    shareAnonymousData: true,
    apiKeys: {
      "orion-mock": { configured: true },
      anthropic: { configured: true, hint: "…9a2f" },
    },
    availableModels: [
      {
        provider: "orion-mock",
        id: "mock-1",
        name: "Mock model (offline)",
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
      },
    ],
  };

  const providers: AuthProviderInfo[] = [
    {
      id: "anthropic",
      name: "Anthropic",
      oauth: { name: "Anthropic (Claude Pro/Max)", subscription: true },
      apiKey: { name: "Anthropic API key" },
      status: { configured: false, method: null, source: null },
      modelCount: 17,
    },
    {
      id: "groq",
      name: "Groq",
      oauth: null,
      apiKey: { name: "Groq API key" },
      status: { configured: false, method: null, source: null },
      modelCount: 7,
    },
  ];

  let modulesState: ModulesState = {
    modules: MODULE_IDS.map((id) => ({
      id,
      enabled: false,
      enabledAt: null,
      enabledBy: null,
    })),
  };

  let snapshots: SnapshotSummary[] = [
    {
      id: "snap-1",
      createdAt: "2026-11-03T08:00:00.000Z",
      description: "Added Bella (DK-1001) to herd records",
      sessionId: "sess-1",
      toolCallId: "call-1",
      tables: ["animals"],
      rowCount: 1,
      undoneAt: null,
    },
  ];

  const requestMock = vi.fn(
    async <T extends Exclude<RequestType, "hello">>(
      type: T,
      params?: RequestParams<T>,
    ): Promise<RequestResult<T>> => {
      switch (type) {
        case "sessions.list":
          return { sessions } as RequestResult<T>;
        case "sessions.open": {
          const p = params as RequestParams<"sessions.open">;
          const found = sessions.find((s) => s.id === p.sessionId) ?? baseSession;
          return {
            session: found,
            items: [
              {
                kind: "user",
                id: "entry-user-1",
                ts: "2026-11-03T07:01:00.000Z",
                text: "List cows",
              },
              {
                kind: "assistant",
                id: "entry-asst-1",
                ts: "2026-11-03T07:01:02.000Z",
                text: "Here are your active dairy cows.",
              },
            ],
          } as RequestResult<T>;
        }
        case "sessions.create": {
          const created: SessionSummary = {
            id: `sess-${sessions.length + 1}`,
            title: "New conversation",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messageCount: 0,
            model: "orion-mock/mock-1",
            streaming: false,
            parentSessionId: null,
          };
          sessions.unshift(created);
          return { session: created } as RequestResult<T>;
        }
        case "sessions.rename": {
          const p = params as RequestParams<"sessions.rename">;
          const target = sessions.find((s) => s.id === p.sessionId);
          const updated: SessionSummary = {
            ...(target ?? baseSession),
            title: p.title,
          };
          return { session: updated } as RequestResult<T>;
        }
        case "sessions.fork": {
          const p = params as RequestParams<"sessions.fork">;
          const forked: SessionSummary = {
            ...baseSession,
            id: "sess-forked",
            title: `${baseSession.title} (copy)`,
            parentSessionId: p.sessionId,
          };
          sessions.unshift(forked);
          return { session: forked } as RequestResult<T>;
        }
        case "sessions.delete":
          return { deleted: true } as RequestResult<T>;
        case "chat.prompt":
          if (options.promptNeverResolves) return new Promise<RequestResult<T>>(() => {});
          return { accepted: true } as RequestResult<T>;
        case "chat.abort":
          return { accepted: options.abortAccepted ?? true } as RequestResult<T>;
        case "chat.steer":
        case "chat.followUp":
          return { accepted: true } as RequestResult<T>;
        case "settings.get":
          return settings as RequestResult<T>;
        case "settings.update": {
          const u = params as RequestParams<"settings.update">;
          const nextKeys = { ...settings.apiKeys };
          if (u.apiKey) {
            if (u.apiKey.key === null) {
              delete nextKeys[u.apiKey.provider];
            } else {
              nextKeys[u.apiKey.provider] = {
                configured: true,
                hint: `…${u.apiKey.key.slice(-4)}`,
              };
            }
          }
          settings = {
            ...settings,
            ...(u.provider !== undefined ? { provider: u.provider } : {}),
            ...(u.model !== undefined ? { model: u.model } : {}),
            ...(u.thinkingLevel ? { thinkingLevel: u.thinkingLevel } : {}),
            apiKeys: nextKeys,
          };
          return settings as RequestResult<T>;
        }
        case "snapshots.list":
          return { snapshots } as RequestResult<T>;
        case "snapshots.undo": {
          const p = params as RequestParams<"snapshots.undo">;
          const defaultSnap: SnapshotSummary = {
            id: "snap-1",
            createdAt: "2026-11-03T08:00:00.000Z",
            description: "Added Bella (DK-1001) to herd records",
            sessionId: "sess-1",
            toolCallId: "call-1",
            tables: ["animals"],
            rowCount: 1,
            undoneAt: null,
          };
          const snap = snapshots.find((s) => s.id === p.snapshotId) ?? snapshots[0] ?? defaultSnap;
          const undone: SnapshotSummary = {
            ...snap,
            undoneAt: "2026-11-03T08:10:00.000Z",
          };
          snapshots = snapshots.map((s) => (s.id === p.snapshotId ? undone : s));
          return {
            snapshot: undone,
            restored: [{ table: "animals", ids: ["a-1"] }],
          } as RequestResult<T>;
        }
        case "auth.providers":
          return { providers: structuredClone(providers) } as RequestResult<T>;
        case "auth.login":
          return { loginId: "login-1" } as RequestResult<T>;
        case "auth.respond":
        case "auth.cancel":
          return { accepted: true } as RequestResult<T>;
        case "modules.list":
          return modulesState as RequestResult<T>;
        case "modules.enable": {
          const p = params as RequestParams<"modules.enable">;
          modulesState = {
            modules: modulesState.modules.map((m) =>
              m.id === p.moduleId
                ? { ...m, enabled: true, enabledAt: "2026-11-09T09:00:00.000Z", enabledBy: "user" }
                : m,
            ),
          };
          return modulesState as RequestResult<T>;
        }
        case "modules.disable": {
          const p = params as RequestParams<"modules.disable">;
          modulesState = {
            modules: modulesState.modules.map((m) =>
              m.id === p.moduleId ? { ...m, enabled: false, enabledAt: null, enabledBy: null } : m,
            ),
          };
          return modulesState as RequestResult<T>;
        }
        default:
          throw new Error(`Unhandled request: ${type}`);
      }
    },
  );

  const client: OrionClient = {
    get state() {
      return currentState;
    },
    server: {
      protocolVersion: 1,
      serverVersion: "0.1.0",
      farmId: "farm-1",
    },
    request: requestMock as OrionClient["request"],
    query: vi.fn(),
    mutate: vi.fn(),
    on(type: string, handler: (event: never) => void) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      const fn = handler as (ev: ServerEvent) => void;
      set.add(fn);
      return () => set.delete(fn);
    },
    onState: () => () => {},
    ready: () => Promise.resolve(),
    close: vi.fn(),
  };

  return {
    client,
    requestMock,
    providers,
    emit(ev: ServerEvent) {
      for (const key of [ev.type, "*"]) {
        for (const fn of listeners.get(key) ?? []) {
          fn(ev);
        }
      }
    },
  };
}

describe("chatReducer streaming and lifecycle", () => {
  it("accumulates message deltas, updates tool calls, and settles cleanly", () => {
    let state = createInitialChatState("sess-1");
    state = chatReducer(state, {
      type: "session.opened",
      session: baseSession,
      items: [],
    });

    state = chatReducer(state, {
      type: "optimistic.user_message",
      text: "Find cameras on my network",
      id: "optimistic-1",
    });
    expect(state.streaming).toBe(true);
    expect(state.items).toHaveLength(1);

    state = chatReducer(state, {
      type: "server.event",
      event: {
        type: "message.end",
        sessionId: "sess-1",
        messageId: "msg_user_1",
        item: {
          kind: "user",
          id: "entry_u1",
          ts: "2026-11-03T07:00:01.000Z",
          text: "Find cameras on my network",
        },
      },
    });
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.id).toBe("entry_u1");

    state = chatReducer(state, {
      type: "server.event",
      event: {
        type: "tool.start",
        sessionId: "sess-1",
        toolCallId: "call_cam_1",
        name: "camera_discover",
        label: "Find cameras",
        args: { timeoutMs: 1500 },
      },
    });
    expect(state.items).toHaveLength(2);
    expect(state.items[1]?.kind).toBe("tool");

    state = chatReducer(state, {
      type: "server.event",
      event: {
        type: "tool.end",
        sessionId: "sess-1",
        toolCallId: "call_cam_1",
        result: "Found 1 camera: Axis Calving Pen",
        details: { cameras: [{ name: "Calving Pen" }] },
        isError: false,
        durationMs: 420,
      },
    });
    const toolItem = state.items[1] as ToolItem;
    expect(toolItem.status).toBe("done");
    expect(toolItem.durationMs).toBe(420);

    state = chatReducer(state, {
      type: "server.event",
      event: {
        type: "message.start",
        sessionId: "sess-1",
        messageId: "msg_a1",
        role: "assistant",
      },
    });
    state = chatReducer(state, {
      type: "server.event",
      event: {
        type: "message.delta",
        sessionId: "sess-1",
        messageId: "msg_a1",
        text: "Here is ",
      },
    });
    state = chatReducer(state, {
      type: "server.event",
      event: {
        type: "message.delta",
        sessionId: "sess-1",
        messageId: "msg_a1",
        text: "what I found.",
      },
    });
    expect(state.items[2]?.kind).toBe("assistant");
    if (state.items[2]?.kind === "assistant") {
      expect(state.items[2].text).toBe("Here is what I found.");
    }

    state = chatReducer(state, {
      type: "server.event",
      event: {
        type: "message.end",
        sessionId: "sess-1",
        messageId: "msg_a1",
        item: {
          kind: "assistant",
          id: "entry_a1",
          ts: "2026-11-03T07:00:03.000Z",
          text: "Here is what I found.",
        },
      },
    });

    state = chatReducer(state, {
      type: "server.event",
      event: {
        type: "agent.settled",
        sessionId: "sess-1",
        reason: "completed",
      },
    });
    expect(state.streaming).toBe(false);
    expect(state.settledReason).toBe("completed");
  });
});

describe("turn grouping", () => {
  it("splits at user messages, groups consecutive tools, and only times turns of a second or more", () => {
    const tool = (id: string, ts: string): ToolItem => ({
      kind: "tool",
      id,
      ts,
      toolCallId: id,
      name: "herd_query",
      label: "Look up the herd",
      args: {},
      status: "done",
      durationMs: 500,
    });
    const turns = buildTurns([
      { kind: "user", id: "u1", ts: "2026-11-03T07:00:00.000Z", text: "List cows" },
      tool("t1", "2026-11-03T07:00:01.000Z"),
      tool("t2", "2026-11-03T07:00:02.000Z"),
      { kind: "assistant", id: "a1", ts: "2026-11-03T07:00:04.000Z", text: "Here they are." },
      { kind: "user", id: "u2", ts: "2026-11-03T07:01:00.000Z", text: "Thanks" },
      { kind: "assistant", id: "a2", ts: "2026-11-03T07:01:00.400Z", text: "Anytime." },
    ]);

    expect(turns.map((t) => t.user?.id)).toEqual(["u1", "u2"]);
    const [first, second] = turns;
    if (!first || !second) throw new Error("expected two turns");
    expect(buildTurnBlocks(first.steps).map((b) => b.kind)).toEqual(["tools", "step"]);
    expect(turnDurationMs(first)).toBe(4000);
    expect(turnDurationMs(second)).toBeNull();
  });

  it("summarizes tool groups by kind with counts sorted descending and other last", () => {
    const mk = (id: string, name: string, status: ToolItem["status"] = "done"): ToolItem => ({
      kind: "tool",
      id,
      ts: "2026-11-03T07:00:01.000Z",
      toolCallId: id,
      name,
      label: name,
      args: {},
      status,
    });

    const summary = summarizeToolGroup([
      mk("t1", "local_ui_build"),
      mk("t2", "read"),
      mk("t3", "bash", "error"),
      mk("t4", "powershell"),
      mk("t5", "bash"),
      mk("t6", "read", "error"),
      mk("t7", "write"),
      mk("t8", "memory_remember"),
    ]);

    expect(summary.total).toBe(8);
    expect(summary.failed).toBe(2);
    expect(summary.kinds.map((k) => ({ kind: k.kind, count: k.count }))).toEqual([
      { kind: "commands", count: 3 },
      { kind: "filesRead", count: 2 },
      { kind: "filesChanged", count: 1 },
      { kind: "other", count: 2 },
    ]);
  });

  it("collapses consecutive calls with identical tool name and argument summary", () => {
    const mk = (
      id: string,
      name: string,
      args: Record<string, unknown>,
      durationMs?: number,
      status: ToolItem["status"] = "done",
    ): ToolItem => ({
      kind: "tool",
      id,
      ts: "2026-11-03T07:00:01.000Z",
      toolCallId: id,
      name,
      label: name,
      args,
      status,
      ...(durationMs !== undefined ? { durationMs } : {}),
    });

    const tools = [
      mk("c1", "computer", { action: "screenshot" }, 100),
      mk("c2", "computer", { action: "screenshot" }, 150),
      mk("c3", "computer", { action: "screenshot" }, 200, "error"),
      mk("c4", "computer", { action: "key", keys: "ctrl+s" }, 50),
      mk("c5", "computer", { action: "screenshot" }, 120),
    ];

    const runs = collapseToolRuns(tools, (tool) =>
      summarizeToolArgs(tool.name, tool.args, (k) => k),
    );
    expect(runs.map((r) => ({ name: r.item.name, arg: r.argSummary, count: r.count }))).toEqual([
      { name: "computer", arg: "screenshot", count: 3 },
      { name: "computer", arg: "key: ctrl+s", count: 1 },
      { name: "computer", arg: "screenshot", count: 1 },
    ]);
    expect(runs[0]?.item.durationMs).toBe(450);
    expect(runs[0]?.item.status).toBe("error");
  });

  it("keeps tool group collapsed when tools are running or failed and expands only on click", () => {
    const { client } = createMockClient();
    const mk = (
      id: string,
      name: string,
      args: Record<string, unknown>,
      status: ToolItem["status"],
    ): ToolItem => ({
      kind: "tool",
      id,
      ts: "2026-11-03T07:00:01.000Z",
      toolCallId: id,
      name,
      label: name,
      args,
      status,
    });

    const { rerender } = render(
      <AppProviders initialClient={client}>
        <Timeline
          items={[
            { kind: "user", id: "u1", ts: "2026-11-03T07:00:00.000Z", text: "Check" },
            mk("t1", "read", { path: "apps/orbit/src/app/shell.tsx" }, "done"),
            mk(
              "t2",
              "bash",
              { command: "git status", description: "Checking for unsaved changes" },
              "running",
            ),
          ]}
          streaming={true}
          runStartedAt="2026-11-03T07:00:00.000Z"
        />
      </AppProviders>,
    );

    expect(screen.getByTestId("tool-group-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("tool-group-live")).toHaveTextContent("Checking for unsaved changes");
    expect(screen.getByTestId("tool-group-live")).not.toHaveTextContent("git status");
    expect(screen.queryByTestId("tool-group-list")).not.toBeInTheDocument();

    rerender(
      <AppProviders initialClient={client}>
        <Timeline
          items={[
            { kind: "user", id: "u1", ts: "2026-11-03T07:00:00.000Z", text: "Check" },
            mk("t1", "read", { path: "apps/orbit/src/app/shell.tsx" }, "done"),
            mk("t2", "bash", { command: "git status" }, "error"),
            mk("t3", "bash", { command: "git status" }, "done"),
          ]}
          streaming={false}
          runStartedAt={null}
        />
      </AppProviders>,
    );

    expect(screen.getByTestId("tool-group-toggle")).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByTestId("tool-group-failed")).toBeInTheDocument();
    expect(screen.queryByTestId("tool-group-list")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("tool-group-toggle"));
    expect(screen.getByTestId("tool-group-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("tool-group-list")).toBeInTheDocument();
    expect(screen.getAllByTestId(/^tool-card-toggle-/)).toHaveLength(2);
    expect(screen.getByTestId("tool-card-repeat-t3")).toHaveTextContent("x2");
  });
});

describe("ToolCard states and animal mini-table", () => {
  it("renders running, done with animal mini-table, and error states", () => {
    const runningTool: ToolItem = {
      kind: "tool",
      id: "call-1",
      ts: "2026-11-03T07:00:00.000Z",
      toolCallId: "call-1",
      name: "herd_query",
      label: "Look up the herd",
      args: { species: "cattle" },
      status: "running",
    };

    const { rerender } = render(<ToolCard item={runningTool} />);
    expect(screen.getByText("Look up herd animals")).toBeInTheDocument();
    expect(screen.getByTestId("tool-card-status-call-1")).toHaveTextContent("Running");

    const doneTool: ToolItem = {
      ...runningTool,
      status: "done",
      durationMs: 185,
      result: "2 animals found.",
      details: {
        total: 2,
        rows: [
          {
            id: "a1",
            farmId: "f1",
            species: "cattle",
            name: "Bella",
            earTagNumber: "DK-1001",
            nationalId: null,
            breed: "Holstein",
            sex: "female",
            birthDate: "2022-03-14",
            groupName: "Milking",
            status: "active",
            notes: null,
            createdAt: "2026-11-01T00:00:00Z",
            updatedAt: "2026-11-01T00:00:00Z",
            deletedAt: null,
            hlc: "1",
            originDevice: "seed",
            wearable: {
              deviceId: "d1",
              kind: "bolus",
              vendor: "smaxtec",
              batteryPct: 92,
            },
          },
        ],
      },
    };

    rerender(<ToolCard item={doneTool} />);
    expect(screen.getByTestId("tool-card-status-call-1")).toHaveTextContent("Done");
    expect(screen.getByTestId("tool-card-duration-call-1")).toHaveTextContent("185 ms");

    fireEvent.click(screen.getByTestId("tool-card-toggle-call-1"));
    expect(screen.getByTestId("tool-card-animal-table-call-1")).toBeInTheDocument();
    expect(screen.getByText("Bella")).toBeInTheDocument();
    expect(screen.getByText("DK-1001")).toBeInTheDocument();
    expect(screen.getByText("bolus (92%)")).toBeInTheDocument();

    const failedTool: ToolItem = {
      ...runningTool,
      toolCallId: "call-2",
      id: "call-2",
      name: "device_bind",
      status: "error",
      isError: true,
      result: "Not done: this animal already wears a collar.",
    };

    rerender(<ToolCard key="call-2" item={failedTool} />);
    expect(screen.getByTestId("tool-card-error-summary-call-2")).toHaveTextContent(/Not done:/);
  });
});

describe("ChatPage and SettingsPage integration", () => {
  it("prefills composer from ?prompt= into a draft that becomes a session only on send", async () => {
    const { client, requestMock } = createMockClient();

    render(
      <MemoryRouter
        initialEntries={["/chat?prompt=Which%20cows%20had%20lower%20milk%20yield%20this%20week%3F"]}
      >
        <AppProviders initialClient={client}>
          <ChatPage />
        </AppProviders>
      </MemoryRouter>,
    );

    const input = screen.getByTestId("chat-composer-input") as HTMLTextAreaElement;
    expect(input.value).toBe("Which cows had lower milk yield this week?");

    await waitFor(() => {
      expect(screen.getByTestId("session-item-sess-1")).toBeInTheDocument();
    });
    expect(screen.getByTestId("chat-empty-state")).toBeInTheDocument();
    expect(requestMock).not.toHaveBeenCalledWith("sessions.create", expect.anything());

    fireEvent.click(screen.getByTestId("chat-send-button"));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("chat.prompt", {
        sessionId: "sess-2",
        text: "Which cows had lower milk yield this week?",
      });
    });
    expect(requestMock).toHaveBeenCalledWith("sessions.create", {});
    expect(screen.getByTestId("session-item-sess-2")).toHaveAttribute("data-active", "true");

    expect(screen.getByTestId("chat-steer-button")).toBeInTheDocument();
    expect(screen.getByTestId("chat-followup-button")).toBeInTheDocument();
  });

  it("New chat never persists an empty session and hides never-started ones from history", async () => {
    const emptySession: SessionSummary = {
      ...baseSession,
      id: "sess-empty",
      title: "New conversation",
      messageCount: 0,
    };
    const { client, requestMock } = createMockClient([emptySession]);

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProviders initialClient={client}>
          <ChatPage />
        </AppProviders>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("session-item-sess-1")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("session-item-sess-empty")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("session-open-sess-1"));
    await waitFor(() => {
      expect(screen.getByTestId("session-item-sess-1")).toHaveAttribute("data-active", "true");
    });

    fireEvent.click(screen.getByTestId("session-new-button"));
    expect(screen.getByTestId("chat-empty-state")).toBeInTheDocument();
    expect(screen.getByTestId("session-item-sess-1")).toHaveAttribute("data-active", "false");
    expect(screen.getAllByTestId(/^session-item-/)).toHaveLength(1);
    expect(requestMock).not.toHaveBeenCalledWith("sessions.create", expect.anything());
  });

  it("Stop ends the run locally when Orion has nothing running to abort", async () => {
    const { client, requestMock, emit } = createMockClient([], {
      promptNeverResolves: true,
      abortAccepted: false,
    });

    render(
      <MemoryRouter initialEntries={["/chat?s=sess-1"]}>
        <AppProviders initialClient={client}>
          <ChatPage />
        </AppProviders>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("session-item-sess-1")).toHaveAttribute("data-active", "true");
    });
    act(() =>
      emit({
        type: "session.updated",
        sessionId: "sess-1",
        session: { ...baseSession, streaming: true },
      }),
    );
    fireEvent.click(await screen.findByTestId("chat-composer-stop-button"));

    await waitFor(() => {
      expect(screen.queryByTestId("chat-composer-stop-button")).not.toBeInTheDocument();
    });
    expect(requestMock).toHaveBeenCalledWith("chat.abort", { sessionId: "sess-1" });
    expect(screen.queryByTestId("chat-streaming-indicator")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-send-button")).toBeInTheDocument();
  });

  it("queues Enter as a follow-up and Ctrl+Enter as a steer while the prompt request is still pending", async () => {
    const { client, requestMock, emit } = createMockClient([], { promptNeverResolves: true });

    render(
      <MemoryRouter initialEntries={["/chat?s=sess-1"]}>
        <AppProviders initialClient={client}>
          <ChatPage />
        </AppProviders>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("session-item-sess-1")).toHaveAttribute("data-active", "true");
    });
    fireEvent.change(screen.getByTestId("chat-composer-input"), {
      target: { value: "List cows" },
    });
    fireEvent.click(screen.getByTestId("chat-send-button"));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("chat.prompt", {
        sessionId: "sess-1",
        text: "List cows",
      });
    });
    act(() =>
      emit({
        type: "session.updated",
        sessionId: "sess-1",
        session: { ...baseSession, streaming: true },
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("chat-composer-stop-button")).toBeInTheDocument();
    });

    const input = screen.getByTestId("chat-composer-input");
    fireEvent.change(input, { target: { value: "Then check the heifers" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("chat.followUp", {
        sessionId: "sess-1",
        text: "Then check the heifers",
      });
    });
    expect(screen.getByTestId("queued-message")).toHaveTextContent("Then check the heifers");

    fireEvent.change(input, { target: { value: "Only the milking group" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("chat.steer", {
        sessionId: "sess-1",
        text: "Only the milking group",
      });
    });
    expect(screen.getAllByTestId("queued-message")).toHaveLength(2);

    act(() => {
      emit({ type: "message.start", sessionId: "sess-1", messageId: "msg_u1", role: "user" });
      emit({ type: "message.start", sessionId: "sess-1", messageId: "msg_u2", role: "user" });
      emit({ type: "message.start", sessionId: "sess-1", messageId: "msg_a2", role: "assistant" });
      emit({
        type: "message.end",
        sessionId: "sess-1",
        messageId: "msg_a2",
        item: {
          kind: "assistant",
          id: "entry-a2",
          ts: new Date().toISOString(),
          text: "Milking group only.",
        },
      });
    });
    await waitFor(() => {
      expect(screen.getAllByTestId("queued-message")).toHaveLength(1);
    });
    act(() =>
      emit({
        type: "message.end",
        sessionId: "sess-1",
        messageId: "msg_u2",
        item: {
          kind: "user",
          id: "entry-u2",
          ts: new Date().toISOString(),
          text: "Only the milking group",
        },
      }),
    );
    const steered = await screen.findByTestId("message-user-entry-u2");
    expect(steered).toHaveTextContent("Only the milking group");
    const reply = screen.getByTestId("message-assistant-entry-a2");
    expect(steered.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByTestId("queued-message")).toHaveLength(1);
  });

  it("adds an API key through the sign-in dialog without ever showing it, and undoes a snapshot", async () => {
    const { client, requestMock, providers, emit } = createMockClient();

    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <AppProviders initialClient={client}>
          <SettingsPage />
        </AppProviders>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId("providers-tab-apiKeys"));
    fireEvent.click(await screen.findByTestId("provider-connect-groq"));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("auth.login", {
        providerId: "groq",
        method: "api_key",
      });
    });
    await act(async () => {});

    act(() =>
      emit({
        type: "auth.prompt",
        loginId: "login-1",
        promptId: "p1",
        prompt: { type: "secret", message: "Enter your Groq API key" },
      }),
    );
    const keyInput = (await screen.findByTestId("login-prompt-input")) as HTMLInputElement;
    expect(keyInput.type).toBe("password");
    fireEvent.change(keyInput, { target: { value: "gsk-secret-8899" } });
    fireEvent.click(screen.getByTestId("login-prompt-submit"));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("auth.respond", {
        loginId: "login-1",
        promptId: "p1",
        value: "gsk-secret-8899",
      });
    });

    const groq = providers.find((p) => p.id === "groq");
    if (groq) groq.status = { configured: true, method: "api_key", source: "stored" };
    act(() =>
      emit({
        type: "auth.finished",
        loginId: "login-1",
        providerId: "groq",
        ok: true,
        cancelled: false,
      }),
    );
    expect(await screen.findByTestId("login-success")).toBeInTheDocument();
    expect(await screen.findByTestId("provider-status-groq")).toHaveTextContent("API key");
    expect(document.body.textContent).not.toContain("gsk-secret-8899");

    fireEvent.click(screen.getByTestId("settings-undo-last-button"));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("snapshots.undo", {
        snapshotId: "snap-1",
      });
    });
  });

  it("shows a subscription's sign-in link and code field, and cancels the sign-in on close", async () => {
    const { client, requestMock, emit } = createMockClient();

    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <AppProviders initialClient={client}>
          <SettingsPage />
        </AppProviders>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId("provider-connect-anthropic"));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("auth.login", {
        providerId: "anthropic",
        method: "oauth",
      });
    });
    await act(async () => {});
    act(() => {
      emit({
        type: "auth.notice",
        loginId: "login-1",
        notice: { type: "auth_url", url: "https://claude.ai/oauth/authorize?x=1", opened: true },
      });
      emit({
        type: "auth.prompt",
        loginId: "login-1",
        promptId: "p1",
        prompt: { type: "manual_code", message: "Paste the authorization code" },
      });
      emit({
        type: "auth.notice",
        loginId: "other-login",
        notice: { type: "info", message: "not for this dialog" },
      });
    });

    expect(await screen.findByTestId("login-open-link")).toHaveAttribute(
      "href",
      "https://claude.ai/oauth/authorize?x=1",
    );
    expect(screen.getByTestId("login-prompt-input")).toHaveAttribute("type", "text");
    expect(screen.queryByText("not for this dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("login-cancel"));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("auth.cancel", { loginId: "login-1" });
    });
    expect(screen.queryByTestId("login-dialog")).not.toBeInTheDocument();
  });
});

describe("returning to Chat", () => {
  beforeEach(() => window.sessionStorage.clear());
  afterEach(() => window.sessionStorage.clear());

  const openChat = (client: ReturnType<typeof createMockClient>["client"], url = "/chat") =>
    render(
      <MemoryRouter initialEntries={[url]}>
        <AppProviders initialClient={client}>
          <ChatPage />
        </AppProviders>
      </MemoryRouter>,
    );

  it("counts a conversation as recent up to the resume window and not after", () => {
    rememberChat("sess-1", 1_000);
    expect(lastChat(1_000 + RESUME_WINDOW_MS)).toEqual({ id: "sess-1", recent: true });
    expect(lastChat(1_001 + RESUME_WINDOW_MS)).toEqual({ id: "sess-1", recent: false });
  });

  it("opens the conversation used a moment ago", async () => {
    rememberChat("sess-1");
    const { client } = createMockClient();
    openChat(client);
    await waitFor(() => {
      expect(screen.getByTestId("session-item-sess-1")).toHaveAttribute("data-active", "true");
    });
  });

  it("starts a new conversation when the last one was used long ago, and remembers one opened now", async () => {
    rememberChat("sess-1", Date.now() - RESUME_WINDOW_MS - 1);
    const { client, requestMock } = createMockClient();
    const view = openChat(client);
    await waitFor(() => {
      expect(screen.getByTestId("session-item-sess-1")).toBeInTheDocument();
    });
    expect(screen.getByTestId("chat-empty-state")).toBeInTheDocument();
    expect(requestMock).not.toHaveBeenCalledWith("sessions.open", expect.anything());

    fireEvent.click(screen.getByTestId("session-open-sess-1"));
    await waitFor(() => {
      expect(screen.getByTestId("session-item-sess-1")).toHaveAttribute("data-active", "true");
    });
    view.unmount();
    expect(lastChat()).toEqual({ id: "sess-1", recent: true });
  });

  it("starts a new conversation after New chat, and when arriving with a question", async () => {
    rememberChat("sess-1");
    const first = createMockClient();
    const view = openChat(first.client);
    await waitFor(() => {
      expect(screen.getByTestId("session-item-sess-1")).toHaveAttribute("data-active", "true");
    });
    fireEvent.click(screen.getByTestId("session-new-button"));
    view.unmount();
    expect(lastChat()).toBeNull();

    rememberChat("sess-1");
    const second = createMockClient();
    openChat(second.client, "/chat?prompt=How%20is%20the%20herd%3F");
    await waitFor(() => {
      expect(screen.getByTestId("session-item-sess-1")).toBeInTheDocument();
    });
    expect(second.requestMock).not.toHaveBeenCalledWith("sessions.open", expect.anything());
  });
});
