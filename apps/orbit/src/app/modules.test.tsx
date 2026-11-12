import {
  type ConnectionState,
  type CustomPage,
  type LocalUiStatus,
  MODULE_IDS,
  type ModuleId,
  type ModulesState,
  type OrionClient,
  type RequestParams,
  type RequestResult,
  type RequestType,
  type ServerEvent,
} from "@orbit/protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { OrbitModulesCard } from "../features/settings";

// The release feed only exists inside the desktop shell, so tests set what it found.
const appUpdate = vi.hoisted(() => ({
  ready: false,
  version: null as string | null,
  restart: vi.fn(),
}));
vi.mock("../lib/updater", async (original) => ({
  ...(await original<typeof import("../lib/updater")>()),
  useAppUpdate: () => appUpdate,
}));

import { AppProviders } from "./providers";
import { AppRoutes } from "./routes";

function createMinimalTestClient(options?: {
  initialEnabled?: ModuleId[];
  cattleCount?: number;
  horsesCount?: number;
  connectorsCount?: number;
  omitModulesList?: boolean;
  holdModulesList?: boolean;
  pages?: CustomPage[];
  /** A fresh install: cloud reachable, nobody signed in, no AI model usable. */
  needsSetup?: boolean;
  /** The farm's own build, as localUi.status reports it. */
  localUi?: LocalUiStatus;
}) {
  const listeners = new Map<string, Set<(ev: ServerEvent) => void>>();
  let pages = options?.pages ?? [];
  const enabledSet = new Set(options?.initialEnabled ?? []);
  let state: ModulesState = {
    modules: MODULE_IDS.map((id) => ({
      id,
      enabled: enabledSet.has(id),
      enabledAt: enabledSet.has(id) ? "2026-11-09T08:00:00.000Z" : null,
      enabledBy: enabledSet.has(id) ? "auto" : null,
    })),
  };

  let resolveInitialList: ((res: ModulesState) => void) | null = null;
  const heldPromise = options?.holdModulesList
    ? new Promise<ModulesState>((resolve) => {
        resolveInitialList = resolve;
      })
    : null;

  const emit = (ev: ServerEvent) => {
    for (const key of [ev.type, "*"]) {
      for (const fn of listeners.get(key) ?? []) {
        fn(ev);
      }
    }
  };

  const requestMock = vi.fn(
    async <T extends Exclude<RequestType, "hello">>(
      type: T,
      params?: RequestParams<T>,
    ): Promise<RequestResult<T>> => {
      switch (type) {
        case "modules.list":
          if (options?.omitModulesList) {
            return {} as RequestResult<T>;
          }
          if (heldPromise) {
            return (await heldPromise) as RequestResult<T>;
          }
          return state as RequestResult<T>;
        case "modules.enable": {
          const p = params as RequestParams<"modules.enable">;
          state = {
            modules: state.modules.map((m) =>
              m.id === p.moduleId
                ? {
                    ...m,
                    enabled: true,
                    enabledAt: "2026-11-09T09:15:00.000Z",
                    enabledBy: "user",
                  }
                : m,
            ),
          };
          emit({ type: "modules.updated", modules: state.modules });
          return state as RequestResult<T>;
        }
        case "modules.disable": {
          const p = params as RequestParams<"modules.disable">;
          state = {
            modules: state.modules.map((m) =>
              m.id === p.moduleId ? { ...m, enabled: false, enabledAt: null, enabledBy: null } : m,
            ),
          };
          emit({ type: "modules.updated", modules: state.modules });
          return state as RequestResult<T>;
        }
        case "pages.list":
          return { pages } as RequestResult<T>;
        case "localUi.status":
          return (options?.localUi ?? {
            state: "none",
            path: null,
            builtAt: null,
            commit: null,
          }) as RequestResult<T>;
        case "sessions.list":
          return { sessions: [] } as RequestResult<T>;
        case "sessions.create":
          return {
            session: {
              id: "session-1",
              title: "New chat",
              createdAt: "2026-11-09T09:15:00.000Z",
              updatedAt: "2026-11-09T09:15:00.000Z",
              messageCount: 0,
              model: null,
              streaming: false,
              parentSessionId: null,
            },
          } as RequestResult<T>;
        case "account.status":
          return {
            state: options?.needsSetup ? "signed_out" : "unavailable",
            coreUrl: options?.needsSetup ? "https://core.example.test" : null,
            user: null,
            farm: null,
          } as RequestResult<T>;
        case "settings.get":
          if (options?.needsSetup) {
            return {
              provider: null,
              model: null,
              thinkingLevel: "off",
              apiKeys: {},
              availableModels: [],
            } as RequestResult<T>;
          }
          return {
            provider: "orion-mock",
            model: "mock-1",
            thinkingLevel: "off",
            apiKeys: {},
            availableModels: [{ provider: "orion-mock", id: "mock-1", name: "Mock model" }],
          } as RequestResult<T>;
        case "snapshots.list":
          return { snapshots: [] } as RequestResult<T>;
        case "localUi.launched":
          return {
            state: "ready",
            path: "/app/tok-123/",
            builtAt: "2026-11-11T10:00:00.000Z",
            commit: "abc1234",
          } as RequestResult<T>;
        default:
          return {} as RequestResult<T>;
      }
    },
  );

  const client: OrionClient = {
    state: "open" as ConnectionState,
    server: {
      protocolVersion: 1,
      serverVersion: "0.1.0",
      farmId: "00000000-0000-4000-8000-00000000f001",
    },
    request: requestMock as OrionClient["request"],
    query: vi.fn(async (query) => {
      if (query === "farm.summary") {
        return {
          farm: {
            id: "00000000-0000-4000-8000-00000000f001",
            name: "North Ridge Barn",
            timezone: "UTC",
            species: ["cattle", "horse"],
            createdAt: "2026-11-01T00:00:00.000Z",
            updatedAt: "2026-11-01T00:00:00.000Z",
            deletedAt: null,
            hlc: "1",
            originDevice: "seed",
          },
          counts: {
            cattle: options?.cattleCount ?? 0,
            horses: options?.horsesCount ?? 0,
            devices: 2,
            devicesOffline: 0,
            cameras: 1,
            camerasOnline: 1,
            connectors: options?.connectorsCount ?? 1,
            connectorsWithErrors: 0,
          },
          recentAlerts: [],
        };
      }
      return { rows: [], total: 0 };
    }) as OrionClient["query"],
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
    emit,
    setPages(next: CustomPage[]) {
      pages = next;
    },
    releaseInitialList() {
      resolveInitialList?.(state);
    },
  };
}

describe("Minimal-first Orbit UI: navigation, routes, Home, and Settings modules", () => {
  it("renders only Home, Ask Orion, and Settings while loading and when all modules are disabled, then adds Cattle on modules.updated", async () => {
    const { client, emit, releaseInitialList } = createMinimalTestClient({
      holdModulesList: true,
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders initialClient={client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );

    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByText("Home")).toBeInTheDocument();
    expect(within(nav).getByText("Ask Orion")).toBeInTheDocument();
    expect(within(nav).getByText("Settings")).toBeInTheDocument();
    expect(within(nav).queryByText("Cattle")).not.toBeInTheDocument();
    expect(within(nav).queryByText("Horses")).not.toBeInTheDocument();
    expect(within(nav).queryByText("Connections")).not.toBeInTheDocument();
    expect(within(nav).queryByText("Cameras")).not.toBeInTheDocument();

    await act(async () => {
      releaseInitialList();
    });

    await waitFor(() => {
      expect(screen.getByTestId("home-minimal")).toBeInTheDocument();
    });
    expect(within(nav).queryByText("Cattle")).not.toBeInTheDocument();

    act(() => {
      emit({
        type: "modules.updated",
        modules: [
          {
            id: "herd",
            enabled: true,
            enabledAt: "2026-11-09T10:00:00.000Z",
            enabledBy: "orion",
          },
          { id: "devices", enabled: false, enabledAt: null, enabledBy: null },
          { id: "cameras", enabled: false, enabledAt: null, enabledBy: null },
        ],
      });
    });

    const links = await waitFor(() => {
      expect(within(nav).getByText("Cattle")).toBeInTheDocument();
      return within(nav).getAllByRole("link");
    });
    expect(links.map((l) => l.textContent)).toEqual(["Home", "Ask Orion", "Cattle", "Settings"]);
  });

  it("shows Orion-first Home when no modules and no animals exist, and starter chips send their prompt to Orion", async () => {
    const { client, requestMock } = createMinimalTestClient();

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders initialClient={client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("home-minimal")).toBeInTheDocument();
    expect(screen.getByTestId("home-hero-headline")).toHaveTextContent(
      "Orbit starts small and grows with your farm.",
    );
    expect(screen.queryByTestId("home-sensors-online")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-cameras-live")).not.toBeInTheDocument();
    expect(screen.getByTestId("home-starter-devices")).toHaveTextContent(
      "Connect my milking robot",
    );
    expect(screen.getByTestId("home-starter-page")).toHaveTextContent("Build what my farm needs");

    fireEvent.click(screen.getByTestId("home-starter-herd"));

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("chat.prompt", {
        sessionId: "session-1",
        text: "Help me track my herd",
      });
    });
    expect(requestMock.mock.calls.filter(([type]) => type === "chat.prompt")).toHaveLength(1);
  });

  it("offers the free account instead of the ask box on an install where Orion cannot answer yet", async () => {
    const { client } = createMinimalTestClient({ needsSetup: true });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders initialClient={client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId("home-setup-create"));
    expect(screen.queryByTestId("home-ask-input")).not.toBeInTheDocument();

    expect(await screen.findByTestId("account-mode-register")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("drops a page from the menu as soon as an undo removes it from the workspace", async () => {
    const { client, emit, setPages } = createMinimalTestClient({
      pages: [{ id: "herd-count", title: "Herd count", path: "/pages/t/herd-count/index.html" }],
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders initialClient={client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId("nav-custom-page-herd-count")).toBeInTheDocument();

    setPages([]);
    act(() => {
      emit({ type: "db.changed", table: "workspace", ids: ["pages/herd-count/index.html"] });
    });

    await waitFor(() => {
      expect(screen.queryByTestId("nav-custom-page-herd-count")).not.toBeInTheDocument();
    });
  });

  it("loads an open page again when its files change, and only then", async () => {
    const { client, emit } = createMinimalTestClient({
      pages: [{ id: "herd-count", title: "Herd count", path: "/pages/t/herd-count/index.html" }],
    });

    render(
      <MemoryRouter initialEntries={["/pages/herd-count"]}>
        <AppProviders initialClient={client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const first = await screen.findByTestId("custom-page-frame");

    act(() => {
      emit({ type: "db.changed", table: "workspace", ids: ["pages/other/index.html"] });
    });
    expect(screen.getByTestId("custom-page-frame")).toBe(first);

    act(() => {
      emit({ type: "db.changed", table: "workspace", ids: ["pages/herd-count/index.html"] });
    });
    await waitFor(() => {
      expect(screen.getByTestId("custom-page-frame")).not.toBe(first);
    });
  });

  it("shows only enabled module instruments on Home when a module is enabled", async () => {
    const { client } = createMinimalTestClient({
      initialEnabled: ["herd"],
      cattleCount: 18,
      horsesCount: 2,
    });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders initialClient={client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("home-herd-counts")).toHaveTextContent("18 cattle");
    expect(screen.getByTestId("home-animals-gauge")).toBeInTheDocument();
    expect(screen.queryByTestId("home-sensors-online")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-connectors-gauge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-cameras-live")).not.toBeInTheDocument();
  });

  it("shows the Connections gauge on Home only when devices is enabled and at least one connector exists, and auto-enables fallback from connectors count", async () => {
    const zeroConn = createMinimalTestClient({
      omitModulesList: true,
      cattleCount: 10,
      connectorsCount: 0,
    });
    const view = render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders initialClient={zeroConn.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("home-animals-gauge")).toBeInTheDocument();
    expect(screen.queryByTestId("nav-module-devices")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-connectors-gauge")).not.toBeInTheDocument();
    expect(screen.queryByTestId("home-sensors-online")).not.toBeInTheDocument();
    view.unmount();

    const withConn = createMinimalTestClient({
      omitModulesList: true,
      cattleCount: 10,
      connectorsCount: 1,
    });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders initialClient={withConn.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("home-connectors-gauge")).toBeInTheDocument();
    expect(screen.getByTestId("nav-module-devices")).toHaveTextContent("Connections");
  });

  it("renders the calm not-added-yet state on /herd when disabled, with Ask Orion and Add it now actions", async () => {
    const { client, requestMock } = createMinimalTestClient();

    render(
      <MemoryRouter initialEntries={["/herd"]}>
        <AppProviders initialClient={client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("module-disabled-herd")).toBeInTheDocument();
    expect(screen.getByText("Cattle is not added yet")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("module-disabled-enable-herd"));

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("modules.enable", { moduleId: "herd" });
    });
    expect(await screen.findByTestId("herd-page")).toBeInTheDocument();
  });

  it("sends the module's prompt to Orion when clicking Ask Orion to add it on a disabled module route", async () => {
    const { client, requestMock } = createMinimalTestClient();

    render(
      <MemoryRouter initialEntries={["/cameras"]}>
        <AppProviders initialClient={client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("module-disabled-cameras")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("module-disabled-ask-cameras"));

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("chat.prompt", {
        sessionId: "session-1",
        text: "Set up barn cameras",
      });
    });
  });

  it("lists all three modules in Settings with who added them and toggles them on and off", async () => {
    const { client, requestMock, emit } = createMinimalTestClient({
      initialEnabled: ["herd"],
    });

    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <AppProviders initialClient={client}>
          <OrbitModulesCard />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("settings-modules-card")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("settings-module-status-herd")).toHaveTextContent(
        "Added automatically",
      );
    });
    expect(screen.getByTestId("settings-module-status-devices")).toHaveTextContent("Not added");
    expect(screen.getByTestId("settings-module-status-cameras")).toHaveTextContent("Not added");

    fireEvent.click(screen.getByTestId("settings-module-toggle-devices"));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("modules.enable", { moduleId: "devices" });
    });
    expect(screen.getByTestId("settings-module-status-devices")).toHaveTextContent("Added by you");

    act(() => {
      emit({
        type: "modules.updated",
        modules: [
          {
            id: "herd",
            enabled: true,
            enabledAt: "2026-11-09T08:00:00.000Z",
            enabledBy: "auto",
          },
          {
            id: "devices",
            enabled: true,
            enabledAt: "2026-11-09T09:15:00.000Z",
            enabledBy: "user",
          },
          {
            id: "cameras",
            enabled: true,
            enabledAt: "2026-11-09T09:20:00.000Z",
            enabledBy: "orion",
          },
        ],
      });
    });

    expect(await screen.findByTestId("settings-module-status-cameras")).toHaveTextContent(
      "Added by Orion",
    );

    fireEvent.click(screen.getByTestId("settings-module-toggle-herd"));
    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith("modules.disable", { moduleId: "herd" });
    });
    expect(screen.getByTestId("settings-module-status-herd")).toHaveTextContent("Not added");
  });

  it("shows the local-ui-ready-bar on localUi.updated ready event and hands off on button click", async () => {
    const { client, requestMock, emit } = createMinimalTestClient();
    const replaceSpy = vi.fn();
    const origLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...origLocation,
        pathname: "/",
        search: "",
        hash: "",
        href: "http://127.0.0.1:5173/",
        replace: replaceSpy,
      },
    });

    try {
      render(
        <MemoryRouter initialEntries={["/"]}>
          <AppProviders
            initialClient={client}
            initialEndpoint={{ url: "ws://127.0.0.1:7717/ws", token: "dev" }}
          >
            <AppRoutes />
          </AppProviders>
        </MemoryRouter>,
      );

      expect(await screen.findByTestId("home-minimal")).toBeInTheDocument();
      expect(screen.queryByTestId("local-ui-ready-bar")).not.toBeInTheDocument();

      act(() => {
        emit({
          type: "localUi.updated",
          state: "ready",
          path: "/app/tok-123/",
          builtAt: "2026-11-11T10:00:00.000Z",
          commit: "abc1234",
        });
      });

      expect(screen.getByTestId("local-ui-ready-bar")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("local-ui-ready-open"));
      await waitFor(() => {
        expect(requestMock).toHaveBeenCalledWith("localUi.launched", {});
      });
      await waitFor(() => {
        expect(replaceSpy).toHaveBeenCalledWith(
          expect.stringContaining("http://127.0.0.1:7717/app/tok-123/#return="),
        );
      });
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: origLocation,
      });
    }
  });
});

describe("update bar", () => {
  const farmBuild = (baseVersion: string): LocalUiStatus => ({
    state: "broken",
    path: null,
    builtAt: "2026-11-12T08:00:00.000Z",
    commit: "abc123",
    baseVersion,
  });
  const renderHome = (client: OrionClient) =>
    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders initialClient={client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );

  it("on a farm with its own build, Update asks Orion to move the farm's changes to the new version", async () => {
    Object.assign(appUpdate, { ready: true, version: "0.1.7" });
    appUpdate.restart.mockClear();
    try {
      const { client, requestMock } = createMinimalTestClient({ localUi: farmBuild("0.1.6") });
      renderHome(client);
      fireEvent.click(await screen.findByTestId("app-update-chat"));
      await waitFor(() => {
        expect(requestMock).toHaveBeenCalledWith("chat.prompt", {
          sessionId: "session-1",
          text: "Update Orbit to version 0.1.7 and keep my changes.",
        });
      });
      expect(appUpdate.restart).not.toHaveBeenCalled();
    } finally {
      Object.assign(appUpdate, { ready: false, version: null });
    }
  });

  it("once the farm's build is on the new version, or there is none, it restarts to update", async () => {
    Object.assign(appUpdate, { ready: true, version: "0.1.7" });
    try {
      for (const localUi of [farmBuild("0.1.7"), undefined]) {
        const { client } = createMinimalTestClient({ localUi });
        const view = renderHome(client);
        expect(await screen.findByTestId("app-update-restart")).toHaveTextContent(
          "Restart to update",
        );
        expect(screen.queryByTestId("app-update-chat")).not.toBeInTheDocument();
        view.unmount();
      }
    } finally {
      Object.assign(appUpdate, { ready: false, version: null });
    }
  });
});
