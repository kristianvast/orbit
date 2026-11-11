import type {
  AnimalListItem,
  ConnectionState,
  DbMutationName,
  DbQueryName,
  DbQueryResults,
  OrionClient,
  ServerEvent,
} from "@orbit/protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { AppProviders } from "../../app";
import { DevicesPage } from "../devices";
import { HerdPage } from "./index";

const FARM_ID = "00000000-0000-4000-8000-00000000f001";
const NOW = "2026-11-03T12:00:00.000Z";

function makeSyncCols() {
  return {
    farmId: FARM_ID,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    hlc: "0001762128000000:000001:seed",
    originDevice: "seed",
  };
}

const NO_ADE_FIELDS = {
  identifierScheme: null,
  alternativeIdentifiers: null,
  reproductionStatus: null,
  lactationStatus: null,
};

type ConnectorRow = DbQueryResults["connectors.list"]["rows"][number];

function createFarmMockClient(options?: { connectors?: ConnectorRow[] }) {
  const animals: AnimalListItem[] = [
    {
      id: "animal-bella",
      species: "cattle",
      name: "Bella",
      earTagNumber: "DK-1002",
      nationalId: "CATTLE-500102",
      breed: "Holstein",
      sex: "female",
      birthDate: "2021-03-14",
      groupName: "Milking",
      status: "active",
      notes: null,
      ...NO_ADE_FIELDS,
      wearable: {
        deviceId: "dev-collar-1",
        kind: "collar",
        vendor: "Nedap",
        batteryPct: 88,
      },
      ...makeSyncCols(),
    },
    {
      id: "animal-daisy",
      species: "cattle",
      name: "Daisy",
      earTagNumber: "DK-1001",
      nationalId: "CATTLE-500101",
      breed: "Jersey",
      sex: "female",
      birthDate: "2020-05-10",
      groupName: "Dry",
      status: "active",
      notes: null,
      ...NO_ADE_FIELDS,
      wearable: {
        deviceId: "dev-bolus-1",
        kind: "bolus",
        vendor: "smaXtec",
        batteryPct: null,
      },
      ...makeSyncCols(),
    },
    {
      id: "animal-storm",
      species: "horse",
      name: "Storm",
      earTagNumber: null,
      nationalId: "UELN-STORM",
      breed: "Warmblood",
      sex: "castrated",
      birthDate: "2017-04-01",
      groupName: "Stable",
      status: "active",
      notes: null,
      ...NO_ADE_FIELDS,
      wearable: null,
      ...makeSyncCols(),
    },
  ];

  const connectors: ConnectorRow[] = options?.connectors ?? [
    {
      id: "conn-lely",
      vendor: "lely",
      kind: "local_api",
      name: "Lely Horizon",
      config: { host: "192.168.1.20" },
      enabled: true,
      lastSyncAt: NOW,
      lastError: null,
      ...makeSyncCols(),
    },
  ];

  const mutateCalls: Array<{ mutation: DbMutationName; params: unknown }> = [];

  const client: OrionClient = {
    state: "open" as ConnectionState,
    server: {
      protocolVersion: 1,
      serverVersion: "0.1.0",
      farmId: FARM_ID,
    },
    request: vi.fn() as unknown as OrionClient["request"],
    query: vi.fn(async <Q extends DbQueryName>(q: Q, params?: unknown) => {
      switch (q) {
        case "animals.list":
          return { rows: animals, total: animals.length } as DbQueryResults[Q];
        case "animals.get": {
          const id = (params as { id?: string } | undefined)?.id;
          const found = animals.find((a) => a.id === id) ?? animals[0];
          return {
            animal: found,
            wearable: found?.wearable ?? null,
            bindings: [],
            devices: [],
            recentObservations: [
              {
                id: "obs-milk-bella",
                animalId: "animal-bella",
                deviceId: "robot-1",
                kind: "milking",
                ts: NOW,
                valueNum: 14.2,
                valueJson: { unit: "kg" },
                source: "connector:lely",
                ...makeSyncCols(),
              },
            ],
          } as unknown as DbQueryResults[Q];
        }
        case "connectors.list":
          return { rows: connectors } as unknown as DbQueryResults[Q];
        case "observations.recent":
          return {
            rows: [
              {
                id: "obs-milk-1",
                animalId: "animal-bella",
                deviceId: "robot-1",
                kind: "milking",
                ts: NOW,
                valueNum: 14.2,
                valueJson: { unit: "kg" },
                source: "connector:lely",
                ...makeSyncCols(),
              },
              {
                id: "obs-milk-2",
                animalId: "animal-daisy",
                deviceId: "robot-1",
                kind: "milking",
                ts: NOW,
                valueNum: 9.4,
                valueJson: { unit: "kg" },
                source: "connector:lely",
                ...makeSyncCols(),
              },
            ],
          } as unknown as DbQueryResults[Q];
        default:
          return { rows: [] } as unknown as DbQueryResults[Q];
      }
    }),
    mutate: vi.fn(async (mutation, params) => {
      mutateCalls.push({ mutation, params });
      return { ids: ["mutated-id"], snapshotId: "snap-1" };
    }),
    on(_type: string, _handler: (event: ServerEvent) => void) {
      return () => {};
    },
    onState(_handler) {
      return () => {};
    },
    ready: () => Promise.resolve(),
    close: vi.fn(),
  };

  return { client, mutateCalls };
}

describe("Farm Data Screens: Herd register & Connections screen", () => {
  it("sorts the herd register table, shows wearables read-only only when present, and drops the wearable column when none in the list have one", async () => {
    const { client } = createFarmMockClient();

    render(
      <MemoryRouter initialEntries={["/herd"]}>
        <AppProviders initialClient={client}>
          <HerdPage initialViewMode="table" />
        </AppProviders>
      </MemoryRouter>,
    );

    const table = await screen.findByTestId("herd-table");
    const getRowNames = () =>
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.textContent ?? "");

    await waitFor(() => {
      expect(getRowNames().length).toBe(3);
    });

    expect(screen.getByTestId("herd-sort-wearable")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("herd-sort-name"));
    const ascByName = getRowNames();
    expect(ascByName[0]).toContain("Bella");
    expect(ascByName[1]).toContain("Daisy");
    expect(ascByName[2]).toContain("Storm");

    fireEvent.click(screen.getByTestId("herd-sort-name"));
    const descByName = getRowNames();
    expect(descByName[0]).toContain("Storm");
    expect(descByName[2]).toContain("Bella");

    fireEvent.click(screen.getByTestId("herd-sort-lastMilking"));
    fireEvent.click(screen.getByTestId("herd-sort-lastMilking"));
    const descByMilk = getRowNames();
    expect(descByMilk[0]).toContain("Bella");
    expect(descByMilk[0]).toContain("14.2 kg");

    fireEvent.click(screen.getByTestId("herd-inspect-DK-1002"));
    const drawer = await screen.findByTestId("animal-detail-drawer");
    expect(within(drawer).getByTestId("animal-drawer-wearable-card")).toHaveTextContent("Collar");
    expect(screen.queryByTestId("animal-drawer-attach-sensor-btn")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("herd-inspect-animal-storm"));
    await waitFor(() => {
      expect(screen.queryByTestId("animal-drawer-wearable-card")).not.toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("herd-filter-species"), { target: { value: "horse" } });
    await waitFor(() => {
      expect(screen.queryByTestId("herd-sort-wearable")).not.toBeInTheDocument();
    });
  });

  it("renders Connections with configured connectors, keychain password dialog, sync action, and compact empty state when none exist", async () => {
    const { client, mutateCalls } = createFarmMockClient();

    const view = render(
      <MemoryRouter initialEntries={["/devices"]}>
        <AppProviders initialClient={client}>
          <DevicesPage />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", { level: 1, name: "Connections" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("connector-card-lely")).toHaveTextContent("Lely Horizon");
    expect(screen.queryByTestId("devices-add-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("device-attach-btn-COL-101")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("connector-sync-lely"));
    await waitFor(() => {
      expect(mutateCalls).toContainEqual({
        mutation: "connectors.syncNow",
        params: { id: "conn-lely" },
      });
    });

    fireEvent.click(screen.getByTestId("connector-password-lely"));
    fireEvent.change(await screen.findByTestId("connector-password-input"), {
      target: { value: "barn-secret-123" },
    });
    fireEvent.click(screen.getByTestId("connector-password-save"));

    await waitFor(() => {
      expect(mutateCalls).toContainEqual({
        mutation: "connectors.upsert",
        params: {
          connector: {
            id: "conn-lely",
            vendor: "lely",
            kind: "local_api",
            name: "Lely Horizon",
            secret: "barn-secret-123",
          },
        },
      });
    });

    view.unmount();

    const emptyClient = createFarmMockClient({ connectors: [] });
    render(
      <MemoryRouter initialEntries={["/devices"]}>
        <AppProviders initialClient={emptyClient.client}>
          <DevicesPage />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("connect-something-new-btn")).toBeInTheDocument();
  });
});
