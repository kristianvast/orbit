import { describe, expect, test } from "bun:test";
import { DAY_MS, reproFacts, reproSettings } from "./repro.js";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW - days * DAY_MS).toISOString();
const event = (kind: string, days: number, valueJson: Record<string, unknown> = {}) => ({
  kind,
  ts: daysAgo(days),
  valueJson,
});
const cow = (status: { lactationStatus?: string | null; reproductionStatus?: string | null }) => ({
  species: "cattle",
  lactationStatus: null,
  reproductionStatus: null,
  ...status,
});
const day = (iso: string | null) => iso?.slice(0, 10) ?? null;

describe("reproFacts", () => {
  test("a confirmed cow in milk is due 280 days after insemination and dries off 60 days before", () => {
    const facts = reproFacts(
      cow({ lactationStatus: "lactating", reproductionStatus: "pregnant" }),
      [
        event("calving", 300),
        event("insemination", 215),
        event("pregnancy_check", 180, { result: "Pregnant" }),
      ],
      reproSettings(),
      NOW,
    );
    expect(day(facts.expectedCalving)).toBe("2027-01-14");
    expect(facts.daysToCalving).toBe(65);
    expect(day(facts.dryOffDue)).toBe("2026-11-15");
    expect(facts.daysInMilk).toBe(300);
    expect(facts.pregnancyCheckDue).toBeNull();
  });

  test("an insemination before the last calving belongs to the previous cycle", () => {
    const facts = reproFacts(
      cow({ lactationStatus: "fresh", reproductionStatus: "birthed" }),
      [event("insemination", 290), event("calving", 9)],
      reproSettings(),
      NOW,
    );
    expect(facts.lastInsemination).toBeNull();
    expect(facts.expectedCalving).toBeNull();
    expect(facts.fresh).toBe(true);
  });

  test("an inseminated cow without a check gets a pregnancy check date and no calving date", () => {
    const facts = reproFacts(
      cow({ lactationStatus: "early", reproductionStatus: "inseminated" }),
      [event("calving", 95), event("insemination", 38)],
      reproSettings(),
      NOW,
    );
    expect(facts.pregnant).toBe(false);
    expect(facts.expectedCalving).toBeNull();
    expect(day(facts.pregnancyCheckDue)).toBe("2026-11-07");
  });

  test("an empty check or an abortion after insemination clears the calving date", () => {
    const pregnant = cow({ lactationStatus: "lactating", reproductionStatus: "pregnant" });
    const empty = reproFacts(
      pregnant,
      [event("insemination", 60), event("pregnancy_check", 25, { result: "Empty" })],
      reproSettings(),
      NOW,
    );
    expect(empty.expectedCalving).toBeNull();
    const lost = reproFacts(
      pregnant,
      [event("insemination", 120), event("abortion", 10)],
      reproSettings(),
      NOW,
    );
    expect(lost.expectedCalving).toBeNull();
    expect(lost.pregnancyCheckDue).toBeNull();
  });

  test("dry cows, heifers and mares get a due date but no dry-off date", () => {
    const events = [event("insemination", 240), event("dry_off", 18)];
    const dry = reproFacts(
      cow({ lactationStatus: "dry", reproductionStatus: "pregnant" }),
      events,
      reproSettings(),
      NOW,
    );
    expect(dry.dry).toBe(true);
    expect(dry.daysToCalving).toBe(40);
    expect(dry.dryOffDue).toBeNull();
    expect(dry.daysInMilk).toBeNull();

    const heifer = reproFacts(
      cow({ reproductionStatus: "pregnant" }),
      [event("insemination", 240)],
      reproSettings(),
      NOW,
    );
    expect(heifer.daysToCalving).toBe(40);
    expect(heifer.dryOffDue).toBeNull();

    const mare = reproFacts(
      { species: "horse", lactationStatus: null, reproductionStatus: "pregnant" },
      [event("insemination", 300)],
      reproSettings(),
      NOW,
    );
    expect(mare.daysToCalving).toBe(40);
  });

  test("recorded events are enough when the animal carries no status", () => {
    const inMilk = reproFacts(
      cow({}),
      [
        event("calving", 300),
        event("insemination", 215),
        event("pregnancy_check", 180, { result: "Pregnant" }),
      ],
      reproSettings(),
      NOW,
    );
    expect(inMilk.pregnant).toBe(true);
    expect(inMilk.daysToCalving).toBe(65);
    expect(day(inMilk.dryOffDue)).toBe("2026-11-15");

    const driedOff = reproFacts(
      cow({}),
      [event("calving", 330), event("insemination", 250), event("dry_off", 20)],
      reproSettings(),
      NOW,
    );
    expect(driedOff.dry).toBe(true);
    expect(driedOff.dryOffDue).toBeNull();
    expect(driedOff.daysInMilk).toBeNull();
    expect(day(driedOff.pregnancyCheckDue)).toBe("2026-04-09");
  });

  test("the farm's own gestation and dry-off days replace the defaults", () => {
    const facts = reproFacts(
      cow({ lactationStatus: "lactating", reproductionStatus: "pregnant" }),
      [event("insemination", 215)],
      reproSettings({ gestationDays: { cattle: 285 }, dryOffDaysBeforeCalving: 45 }),
      NOW,
    );
    expect(facts.daysToCalving).toBe(70);
    expect(day(facts.dryOffDue)).toBe("2026-12-05");
    expect(reproSettings({ gestationDays: { cattle: 285 } }).gestationDays.horse).toBe(340);
  });
});
