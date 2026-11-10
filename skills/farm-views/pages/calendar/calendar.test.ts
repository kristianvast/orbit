import { describe, expect, test } from "bun:test";
import {
  buildEvents,
  buildMonthGrid,
  buildUpcomingList,
  buildWeekStrip,
  DEFAULT_SHOW,
  EVENT_PRIORITY,
  eventsForDay,
  formatRelativeDay,
  getNextEventSummary,
  resolveConfig,
  toLocalDay,
} from "./calendar.js";
import { DAY_MS } from "./repro.js";

function localNoon(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function addDaysIso(base: Date, days: number): string {
  return new Date(base.getTime() + days * DAY_MS).toISOString();
}

describe("resolveConfig", () => {
  test("fills defaults when keys are missing", () => {
    const cfg = resolveConfig({});
    expect(cfg.weekStart).toBe(1);
    expect(cfg.show).toEqual(DEFAULT_SHOW);
    expect(cfg.upcomingDays).toBe(60);
    expect(cfg.card.upcomingDays).toBe(14);
    expect(cfg.repro.gestationDays).toEqual({ cattle: 280, horse: 340 });
  });

  test("drops unknown event type ids and preserves config order without duplicates", () => {
    const cfg = resolveConfig({
      weekStart: 0,
      show: ["alert", "unknown-id", "expected-calving", "alert", "dry-off"],
      upcomingDays: 30,
      card: { upcomingDays: 7 },
      repro: { dryOffDaysBeforeCalving: 50, gestationDays: { cattle: 282 } },
    });
    expect(cfg.weekStart).toBe(0);
    expect(cfg.show).toEqual(["alert", "expected-calving", "dry-off"]);
    expect(cfg.upcomingDays).toBe(30);
    expect(cfg.card.upcomingDays).toBe(7);
    expect(cfg.repro.dryOffDaysBeforeCalving).toBe(50);
    expect(cfg.repro.gestationDays).toEqual({ cattle: 282, horse: 340 });
  });
});

describe("planned event derivations", () => {
  const now = localNoon(2026, 11, 10);

  test("derives expected-calving for cattle ('Calving due') and horses ('Foaling due')", () => {
    const animals = [
      {
        id: "cow-1",
        species: "cattle",
        name: "Ruby",
        earTagNumber: "DK-1013",
        lactationStatus: "dry",
        reproductionStatus: "pregnant",
      },
      {
        id: "mare-1",
        species: "horse",
        name: "Saga",
        earTagNumber: null,
        nationalId: "UELN-SAGA",
        lactationStatus: null,
        reproductionStatus: "pregnant",
      },
    ];
    const observations = [
      {
        id: "obs-1",
        animalId: "cow-1",
        kind: "insemination",
        ts: addDaysIso(now, -279),
        valueJson: { inseminationType: "Insemination" },
      },
      {
        id: "obs-2",
        animalId: "mare-1",
        kind: "insemination",
        ts: addDaysIso(now, -300),
        valueJson: { inseminationType: "Insemination" },
      },
    ];

    const events = buildEvents(animals, observations, { show: ["expected-calving"] }, now);
    expect(events).toHaveLength(2);

    const cowEv = events.find((e) => e.animalId === "cow-1");
    expect(cowEv?.title).toBe("Calving due");
    expect(cowEv?.planned).toBe(true);
    expect(cowEv?.tone).toBe("warn");
    expect(cowEv?.day).toBe(toLocalDay(addDaysIso(now, 1)));

    const mareEv = events.find((e) => e.animalId === "mare-1");
    expect(mareEv?.title).toBe("Foaling due");
    expect(mareEv?.planned).toBe(true);
    expect(mareEv?.tone).toBe("warn");
    expect(mareEv?.day).toBe(toLocalDay(addDaysIso(now, 40)));
  });

  test("derives dry-off-due for pregnant lactating cattle and pregnancy-check-due for unconfirmed inseminations", () => {
    const animals = [
      {
        id: "cow-ivy",
        species: "cattle",
        name: "Ivy",
        earTagNumber: "DK-1010",
        lactationStatus: "lactating",
        reproductionStatus: "pregnant",
      },
      {
        id: "cow-molly",
        species: "cattle",
        name: "Molly",
        earTagNumber: "DK-1004",
        lactationStatus: "early",
        reproductionStatus: "inseminated",
      },
    ];
    const observations = [
      {
        id: "obs-ivy",
        animalId: "cow-ivy",
        kind: "insemination",
        ts: addDaysIso(now, -215),
        valueJson: { inseminationType: "Insemination" },
      },
      {
        id: "obs-molly",
        animalId: "cow-molly",
        kind: "insemination",
        ts: addDaysIso(now, -12),
        valueJson: { inseminationType: "Insemination" },
      },
    ];

    const events = buildEvents(
      animals,
      observations,
      { show: ["dry-off-due", "pregnancy-check-due"] },
      now,
    );
    const dryOff = events.find((e) => e.type === "dry-off-due");
    expect(dryOff?.animalName).toBe("Ivy");
    expect(dryOff?.title).toBe("Dry-off due");
    expect(dryOff?.tone).toBe("info");
    expect(dryOff?.day).toBe(toLocalDay(addDaysIso(now, 5)));

    const pregDue = events.find((e) => e.type === "pregnancy-check-due");
    expect(pregDue?.animalName).toBe("Molly");
    expect(pregDue?.title).toBe("Pregnancy check due");
    expect(pregDue?.tone).toBe("info");
    expect(pregDue?.day).toBe(toLocalDay(addDaysIso(now, 23)));
  });

  test("marks overdue planned events with danger tone and Overdue detail", () => {
    const animals = [
      {
        id: "cow-luna",
        species: "cattle",
        name: "Luna",
        earTagNumber: "DK-1005",
        lactationStatus: "early",
        reproductionStatus: "inseminated",
      },
    ];
    const observations = [
      {
        id: "obs-luna",
        animalId: "cow-luna",
        kind: "insemination",
        ts: addDaysIso(now, -38),
        valueJson: { inseminationType: "Insemination" },
      },
    ];

    const events = buildEvents(animals, observations, { show: ["pregnancy-check-due"] }, now);
    expect(events).toHaveLength(1);
    expect(events[0]?.overdue).toBe(true);
    expect(events[0]?.tone).toBe("danger");
    expect(events[0]?.detail).toBe("Overdue");
    expect(formatRelativeDay(events[0]?.day, toLocalDay(now))).toBe("3 days overdue");
  });
});

describe("recorded event derivations", () => {
  const now = localNoon(2026, 11, 10);
  const animals = [
    { id: "c1", species: "cattle", name: "Bella", earTagNumber: "DK-1001" },
    { id: "h1", species: "horse", name: "Saga", earTagNumber: null, nationalId: "UELN-SAGA" },
  ];

  test("calving produces 'Calved' for cattle and 'Foaled' for horses", () => {
    const obs = [
      { id: "o1", animalId: "c1", kind: "calving", ts: now.toISOString(), valueJson: {} },
      { id: "o2", animalId: "h1", kind: "calving", ts: now.toISOString(), valueJson: {} },
    ];
    const evs = buildEvents(animals, obs, { show: ["calving"] }, now);
    expect(evs.find((e) => e.animalId === "c1")?.title).toBe("Calved");
    expect(evs.find((e) => e.animalId === "h1")?.title).toBe("Foaled");
    expect(evs.every((e) => e.tone === "neutral" && !e.planned)).toBe(true);
  });

  test("insemination sets 'Natural service' detail for NaturalService and RunWithBull", () => {
    const obs = [
      {
        id: "o1",
        animalId: "c1",
        kind: "insemination",
        ts: now.toISOString(),
        valueJson: { inseminationType: "NaturalService" },
      },
      {
        id: "o2",
        animalId: "c1",
        kind: "insemination",
        ts: addDaysIso(now, -1),
        valueJson: { inseminationType: "RunWithBull" },
      },
      {
        id: "o3",
        animalId: "c1",
        kind: "insemination",
        ts: addDaysIso(now, -2),
        valueJson: { inseminationType: "Insemination" },
      },
    ];
    const evs = buildEvents(animals, obs, { show: ["insemination"] }, now);
    expect(evs.find((e) => e.id === "insemination:o1")?.detail).toBe("Natural service");
    expect(evs.find((e) => e.id === "insemination:o2")?.detail).toBe("Natural service");
    expect(evs.find((e) => e.id === "insemination:o3")?.detail).toBe("");
  });

  test("pregnancy-check formats In calf / In foal / Not in calf / Not in foal", () => {
    const obs = [
      {
        id: "p1",
        animalId: "c1",
        kind: "pregnancy_check",
        ts: now.toISOString(),
        valueJson: { result: "Pregnant" },
      },
      {
        id: "p2",
        animalId: "h1",
        kind: "pregnancy_check",
        ts: now.toISOString(),
        valueJson: { result: "Multiple" },
      },
      {
        id: "p3",
        animalId: "c1",
        kind: "pregnancy_check",
        ts: addDaysIso(now, -1),
        valueJson: { result: "Empty" },
      },
      {
        id: "p4",
        animalId: "h1",
        kind: "pregnancy_check",
        ts: addDaysIso(now, -1),
        valueJson: { result: "Empty" },
      },
    ];
    const evs = buildEvents(animals, obs, { show: ["pregnancy-check"] }, now);
    expect(evs.find((e) => e.id === "pregnancy-check:p1")?.detail).toBe("In calf");
    expect(evs.find((e) => e.id === "pregnancy-check:p2")?.detail).toBe("In foal");
    expect(evs.find((e) => e.id === "pregnancy-check:p3")?.detail).toBe("Not in calf");
    expect(evs.find((e) => e.id === "pregnancy-check:p4")?.detail).toBe("Not in foal");
  });

  test("dry-off and treatment and alert derive titles, details, and tones accurately", () => {
    const obs = [
      { id: "d1", animalId: "c1", kind: "dry_off", ts: now.toISOString(), valueJson: {} },
      {
        id: "t1",
        animalId: "c1",
        kind: "treatment",
        ts: now.toISOString(),
        valueJson: { procedure: "Examination", message: "Checked by the vet" },
      },
      {
        id: "a1",
        animalId: "c1",
        kind: "health_event",
        ts: now.toISOString(),
        valueJson: { message: "Body temperature 40.4 C" },
      },
      {
        id: "a2",
        animalId: "c1",
        kind: "calving_alert",
        ts: now.toISOString(),
        valueJson: { message: "Restless in calving pen" },
      },
      {
        id: "a3",
        animalId: "c1",
        kind: "heat_alert",
        ts: now.toISOString(),
        valueJson: { message: "Activity spike" },
      },
    ];
    const evs = buildEvents(animals, obs, { show: ["dry-off", "treatment", "alert"] }, now);
    expect(evs.find((e) => e.id === "dry-off:d1")?.title).toBe("Dried off");
    expect(evs.find((e) => e.id === "treatment:t1")?.detail).toBe(
      "Examination: Checked by the vet",
    );

    const hAlert = evs.find((e) => e.id === "alert:a1");
    expect(hAlert?.title).toBe("Health alert");
    expect(hAlert?.tone).toBe("danger");
    expect(hAlert?.detail).toBe("Body temperature 40.4 C");

    const cAlert = evs.find((e) => e.id === "alert:a2");
    expect(cAlert?.title).toBe("Calving alert");
    expect(cAlert?.tone).toBe("danger");

    const heatAlert = evs.find((e) => e.id === "alert:a3");
    expect(heatAlert?.title).toBe("Heat alert");
    expect(heatAlert?.tone).toBe("warn");
  });
});

describe("priority ordering, filtering, and grid/week/upcoming builders", () => {
  const now = localNoon(2026, 11, 10);
  const todayStr = toLocalDay(now);

  test("orders events within a day by EVENT_PRIORITY", () => {
    const animals = [
      {
        id: "c1",
        species: "cattle",
        name: "Ruby",
        earTagNumber: "DK-1013",
        lactationStatus: "lactating",
        reproductionStatus: "pregnant",
      },
    ];
    const obs = [
      { id: "o-dry", animalId: "c1", kind: "dry_off", ts: now.toISOString(), valueJson: {} },
      {
        id: "o-preg",
        animalId: "c1",
        kind: "pregnancy_check",
        ts: now.toISOString(),
        valueJson: { result: "Pregnant" },
      },
      {
        id: "o-ins",
        animalId: "c1",
        kind: "insemination",
        ts: addDaysIso(now, -280),
        valueJson: { inseminationType: "Insemination" },
      },
      {
        id: "o-treat",
        animalId: "c1",
        kind: "treatment",
        ts: now.toISOString(),
        valueJson: { message: "Check" },
      },
      { id: "o-calv", animalId: "c1", kind: "calving", ts: addDaysIso(now, -350), valueJson: {} },
      {
        id: "o-alert",
        animalId: "c1",
        kind: "calving_alert",
        ts: now.toISOString(),
        valueJson: { message: "Alert" },
      },
    ];
    const all = buildEvents(animals, obs, {}, now);
    const dayEvs = eventsForDay(all, todayStr);
    expect(dayEvs.map((e) => e.type)).toEqual([
      "expected-calving",
      "alert",
      "treatment",
      "pregnancy-check",
      "dry-off",
    ]);
    expect(EVENT_PRIORITY[0]).toBe("expected-calving");
  });

  test("month grid and week strip honour weekStart (1 = Monday vs 0 = Sunday)", () => {
    const gridMon = buildMonthGrid(2026, 10, [], { weekStart: 1 }, now); // Nov 2026: Nov 1 is Sunday
    // With Monday start, Nov 1 (Sun) is at index 6 of the first week, so index 0 is Oct 26
    expect(gridMon[0]?.[0]?.day).toBe("2026-10-26");
    expect(gridMon[0]?.[6]?.day).toBe("2026-11-01");
    expect(gridMon[0]?.[6]?.inMonth).toBe(true);

    const gridSun = buildMonthGrid(2026, 10, [], { weekStart: 0 }, now);
    // With Sunday start, Nov 1 (Sun) is at index 0 of the first week
    expect(gridSun[0]?.[0]?.day).toBe("2026-11-01");

    const stripMon = buildWeekStrip([], { weekStart: 1 }, now); // Nov 10 2026 is Tuesday
    expect(stripMon[0]?.day).toBe("2026-11-09"); // Monday
    expect(stripMon[1]?.isToday).toBe(true);

    const stripSun = buildWeekStrip([], { weekStart: 0 }, now);
    expect(stripSun[0]?.day).toBe("2026-11-08"); // Sunday
    expect(stripSun[2]?.isToday).toBe(true);
  });

  test("chip filtering via config.show and activeTypes excludes unselected types", () => {
    const animals = [{ id: "c1", species: "cattle", name: "Rosa", earTagNumber: "DK-1003" }];
    const obs = [
      {
        id: "a1",
        animalId: "c1",
        kind: "heat_alert",
        ts: now.toISOString(),
        valueJson: { message: "Heat" },
      },
      {
        id: "t1",
        animalId: "c1",
        kind: "treatment",
        ts: now.toISOString(),
        valueJson: { message: "Hoof trim" },
      },
    ];
    const withoutAlertConfig = buildEvents(animals, obs, { show: ["treatment"] }, now);
    expect(withoutAlertConfig.map((e) => e.type)).toEqual(["treatment"]);

    const both = buildEvents(animals, obs, { show: ["alert", "treatment"] }, now);
    const filteredDay = eventsForDay(both, todayStr, ["treatment"]);
    expect(filteredDay.map((e) => e.type)).toEqual(["treatment"]);
  });

  test("buildUpcomingList puts overdue first and getNextEventSummary picks next future planned event", () => {
    const animals = [
      {
        id: "luna",
        species: "cattle",
        name: "Luna",
        earTagNumber: "DK-1005",
        lactationStatus: "early",
        reproductionStatus: "inseminated",
      },
      {
        id: "ruby",
        species: "cattle",
        name: "Ruby",
        earTagNumber: "DK-1013",
        lactationStatus: "dry",
        reproductionStatus: "pregnant",
      },
    ];
    const obs = [
      { id: "o1", animalId: "luna", kind: "insemination", ts: addDaysIso(now, -38), valueJson: {} },
      {
        id: "o2",
        animalId: "ruby",
        kind: "insemination",
        ts: addDaysIso(now, -279),
        valueJson: {},
      },
    ];
    const evs = buildEvents(animals, obs, {}, now);
    const upcoming = buildUpcomingList(evs, { upcomingDays: 60 }, now);
    expect(upcoming.map((e) => e.animalName)).toEqual(["Luna", "Ruby"]);
    expect(upcoming[0]?.relativeLabel).toBe("3 days overdue");
    expect(upcoming[1]?.relativeLabel).toBe("Tomorrow");

    const summary = getNextEventSummary(evs, { card: { upcomingDays: 14 } }, now);
    expect(summary.overdueCount).toBe(1);
    expect(summary.next?.animalName).toBe("Ruby");
    expect(summary.next?.relativeLabel).toBe("Tomorrow");
  });
});
