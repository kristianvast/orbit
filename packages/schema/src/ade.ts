// ICAR Animal Data Exchange (ADE) v1.5.1 mapping: Orbit rows <-> ADE JSON resources.
// Spec: https://github.com/adewg/ICAR (Apache-2.0). The official JSON schemas this module targets
// are vendored under vendor/icar-ade-1.5.1 and used by test/ade.test.ts to validate the output.
// Pure functions, browser-safe. Import functions validate the fields they map and throw
// AdeMappingError before returning anything, so callers never get a partial row.
//
// Observation convention: for ADE event kinds, observations.value_json stores the ADE event's own
// properties under their ADE names (e.g. { inseminationType: "Insemination", sireIdentifiers: [...] }),
// plus optional Orbit keys (unit, message, severity). value_num holds the scalar where ADE has one
// (milk weight, live weight) in kilograms.
import type {
  AnimalLactationStatus,
  AnimalReproductionStatus,
  AnimalSex,
  AnimalStatus,
  ObservationKind,
  Species,
} from "./enums";
import type { Animal, Observation } from "./sqlite";

export const ADE_VERSION = "1.5.1";
/** meta.source for resources produced by Orbit. */
export const ADE_SOURCE = "orbit";
/** Scheme of Orbit's own animal UUIDs, used when no official identifier is known. */
export const ORBIT_ANIMAL_SCHEME = "orbit.animal";
/** Scheme for a national id stored without an issuing scheme. */
export const ORBIT_UNSCHEMED_ID_SCHEME = "orbit.national-id";
/** Scheme of Orbit farm ids used as the ADE location. */
export const ORBIT_LOCATION_SCHEME = "orbit.farm";
/** Breeds are free text in Orbit, so they are exported under an Orbit scheme. */
export const ORBIT_BREED_SCHEME = "orbit.breed";

export type AdeIdentifier = { id: string; scheme: string };

export type AdeMeta = {
  source: string;
  sourceId?: string;
  isDeleted?: boolean;
  modified: string;
  created?: string | null;
};

export type AdeAnimalCoreResource = {
  resourceType: "icarAnimalCoreResource";
  meta: AdeMeta;
  location: AdeIdentifier;
  identifier: AdeIdentifier;
  alternativeIdentifiers?: AdeIdentifier[];
  specie: "Cattle" | "Horse";
  gender: string;
  birthDate?: string;
  primaryBreed?: AdeIdentifier;
  managementTag?: string;
  name?: string;
  status: string;
  reproductionStatus?: string;
  lactationStatus?: string;
};

export type AdeEventResource = {
  resourceType: AdeEventResourceType;
  id: string;
  meta: AdeMeta;
  location: AdeIdentifier;
  animal: AdeIdentifier;
  eventDateTime: string;
  remark?: string;
  [property: string]: unknown;
};

export type AdeMappingErrorCode =
  | "missing_field"
  | "invalid_value"
  | "unsupported_value"
  | "unknown_resource_type";

export class AdeMappingError extends Error {
  override readonly name = "AdeMappingError";
  constructor(
    readonly code: AdeMappingErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
  }
}

// ---------------------------------------------------------------- enum maps

const SPECIES_TO_ADE = { cattle: "Cattle", horse: "Horse" } as const satisfies Record<
  Species,
  string
>;
const SEX_TO_ADE = {
  female: "Female",
  male: "Male",
  castrated: "MaleNeuter",
  unknown: "Unknown",
} as const satisfies Record<AnimalSex, string>;
/** ADE genders are finer-grained than Orbit's; import folds them onto the nearest Orbit sex. */
const ADE_TO_SEX: Record<string, AnimalSex> = {
  Female: "female",
  FemaleNeuter: "female",
  Freemartin: "female",
  Male: "male",
  MaleCryptorchid: "male",
  MaleNeuter: "castrated",
  Unknown: "unknown",
};
const STATUS_TO_ADE = { active: "Alive", sold: "OffFarm", dead: "Dead" } as const satisfies Record<
  AnimalStatus,
  string
>;
const ADE_TO_STATUS: Record<string, AnimalStatus> = {
  Alive: "active",
  OffFarm: "sold",
  Dead: "dead",
  Unknown: "active",
};
const REPRODUCTION_TO_ADE = {
  open: "Open",
  inseminated: "Inseminated",
  pregnant: "Pregnant",
  not_pregnant: "NotPregnant",
  birthed: "Birthed",
  do_not_breed: "DoNotBreed",
  pregnant_multiple_foetus: "PregnantMultipleFoetus",
} as const satisfies Record<AnimalReproductionStatus, string>;
const LACTATION_TO_ADE = {
  dry: "Dry",
  lead: "Lead",
  fresh: "Fresh",
  early: "Early",
  lactating: "Lactating",
} as const satisfies Record<AnimalLactationStatus, string>;

const invert = <K extends string, V extends string>(m: Record<K, V>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k])) as Record<string, K>;
const ADE_TO_SPECIES = invert(SPECIES_TO_ADE);
const ADE_TO_REPRODUCTION = invert(REPRODUCTION_TO_ADE);
const ADE_TO_LACTATION = invert(LACTATION_TO_ADE);

// ---------------------------------------------------------------- event kinds

/**
 * ADE event resource per Orbit observation kind, with the ADE properties copied between
 * value_json and the resource. Kinds absent here (activity, rumination, temperature,
 * calving_alert) are sensor aggregates or Orbit-only alerts with no ADE animal event.
 */
export const ADE_EVENT_KINDS = {
  milking: {
    resourceType: "icarMilkingVisitEventResource",
    fields: [
      "milkingDuration",
      "milkingVisitDuration",
      "milkingType",
      "milkingComplete",
      "milkingParlourUnit",
      "milkingBoxNumber",
      "milkingDeviceId",
      "measureDeviceId",
      "quarterMilkings",
      "milkCharacteristics",
      "milkingRemarks",
    ],
  },
  weight: { resourceType: "icarWeightEventResource", fields: ["timeOffFeed"] },
  heat_alert: {
    resourceType: "icarReproHeatEventResource",
    fields: [
      "heatDetectionMethod",
      "certainty",
      "commencementDateTime",
      "expirationDateTime",
      "optimumInseminationWindow",
      "deviceHeatProbability",
    ],
  },
  health_event: { resourceType: "icarDiagnosisEventResource", fields: ["diagnoses"] },
  insemination: {
    resourceType: "icarReproInseminationEventResource",
    fields: [
      "rank",
      "inseminationType",
      "sireIdentifiers",
      "sireOfficialName",
      "sireURI",
      "straw",
      "eventEndDateTime",
      "semenFromFarmStocks",
      "farmContainer",
      "embryo",
      "doItYourself",
    ],
  },
  pregnancy_check: {
    resourceType: "icarReproPregnancyCheckEventResource",
    fields: [
      "method",
      "result",
      "foetalAge",
      "foetusCount",
      "foetusCountMale",
      "foetusCountFemale",
      "exceptions",
    ],
  },
  calving: {
    resourceType: "icarReproParturitionEventResource",
    fields: [
      "isEmbryoImplant",
      "damParity",
      "liveProgeny",
      "totalProgeny",
      "calvingEase",
      "progenyDetails",
      "progeny",
    ],
  },
  abortion: { resourceType: "icarReproAbortionEventResource", fields: [] },
  dry_off: { resourceType: "icarMilkingDryOffEventResource", fields: [] },
  treatment: {
    resourceType: "icarTreatmentEventResource",
    fields: [
      "medicine",
      "procedure",
      "batches",
      "withdrawals",
      "dose",
      "site",
      "positions",
      "comment",
    ],
  },
  arrival: {
    resourceType: "icarMovementArrivalEventResource",
    fields: ["arrivalReason", "animalState", "consignment"],
  },
  departure: {
    resourceType: "icarMovementDepartureEventResource",
    fields: ["departureKind", "departureReason", "consignment", "extendedReasons"],
  },
  birth: { resourceType: "icarMovementBirthEventResource", fields: ["registrationReason"] },
  death: {
    resourceType: "icarMovementDeathEventResource",
    fields: [
      "deathReason",
      "explanation",
      "disposalMethod",
      "disposalOperator",
      "disposalReference",
      "consignment",
      "deathMethod",
      "extendedReasons",
    ],
  },
} as const satisfies Partial<
  Record<ObservationKind, { resourceType: string; fields: readonly string[] }>
>;

export type AdeEventKind = keyof typeof ADE_EVENT_KINDS;
export type AdeEventResourceType = (typeof ADE_EVENT_KINDS)[AdeEventKind]["resourceType"];

const KIND_BY_RESOURCE = Object.fromEntries(
  Object.entries(ADE_EVENT_KINDS).map(([kind, v]) => [v.resourceType, kind]),
) as Record<string, AdeEventKind>;

export function isAdeEventKind(kind: string): kind is AdeEventKind {
  return Object.hasOwn(ADE_EVENT_KINDS, kind);
}

// ---------------------------------------------------------------- helpers

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function dateTime(v: unknown, path: string): string {
  if (v === undefined || v === null) throw new AdeMappingError("missing_field", path, "required");
  if (typeof v !== "string" || !RFC3339.test(v) || Number.isNaN(Date.parse(v)))
    throw new AdeMappingError("invalid_value", path, `not an RFC3339 date-time: ${String(v)}`);
  return v;
}

function identifier(v: unknown, path: string): AdeIdentifier {
  if (v === undefined || v === null) throw new AdeMappingError("missing_field", path, "required");
  if (
    !isRecord(v) ||
    typeof v.id !== "string" ||
    !v.id ||
    typeof v.scheme !== "string" ||
    !v.scheme
  )
    throw new AdeMappingError("invalid_value", path, "expected { id, scheme } strings");
  return { id: v.id, scheme: v.scheme };
}

function lookup<T>(map: Record<string, T>, v: unknown, path: string): T {
  if (v === undefined || v === null) throw new AdeMappingError("missing_field", path, "required");
  if (typeof v !== "string" || !Object.hasOwn(map, v))
    throw new AdeMappingError("unsupported_value", path, `unsupported value: ${String(v)}`);
  return map[v] as T;
}

function optionalLookup<T>(map: Record<string, T>, v: unknown, path: string): T | null {
  return v === undefined || v === null ? null : lookup(map, v, path);
}

function optionalString(v: unknown, path: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new AdeMappingError("invalid_value", path, "expected a string");
  return v;
}

type SyncedRow = {
  id: string;
  farmId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

function meta(row: SyncedRow): AdeMeta {
  return {
    source: ADE_SOURCE,
    sourceId: row.id,
    isDeleted: row.deletedAt !== null,
    modified: row.updatedAt,
    created: row.createdAt,
  };
}

const location = (farmId: string): AdeIdentifier => ({ id: farmId, scheme: ORBIT_LOCATION_SCHEME });

// ---------------------------------------------------------------- animals

/** The ADE identifier other resources use to reference this animal. */
export function adeAnimalIdentifier(
  animal: Pick<Animal, "id" | "nationalId" | "identifierScheme">,
): AdeIdentifier {
  return animal.nationalId && animal.identifierScheme
    ? { id: animal.nationalId, scheme: animal.identifierScheme }
    : { id: animal.id, scheme: ORBIT_ANIMAL_SCHEME };
}

export function animalToAde(animal: Animal): AdeAnimalCoreResource {
  const primary = adeAnimalIdentifier(animal);
  const alternatives: AdeIdentifier[] = [];
  if (primary.scheme !== ORBIT_ANIMAL_SCHEME)
    alternatives.push({ id: animal.id, scheme: ORBIT_ANIMAL_SCHEME });
  else if (animal.nationalId)
    alternatives.push({ id: animal.nationalId, scheme: ORBIT_UNSCHEMED_ID_SCHEME });
  alternatives.push(...(animal.alternativeIdentifiers ?? []));

  const out: AdeAnimalCoreResource = {
    resourceType: "icarAnimalCoreResource",
    meta: meta(animal),
    location: location(animal.farmId),
    identifier: primary,
    specie: SPECIES_TO_ADE[animal.species],
    gender: SEX_TO_ADE[animal.sex],
    status: STATUS_TO_ADE[animal.status],
  };
  if (alternatives.length) out.alternativeIdentifiers = alternatives;
  if (animal.birthDate) out.birthDate = `${animal.birthDate}T00:00:00Z`;
  if (animal.breed) out.primaryBreed = { id: animal.breed, scheme: ORBIT_BREED_SCHEME };
  if (animal.earTagNumber) out.managementTag = animal.earTagNumber;
  if (animal.name) out.name = animal.name;
  if (animal.reproductionStatus)
    out.reproductionStatus = REPRODUCTION_TO_ADE[animal.reproductionStatus];
  if (animal.lactationStatus) out.lactationStatus = LACTATION_TO_ADE[animal.lactationStatus];
  return out;
}

/** Animal columns an ADE animal resource maps onto. `id` is set only for Orbit-issued identifiers. */
export type AdeAnimalFields = {
  id?: string;
  species: Species;
  sex: AnimalSex;
  status: AnimalStatus;
  nationalId: string | null;
  identifierScheme: string | null;
  alternativeIdentifiers: AdeIdentifier[] | null;
  earTagNumber: string | null;
  name: string | null;
  breed: string | null;
  birthDate: string | null;
  reproductionStatus: AnimalReproductionStatus | null;
  lactationStatus: AnimalLactationStatus | null;
};

/** Map an ADE icarAnimalCoreResource onto Orbit animal columns. Throws AdeMappingError. */
export function adeToAnimal(resource: unknown): AdeAnimalFields {
  if (!isRecord(resource)) throw new AdeMappingError("invalid_value", "$", "expected an object");
  if (resource.resourceType !== undefined && resource.resourceType !== "icarAnimalCoreResource")
    throw new AdeMappingError(
      "unknown_resource_type",
      "$.resourceType",
      `expected icarAnimalCoreResource, got ${String(resource.resourceType)}`,
    );
  const primary = identifier(resource.identifier, "$.identifier");
  const rawAlternatives = resource.alternativeIdentifiers ?? [];
  if (!Array.isArray(rawAlternatives))
    throw new AdeMappingError("invalid_value", "$.alternativeIdentifiers", "expected an array");
  const all = [
    primary,
    ...rawAlternatives.map((a, i) => identifier(a, `$.alternativeIdentifiers[${i}]`)),
  ];

  const orbitId = all.find((x) => x.scheme === ORBIT_ANIMAL_SCHEME)?.id;
  const official =
    primary.scheme !== ORBIT_ANIMAL_SCHEME
      ? primary
      : all.find((x) => x.scheme === ORBIT_UNSCHEMED_ID_SCHEME);
  const rest = all.filter(
    (x) => x !== primary && x !== official && x.scheme !== ORBIT_ANIMAL_SCHEME,
  );

  let breed: string | null = null;
  if (resource.primaryBreed !== undefined)
    breed = identifier(resource.primaryBreed, "$.primaryBreed").id;
  const birth =
    resource.birthDate === undefined || resource.birthDate === null
      ? null
      : new Date(dateTime(resource.birthDate, "$.birthDate")).toISOString().slice(0, 10);

  const out: AdeAnimalFields = {
    species: lookup(ADE_TO_SPECIES, resource.specie, "$.specie"),
    sex: lookup(ADE_TO_SEX, resource.gender, "$.gender"),
    status: optionalLookup(ADE_TO_STATUS, resource.status, "$.status") ?? "active",
    nationalId: official?.id ?? null,
    identifierScheme:
      official && official.scheme !== ORBIT_UNSCHEMED_ID_SCHEME ? official.scheme : null,
    alternativeIdentifiers: rest.length ? rest : null,
    earTagNumber: optionalString(resource.managementTag, "$.managementTag"),
    name: optionalString(resource.name, "$.name"),
    breed,
    birthDate: birth,
    reproductionStatus: optionalLookup(
      ADE_TO_REPRODUCTION,
      resource.reproductionStatus,
      "$.reproductionStatus",
    ),
    lactationStatus: optionalLookup(
      ADE_TO_LACTATION,
      resource.lactationStatus,
      "$.lactationStatus",
    ),
  };
  if (orbitId) out.id = orbitId;
  return out;
}

// ---------------------------------------------------------------- observations

/**
 * Map an observation onto its ADE event resource, or null when the kind has no ADE event.
 * `animal` is the ADE identifier of the observed animal (see adeAnimalIdentifier).
 */
export function observationToAde(obs: Observation, animal: AdeIdentifier): AdeEventResource | null {
  if (!isAdeEventKind(obs.kind)) return null;
  const spec = ADE_EVENT_KINDS[obs.kind];
  const value = obs.valueJson ?? {};
  const out: AdeEventResource = {
    resourceType: spec.resourceType,
    id: obs.id,
    meta: meta(obs),
    location: location(obs.farmId),
    animal,
    eventDateTime: obs.ts,
  };
  if (typeof value.message === "string") out.remark = value.message;
  for (const f of spec.fields) if (value[f] !== undefined) out[f] = value[f];

  if (obs.kind === "milking" || obs.kind === "weight") {
    if (obs.valueNum === null)
      throw new AdeMappingError("missing_field", `observations[${obs.id}].value_num`, "required");
    if (obs.kind === "milking") {
      out.milkingStartingDateTime = obs.ts;
      out.milkingMilkWeight = { unitCode: "KGM", value: obs.valueNum };
    } else {
      out.weight = { measurement: obs.valueNum, units: "KGM" };
    }
  }
  if (obs.kind === "insemination" && out.inseminationType === undefined)
    throw new AdeMappingError(
      "missing_field",
      `observations[${obs.id}].value_json.inseminationType`,
      "required by icarReproInseminationEventResource",
    );
  return out;
}

/** Observation columns an ADE event maps onto, plus the referenced animal identifier. */
export type AdeObservationFields = {
  kind: AdeEventKind;
  ts: string;
  valueNum: number | null;
  valueJson: Record<string, unknown>;
  animal: AdeIdentifier;
  /** The event id in the source system, when given. */
  sourceId: string | null;
};

const KG_PER_UNIT: Record<string, number> = { KGM: 1, GRM: 0.001, LBR: 0.45359237, TNE: 1000 };

function kilograms(v: unknown, unitKey: string, valueKey: string, path: string): number {
  if (!isRecord(v)) throw new AdeMappingError("missing_field", path, "required");
  const value = v[valueKey];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new AdeMappingError("invalid_value", `${path}.${valueKey}`, "expected a number");
  const factor = KG_PER_UNIT[String(v[unitKey] ?? "KGM")];
  if (factor === undefined)
    throw new AdeMappingError(
      "unsupported_value",
      `${path}.${unitKey}`,
      `unsupported unit: ${String(v[unitKey])}`,
    );
  return value * factor;
}

/** Map an ADE animal event resource onto Orbit observation columns. Throws AdeMappingError. */
export function adeToObservation(resource: unknown): AdeObservationFields {
  if (!isRecord(resource)) throw new AdeMappingError("invalid_value", "$", "expected an object");
  const rt = resource.resourceType;
  if (typeof rt !== "string" || !Object.hasOwn(KIND_BY_RESOURCE, rt))
    throw new AdeMappingError(
      "unknown_resource_type",
      "$.resourceType",
      `unsupported ADE resource type: ${String(rt)}`,
    );
  const kind = KIND_BY_RESOURCE[rt] as AdeEventKind;
  const animal = identifier(resource.animal, "$.animal");
  const ts =
    kind === "milking" && resource.eventDateTime === undefined
      ? dateTime(resource.milkingStartingDateTime, "$.milkingStartingDateTime")
      : dateTime(resource.eventDateTime, "$.eventDateTime");

  const valueJson: Record<string, unknown> = {};
  for (const f of ADE_EVENT_KINDS[kind].fields)
    if (resource[f] !== undefined) valueJson[f] = resource[f];
  if (typeof resource.remark === "string") valueJson.message = resource.remark;

  let valueNum: number | null = null;
  if (kind === "milking") {
    valueNum = kilograms(resource.milkingMilkWeight, "unitCode", "value", "$.milkingMilkWeight");
    valueJson.unit = "kg";
  } else if (kind === "weight") {
    valueNum = kilograms(resource.weight, "units", "measurement", "$.weight");
    valueJson.unit = "kg";
  } else if (kind === "insemination" && typeof resource.inseminationType !== "string") {
    throw new AdeMappingError("missing_field", "$.inseminationType", "required");
  }

  const sourceId = isRecord(resource.meta) ? resource.meta.sourceId : undefined;
  return {
    kind,
    ts,
    valueNum,
    valueJson,
    animal,
    sourceId:
      typeof sourceId === "string"
        ? sourceId
        : typeof resource.id === "string"
          ? resource.id
          : null,
  };
}
