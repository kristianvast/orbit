// Pure calendar logic and event-type registry for Orbit farm-views.
import { DAY_MS, reproFacts, reproSettings } from "./repro.js";

/** Priority order: earlier in this array means higher priority for a day's single mark and sorting within a day. */
export const EVENT_PRIORITY = [
  "expected-calving",
  "alert",
  "dry-off-due",
  "pregnancy-check-due",
  "calving",
  "treatment",
  "insemination",
  "pregnancy-check",
  "dry-off",
];

const PRIORITY_INDEX = new Map(EVENT_PRIORITY.map((id, idx) => [id, idx]));

/** Format a Date or ISO timestamp into local YYYY-MM-DD in the current time zone. */
export function toLocalDay(input) {
  const d = input instanceof Date ? input : new Date(input);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Parse a local YYYY-MM-DD string into a Date at local noon (avoids DST boundary shifts). */
export function parseLocalDay(dayStr) {
  const [y, m, d] = dayStr.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

/** Whole calendar days from fromDay (YYYY-MM-DD) to toDay (YYYY-MM-DD). Negative when toDay is before fromDay. */
export function diffCalendarDays(toDay, fromDay) {
  const [y1, m1, d1] = toDay.split("-").map(Number);
  const [y2, m2, d2] = fromDay.split("-").map(Number);
  return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / DAY_MS);
}

/** Add whole calendar days to a YYYY-MM-DD string. */
export function addCalendarDays(dayStr, deltaDays) {
  const dt = parseLocalDay(dayStr);
  dt.setDate(dt.getDate() + deltaDays);
  return toLocalDay(dt);
}

/** Relative day label for upcoming / overdue planned events. */
export function formatRelativeDay(dayStr, todayStr) {
  const diff = diffCalendarDays(dayStr, todayStr);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff > 1) return `In ${diff} days`;
  if (diff === -1) return "1 day overdue";
  return `${Math.abs(diff)} days overdue`;
}

function isHorse(animal) {
  return animal?.species === "horse";
}

function inseminationDetail(obs) {
  const t = obs?.valueJson?.inseminationType;
  if (t === "NaturalService" || t === "RunWithBull") return "Natural service";
  return "";
}

function pregnancyCheckDetail(obs, animal) {
  const res = obs?.valueJson?.result;
  const horse = isHorse(animal);
  if (res === "Pregnant" || res === "Multiple") {
    return horse ? "In foal" : "In calf";
  }
  if (res === "Empty") {
    return horse ? "Not in foal" : "Not in calf";
  }
  return "";
}

function treatmentDetail(obs) {
  const v = obs?.valueJson;
  if (!v) return "";
  if (typeof v.procedure === "string" && v.procedure.trim()) {
    if (typeof v.message === "string" && v.message.trim()) {
      return `${v.procedure.trim()}: ${v.message.trim()}`;
    }
    return v.procedure.trim();
  }
  if (typeof v.message === "string" && v.message.trim()) return v.message.trim();
  return "";
}

function alertTitle(obs) {
  if (obs.kind === "health_event") return "Health alert";
  if (obs.kind === "calving_alert") return "Calving alert";
  if (obs.kind === "heat_alert") return "Heat alert";
  return "Alert";
}

function alertTone(obs) {
  if (obs.kind === "health_event" || obs.kind === "calving_alert") return "danger";
  return "warn";
}

function makePlannedEvent({ id, type, ts, animal, title, detail = "", baseTone, todayDay }) {
  const day = toLocalDay(ts);
  const overdue = day < todayDay;
  return {
    id,
    type,
    planned: true,
    overdue,
    ts,
    day,
    animalId: animal.id,
    animalName: animal.name ?? "",
    earTag: animal.earTagNumber ?? animal.nationalId ?? "",
    species: animal.species ?? "cattle",
    title,
    detail: overdue ? (detail ? `Overdue · ${detail}` : "Overdue") : detail,
    tone: overdue ? "danger" : baseTone,
  };
}

function makeRecordedEvent({ id, type, obs, animal, title, detail = "", tone = "neutral" }) {
  const ts = obs.ts;
  const day = toLocalDay(ts);
  return {
    id,
    type,
    planned: false,
    overdue: false,
    ts,
    day,
    animalId: animal?.id ?? obs.animalId ?? null,
    animalName: animal?.name ?? "",
    earTag: animal?.earTagNumber ?? animal?.nationalId ?? "",
    species: animal?.species ?? "cattle",
    title,
    detail,
    tone,
  };
}

/**
 * Registry of all supported calendar event types.
 * config.json lists ids under "show"; unknown ids are ignored.
 */
export const EVENT_TYPES = {
  "expected-calving": {
    id: "expected-calving",
    label: "Calving due",
    planned: true,
    derivePlanned(animal, facts, todayDay) {
      if (!facts.expectedCalving) return null;
      return makePlannedEvent({
        id: `expected-calving:${animal.id}`,
        type: "expected-calving",
        ts: facts.expectedCalving,
        animal,
        title: isHorse(animal) ? "Foaling due" : "Calving due",
        baseTone: "warn",
        todayDay,
      });
    },
  },
  "dry-off-due": {
    id: "dry-off-due",
    label: "Dry-off due",
    planned: true,
    derivePlanned(animal, facts, todayDay) {
      if (!facts.dryOffDue) return null;
      return makePlannedEvent({
        id: `dry-off-due:${animal.id}`,
        type: "dry-off-due",
        ts: facts.dryOffDue,
        animal,
        title: "Dry-off due",
        baseTone: "info",
        todayDay,
      });
    },
  },
  "pregnancy-check-due": {
    id: "pregnancy-check-due",
    label: "Pregnancy check due",
    planned: true,
    derivePlanned(animal, facts, todayDay) {
      if (!facts.pregnancyCheckDue) return null;
      return makePlannedEvent({
        id: `pregnancy-check-due:${animal.id}`,
        type: "pregnancy-check-due",
        ts: facts.pregnancyCheckDue,
        animal,
        title: "Pregnancy check due",
        baseTone: "info",
        todayDay,
      });
    },
  },
  calving: {
    id: "calving",
    label: "Calvings",
    planned: false,
    observationKinds: ["calving"],
    fromObservation(obs, animal) {
      return makeRecordedEvent({
        id: `calving:${obs.id}`,
        type: "calving",
        obs,
        animal,
        title: isHorse(animal) ? "Foaled" : "Calved",
      });
    },
  },
  insemination: {
    id: "insemination",
    label: "Inseminations",
    planned: false,
    observationKinds: ["insemination"],
    fromObservation(obs, animal) {
      return makeRecordedEvent({
        id: `insemination:${obs.id}`,
        type: "insemination",
        obs,
        animal,
        title: "Inseminated",
        detail: inseminationDetail(obs),
      });
    },
  },
  "pregnancy-check": {
    id: "pregnancy-check",
    label: "Pregnancy checks",
    planned: false,
    observationKinds: ["pregnancy_check"],
    fromObservation(obs, animal) {
      return makeRecordedEvent({
        id: `pregnancy-check:${obs.id}`,
        type: "pregnancy-check",
        obs,
        animal,
        title: "Pregnancy check",
        detail: pregnancyCheckDetail(obs, animal),
      });
    },
  },
  "dry-off": {
    id: "dry-off",
    label: "Dry-offs",
    planned: false,
    observationKinds: ["dry_off"],
    fromObservation(obs, animal) {
      return makeRecordedEvent({
        id: `dry-off:${obs.id}`,
        type: "dry-off",
        obs,
        animal,
        title: "Dried off",
      });
    },
  },
  treatment: {
    id: "treatment",
    label: "Treatments",
    planned: false,
    observationKinds: ["treatment"],
    fromObservation(obs, animal) {
      return makeRecordedEvent({
        id: `treatment:${obs.id}`,
        type: "treatment",
        obs,
        animal,
        title: "Treatment",
        detail: treatmentDetail(obs),
      });
    },
  },
  alert: {
    id: "alert",
    label: "Alerts",
    planned: false,
    observationKinds: ["health_event", "calving_alert", "heat_alert"],
    fromObservation(obs, animal) {
      return makeRecordedEvent({
        id: `alert:${obs.id}`,
        type: "alert",
        obs,
        animal,
        title: alertTitle(obs),
        detail: typeof obs.valueJson?.message === "string" ? obs.valueJson.message : "",
        tone: alertTone(obs),
      });
    },
  },
};

export const DEFAULT_SHOW = [
  "expected-calving",
  "dry-off-due",
  "pregnancy-check-due",
  "calving",
  "insemination",
  "pregnancy-check",
  "dry-off",
  "treatment",
  "alert",
];

export const DEFAULT_CONFIG = {
  weekStart: 1,
  show: DEFAULT_SHOW,
  card: { upcomingDays: 14 },
  upcomingDays: 60,
  repro: {},
};

/** Resolve raw config.json, filling defaults and dropping unknown event type ids while preserving config order. */
export function resolveConfig(raw = {}) {
  const input = raw && typeof raw === "object" ? raw : {};
  const weekStart =
    Number.isInteger(input.weekStart) && input.weekStart >= 0 && input.weekStart <= 6
      ? input.weekStart
      : DEFAULT_CONFIG.weekStart;

  const rawShow = Array.isArray(input.show) ? input.show : DEFAULT_CONFIG.show;
  const seen = new Set();
  const show = [];
  for (const id of rawShow) {
    if (typeof id === "string" && Object.hasOwn(EVENT_TYPES, id) && !seen.has(id)) {
      seen.add(id);
      show.push(id);
    }
  }

  const upcomingDays =
    typeof input.upcomingDays === "number" && input.upcomingDays >= 0
      ? Math.floor(input.upcomingDays)
      : DEFAULT_CONFIG.upcomingDays;

  const cardUpcomingDays =
    typeof input.card?.upcomingDays === "number" && input.card.upcomingDays >= 0
      ? Math.floor(input.card.upcomingDays)
      : DEFAULT_CONFIG.card.upcomingDays;

  const repro = reproSettings(input.repro && typeof input.repro === "object" ? input.repro : {});

  return {
    weekStart,
    show,
    card: { upcomingDays: cardUpcomingDays },
    upcomingDays,
    repro,
  };
}

/** Compare two calendar events by priority, then species (cattle first when tied on day/type), then animal name. */
const TONE_ORDER = { danger: 0, warn: 1, info: 2, ok: 3, neutral: 4 };

export function compareEvents(a, b) {
  const pa = PRIORITY_INDEX.get(a.type) ?? 999;
  const pb = PRIORITY_INDEX.get(b.type) ?? 999;
  if (pa !== pb) return pa - pb;
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  const ta = TONE_ORDER[a.tone] ?? 9;
  const tb = TONE_ORDER[b.tone] ?? 9;
  if (ta !== tb) return ta - tb;
  if (a.species !== b.species) return a.species === "cattle" ? -1 : 1;
  const nameCmp = (a.animalName || "").localeCompare(b.animalName || "");
  if (nameCmp !== 0) return nameCmp;
  return (a.id || "").localeCompare(b.id || "");
}

/**
 * Build all calendar events enabled by config.show from animals and observations.
 * @param animals list of animal rows from animals.list
 * @param observations list of observation rows
 * @param rawConfig config object (or raw config.json)
 * @param now Date or timestamp (ms)
 */
export function buildEvents(animals = [], observations = [], rawConfig = {}, now = new Date()) {
  const config = resolveConfig(rawConfig);
  const showSet = new Set(config.show);
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const todayDay = toLocalDay(nowDate);

  const activeAnimals = animals.filter((a) => !a.status || a.status === "active");
  const animalById = new Map(animals.map((a) => [a.id, a]));

  const obsByAnimal = new Map();
  for (const obs of observations) {
    if (!obs?.animalId) continue;
    let list = obsByAnimal.get(obs.animalId);
    if (!list) {
      list = [];
      obsByAnimal.set(obs.animalId, list);
    }
    list.push(obs);
  }

  const events = [];

  // 1. Derived planned events per active animal
  const plannedTypes = ["expected-calving", "dry-off-due", "pregnancy-check-due"].filter((t) =>
    showSet.has(t),
  );
  if (plannedTypes.length > 0) {
    for (const animal of activeAnimals) {
      const animalObs = obsByAnimal.get(animal.id) ?? [];
      const facts = reproFacts(animal, animalObs, config.repro, nowMs);
      for (const typeId of plannedTypes) {
        const def = EVENT_TYPES[typeId];
        const ev = def.derivePlanned(animal, facts, todayDay);
        if (ev) events.push(ev);
      }
    }
  }

  // 2. Recorded events from observations
  const kindToType = new Map();
  for (const typeId of config.show) {
    const def = EVENT_TYPES[typeId];
    if (!def || def.planned || !def.observationKinds) continue;
    for (const k of def.observationKinds) {
      kindToType.set(k, def);
    }
  }

  if (kindToType.size > 0) {
    for (const obs of observations) {
      if (!obs?.ts) continue;
      const def = kindToType.get(obs.kind);
      if (!def) continue;
      const animal = obs.animalId ? animalById.get(obs.animalId) : null;
      if (obs.animalId && !animal) continue;
      const ev = def.fromObservation(obs, animal);
      if (ev) events.push(ev);
    }
  }

  events.sort((a, b) => a.day.localeCompare(b.day) || compareEvents(a, b));
  return events;
}

/** Return events for a given local day (YYYY-MM-DD or Date), ordered by priority. */
export function eventsForDay(events, dayInput, activeTypes = null) {
  const day = typeof dayInput === "string" ? dayInput : toLocalDay(dayInput);
  const typeSet = activeTypes ? new Set(activeTypes) : null;
  return events
    .filter((e) => e.day === day && (!typeSet || typeSet.has(e.type)))
    .slice()
    .sort(compareEvents);
}

/** Return the highest-priority event on a list of day events, or null. */
export function topEventForDay(dayEvents) {
  if (!dayEvents || dayEvents.length === 0) return null;
  const sorted = dayEvents.slice().sort(compareEvents);
  return sorted[0] ?? null;
}

/**
 * Build a month grid (weeks x 7 day cells) honouring weekStart (0=Sun..6=Sat).
 * @param year full year (e.g. 2026)
 * @param monthIndex 0-based month (0=Jan..11=Dec)
 * @param events all built events
 * @param rawConfig config or resolved config
 * @param now Date or ms for isToday
 * @param activeTypes optional Set/Array of enabled type ids
 */
export function buildMonthGrid(
  year,
  monthIndex,
  events = [],
  rawConfig = {},
  now = new Date(),
  activeTypes = null,
) {
  const config = resolveConfig(rawConfig);
  const todayDay = toLocalDay(now instanceof Date ? now : new Date(now));
  const typeSet = activeTypes ? new Set(activeTypes) : null;

  const byDay = new Map();
  for (const ev of events) {
    if (typeSet && !typeSet.has(ev.type)) continue;
    let list = byDay.get(ev.day);
    if (!list) {
      list = [];
      byDay.set(ev.day, list);
    }
    list.push(ev);
  }
  for (const list of byDay.values()) {
    list.sort(compareEvents);
  }

  const firstOfMonth = new Date(year, monthIndex, 1, 12, 0, 0, 0);
  const lastOfMonth = new Date(year, monthIndex + 1, 0, 12, 0, 0, 0);

  const startOffset = (firstOfMonth.getDay() - config.weekStart + 7) % 7;
  const endOffset = (6 - ((lastOfMonth.getDay() - config.weekStart + 7) % 7) + 7) % 7;

  const startDate = new Date(year, monthIndex, 1 - startOffset, 12, 0, 0, 0);
  const totalDays = lastOfMonth.getDate() + startOffset + endOffset;
  const weekCount = Math.round(totalDays / 7);

  const weeks = [];
  const cursor = new Date(startDate);
  for (let w = 0; w < weekCount; w++) {
    const week = [];
    for (let d = 0; d < 7; d++) {
      const dayStr = toLocalDay(cursor);
      const dayEvents = byDay.get(dayStr) ?? [];
      week.push({
        day: dayStr,
        dayNumber: cursor.getDate(),
        inMonth: cursor.getMonth() === monthIndex && cursor.getFullYear() === year,
        isToday: dayStr === todayDay,
        events: dayEvents,
        topEvent: dayEvents[0] ?? null,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }

  return weeks;
}

/**
 * Build the 7-day week strip for the Home card, honouring weekStart.
 */
export function buildWeekStrip(events = [], rawConfig = {}, now = new Date()) {
  const config = resolveConfig(rawConfig);
  const nowDate = now instanceof Date ? now : new Date(now);
  const todayDay = toLocalDay(nowDate);
  const noonToday = parseLocalDay(todayDay);
  const offset = (noonToday.getDay() - config.weekStart + 7) % 7;
  const weekStartDate = new Date(
    noonToday.getFullYear(),
    noonToday.getMonth(),
    noonToday.getDate() - offset,
    12,
    0,
    0,
    0,
  );

  const byDay = new Map();
  for (const ev of events) {
    let list = byDay.get(ev.day);
    if (!list) {
      list = [];
      byDay.set(ev.day, list);
    }
    list.push(ev);
  }
  for (const list of byDay.values()) {
    list.sort(compareEvents);
  }

  const days = [];
  const cursor = new Date(weekStartDate);
  for (let i = 0; i < 7; i++) {
    const dayStr = toLocalDay(cursor);
    const dayEvents = byDay.get(dayStr) ?? [];
    days.push({
      day: dayStr,
      dayNumber: cursor.getDate(),
      isToday: dayStr === todayDay,
      events: dayEvents,
      topEvent: dayEvents[0] ?? null,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

/**
 * Upcoming planned events: overdue ones first (ordered by day asc, then priority),
 * followed by planned events from today through today + windowDays.
 */
export function buildUpcomingList(
  events = [],
  rawConfig = {},
  now = new Date(),
  windowDaysOverride = null,
  activeTypes = null,
) {
  const config = resolveConfig(rawConfig);
  const windowDays =
    typeof windowDaysOverride === "number" ? windowDaysOverride : config.upcomingDays;
  const todayDay = toLocalDay(now instanceof Date ? now : new Date(now));
  const limitDay = addCalendarDays(todayDay, windowDays);
  const typeSet = activeTypes ? new Set(activeTypes) : null;

  const upcoming = events.filter(
    (e) =>
      e.planned &&
      (!typeSet || typeSet.has(e.type)) &&
      (e.day < todayDay || (e.day >= todayDay && e.day <= limitDay)),
  );

  upcoming.sort((a, b) => a.day.localeCompare(b.day) || compareEvents(a, b));
  return upcoming.map((e) => ({
    ...e,
    daysFromToday: diffCalendarDays(e.day, todayDay),
    relativeLabel: formatRelativeDay(e.day, todayDay),
  }));
}

/**
 * Pick the next upcoming non-overdue planned event within card.upcomingDays (or upcomingDays),
 * plus the count of overdue planned events.
 */
export function getNextEventSummary(events = [], rawConfig = {}, now = new Date()) {
  const config = resolveConfig(rawConfig);
  const todayDay = toLocalDay(now instanceof Date ? now : new Date(now));
  const cardLimitDay = addCalendarDays(todayDay, config.card.upcomingDays);

  const planned = events
    .filter((e) => e.planned)
    .slice()
    .sort((a, b) => a.day.localeCompare(b.day) || compareEvents(a, b));

  const overdue = planned.filter((e) => e.day < todayDay);
  const withinCardWindow = planned.filter((e) => e.day >= todayDay && e.day <= cardLimitDay);
  const futureAll = planned.filter((e) => e.day >= todayDay);

  const next = withinCardWindow[0] ?? futureAll[0] ?? overdue[0] ?? null;
  return {
    next: next
      ? {
          ...next,
          daysFromToday: diffCalendarDays(next.day, todayDay),
          relativeLabel: formatRelativeDay(next.day, todayDay),
        }
      : null,
    overdueCount: overdue.length,
    overdue,
  };
}
