import {
  type AccountStatus,
  type BillingStatus,
  type ConnectionState,
  type OrionClient,
  OrionRequestError,
  type RequestParams,
  type RequestResult,
  type RequestType,
  type ServerEvent,
  type SessionSummary,
} from "@orbit/protocol";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../../app/providers";
import { AccountCard } from "../settings";
import ChatPage, { base64ToPcm16Float32, pcm16ToBase64, resampleTo16kHzPcm16 } from "./index";

const baseSession: SessionSummary = {
  id: "sess-voice-1",
  title: "Evening calving check",
  createdAt: "2026-11-06T18:00:00.000Z",
  updatedAt: "2026-11-06T18:05:00.000Z",
  messageCount: 1,
  model: "orbit-gateway/orbit-default",
  streaming: false,
  parentSessionId: null,
};

const signedInAccount: AccountStatus = {
  state: "signed_in",
  coreUrl: "https://api.pecorva.com",
  user: { id: "u-1", email: "astrid@pecorva.com", name: "Astrid" },
  farm: { id: "f-1", name: "North Meadow Farm", role: "owner" },
};

const freeBilling: BillingStatus = {
  plan: "free",
  interval: null,
  status: "inactive",
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  usage: { tokensUsed: 0, tokenAllowance: 0, voiceSecondsUsed: 0, voiceSecondsAllowance: 0 },
};

const paidBarnBilling: BillingStatus = {
  plan: "barn",
  interval: "month",
  status: "active",
  currentPeriodEnd: "2026-12-06T00:00:00.000Z",
  cancelAtPeriodEnd: false,
  usage: {
    tokensUsed: 4_500_000,
    tokenAllowance: 15_000_000,
    voiceSecondsUsed: 3_600,
    voiceSecondsAllowance: 18_000,
  },
};

function createBillingVoiceClient(
  options: { billing?: BillingStatus; promptErrorCode?: "plan_required" | "budget_exceeded" } = {},
) {
  const listeners = new Map<string, Set<(ev: ServerEvent) => void>>();
  let currentBilling: BillingStatus = options.billing ?? freeBilling;

  const requestMock = vi.fn(
    async <T extends Exclude<RequestType, "hello">>(
      type: T,
      _params?: RequestParams<T>,
    ): Promise<RequestResult<T>> => {
      switch (type) {
        case "account.status":
          return signedInAccount as RequestResult<T>;
        case "billing.status":
          return currentBilling as RequestResult<T>;
        case "billing.checkout":
          return { url: "https://checkout.stripe.com/c/pay/cs_test_orbit" } as RequestResult<T>;
        case "billing.portal":
          return { url: "https://billing.stripe.com/p/session/test_portal" } as RequestResult<T>;
        case "sessions.list":
          return { sessions: [baseSession] } as RequestResult<T>;
        case "sessions.create":
          return { session: baseSession } as RequestResult<T>;
        case "sessions.open":
          return { session: baseSession, items: [] } as RequestResult<T>;
        case "settings.get":
          return {
            provider: "orbit-gateway",
            model: "orbit-default",
            thinkingLevel: "off",
            apiKeys: {},
            availableModels: [
              { provider: "orbit-gateway", id: "orbit-default", name: "Orbit (subscription)" },
            ],
          } as RequestResult<T>;
        case "chat.prompt":
          if (options.promptErrorCode) {
            throw new OrionRequestError(
              options.promptErrorCode,
              "Choose a plan or use your own AI key in Providers.",
            );
          }
          return { accepted: true } as RequestResult<T>;
        case "voice.start": {
          const p = _params as RequestParams<"voice.start">;
          queueMicrotask(() => {
            for (const key of ["voice.state", "*"]) {
              for (const fn of listeners.get(key) ?? []) {
                fn({
                  type: "voice.state",
                  sessionId: p.sessionId,
                  voiceId: "voice-1",
                  state: "listening",
                });
              }
            }
          });
          return { voiceId: "voice-1" } as RequestResult<T>;
        }
        case "voice.stop": {
          const p = _params as RequestParams<"voice.stop">;
          queueMicrotask(() => {
            for (const key of ["voice.state", "*"]) {
              for (const fn of listeners.get(key) ?? []) {
                fn({
                  type: "voice.state",
                  sessionId: baseSession.id,
                  voiceId: p.voiceId,
                  state: "stopped",
                });
              }
            }
          });
          return { accepted: true } as RequestResult<T>;
        }
        case "voice.audio":
        case "voice.text":
          return { accepted: true } as RequestResult<T>;
        default:
          throw new Error(`Unhandled request: ${type}`);
      }
    },
  );

  const client: OrionClient = {
    state: "open" as ConnectionState,
    server: { protocolVersion: 1, serverVersion: "0.1.0", farmId: "f-1" },
    request: requestMock as OrionClient["request"],
    query: vi.fn(),
    mutate: vi.fn(),
    on(type: string, handler: (event: never) => void) {
      const set = listeners.get(type) ?? new Set();
      listeners.set(type, set);
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
    setBilling(next: BillingStatus) {
      currentBilling = next;
    },
    emit(ev: ServerEvent) {
      for (const key of [ev.type, "*"]) {
        for (const fn of listeners.get(key) ?? []) fn(ev);
      }
    },
  };
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="route-probe">{`${loc.pathname}${loc.hash}`}</div>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AccountCard billing plans and usage meters", () => {
  it("renders free and paid plans with meters and calls billing.checkout with the picked plan", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const { client, requestMock, setBilling } = createBillingVoiceClient({ billing: freeBilling });

    const { rerender } = render(
      <MemoryRouter>
        <AppProviders initialClient={client}>
          <AccountCard status={signedInAccount} onStatus={() => {}} />
        </AppProviders>
      </MemoryRouter>,
    );

    await waitFor(() => expect(requestMock).toHaveBeenCalledWith("billing.status", {}));
    expect(screen.getByTestId("billing-plan-name")).toHaveTextContent("Free (bring your own key)");
    expect(screen.getByTestId("billing-free-copy")).toHaveTextContent(
      /Orbit and Orion are open source and free/,
    );
    expect(screen.getByTestId("billing-meter-tokens-value")).toHaveTextContent("0 / 0 tokens");
    expect(screen.getByTestId("billing-meter-voice-value")).toHaveTextContent("0 / 0 min");

    fireEvent.click(screen.getByTestId("billing-interval-year"));
    fireEvent.click(screen.getByTestId("billing-plan-barn"));
    fireEvent.click(screen.getByTestId("billing-checkout-button"));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("billing.checkout", {
        plan: "barn",
        interval: "year",
      }),
    );
    expect(openSpy).toHaveBeenCalledWith(
      "https://checkout.stripe.com/c/pay/cs_test_orbit",
      "_blank",
      "noopener,noreferrer",
    );

    setBilling(paidBarnBilling);
    rerender(
      <MemoryRouter>
        <AppProviders initialClient={client}>
          <AccountCard status={{ ...signedInAccount }} onStatus={() => {}} />
        </AppProviders>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId("billing-plan-name")).toHaveTextContent("Barn"));
    expect(screen.getByTestId("billing-status-badge")).toHaveTextContent("Active");
    expect(screen.getByTestId("billing-meter-tokens-value")).toHaveTextContent(
      "4,500,000 / 15,000,000 tokens",
    );
    expect(screen.getByTestId("billing-meter-voice-value")).toHaveTextContent("60 / 300 min");

    fireEvent.click(screen.getByTestId("billing-portal-button"));
    await waitFor(() => expect(requestMock).toHaveBeenCalledWith("billing.portal", {}));
    expect(openSpy).toHaveBeenCalledWith(
      "https://billing.stripe.com/p/session/test_portal",
      "_blank",
      "noopener,noreferrer",
    );
  });
});

describe("Chat plan_required card", () => {
  it("renders plan_required card with both actions and navigates to Providers or Account", async () => {
    const { client } = createBillingVoiceClient({ promptErrorCode: "plan_required" });

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProviders initialClient={client}>
          <Routes>
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/settings" element={<LocationProbe />} />
          </Routes>
        </AppProviders>
      </MemoryRouter>,
    );

    const input = await screen.findByTestId("chat-composer-input");
    fireEvent.change(input, { target: { value: "Check calving pen cows" } });
    fireEvent.click(screen.getByTestId("chat-send-button"));

    const card = await screen.findByTestId("chat-plan-error-card");
    expect(card).toHaveAttribute("data-error-code", "plan_required");
    expect(screen.getByTestId("chat-plan-error-use-key")).toHaveTextContent("Use your own key");
    expect(screen.getByTestId("chat-plan-error-see-plans")).toHaveTextContent("See plans");

    fireEvent.click(screen.getByTestId("chat-plan-error-use-key"));
    expect(await screen.findByTestId("route-probe")).toHaveTextContent("/settings#providers");
  });
});

describe("VoicePanel transcript, tool card, and audio helpers", () => {
  it("opens voice panel on a draft conversation without re-triggering voice.stop when sessionId is created", async () => {
    const { client, requestMock } = createBillingVoiceClient();

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProviders initialClient={client}>
          <ChatPage />
        </AppProviders>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId("chat-voice-button"));
    await waitFor(() =>
      expect(screen.getByTestId("voice-state-badge")).toHaveTextContent("Listening"),
    );
    expect(requestMock).toHaveBeenCalledWith("voice.start", { sessionId: "sess-voice-1" });
    expect(requestMock).not.toHaveBeenCalledWith("voice.stop", expect.anything());
  });

  it("opens voice panel, accumulates transcript chunks and tool card from mocked events, and stops cleanly", async () => {
    const { client, requestMock, emit } = createBillingVoiceClient();

    render(
      <MemoryRouter initialEntries={["/chat?s=sess-voice-1"]}>
        <AppProviders initialClient={client}>
          <ChatPage />
        </AppProviders>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId("chat-voice-button"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("voice.start", { sessionId: "sess-voice-1" }),
    );
    expect(screen.getByTestId("voice-panel")).toBeInTheDocument();

    act(() => {
      emit({
        type: "voice.state",
        sessionId: "sess-voice-1",
        voiceId: "voice-1",
        state: "listening",
      });
      emit({
        type: "voice.transcript",
        sessionId: "sess-voice-1",
        voiceId: "voice-1",
        role: "user",
        text: "How many cows ",
        final: false,
      });
      emit({
        type: "voice.transcript",
        sessionId: "sess-voice-1",
        voiceId: "voice-1",
        role: "user",
        text: "are in the calving pen?",
        final: true,
      });
      emit({
        type: "voice.tool",
        sessionId: "sess-voice-1",
        voiceId: "voice-1",
        toolCallId: "vcall-1",
        name: "db_query",
        state: "running",
        args: { query: "animals.list", params: { groupName: "Calving" } },
      });
    });

    expect(screen.getByTestId("voice-state-badge")).toHaveTextContent("Listening");
    expect(screen.getByTestId("voice-transcript-user")).toHaveTextContent(
      "How many cows are in the calving pen?",
    );
    expect(screen.getByTestId("tool-card-vcall-1")).toHaveAttribute("data-tool-status", "running");

    act(() => {
      emit({
        type: "voice.tool",
        sessionId: "sess-voice-1",
        voiceId: "voice-1",
        toolCallId: "vcall-1",
        name: "db_query",
        state: "done",
        result: JSON.stringify({ result: { rows: [], total: 2 } }),
        isError: false,
      });
      emit({
        type: "voice.transcript",
        sessionId: "sess-voice-1",
        voiceId: "voice-1",
        role: "assistant",
        text: "Two cows are ",
        final: false,
      });
      emit({
        type: "voice.transcript",
        sessionId: "sess-voice-1",
        voiceId: "voice-1",
        role: "assistant",
        text: "in the calving pen right now.",
        final: true,
      });
    });

    expect(screen.getByTestId("tool-card-vcall-1")).toHaveAttribute("data-tool-status", "done");
    expect(screen.getByTestId("voice-transcript-assistant")).toHaveTextContent(
      "Two cows are in the calving pen right now.",
    );

    fireEvent.click(screen.getByTestId("voice-stop-button"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("voice.stop", { voiceId: "voice-1" }),
    );
  });

  it("resamples Float32 audio to 16 kHz PCM16 and round-trips base64", () => {
    const input48k = new Float32Array(480);
    for (let i = 0; i < input48k.length; i++) input48k[i] = Math.sin((i / 480) * Math.PI * 2) * 0.5;
    const pcm16 = resampleTo16kHzPcm16(input48k, 48_000);
    expect(pcm16.length).toBe(160);
    const decoded = base64ToPcm16Float32(pcm16ToBase64(pcm16));
    expect(decoded.length).toBe(160);
    expect(decoded[40]).toBeCloseTo(0.5, 2);
  });
});
