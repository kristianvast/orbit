// Reproduction dates worked out from an animal's status and its recorded events (calving,
// insemination, pregnancy check, dry-off, abortion). The herd view and the calendar view each
// carry their own copy of this file so either works without the other; keep the copies identical.

export const DAY_MS = 86_400_000;

/** Farm settings; a view's config.json may override any of them under "repro". */
export const DEFAULT_REPRO = {
  gestationDays: { cattle: 280, horse: 340 },
  dryOffDaysBeforeCalving: 60,
  pregnancyCheckDaysAfterInsemination: 35,
  freshDays: 30,
  dueSoonDays: 14,
};

export function reproSettings(overrides = {}) {
  return {
    ...DEFAULT_REPRO,
    ...overrides,
    gestationDays: { ...DEFAULT_REPRO.gestationDays, ...overrides.gestationDays },
  };
}

const PREGNANT_STATUSES = ["pregnant", "pregnant_multiple_foetus"];
const POSITIVE_CHECKS = ["Pregnant", "Multiple"];

function latest(observations, kind, after = null) {
  let found = null;
  for (const o of observations) {
    if (o.kind !== kind) continue;
    if (after !== null && Date.parse(o.ts) <= after) continue;
    if (found === null || Date.parse(o.ts) > Date.parse(found.ts)) found = o;
  }
  return found;
}

const addDays = (iso, days) => new Date(Date.parse(iso) + days * DAY_MS).toISOString();

/** Whole days from now until an ISO time; negative when it has passed. */
export function daysUntil(iso, now = Date.now()) {
  return Math.ceil((Date.parse(iso) - now) / DAY_MS);
}

/**
 * Reproduction facts for one animal.
 * @param animal a row from animals.list (species, lactationStatus, reproductionStatus)
 * @param observations this animal's observations, in any order
 */
export function reproFacts(animal, observations, settings = DEFAULT_REPRO, now = Date.now()) {
  const calving = latest(observations, "calving");
  const calvedAt = calving ? Date.parse(calving.ts) : null;
  // A dry-off recorded since the last calving counts even when nobody updated the status.
  const dry =
    animal.lactationStatus === "dry" || latest(observations, "dry_off", calvedAt) !== null;

  // Only an insemination since the last calving belongs to the current cycle.
  const insemination = latest(observations, "insemination", calvedAt);
  const inseminatedAt = insemination ? Date.parse(insemination.ts) : null;
  const lost = insemination ? latest(observations, "abortion", inseminatedAt) : null;
  const check = insemination ? latest(observations, "pregnancy_check", inseminatedAt) : null;
  const checkedEmpty = check?.valueJson?.result === "Empty";
  const confirmed = POSITIVE_CHECKS.includes(check?.valueJson?.result);
  const pregnant =
    !lost && !checkedEmpty && (confirmed || PREGNANT_STATUSES.includes(animal.reproductionStatus));

  const gestation = settings.gestationDays[animal.species];
  const expectedCalving =
    pregnant && insemination && gestation ? addDays(insemination.ts, gestation) : null;

  // Only a cow in milk is dried off: she has a lactation status or a calving on record. Heifers
  // and mares get no dry-off date; on a beef farm leave "dry-off-due" out of the view's config.
  const inMilk =
    animal.species === "cattle" && !dry && (Boolean(animal.lactationStatus) || calvedAt !== null);
  const dryOffDue =
    expectedCalving && inMilk ? addDays(expectedCalving, -settings.dryOffDaysBeforeCalving) : null;

  const pregnancyCheckDue =
    insemination && !check && !lost && !PREGNANT_STATUSES.includes(animal.reproductionStatus)
      ? addDays(insemination.ts, settings.pregnancyCheckDaysAfterInsemination)
      : null;

  const daysSinceCalving = calvedAt === null ? null : Math.floor((now - calvedAt) / DAY_MS);
  return {
    lastCalving: calving?.ts ?? null,
    daysInMilk: daysSinceCalving !== null && !dry ? daysSinceCalving : null,
    lastInsemination: insemination?.ts ?? null,
    pregnancyCheck: check ? { ts: check.ts, result: check.valueJson?.result ?? null } : null,
    pregnant,
    expectedCalving,
    daysToCalving: expectedCalving ? daysUntil(expectedCalving, now) : null,
    dryOffDue,
    pregnancyCheckDue,
    fresh:
      animal.lactationStatus === "fresh" ||
      (daysSinceCalving !== null && daysSinceCalving <= settings.freshDays && !dry),
    dry,
  };
}
