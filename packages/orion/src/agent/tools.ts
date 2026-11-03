import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AnimalListItem } from "@orbit/protocol";
import {
  ANIMAL_SEX,
  ANIMAL_STATUS,
  DEVICE_KINDS,
  OBSERVATION_KINDS,
  SPECIES,
} from "@orbit/schema/enums";
import { type Static, type TSchema, Type } from "typebox";
import { RepoError, type WearableViolation } from "../db/repo";
import type { FarmService } from "../services/farm";

const Opt = <T extends TSchema>(schema: T) => Type.Optional(schema);
const OptStr = (description: string) => Type.Optional(Type.String({ description }));

function text(content: string, details: unknown = {}, isError = false): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: content }], details, ...(isError ? { isError } : {}) };
}

function describeAnimal(a: AnimalListItem): string {
  const who = [a.name, a.earTagNumber ? `tag ${a.earTagNumber}` : null].filter(Boolean).join(", ");
  const what = [
    a.breed,
    a.species === "horse" ? "horse" : "cattle",
    a.groupName ? `group ${a.groupName}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const wear = a.wearable ? `wears ${a.wearable.kind.replaceAll("_", " ")}` : "no wearable";
  return `- ${who || a.id} (${what}; ${a.status}; ${wear}) id=${a.id}`;
}

function wearableExplanation(v: WearableViolation): string {
  const kind = (k: string) => k.replaceAll("_", " ");
  return (
    `Not done: ${v.animalName ?? "this animal"} already wears a ${kind(v.existingKind)} (device ${v.existingDeviceId}). ` +
    `An animal wears a collar OR a bolus OR an ear tag sensor, never more than one at a time. ` +
    `To switch to the ${kind(v.requestedKind)}, first take the ${kind(v.existingKind)} off (device_bind with action "unbind" for device ${v.existingDeviceId}), then bind the new one.`
  );
}

type Def<P extends TSchema> = Omit<ToolDefinition<P>, "execute"> & {
  run(
    params: Static<P>,
    origin: { sessionId: string; toolCallId: string },
    signal: AbortSignal | undefined,
  ): Promise<AgentToolResult<unknown>> | AgentToolResult<unknown>;
};

function tool<P extends TSchema>(def: Def<P>): ToolDefinition {
  const { run, ...rest } = def;
  return {
    ...rest,
    async execute(toolCallId, params, signal, _onUpdate, ctx: ExtensionToolContext) {
      const origin = { sessionId: ctx.sessionManager.getSessionId(), toolCallId };
      try {
        return await run(params as Static<P>, origin, signal);
      } catch (error) {
        if (error instanceof RepoError) {
          return text(
            `Not done: ${error.message}`,
            { code: error.code, details: error.details },
            true,
          );
        }
        throw error;
      }
    },
  } as ToolDefinition;
}

const AnimalParams = Type.Object({
  id: OptStr("Existing animal id to update; omit to add a new animal"),
  species: Type.Enum([...SPECIES]),
  name: OptStr("Name"),
  earTagNumber: OptStr("Visual ear tag number"),
  nationalId: OptStr("Official/national id"),
  breed: OptStr("Breed"),
  sex: Opt(Type.Enum([...ANIMAL_SEX])),
  birthDate: OptStr("YYYY-MM-DD"),
  groupName: OptStr("Group or pen, e.g. Milking, Dry, Heifers"),
  status: Opt(Type.Enum([...ANIMAL_STATUS])),
  notes: OptStr("Free-text notes"),
});

export function createFarmTools(farm: FarmService): ToolDefinition[] {
  const repo = farm.repo;
  return [
    tool({
      name: "herd_query",
      label: "Look up the herd",
      description:
        "List or search animals (cattle and horses) with their active wearable sensor. Pass id to get one animal with its bindings and recent observations.",
      parameters: Type.Object({
        id: OptStr("Animal id, ear tag or name for a single animal"),
        species: Opt(Type.Enum([...SPECIES])),
        status: Opt(Type.Enum([...ANIMAL_STATUS])),
        groupName: OptStr("Group name"),
        search: OptStr("Matches name, ear tag or national id"),
        limit: Opt(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
      run(p) {
        if (p.id) {
          const animal = repo.findAnimal(p.id);
          if (!animal) return text(`No animal matches "${p.id}".`, { found: false });
          const detail = repo.getAnimal(animal.id);
          const obs = detail.recentObservations
            .slice(0, 10)
            .map((o) => `  - ${o.ts} ${o.kind}${o.valueNum !== null ? ` ${o.valueNum}` : ""}`);
          return text(
            [
              describeAnimal({ ...detail.animal, wearable: detail.wearable }),
              "Recent observations:",
              ...obs,
            ].join("\n"),
            detail,
          );
        }
        const { rows, total } = repo.listAnimals({
          species: p.species,
          status: p.status ?? "active",
          groupName: p.groupName,
          search: p.search,
          limit: p.limit ?? 50,
        });
        const header = `${total} animal${total === 1 ? "" : "s"} found${rows.length < total ? ` (showing ${rows.length})` : ""}.`;
        return text([header, ...rows.map(describeAnimal)].join("\n"), { total, rows });
      },
    }),
    tool({
      name: "herd_upsert_animal",
      label: "Update herd records",
      description: "Add a new animal or update an existing one (pass id to update).",
      parameters: AnimalParams,
      run(p, origin) {
        const result = repo.upsertAnimal(p, origin);
        return text(
          `${p.id ? "Updated" : "Added"} ${p.name ?? p.earTagNumber ?? "the animal"} (id ${result.ids[0]}). The farmer can undo this.`,
          result,
        );
      },
    }),
    tool({
      name: "devices_list",
      label: "List devices",
      description:
        "List devices (collars, boluses, ear tag sensors, milking robots, cameras, scales...) and which animal each is on.",
      parameters: Type.Object({ kind: Opt(Type.Enum([...DEVICE_KINDS])) }),
      run(p) {
        const { rows } = repo.listDevices(p.kind);
        const lines = rows.map(
          (d) =>
            `- ${d.kind} ${d.vendor ?? ""} ${d.model ?? ""} serial=${d.serial ?? "?"} status=${d.status}${d.batteryPct !== null ? ` battery=${d.batteryPct}%` : ""}${d.boundAnimalId ? ` on animal ${d.boundAnimalId}` : " (not on an animal)"} id=${d.id}`,
        );
        return text([`${rows.length} devices.`, ...lines].join("\n"), { rows });
      },
    }),
    tool({
      name: "device_bind",
      label: "Put a sensor on an animal",
      description:
        "Record that a device is worn by an animal (action bind), or take it off (action unbind). An animal can wear only ONE wearable sensor: a collar OR a bolus OR an ear tag sensor.",
      parameters: Type.Object({
        deviceId: Type.String(),
        animalId: OptStr("Animal id, ear tag or name (required for bind)"),
        action: Opt(Type.Enum(["bind", "unbind"])),
      }),
      run(p, origin) {
        if (p.action === "unbind") {
          const r = repo.clearBinding(p.deviceId, origin);
          return text(`Device ${p.deviceId} is no longer on an animal.`, r);
        }
        if (!p.animalId) return text("Not done: say which animal (animalId).", {}, true);
        const animal = repo.findAnimal(p.animalId);
        if (!animal) return text(`Not done: no animal matches "${p.animalId}".`, {}, true);
        const violation = repo.checkWearable(p.deviceId, animal.id);
        if (violation)
          return text(wearableExplanation(violation), { ruleViolation: violation }, true);
        const r = repo.setBinding(p.deviceId, animal.id, origin);
        return text(
          `Device ${p.deviceId} is now on ${animal.name ?? animal.earTagNumber ?? animal.id}.`,
          r,
        );
      },
    }),
    tool({
      name: "observations_query",
      label: "Look at sensor data",
      description:
        "Recent observations (milking, activity, rumination, temperature, weight) and alerts (heat, calving, health), newest first.",
      parameters: Type.Object({
        animalId: OptStr("Animal id, ear tag or name"),
        kind: Opt(Type.Enum([...OBSERVATION_KINDS])),
        sinceHours: Opt(Type.Number({ minimum: 0 })),
        alertsOnly: Opt(Type.Boolean()),
        limit: Opt(Type.Integer({ minimum: 1, maximum: 500 })),
      }),
      run(p) {
        const animal = p.animalId ? repo.findAnimal(p.animalId) : null;
        if (p.animalId && !animal) return text(`No animal matches "${p.animalId}".`, { rows: [] });
        const rows = repo.recentObservations({
          animalId: animal?.id,
          kind: p.kind,
          alertsOnly: p.alertsOnly,
          since:
            p.sinceHours !== undefined
              ? new Date(Date.now() - p.sinceHours * 3_600_000).toISOString()
              : undefined,
          limit: p.limit ?? 50,
        });
        const lines = rows.map(
          (o) =>
            `- ${o.ts} ${o.kind}${o.valueNum !== null ? ` ${o.valueNum}` : ""}${o.valueJson ? ` ${JSON.stringify(o.valueJson)}` : ""} animal=${o.animalId ?? "-"}`,
        );
        return text([`${rows.length} observations.`, ...lines].join("\n"), { rows });
      },
    }),
    tool({
      name: "connectors_list",
      label: "List connectors",
      description:
        "List data connectors (milking robots, sensor clouds, CSV imports, custom) with status.",
      parameters: Type.Object({}),
      run() {
        const rows = repo.listConnectors();
        const lines = rows.map(
          (c) =>
            `- ${c.name ?? c.vendor} (${c.vendor}, ${c.kind}) ${c.enabled ? "on" : "off"}; last sync ${c.lastSyncAt ?? "never"}${c.lastError ? `; error: ${c.lastError}` : ""} id=${c.id}`,
        );
        return text([`${rows.length} connectors.`, ...lines].join("\n"), {
          rows: rows.map(({ config, ...c }) => ({
            ...c,
            config: { ...config, credentialRef: undefined },
          })),
        });
      },
    }),
    tool({
      name: "connector_scaffold",
      label: "Create a connector",
      description:
        "Create a new connector folder in the farm workspace (connectors/<name>) from the Orbit template and register it switched off. Then edit its code with the file tools.",
      parameters: Type.Object({ name: Type.String({ description: "lowercase-with-dashes" }) }),
      run(p, origin) {
        const r = farm.connectors.scaffold(p.name, origin);
        return text(
          `Created ${r.path} (${r.usedTemplate ? "from the Orbit template" : "from the built-in starter"}). It is switched off until the farmer turns it on. Connector id ${r.id}.`,
          r,
        );
      },
    }),
    tool({
      name: "connector_run",
      label: "Run a connector",
      description: "Run an enabled connector's sync once and import what it returns.",
      parameters: Type.Object({ id: Type.String() }),
      async run(p) {
        const r = await farm.connectors.run(p.id);
        return text(
          `Imported ${r.imported} observation${r.imported === 1 ? "" : "s"}${r.skipped ? `, skipped ${r.skipped} invalid` : ""}.${r.logs.length ? `\nLog:\n${r.logs.slice(-20).join("\n")}` : ""}`,
          r,
        );
      },
    }),
    tool({
      name: "camera_discover",
      label: "Find cameras",
      description:
        "Search the local network for ONVIF IP cameras (WS-Discovery). Returns manufacturer, model and address.",
      parameters: Type.Object({ timeoutMs: Opt(Type.Integer({ minimum: 500, maximum: 15000 })) }),
      async run(p) {
        const cams = await farm.cameras.discover(p.timeoutMs ?? 3000);
        if (cams.length === 0) {
          return text(
            "No ONVIF cameras answered. Check that the cameras are powered, on the same network as this PC, and that ONVIF is switched on in their settings.",
            { cameras: [] },
          );
        }
        const lines = cams.map(
          (c) =>
            `- ${c.manufacturer ?? "Unknown maker"} ${c.model ?? ""} at ${c.host ?? "?"} (xaddr ${c.xaddr ?? "?"})`,
        );
        return text(
          [`Found ${cams.length} camera${cams.length === 1 ? "" : "s"}:`, ...lines].join("\n"),
          { cameras: cams },
        );
      },
    }),
    tool({
      name: "camera_add",
      label: "Add a camera",
      description:
        "Save a camera. The password is stored in the system keychain, never in the database or chat.",
      parameters: Type.Object({
        name: Type.String(),
        location: OptStr("Where it hangs, e.g. Calving pen"),
        onvifXaddr: OptStr("ONVIF device service URL from camera_discover"),
        rtspUrl: OptStr("RTSP stream URL without credentials"),
        username: OptStr("Camera login user"),
        password: OptStr("Camera login password"),
      }),
      async run(p, origin) {
        const r = await farm.cameras.upsert(p, origin);
        return text(
          `Saved camera "${p.name}"${p.password ? " with its login stored in the keychain" : ""} (id ${r.ids[0]}).`,
          { ids: r.ids, snapshotId: r.snapshotId },
        );
      },
    }),
  ];
}

export const FARM_TOOL_NAMES = [
  "herd_query",
  "herd_upsert_animal",
  "devices_list",
  "device_bind",
  "observations_query",
  "connectors_list",
  "connector_scaffold",
  "connector_run",
  "camera_discover",
  "camera_add",
] as const;
