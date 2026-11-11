import {
  type ConnectionState,
  MODULE_IDS,
  type OrionClient,
  type OrionRequestError,
  type RequestParams,
  type RequestResult,
  type RequestType,
  type ServerEvent,
  type SessionSummary,
} from "@orbit/protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomePage } from "../../app/HomePage";
import { AppProviders } from "../../app/providers";
import { AppShell } from "../../app/shell";
import { translate } from "../../i18n";
import ChatPage, { summarizeToolArgs, ToolCard } from "../chat";
import {
  activityReducer,
  describeActivityRecord,
  ELAPSED_VISIBILITY_MS,
  formatActivityElapsed,
  type VoiceSdkStartInput,
  type VoiceSessionHandle,
  type VoiceStartSessionFn,
} from "./index";

const sessionA: SessionSummary = {
  id: "sess-1",
  title: "Morning barn check",
  createdAt: "2026-11-11T07:00:00.000Z",
  updatedAt: "2026-11-11T07:05:00.000Z",
  messageCount: 0,
  model: "orbit-gateway/orbit-default",
  streaming: false,
  parentSessionId: null,
};

function createFakeVoiceClient(
  options: {
    voiceStartError?: OrionRequestError;
    voiceTurnError?: Error;
    toolResponse?: { result: string; isError: boolean };
  } = {},
) {
  const listeners = new Map<string, Set<(ev: ServerEvent) => void>>();
  const stateListeners = new Set<(next: ConnectionState) => void>();
  let connState: ConnectionState = "open";

  const requestMock = vi.fn(
    async <T extends Exclude<RequestType, "hello">>(
      type: T,
      params?: RequestParams<T>,
    ): Promise<RequestResult<T>> => {
      switch (type) {
        case "sessions.create":
          return { session: sessionA } as RequestResult<T>;
        case "sessions.list":
          return { sessions: [{ ...sessionA, messageCount: 2 }] } as RequestResult<T>;
        case "sessions.open":
          return {
            session: { ...sessionA, messageCount: 2 },
            items: [
              {
                kind: "user",
                id: "u-1",
                ts: "2026-11-11T07:01:00.000Z",
                text: "How many cattle?",
                voice: true,
              },
              {
                kind: "assistant",
                id: "a-1",
                ts: "2026-11-11T07:01:02.000Z",
                text: "28 cattle.",
                voice: true,
              },
            ],
          } as RequestResult<T>;
        case "settings.get":
          return {
            provider: "orbit-gateway",
            model: "orbit-default",
            thinkingLevel: "off",
            shareAnonymousData: true,
            apiKeys: {},
            availableModels: [{ provider: "orbit-gateway", id: "orbit-default", name: "Orbit" }],
          } as RequestResult<T>;
        case "account.status":
          return {
            state: "signed_in",
            coreUrl: "https://api.pecorva.com",
            user: { id: "u-1", email: "farmer@example.com", name: "Astrid" },
            farm: { id: "f-1", name: "North Meadow", role: "owner" },
          } as RequestResult<T>;
        case "modules.list":
          return {
            modules: MODULE_IDS.map((id) => ({
              id,
              enabled: id === "herd",
              enabledAt: id === "herd" ? "2026-11-11T00:00:00Z" : null,
              enabledBy: id === "herd" ? "user" : null,
            })),
          } as RequestResult<T>;
        case "voice.start":
          if (options.voiceStartError) throw options.voiceStartError;
          return {
            voiceId: "voice-42",
            path: "/voice/tok-secret/voice-42",
            variables: { farm_name: "North Meadow", conversation_recap: "" },
          } as RequestResult<T>;
        case "voice.turn":
          if (options.voiceTurnError) throw options.voiceTurnError;
          return { accepted: true } as RequestResult<T>;
        case "voice.stop":
        case "chat.abort":
        case "chat.prompt":
          return { accepted: true } as RequestResult<T>;
        case "voice.tool": {
          const p = params as RequestParams<"voice.tool">;
          return (options.toolResponse ?? {
            result: JSON.stringify({ total: 28, rows: [] }),
            isError: p.name === "db_mutate" && Boolean((p.args as { fail?: boolean })?.fail),
          }) as RequestResult<T>;
        }
        default:
          throw new Error(`Unhandled request: ${type}`);
      }
    },
  );

  const queryMock = vi.fn(async (name: string) => {
    if (name === "farm.summary") {
      return {
        farm: { id: "f-1", name: "North Meadow" },
        counts: {
          cattle: 28,
          horses: 0,
          cameras: 0,
          camerasOnline: 0,
          connectors: 0,
          connectorsWithErrors: 0,
        },
        recentAlerts: [],
      };
    }
    return { rows: [], total: 28 };
  });

  const client: OrionClient = {
    get state() {
      return connState;
    },
    server: { protocolVersion: 1, serverVersion: "0.1.5", farmId: "f-1" },
    request: requestMock as OrionClient["request"],
    query: queryMock as OrionClient["query"],
    mutate: vi.fn(),
    on(type: string, handler: (event: never) => void) {
      const set = listeners.get(type) ?? new Set();
      listeners.set(type, set);
      const fn = handler as (ev: ServerEvent) => void;
      set.add(fn);
      return () => set.delete(fn);
    },
    onState(fn) {
      stateListeners.add(fn);
      return () => stateListeners.delete(fn);
    },
    ready: () => Promise.resolve(),
    close: vi.fn(),
  };

  return {
    client,
    requestMock,
    emit(ev: ServerEvent) {
      for (const key of [ev.type, "*"]) {
        for (const fn of listeners.get(key) ?? []) fn(ev);
      }
    },
    setConnectionState(next: ConnectionState) {
      connState = next;
      for (const fn of stateListeners) fn(next);
    },
  };
}

function createFakeStartSession(options: { micUnavailable?: boolean } = {}) {
  let capturedInput: VoiceSdkStartInput | null = null;
  const sendUserMessage = vi.fn();
  const endSession = vi.fn(async () => undefined);
  const setMicMuted = vi.fn();

  const handle: VoiceSessionHandle = {
    type: options.micUnavailable ? "text" : "voice",
    endSession,
    sendUserMessage,
    setMicMuted,
    getInputVolume: () => 0.25,
    getOutputVolume: () => 0.4,
  };

  const startSession: VoiceStartSessionFn = vi.fn(async (input) => {
    capturedInput = input;
    input.onStatusChange("connected");
    return { session: handle, micUnavailable: Boolean(options.micUnavailable) };
  });

  return {
    startSession,
    sendUserMessage,
    endSession,
    setMicMuted,
    getInput: () => {
      if (!capturedInput) throw new Error("startSession was not called");
      return capturedInput;
    },
  };
}

function RouteJumpProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div>
      <span data-testid="current-path">{location.pathname}</span>
      <button type="button" onClick={() => void navigate("/settings")} data-testid="go-settings">
        Go settings
      </button>
    </div>
  );
}

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("VoiceProvider lifecycle and surfaces", () => {
  it("starts from Home without navigating, forwards clientTools, turns, and voice.note, and transitions across dock and chat stage", async () => {
    const { client, requestMock, emit } = createFakeVoiceClient();
    const fakeSdk = createFakeStartSession();

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders
          initialClient={client}
          initialEndpoint={{ url: "ws://127.0.0.1:7851/ws", token: "qa" }}
          initialLocale="en"
          voiceStartSession={fakeSdk.startSession}
        >
          <RouteJumpProbe />
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<HomePage />} />
              <Route path="chat" element={<ChatPage />} />
              <Route path="settings" element={<div data-testid="settings-stub">Settings</div>} />
            </Route>
          </Routes>
        </AppProviders>
      </MemoryRouter>,
    );

    const widget = await screen.findByTestId("home-orion-widget");
    expect(widget).toHaveAttribute("data-voice-state", "idle");

    fireEvent.click(screen.getByTestId("home-voice-start"));

    await waitFor(() => expect(widget).toHaveAttribute("data-voice-state", "listening"));
    expect(screen.getByTestId("current-path")).toHaveTextContent("/");
    expect(screen.queryByTestId("voice-dock")).not.toBeInTheDocument();

    const sdkInput = fakeSdk.getInput();
    expect(sdkInput.signedUrl).toBe("ws://127.0.0.1:7851/voice/tok-secret/voice-42");
    expect(sdkInput.dynamicVariables).toEqual({
      farm_name: "North Meadow",
      conversation_recap: "",
    });

    sdkInput.onClientToolDispatched("db_query", "mock-1", { query: "animals.list", params: {} });
    const toolOut = await sdkInput.clientTools.db_query({ query: "animals.list", params: {} });
    expect(JSON.parse(toolOut)).toEqual({ total: 28, rows: [] });
    expect(requestMock).toHaveBeenCalledWith("voice.tool", {
      voiceId: "voice-42",
      toolCallId: "mock-1",
      name: "db_query",
      args: { query: "animals.list", params: {} },
    });

    sdkInput.onClientToolDispatched("db_mutate", "mock-2", { fail: true });
    await expect(sdkInput.clientTools.db_mutate({ fail: true })).rejects.toThrow();

    act(() => {
      sdkInput.onMessage({ role: "agent", message: "Hello, Orion here." });
    });
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("voice.turn", {
        voiceId: "voice-42",
        role: "assistant",
        text: "Hello, Orion here.",
      }),
    );

    const textInput = screen.getByTestId("voice-text-input");
    fireEvent.change(textInput, { target: { value: "How many cattle do we have?" } });
    fireEvent.submit(screen.getByTestId("voice-text-form"));

    await waitFor(() =>
      expect(fakeSdk.sendUserMessage).toHaveBeenCalledWith("How many cattle do we have?"),
    );
    expect(requestMock).toHaveBeenCalledWith("voice.turn", {
      voiceId: "voice-42",
      role: "user",
      text: "How many cattle do we have?",
    });

    const turnCallsBeforeNote = requestMock.mock.calls.filter((c) => c[0] === "voice.turn").length;
    act(() => {
      emit({
        type: "voice.note",
        sessionId: "sess-1",
        voiceId: "voice-42",
        text: "Morning check page is ready.",
      });
    });
    expect(fakeSdk.sendUserMessage).toHaveBeenCalledWith(
      "[Orion update] Morning check page is ready.",
    );
    expect(requestMock.mock.calls.filter((c) => c[0] === "voice.turn").length).toBe(
      turnCallsBeforeNote,
    );

    fireEvent.click(screen.getByTestId("go-settings"));
    expect(await screen.findByTestId("settings-stub")).toBeInTheDocument();
    const dock = await screen.findByTestId("voice-dock");
    expect(dock).toHaveAttribute("data-voice-state", "listening");

    fireEvent.click(screen.getByTestId("voice-dock-open-chat"));
    const stage = await screen.findByTestId("voice-stage");
    expect(stage).toHaveAttribute("data-voice-state", "listening");
    expect(screen.queryByTestId("voice-dock")).not.toBeInTheDocument();
    expect(stage.closest(".orbit-thread-pane")).toHaveAttribute("data-voice", "on");
    expect(screen.getAllByTestId("message-voice-mark").length).toBe(2);

    fireEvent.click(screen.getByTestId("voice-end"));
    await waitFor(() => expect(fakeSdk.endSession).toHaveBeenCalledTimes(1));
    expect(requestMock).toHaveBeenCalledWith("voice.stop", { voiceId: "voice-42" });
  });

  it("keeps typed input working and shows a microphone notice when no microphone is available", async () => {
    const { client, requestMock } = createFakeVoiceClient();
    const fakeSdk = createFakeStartSession({ micUnavailable: true });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders
          initialClient={client}
          initialLocale="en"
          voiceStartSession={fakeSdk.startSession}
        >
          <HomePage />
        </AppProviders>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId("home-voice-start"));
    const widget = screen.getByTestId("home-orion-widget");
    await waitFor(() => expect(widget).toHaveAttribute("data-voice-state", "listening"));
    expect(screen.getByTestId("voice-mic-error")).toBeInTheDocument();

    const input = screen.getByTestId("voice-text-input");
    expect(input).not.toBeDisabled();
    fireEvent.change(input, { target: { value: "Check herd count" } });
    fireEvent.submit(screen.getByTestId("voice-text-form"));

    await waitFor(() => expect(fakeSdk.sendUserMessage).toHaveBeenCalledWith("Check herd count"));
    expect(requestMock).toHaveBeenCalledWith("voice.turn", {
      voiceId: "voice-42",
      role: "user",
      text: "Check herd count",
    });
  });

  it("releases the call when the Orion connection drops", async () => {
    const { client, setConnectionState } = createFakeVoiceClient();
    const fakeSdk = createFakeStartSession();

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders
          initialClient={client}
          initialLocale="en"
          voiceStartSession={fakeSdk.startSession}
        >
          <HomePage />
        </AppProviders>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId("home-voice-start"));
    await waitFor(() =>
      expect(screen.getByTestId("home-orion-widget")).toHaveAttribute(
        "data-voice-state",
        "listening",
      ),
    );

    act(() => {
      setConnectionState("reconnecting");
    });

    await waitFor(() => expect(fakeSdk.endSession).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("home-orion-widget")).toHaveAttribute("data-voice-state", "ended");
  });

  it("tells the farmer when a spoken turn could not be saved", async () => {
    const { client } = createFakeVoiceClient({
      voiceTurnError: new Error("The conversation could not be saved."),
    });
    const fakeSdk = createFakeStartSession();

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders
          initialClient={client}
          initialLocale="en"
          voiceStartSession={fakeSdk.startSession}
        >
          <HomePage />
        </AppProviders>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId("home-voice-start"));
    await waitFor(() =>
      expect(screen.getByTestId("home-orion-widget")).toHaveAttribute(
        "data-voice-state",
        "listening",
      ),
    );

    act(() => {
      fakeSdk.getInput().onMessage({ role: "agent", message: "The herd is fine." });
    });

    expect(await screen.findByTestId("voice-error")).toHaveTextContent(
      "The conversation could not be saved.",
    );
  });

  it("uses the single chat composer to send typed messages into an active call and resumes chat.prompt after ending", async () => {
    const { client, requestMock } = createFakeVoiceClient();
    const fakeSdk = createFakeStartSession();

    render(
      <MemoryRouter initialEntries={["/chat?s=sess-1"]}>
        <AppProviders
          initialClient={client}
          initialLocale="en"
          voiceStartSession={fakeSdk.startSession}
        >
          <ChatPage />
        </AppProviders>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId("chat-voice-button"));
    const stage = await screen.findByTestId("voice-stage");
    await waitFor(() => expect(stage).toHaveAttribute("data-voice-state", "listening"));
    expect(within(stage).queryByTestId("voice-text-input")).toBeNull();

    const composer = screen.getByTestId("chat-composer-input");
    fireEvent.change(composer, { target: { value: "Check dry cows" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    await waitFor(() => expect(fakeSdk.sendUserMessage).toHaveBeenCalledWith("Check dry cows"));
    expect(requestMock).toHaveBeenCalledWith("voice.turn", {
      voiceId: "voice-42",
      role: "user",
      text: "Check dry cows",
    });
    expect(requestMock).not.toHaveBeenCalledWith("chat.prompt", expect.anything());

    fireEvent.click(screen.getByTestId("voice-end"));
    await waitFor(() => expect(screen.queryByTestId("voice-stage")).not.toBeInTheDocument());

    fireEvent.change(composer, { target: { value: "Text follow-up after call" } });
    fireEvent.click(screen.getByTestId("chat-send-button"));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("chat.prompt", {
        sessionId: "sess-1",
        text: "Text follow-up after call",
      }),
    );
  });
});

describe("Saved voice tool cards in Chat timeline", () => {
  it("renders plain-language summaries for db_query and db_mutate in English and Norwegian while keeping technical inputs inside expanded details", () => {
    const tEn = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) =>
      translate("en", key, vars);
    const tNb = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) =>
      translate("nb", key, vars);

    for (const [name, args] of [
      ["db_query", { query: "animals.list", params: {} }],
      ["db_query", { query: "animals.get", params: { id: "a-1" } }],
      ["db_query", { query: "observations.recent", params: {} }],
      ["db_mutate", { mutation: "observations.add", params: { kind: "health_event" } }],
      ["db_mutate", { mutation: "animals.upsert", params: {} }],
    ] as const) {
      const enSummary = summarizeToolArgs(name, args, tEn);
      const nbSummary = summarizeToolArgs(name, args, tNb);
      expect(enSummary.length).toBeGreaterThan(0);
      expect(nbSummary.length).toBeGreaterThan(0);
      expect(enSummary).not.toMatch(/\./);
      expect(nbSummary).not.toMatch(/\./);
    }

    const { client } = createFakeVoiceClient();
    render(
      <AppProviders initialClient={client} initialLocale="en">
        <ToolCard
          item={{
            kind: "tool",
            id: "tc-db-1",
            ts: "2026-11-11T08:00:00.000Z",
            toolCallId: "tc-db-1",
            name: "db_query",
            label: "Read farm records",
            args: { query: "animals.list", params: {} },
            status: "done",
            result: JSON.stringify({ rows: [], total: 24 }),
            durationMs: 2,
          }}
        />
      </AppProviders>,
    );

    const card = screen.getByTestId("tool-card-tc-db-1");
    expect(card).not.toHaveTextContent("animals.list");
    fireEvent.click(screen.getByTestId("tool-card-toggle-tc-db-1"));
    expect(screen.getByTestId("tool-card-args-tc-db-1")).toHaveTextContent("animals.list");
  });
});

describe("Activity model reducer and plain-language formatting", () => {
  const tEn = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) =>
    translate("en", key, vars);

  it("tracks running, done, error, and handed-over orion_task stop/settle transitions without leaking raw tool syntax", () => {
    let state = activityReducer([], {
      type: "tool.start",
      now: 1_000,
      ev: {
        type: "tool.start",
        sessionId: "s-1",
        toolCallId: "c-1",
        name: "db_query",
        label: "db_query",
        args: { query: "animals.list", params: {} },
      },
    });
    const firstRunning = state[0];
    if (!firstRunning) throw new Error("expected activity record");
    let view = describeActivityRecord(firstRunning, tEn, "cattle");
    expect(view.status).toBe("running");
    expect(view.canStop).toBe(false);
    expect(view.text).not.toMatch(/[{}[\]_]|\b(tool|function)\b/i);

    state = activityReducer(state, {
      type: "tool.end",
      now: 1_800,
      ev: {
        type: "tool.end",
        sessionId: "s-1",
        toolCallId: "c-1",
        result: JSON.stringify({ total: 28, rows: [] }),
        details: null,
        isError: false,
        durationMs: 18,
      },
    });
    const firstDone = state[0];
    if (!firstDone) throw new Error("expected activity record");
    view = describeActivityRecord(firstDone, tEn, "cattle");
    expect(view.status).toBe("done");
    expect(view.text).toContain("28");
    expect(view.text).not.toMatch(/[{}[\]_]|\b(tool|function)\b/i);

    state = activityReducer(state, {
      type: "tool.start",
      now: 2_000,
      ev: {
        type: "tool.start",
        sessionId: "s-1",
        toolCallId: "c-2",
        name: "orion_task",
        label: "orion_task",
        args: { request: "Build morning check page" },
      },
    });
    state = activityReducer(state, {
      type: "tool.end",
      now: 2_100,
      ev: {
        type: "tool.end",
        sessionId: "s-1",
        toolCallId: "c-2",
        result: "started",
        details: null,
        isError: false,
        durationMs: 9,
      },
    });
    const secondTask = state[1];
    if (!secondTask) throw new Error("expected task record");
    const runningTask = describeActivityRecord(secondTask, tEn, "cattle");
    expect(runningTask.status).toBe("running");
    expect(runningTask.canStop).toBe(true);

    state = activityReducer(state, {
      type: "tool.start",
      now: 2_200,
      ev: {
        type: "tool.start",
        sessionId: "s-1",
        toolCallId: "c-3",
        name: "internal_custom_helper",
        label: "Tool call",
        args: { raw: 1 },
      },
    });
    const thirdRow = state[2];
    if (!thirdRow) throw new Error("expected fallback record");
    const fallbackRow = describeActivityRecord(thirdRow, tEn, "cattle");
    expect(fallbackRow.text).not.toMatch(/internal_custom_helper|[{}[\]_]|\b(tool|function)\b/i);

    state = activityReducer(state, {
      type: "agent.settled",
      now: 5_500,
      ev: { type: "agent.settled", sessionId: "s-1", reason: "aborted" },
    });
    const settledTask = state[1];
    if (!settledTask) throw new Error("expected settled task");
    expect(settledTask.status).toBe("stopped");
    expect(state[2]?.status).toBe("stopped");
    expect(describeActivityRecord(settledTask, tEn, "cattle").canStop).toBe(false);
  });

  it("shows elapsed time only once ELAPSED_VISIBILITY_MS has passed", () => {
    expect(formatActivityElapsed(1_000, 1_000 + ELAPSED_VISIBILITY_MS - 1, tEn)).toBeNull();
    expect(formatActivityElapsed(1_000, 1_000 + ELAPSED_VISIBILITY_MS + 1_000, tEn)).toBe("4s");
  });

  it("keeps status as stopped when tool.end or voice.note arrives after agent.settled aborted", () => {
    let state = activityReducer([], {
      type: "tool.start",
      now: 1_000,
      ev: {
        type: "tool.start",
        sessionId: "s-1",
        toolCallId: "task-stop-1",
        name: "orion_task",
        label: "Ask Orion to work",
        args: { request: "build me a calving overview" },
      },
    });
    state = activityReducer(state, {
      type: "agent.settled",
      now: 2_500,
      ev: { type: "agent.settled", sessionId: "s-1", reason: "aborted" },
    });
    expect(state[0]?.status).toBe("stopped");

    state = activityReducer(state, {
      type: "tool.end",
      now: 2_550,
      ev: {
        type: "tool.end",
        sessionId: "s-1",
        toolCallId: "task-stop-1",
        result: "It was stopped.",
        details: null,
        isError: false,
        durationMs: 1_550,
      },
    });
    expect(state[0]?.status).toBe("stopped");
    expect(state[0]?.result).toBe("It was stopped.");

    state = activityReducer(state, { type: "voice.note", now: 2_600 });
    expect(state[0]?.status).toBe("stopped");
  });
});
