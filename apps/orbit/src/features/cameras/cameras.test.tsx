import type {
  CameraMapLayout,
  CameraRelayStatus,
  ConnectionState,
  DbMutationName,
  DbQueryName,
  DbQueryResults,
  OrionClient,
  ServerEvent,
} from "@orbit/protocol";
import type { Camera as CameraRow } from "@orbit/schema";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { AppProviders } from "../../app";
import { CamerasPage } from "./index";
import {
  buildDefaultLayouts,
  computeSnappedMove,
  DEFAULT_CAMERA_AR,
  DEFAULT_TILE_W,
  reconcileLayouts,
  snapToGrid,
  snapWidth,
  TILE_MARGIN,
} from "./lib/default-layout";
import { buildCameraSnapshotUrl, buildCameraWsUrl, getSupportedCodecs } from "./lib/stream";

const FARM_ID = "00000000-0000-4000-8000-00000000f001";
const NOW = "2026-11-05T12:00:00.000Z";

function makeCamera(overrides: Partial<CameraRow> & { id: string; name: string }): CameraRow {
  return {
    id: overrides.id,
    farmId: FARM_ID,
    name: overrides.name,
    location: overrides.location ?? null,
    onvifXaddr: overrides.onvifXaddr ?? null,
    rtspUrl: overrides.rtspUrl ?? "rtsp://192.168.1.35:554/stream1",
    credentialRef: overrides.credentialRef ?? "cred-1",
    status: overrides.status ?? "online",
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    hlc: "0001762128000000:000001:seed",
    originDevice: "seed",
  };
}

function createCameraTestClient(options?: {
  cameras?: CameraRow[];
  relay?: CameraRelayStatus;
  layout?: CameraMapLayout | null;
}) {
  let cameras = options?.cameras ?? [
    makeCamera({ id: "cam-calving", name: "Calving pen", location: "Calving barn" }),
    makeCamera({ id: "cam-parlour", name: "Milking parlour", location: "Main barn" }),
  ];
  const relay: CameraRelayStatus = options?.relay ?? {
    available: false,
    reason: "go2rtc not installed",
  };
  let storedLayout: CameraMapLayout | null = options?.layout ?? null;
  const mutateCalls: Array<{ mutation: DbMutationName; params: unknown }> = [];

  const client: OrionClient = {
    state: "open" as ConnectionState,
    server: { protocolVersion: 1, serverVersion: "0.1.0", farmId: FARM_ID },
    request: vi.fn() as unknown as OrionClient["request"],
    query: vi.fn(async <Q extends DbQueryName>(q: Q) => {
      switch (q) {
        case "cameras.list":
          return { rows: cameras } as DbQueryResults[Q];
        case "cameras.relay":
          return relay as DbQueryResults[Q];
        case "cameraLayout.get":
          return { layout: storedLayout } as DbQueryResults[Q];
        default:
          return { rows: [] } as unknown as DbQueryResults[Q];
      }
    }),
    mutate: vi.fn(async (mutation, params) => {
      mutateCalls.push({ mutation, params });
      if (mutation === "cameras.upsert") {
        const input = (params as { camera: Partial<CameraRow> & { name: string } }).camera;
        if (input.id) {
          cameras = cameras.map((c) =>
            c.id === input.id ? { ...c, name: input.name, location: input.location ?? null } : c,
          );
        }
      } else if (mutation === "cameraLayout.save") {
        storedLayout = (params as { layout: CameraMapLayout }).layout;
      }
      return { ids: ["cam-calving"], snapshotId: "snap-1" };
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

describe("Camera stream & snapshot URL builders", () => {
  it("builds ws/wss and http/https camera URLs from Orion endpoint and encodes token + id", () => {
    const devEndpoint = { url: "ws://127.0.0.1:7717/ws", token: "dev/token?1" };
    expect(buildCameraWsUrl(devEndpoint, "cam-1")).toBe(
      "ws://127.0.0.1:7717/camera/dev%2Ftoken%3F1/cam-1/ws",
    );
    expect(buildCameraSnapshotUrl(devEndpoint, "cam-1")).toBe(
      "http://127.0.0.1:7717/camera/dev%2Ftoken%3F1/cam-1/frame.jpeg",
    );
    expect(buildCameraSnapshotUrl(devEndpoint, "cam-1", 12345)).toBe(
      "http://127.0.0.1:7717/camera/dev%2Ftoken%3F1/cam-1/frame.jpeg?_t=12345",
    );

    const tlsEndpoint = { url: "wss://orbit.example.com:8443/ws", token: "sec" };
    expect(buildCameraWsUrl(tlsEndpoint, "cam-2")).toBe(
      "wss://orbit.example.com:8443/camera/sec/cam-2/ws",
    );
    expect(buildCameraSnapshotUrl(tlsEndpoint, "cam-2")).toBe(
      "https://orbit.example.com:8443/camera/sec/cam-2/frame.jpeg",
    );

    expect(buildCameraWsUrl(null, "cam-1")).toBe("");
    expect(buildCameraWsUrl({ url: "ws://127.0.0.1:7717/ws", token: "" }, "cam-1")).toBe("");
    expect(buildCameraWsUrl(devEndpoint, "   ")).toBe("");
    expect(buildCameraSnapshotUrl({ url: "not a url", token: "dev" }, "cam-1")).toBe("");
  });

  it("filters MSE_CODECS through MediaSource.isTypeSupported", () => {
    const orig = (globalThis as { MediaSource?: unknown }).MediaSource;
    try {
      (globalThis as { MediaSource?: unknown }).MediaSource = {
        isTypeSupported: (mime: string) => mime.includes("avc1.640029") || mime.includes("opus"),
      };
      expect(getSupportedCodecs()).toBe("avc1.640029,opus");
    } finally {
      (globalThis as { MediaSource?: unknown }).MediaSource = orig;
    }
  });
});

describe("Barn-map default layout and reconciliation", () => {
  it("packs cameras in a 3-column grid and auto-places missing cameras below existing tiles", () => {
    const cams = [{ id: "c1" }, { id: "c2" }, { id: "c3" }, { id: "c4" }];
    const initial = buildDefaultLayouts(cams);
    expect(initial.version).toBe(2);
    expect(initial.tiles).toHaveLength(4);
    expect(initial.tiles[0]).toEqual({
      i: "c1",
      x: 0,
      y: 0,
      w: DEFAULT_TILE_W,
      ar: DEFAULT_CAMERA_AR,
    });
    expect(initial.tiles[3]?.x).toBe(0);
    expect(initial.tiles[3]?.y).toBeCloseTo(DEFAULT_TILE_W / DEFAULT_CAMERA_AR + TILE_MARGIN, 4);

    const customStored: CameraMapLayout = {
      version: 2,
      tiles: [{ i: "c1", x: 100, y: 80, w: 640, ar: DEFAULT_CAMERA_AR }],
    };
    const reconciled = reconcileLayouts([{ id: "c1" }, { id: "c2" }], customStored);
    expect(reconciled.tiles[0]).toEqual({
      i: "c1",
      x: 100,
      y: 80,
      w: 640,
      ar: DEFAULT_CAMERA_AR,
    });
    expect(reconciled.tiles[1]?.i).toBe("c2");
    expect(reconciled.tiles[1]?.y).toBeCloseTo(80 + 640 / DEFAULT_CAMERA_AR + TILE_MARGIN, 4);
  });

  it("snaps coordinates to neighbor edges or grid and snaps widths to presets", () => {
    expect(snapToGrid(33)).toBe(40);
    expect(snapWidth(472, [600])).toBe(480);
    expect(snapWidth(595, [600])).toBe(600);

    const moved = computeSnappedMove({
      id: "c2",
      rawX: 504,
      rawY: 14,
      width: 480,
      height: 274,
      tiles: [{ i: "c1", x: 20, y: 20, w: 480, ar: DEFAULT_CAMERA_AR }],
    });
    expect(moved.x).toBe(500);
    expect(moved.y).toBe(20);
    expect(moved.guideX).toBe(500);
    expect(moved.guideY).toBe(20);
  });
});

describe("CamerasPage BarnMapCanvas, BarnSelector, and layout persistence", () => {
  it("filters cameras by barn location, moves a camera between barns, and debounces layout saves", async () => {
    const { client, mutateCalls } = createCameraTestClient();

    render(
      <MemoryRouter initialEntries={["/cameras"]}>
        <AppProviders
          initialClient={client}
          initialEndpoint={{ url: "ws://127.0.0.1:7717/ws", token: "dev" }}
        >
          <CamerasPage />
        </AppProviders>
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("camera-barn-map")).toBeInTheDocument();
    expect(screen.getByTestId("cameras-relay-notice")).toHaveAttribute(
      "title",
      "go2rtc not installed",
    );
    expect(screen.getByTestId("camera-barn-selector")).toBeInTheDocument();

    expect(screen.getByTestId("camera-tile-cam-calving")).toBeInTheDocument();
    expect(screen.getByTestId("camera-snapshot-cam-calving")).toBeInTheDocument();
    expect(screen.queryByTestId("camera-tile-cam-parlour")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("camera-barn-option-Main barn"));
    expect(await screen.findByTestId("camera-tile-cam-parlour")).toBeInTheDocument();
    expect(screen.queryByTestId("camera-tile-cam-calving")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("camera-tile-menu-cam-parlour"));
    fireEvent.click(screen.getByTestId("camera-move-barn-cam-parlour-Calving barn"));

    await waitFor(() => {
      expect(mutateCalls).toContainEqual({
        mutation: "cameras.upsert",
        params: {
          camera: {
            id: "cam-parlour",
            name: "Milking parlour",
            location: "Calving barn",
            rtspUrl: "rtsp://192.168.1.35:554/stream1",
            onvifXaddr: null,
            status: "online",
          },
        },
      });
    });

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByTestId("cameras-tidy-btn"));
      expect(mutateCalls.filter((m) => m.mutation === "cameraLayout.save")).toHaveLength(0);
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(mutateCalls.filter((m) => m.mutation === "cameraLayout.save")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
