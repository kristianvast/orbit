import type {
  AnimalListItem,
  ConnectionState,
  DbMutationName,
  DbQueryName,
  DbQueryResults,
  DeviceListItem,
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

function createFarmMockClient() {
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

  const devices: DeviceListItem[] = [
    {
      id: "dev-collar-1",
      kind: "collar",
      vendor: "Nedap",
      model: "SmartTag Neck",
      serial: "COL-101",
      connection: null,
      status: "online",
      batteryPct: 88,
      lastSeenAt: NOW,
      boundAnimalId: "animal-bella",
      ...makeSyncCols(),
    },
    {
      id: "dev-bolus-1",
      kind: "bolus",
      vendor: "smaXtec",
      model: "Climate Bolus",
      serial: "BOL-201",
      connection: null,
      status: "online",
      batteryPct: null,
      lastSeenAt: NOW,
      boundAnimalId: "animal-daisy",
      ...makeSyncCols(),
    },
    {
      id: "dev-spare-eartag",
      kind: "ear_tag_sensor",
      vendor: "CowManager",
      model: "SensOor",
      serial: "EAR-399",
      connection: null,
      status: "online",
      batteryPct: 96,
      lastSeenAt: NOW,
      boundAnimalId: null,
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
    query: vi.fn(async <Q extends DbQueryName>(q: Q) => {
      switch (q) {
        case "animals.list":
          return { rows: animals, total: animals.length } as DbQueryResults[Q];
        case "animals.get":
          return {
            animal: animals[0],
            wearable: animals[0]?.wearable ?? null,
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
        case "devices.list":
          return { rows: devices } as DbQueryResults[Q];
        case "connectors.list":
          return {
            rows: [
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
            ],
          } as unknown as DbQueryResults[Q];
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

describe("Farm Data Screens: Herd sorting & One-wearable sensor binding", () => {
  it("sorts the herd register table by ear tag, name, and last milking yield", async () => {
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
  });

  it("explains the one-wearable rule (collar OR bolus OR ear tag) and replaces an existing wearable when attaching a spare sensor", async () => {
    const { client, mutateCalls } = createFarmMockClient();

    render(
      <MemoryRouter initialEntries={["/devices"]}>
        <AppProviders initialClient={client}>
          <DevicesPage />
        </AppProviders>
      </MemoryRouter>,
    );

    const attachSpareBtn = await screen.findByTestId("device-attach-btn-EAR-399");
    fireEvent.click(attachSpareBtn);

    const dialog = await screen.findByTestId("device-bind-dialog");
    expect(dialog).toBeInTheDocument();

    const ruleBox = screen.getByTestId("device-bind-rule-explanation");
    expect(ruleBox.textContent).toMatch(/collar/i);
    expect(ruleBox.textContent).toMatch(/bolus/i);
    expect(ruleBox.textContent).toMatch(/ear tag sensor/i);

    const conflictWarning = screen.getByTestId("device-bind-conflict-warning");
    expect(conflictWarning.textContent).toMatch(/Bella already wears a collar/i);

    const selectEl = screen.getByTestId("device-bind-animal-select");
    expect(selectEl.textContent).not.toMatch(/\ba ear tag sensor\b/i);

    const confirmBtn = screen.getByTestId("device-bind-confirm-btn");
    expect(confirmBtn.textContent).toMatch(/Replace collar & attach/i);

    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mutateCalls).toEqual([
        {
          mutation: "bindings.clear",
          params: { deviceId: "dev-collar-1" },
        },
        {
          mutation: "bindings.set",
          params: { deviceId: "dev-spare-eartag", animalId: "animal-bella" },
        },
      ]);
    });
  });

  it("uses 'an ear tag sensor' (vowel-sound article) when an animal wears an ear tag sensor", async () => {
    const { client } = createFarmMockClient();
    const firstQueryResult = await client.query("animals.list", {});
    const bella = firstQueryResult.rows[0];
    if (bella) {
      bella.wearable = {
        deviceId: "dev-spare-eartag",
        kind: "ear_tag_sensor",
        vendor: "CowManager",
        batteryPct: 96,
      };
    }

    render(
      <MemoryRouter initialEntries={["/devices"]}>
        <AppProviders initialClient={client}>
          <DevicesPage />
        </AppProviders>
      </MemoryRouter>,
    );

    const attachCollarBtn = await screen.findByTestId("device-attach-btn-COL-101");
    fireEvent.click(attachCollarBtn);

    const conflictWarning = await screen.findByTestId("device-bind-conflict-warning");
    expect(conflictWarning.textContent).toMatch(/Bella already wears an ear tag sensor/i);
    expect(conflictWarning.textContent).not.toMatch(/\ba ear tag sensor\b/i);
  });
});
