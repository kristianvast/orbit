import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import {
  ADE_EVENT_KINDS,
  type AdeEventKind,
  AdeMappingError,
  adeAnimalIdentifier,
  adeToAnimal,
  adeToObservation,
  animalToAde,
  ORBIT_ANIMAL_SCHEME,
  observationToAde,
} from "../src/ade";
import type { Animal, Observation } from "../src/sqlite";

const VENDOR = join(import.meta.dir, "..", "vendor", "icar-ade-1.5.1");
const BASE = "https://adewg.github.io/ICAR/v1.5.1/";
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
// ADE uses the non-standard format "integer" on number properties (e.g. deviceHeatProbability).
ajv.addFormat("integer", { type: "number", validate: Number.isInteger });
for (const glob of ["resources/*.json", "types/*.json", "enums/*.json"])
  for (const rel of new Bun.Glob(glob).scanSync(VENDOR))
    ajv.addSchema({ ...JSON.parse(readFileSync(join(VENDOR, rel), "utf8")), $id: BASE + rel });

const validators = new Map<string, ValidateFunction>();
function expectValid(resourceType: string, doc: unknown) {
  let v = validators.get(resourceType);
  if (!v) {
    v = ajv.getSchema(`${BASE}resources/${resourceType}.json`) as ValidateFunction;
    validators.set(resourceType, v);
  }
  const ok = v(doc);
  expect(ok ? [] : v.errors).toEqual([]);
}

const FARM = "7f1c2a9e-0000-4000-8000-000000000001";
const sync = {
  farmId: FARM,
  createdAt: "2026-01-02T03:04:05.000Z",
  updatedAt: "2026-02-03T04:05:06.000Z",
  deletedAt: null,
  hlc: "0000000000001:0000:dev",
  originDevice: "dev",
};

const cow: Animal = {
  id: "7f1c2a9e-0000-4000-8000-0000000000a1",
  species: "cattle",
  name: "Dagros",
  earTagNumber: "1042",
  nationalId: "NL123456789",
  identifierScheme: "nl.naktuinbouw",
  alternativeIdentifiers: [{ id: "982000123456789", scheme: "iso.11784" }],
  breed: "Holstein",
  sex: "female",
  birthDate: "2021-04-12",
  groupName: "Lactating",
  status: "active",
  reproductionStatus: "pregnant",
  lactationStatus: "lactating",
  notes: null,
  ...sync,
};

const horse: Animal = {
  ...cow,
  id: "7f1c2a9e-0000-4000-8000-0000000000b2",
  species: "horse",
  name: null,
  earTagNumber: null,
  nationalId: null,
  identifierScheme: null,
  alternativeIdentifiers: null,
  breed: null,
  sex: "castrated",
  birthDate: null,
  status: "sold",
  reproductionStatus: null,
  lactationStatus: null,
};

const obs = (
  kind: Observation["kind"],
  valueNum: number | null,
  valueJson: object,
): Observation => ({
  id: `obs-${kind}`,
  animalId: cow.id,
  deviceId: null,
  kind,
  ts: "2026-03-04T05:06:07.000Z",
  valueNum,
  valueJson: valueJson as Observation["valueJson"],
  source: "manual",
  ...sync,
});

const EVENT_SAMPLES: Record<AdeEventKind, Observation> = {
  milking: obs("milking", 12.4, { unit: "kg", milkingType: "Automated", milkingBoxNumber: "2" }),
  weight: obs("weight", 612, { unit: "kg" }),
  heat_alert: obs("heat_alert", null, {
    message: "Activity spike",
    heatDetectionMethod: "Collar",
    certainty: "Suspect",
  }),
  health_event: obs("health_event", 40.4, {
    message: "Body temperature 40.4 C",
    diagnoses: [{ name: "Fever", severity: "Moderate" }],
  }),
  insemination: obs("insemination", null, {
    inseminationType: "Insemination",
    sireIdentifiers: [{ id: "NL987654321", scheme: "nl.naktuinbouw" }],
  }),
  pregnancy_check: obs("pregnancy_check", null, { method: "Echography", result: "Pregnant" }),
  calving: obs("calving", null, { calvingEase: "EasyUnassisted", liveProgeny: 1 }),
  abortion: obs("abortion", null, {}),
  dry_off: obs("dry_off", null, {}),
  treatment: obs("treatment", null, {
    procedure: "Intramammary",
    dose: { doseQuantity: 10, doseUnits: "MLT" },
  }),
  arrival: obs("arrival", null, { arrivalReason: "Purchase" }),
  departure: obs("departure", null, { departureKind: "Sale", departureReason: "Superfluous" }),
  birth: obs("birth", null, {}),
  death: obs("death", null, { deathReason: "Accident" }),
};

describe("animals", () => {
  test("animalToAde output validates against icarAnimalCoreResource", () => {
    expectValid("icarAnimalCoreResource", animalToAde(cow));
    expectValid("icarAnimalCoreResource", animalToAde(horse));
  });

  test("the validator rejects a resource without an identifier", () => {
    const { identifier: _, ...broken } = animalToAde(cow);
    const v = ajv.getSchema(`${BASE}resources/icarAnimalCoreResource.json`) as ValidateFunction;
    expect(v(broken)).toBe(false);
  });

  test("official id is primary; Orbit id rides along as an alternative identifier", () => {
    const ade = animalToAde(cow);
    expect(ade.identifier).toEqual({ id: "NL123456789", scheme: "nl.naktuinbouw" });
    expect(ade.alternativeIdentifiers).toContainEqual({ id: cow.id, scheme: ORBIT_ANIMAL_SCHEME });
    expect(animalToAde(horse).identifier).toEqual({ id: horse.id, scheme: ORBIT_ANIMAL_SCHEME });
  });

  test.each([cow, horse])("round trip preserves mapped columns (%#)", (animal) => {
    expect(adeToAnimal(animalToAde(animal))).toEqual({
      id: animal.id,
      species: animal.species,
      sex: animal.sex,
      status: animal.status,
      nationalId: animal.nationalId,
      identifierScheme: animal.identifierScheme,
      alternativeIdentifiers: animal.alternativeIdentifiers,
      earTagNumber: animal.earTagNumber,
      name: animal.name,
      breed: animal.breed,
      birthDate: animal.birthDate,
      reproductionStatus: animal.reproductionStatus,
      lactationStatus: animal.lactationStatus,
    });
  });

  const valid = animalToAde(cow);
  test.each([
    ["missing identifier", { ...valid, identifier: undefined }, "missing_field", "$.identifier"],
    ["unsupported specie", { ...valid, specie: "Pig" }, "unsupported_value", "$.specie"],
    ["bad birthDate", { ...valid, birthDate: "12/04/2021" }, "invalid_value", "$.birthDate"],
    ["unknown gender", { ...valid, gender: "Mare" }, "unsupported_value", "$.gender"],
    [
      "wrong resourceType",
      { ...valid, resourceType: "icarDeviceResource" },
      "unknown_resource_type",
      "$.resourceType",
    ],
    ["not an object", "cow", "invalid_value", "$"],
  ] as const)("adeToAnimal rejects %s", (_, input, code, path) => {
    expect(() => adeToAnimal(input)).toThrow(AdeMappingError);
    try {
      adeToAnimal(input);
    } catch (e) {
      expect((e as AdeMappingError).code).toBe(code);
      expect((e as AdeMappingError).path).toBe(path);
    }
  });
});

describe("events", () => {
  const animal = adeAnimalIdentifier(cow);

  test.each(Object.keys(ADE_EVENT_KINDS) as AdeEventKind[])(
    "%s exports a valid ADE event and round-trips",
    (kind) => {
      const sample = EVENT_SAMPLES[kind];
      const ade = observationToAde(sample, animal);
      expect(ade?.resourceType).toBe(ADE_EVENT_KINDS[kind].resourceType);
      expectValid(ADE_EVENT_KINDS[kind].resourceType, ade);
      const back = adeToObservation(ade);
      expect(back).toEqual({
        kind,
        ts: sample.ts,
        valueNum: sample.valueNum !== null && kind !== "health_event" ? sample.valueNum : null,
        valueJson: sample.valueJson ?? {},
        animal,
        sourceId: sample.id,
      });
    },
  );

  test.each(["activity", "rumination", "temperature", "calving_alert"] as const)(
    "%s has no ADE event",
    (kind) => {
      expect(observationToAde(obs(kind, 1, {}), animal)).toBeNull();
    },
  );

  test("insemination without inseminationType cannot be exported", () => {
    expect(() => observationToAde(obs("insemination", null, {}), animal)).toThrow(AdeMappingError);
  });

  test("milk weight in pounds is converted to kilograms", () => {
    const ade = observationToAde(EVENT_SAMPLES.milking, animal) as Record<string, unknown>;
    const back = adeToObservation({ ...ade, milkingMilkWeight: { unitCode: "LBR", value: 10 } });
    expect(back.valueNum).toBeCloseTo(4.5359237, 6);
  });

  const weight = observationToAde(EVENT_SAMPLES.weight, animal) as Record<string, unknown>;
  test.each([
    [
      "unknown resourceType",
      { ...weight, resourceType: "icarFeedReportResource" },
      "unknown_resource_type",
    ],
    ["bad eventDateTime", { ...weight, eventDateTime: "yesterday" }, "invalid_value"],
    ["missing animal", { ...weight, animal: undefined }, "missing_field"],
    [
      "unsupported unit",
      { ...weight, weight: { measurement: 1, units: "ONZ" } },
      "unsupported_value",
    ],
  ] as const)("adeToObservation rejects %s", (_, input, code) => {
    try {
      adeToObservation(input);
      throw new Error("expected AdeMappingError");
    } catch (e) {
      expect(e).toBeInstanceOf(AdeMappingError);
      expect((e as AdeMappingError).code).toBe(code);
    }
  });
});
