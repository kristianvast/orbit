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
import type { VoiceSdkStartInput, VoiceStartSessionFn } from "../voice";
import ChatPage from "./index";

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
    voiceErrorCode?: "plan_required" | "budget_exceeded";
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
          if (options.voiceErrorCode) {
            throw new OrionRequestError(
              options.voiceErrorCode,
              options.voiceErrorCode === "budget_exceeded"
                ? "Voice allowance is used up for this billing period."
                : "Sign in with a paid plan to talk to Orion.",
            );
          }
          return {
            voiceId: "voice-1",
            path: "/voice/dev/voice-1",
            variables: { farm_name: "North Meadow Farm", conversation_recap: "" },
          } as RequestResult<T>;
        }
        case "voice.stop":
        case "voice.turn":
          return { accepted: true } as RequestResult<T>;
        case "voice.tool":
          return {
            result: JSON.stringify({ rows: [], total: 2 }),
            isError: false,
          } as RequestResult<T>;
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

describe("Voice stage, activity rows, and plan errors in Chat", () => {
  function makeStubVoiceStarter() {
    let sdkInput: VoiceSdkStartInput | null = null;
    const endSession = vi.fn(async () => undefined);
    const sendUserMessage = vi.fn();
    const startSession: VoiceStartSessionFn = vi.fn(async (input) => {
      sdkInput = input;
      input.onStatusChange("connected");
      return {
        session: {
          type: "voice" as const,
          endSession,
          sendUserMessage,
          setMicMuted: vi.fn(),
          getInputVolume: () => 0,
          getOutputVolume: () => 0,
        },
        micUnavailable: false,
      };
    });
    return {
      startSession,
      endSession,
      getSdkInput: () => {
        if (!sdkInput) throw new Error("SDK session not started");
        return sdkInput;
      },
    };
  }

  it("opens voice stage on a draft conversation without re-triggering voice.stop when sessionId is created", async () => {
    const { client, requestMock } = createBillingVoiceClient();
    const stub = makeStubVoiceStarter();

    render(
      <MemoryRouter initialEntries={["/chat"]}>
        <AppProviders initialClient={client} voiceStartSession={stub.startSession}>
          <ChatPage />
        </AppProviders>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId("chat-voice-button"));
    const stage = await screen.findByTestId("voice-stage");
    await waitFor(() => expect(stage).toHaveAttribute("data-voice-state", "listening"));
    expect(stage.closest(".orbit-thread-pane")).toHaveAttribute("data-voice", "on");
    expect(requestMock).toHaveBeenCalledWith("voice.start", { sessionId: "sess-voice-1" });
    expect(requestMock).not.toHaveBeenCalledWith("voice.stop", expect.anything());
  });

  it("pins voice stage outside chat-transcript, shows only the live caption line, and clears finished turns from the stage", async () => {
    const { client, requestMock, emit } = createBillingVoiceClient();
    const stub = makeStubVoiceStarter();

    render(
      <MemoryRouter initialEntries={["/chat?s=sess-voice-1"]}>
        <AppProviders initialClient={client} voiceStartSession={stub.startSession}>
          <ChatPage />
        </AppProviders>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId("chat-voice-button"));
    const stage = await screen.findByTestId("voice-stage");
    const transcript = screen.getByTestId("chat-transcript");
    expect(transcript.contains(stage)).toBe(false);
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("voice.start", { sessionId: "sess-voice-1" }),
    );
    expect(stage).toHaveAttribute("data-voice-state", "listening");

    act(() => {
      stub.getSdkInput().onTentativeUserTranscript("How many cows are in the calving pen?");
      emit({
        type: "tool.start",
        sessionId: "sess-voice-1",
        toolCallId: "vcall-1",
        name: "db_query",
        label: "db_query",
        args: { query: "animals.list", params: { groupName: "Calving" } },
      });
    });

    expect(stage).toHaveAttribute("data-voice-state", "working");
    expect(screen.getByTestId("activity-row")).toHaveAttribute("data-status", "running");
    expect(screen.getByTestId("voice-stage-live-caption")).toHaveTextContent(
      "How many cows are in the calving pen?",
    );

    act(() => {
      stub.getSdkInput().onMessage({
        role: "user",
        message: "How many cows are in the calving pen?",
      });
      emit({
        type: "tool.end",
        sessionId: "sess-voice-1",
        toolCallId: "vcall-1",
        result: JSON.stringify({ rows: [], total: 2 }),
        details: null,
        isError: false,
        durationMs: 12,
      });
      stub.getSdkInput().onAgentChatResponsePart({
        type: "delta",
        text: "Two cows are ",
        event_id: 7,
      });
    });

    expect(screen.getByTestId("voice-stage-live-caption")).toHaveTextContent("Two cows are");

    act(() => {
      stub.getSdkInput().onMessage({
        role: "agent",
        message: "Two cows are in the calving pen right now.",
        event_id: 7,
      });
    });

    expect(screen.getByTestId("activity-row")).toHaveAttribute("data-status", "done");
    expect(screen.getByTestId("activity-row")).toHaveTextContent("2");
    expect(screen.queryByTestId("voice-stage-live-caption")).not.toBeInTheDocument();
    expect(stage).not.toHaveTextContent("Two cows are in the calving pen right now.");

    fireEvent.click(screen.getByTestId("voice-end"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("voice.stop", { voiceId: "voice-1" }),
    );
    expect(stub.endSession).toHaveBeenCalledTimes(1);
  });

  it.each(["plan_required", "budget_exceeded"] as const)(
    "surfaces PlanErrorCard when voice.start fails with %s without prompting for a BYO key",
    async (voiceErrorCode) => {
      const { client } = createBillingVoiceClient({ voiceErrorCode });
      const stub = makeStubVoiceStarter();

      render(
        <MemoryRouter initialEntries={["/chat"]}>
          <AppProviders initialClient={client} voiceStartSession={stub.startSession}>
            <Routes>
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/settings" element={<LocationProbe />} />
            </Routes>
          </AppProviders>
        </MemoryRouter>,
      );

      fireEvent.click(await screen.findByTestId("chat-voice-button"));
      const card = await screen.findByTestId("chat-plan-error-card");
      expect(card).toHaveAttribute("data-error-code", voiceErrorCode);
      expect(screen.queryByTestId("chat-plan-error-use-key")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("chat-plan-error-see-plans"));
      expect(await screen.findByTestId("route-probe")).toHaveTextContent("/settings#account");
    },
  );
});
