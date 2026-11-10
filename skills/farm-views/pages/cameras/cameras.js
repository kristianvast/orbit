// Pure logic for the cameras farm view (no DOM, no network calls).

export const NO_LOCATION_LABEL = "No location";
export const MIN_REFRESH_SECONDS = 1;
export const MAX_REFRESH_SECONDS = 120;
export const UNAVAILABLE_RETRY_SECONDS = 30;
export const MAX_CONSECUTIVE_FAILURES = 3;

export const DEFAULT_CONFIG = Object.freeze({
  card: Object.freeze({ camera: null, refreshSeconds: 15 }),
  panel: Object.freeze({ refreshSeconds: 5, zoomRefreshSeconds: 2 }),
  locations: Object.freeze([]),
  order: "location",
  hide: Object.freeze([]),
});

/**
 * Registry of tested camera status mappings.
 */
export const STATUS_REGISTRY = Object.freeze({
  online: Object.freeze({
    id: "online",
    label: "Online",
    tone: "ok",
    badgeClass: "orbit-badge--ok",
    dotTone: "ok",
    requestsFrames: true,
  }),
  offline: Object.freeze({
    id: "offline",
    label: "Offline",
    tone: "neutral",
    badgeClass: "orbit-badge--neutral",
    dotTone: "neutral",
    requestsFrames: false,
  }),
  error: Object.freeze({
    id: "error",
    label: "Not responding",
    tone: "danger",
    badgeClass: "orbit-badge--danger",
    dotTone: "danger",
    requestsFrames: true,
  }),
  unknown: Object.freeze({
    id: "unknown",
    label: "Not checked yet",
    tone: "neutral",
    badgeClass: "orbit-badge--neutral",
    dotTone: "neutral",
    requestsFrames: true,
  }),
});

export function getCameraLocation(camera) {
  const raw = typeof camera?.location === "string" ? camera.location.trim() : "";
  return raw.length > 0 ? raw : NO_LOCATION_LABEL;
}

export function locationSlug(location) {
  const raw = typeof location === "string" ? location.trim() : "";
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "none";
}

function compareText(a, b) {
  return String(a ?? "").localeCompare(String(b ?? ""), "en", { sensitivity: "base" });
}

function compareByLocation(a, b) {
  const locA = getCameraLocation(a);
  const locB = getCameraLocation(b);
  const aNoLoc = locA === NO_LOCATION_LABEL;
  const bNoLoc = locB === NO_LOCATION_LABEL;
  if (aNoLoc !== bNoLoc) return aNoLoc ? 1 : -1;
  const byLoc = compareText(locA, locB);
  if (byLoc !== 0) return byLoc;
  const byName = compareText(a?.name, b?.name);
  if (byName !== 0) return byName;
  return compareText(a?.id, b?.id);
}

function compareByName(a, b) {
  const byName = compareText(a?.name, b?.name);
  if (byName !== 0) return byName;
  const byLoc = compareText(getCameraLocation(a), getCameraLocation(b));
  if (byLoc !== 0) return byLoc;
  return compareText(a?.id, b?.id);
}

function statusSortRank(status) {
  if (status === "online") return 0;
  if (status === "error") return 1;
  if (status === "unknown") return 2;
  return 3;
}

function compareByOnlineFirst(a, b) {
  const rankDiff = statusSortRank(a?.status) - statusSortRank(b?.status);
  if (rankDiff !== 0) return rankDiff;
  return compareByLocation(a, b);
}

/**
 * Registry of tested camera ordering options.
 */
export const ORDER_REGISTRY = Object.freeze({
  location: Object.freeze({
    id: "location",
    label: "By location, then camera name",
    compare: compareByLocation,
  }),
  name: Object.freeze({
    id: "name",
    label: "By camera name",
    compare: compareByName,
  }),
  "online-first": Object.freeze({
    id: "online-first",
    label: "Online cameras first",
    compare: compareByOnlineFirst,
  }),
});

export function clampRefreshSeconds(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  return Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, rounded));
}

function normalizeStringList(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const item of input) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Resolves raw config.json input: applies defaults, clamps refresh intervals to 1..120s,
 * validates ordering against ORDER_REGISTRY, and ignores unknown keys.
 */
export function resolveConfig(raw) {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const rawCard =
    obj.card && typeof obj.card === "object" && !Array.isArray(obj.card) ? obj.card : {};
  const rawPanel =
    obj.panel && typeof obj.panel === "object" && !Array.isArray(obj.panel) ? obj.panel : {};

  const cameraRef =
    typeof rawCard.camera === "string" && rawCard.camera.trim().length > 0
      ? rawCard.camera.trim()
      : null;

  const order =
    typeof obj.order === "string" && Object.hasOwn(ORDER_REGISTRY, obj.order)
      ? obj.order
      : DEFAULT_CONFIG.order;

  return {
    card: {
      camera: cameraRef,
      refreshSeconds: clampRefreshSeconds(
        rawCard.refreshSeconds,
        DEFAULT_CONFIG.card.refreshSeconds,
      ),
    },
    panel: {
      refreshSeconds: clampRefreshSeconds(
        rawPanel.refreshSeconds,
        DEFAULT_CONFIG.panel.refreshSeconds,
      ),
      zoomRefreshSeconds: clampRefreshSeconds(
        rawPanel.zoomRefreshSeconds,
        DEFAULT_CONFIG.panel.zoomRefreshSeconds,
      ),
    },
    locations: normalizeStringList(obj.locations),
    order,
    hide: normalizeStringList(obj.hide),
  };
}

/**
 * Returns cameras not excluded by config.hide (matches camera id or name).
 */
export function visibleCameras(cameras, config) {
  if (!Array.isArray(cameras)) return [];
  const hideList = Array.isArray(config)
    ? normalizeStringList(config)
    : normalizeStringList(config?.hide);
  if (hideList.length === 0) return [...cameras];
  const hidden = new Set(hideList);
  return cameras.filter((cam) => {
    if (!cam || typeof cam !== "object") return false;
    const id = typeof cam.id === "string" ? cam.id.trim() : "";
    const name = typeof cam.name === "string" ? cam.name.trim() : "";
    return !hidden.has(id) && !hidden.has(name);
  });
}

/**
 * Sorts a list of cameras according to the configured order ("location" | "name" | "online-first").
 */
export function sortCameras(cameras, order = DEFAULT_CONFIG.order) {
  if (!Array.isArray(cameras)) return [];
  const resolvedOrder = typeof order === "object" && order !== null ? order.order : order;
  const entry = Object.hasOwn(ORDER_REGISTRY, resolvedOrder)
    ? ORDER_REGISTRY[resolvedOrder]
    : ORDER_REGISTRY[DEFAULT_CONFIG.order];
  return [...cameras].sort(entry.compare);
}

/**
 * Returns visible cameras sorted according to config.order.
 */
export function selectPanelCameras(cameras, config) {
  const resolved = resolveConfig(config);
  return sortCameras(visibleCameras(cameras, resolved), resolved.order);
}

/**
 * Builds the location filter chips with counts.
 * An "All" chip always comes first.
 * When config.locations is empty, every location present on the farm gets a chip (alphabetical, "No location" last).
 * When config.locations is non-empty, only configured locations present on the farm get chips, in that order.
 */
export function buildLocationChips(cameras, config) {
  const list = Array.isArray(cameras) ? cameras : [];
  const countsByLocation = new Map();
  for (const cam of list) {
    const loc = getCameraLocation(cam);
    countsByLocation.set(loc, (countsByLocation.get(loc) ?? 0) + 1);
  }

  const configuredLocations = Array.isArray(config)
    ? normalizeStringList(config)
    : normalizeStringList(config?.locations);

  let orderedLocations;
  if (configuredLocations.length > 0) {
    orderedLocations = configuredLocations.filter((loc) => countsByLocation.has(loc));
  } else {
    orderedLocations = [...countsByLocation.keys()].sort((a, b) => {
      const aNoLoc = a === NO_LOCATION_LABEL;
      const bNoLoc = b === NO_LOCATION_LABEL;
      if (aNoLoc !== bNoLoc) return aNoLoc ? 1 : -1;
      return compareText(a, b);
    });
  }

  const chips = [
    {
      id: "all",
      label: "All",
      slug: "all",
      count: list.length,
      testId: "cameras-filter-all",
    },
  ];

  for (const loc of orderedLocations) {
    const slug = locationSlug(loc);
    chips.push({
      id: loc,
      label: loc,
      slug,
      count: countsByLocation.get(loc) ?? 0,
      testId: `cameras-filter-${slug}`,
    });
  }

  return chips;
}

/**
 * Filters cameras by location chip id ("all" or null returns all cameras).
 */
export function filterByLocation(cameras, location) {
  if (!Array.isArray(cameras)) return [];
  if (!location || location === "all") return [...cameras];
  return cameras.filter((cam) => getCameraLocation(cam) === location);
}

/**
 * Picks the camera for the Home card:
 * 1. Configured card.camera (matched by id or name among visible cameras)
 * 2. First online camera in panel order
 * 3. First visible camera in panel order
 */
export function pickCardCamera(cameras, config) {
  const resolved = resolveConfig(config);
  const ordered = selectPanelCameras(cameras, resolved);
  if (ordered.length === 0) return null;

  const target = resolved.card.camera;
  if (target) {
    const match = ordered.find(
      (cam) =>
        (typeof cam.id === "string" && cam.id.trim() === target) ||
        (typeof cam.name === "string" && cam.name.trim() === target),
    );
    if (match) return match;
  }

  const firstOnline = ordered.find((cam) => cam.status === "online");
  return firstOnline ?? ordered[0] ?? null;
}

/**
 * Returns status wording and tone for a camera status.
 */
export function getCameraStatus(status) {
  if (typeof status === "string" && Object.hasOwn(STATUS_REGISTRY, status)) {
    return STATUS_REGISTRY[status];
  }
  return STATUS_REGISTRY.unknown;
}

/**
 * Whether a camera should request picture frames (all except "offline").
 */
export function shouldRequestFrame(camera) {
  return camera?.status !== "offline";
}

/**
 * Formats the summary line, e.g. "2 of 3 online".
 */
export function formatSummary(cameras) {
  const list = Array.isArray(cameras) ? cameras : [];
  const total = list.length;
  const online = list.filter((cam) => cam?.status === "online").length;
  return `${online} of ${total} online`;
}

/**
 * Builds the fallback camera list for the Home card (max 4 items, then "+N more").
 */
export function buildCardFallbackList(cameras, maxVisible = 4) {
  const list = Array.isArray(cameras) ? cameras : [];
  const limit = Math.max(1, Math.floor(maxVisible));
  const items = list.slice(0, limit).map((cam) => {
    const statusInfo = getCameraStatus(cam?.status);
    return {
      id: cam?.id ?? "",
      name: cam?.name ?? "Camera",
      status: statusInfo.id,
      statusLabel: statusInfo.label,
      dotTone: statusInfo.dotTone,
    };
  });
  const extraCount = Math.max(0, list.length - items.length);
  return {
    items,
    extraCount,
    moreLabel: extraCount > 0 ? `+${extraCount} more` : null,
  };
}

/**
 * Formats the timestamp of the last loaded picture: "Picture from 14:32:05".
 */
export function formatPictureTime(timestamp, lang = "en") {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  let timeText;
  try {
    timeText = new Intl.DateTimeFormat(lang || "en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    const pad = (n) => String(n).padStart(2, "0");
    timeText = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
  return `Picture from ${timeText}`;
}

/**
 * Initial frame state for a single camera tile.
 * Offline cameras never request frames and start as "unavailable".
 */
export function createFrameState(cameraOrStatus) {
  const status =
    typeof cameraOrStatus === "string" ? cameraOrStatus : (cameraOrStatus?.status ?? "unknown");
  const isOffline = status === "offline";
  return {
    frame: isOffline ? "unavailable" : "loading",
    consecutiveFailures: 0,
    hasShownPicture: false,
    pictureUrl: null,
    lastUpdatedAt: null,
  };
}

/**
 * Frame-state reducer for one camera tile:
 * - "loading" -> "showing" when a picture loads (keeps last good picture while next loads)
 * - "loading" -> "unavailable" on first failure when no picture was ever shown
 * - "showing" -> "unavailable" only when 3 refreshes in a row fail
 * - any success resets consecutiveFailures to 0 and transitions to "showing"
 */
export function reduceFrameState(state, action) {
  const current = state ?? createFrameState("unknown");
  const type = typeof action === "string" ? action : action?.type;

  if (type === "load" || type === "success") {
    return {
      frame: "showing",
      consecutiveFailures: 0,
      hasShownPicture: true,
      pictureUrl: action?.url ?? action?.pictureUrl ?? current.pictureUrl ?? null,
      lastUpdatedAt: action?.timestamp ?? action?.lastUpdatedAt ?? current.lastUpdatedAt ?? null,
    };
  }

  if (type === "error" || type === "fail" || type === "failure") {
    const consecutiveFailures = (current.consecutiveFailures ?? 0) + 1;
    const hasShownPicture = Boolean(current.hasShownPicture);
    const unavailable = !hasShownPicture || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
    return {
      frame: unavailable ? "unavailable" : "showing",
      consecutiveFailures,
      hasShownPicture,
      pictureUrl: unavailable ? null : current.pictureUrl,
      lastUpdatedAt: current.lastUpdatedAt ?? null,
    };
  }

  if (type === "reset") {
    return createFrameState(action?.status ?? "unknown");
  }

  return current;
}

/**
 * Returns the next refresh delay in seconds for a tile:
 * 30s when "unavailable", or the configured refreshSeconds otherwise.
 */
export function getNextRefreshSeconds(frameState, refreshSeconds) {
  if (frameState?.frame === "unavailable") {
    return UNAVAILABLE_RETRY_SECONDS;
  }
  return clampRefreshSeconds(refreshSeconds, DEFAULT_CONFIG.panel.refreshSeconds);
}
