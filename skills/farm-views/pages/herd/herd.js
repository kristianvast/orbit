// Pure logic and option registry for the herd view.
// No DOM or window.orbit calls here; index.html and card.html import this module.

import { DAY_MS, daysUntil, reproFacts, reproSettings } from "./repro.js";

export { DAY_MS, daysUntil, reproFacts, reproSettings };

export const ALERT_KINDS = ["health_event", "calving_alert", "heat_alert"];
export const URGENT_ALERT_KINDS = ["health_event", "calving_alert"];
export const REPRO_EVENT_KINDS = [
  "calving",
  "insemination",
  "pregnancy_check",
  "dry_off",
  "abortion",
];
export const RECORDED_EVENT_KINDS = [
  "insemination",
  "pregnancy_check",
  "calving",
  "abortion",
  "dry_off",
  "treatment",
  "arrival",
  "departure",
  "birth",
  "death",
];
export const READING_KINDS = ["activity", "rumination", "temperature", "weight"];

export const DEFAULT_CONFIG = {
  species: "all",
  card: { breakdown: "group" },
  filters: ["attention", "group"],
  sorts: ["attention", "name", "tag"],
  animalCard: {
    facts: ["group", "age"],
    badges: ["alert", "heat", "due-soon", "fresh", "dry"],
  },
  animalPanel: {
    facts: ["tag", "nationalId", "breed", "sex", "age", "group", "sensor"],
    sections: ["attention", "reproduction", "milk", "readings", "events", "notes"],
  },
  repro: {},
};

export function toSlug(value) {
  return (
    String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "none"
  );
}

export function formatNumber(value, lang = "en", maxFractionDigits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat(lang || "en", {
    maximumFractionDigits: maxFractionDigits,
  }).format(value);
}

export function formatDateShort(isoOrDate, lang = "en") {
  if (!isoOrDate) return null;
  const ms = typeof isoOrDate === "number" ? isoOrDate : Date.parse(isoOrDate);
  if (!Number.isFinite(ms)) return String(isoOrDate);
  return new Intl.DateTimeFormat(lang || "en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(ms));
}

export function formatRelativeTime(iso, now = Date.now(), lang = "en") {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const diffMs = now - ms;
  const absDays = Math.round(Math.abs(diffMs) / DAY_MS);
  if (diffMs < 0) {
    if (absDays === 0) return "today";
    if (absDays === 1) return "tomorrow";
    return `in ${formatNumber(absDays, lang, 0)} d`;
  }
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${formatNumber(mins, lang, 0)} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${formatNumber(hours, lang, 0)} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "1 day ago";
  return `${formatNumber(days, lang, 0)} days ago`;
}

/**
 * Age formatting:
 * under 60 days -> days; under 24 months -> months; otherwise years (floor);
 * unknown birth date -> null (omitted).
 */
export function formatAge(birthDate, now = Date.now(), lang = "en") {
  if (!birthDate) return null;
  const birthMs = Date.parse(birthDate);
  if (!Number.isFinite(birthMs)) return null;
  const diffDays = Math.floor((now - birthMs) / DAY_MS);
  if (diffDays < 0) return null;
  if (diffDays < 60) {
    return `${formatNumber(diffDays, lang, 0)} ${diffDays === 1 ? "day" : "days"}`;
  }
  const months = Math.floor(diffDays / 30.4375);
  if (months < 24) {
    return `${formatNumber(months, lang, 0)} ${months === 1 ? "month" : "months"}`;
  }
  const years = Math.floor(diffDays / 365.25);
  return `${formatNumber(years, lang, 0)} ${years === 1 ? "yr" : "yrs"}`;
}

export function formatWearable(wearable, lang = "en") {
  if (!wearable?.kind) return "No sensor";
  const kindLabels = {
    collar: "Collar",
    bolus: "Bolus",
    ear_tag_sensor: "Ear tag sensor",
  };
  const label = kindLabels[wearable.kind] ?? String(wearable.kind).replace(/_/g, " ");
  if (wearable.batteryPct !== null && wearable.batteryPct !== undefined) {
    return `${label}, battery ${formatNumber(wearable.batteryPct, lang, 0)}%`;
  }
  return label;
}

export function formatSpeciesLabel(species, plural = false) {
  if (species === "horse") return plural ? "Horses" : "Horse";
  if (species === "cattle") return plural ? "Cattle" : "Cattle";
  return species ? String(species) : "Unknown";
}

export function formatSexLabel(sex) {
  const labels = {
    female: "Female",
    male: "Male",
    castrated: "Castrated",
    unknown: "Unknown",
  };
  return labels[sex] ?? null;
}

export function formatLactationLabel(status) {
  const labels = {
    fresh: "Fresh",
    early: "Early lactation",
    lactating: "In milk",
    lead: "Lead",
    dry: "Dry",
  };
  return labels[status] ?? null;
}

export function formatReproductionStatus(animal, repro = null) {
  if (repro?.pregnant) {
    return animal?.species === "horse" ? "In foal" : "In calf";
  }
  const status = animal?.reproductionStatus;
  const labels = {
    open: "Open",
    inseminated: "Inseminated",
    pregnant: animal?.species === "horse" ? "In foal" : "In calf",
    pregnant_multiple_foetus: animal?.species === "horse" ? "In foal (twins)" : "In calf (twins)",
    not_pregnant: "Not pregnant",
    birthed: animal?.species === "horse" ? "Foaled" : "Calved",
    do_not_breed: "Do not breed",
  };
  return labels[status] ?? null;
}

export function birthTerm(species) {
  return species === "horse"
    ? {
        noun: "foaling",
        expected: "Expected foaling",
        last: "Last foaling",
        alerts: "Foaling alert",
      }
    : {
        noun: "calving",
        expected: "Expected calving",
        last: "Last calving",
        alerts: "Calving alert",
      };
}

/**
 * Milk 7-day average = total kg over the last 7 days / number of days that have a milking.
 * Also returns last milking and 7 daily totals for the panel chart.
 */
export function computeMilkSummary(observations = [], now = Date.now()) {
  const windowStart = now - 7 * DAY_MS;
  const milkings = observations
    .filter(
      (o) =>
        o.kind === "milking" &&
        typeof o.valueNum === "number" &&
        Number.isFinite(o.valueNum) &&
        Date.parse(o.ts) >= windowStart &&
        Date.parse(o.ts) <= now,
    )
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));

  const allMilkings = observations
    .filter(
      (o) => o.kind === "milking" && typeof o.valueNum === "number" && Number.isFinite(o.valueNum),
    )
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));

  if (milkings.length === 0 && allMilkings.length === 0) {
    return {
      averageKg: null,
      lastMilking: null,
      dailyTotals: [],
    };
  }

  const byDay = new Map();
  let totalKg = 0;
  for (const m of milkings) {
    const dayIndex = Math.min(6, Math.max(0, Math.floor((now - Date.parse(m.ts)) / DAY_MS)));
    byDay.set(dayIndex, (byDay.get(dayIndex) ?? 0) + m.valueNum);
    totalKg += m.valueNum;
  }

  const daysWithMilking = byDay.size;
  const averageKg = daysWithMilking > 0 ? Math.round((totalKg / daysWithMilking) * 10) / 10 : null;

  const dailyTotals = [];
  for (let d = 6; d >= 0; d--) {
    const dayEndMs = now - d * DAY_MS;
    const dateIso = new Date(dayEndMs).toISOString().slice(0, 10);
    const kg = Math.round((byDay.get(d) ?? 0) * 10) / 10;
    dailyTotals.push({ dayAgo: d, date: dateIso, kg });
  }

  const latest = allMilkings[0] ?? null;
  return {
    averageKg,
    lastMilking: latest ? { ts: latest.ts, kg: latest.valueNum } : null,
    dailyTotals,
  };
}

export function alertsForAnimal(observations = [], now = Date.now()) {
  const since7d = now - 7 * DAY_MS;
  return observations
    .filter(
      (o) => ALERT_KINDS.includes(o.kind) && Date.parse(o.ts) >= since7d && Date.parse(o.ts) <= now,
    )
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}

export function hasRecentHeatAlert(observations = [], now = Date.now()) {
  const since48h = now - 48 * 3_600_000;
  return observations.some(
    (o) => o.kind === "heat_alert" && Date.parse(o.ts) >= since48h && Date.parse(o.ts) <= now,
  );
}

export function hasUrgentAlert(observations = [], now = Date.now()) {
  const since7d = now - 7 * DAY_MS;
  return observations.some(
    (o) =>
      URGENT_ALERT_KINDS.includes(o.kind) && Date.parse(o.ts) >= since7d && Date.parse(o.ts) <= now,
  );
}

/**
 * Enriches one animal with derived reproduction facts, alerts, and milk stats.
 */
export function deriveAnimalContext(
  animal,
  observations = [],
  settings = reproSettings(),
  now = Date.now(),
  milkAvgOverride = undefined,
) {
  const repro = reproFacts(animal, observations, settings, now);
  const alerts = alertsForAnimal(observations, now);
  const newestAlertTs = alerts.length > 0 ? Date.parse(alerts[0].ts) : null;
  const urgentAlert = hasUrgentAlert(observations, now);
  const heat48h = hasRecentHeatAlert(observations, now);
  const milk = computeMilkSummary(observations, now);
  const milkAverageKg = milkAvgOverride !== undefined ? milkAvgOverride : milk.averageKg;

  return {
    animal,
    observations,
    repro,
    alerts,
    newestAlertTs,
    hasAttention: alerts.length > 0,
    urgentAlert,
    heat48h,
    milkAverageKg,
    milkSummary: milk,
  };
}

// ------------------------------------------------------------------ REGISTRY

export const SPECIES_OPTIONS = {
  all: {
    id: "all",
    label: "All species",
    match: () => true,
  },
  cattle: {
    id: "cattle",
    label: "Cattle",
    match: (animal) => animal.species === "cattle",
  },
  horse: {
    id: "horse",
    label: "Horses",
    match: (animal) => animal.species === "horse",
  },
};

export const BREAKDOWN_OPTIONS = {
  group: {
    id: "group",
    label: "By group",
    keyOf: (animal) => animal.groupName || "Ungrouped",
  },
  species: {
    id: "species",
    label: "By species",
    keyOf: (animal) => formatSpeciesLabel(animal.species, true),
  },
  lactation: {
    id: "lactation",
    label: "By lactation",
    keyOf: (animal) => formatLactationLabel(animal.lactationStatus) || "Other",
  },
};

export const FILTER_OPTIONS = {
  attention: {
    id: "attention",
    label: "Needs attention",
    needsReproEvents: false,
    match: (ctx) => ctx.hasAttention,
  },
  group: {
    id: "group",
    label: "Group",
    expands: true,
    needsReproEvents: false,
    expand(contexts) {
      const counts = new Map();
      for (const ctx of contexts) {
        const g = ctx.animal.groupName;
        if (!g) continue;
        counts.set(g, (counts.get(g) ?? 0) + 1);
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([groupName]) => ({
          id: `group:${groupName}`,
          testId: `herd-filter-group-${toSlug(groupName)}`,
          label: groupName,
          match: (ctx) => ctx.animal.groupName === groupName,
        }));
    },
  },
  species: {
    id: "species",
    label: "Species",
    expands: true,
    needsReproEvents: false,
    expand(contexts) {
      const present = new Set(contexts.map((c) => c.animal.species).filter(Boolean));
      if (present.size <= 1) return [];
      const order = ["cattle", "horse"].filter((s) => present.has(s));
      for (const s of present) {
        if (!order.includes(s)) order.push(s);
      }
      return order.map((sp) => ({
        id: `species:${sp}`,
        testId: `herd-filter-species-${toSlug(sp)}`,
        label: formatSpeciesLabel(sp, true),
        match: (ctx) => ctx.animal.species === sp,
      }));
    },
  },
  fresh: {
    id: "fresh",
    label: "Fresh",
    needsReproEvents: true,
    match: (ctx) => Boolean(ctx.repro.fresh),
  },
  dry: {
    id: "dry",
    label: "Dry",
    needsReproEvents: false,
    match: (ctx) => Boolean(ctx.repro.dry),
  },
  "in-calf": {
    id: "in-calf",
    label: "In calf",
    needsReproEvents: true,
    match: (ctx) => Boolean(ctx.repro.pregnant),
  },
  inseminated: {
    id: "inseminated",
    label: "Inseminated",
    needsReproEvents: false,
    match: (ctx) => ctx.animal.reproductionStatus === "inseminated",
  },
  open: {
    id: "open",
    label: "Open",
    needsReproEvents: false,
    match: (ctx) =>
      ctx.animal.sex === "female" &&
      (ctx.animal.reproductionStatus === "open" ||
        ctx.animal.reproductionStatus === "not_pregnant"),
  },
  "due-soon": {
    id: "due-soon",
    label: "Due soon",
    needsReproEvents: true,
    match: (ctx, settings) =>
      ctx.repro.daysToCalving !== null &&
      ctx.repro.daysToCalving >= 0 &&
      ctx.repro.daysToCalving <= settings.dueSoonDays,
  },
  "dry-off-due": {
    id: "dry-off-due",
    label: "Dry-off due",
    needsReproEvents: true,
    match: (ctx, _settings, now) =>
      ctx.repro.dryOffDue !== null && daysUntil(ctx.repro.dryOffDue, now) <= 14,
  },
  "check-due": {
    id: "check-due",
    label: "Check due",
    needsReproEvents: true,
    match: (ctx, _settings, now) =>
      ctx.repro.pregnancyCheckDue !== null && daysUntil(ctx.repro.pregnancyCheckDue, now) <= 7,
  },
  heat: {
    id: "heat",
    label: "In heat",
    needsReproEvents: false,
    match: (ctx) => ctx.heat48h,
  },
  "no-sensor": {
    id: "no-sensor",
    label: "No sensor",
    needsReproEvents: false,
    match: (ctx) => ctx.animal.wearable === null || ctx.animal.wearable === undefined,
  },
  "low-battery": {
    id: "low-battery",
    label: "Low battery",
    needsReproEvents: false,
    match: (ctx) =>
      ctx.animal.wearable !== null &&
      ctx.animal.wearable !== undefined &&
      typeof ctx.animal.wearable.batteryPct === "number" &&
      ctx.animal.wearable.batteryPct < 20,
  },
};

function animalDisplayName(animal) {
  return animal.name || animal.earTagNumber || animal.nationalId || animal.id || "";
}

export const SORT_OPTIONS = {
  attention: {
    id: "attention",
    label: "Needs attention",
    compare(a, b) {
      if (a.hasAttention !== b.hasAttention) return a.hasAttention ? -1 : 1;
      if (a.hasAttention && b.hasAttention && a.newestAlertTs !== b.newestAlertTs) {
        return (b.newestAlertTs ?? 0) - (a.newestAlertTs ?? 0);
      }
      return animalDisplayName(a.animal).localeCompare(animalDisplayName(b.animal), undefined, {
        numeric: true,
      });
    },
  },
  name: {
    id: "name",
    label: "Name",
    compare(a, b) {
      return animalDisplayName(a.animal).localeCompare(animalDisplayName(b.animal), undefined, {
        numeric: true,
      });
    },
  },
  tag: {
    id: "tag",
    label: "Ear tag",
    compare(a, b) {
      const tagA = a.animal.earTagNumber ?? "";
      const tagB = b.animal.earTagNumber ?? "";
      if (!tagA && !tagB) return SORT_OPTIONS.name.compare(a, b);
      if (!tagA) return 1;
      if (!tagB) return -1;
      return tagA.localeCompare(tagB, undefined, { numeric: true });
    },
  },
  age: {
    id: "age",
    label: "Age (oldest first)",
    compare(a, b) {
      const msA = a.animal.birthDate ? Date.parse(a.animal.birthDate) : Number.NaN;
      const msB = b.animal.birthDate ? Date.parse(b.animal.birthDate) : Number.NaN;
      const validA = Number.isFinite(msA);
      const validB = Number.isFinite(msB);
      if (!validA && !validB) return SORT_OPTIONS.name.compare(a, b);
      if (!validA) return 1;
      if (!validB) return -1;
      if (msA !== msB) return msA - msB;
      return SORT_OPTIONS.name.compare(a, b);
    },
  },
  group: {
    id: "group",
    label: "Group",
    compare(a, b) {
      const gA = a.animal.groupName ?? "";
      const gB = b.animal.groupName ?? "";
      if (!gA && !gB) return SORT_OPTIONS.name.compare(a, b);
      if (!gA) return 1;
      if (!gB) return -1;
      const cmp = gA.localeCompare(gB);
      return cmp !== 0 ? cmp : SORT_OPTIONS.name.compare(a, b);
    },
  },
  due: {
    id: "due",
    label: "Due date (soonest first)",
    compare(a, b) {
      const dA = a.repro.daysToCalving;
      const dB = b.repro.daysToCalving;
      const validA = dA !== null && dA !== undefined;
      const validB = dB !== null && dB !== undefined;
      if (!validA && !validB) return SORT_OPTIONS.name.compare(a, b);
      if (!validA) return 1;
      if (!validB) return -1;
      if (dA !== dB) return dA - dB;
      return SORT_OPTIONS.name.compare(a, b);
    },
  },
  milk: {
    id: "milk",
    label: "Milk (7-day average)",
    compare(a, b) {
      const mA = a.milkAverageKg;
      const mB = b.milkAverageKg;
      const validA = typeof mA === "number" && Number.isFinite(mA);
      const validB = typeof mB === "number" && Number.isFinite(mB);
      if (!validA && !validB) return SORT_OPTIONS.name.compare(a, b);
      if (!validA) return 1;
      if (!validB) return -1;
      if (mB !== mA) return mB - mA;
      return SORT_OPTIONS.name.compare(a, b);
    },
  },
};

export const FACT_OPTIONS = {
  group: {
    id: "group",
    label: "Group",
    cardAllowed: true,
    panelAllowed: true,
    format: (ctx) => ctx.animal.groupName || null,
  },
  age: {
    id: "age",
    label: "Age",
    cardAllowed: true,
    panelAllowed: true,
    format: (ctx, { now, lang } = {}) => formatAge(ctx.animal.birthDate, now, lang),
  },
  breed: {
    id: "breed",
    label: "Breed",
    cardAllowed: true,
    panelAllowed: true,
    format: (ctx) => ctx.animal.breed || null,
  },
  sex: {
    id: "sex",
    label: "Sex",
    cardAllowed: true,
    panelAllowed: true,
    format: (ctx) => formatSexLabel(ctx.animal.sex),
  },
  species: {
    id: "species",
    label: "Species",
    cardAllowed: true,
    panelAllowed: true,
    format: (ctx) => formatSpeciesLabel(ctx.animal.species, false),
  },
  lactation: {
    id: "lactation",
    label: "Lactation",
    cardAllowed: true,
    panelAllowed: true,
    format: (ctx) => formatLactationLabel(ctx.animal.lactationStatus),
  },
  reproduction: {
    id: "reproduction",
    label: "Reproduction",
    cardAllowed: true,
    panelAllowed: true,
    format: (ctx) => formatReproductionStatus(ctx.animal, ctx.repro),
  },
  "days-in-milk": {
    id: "days-in-milk",
    label: "Days in milk",
    cardAllowed: true,
    panelAllowed: true,
    format: (ctx, { lang } = {}) =>
      ctx.repro.daysInMilk !== null && ctx.repro.daysInMilk !== undefined
        ? `${formatNumber(ctx.repro.daysInMilk, lang, 0)} d in milk`
        : null,
  },
  due: {
    id: "due",
    label: "Expected due",
    cardAllowed: true,
    panelAllowed: true,
    format: (ctx, { lang } = {}) => {
      if (!ctx.repro.expectedCalving) return null;
      const term = birthTerm(ctx.animal.species);
      return `Due (${term.noun}) ${formatDateShort(ctx.repro.expectedCalving, lang)}`;
    },
  },
  milk: {
    id: "milk",
    label: "Milk (7-day avg)",
    cardAllowed: true,
    panelAllowed: true,
    format: (ctx, { lang } = {}) =>
      typeof ctx.milkAverageKg === "number" && Number.isFinite(ctx.milkAverageKg)
        ? `${formatNumber(ctx.milkAverageKg, lang, 1)} kg/day`
        : null,
  },
  sensor: {
    id: "sensor",
    label: "Sensor",
    cardAllowed: true,
    panelAllowed: true,
    format: (ctx, { lang } = {}) => formatWearable(ctx.animal.wearable, lang),
  },
  tag: {
    id: "tag",
    label: "Ear tag",
    cardAllowed: false,
    panelAllowed: true,
    mono: true,
    format: (ctx) => ctx.animal.earTagNumber || null,
  },
  nationalId: {
    id: "nationalId",
    label: "National ID",
    cardAllowed: false,
    panelAllowed: true,
    mono: true,
    format: (ctx) => ctx.animal.nationalId || null,
  },
  birthDate: {
    id: "birthDate",
    label: "Birth date",
    cardAllowed: false,
    panelAllowed: true,
    format: (ctx, { lang } = {}) =>
      ctx.animal.birthDate ? formatDateShort(ctx.animal.birthDate, lang) : null,
  },
};

export const BADGE_OPTIONS = {
  alert: {
    id: "alert",
    label: "Alert",
    tone: "danger",
    match: (ctx) => ctx.urgentAlert,
    format(ctx) {
      if (!ctx.urgentAlert) return null;
      const calvingAlert = ctx.alerts.find((a) => a.kind === "calving_alert");
      if (calvingAlert) {
        return birthTerm(ctx.animal.species).alerts;
      }
      return "Health alert";
    },
  },
  heat: {
    id: "heat",
    label: "In heat",
    tone: "warn",
    match: (ctx) => ctx.heat48h,
    format: (ctx) => (ctx.heat48h ? "In heat" : null),
  },
  "due-soon": {
    id: "due-soon",
    label: "Due soon",
    tone: "info",
    match: (ctx, settings) =>
      ctx.repro.daysToCalving !== null &&
      ctx.repro.daysToCalving >= 0 &&
      ctx.repro.daysToCalving <= settings.dueSoonDays,
    format(ctx, settings, _now, lang = "en") {
      if (!this.match(ctx, settings)) return null;
      const d = ctx.repro.daysToCalving;
      if (d === 0) return "Due today";
      if (d === 1) return "Due tomorrow";
      return `Due in ${formatNumber(d, lang, 0)} d`;
    },
  },
  "check-due": {
    id: "check-due",
    label: "Check due",
    tone: "warn",
    match: (ctx, _settings, now) =>
      ctx.repro.pregnancyCheckDue !== null && daysUntil(ctx.repro.pregnancyCheckDue, now) <= 7,
    format(ctx, settings, now) {
      if (!this.match(ctx, settings, now)) return null;
      const d = daysUntil(ctx.repro.pregnancyCheckDue, now);
      return d < 0 ? "Check overdue" : "Check due";
    },
  },
  "dry-off-due": {
    id: "dry-off-due",
    label: "Dry-off due",
    tone: "warn",
    match: (ctx, _settings, now) =>
      ctx.repro.dryOffDue !== null && daysUntil(ctx.repro.dryOffDue, now) <= 14,
    format(ctx, settings, now) {
      if (!this.match(ctx, settings, now)) return null;
      const d = daysUntil(ctx.repro.dryOffDue, now);
      return d < 0 ? "Dry-off overdue" : "Dry-off due";
    },
  },
  fresh: {
    id: "fresh",
    label: "Fresh",
    tone: "info",
    match: (ctx) => Boolean(ctx.repro.fresh),
    format: (ctx) => (ctx.repro.fresh ? "Fresh" : null),
  },
  dry: {
    id: "dry",
    label: "Dry",
    tone: "neutral",
    match: (ctx) => Boolean(ctx.repro.dry),
    format: (ctx) => (ctx.repro.dry ? "Dry" : null),
  },
  "in-calf": {
    id: "in-calf",
    label: "In calf",
    tone: "neutral",
    match: (ctx) => Boolean(ctx.repro.pregnant),
    format: (ctx) =>
      ctx.repro.pregnant ? (ctx.animal.species === "horse" ? "In foal" : "In calf") : null,
  },
};

export const PANEL_SECTION_OPTIONS = {
  attention: { id: "attention", label: "Attention" },
  reproduction: { id: "reproduction", label: "Reproduction" },
  milk: { id: "milk", label: "Milk" },
  readings: { id: "readings", label: "Readings" },
  events: { id: "events", label: "Events" },
  notes: { id: "notes", label: "Notes" },
};

export const REGISTRY = {
  species: SPECIES_OPTIONS,
  breakdown: BREAKDOWN_OPTIONS,
  filters: FILTER_OPTIONS,
  sorts: SORT_OPTIONS,
  facts: FACT_OPTIONS,
  badges: BADGE_OPTIONS,
  sections: PANEL_SECTION_OPTIONS,
};

// ------------------------------------------------------------------ CONFIG RESOLUTION

function pickIds(list, fallback, allowedMap, predicate = () => true) {
  const source = Array.isArray(list) ? list : fallback;
  const seen = new Set();
  const out = [];
  for (const id of source) {
    if (typeof id !== "string" || seen.has(id)) continue;
    const entry = allowedMap[id];
    if (!entry || !predicate(entry)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Resolves raw config.json by filling defaults for missing keys and dropping unknown option ids.
 */
export function resolveConfig(raw = {}) {
  const input = raw && typeof raw === "object" ? raw : {};
  const species =
    typeof input.species === "string" && SPECIES_OPTIONS[input.species]
      ? input.species
      : DEFAULT_CONFIG.species;

  const rawBreakdown = input.card?.breakdown;
  const breakdown =
    typeof rawBreakdown === "string" && BREAKDOWN_OPTIONS[rawBreakdown]
      ? rawBreakdown
      : DEFAULT_CONFIG.card.breakdown;

  const filters = pickIds(input.filters, DEFAULT_CONFIG.filters, FILTER_OPTIONS);
  const sorts = pickIds(input.sorts, DEFAULT_CONFIG.sorts, SORT_OPTIONS);

  const cardFacts = pickIds(
    input.animalCard?.facts,
    DEFAULT_CONFIG.animalCard.facts,
    FACT_OPTIONS,
    (f) => f.cardAllowed,
  );
  const cardBadges = pickIds(
    input.animalCard?.badges,
    DEFAULT_CONFIG.animalCard.badges,
    BADGE_OPTIONS,
  );

  const panelFacts = pickIds(
    input.animalPanel?.facts,
    DEFAULT_CONFIG.animalPanel.facts,
    FACT_OPTIONS,
    (f) => f.panelAllowed,
  );
  const panelSections = pickIds(
    input.animalPanel?.sections,
    DEFAULT_CONFIG.animalPanel.sections,
    PANEL_SECTION_OPTIONS,
  );

  const repro = reproSettings(
    input.repro && typeof input.repro === "object" ? input.repro : DEFAULT_CONFIG.repro,
  );

  return {
    species,
    card: { breakdown },
    filters,
    sorts: sorts.length > 0 ? sorts : [...DEFAULT_CONFIG.sorts],
    animalCard: {
      facts: cardFacts,
      badges: cardBadges,
    },
    animalPanel: {
      facts: panelFacts,
      sections: panelSections,
    },
    repro,
  };
}

/**
 * Whether the current resolved config requires fetching reproduction event observations
 * across the herd for filtering, sorting, card facts, or card badges.
 */
export function configNeedsHerdReproEvents(config) {
  const c = resolveConfig(config);
  if (c.filters.some((id) => FILTER_OPTIONS[id]?.needsReproEvents)) return true;
  if (c.sorts.includes("due")) return true;
  if (c.animalCard.facts.some((id) => ["reproduction", "days-in-milk", "due"].includes(id))) {
    return true;
  }
  if (
    c.animalCard.badges.some((id) =>
      ["due-soon", "check-due", "dry-off-due", "fresh", "in-calf"].includes(id),
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Whether the current resolved config requires fetching per-animal 7-day milkings
 * across the herd ("milk" is a configured card fact or sort).
 */
export function configNeedsHerdMilk(config) {
  const c = resolveConfig(config);
  return c.animalCard.facts.includes("milk") || c.sorts.includes("milk");
}

// ------------------------------------------------------------------ VIEW DERIVATIONS

export function filterByConfiguredSpecies(animals, config) {
  const c = resolveConfig(config);
  const opt = SPECIES_OPTIONS[c.species] ?? SPECIES_OPTIONS.all;
  return animals.filter((a) => opt.match(a));
}

export function buildFilterChips(contexts, config, now = Date.now()) {
  const c = resolveConfig(config);
  const chips = [
    {
      id: "all",
      testId: "herd-filter-all",
      label: "All",
      count: contexts.length,
      match: () => true,
    },
  ];

  for (const filterId of c.filters) {
    const def = FILTER_OPTIONS[filterId];
    if (!def) continue;
    if (def.expands) {
      const expanded = def.expand(contexts, c.repro, now);
      for (const item of expanded) {
        const count = contexts.filter((ctx) => item.match(ctx, c.repro, now)).length;
        chips.push({ ...item, count });
      }
    } else {
      const count = contexts.filter((ctx) => def.match(ctx, c.repro, now)).length;
      chips.push({
        id: def.id,
        testId: `herd-filter-${def.id}`,
        label: def.label,
        count,
        match: (ctx) => def.match(ctx, c.repro, now),
      });
    }
  }

  return chips;
}

export function matchesSearch(animal, query) {
  const q = String(query ?? "")
    .trim()
    .toLowerCase();
  if (!q) return true;
  return Boolean(
    animal.name?.toLowerCase().includes(q) ||
      animal.earTagNumber?.toLowerCase().includes(q) ||
      animal.nationalId?.toLowerCase().includes(q),
  );
}

export function sortContexts(contexts, sortId = "attention") {
  const sorter = SORT_OPTIONS[sortId] ?? SORT_OPTIONS.attention;
  return [...contexts].sort((a, b) => sorter.compare(a, b));
}

export function selectCardFacts(ctx, config, options = {}) {
  const c = resolveConfig(config);
  const out = [];
  for (const factId of c.animalCard.facts) {
    if (out.length >= 3) break;
    const def = FACT_OPTIONS[factId];
    if (!def?.cardAllowed) continue;
    const text = def.format(ctx, options);
    if (text) out.push({ id: factId, label: def.label, value: text });
  }
  return out;
}

export function selectCardBadges(ctx, config, now = Date.now(), lang = "en") {
  const c = resolveConfig(config);
  const out = [];
  for (const badgeId of c.animalCard.badges) {
    if (out.length >= 2) break;
    const def = BADGE_OPTIONS[badgeId];
    if (!def) continue;
    const label = def.format(ctx, c.repro, now, lang);
    if (label) {
      out.push({ id: badgeId, label, tone: def.tone });
    }
  }
  return out;
}

export function selectPanelFacts(ctx, config, options = {}) {
  const c = resolveConfig(config);
  const out = [];
  for (const factId of c.animalPanel.facts) {
    const def = FACT_OPTIONS[factId];
    if (!def?.panelAllowed) continue;
    const text = def.format(ctx, options);
    if (text) {
      out.push({ id: factId, label: def.label, value: text, mono: Boolean(def.mono) });
    }
  }
  return out;
}

/**
 * Derives the Home card summary: total, species caption, meter breakdown (top 3 + other), and attention count.
 */
export function buildCardSummary(animals, alerts = [], config = {}, now = Date.now(), lang = "en") {
  const c = resolveConfig(config);
  const scoped = filterByConfiguredSpecies(animals, c);
  const total = scoped.length;

  const cattleCount = scoped.filter((a) => a.species === "cattle").length;
  const horseCount = scoped.filter((a) => a.species === "horse").length;
  const captionParts = [];
  if (cattleCount > 0) {
    captionParts.push(`${formatNumber(cattleCount, lang, 0)} cattle`);
  }
  if (horseCount > 0) {
    captionParts.push(
      `${formatNumber(horseCount, lang, 0)} ${horseCount === 1 ? "horse" : "horses"}`,
    );
  }
  const speciesCaption = captionParts.join(", ");

  const breakdownDef = BREAKDOWN_OPTIONS[c.card.breakdown] ?? BREAKDOWN_OPTIONS.group;
  const bucketCounts = new Map();
  for (const a of scoped) {
    const key = breakdownDef.keyOf(a);
    bucketCounts.set(key, (bucketCounts.get(key) ?? 0) + 1);
  }
  const sortedBuckets = [...bucketCounts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );

  const segments = [];
  if (sortedBuckets.length <= 3) {
    for (const [label, count] of sortedBuckets) {
      segments.push({ label, count });
    }
  } else {
    for (const [label, count] of sortedBuckets.slice(0, 3)) {
      segments.push({ label, count });
    }
    const otherCount = sortedBuckets.slice(3).reduce((sum, [, count]) => sum + count, 0);
    if (otherCount > 0) {
      segments.push({ label: "other", count: otherCount });
    }
  }

  const scopedIds = new Set(scoped.map((a) => a.id));
  const since7d = now - 7 * DAY_MS;
  const attentionAnimalIds = new Set();
  for (const alert of alerts) {
    if (
      alert.animalId &&
      scopedIds.has(alert.animalId) &&
      ALERT_KINDS.includes(alert.kind) &&
      Date.parse(alert.ts) >= since7d &&
      Date.parse(alert.ts) <= now
    ) {
      attentionAnimalIds.add(alert.animalId);
    }
  }
  const attentionCount = attentionAnimalIds.size;

  return {
    total,
    speciesCaption,
    segments,
    attentionCount,
    attentionText:
      attentionCount > 0
        ? `${formatNumber(attentionCount, lang, 0)} ${attentionCount === 1 ? "needs" : "need"} a look`
        : "Nothing needs a look",
    attentionTone: attentionCount > 0 ? "danger" : "ok",
  };
}

/**
 * Formats an animal's panel sections from its full observations list.
 */
export function buildAnimalPanelDetails(
  animal,
  observations = [],
  config = {},
  now = Date.now(),
  lang = "en",
) {
  const c = resolveConfig(config);
  const ctx = deriveAnimalContext(animal, observations, c.repro, now);
  const terms = birthTerm(animal.species);

  // 1. Attention section
  const attentionAlerts = ctx.alerts.map((a) => {
    let what = "Alert";
    if (a.kind === "health_event") what = "Health event";
    else if (a.kind === "calving_alert") what = terms.alerts;
    else if (a.kind === "heat_alert") what = "Heat alert";

    const message =
      a.valueJson?.message ||
      (a.kind === "health_event" && a.valueNum !== null ? `${a.valueNum} C` : what);
    return {
      id: a.id,
      kind: a.kind,
      what,
      when: formatRelativeTime(a.ts, now, lang),
      ts: a.ts,
      message,
    };
  });

  // 2. Reproduction section (only rows that have a value)
  const reproRows = [];
  const statusLabel = formatReproductionStatus(animal, ctx.repro);
  if (statusLabel) {
    reproRows.push({ id: "status", label: "Status", value: statusLabel });
  }
  if (ctx.repro.lastCalving) {
    reproRows.push({
      id: "lastCalving",
      label: terms.last,
      value: formatDateShort(ctx.repro.lastCalving, lang),
    });
  }
  if (ctx.repro.daysInMilk !== null) {
    reproRows.push({
      id: "daysInMilk",
      label: "Days in milk",
      value: `${formatNumber(ctx.repro.daysInMilk, lang, 0)}`,
    });
  }
  if (ctx.repro.lastInsemination) {
    reproRows.push({
      id: "lastInsemination",
      label: "Last insemination",
      value: formatDateShort(ctx.repro.lastInsemination, lang),
    });
  }
  if (ctx.repro.pregnancyCheck) {
    const checkDate = formatDateShort(ctx.repro.pregnancyCheck.ts, lang);
    const res = ctx.repro.pregnancyCheck.result;
    reproRows.push({
      id: "pregnancyCheck",
      label: "Pregnancy check",
      value: res ? `${res} (${checkDate})` : checkDate,
    });
  } else if (ctx.repro.pregnancyCheckDue) {
    const dueDays = daysUntil(ctx.repro.pregnancyCheckDue, now);
    const dateStr = formatDateShort(ctx.repro.pregnancyCheckDue, lang);
    const rel =
      dueDays < 0
        ? `${formatNumber(Math.abs(dueDays), lang, 0)} d overdue`
        : dueDays === 0
          ? "due today"
          : dueDays === 1
            ? "due tomorrow"
            : `in ${formatNumber(dueDays, lang, 0)} d`;
    reproRows.push({
      id: "pregnancyCheck",
      label: "Pregnancy check",
      value: `${dateStr} (${rel})`,
    });
  }
  if (ctx.repro.expectedCalving) {
    const d = ctx.repro.daysToCalving;
    const dateStr = formatDateShort(ctx.repro.expectedCalving, lang);
    const daysText =
      d === 0
        ? "today"
        : d === 1
          ? "tomorrow"
          : d < 0
            ? `${formatNumber(Math.abs(d), lang, 0)} days ago`
            : `in ${formatNumber(d, lang, 0)} days`;
    reproRows.push({
      id: "due",
      testId: "animal-panel-due",
      label: terms.expected,
      value: `${dateStr} (${daysText})`,
    });
  }
  if (ctx.repro.dryOffDue) {
    const d = daysUntil(ctx.repro.dryOffDue, now);
    const dateStr = formatDateShort(ctx.repro.dryOffDue, lang);
    const daysText =
      d === 0
        ? "today"
        : d === 1
          ? "tomorrow"
          : d < 0
            ? `${formatNumber(Math.abs(d), lang, 0)} days overdue`
            : `in ${formatNumber(d, lang, 0)} days`;
    reproRows.push({
      id: "dryOffDue",
      label: "Dry-off due",
      value: `${dateStr} (${daysText})`,
    });
  }

  // 3. Milk section
  const milk = ctx.milkSummary;

  // 4. Readings section (latest activity, rumination, temperature, weight with their time)
  const readingDefs = [
    { kind: "activity", label: "Activity", unit: "" },
    { kind: "rumination", label: "Rumination", unit: "min/day" },
    { kind: "temperature", label: "Temperature", unit: "C" },
    { kind: "weight", label: "Weight", unit: "kg" },
  ];
  const readings = [];
  for (const def of readingDefs) {
    const latest = observations
      .filter((o) => o.kind === def.kind && o.valueNum !== null && o.valueNum !== undefined)
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
    if (latest) {
      const unitStr = def.unit ? ` ${def.unit}` : "";
      readings.push({
        kind: def.kind,
        label: def.label,
        value: `${formatNumber(latest.valueNum, lang, 1)}${unitStr}`,
        when: formatRelativeTime(latest.ts, now, lang),
        ts: latest.ts,
      });
    }
  }

  // 5. Events section (recorded events, newest first, max 10)
  const events = observations
    .filter((o) => RECORDED_EVENT_KINDS.includes(o.kind))
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))
    .slice(0, 10)
    .map((o) => {
      let title = o.kind.replace(/_/g, " ");
      title = title.charAt(0).toUpperCase() + title.slice(1);
      if (o.kind === "calving") {
        title = animal.species === "horse" ? "Foaling" : "Calving";
      } else if (o.kind === "insemination") {
        title =
          o.valueJson?.inseminationType === "NaturalService" ? "Natural service" : "Insemination";
      } else if (o.kind === "pregnancy_check") {
        title = o.valueJson?.result ? `Pregnancy check: ${o.valueJson.result}` : "Pregnancy check";
      } else if (o.kind === "dry_off") {
        title = "Dried off";
      } else if (o.kind === "treatment") {
        title = o.valueJson?.procedure ? `Treatment: ${o.valueJson.procedure}` : "Treatment";
      }
      const detail = o.valueJson?.message || null;
      return {
        id: o.id,
        kind: o.kind,
        title,
        detail,
        date: formatDateShort(o.ts, lang),
        ts: o.ts,
      };
    });

  return {
    ctx,
    facts: selectPanelFacts(ctx, c, { now, lang }),
    badges: selectCardBadges(ctx, c, now, lang),
    attention: {
      alerts: attentionAlerts,
      vetLine:
        "Alerts are signals, not diagnoses. Check the animal and call the vet for medical decisions.",
    },
    reproduction: reproRows,
    milk,
    readings,
    events,
  };
}
