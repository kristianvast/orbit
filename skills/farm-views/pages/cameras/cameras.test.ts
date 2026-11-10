import { describe, expect, test } from "bun:test";
import {
  buildCardFallbackList,
  buildLocationChips,
  createFrameState,
  DEFAULT_CONFIG,
  filterByLocation,
  formatPictureTime,
  formatSummary,
  getCameraLocation,
  getCameraStatus,
  getNextRefreshSeconds,
  locationSlug,
  NO_LOCATION_LABEL,
  ORDER_REGISTRY,
  pickCardCamera,
  reduceFrameState,
  resolveConfig,
  selectPanelCameras,
  shouldRequestFrame,
  sortCameras,
  UNAVAILABLE_RETRY_SECONDS,
  visibleCameras,
} from "./cameras.js";

const SAMPLE_CAMERAS = [
  {
    id: "cam-1",
    name: "Robot entrance",
    location: "Milking parlour",
    status: "online",
  },
  {
    id: "cam-2",
    name: "Calving pen",
    location: "Calving pen",
    status: "online",
  },
  {
    id: "cam-3",
    name: "Stable aisle",
    location: "Horse stable",
    status: "offline",
  },
];

describe("resolveConfig", () => {
  test("returns shipped defaults when input is missing or invalid", () => {
    expect(resolveConfig(undefined)).toEqual({
      card: { camera: null, refreshSeconds: 15 },
      panel: { refreshSeconds: 5, zoomRefreshSeconds: 2 },
      locations: [],
      order: "location",
      hide: [],
    });
    expect(resolveConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(resolveConfig("invalid")).toEqual(DEFAULT_CONFIG);
  });

  test("clamps refreshSeconds values to 1..120", () => {
    const low = resolveConfig({
      card: { camera: "cam-1", refreshSeconds: 0 },
      panel: { refreshSeconds: -10, zoomRefreshSeconds: 0.2 },
    });
    expect(low.card.refreshSeconds).toBe(1);
    expect(low.panel.refreshSeconds).toBe(1);
    expect(low.panel.zoomRefreshSeconds).toBe(1);

    const high = resolveConfig({
      card: { refreshSeconds: 300 },
      panel: { refreshSeconds: 999, zoomRefreshSeconds: 121 },
    });
    expect(high.card.refreshSeconds).toBe(120);
    expect(high.panel.refreshSeconds).toBe(120);
    expect(high.panel.zoomRefreshSeconds).toBe(120);
  });

  test("ignores unknown keys and falls back on unknown order option", () => {
    const resolved = resolveConfig({
      card: { camera: "  Calving pen  ", refreshSeconds: 20, extraCardOption: true },
      panel: { refreshSeconds: 8, zoomRefreshSeconds: 3, unknownKey: 42 },
      locations: ["Calving pen", "  ", "Calving pen", 123],
      order: "random-order",
      hide: ["Stable aisle", "", "Stable aisle"],
      unexpectedTopLevel: "ignored",
    });

    expect(resolved).toEqual({
      card: { camera: "Calving pen", refreshSeconds: 20 },
      panel: { refreshSeconds: 8, zoomRefreshSeconds: 3 },
      locations: ["Calving pen"],
      order: "location",
      hide: ["Stable aisle"],
    });
    expect("unexpectedTopLevel" in resolved).toBe(false);
  });
});

describe("visibleCameras and ordering", () => {
  test("hides cameras matched by name or id", () => {
    const byName = visibleCameras(SAMPLE_CAMERAS, { hide: ["Stable aisle"] });
    expect(byName.map((c) => c.id)).toEqual(["cam-1", "cam-2"]);

    const byId = visibleCameras(SAMPLE_CAMERAS, { hide: ["cam-1"] });
    expect(byId.map((c) => c.name)).toEqual(["Calving pen", "Stable aisle"]);
  });

  test("orders by location name then camera name ('location')", () => {
    const cams = [
      { id: "1", name: "West corner", location: "Milking parlour", status: "online" },
      { id: "2", name: "Unassigned cam", location: null, status: "online" },
      { id: "3", name: "East corner", location: "Milking parlour", status: "offline" },
      { id: "4", name: "Main view", location: "Calving pen", status: "online" },
    ];
    const sorted = sortCameras(cams, "location");
    expect(sorted.map((c) => c.name)).toEqual([
      "Main view",
      "East corner",
      "West corner",
      "Unassigned cam",
    ]);
    expect(ORDER_REGISTRY.location.id).toBe("location");
  });

  test("orders alphabetically by camera name ('name')", () => {
    const sorted = sortCameras(SAMPLE_CAMERAS, "name");
    expect(sorted.map((c) => c.name)).toEqual(["Calving pen", "Robot entrance", "Stable aisle"]);
    const panel = selectPanelCameras(SAMPLE_CAMERAS, { hide: ["Stable aisle"], order: "name" });
    expect(panel.map((c) => c.name)).toEqual(["Calving pen", "Robot entrance"]);
  });

  test("orders online cameras first ('online-first')", () => {
    const cams = [
      { id: "1", name: "Aisle", location: "Barn A", status: "offline" },
      { id: "2", name: "Yard", location: "Barn C", status: "unknown" },
      { id: "3", name: "Gate", location: "Barn B", status: "online" },
      { id: "4", name: "Feeder", location: "Barn A", status: "error" },
      { id: "5", name: "Box 1", location: "Barn A", status: "online" },
    ];
    const sorted = sortCameras(cams, "online-first");
    expect(sorted.map((c) => c.name)).toEqual(["Box 1", "Gate", "Feeder", "Yard", "Aisle"]);
  });
});

describe("location chips and filtering", () => {
  test("builds All chip first followed by all farm locations with counts and slugs", () => {
    const chips = buildLocationChips(SAMPLE_CAMERAS, { locations: [] });
    expect(chips).toEqual([
      { id: "all", label: "All", slug: "all", count: 3, testId: "cameras-filter-all" },
      {
        id: "Calving pen",
        label: "Calving pen",
        slug: "calving-pen",
        count: 1,
        testId: "cameras-filter-calving-pen",
      },
      {
        id: "Horse stable",
        label: "Horse stable",
        slug: "horse-stable",
        count: 1,
        testId: "cameras-filter-horse-stable",
      },
      {
        id: "Milking parlour",
        label: "Milking parlour",
        slug: "milking-parlour",
        count: 1,
        testId: "cameras-filter-milking-parlour",
      },
    ]);
  });

  test("groups cameras without a location under 'No location'", () => {
    const cams = [
      ...SAMPLE_CAMERAS,
      { id: "cam-4", name: "Yard cam", location: "", status: "online" },
      { id: "cam-5", name: "Gate cam", location: null, status: "offline" },
    ];
    expect(getCameraLocation(cams[3])).toBe(NO_LOCATION_LABEL);
    const chips = buildLocationChips(cams, { locations: [] });
    const noLocChip = chips.find((c) => c.id === NO_LOCATION_LABEL);
    expect(noLocChip).toEqual({
      id: "No location",
      label: "No location",
      slug: "no-location",
      count: 2,
      testId: "cameras-filter-no-location",
    });
    expect(chips[chips.length - 1]?.id).toBe("No location");

    const filtered = filterByLocation(cams, "No location");
    expect(filtered.map((c) => c.id)).toEqual(["cam-4", "cam-5"]);
  });

  test("honours configured locations order and skips unknown locations", () => {
    const visible = visibleCameras(SAMPLE_CAMERAS, { hide: ["Stable aisle"] });
    const chips = buildLocationChips(visible, {
      locations: ["Calving pen", "Unknown barn"],
    });
    expect(chips).toEqual([
      { id: "all", label: "All", slug: "all", count: 2, testId: "cameras-filter-all" },
      {
        id: "Calving pen",
        label: "Calving pen",
        slug: "calving-pen",
        count: 1,
        testId: "cameras-filter-calving-pen",
      },
    ]);
  });

  test("filters cameras by selected location or returns all for 'all'", () => {
    expect(filterByLocation(SAMPLE_CAMERAS, "all")).toHaveLength(3);
    expect(filterByLocation(SAMPLE_CAMERAS, "Horse stable").map((c) => c.name)).toEqual([
      "Stable aisle",
    ]);
    expect(locationSlug("Calving Pen #2!")).toBe("calving-pen-2");
  });
});

describe("pickCardCamera", () => {
  test("picks configured camera by name or id when visible", () => {
    const byName = pickCardCamera(SAMPLE_CAMERAS, {
      card: { camera: "Robot entrance", refreshSeconds: 15 },
      order: "location",
    });
    expect(byName?.id).toBe("cam-1");

    const byId = pickCardCamera(SAMPLE_CAMERAS, {
      card: { camera: "cam-3", refreshSeconds: 15 },
      order: "location",
    });
    expect(byId?.name).toBe("Stable aisle");
  });

  test("falls back to first online camera in panel order when card.camera is null or unknown", () => {
    const pickedDefault = pickCardCamera(SAMPLE_CAMERAS, {
      card: { camera: null, refreshSeconds: 15 },
      order: "location",
    });
    // In location order: Calving pen (online), Stable aisle (offline), Robot entrance (online)
    expect(pickedDefault?.name).toBe("Calving pen");

    const pickedUnknown = pickCardCamera(SAMPLE_CAMERAS, {
      card: { camera: "Nonexistent", refreshSeconds: 15 },
      order: "location",
    });
    expect(pickedUnknown?.name).toBe("Calving pen");
  });

  test("falls back to first camera when no camera is online, and null when empty", () => {
    const allOffline = [
      { id: "a", name: "North", location: "Barn B", status: "offline" },
      { id: "b", name: "South", location: "Barn A", status: "error" },
    ];
    const picked = pickCardCamera(allOffline, { order: "location" });
    expect(picked?.name).toBe("South");
    expect(pickCardCamera([], {})).toBeNull();
  });
});

describe("status wording, summary, and formatting helpers", () => {
  test("maps each status to exact wording, tone, and frame-request policy", () => {
    expect(getCameraStatus("online")).toMatchObject({
      label: "Online",
      tone: "ok",
      requestsFrames: true,
    });
    expect(getCameraStatus("offline")).toMatchObject({
      label: "Offline",
      tone: "neutral",
      requestsFrames: false,
    });
    expect(getCameraStatus("error")).toMatchObject({
      label: "Not responding",
      tone: "danger",
      requestsFrames: true,
    });
    expect(getCameraStatus("unknown")).toMatchObject({
      label: "Not checked yet",
      tone: "neutral",
      requestsFrames: true,
    });
    expect(shouldRequestFrame({ status: "online" })).toBe(true);
    expect(shouldRequestFrame({ status: "error" })).toBe(true);
    expect(shouldRequestFrame({ status: "unknown" })).toBe(true);
    expect(shouldRequestFrame({ status: "offline" })).toBe(false);
  });

  test("formats the online summary and card fallback list", () => {
    expect(formatSummary(SAMPLE_CAMERAS)).toBe("2 of 3 online");
    expect(formatSummary([])).toBe("0 of 0 online");

    const fiveCams = [
      ...SAMPLE_CAMERAS,
      { id: "cam-4", name: "Feed alley", location: "Barn", status: "error" },
      { id: "cam-5", name: "Pasture gate", location: "Pasture", status: "unknown" },
    ];
    const fallback = buildCardFallbackList(fiveCams, 4);
    expect(fallback.items).toHaveLength(4);
    expect(fallback.extraCount).toBe(1);
    expect(fallback.moreLabel).toBe("+1 more");
  });

  test("formats picture time as 'Picture from HH:MM:SS'", () => {
    const d = new Date(2026, 10, 10, 14, 32, 5);
    expect(formatPictureTime(d, "en-GB")).toBe("Picture from 14:32:05");
  });
});

describe("frame-state reducer", () => {
  test("transitions loading -> unavailable on first failure if nothing was ever shown", () => {
    const initial = createFrameState("online");
    expect(initial.frame).toBe("loading");
    expect(getNextRefreshSeconds(initial, 5)).toBe(5);

    const failedOnce = reduceFrameState(initial, { type: "error" });
    expect(failedOnce.frame).toBe("unavailable");
    expect(failedOnce.consecutiveFailures).toBe(1);
    expect(failedOnce.hasShownPicture).toBe(false);
    expect(getNextRefreshSeconds(failedOnce, 5)).toBe(UNAVAILABLE_RETRY_SECONDS);
  });

  test("keeps showing last good picture until 3 failures in a row, then becomes unavailable", () => {
    let state = createFrameState("online");
    state = reduceFrameState(state, {
      type: "load",
      url: "/camera/qa/cam-1/frame.jpeg?t=100",
      timestamp: 100,
    });
    expect(state.frame).toBe("showing");
    expect(state.pictureUrl).toBe("/camera/qa/cam-1/frame.jpeg?t=100");
    expect(state.consecutiveFailures).toBe(0);

    // 1st failure after a good picture -> still showing last good picture
    state = reduceFrameState(state, { type: "error" });
    expect(state.frame).toBe("showing");
    expect(state.consecutiveFailures).toBe(1);
    expect(state.pictureUrl).toBe("/camera/qa/cam-1/frame.jpeg?t=100");

    // 2nd failure in a row -> still showing last good picture
    state = reduceFrameState(state, { type: "error" });
    expect(state.frame).toBe("showing");
    expect(state.consecutiveFailures).toBe(2);
    expect(state.pictureUrl).toBe("/camera/qa/cam-1/frame.jpeg?t=100");

    // 3rd failure in a row -> unavailable and slows down retry to 30s
    state = reduceFrameState(state, { type: "error" });
    expect(state.frame).toBe("unavailable");
    expect(state.consecutiveFailures).toBe(3);
    expect(state.pictureUrl).toBeNull();
    expect(getNextRefreshSeconds(state, 5)).toBe(30);
  });

  test("resets failure count on a subsequent success", () => {
    let state = createFrameState("online");
    state = reduceFrameState(state, { type: "load", url: "frame-1.jpg", timestamp: 1 });
    state = reduceFrameState(state, { type: "error" });
    state = reduceFrameState(state, { type: "error" });
    expect(state.consecutiveFailures).toBe(2);

    // Success before 3rd failure resets count
    state = reduceFrameState(state, { type: "load", url: "frame-2.jpg", timestamp: 2 });
    expect(state.frame).toBe("showing");
    expect(state.consecutiveFailures).toBe(0);
    expect(state.pictureUrl).toBe("frame-2.jpg");

    // Next 2 failures do not trigger unavailable because count was reset
    state = reduceFrameState(state, { type: "error" });
    state = reduceFrameState(state, { type: "error" });
    expect(state.frame).toBe("showing");
    expect(state.consecutiveFailures).toBe(2);
  });

  test("offline camera starts as unavailable", () => {
    const offlineState = createFrameState({ status: "offline" });
    expect(offlineState.frame).toBe("unavailable");
  });
});
