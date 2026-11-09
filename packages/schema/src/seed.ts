// Deterministic demo farm used by `orion --seed`, the UI in browser dev mode and e2e tests.
// 24 cattle (16 dairy, 8 beef), 4 horses, a milking robot, one wearable per tagged animal
// (collar OR bolus OR ear tag sensor), 3 cameras, 1 connector (generic CSV) and 7 days of observations with
// a heat alert, a calving alert and a health event.
import { eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { DeviceKind } from "./enums";
import { createHlc } from "./hlc";
import {
  animals,
  cameras,
  connectors,
  deviceBindings,
  devices,
  farms,
  type NewAnimal,
  type NewDevice,
  type NewDeviceBinding,
  type NewObservation,
  observations,
} from "./sqlite";
import { assertSingleWearable } from "./wearable";

export const DEMO_FARM_ID = "00000000-0000-4000-8000-00000000f001";
export const SEED_ORIGIN = "seed";

export interface SeedOptions {
  farmId?: string;
  /** End of the observation window. Defaults to now. */
  now?: Date;
  /** PRNG seed; same seed gives identical rows. */
  seed?: number;
}

export interface SeedResult {
  farmId: string;
  created: boolean;
  counts: {
    animals: number;
    cattle: number;
    horses: number;
    devices: number;
    bindings: number;
    cameras: number;
    connectors: number;
    observations: number;
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uuidFrom(rand: () => number): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(rand() * 16).toString(16));
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const DAIRY_NAMES = [
  "Bella",
  "Daisy",
  "Rosa",
  "Molly",
  "Luna",
  "Stella",
  "Clover",
  "Maple",
  "Hazel",
  "Ivy",
  "Willow",
  "Poppy",
  "Ruby",
  "Pearl",
  "Dolly",
  "Fern",
];
const BEEF_NAMES = ["Duke", "Ginger", "Tank", "Bramble", "Rusty", "Juno", "Biscuit", "Thistle"];
const HORSES = [
  { name: "Storm", breed: "Warmblood", sex: "castrated" },
  { name: "Saga", breed: "Fjord", sex: "female" },
  { name: "Atlas", breed: "Thoroughbred", sex: "male" },
  { name: "Nova", breed: "Icelandic", sex: "female" },
] as const;

// biome-ignore lint/suspicious/noExplicitAny: works with any bun:sqlite drizzle database
export function seedDemoFarm(db: BunSQLiteDatabase<any>, options: SeedOptions = {}): SeedResult {
  const farmId = options.farmId ?? DEMO_FARM_ID;
  const end = options.now ?? new Date();
  const rand = mulberry32(options.seed ?? 42);
  const id = () => uuidFrom(rand);
  const endMs = Math.floor(end.getTime() / 3_600_000) * 3_600_000;
  const clock = createHlc(SEED_ORIGIN, { now: () => endMs });
  const nowIso = new Date(endMs).toISOString();
  const sync = () => ({
    farmId,
    createdAt: nowIso,
    updatedAt: nowIso,
    hlc: clock.tick(),
    originDevice: SEED_ORIGIN,
  });

  const existing = db.select({ id: farms.id }).from(farms).where(eq(farms.id, farmId)).get();
  if (existing) {
    return {
      farmId,
      created: false,
      counts: {
        animals: 0,
        cattle: 0,
        horses: 0,
        devices: 0,
        bindings: 0,
        cameras: 0,
        connectors: 0,
        observations: 0,
      },
    };
  }

  const animalRows: NewAnimal[] = [];
  DAIRY_NAMES.forEach((name, i) => {
    animalRows.push({
      id: id(),
      species: "cattle",
      name,
      earTagNumber: `DK-${String(1001 + i)}`,
      nationalId: `CATTLE-${String(500100 + i)}`,
      breed: i % 4 === 3 ? "Jersey" : "Holstein",
      sex: "female",
      birthDate: `20${String(18 + (i % 5))}-0${(i % 9) + 1}-1${i % 10}`,
      groupName: i < 10 ? "Milking" : i < 14 ? "Dry" : "Heifers",
      status: "active",
      notes: null,
      ...sync(),
    });
  });
  BEEF_NAMES.forEach((name, i) => {
    animalRows.push({
      id: id(),
      species: "cattle",
      name,
      earTagNumber: `BF-${String(2001 + i)}`,
      nationalId: `CATTLE-${String(600200 + i)}`,
      breed: i % 2 ? "Hereford" : "Angus",
      sex: i === 0 ? "male" : i % 3 === 0 ? "castrated" : "female",
      birthDate: `202${i % 4}-0${(i % 8) + 1}-2${i % 8}`,
      groupName: "Pasture",
      status: "active",
      notes: null,
      ...sync(),
    });
  });
  for (const h of HORSES) {
    animalRows.push({
      id: id(),
      species: "horse",
      name: h.name,
      earTagNumber: null,
      nationalId: `UELN-${h.name.toUpperCase()}`,
      breed: h.breed,
      sex: h.sex,
      birthDate: "2015-05-01",
      groupName: "Stable",
      status: "active",
      notes: null,
      ...sync(),
    });
  }
  const dairy = animalRows.slice(0, 16);
  const beef = animalRows.slice(16, 24);
  const horses = animalRows.slice(24);

  const deviceRows: NewDevice[] = [];
  const mkDevice = (
    kind: DeviceKind,
    vendor: string,
    model: string,
    serial: string,
    battery: number | null,
  ) => {
    const row: NewDevice = {
      id: id(),
      kind,
      vendor,
      model,
      serial,
      connection: null,
      status: "online",
      batteryPct: battery,
      lastSeenAt: nowIso,
      ...sync(),
    };
    deviceRows.push(row);
    return row;
  };
  const robot = mkDevice("milking_robot", "Demo", "Milking robot", "LA5-0001", null);
  // Wearables: collars on milking cows 0-9, boluses on cows 10-15, ear tag sensors on beef 0-5.
  const collars = dairy
    .slice(0, 10)
    .map((_, i) =>
      mkDevice("collar", "Demo", "Neck collar", `COL-${100 + i}`, 60 + Math.round(rand() * 40)),
    );
  const boluses = dairy
    .slice(10)
    .map((_, i) => mkDevice("bolus", "Demo", "Rumen bolus", `BOL-${200 + i}`, null));
  const tags = beef
    .slice(0, 6)
    .map((_, i) =>
      mkDevice(
        "ear_tag_sensor",
        "Demo",
        "Ear tag sensor",
        `EAR-${300 + i}`,
        70 + Math.round(rand() * 30),
      ),
    );
  const spareCollar = mkDevice("collar", "Demo", "Neck collar", "COL-199", 100);
  spareCollar.status = "offline";
  const scale = mkDevice("scale", "Tru-Test", "S3", "SCL-01", null);

  const bindingRows: NewDeviceBinding[] = [];
  const bind = (device: NewDevice, animal: NewAnimal): void => {
    bindingRows.push({
      id: id(),
      deviceId: device.id,
      animalId: animal.id as string,
      wearable: true,
      boundAt: new Date(endMs - 90 * 86_400_000).toISOString(),
      unboundAt: null,
      ...sync(),
    });
  };
  for (const [i, d] of collars.entries()) bind(d, dairy[i] as NewAnimal);
  for (const [i, d] of boluses.entries()) bind(d, dairy[10 + i] as NewAnimal);
  for (const [i, d] of tags.entries()) bind(d, beef[i] as NewAnimal);
  // History: the spare collar was once worn by beef 6 and has been unbound.
  bindingRows.push({
    id: id(),
    deviceId: spareCollar.id,
    animalId: beef[6]?.id as string,
    wearable: true,
    boundAt: new Date(endMs - 200 * 86_400_000).toISOString(),
    unboundAt: new Date(endMs - 30 * 86_400_000).toISOString(),
    ...sync(),
  });

  const cameraRows = [
    {
      name: "Robot entrance",
      location: "Milking parlour",
      ip: "192.168.1.31",
      status: "online" as const,
    },
    { name: "Calving pen", location: "Calving pen", ip: "192.168.1.32", status: "online" as const },
    {
      name: "Stable aisle",
      location: "Horse stable",
      ip: "192.168.1.33",
      status: "offline" as const,
    },
  ].map((c, i) => ({
    id: id(),
    name: c.name,
    location: c.location,
    onvifXaddr: `http://${c.ip}/onvif/device_service`,
    rtspUrl: `rtsp://${c.ip}:554/stream1`,
    credentialRef: `orbit/camera/${i + 1}`,
    status: c.status,
    ...sync(),
  }));

  const connectorRows = [
    {
      vendor: "generic_csv" as const,
      kind: "file_import" as const,
      name: "Herd register CSV",
      config: { path: "imports/herd.csv" },
    },
  ].map((c) => ({
    id: id(),
    ...c,
    enabled: true,
    lastSyncAt: new Date(endMs - 3_600_000).toISOString(),
    lastError: null,
    ...sync(),
  }));

  const obs: NewObservation[] = [];
  const at = (msAgo: number) => new Date(endMs - msAgo).toISOString();
  const push = (o: Omit<NewObservation, "id" | keyof ReturnType<typeof sync>>) =>
    obs.push({ id: id(), ...o, ...sync() });
  const DAY = 86_400_000;
  for (let day = 6; day >= 0; day--) {
    dairy.slice(0, 10).forEach((cow, i) => {
      for (const hour of [5, 13, 21]) {
        push({
          animalId: cow.id,
          deviceId: robot.id,
          kind: "milking",
          ts: at(day * DAY + (24 - hour) * 3_600_000),
          valueNum: Math.round((9 + rand() * 5) * 10) / 10,
          valueJson: { unit: "kg" },
          source: "demo",
        });
      }
      push({
        animalId: cow.id,
        deviceId: collars[i]?.id,
        kind: "rumination",
        ts: at(day * DAY),
        valueNum: Math.round(480 + rand() * 120),
        valueJson: { unit: "min/day" },
        source: "demo",
      });
      push({
        animalId: cow.id,
        deviceId: collars[i]?.id,
        kind: "activity",
        ts: at(day * DAY),
        valueNum: Math.round(300 + rand() * 200),
        valueJson: { unit: "index" },
        source: "demo",
      });
    });
    dairy.slice(10).forEach((cow, i) => {
      for (let h = 0; h < 24; h += 6) {
        const spike = i === 1 && day === 0 && h === 0;
        push({
          animalId: cow.id,
          deviceId: boluses[i]?.id,
          kind: "temperature",
          ts: at(day * DAY + h * 3_600_000),
          valueNum: spike ? 40.4 : Math.round((38.4 + rand() * 0.6) * 10) / 10,
          valueJson: { unit: "C" },
          source: "demo",
        });
      }
    });
    beef.slice(0, 6).forEach((cow, i) => {
      push({
        animalId: cow.id,
        deviceId: tags[i]?.id,
        kind: "activity",
        ts: at(day * DAY),
        valueNum: Math.round(200 + rand() * 250),
        valueJson: { unit: "index" },
        source: "demo",
      });
    });
  }
  horses.forEach((horse) => {
    push({
      animalId: horse.id,
      deviceId: scale.id,
      kind: "weight",
      ts: at(3 * DAY),
      valueNum: Math.round(420 + rand() * 180),
      valueJson: { unit: "kg" },
      source: "manual",
    });
  });
  push({
    animalId: dairy[2]?.id,
    deviceId: collars[2]?.id,
    kind: "heat_alert",
    ts: at(5 * 3_600_000),
    valueNum: null,
    valueJson: {
      severity: "info",
      message: "Activity spike consistent with heat; best insemination window in 6-12 h",
    },
    source: "demo",
  });
  push({
    animalId: dairy[11]?.id,
    deviceId: boluses[1]?.id,
    kind: "health_event",
    ts: at(23 * 3_600_000),
    valueNum: 40.4,
    valueJson: { severity: "warning", message: "Body temperature 40.4 C" },
    source: "demo",
  });
  push({
    animalId: dairy[12]?.id,
    deviceId: null,
    kind: "calving_alert",
    ts: at(2 * 3_600_000),
    valueNum: null,
    valueJson: {
      severity: "urgent",
      message: "Restless behaviour and tail raising in calving pen",
      cameraId: cameraRows[1]?.id,
    },
    source: `camera:${cameraRows[1]?.id}`,
  });

  db.transaction((tx) => {
    tx.insert(farms)
      .values({ id: farmId, name: "Demo Farm", timezone: "UTC", ...sync(), farmId })
      .run();
    tx.insert(animals).values(animalRows).run();
    tx.insert(devices).values(deviceRows).run();
    for (const b of bindingRows) {
      if (!b.unboundAt) assertSingleWearable(tx, b);
      tx.insert(deviceBindings).values(b).run();
    }
    tx.insert(cameras).values(cameraRows).run();
    tx.insert(connectors).values(connectorRows).run();
    for (let i = 0; i < obs.length; i += 200)
      tx.insert(observations)
        .values(obs.slice(i, i + 200))
        .run();
  });

  return {
    farmId,
    created: true,
    counts: {
      animals: animalRows.length,
      cattle: dairy.length + beef.length,
      horses: horses.length,
      devices: deviceRows.length,
      bindings: bindingRows.length,
      cameras: cameraRows.length,
      connectors: connectorRows.length,
      observations: obs.length,
    },
  };
}
