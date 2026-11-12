import type {
  AccountStatus,
  BillingPlans,
  BillingStatus,
  ConnectionState,
  FarmInvite,
  FarmMember,
  OrionClient,
  RequestParams,
  RequestResult,
  RequestType,
  ServerEvent,
} from "@orbit/protocol";
import { MODULE_IDS } from "@orbit/protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../../app/providers";
import { AppRoutes } from "../../app/routes";
import { AccountCard, BillingSection, FarmProfileCard, MembersCard } from "./index";

const billingCatalogue: BillingPlans = {
  currency: "eur",
  locked: false,
  trialDays: 30,
  plans: [
    { id: "free", name: "Free", cameras: 0, orionTokens: 0, voiceMinutes: 0 },
    {
      id: "orion",
      name: "Orion",
      cameras: 0,
      monthly: 23,
      orionTokens: 2_000_000,
      voiceMinutes: 30,
    },
    { id: "cam2", name: "Pair", cameras: 2, monthly: 51, orionTokens: 3_000_000, voiceMinutes: 60 },
    {
      id: "cam4",
      name: "Four",
      cameras: 4,
      monthly: 77,
      orionTokens: 5_000_000,
      voiceMinutes: 100,
    },
    { id: "cam6", name: "Six", cameras: 6, monthly: 97, orionTokens: 8_000_000, voiceMinutes: 150 },
  ],
  hardware: [],
};

function createMultiUserClient(options: {
  account: AccountStatus;
  billing?: BillingStatus;
  members?: FarmMember[];
  invites?: FarmInvite[];
  restarting?: boolean;
}) {
  const listeners = new Map<string, Set<(ev: ServerEvent) => void>>();
  let currentAccount = options.account;
  let currentBilling: BillingStatus = options.billing ?? {
    plan: "free",
    interval: null,
    status: "inactive",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    usage: { tokensUsed: 0, tokenAllowance: 0, voiceSecondsUsed: 0, voiceSecondsAllowance: 0 },
  };
  let members = [...(options.members ?? [])];
  let invites = [...(options.invites ?? [])];

  const emit = (ev: ServerEvent) => {
    for (const key of [ev.type, "*"]) {
      for (const fn of listeners.get(key) ?? []) fn(ev);
    }
  };

  const requestMock = vi.fn(
    async <T extends Exclude<RequestType, "hello">>(
      type: T,
      params?: RequestParams<T>,
    ): Promise<RequestResult<T>> => {
      switch (type) {
        case "account.status":
          return currentAccount as RequestResult<T>;
        case "farms.open":
          return { restarting: options.restarting ?? true } as RequestResult<T>;
        case "farms.create": {
          const p = params as RequestParams<"farms.create">;
          const createdName = p.name ?? currentAccount.localFarm?.name ?? "Cloud Barn";
          const createdId = currentAccount.localFarm?.id ?? "farm-cloud-new";
          currentAccount = {
            ...currentAccount,
            farm: { id: createdId, name: createdName, role: "owner" },
            farms: [
              ...(currentAccount.farms ?? []),
              {
                id: createdId,
                name: createdName,
                role: "owner",
                plan: "free",
                useFarmPlan: true,
                usageSource: null,
              },
            ],
            localFarm: null,
          };
          return currentAccount as RequestResult<T>;
        }
        case "members.list":
          return { members, invites } as RequestResult<T>;
        case "members.update": {
          const p = params as RequestParams<"members.update">;
          members = members.map((m) =>
            m.userId === p.userId
              ? {
                  ...m,
                  ...(p.role !== undefined ? { role: p.role } : {}),
                  ...(p.useFarmPlan !== undefined ? { useFarmPlan: p.useFarmPlan } : {}),
                  ...(p.monthlyTokenLimit !== undefined
                    ? { monthlyTokenLimit: p.monthlyTokenLimit }
                    : {}),
                }
              : m,
          );
          return { members, invites } as RequestResult<T>;
        }
        case "members.remove": {
          const p = params as RequestParams<"members.remove">;
          members = members.filter((m) => m.userId !== p.userId);
          return { members, invites } as RequestResult<T>;
        }
        case "invites.create": {
          const p = params as RequestParams<"invites.create">;
          const invite: FarmInvite = {
            id: `inv-${invites.length + 1}`,
            email: p.email,
            role: p.role,
            createdAt: "2026-11-12T10:00:00Z",
            expiresAt: "2026-11-19T10:00:00Z",
            ...(p.useFarmPlan !== undefined ? { useFarmPlan: p.useFarmPlan } : {}),
            ...(p.monthlyTokenLimit !== undefined
              ? { monthlyTokenLimit: p.monthlyTokenLimit }
              : {}),
          };
          invites = [invite, ...invites];
          return { invite, code: "INV-9821-ABCD" } as RequestResult<T>;
        }
        case "invites.revoke": {
          const p = params as RequestParams<"invites.revoke">;
          invites = invites.filter((i) => i.id !== p.inviteId);
          return { members, invites } as RequestResult<T>;
        }
        case "billing.status":
          return currentBilling as RequestResult<T>;
        case "billing.plans":
          return billingCatalogue as RequestResult<T>;
        case "billing.setSource": {
          const p = params as RequestParams<"billing.setSource">;
          const useOwn = p.source === "own";
          currentBilling = {
            ...currentBilling,
            usageSource: p.source,
            account: useOwn ? "personal" : "farm",
            plan: useOwn
              ? (currentBilling.personal?.plan ?? "free")
              : (currentBilling.farm?.plan ?? "free"),
          };
          return currentBilling as RequestResult<T>;
        }
        case "billing.portal":
          return { url: "https://billing.stripe.com/p/session/multi" } as RequestResult<T>;
        case "modules.list":
          return {
            modules: MODULE_IDS.map((id) => ({
              id,
              enabled: false,
              enabledAt: null,
              enabledBy: null,
            })),
          } as RequestResult<T>;
        case "pages.list":
          return { pages: [] } as RequestResult<T>;
        case "localUi.status":
          return { state: "none", path: null, builtAt: null, commit: null } as RequestResult<T>;
        case "settings.get":
          return {
            provider: "orbit-gateway",
            model: "orbit-default",
            thinkingLevel: "off",
            apiKeys: {},
            availableModels: [{ provider: "orbit-gateway", id: "orbit-default", name: "Orbit" }],
          } as RequestResult<T>;
        default:
          return {} as RequestResult<T>;
      }
    },
  );

  const client: OrionClient = {
    state: "open" as ConnectionState,
    server: { protocolVersion: 1, serverVersion: "0.1.5", farmId: "f-1" },
    request: requestMock as OrionClient["request"],
    query: vi.fn(async () => ({
      farm: {
        id: "f-1",
        name: "North Meadow",
        timezone: "UTC",
        species: ["cattle"],
        createdAt: "2026-11-01T00:00:00Z",
        updatedAt: "2026-11-01T00:00:00Z",
        deletedAt: null,
        hlc: "1",
        originDevice: "seed",
      },
      counts: {
        cattle: 12,
        horses: 0,
        devices: 0,
        devicesOffline: 0,
        cameras: 0,
        camerasOnline: 0,
        connectors: 0,
        connectorsWithErrors: 0,
      },
      recentAlerts: [],
    })) as OrionClient["query"],
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

  return { client, requestMock, emit };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Farm picker in Settings > Farm and AppShell", () => {
  it("lists cloud farms and this PC's own farm, marks the open farm, and shows Opening state on switch", async () => {
    const account: AccountStatus = {
      state: "signed_in",
      coreUrl: "https://api.pecorva.com",
      user: { id: "u-1", email: "astrid@pecorva.com", name: "Astrid" },
      farm: { id: "f-1", name: "North Meadow", role: "owner" },
      farms: [
        {
          id: "f-1",
          name: "North Meadow",
          role: "owner",
          plan: "orion",
          useFarmPlan: true,
          usageSource: null,
        },
        {
          id: "f-2",
          name: "South Valley",
          role: "worker",
          plan: "cam2",
          useFarmPlan: true,
          usageSource: null,
        },
      ],
      localFarm: { id: "loc-1", name: "Home Barn" },
    };
    const { client, requestMock, emit } = createMultiUserClient({ account });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders initialClient={client}>
          <AppRoutes />
          <FarmProfileCard />
        </AppProviders>
      </MemoryRouter>,
    );

    const item1 = await screen.findByTestId("farm-picker-item-f-1");
    const item2 = screen.getByTestId("farm-picker-item-f-2");
    const itemLocal = screen.getByTestId("farm-picker-item-local");

    expect(item1).toHaveAttribute("data-open", "true");
    expect(item2).toHaveAttribute("data-open", "false");
    expect(itemLocal).toHaveAttribute("data-open", "false");
    expect(item2).toHaveTextContent("South Valley");
    expect(item2).toHaveTextContent("Worker");
    expect(itemLocal).toHaveTextContent("Home Barn");

    const shellPicker = screen.getByTestId("shell-farm-picker") as HTMLSelectElement;
    expect(shellPicker.value).toBe("f-1");

    fireEvent.click(screen.getByTestId("farm-picker-switch-f-2"));
    await waitFor(() => expect(requestMock).toHaveBeenCalledWith("farms.open", { farmId: "f-2" }));
    expect(await screen.findByTestId("farm-picker-opening")).toHaveTextContent(
      "Opening South Valley",
    );
    expect(screen.getByTestId("shell-farm-opening")).toHaveTextContent("Opening South Valley");

    act(() => {
      emit({
        type: "account.updated",
        ...account,
        farm: { id: "f-2", name: "South Valley", role: "worker" },
      });
    });

    await waitFor(() =>
      expect(screen.queryByTestId("farm-picker-opening")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("farm-picker-item-f-2")).toHaveAttribute("data-open", "true");

    fireEvent.change(screen.getByTestId("shell-farm-picker"), { target: { value: "local" } });
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("farms.open", { farmId: "local" }),
    );
    expect(await screen.findByTestId("shell-farm-opening")).toHaveTextContent("Opening Home Barn");
  });
});

describe("AccountCard cloud farm creation and farm-less signed-in state", () => {
  it("prefills localFarm name for Put this farm in the cloud and calls farms.create", async () => {
    const onStatus = vi.fn();
    const account: AccountStatus = {
      state: "signed_in",
      coreUrl: "https://api.pecorva.com",
      user: { id: "u-1", email: "astrid@pecorva.com", name: "Astrid" },
      farm: null,
      farms: [],
      localFarm: { id: "loc-1", name: "Hilltop Dairy" },
    };
    const { client, requestMock } = createMultiUserClient({ account });

    render(
      <MemoryRouter>
        <AppProviders initialClient={client}>
          <AccountCard status={account} onStatus={onStatus} />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(screen.queryByTestId("account-link-error")).not.toBeInTheDocument();
    const nameInput = screen.getByTestId("account-create-farm-name") as HTMLInputElement;
    expect(nameInput.value).toBe("Hilltop Dairy");

    fireEvent.change(nameInput, { target: { value: "Hilltop Cloud Dairy" } });
    fireEvent.click(screen.getByTestId("account-create-farm-submit"));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("farms.create", { name: "Hilltop Cloud Dairy" }),
    );
    expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        farm: { id: "loc-1", name: "Hilltop Cloud Dairy", role: "owner" },
        localFarm: null,
      }),
    );
  });

  it("renders a calm signed-in card with no link error when the account has no farm at all", () => {
    const account: AccountStatus = {
      state: "signed_in",
      coreUrl: "https://api.pecorva.com",
      user: { id: "u-solo", email: "solo@pecorva.com", name: "Solo" },
      farm: null,
      farms: [],
      localFarm: null,
    };
    const { client } = createMultiUserClient({ account });

    render(
      <MemoryRouter>
        <AppProviders initialClient={client}>
          <AccountCard status={account} onStatus={() => {}} />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("account-signed-in")).toBeInTheDocument();
    expect(screen.queryByTestId("account-link-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("account-create-farm")).not.toBeInTheDocument();
  });
});

describe("MembersCard permissions, limits, compact usage, invites, and leaving", () => {
  it("keeps owners forced on, updates member useFarmPlan and monthlyTokenLimit, formats compact usage, and confirms removal", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const members: FarmMember[] = [
      {
        userId: "u-owner",
        email: "astrid@pecorva.com",
        name: "Astrid",
        role: "owner",
        createdAt: "2026-11-01T00:00:00Z",
        useFarmPlan: true,
        monthlyTokenLimit: null,
        usage: { farmTokens: 1_500_000, ownTokens: 0, voiceSeconds: 120 },
      },
      {
        userId: "u-worker",
        email: "lars@pecorva.com",
        name: "Lars",
        role: "worker",
        createdAt: "2026-11-02T00:00:00Z",
        useFarmPlan: false,
        monthlyTokenLimit: null,
        usage: { farmTokens: 12_340, ownTokens: 450, voiceSeconds: 0 },
      },
    ];
    const { client, requestMock } = createMultiUserClient({
      account: {
        state: "signed_in",
        coreUrl: "https://api.pecorva.com",
        user: { id: "u-owner", email: "astrid@pecorva.com", name: "Astrid" },
        farm: { id: "f-1", name: "North Meadow", role: "owner" },
      },
      members,
    });

    const ownerRole = "owner" as const;
    render(
      <AppProviders initialClient={client}>
        <MembersCard role={ownerRole} userId="u-owner" />
      </AppProviders>,
    );

    const rows = await screen.findAllByTestId("member-row");
    const [ownerRow, workerRow] = rows;
    if (!ownerRow || !workerRow) throw new Error("Expected two member rows");

    const ownerSwitch = within(ownerRow).getByTestId("member-use-farm-plan") as HTMLInputElement;
    expect(ownerSwitch.checked).toBe(true);
    expect(ownerSwitch.disabled).toBe(true);
    expect(within(ownerRow).queryByTestId("member-token-limit")).not.toBeInTheDocument();
    expect(within(ownerRow).getByTestId("member-usage")).toHaveTextContent("1.5M farm · 0 own");

    expect(within(workerRow).getByTestId("member-usage")).toHaveTextContent("12.3k farm · 450 own");
    const workerSwitch = within(workerRow).getByTestId("member-use-farm-plan") as HTMLInputElement;
    expect(workerSwitch.checked).toBe(false);
    expect(workerSwitch.disabled).toBe(false);

    fireEvent.click(workerSwitch);
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("members.update", {
        userId: "u-worker",
        useFarmPlan: true,
      }),
    );

    const limitInput = within(workerRow).getByTestId("member-token-limit") as HTMLInputElement;
    await waitFor(() => expect(limitInput).not.toBeDisabled());
    fireEvent.change(limitInput, { target: { value: "50000" } });
    fireEvent.blur(limitInput);
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("members.update", {
        userId: "u-worker",
        monthlyTokenLimit: 50_000,
      });
      expect(limitInput).not.toBeDisabled();
      expect(limitInput).toHaveValue(50_000);
    });

    fireEvent.change(limitInput, { target: { value: "" } });
    fireEvent.keyDown(limitInput, { key: "Enter" });
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("members.update", {
        userId: "u-worker",
        monthlyTokenLimit: null,
      });
      expect(limitInput).not.toBeDisabled();
    });

    const inviteSwitch = screen.getByTestId("invite-use-farm-plan") as HTMLInputElement;
    expect(inviteSwitch.checked).toBe(false);
    fireEvent.change(screen.getByTestId("invite-role"), { target: { value: "owner" } });
    expect(inviteSwitch.checked).toBe(true);
    expect(inviteSwitch.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("invite-role"), { target: { value: "worker" } });
    expect(inviteSwitch.checked).toBe(false);
    fireEvent.click(inviteSwitch);
    fireEvent.change(screen.getByTestId("invite-email"), {
      target: { value: "maja@pecorva.com" },
    });
    fireEvent.change(screen.getByTestId("invite-token-limit"), { target: { value: "25000" } });
    fireEvent.submit(screen.getByTestId("invite-form"));

    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("invites.create", {
        email: "maja@pecorva.com",
        role: "worker",
        useFarmPlan: true,
        monthlyTokenLimit: 25_000,
      }),
    );
    expect(await screen.findByTestId("invite-code")).toHaveTextContent("INV-9821-ABCD");
    fireEvent.click(screen.getByTestId("invite-code-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("INV-9821-ABCD"));

    const inviteRow = screen.getByTestId("invite-row");
    expect(within(inviteRow).getByTestId("invite-plan-badge")).toBeInTheDocument();
    expect(within(inviteRow).getByTestId("invite-limit-badge")).toHaveTextContent("25k");

    fireEvent.click(within(workerRow).getByTestId("member-remove"));
    expect(requestMock).not.toHaveBeenCalledWith("members.remove", expect.anything());
    fireEvent.click(await screen.findByTestId("member-remove-confirm"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("members.remove", { userId: "u-worker" }),
    );
  });

  it("lets a non-owner leave the farm with confirmation via members.remove on their own userId", async () => {
    const onLeft = vi.fn();
    const { client, requestMock } = createMultiUserClient({
      account: {
        state: "signed_in",
        coreUrl: "https://api.pecorva.com",
        user: { id: "u-worker", email: "lars@pecorva.com", name: "Lars" },
        farm: { id: "f-1", name: "North Meadow", role: "worker" },
      },
      members: [
        {
          userId: "u-owner",
          email: "astrid@pecorva.com",
          name: "Astrid",
          role: "owner",
          createdAt: "2026-11-01T00:00:00Z",
        },
        {
          userId: "u-worker",
          email: "lars@pecorva.com",
          name: "Lars",
          role: "worker",
          createdAt: "2026-11-02T00:00:00Z",
        },
      ],
    });

    const workerRole = "worker" as const;
    render(
      <AppProviders initialClient={client}>
        <MembersCard role={workerRole} userId="u-worker" onLeft={onLeft} />
      </AppProviders>,
    );

    fireEvent.click(await screen.findByTestId("member-leave"));
    expect(requestMock).not.toHaveBeenCalledWith("members.remove", expect.anything());
    fireEvent.click(await screen.findByTestId("member-leave-confirm"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("members.remove", { userId: "u-worker" }),
    );
    expect(onLeft).toHaveBeenCalledTimes(1);
  });
});

describe("BillingSection usage source switch, dual allowances, and account routing", () => {
  it("switches between Farm plan and My own plan via billing.setSource, renders both allowances and member cap, and passes account to billing.portal", async () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    const ownerAccount: AccountStatus = {
      state: "signed_in",
      coreUrl: "https://api.pecorva.com",
      user: { id: "u-1", email: "astrid@pecorva.com", name: "Astrid" },
      farm: { id: "f-1", name: "North Meadow", role: "owner" },
    };
    const billing: BillingStatus = {
      plan: "cam2",
      interval: "month",
      status: "active",
      currentPeriodEnd: "2026-12-12T00:00:00Z",
      cancelAtPeriodEnd: false,
      usage: {
        tokensUsed: 300_000,
        tokenAllowance: 3_000_000,
        voiceSecondsUsed: 600,
        voiceSecondsAllowance: 3_600,
      },
      account: "farm",
      usageSource: "farm",
      farmPlanAllowed: true,
      member: { tokensUsed: 42_000, tokenLimit: 100_000 },
      farm: {
        plan: "cam2",
        trialEndsAt: null,
        tokensUsed: 300_000,
        tokenAllowance: 3_000_000,
      },
      personal: {
        plan: "orion",
        trialEndsAt: "2026-12-01T00:00:00Z",
        tokensUsed: 15_000,
        tokenAllowance: 2_000_000,
      },
    };
    const { client, requestMock } = createMultiUserClient({ account: ownerAccount, billing });

    render(
      <AppProviders initialClient={client}>
        <BillingSection status={ownerAccount} />
      </AppProviders>,
    );

    const farmTab = await screen.findByTestId("billing-source-farm");
    const ownTab = screen.getByTestId("billing-source-own");
    expect(farmTab).toHaveAttribute("aria-selected", "true");
    expect(ownTab).toHaveAttribute("aria-selected", "false");

    expect(screen.getByTestId("billing-allowance-farm-tokens")).toHaveTextContent(
      "300,000 / 3,000,000 tokens",
    );
    expect(screen.getByTestId("billing-allowance-personal-tokens")).toHaveTextContent(
      "15,000 / 2,000,000 tokens",
    );
    expect(screen.getByTestId("billing-allowance-personal-trial")).toBeInTheDocument();
    expect(screen.getByTestId("billing-member-usage")).toHaveTextContent("42,000 / 100,000 tokens");

    fireEvent.click(screen.getByTestId("billing-portal-button"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("billing.portal", { account: "farm" }),
    );

    fireEvent.click(ownTab);
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("billing.setSource", { source: "own" }),
    );
    expect(ownTab).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByTestId("billing-portal-button"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("billing.portal", { account: "personal" }),
    );
  });

  it("disables Farm plan with a hint when farmPlanAllowed is false, and hides farm billing actions for workers on farm plan", async () => {
    vi.spyOn(window, "open").mockImplementation(() => null);
    const workerAccount: AccountStatus = {
      state: "signed_in",
      coreUrl: "https://api.pecorva.com",
      user: { id: "u-worker", email: "lars@pecorva.com", name: "Lars" },
      farm: { id: "f-1", name: "North Meadow", role: "worker" },
    };
    const disallowedBilling: BillingStatus = {
      plan: "orion",
      interval: "month",
      status: "active",
      currentPeriodEnd: "2026-12-12T00:00:00Z",
      cancelAtPeriodEnd: false,
      usage: {
        tokensUsed: 10_000,
        tokenAllowance: 2_000_000,
        voiceSecondsUsed: 0,
        voiceSecondsAllowance: 1_800,
      },
      account: "personal",
      usageSource: null,
      farmPlanAllowed: false,
      member: { tokensUsed: 0, tokenLimit: null },
      farm: { plan: "cam2", trialEndsAt: null, tokensUsed: 500_000, tokenAllowance: 3_000_000 },
      personal: { plan: "orion", trialEndsAt: null, tokensUsed: 10_000, tokenAllowance: 2_000_000 },
    };
    const { client, requestMock } = createMultiUserClient({
      account: workerAccount,
      billing: disallowedBilling,
    });

    const view = render(
      <AppProviders initialClient={client}>
        <BillingSection status={workerAccount} />
      </AppProviders>,
    );

    const farmTab = await screen.findByTestId("billing-source-farm");
    expect(farmTab).toBeDisabled();
    expect(screen.getByTestId("billing-source-own")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("billing-farm-disallowed-hint")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("billing-portal-button"));
    await waitFor(() =>
      expect(requestMock).toHaveBeenCalledWith("billing.portal", { account: "personal" }),
    );
    view.unmount();

    const allowedWorkerBilling: BillingStatus = {
      ...disallowedBilling,
      account: "farm",
      usageSource: "farm",
      farmPlanAllowed: true,
    };
    const workerOnFarm = createMultiUserClient({
      account: workerAccount,
      billing: allowedWorkerBilling,
    });
    render(
      <AppProviders initialClient={workerOnFarm.client}>
        <BillingSection status={workerAccount} />
      </AppProviders>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("billing-source-farm")).toHaveAttribute("aria-selected", "true"),
    );
    expect(screen.queryByTestId("billing-portal-button")).not.toBeInTheDocument();
    expect(screen.queryByTestId("billing-choose-plan-button")).not.toBeInTheDocument();
  });
});
