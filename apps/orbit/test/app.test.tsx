import type {
  ConnectionState,
  DbQueryName,
  DbQueryResults,
  OrionClient,
  ServerEvent,
} from "@orbit/protocol";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../src/app";
import { Badge, Button, Dialog, OrbitRings, Tabs } from "../src/design";

function createFakeOrionClient(options?: {
  state?: ConnectionState;
  summary?: DbQueryResults["farm.summary"];
}): {
  client: OrionClient;
  emitState: (s: ConnectionState) => void;
  emitEvent: (ev: ServerEvent) => void;
} {
  let currentState: ConnectionState = options?.state ?? "open";
  const stateListeners = new Set<(s: ConnectionState) => void>();
  const eventListeners = new Map<string, Set<(ev: ServerEvent) => void>>();

  const defaultSummary: DbQueryResults["farm.summary"] = options?.summary ?? {
    farm: {
      id: "00000000-0000-4000-8000-00000000f001",
      farmId: "00000000-0000-4000-8000-00000000f001",
      name: "Oak Hollow Dairy & Stud",
      timezone: "UTC",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      deletedAt: null,
      hlc: "0001762128000000:000001:seed",
      originDevice: "seed",
    },
    counts: {
      cattle: 24,
      horses: 4,
      devices: 25,
      devicesOffline: 1,
      cameras: 3,
      camerasOnline: 2,
      connectors: 4,
      connectorsWithErrors: 0,
    },
    recentAlerts: [
      {
        id: "obs-calving-1",
        farmId: "00000000-0000-4000-8000-00000000f001",
        animalId: "animal-1",
        deviceId: "device-1",
        kind: "calving_alert",
        ts: new Date(Date.now() - 45 * 60_000).toISOString(),
        valueNum: 1,
        valueJson: { note: "Bella (DK-1001) showing calving restlessness in Calving pen" },
        source: "connector:smaxtec",
        createdAt: "2026-11-03T10:00:00.000Z",
        updatedAt: "2026-11-03T10:00:00.000Z",
        deletedAt: null,
        hlc: "0001762128000000:000002:seed",
        originDevice: "seed",
      },
      {
        id: "obs-health-2",
        farmId: "00000000-0000-4000-8000-00000000f001",
        animalId: "animal-2",
        deviceId: "device-2",
        kind: "health_event",
        ts: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        valueNum: 40.4,
        valueJson: { unit: "C", note: "Rosa (DK-1003) bolus temperature 40.4 °C" },
        source: "connector:smaxtec",
        createdAt: "2026-11-03T08:00:00.000Z",
        updatedAt: "2026-11-03T08:00:00.000Z",
        deletedAt: null,
        hlc: "0001762128000000:000003:seed",
        originDevice: "seed",
      },
    ],
  };

  const client: OrionClient = {
    get state() {
      return currentState;
    },
    server: {
      protocolVersion: 1,
      serverVersion: "0.1.0",
      farmId: "00000000-0000-4000-8000-00000000f001",
    },
    request: vi.fn() as unknown as OrionClient["request"],
    query: vi.fn(async <Q extends DbQueryName>(q: Q) => {
      if (q === "farm.summary") {
        return defaultSummary as DbQueryResults[Q];
      }
      throw new Error(`Unexpected query: ${q}`);
    }),
    mutate: vi.fn(),
    on(type: string, handler: (event: never) => void) {
      let set = eventListeners.get(type);
      if (!set) {
        set = new Set();
        eventListeners.set(type, set);
      }
      const fn = handler as (ev: ServerEvent) => void;
      set.add(fn);
      return () => set.delete(fn);
    },
    onState(handler) {
      stateListeners.add(handler);
      return () => stateListeners.delete(handler);
    },
    ready: () => Promise.resolve(),
    close: vi.fn(),
  };

  return {
    client,
    emitState(next: ConnectionState) {
      currentState = next;
      for (const l of stateListeners) l(next);
    },
    emitEvent(ev: ServerEvent) {
      for (const key of [ev.type, "*"]) {
        for (const l of eventListeners.get(key) ?? []) l(ev);
      }
    },
  };
}

describe("@orbit/app UI shell and design system", () => {
  it("renders Home summary, navigation rail, OrbitRings, and navigates across routes", async () => {
    const { client } = createFakeOrionClient();

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders initialClient={client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("heading", {
          level: 1,
          name: /(things? needs? a look today|All quiet in the barn today)/i,
        }),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByText("Bella (DK-1001) showing calving restlessness in Calving pen"),
    ).toBeInTheDocument();
    expect(screen.getByText("Rosa (DK-1003) bolus temperature 40.4 °C")).toBeInTheDocument();
    expect(screen.getByText(/Collar OR bolus OR ear tag sensor/i)).toBeInTheDocument();

    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Cows & Horses/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Sensors & Robots/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Cameras/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Settings/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: /Cows & Horses/i }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Cows & Horses" })).toBeInTheDocument();
    });
  });

  it("shows a friendly connection banner when Orion is reconnecting", async () => {
    const { client } = createFakeOrionClient({ state: "reconnecting" });

    render(
      <MemoryRouter initialEntries={["/"]}>
        <AppProviders initialClient={client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(screen.getByText(/Orion assistant is not reachable right now/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry connection/i })).toBeInTheDocument();
  });

  it("renders design primitives (Button, Badge, Tabs, Dialog, OrbitRings) accessibly", () => {
    const onClose = vi.fn();
    render(
      <div>
        <Button variant="primary" loading>
          Save animal
        </Button>
        <Badge variant="ok">Healthy</Badge>
        <OrbitRings centerLabel="FARM" centerSublabel="28 head" />
        <Tabs
          items={[
            { id: "cattle", label: "Cattle", content: <div>24 cows</div> },
            { id: "horses", label: "Horses", content: <div>4 horses</div> },
          ]}
        />
        <Dialog open title="Bind sensor" onClose={onClose}>
          <p>Choose collar, bolus, or ear tag sensor</p>
        </Dialog>
      </div>,
    );

    expect(screen.getByRole("button", { name: "Save animal" })).toBeDisabled();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Farm orbit diagram/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Horses" }));
    expect(screen.getByText("4 horses")).toBeInTheDocument();

    expect(screen.getByRole("dialog", { name: "Bind sensor" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
