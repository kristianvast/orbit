import { describe, expect, test } from "bun:test";
import {
  BADGE_OPTIONS,
  BREAKDOWN_OPTIONS,
  buildAnimalPanelDetails,
  buildCardSummary,
  buildFilterChips,
  computeMilkSummary,
  configNeedsHerdMilk,
  configNeedsHerdReproEvents,
  DAY_MS,
  DEFAULT_CONFIG,
  deriveAnimalContext,
  FACT_OPTIONS,
  FILTER_OPTIONS,
  filterByConfiguredSpecies,
  formatAge,
  formatWearable,
  matchesSearch,
  PANEL_SECTION_OPTIONS,
  reproSettings,
  resolveConfig,
  SORT_OPTIONS,
  SPECIES_OPTIONS,
  selectCardBadges,
  selectCardFacts,
  selectPanelFacts,
  sortContexts,
  toSlug,
} from "./herd.js";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const daysAgo = (d: number) => new Date(NOW - d * DAY_MS).toISOString();

function makeAnimal(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    species: "cattle",
    name: "Bella",
    earTagNumber: "DK-1001",
    nationalId: "CATTLE-500100",
    breed: "Holstein",
    sex: "female",
    birthDate: "2022-05-10",
    groupName: "Milking",
    status: "active",
    lactationStatus: "lactating",
    reproductionStatus: "open",
    wearable: { deviceId: "d1", kind: "collar", vendor: "Demo", batteryPct: 82 },
    notes: null,
    ...overrides,
  };
}

describe("resolveConfig", () => {
  test("fills defaults when keys are missing and preserves valid config order", () => {
    const resolved = resolveConfig({});
    expect(resolved.species).toBe(DEFAULT_CONFIG.species);
    expect(resolved.card.breakdown).toBe(DEFAULT_CONFIG.card.breakdown);
    expect(resolved.filters).toEqual(DEFAULT_CONFIG.filters);
    expect(resolved.sorts).toEqual(DEFAULT_CONFIG.sorts);
    expect(resolved.animalCard.facts).toEqual(DEFAULT_CONFIG.animalCard.facts);
    expect(resolved.animalCard.badges).toEqual(DEFAULT_CONFIG.animalCard.badges);
    expect(resolved.animalPanel.facts).toEqual(DEFAULT_CONFIG.animalPanel.facts);
    expect(resolved.animalPanel.sections).toEqual(DEFAULT_CONFIG.animalPanel.sections);
    expect(resolved.repro.gestationDays.cattle).toBe(280);
  });

  test("drops unknown option ids, deduplicates, and restricts card-only vs panel-only facts", () => {
    const custom = resolveConfig({
      species: "martian",
      card: { breakdown: "unknown" },
      filters: ["due-soon", "bogus", "in-calf", "due-soon"],
      sorts: ["milk", "unknown-sort", "due"],
      animalCard: {
        facts: ["milk", "nationalId", "tag", "birthDate", "lactation", "unknown"],
        badges: ["in-calf", "nope", "heat"],
      },
      animalPanel: {
        facts: ["birthDate", "tag", "unknown-fact", "milk"],
        sections: ["notes", "bogus-section", "milk"],
      },
      repro: { dueSoonDays: 10 },
    });

    expect(custom.species).toBe("all");
    expect(custom.card.breakdown).toBe("group");
    expect(custom.filters).toEqual(["due-soon", "in-calf"]);
    expect(custom.sorts).toEqual(["milk", "due"]);
    // nationalId, tag, birthDate are panel-only, not allowed in animalCard.facts
    expect(custom.animalCard.facts).toEqual(["milk", "lactation"]);
    expect(custom.animalCard.badges).toEqual(["in-calf", "heat"]);
    expect(custom.animalPanel.facts).toEqual(["birthDate", "tag", "milk"]);
    expect(custom.animalPanel.sections).toEqual(["notes", "milk"]);
    expect(custom.repro.dueSoonDays).toBe(10);
  });

  test("detects when herd-wide repro events or per-animal milk queries are needed", () => {
    expect(
      configNeedsHerdReproEvents({
        filters: ["attention", "group"],
        sorts: ["name"],
        animalCard: { facts: ["group"], badges: ["alert", "dry"] },
      }),
    ).toBe(false);
    expect(configNeedsHerdReproEvents({ filters: ["in-calf"] })).toBe(true);
    expect(configNeedsHerdMilk(DEFAULT_CONFIG)).toBe(false);
    expect(configNeedsHerdMilk({ sorts: ["milk"] })).toBe(true);
    expect(configNeedsHerdMilk({ animalCard: { facts: ["milk"] } })).toBe(true);
  });
});

describe("species and card.breakdown rules", () => {
  const animals = [
    makeAnimal({ id: "c1", species: "cattle", groupName: "Milking", lactationStatus: "lactating" }),
    makeAnimal({ id: "c2", species: "cattle", groupName: "Milking", lactationStatus: "fresh" }),
    makeAnimal({ id: "c3", species: "cattle", groupName: "Dry", lactationStatus: "dry" }),
    makeAnimal({ id: "c4", species: "cattle", groupName: "Pasture", lactationStatus: null }),
    makeAnimal({ id: "h1", species: "horse", groupName: "Stable", lactationStatus: null }),
  ];

  test("species filter limits the view for all, cattle, and horse", () => {
    expect(SPECIES_OPTIONS.all.match(animals[0])).toBe(true);
    expect(SPECIES_OPTIONS.cattle.match(animals[0])).toBe(true);
    expect(SPECIES_OPTIONS.cattle.match(animals[4])).toBe(false);
    expect(SPECIES_OPTIONS.horse.match(animals[4])).toBe(true);

    expect(filterByConfiguredSpecies(animals, { species: "all" })).toHaveLength(5);
    expect(filterByConfiguredSpecies(animals, { species: "cattle" })).toHaveLength(4);
    expect(filterByConfiguredSpecies(animals, { species: "horse" })).toHaveLength(1);
  });

  test("card.breakdown splits by group, species, or lactation and sums past top 3 as other", () => {
    expect(BREAKDOWN_OPTIONS.group.keyOf(animals[0])).toBe("Milking");
    expect(BREAKDOWN_OPTIONS.species.keyOf(animals[4])).toBe("Horses");
    expect(BREAKDOWN_OPTIONS.lactation.keyOf(animals[1])).toBe("Fresh");

    const byGroup = buildCardSummary(
      animals,
      [{ animalId: "c1", kind: "health_event", ts: hoursAgo(3) }],
      { card: { breakdown: "group" } },
      NOW,
    );
    expect(byGroup.total).toBe(5);
    expect(byGroup.speciesCaption).toBe("4 cattle, 1 horse");
    // 4 groups: Milking (2), Dry (1), Pasture (1), Stable (1) -> top 3 + other (1)
    expect(byGroup.segments).toEqual([
      { label: "Milking", count: 2 },
      { label: "Dry", count: 1 },
      { label: "Pasture", count: 1 },
      { label: "other", count: 1 },
    ]);
    expect(byGroup.attentionCount).toBe(1);
    expect(byGroup.attentionTone).toBe("danger");

    const quiet = buildCardSummary(
      animals,
      [],
      { species: "cattle", card: { breakdown: "species" } },
      NOW,
    );
    expect(quiet.speciesCaption).toBe("4 cattle");
    expect(quiet.attentionText).toBe("Nothing needs a look");
    expect(quiet.attentionTone).toBe("ok");
  });
});

describe("filter registry rules", () => {
  const settings = reproSettings();

  test("attention matches health_event, calving_alert, or heat_alert in last 7 days", () => {
    const withAlert = deriveAnimalContext(
      makeAnimal(),
      [{ kind: "health_event", ts: daysAgo(2) }],
      settings,
      NOW,
    );
    const oldAlert = deriveAnimalContext(
      makeAnimal(),
      [{ kind: "health_event", ts: daysAgo(9) }],
      settings,
      NOW,
    );
    expect(FILTER_OPTIONS.attention.match(withAlert)).toBe(true);
    expect(FILTER_OPTIONS.attention.match(oldAlert)).toBe(false);
  });

  test("group expands sorted by group size descending, then group name", () => {
    const contexts = [
      deriveAnimalContext(makeAnimal({ id: "1", groupName: "Pasture" }), [], settings, NOW),
      deriveAnimalContext(makeAnimal({ id: "2", groupName: "Milking" }), [], settings, NOW),
      deriveAnimalContext(makeAnimal({ id: "3", groupName: "Milking" }), [], settings, NOW),
      deriveAnimalContext(makeAnimal({ id: "4", groupName: "Dry" }), [], settings, NOW),
    ];
    const chips = buildFilterChips(contexts, { filters: ["group"] }, NOW);
    expect(chips.map((c) => `${c.label}:${c.count}`)).toEqual([
      "All:4",
      "Milking:2",
      "Dry:1",
      "Pasture:1",
    ]);
    expect(chips[1].testId).toBe("herd-filter-group-milking");
  });

  test("species filter expands only when farm has more than one species", () => {
    const cattleOnly = [deriveAnimalContext(makeAnimal({ species: "cattle" }), [], settings, NOW)];
    expect(FILTER_OPTIONS.species.expand(cattleOnly)).toHaveLength(0);

    const mixed = [
      deriveAnimalContext(makeAnimal({ id: "1", species: "cattle" }), [], settings, NOW),
      deriveAnimalContext(makeAnimal({ id: "2", species: "horse" }), [], settings, NOW),
    ];
    const expanded = FILTER_OPTIONS.species.expand(mixed);
    expect(expanded.map((e) => e.testId)).toEqual([
      "herd-filter-species-cattle",
      "herd-filter-species-horse",
    ]);
  });

  test("fresh, dry, in-calf, inseminated, open", () => {
    const freshCtx = deriveAnimalContext(
      makeAnimal({ lactationStatus: "fresh", reproductionStatus: "birthed" }),
      [{ kind: "calving", ts: daysAgo(9) }],
      settings,
      NOW,
    );
    const dryInCalfCtx = deriveAnimalContext(
      makeAnimal({ lactationStatus: "dry", reproductionStatus: "pregnant" }),
      [{ kind: "insemination", ts: daysAgo(240) }],
      settings,
      NOW,
    );
    const insemCtx = deriveAnimalContext(
      makeAnimal({ reproductionStatus: "inseminated" }),
      [{ kind: "insemination", ts: daysAgo(12) }],
      settings,
      NOW,
    );
    const openFemaleCtx = deriveAnimalContext(
      makeAnimal({ sex: "female", reproductionStatus: "open" }),
      [],
      settings,
      NOW,
    );
    const openMaleCtx = deriveAnimalContext(
      makeAnimal({ sex: "male", reproductionStatus: "open" }),
      [],
      settings,
      NOW,
    );

    expect(FILTER_OPTIONS.fresh.match(freshCtx)).toBe(true);
    expect(FILTER_OPTIONS.dry.match(dryInCalfCtx)).toBe(true);
    expect(FILTER_OPTIONS["in-calf"].match(dryInCalfCtx)).toBe(true);
    expect(FILTER_OPTIONS.inseminated.match(insemCtx)).toBe(true);
    expect(FILTER_OPTIONS.open.match(openFemaleCtx)).toBe(true);
    expect(FILTER_OPTIONS.open.match(openMaleCtx)).toBe(false);
  });

  test("due-soon, dry-off-due, check-due, heat, no-sensor, low-battery", () => {
    // Due tomorrow (inseminated 279 days ago, gestation 280)
    const dueSoonCtx = deriveAnimalContext(
      makeAnimal({ lactationStatus: "dry", reproductionStatus: "pregnant" }),
      [{ kind: "insemination", ts: daysAgo(279) }],
      settings,
      NOW,
    );
    expect(FILTER_OPTIONS["due-soon"].match(dueSoonCtx, settings)).toBe(true);

    // Dry-off due in 5 days (inseminated 215 days ago -> due in 65 days -> dry-off in 5 days)
    const dryOffDueCtx = deriveAnimalContext(
      makeAnimal({ lactationStatus: "lactating", reproductionStatus: "pregnant" }),
      [{ kind: "insemination", ts: daysAgo(215) }],
      settings,
      NOW,
    );
    expect(FILTER_OPTIONS["dry-off-due"].match(dryOffDueCtx, settings, NOW)).toBe(true);

    // Check due overdue by 3 days (inseminated 38 days ago, check at 35 days)
    const checkDueCtx = deriveAnimalContext(
      makeAnimal({ lactationStatus: "early", reproductionStatus: "inseminated" }),
      [{ kind: "insemination", ts: daysAgo(38) }],
      settings,
      NOW,
    );
    expect(FILTER_OPTIONS["check-due"].match(checkDueCtx, settings, NOW)).toBe(true);

    // Heat alert in last 48h vs 72h ago
    const heatRecent = deriveAnimalContext(
      makeAnimal(),
      [{ kind: "heat_alert", ts: hoursAgo(12) }],
      settings,
      NOW,
    );
    const heatOld = deriveAnimalContext(
      makeAnimal(),
      [{ kind: "heat_alert", ts: hoursAgo(72) }],
      settings,
      NOW,
    );
    expect(FILTER_OPTIONS.heat.match(heatRecent)).toBe(true);
    expect(FILTER_OPTIONS.heat.match(heatOld)).toBe(false);

    // Sensor & battery
    const noSensor = deriveAnimalContext(makeAnimal({ wearable: null }), [], settings, NOW);
    const lowBat = deriveAnimalContext(
      makeAnimal({ wearable: { deviceId: "d2", kind: "collar", vendor: "Demo", batteryPct: 15 } }),
      [],
      settings,
      NOW,
    );
    expect(FILTER_OPTIONS["no-sensor"].match(noSensor)).toBe(true);
    expect(FILTER_OPTIONS["no-sensor"].match(lowBat)).toBe(false);
    expect(FILTER_OPTIONS["low-battery"].match(lowBat)).toBe(true);
    expect(FILTER_OPTIONS["low-battery"].match(heatRecent)).toBe(false);
  });
});

describe("sort registry rules", () => {
  const settings = reproSettings();
  const aRuby = deriveAnimalContext(
    makeAnimal({
      id: "ruby",
      name: "Ruby",
      earTagNumber: "DK-1013",
      birthDate: "2019-03-01",
      groupName: "Dry",
      lactationStatus: "dry",
      reproductionStatus: "pregnant",
    }),
    [
      { kind: "calving_alert", ts: hoursAgo(2) },
      { kind: "insemination", ts: daysAgo(279) },
    ],
    settings,
    NOW,
    null,
  );
  const aRosa = deriveAnimalContext(
    makeAnimal({
      id: "rosa",
      name: "Rosa",
      earTagNumber: "DK-1003",
      birthDate: "2021-06-15",
      groupName: "Milking",
    }),
    [{ kind: "heat_alert", ts: hoursAgo(5) }],
    settings,
    NOW,
    32.4,
  );
  const aBella = deriveAnimalContext(
    makeAnimal({
      id: "bella",
      name: "Bella",
      earTagNumber: "DK-1001",
      birthDate: "2020-01-10",
      groupName: "Milking",
      reproductionStatus: "pregnant",
    }),
    [{ kind: "insemination", ts: daysAgo(240) }],
    settings,
    NOW,
    38.1,
  );

  test("sorts by attention, name, tag, age, group, due, and milk", () => {
    const list = [aBella, aRosa, aRuby];

    expect(sortContexts(list, "attention").map((c) => c.animal.name)).toEqual([
      "Ruby",
      "Rosa",
      "Bella",
    ]);
    expect(sortContexts(list, "name").map((c) => c.animal.name)).toEqual(["Bella", "Rosa", "Ruby"]);
    expect(sortContexts(list, "tag").map((c) => c.animal.earTagNumber)).toEqual([
      "DK-1001",
      "DK-1003",
      "DK-1013",
    ]);
    expect(sortContexts(list, "age").map((c) => c.animal.name)).toEqual(["Ruby", "Bella", "Rosa"]);
    expect(sortContexts(list, "group").map((c) => c.animal.name)).toEqual([
      "Ruby",
      "Bella",
      "Rosa",
    ]);
    expect(sortContexts(list, "due").map((c) => c.animal.name)).toEqual(["Ruby", "Bella", "Rosa"]);
    expect(sortContexts(list, "milk").map((c) => c.animal.name)).toEqual(["Bella", "Rosa", "Ruby"]);
    expect(Object.keys(SORT_OPTIONS)).toEqual([
      "attention",
      "name",
      "tag",
      "age",
      "group",
      "due",
      "milk",
    ]);
  });
});

describe("age, milk, facts, badges, and panel sections", () => {
  test("age formatting follows <60d -> days, <24m -> months, else years, unknown -> null", () => {
    expect(formatAge(daysAgo(18).slice(0, 10), NOW)).toBe("18 days");
    expect(formatAge(daysAgo(200).slice(0, 10), NOW)).toBe("6 months");
    expect(formatAge(daysAgo(400).slice(0, 10), NOW)).toBe("13 months");
    expect(formatAge("2021-11-01", NOW)).toBe("5 yrs");
    expect(formatAge(null, NOW)).toBeNull();
  });

  test("milk 7-day average divides total kg by number of days with milkings", () => {
    const obs = [
      { kind: "milking", ts: hoursAgo(2), valueNum: 12 },
      { kind: "milking", ts: hoursAgo(8), valueNum: 14 },
      { kind: "milking", ts: daysAgo(2), valueNum: 10 },
      { kind: "milking", ts: daysAgo(2), valueNum: 12 },
    ];
    // Day 0 total = 26, Day 2 total = 22 -> 48 / 2 days = 24.0 kg
    const summary = computeMilkSummary(obs, NOW);
    expect(summary.averageKg).toBe(24);
    expect(summary.lastMilking?.kg).toBe(12);
    expect(summary.dailyTotals).toHaveLength(7);
  });

  test("every fact in FACT_OPTIONS formats properly and card renders at most 3", () => {
    const settings = reproSettings();
    const ctx = deriveAnimalContext(
      makeAnimal({
        birthDate: "2021-05-01",
        lactationStatus: "lactating",
        reproductionStatus: "pregnant",
      }),
      [
        { kind: "calving", ts: daysAgo(150) },
        { kind: "insemination", ts: daysAgo(75) },
      ],
      settings,
      NOW,
      31.5,
    );

    expect(FACT_OPTIONS.group.format(ctx)).toBe("Milking");
    expect(FACT_OPTIONS.age.format(ctx, { now: NOW })).toBe("5 yrs");
    expect(FACT_OPTIONS.breed.format(ctx)).toBe("Holstein");
    expect(FACT_OPTIONS.sex.format(ctx)).toBe("Female");
    expect(FACT_OPTIONS.species.format(ctx)).toBe("Cattle");
    expect(FACT_OPTIONS.lactation.format(ctx)).toBe("In milk");
    expect(FACT_OPTIONS.reproduction.format(ctx)).toBe("In calf");
    expect(FACT_OPTIONS["days-in-milk"].format(ctx)).toBe("150 d in milk");
    expect(FACT_OPTIONS.due.format(ctx)).toContain("Due (calving)");
    expect(FACT_OPTIONS.milk.format(ctx)).toBe("31.5 kg/day");
    expect(FACT_OPTIONS.sensor.format(ctx)).toBe("Collar, battery 82%");
    expect(FACT_OPTIONS.tag.format(ctx)).toBe("DK-1001");
    expect(FACT_OPTIONS.nationalId.format(ctx)).toBe("CATTLE-500100");
    expect(FACT_OPTIONS.birthDate.format(ctx)).toContain("2021");

    const cardFacts = selectCardFacts(
      ctx,
      { animalCard: { facts: ["group", "age", "breed", "milk"] } },
      { now: NOW },
    );
    expect(cardFacts).toHaveLength(3);

    const panelFacts = selectPanelFacts(
      ctx,
      { animalPanel: { facts: ["tag", "nationalId", "birthDate", "sensor"] } },
      { now: NOW },
    );
    expect(panelFacts.map((f) => f.id)).toEqual(["tag", "nationalId", "birthDate", "sensor"]);
  });

  test("every badge in BADGE_OPTIONS matches its rule and card renders at most 2 in config order", () => {
    const settings = reproSettings();
    const ctx = deriveAnimalContext(
      makeAnimal({ lactationStatus: "dry", reproductionStatus: "pregnant" }),
      [
        { kind: "calving_alert", ts: hoursAgo(2) },
        { kind: "heat_alert", ts: hoursAgo(4) },
        { kind: "insemination", ts: daysAgo(279) },
      ],
      settings,
      NOW,
    );

    expect(BADGE_OPTIONS.alert.format(ctx)).toBe("Calving alert");
    expect(BADGE_OPTIONS.heat.format(ctx)).toBe("In heat");
    expect(BADGE_OPTIONS["due-soon"].format(ctx, settings, NOW)).toBe("Due tomorrow");
    expect(BADGE_OPTIONS.dry.format(ctx)).toBe("Dry");
    expect(BADGE_OPTIONS["in-calf"].format(ctx)).toBe("In calf");

    const badges = selectCardBadges(
      ctx,
      { animalCard: { badges: ["alert", "due-soon", "dry", "in-calf"] } },
      NOW,
    );
    expect(badges).toEqual([
      { id: "alert", label: "Calving alert", tone: "danger" },
      { id: "due-soon", label: "Due tomorrow", tone: "info" },
    ]);

    const checkCtx = deriveAnimalContext(
      makeAnimal({ lactationStatus: "lactating", reproductionStatus: "inseminated" }),
      [{ kind: "insemination", ts: daysAgo(38) }],
      settings,
      NOW,
    );
    expect(BADGE_OPTIONS["check-due"].format(checkCtx, settings, NOW)).toBe("Check overdue");

    const dryOffCtx = deriveAnimalContext(
      makeAnimal({ lactationStatus: "lactating", reproductionStatus: "pregnant" }),
      [{ kind: "insemination", ts: daysAgo(215) }],
      settings,
      NOW,
    );
    expect(BADGE_OPTIONS["dry-off-due"].format(dryOffCtx, settings, NOW)).toBe("Dry-off due");

    const freshCtx = deriveAnimalContext(
      makeAnimal({ lactationStatus: "fresh", reproductionStatus: "birthed" }),
      [{ kind: "calving", ts: daysAgo(5) }],
      settings,
      NOW,
    );
    expect(BADGE_OPTIONS.fresh.format(freshCtx)).toBe("Fresh");
  });

  test("panel details use foaling terminology for horses and calving for cattle", () => {
    const saga = makeAnimal({
      id: "saga",
      species: "horse",
      name: "Saga",
      earTagNumber: null,
      nationalId: "UELN-SAGA",
      breed: "Fjord",
      lactationStatus: null,
      reproductionStatus: "pregnant",
      wearable: null,
    });
    const details = buildAnimalPanelDetails(
      saga,
      [
        { id: "o1", kind: "insemination", ts: daysAgo(300), valueJson: {} },
        { id: "o2", kind: "pregnancy_check", ts: daysAgo(270), valueJson: { result: "Pregnant" } },
        { id: "o3", kind: "weight", ts: daysAgo(3), valueNum: 495, valueJson: { unit: "kg" } },
      ],
      DEFAULT_CONFIG,
      NOW,
    );
    const dueRow = details.reproduction.find((r) => r.id === "due");
    expect(dueRow?.label).toBe("Expected foaling");
    expect(dueRow?.value).toContain("in 40 days");
    expect(details.readings).toEqual([
      expect.objectContaining({ kind: "weight", value: "495 kg" }),
    ]);
    expect(formatWearable(null)).toBe("No sensor");
    expect(Object.keys(PANEL_SECTION_OPTIONS)).toEqual([
      "attention",
      "reproduction",
      "milk",
      "readings",
      "events",
      "notes",
    ]);
  });

  test("search and slug helpers", () => {
    const a = makeAnimal({ name: "Bella", earTagNumber: "DK-1001", nationalId: "CATTLE-500100" });
    expect(matchesSearch(a, "bella")).toBe(true);
    expect(matchesSearch(a, "1001")).toBe(true);
    expect(matchesSearch(a, "500100")).toBe(true);
    expect(matchesSearch(a, "storm")).toBe(false);
    expect(toSlug("Milking Cows #1")).toBe("milking-cows-1");
  });
});
