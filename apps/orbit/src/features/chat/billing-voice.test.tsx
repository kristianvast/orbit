import {
  type AccountStatus,
  type BillingPlans,
  type BillingStatus,
  type ConnectionState,
  MODULE_IDS,
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
import { BillingSection } from "../settings/BillingSection";
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

const paidCameraBilling: BillingStatus = {
  plan: "cam6",
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

const billingPlans: BillingPlans = {
  currency: "eur",
  locked: false,
  trialDays: 30,
  plans: [
    {
      id: "free",
      name: "Free from Core",
      cameras: 0,
      monthly: 0,
      yearly: 0,
      orionTokens: 0,
      voiceMinutes: 0,
    },
    {
      id: "orion",
      name: "Orion from Core",
      cameras: 0,
      monthly: 23,
      yearly: 230,
      orionTokens: 2000000,
      voiceMinutes: 30,
    },
    {
      id: "cam2",
      name: "Pair from Core",
      cameras: 2,
      monthly: 51,
      yearly: 510,
      orionTokens: 3000000,
      voiceMinutes: 60,
    },
    {
      id: "cam4",
      name: "Four from Core",
      cameras: 4,
      monthly: 77,
      yearly: 770,
      orionTokens: 5000000,
      voiceMinutes: 100,
    },
    {
      id: "cam6",
      name: "Six from Core",
      cameras: 6,
      monthly: 97,
      yearly: 970,
      orionTokens: 8000000,
      voiceMinutes: 150,
    },
  ],
  hardware: [],
};

function createBillingVoiceClient(
  options: {
    billing?: BillingStatus;
    plans?: BillingPlans;
    plansFailure?: boolean;
    promptErrorCode?: "plan_required" | "budget_exceeded" | "not_ready";
  } = {},
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
        case "billing.plans":
          if (options.plansFailure) throw new Error("Catalogue unavailable");
          return (options.plans ?? billingPlans) as RequestResult<T>;
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
              options.promptErrorCode === "not_ready"
                ? "No AI model is set up yet. Choose a model and add a key in Settings."
                : "Choose a plan or use your own AI key in Providers.",
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
        case "modules.list":
          return {
            modules: MODULE_IDS.map((id) => ({
              id,
              enabled: false,
              enabledAt: null,
              enabledBy: null,
            })),
          } as RequestResult<T>;
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
    await screen.findByTestId("billing-picker");
    expect(screen.getByTestId("billing-plan-name")).toHaveTextContent("Free from Core");
    for (const [id, name, price] of [
      ["orion", "Orion from Core", "€23.00"],
      ["cam2", "Pair from Core", "€51.00"],
      ["cam4", "Four from Core", "€77.00"],
      ["cam6", "Six from Core", "€97.00"],
    ] as const) {
      const option = screen.getByTestId(`billing-plan-${id}`);
      expect(option).toHaveTextContent(name);
      expect(option).toHaveTextContent(price);
    }
    expect(screen.getByTestId("billing-free-copy")).toHaveTextContent(
      /Orbit and Orion are open source and free/,
    );
    expect(screen.getByTestId("billing-meter-tokens-value")).toHaveTextContent("0 / 0 tokens");
    expect(screen.getByTestId("billing-meter-voice-value")).toHaveTextContent("0 / 0 min");

    fireEvent.click(screen.getByTestId("billing-interval-year"));
    expect(screen.getByTestId("billing-plan-cam6")).toHaveTextContent("€970.00 / year");
    fireEvent.click(screen.getByTestId("billing-plan-cam6"));
    fireEvent.click(screen.getByTestId("billing-checkout-button"));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("billing.checkout", {
        plan: "cam6",
        interval: "year",
      }),
    );
    expect(openSpy).toHaveBeenCalledWith(
      "https://checkout.stripe.com/c/pay/cs_test_orbit",
      "_blank",
      "noopener,noreferrer",
    );

    setBilling(paidCameraBilling);
    rerender(
      <MemoryRouter>
        <AppProviders initialClient={client}>
          <AccountCard status={{ ...signedInAccount }} onStatus={() => {}} />
        </AppProviders>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("billing-plan-name")).toHaveTextContent("Six from Core"),
    );
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

  it.each(["locked", "failed", "missing prices"] as const)(
    "shows website pricing and keeps the portal working when the catalogue is %s",
    async (mode) => {
      const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
      const plans: BillingPlans = {
        ...billingPlans,
        locked: mode === "locked",
        plans:
          mode === "locked"
            ? billingPlans.plans
            : billingPlans.plans.map(({ monthly: _monthly, yearly: _yearly, ...plan }) => plan),
      };
      const { client } = createBillingVoiceClient({
        billing: paidCameraBilling,
        plans,
        plansFailure: mode === "failed",
      });
      render(
        <AppProviders initialClient={client}>
          <BillingSection status={signedInAccount} />
        </AppProviders>,
      );
      const portal = await screen.findByTestId("billing-portal-button");
      expect(screen.queryByTestId("billing-picker")).not.toBeInTheDocument();
      expect(screen.queryByTestId("billing-checkout-button")).not.toBeInTheDocument();
      expect(screen.getByTestId("billing-pricing-link")).toHaveAttribute(
        "href",
        "https://pecorva.com/pricing/",
      );
      expect(screen.getByTestId("billing-section")).not.toHaveTextContent("€");
      expect(screen.getByTestId("billing-plan-name")).toHaveTextContent(
        mode === "failed" ? "Current plan" : "Six from Core",
      );
      fireEvent.click(portal);
      await waitFor(() =>
        expect(openSpy).toHaveBeenCalledWith(
          "https://billing.stripe.com/p/session/test_portal",
          "_blank",
          "noopener,noreferrer",
        ),
      );
    },
  );

  it("keeps the sign-in prompt without loading billing when signed out", () => {
    const { client, requestMock } = createBillingVoiceClient();
    render(
      <AppProviders initialClient={client}>
        <BillingSection
          status={{ state: "signed_out", coreUrl: "https://core.test", user: null, farm: null }}
        />
      </AppProviders>,
    );
    expect(screen.getByTestId("billing-signin-prompt")).toBeInTheDocument();
    expect(screen.queryByTestId("billing-picker")).not.toBeInTheDocument();
    expect(requestMock).not.toHaveBeenCalledWith("billing.plans", {});
  });

  it.each([
    { plan: "free", trialEndsAt: "2026-11-13T00:00:00Z", visible: true },
    { plan: "free", trialEndsAt: null, visible: false },
    { plan: "free", trialEndsAt: undefined, visible: false },
    { plan: "free", trialEndsAt: "2026-11-09T00:00:00Z", visible: false },
    { plan: "free", trialEndsAt: "2026-11-10T00:00:00Z", visible: false },
    { plan: "orion", trialEndsAt: "2026-11-13T00:00:00Z", visible: false },
  ] as const)(
    "shows the free month only for a future free trial: $plan $trialEndsAt",
    async ({ plan, trialEndsAt, visible }) => {
      const { client } = createBillingVoiceClient({
        billing: { ...freeBilling, plan, ...(trialEndsAt === undefined ? {} : { trialEndsAt }) },
      });
      render(
        <AppProviders initialClient={client}>
          <BillingSection status={signedInAccount} now={Date.parse("2026-11-10T00:00:00Z")} />
        </AppProviders>,
      );
      await screen.findByTestId("billing-picker");
      if (visible) {
        expect(screen.getByTestId("billing-trial")).toHaveTextContent(
          "Free Orion month: 3 days left",
        );
        expect(screen.getByTestId("billing-trial")).toHaveTextContent(
          new Intl.DateTimeFormat("en-US", {
            year: "numeric",
            month: "short",
            day: "numeric",
          }).format(new Date("2026-11-13T00:00:00Z")),
        );
      } else {
        expect(screen.queryByTestId("billing-trial")).not.toBeInTheDocument();
      }
    },
  );
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

describe("Chat with no AI model set up", () => {
  it("shows the setup card, stops working, and hands the message back to the composer", async () => {
    const { client } = createBillingVoiceClient({ promptErrorCode: "not_ready" });

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
    fireEvent.change(input, { target: { value: "How many cows are dry?" } });
    fireEvent.click(screen.getByTestId("chat-send-button"));

    const card = await screen.findByTestId("chat-plan-error-card");
    expect(card).toHaveAttribute("data-error-code", "model_required");
    expect(screen.queryByTestId("chat-streaming-indicator")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-composer-stop-button")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-composer-input")).toHaveValue("How many cows are dry?");
    expect(screen.getByTestId("chat-transcript")).not.toHaveTextContent("How many cows are dry?");

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
