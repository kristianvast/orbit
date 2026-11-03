import type {
  ConnectionState,
  OrionClient,
  RequestParams,
  RequestResult,
  RequestType,
  ServerEvent,
  SessionSummary,
  Settings,
  SnapshotSummary,
  ToolItem,
} from "@orbit/protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../../app/providers";
import SettingsPage from "../settings";
import ChatPage, {
  ApprovalCard,
  chatReducer,
  createInitialChatState,
  type PendingApprovalItem,
  resetPendingApprovalsForTests,
  ToolCard,
  usePendingApprovalCount,
} from "./index";

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

function createMockClient() {
  const currentState: ConnectionState = "open";
  const listeners = new Map<string, Set<(ev: ServerEvent) => void>>();

  const sessions: SessionSummary[] = [baseSession];
  let settings: Settings = {
    provider: "orion-mock",
    model: "mock-1",
    thinkingLevel: "off",
    approvalMode: "ask",
    apiKeys: {
      "orion-mock": { configured: true },
      anthropic: { configured: true, hint: "…9a2f" },
    },
    alwaysAllow: ["herd_query"],
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
        case "chat.steer":
        case "chat.followUp":
        case "chat.abort":
        case "approval.respond":
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
            ...(u.approvalMode ? { approvalMode: u.approvalMode } : {}),
            ...(u.alwaysAllow ? { alwaysAllow: u.alwaysAllow } : {}),
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
    emit(ev: ServerEvent) {
      for (const key of [ev.type, "*"]) {
        for (const fn of listeners.get(key) ?? []) {
          fn(ev);
        }
      }
    },
  };
}

function BadgeProbe() {
  const count = usePendingApprovalCount();
  return <span data-testid="nav-approval-probe">{count}</span>;
}

describe("chatReducer streaming and lifecycle", () => {
  it("accumulates message deltas, updates tool calls, tracks approvals, and settles cleanly", () => {
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
        type: "approval.request",
        sessionId: "sess-1",
        approvalId: "app_1",
        toolCallId: "call_cam_1",
        toolName: "camera_discover",
        title: "Look for cameras on your network",
        plainLanguage: "Orion wants to send a discovery message on your local network.",
        risk: "ask",
      },
    });
    expect(state.approvals).toHaveLength(1);
    expect(state.approvals[0]?.status).toBe("pending");

    state = chatReducer(state, {
      type: "server.event",
      event: {
        type: "approval.resolved",
        sessionId: "sess-1",
        approvalId: "app_1",
        decision: "allow_once",
        by: "user",
      },
    });
    expect(state.approvals[0]?.status).toBe("resolved");
    expect(state.approvals[0]?.decision).toBe("allow_once");

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

describe("ToolCard states and animal mini-table", () => {
  it("renders running, done with animal mini-table, and denied error states", () => {
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

    const deniedTool: ToolItem = {
      ...runningTool,
      toolCallId: "call-2",
      id: "call-2",
      name: "device_bind",
      status: "denied",
      isError: true,
      result: 'Not allowed: the farmer said no to "Change which sensor an animal wears".',
    };

    rerender(<ToolCard key="call-2" item={deniedTool} />);
    expect(screen.getByTestId("tool-card-status-call-2")).toHaveTextContent("Not allowed");
    expect(screen.getByTestId("tool-card-error-summary-call-2")).toHaveTextContent(/Not allowed:/);
  });
});

describe("ApprovalCard decisions and details", () => {
  it("renders notice, expands command details, and fires allow_once / always_allow / deny", async () => {
    const onRespond = vi.fn();
    const approval: PendingApprovalItem = {
      approvalId: "app-42",
      sessionId: "sess-1",
      toolCallId: "call-9",
      toolName: "bash",
      title: "Run a command",
      plainLanguage: "Orion wants to run a command in the farm workspace on this computer.",
      command: "ls -la connectors/",
      risk: "ask",
      status: "pending",
    };

    render(<ApprovalCard approval={approval} onRespond={onRespond} />);

    expect(screen.getByTestId("approval-notice-app-42")).toHaveTextContent(
      "AI can make mistakes. Check what Orion wants to do.",
    );

    fireEvent.click(screen.getByTestId("approval-details-toggle-app-42"));
    expect(screen.getByTestId("approval-command-app-42")).toHaveTextContent("ls -la connectors/");

    fireEvent.click(screen.getByTestId("approval-allow-once-app-42"));
    await waitFor(() => {
      expect(onRespond).toHaveBeenCalledWith("app-42", "allow_once");
    });

    fireEvent.click(screen.getByTestId("approval-always-allow-app-42"));
    await waitFor(() => {
      expect(onRespond).toHaveBeenCalledWith("app-42", "always_allow");
    });

    fireEvent.click(screen.getByTestId("approval-deny-app-42"));
    await waitFor(() => {
      expect(onRespond).toHaveBeenCalledWith("app-42", "deny");
    });
  });
});

describe("ChatPage and SettingsPage integration", () => {
  beforeEach(() => {
    resetPendingApprovalsForTests();
  });

  it("prefills composer from ?prompt=, switches between prompt and steer/followUp while streaming, and updates pending approval count", async () => {
    const { client, requestMock, emit } = createMockClient();

    render(
      <MemoryRouter
        initialEntries={["/chat?prompt=Which%20cows%20had%20lower%20milk%20yield%20this%20week%3F"]}
      >
        <AppProviders initialClient={client}>
          <BadgeProbe />
          <ChatPage />
        </AppProviders>
      </MemoryRouter>,
    );

    const input = screen.getByTestId("chat-composer-input") as HTMLTextAreaElement;
    expect(input.value).toBe("Which cows had lower milk yield this week?");

    await waitFor(() => {
      expect(screen.getByTestId("session-item-sess-1")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("chat-send-button"));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("chat.prompt", {
        sessionId: "sess-1",
        text: "Which cows had lower milk yield this week?",
      });
    });

    expect(screen.getByTestId("chat-steer-button")).toBeInTheDocument();
    expect(screen.getByTestId("chat-followup-button")).toBeInTheDocument();

    act(() => {
      emit({
        type: "approval.request",
        sessionId: "sess-1",
        approvalId: "app-live-1",
        toolName: "camera_discover",
        title: "Look for cameras on your network",
        plainLanguage: "Orion wants to scan for ONVIF cameras.",
        risk: "ask",
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("approval-card-app-live-1")).toBeInTheDocument();
      expect(screen.getByTestId("nav-approval-probe")).toHaveTextContent("1");
    });
  });

  it("renders SettingsPage, updates approval mode, saves API key without echoing it, and undoes snapshot", async () => {
    const { client, requestMock } = createMockClient();

    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <AppProviders initialClient={client}>
          <SettingsPage />
        </AppProviders>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("settings-provider-select")).toBeInTheDocument();
    });

    const keyInput = screen.getByTestId("settings-apikey-input") as HTMLInputElement;
    expect(keyInput.value).toBe("");
    fireEvent.change(keyInput, { target: { value: "sk-secret-key-8899" } });
    fireEvent.click(screen.getByTestId("settings-save-apikey-button"));

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("settings.update", {
        apiKey: { provider: "anthropic", key: "sk-secret-key-8899" },
      });
    });
    expect(keyInput.value).toBe("");
    expect(screen.getByTestId("settings-key-hint-anthropic")).toHaveTextContent("…8899");

    fireEvent.click(screen.getByTestId("settings-approval-mode-auto"));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("settings.update", {
        approvalMode: "auto",
      });
    });

    fireEvent.click(screen.getByTestId("settings-undo-last-button"));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("snapshots.undo", {
        snapshotId: "snap-1",
      });
    });
  });
});
