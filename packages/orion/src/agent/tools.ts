import { join } from "node:path";
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
import type { ConnectorSource } from "../services/connectors";
import type { FarmService } from "../services/farm";
import type { LocalUiService } from "../services/local-ui";
import type { SkillService } from "../services/skills";
import { forgetFacts, MEMORY_SCOPES, rememberFact } from "./memory";

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

const SECRET_KEY = /pass|secret|token|key|credential/i;

const RECORDED_EVENTS = [
  "insemination",
  "pregnancy_check",
  "calving",
  "abortion",
  "dry_off",
  "treatment",
] as const;

export function createFarmTools(
  farm: FarmService,
  localUi: LocalUiService,
  skills: SkillService | null = null,
): ToolDefinition[] {
  const repo = farm.repo;
  const skillTools = skills ? createSkillTools(farm, skills) : [];
  return [
    ...skillTools,
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
          const detail = repo.query("animals.get", { id: animal.id });
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
        const { rows, total } = repo.query("animals.list", {
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
      async run(p, origin) {
        const result = await farm.mutate(
          { mutation: "animals.upsert", params: { animal: p } },
          origin,
        );
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
        const { rows } = repo.query("devices.list", { kind: p.kind });
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
      async run(p, origin) {
        if (p.action === "unbind") {
          const r = await farm.mutate(
            { mutation: "bindings.clear", params: { deviceId: p.deviceId } },
            origin,
          );
          return text(`Device ${p.deviceId} is no longer on an animal.`, r);
        }
        if (!p.animalId) return text("Not done: say which animal (animalId).", {}, true);
        const animal = repo.findAnimal(p.animalId);
        if (!animal) return text(`Not done: no animal matches "${p.animalId}".`, {}, true);
        const violation = repo.checkWearable(p.deviceId, animal.id);
        if (violation)
          return text(wearableExplanation(violation), { ruleViolation: violation }, true);
        const r = await farm.mutate(
          { mutation: "bindings.set", params: { deviceId: p.deviceId, animalId: animal.id } },
          origin,
        );
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
        const { rows } = repo.query("observations.recent", {
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
      name: "herd_record_event",
      label: "Record an animal event",
      description:
        "Record something that happened to an animal: an insemination, pregnancy check, calving (or foaling), abortion, dry-off or treatment. Herd and calendar pages work out what is due (calving, dry-off, pregnancy check) from these records.",
      parameters: Type.Object({
        animalId: Type.String({ description: "Animal id, ear tag or name" }),
        kind: Type.Enum([...RECORDED_EVENTS]),
        date: OptStr("When it happened, YYYY-MM-DD or an ISO time; now when omitted"),
        naturalService: Opt(
          Type.Boolean({ description: "Insemination: served by a bull or stallion" }),
        ),
        pregnant: Opt(Type.Boolean({ description: "Pregnancy check: what the check found" })),
        note: OptStr("What was done or seen, in the farmer's words"),
      }),
      async run(p, origin) {
        const animal = repo.findAnimal(p.animalId);
        if (!animal) return text(`Not done: no animal matches "${p.animalId}".`, {}, true);
        const when = p.date ? new Date(p.date) : new Date();
        if (Number.isNaN(when.getTime())) {
          return text(`Not done: "${p.date}" is not a date.`, {}, true);
        }
        if (p.kind === "pregnancy_check" && p.pregnant === undefined) {
          return text("Not done: say what the check found (pregnant: true or false).", {}, true);
        }
        const r = await farm.mutate(
          {
            mutation: "observations.add",
            params: {
              animalId: animal.id,
              kind: p.kind,
              ts: when.toISOString(),
              valueJson: {
                ...(p.kind === "insemination"
                  ? { inseminationType: p.naturalService ? "NaturalService" : "Insemination" }
                  : {}),
                ...(p.kind === "pregnancy_check"
                  ? { result: p.pregnant ? "Pregnant" : "Empty" }
                  : {}),
                ...(p.note ? { message: p.note } : {}),
              },
            },
          },
          origin,
        );
        return text(
          `Recorded ${p.kind.replaceAll("_", " ")} for ${animal.name ?? animal.earTagNumber ?? animal.id} on ${when.toISOString().slice(0, 10)}. The farmer can undo this.`,
          r,
        );
      },
    }),
    tool({
      name: "connectors_list",
      label: "List connectors",
      description:
        "List data connectors (milking robots, sensor clouds, CSV imports, custom) with status.",
      parameters: Type.Object({}),
      run() {
        const { rows } = repo.query("connectors.list", {});
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
        "Create a new connector folder in the farm workspace (connectors/<name>) and register it switched off. By default it starts from the Orbit template; pass fromSkill to copy the ready-made connector of an installed skill (its dependencies are installed too). Then edit or configure it.",
      parameters: Type.Object({
        name: Type.String({ description: "lowercase-with-dashes" }),
        fromSkill: OptStr("Name of an installed skill whose connector to copy"),
      }),
      async run(p, origin) {
        farm.guard?.("connectors.upsert");
        let source: ConnectorSource | null = null;
        if (p.fromSkill) {
          if (!skills) return text("Not done: skills are not available in this Orbit.", {}, true);
          const manifest = await skills.manifest(p.fromSkill);
          if (!manifest?.connector) {
            return text(`Not done: skill ${p.fromSkill} has no connector.`, {}, true);
          }
          const { dir, ...rest } = manifest.connector;
          source = { dir: join(skills.installDir, p.fromSkill, dir), ...rest };
        }
        const r = farm.connectors.scaffold(p.name, origin, source);
        const install = source ? await farm.connectors.installDependencies(r.path) : null;
        const from = source
          ? `from the ${p.fromSkill} skill`
          : r.usedTemplate
            ? "from the Orbit template"
            : "from the built-in starter";
        const deps = !install
          ? ""
          : install.ok
            ? " Its dependencies are installed."
            : ` Installing its dependencies failed:\n${install.output}`;
        return text(
          `Created ${r.path} (${from}). It is switched off until the farmer turns it on. Connector id ${r.id}.${deps}`,
          { ...r, install },
          install ? !install.ok : false,
        );
      },
    }),
    tool({
      name: "connector_configure",
      label: "Configure a connector",
      description:
        "Save non-secret settings of a connector (host, port, user name, time zone...); they are merged into its config. Never pass passwords or keys: the farmer enters those in Sensors & Robots > Connections > Password, which stores them in the OS keychain.",
      parameters: Type.Object({
        id: Type.String(),
        config: Type.Record(Type.String(), Type.Unknown(), {
          description: "Settings to set, e.g. { host, port, user, timezone }",
        }),
      }),
      run(p, origin) {
        farm.guard?.("connectors.upsert");
        const secretKeys = Object.keys(p.config).filter((k) => SECRET_KEY.test(k));
        if (secretKeys.length > 0) {
          return text(
            `Not done: ${secretKeys.join(", ")} look like secrets. Ask the farmer to enter the password in Sensors & Robots > Connections instead.`,
            { secretKeys },
            true,
          );
        }
        const current = repo.getConnector(p.id);
        repo.upsertConnector(
          { id: p.id, vendor: current.vendor, kind: current.kind, config: p.config as never },
          { description: `Configured connector ${current.name ?? current.vendor}`, ...origin },
        );
        return text(`Saved ${Object.keys(p.config).join(", ")} for ${current.name ?? p.id}.`, {
          id: p.id,
          keys: Object.keys(p.config),
        });
      },
    }),
    tool({
      name: "connector_run",
      label: "Run a connector",
      description: "Run an enabled connector's sync once and import what it returns.",
      parameters: Type.Object({ id: Type.String() }),
      async run(p) {
        farm.guard?.("connectors.syncNow");
        const r = await farm.connectors.run(p.id);
        const herd =
          r.animalsCreated || r.animalsUpdated
            ? ` Animals: ${r.animalsCreated} added, ${r.animalsUpdated} updated.`
            : "";
        return text(
          `Imported ${r.imported} observation${r.imported === 1 ? "" : "s"}${r.skipped ? `, skipped ${r.skipped} invalid` : ""}.${herd}${r.logs.length ? `\nLog:\n${r.logs.slice(-20).join("\n")}` : ""}`,
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
        const r = await farm.mutate({ mutation: "cameras.upsert", params: { camera: p } }, origin);
        return text(
          `Saved camera "${p.name}"${p.password ? " with its login stored in the keychain" : ""} (id ${r.ids[0]}).`,
          { ids: r.ids, snapshotId: r.snapshotId },
        );
      },
    }),
    tool({
      name: "local_ui_build",
      label: "Build your Orbit",
      description: `Typecheck and build the farm's own copy of the Orbit app from the checkout at ${localUi.checkoutDir} (installs dependencies the first time). Only a build that passes is switched on; Orbit then opens it at startup and a running copy reloads. Read the editing-orbit skill first.`,
      parameters: Type.Object({}),
      async run(_p, _origin, signal) {
        const r = await localUi.build(signal);
        if (!r.ok) {
          return text(
            `Not done: the ${r.step} step failed, so Orbit keeps ${r.status.state === "none" ? "the original app" : "the previous build"}.\n${r.output}`,
            { step: r.step, status: r.status },
            true,
          );
        }
        return text(
          "Built and checked. Orbit opens this version from the next start, and a running copy reloads now. The farmer can switch back in Settings > Your Orbit.",
          { status: r.status },
        );
      },
    }),
    tool({
      name: "local_ui_disable",
      label: "Use the original Orbit",
      description:
        "Stop using the farm's own build of the Orbit app; the original app is used from the next start. The checkout and its changes stay.",
      parameters: Type.Object({}),
      run() {
        return text("Orbit will start with the original app.", { status: localUi.disable() });
      },
    }),
    tool({
      name: "memory_remember",
      label: "Remember",
      description:
        'Save one lasting fact, without asking first. scope "farm" is for the farm (animals, routines, barn layout, devices, vet); scope "user" is for the person using Orbit (name, preferences, units, how they like answers). One short sentence per fact. Never store passwords or keys.',
      parameters: Type.Object({
        scope: Type.Enum([...MEMORY_SCOPES]),
        fact: Type.String({ description: "One short, self-contained sentence" }),
      }),
      run(p) {
        const added = rememberFact(farm.workspace, p.scope, p.fact);
        return text(
          added ? `Remembered (${p.scope}): ${p.fact}` : `Already remembered (${p.scope}).`,
          { scope: p.scope, added },
        );
      },
    }),
    tool({
      name: "memory_forget",
      label: "Forget",
      description:
        "Remove remembered facts that are wrong or out of date, without asking first. Removes every fact in the scope containing the given text.",
      parameters: Type.Object({
        scope: Type.Enum([...MEMORY_SCOPES]),
        match: Type.String({ description: "Text the facts to remove contain" }),
      }),
      run(p) {
        const removed = forgetFacts(farm.workspace, p.scope, p.match);
        if (removed.length === 0) {
          return text(`Nothing in ${p.scope} memory matches "${p.match}".`, { removed }, true);
        }
        return text(
          [`Forgot ${removed.length} (${p.scope}):`, ...removed.map((f) => `- ${f}`)].join("\n"),
          { scope: p.scope, removed },
        );
      },
    }),
  ];
}

function createSkillTools(farm: FarmService, skills: SkillService): ToolDefinition[] {
  return [
    tool({
      name: "skill_search",
      label: "Find a skill",
      description:
        "Search Orbit's online skill catalog for add-ons that are not built in: a connector for a specific vendor's milking robot, herd software or sensor system, or ready-made, tested screens (herd, calendar, cameras) to start from. Search before saying Orbit cannot connect to something and before building a new screen from scratch.",
      parameters: Type.Object({
        query: Type.String({
          description: "Vendor, system or screen, e.g. delaval, herd, calendar; empty lists all",
        }),
      }),
      async run(p) {
        const found = await skills.search(p.query);
        const installed = new Set(skills.installed());
        if (found.length === 0) {
          return text(`No skill in the catalog matches "${p.query}".`, { skills: [] });
        }
        const lines = found.map(
          (s) =>
            `- ${s.name} ${s.version}${installed.has(s.name) ? " (installed)" : ""}: ${s.description}`,
        );
        return text(
          [`${found.length} skill${found.length === 1 ? "" : "s"} found:`, ...lines].join("\n"),
          { skills: found.map(({ files, ...s }) => ({ ...s, installed: installed.has(s.name) })) },
        );
      },
    }),
    tool({
      name: "skill_install",
      label: "Install a skill",
      description:
        "Download a skill from the catalog into the farm workspace (skills/<name>/) and return its instructions; follow them. Every file is checked against the catalog before it is written. Installing again updates it.",
      parameters: Type.Object({ name: Type.String() }),
      async run(p) {
        farm.guard?.("connectors.upsert");
        const s = await skills.install(p.name);
        return text(
          `Installed ${s.name} ${s.version} into skills/${s.name}/ (${s.files.length} files). Its instructions:\n\n${s.instructions}`,
          { name: s.name, version: s.version, files: s.files },
        );
      },
    }),
    tool({
      name: "page_scaffold",
      label: "Add a ready-made page",
      description:
        "Copy a ready-made, tested page of an installed skill into the farm workspace (pages/<id>/): a full screen, usually with a card on Home. Then change its config.json to what this farmer uses, or build on its files. Refuses to replace a page that already exists, so the farmer's changes are never overwritten.",
      parameters: Type.Object({
        fromSkill: Type.String({ description: "Name of the installed skill" }),
        page: Type.String({ description: "Which of the skill's pages to copy" }),
        id: OptStr("Folder name under pages/ when it should differ from the page name"),
      }),
      async run(p) {
        farm.guard?.("connectors.upsert");
        const offered = await skills.pages(p.fromSkill);
        if (!offered.includes(p.page)) {
          return text(
            `Not done: skill ${p.fromSkill} has no page "${p.page}".${offered.length ? ` It has: ${offered.join(", ")}.` : " It has no pages."}`,
            { pages: offered },
            true,
          );
        }
        const r = await skills.scaffoldPage(p.fromSkill, p.page, p.id);
        return text(
          `Added ${r.path}/ from the ${p.fromSkill} skill (${r.files.join(", ")}). The farmer finds it under "Your pages"${r.files.includes("card.html") ? " and as a card on Home" : ""}. Now set ${r.path}/config.json to what this farmer uses.`,
          r,
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
  "herd_record_event",
  "skill_search",
  "skill_install",
  "page_scaffold",
  "connectors_list",
  "connector_scaffold",
  "connector_configure",
  "connector_run",
  "camera_discover",
  "camera_add",
  "local_ui_build",
  "local_ui_disable",
  "memory_remember",
  "memory_forget",
] as const;
