import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  type AnimalListItem,
  FEEDBACK_KINDS,
  MODULE_IDS,
  SHARED_BUILD_KINDS,
} from "@orbit/protocol";
import {
  ANIMAL_SEX,
  ANIMAL_STATUS,
  DEVICE_KINDS,
  OBSERVATION_KINDS,
  SPECIES,
} from "@orbit/schema/enums";
import { type Static, type TSchema, Type } from "typebox";
import { RepoError, type WearableViolation } from "../db/repo";
import { AccountError } from "../services/account";
import type { ConnectorSource } from "../services/connectors";
import type { FarmService } from "../services/farm";
import type { FeedbackService } from "../services/feedback";
import type { FarmChange, LocalUiService } from "../services/local-ui";
import { describeModules, type ModulesStore } from "../services/modules";
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
        if (error instanceof AccountError) {
          return text(`Not done: ${error.message}`, { code: error.code }, true);
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
  modules: ModulesStore | null = null,
  /** Asks for Orion to restart once it is idle; false when nothing will restart it. */
  restartOrion: () => boolean = () => false,
): ToolDefinition[] {
  const repo = farm.repo;
  const skillTools = skills ? createSkillTools(farm, skills) : [];
  return [
    ...skillTools,
    ...(modules ? [createModulesTool(modules)] : []),
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
        "Save non-secret settings of a connector (host, port, user name, time zone...); they are merged into its config. Never pass passwords or keys: the farmer enters those in Connections > Password, which stores them in the OS keychain.",
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
            `Not done: ${secretKeys.join(", ")} look like secrets. Ask the farmer to enter the password in Connections > Password instead.`,
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
      name: "connector_remove",
      label: "Remove a connector",
      description:
        "Remove a connector the farmer asked to remove. It disappears from Connections, its stored password is deleted and its folder under connectors/ is removed. The farmer can undo it.",
      parameters: Type.Object({
        id: Type.String({ description: "Connector id from connectors_list" }),
      }),
      async run(p, origin) {
        farm.guard?.("connectors.upsert");
        const r = await farm.connectors.remove(p.id, origin);
        const folder = r.removedPath ? ` Its folder ${r.removedPath} is removed.` : "";
        const problems = r.problems.length ? ` But ${r.problems.join("; ")}.` : "";
        return text(
          `Removed connector ${r.name}.${folder}${problems} The farmer can undo this.`,
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
      name: "orbit_source",
      label: "Get Orbit's source",
      description: `Make Orbit's own source ready to edit at ${localUi.checkoutDir}: downloads the installed version on its own "farm" branch and installs what it needs. Run it before changing Orbit itself; it returns at once when the source is already there. The first time takes a few minutes and needs the internet, so tell the farmer first. Read the editing-orbit skill first.`,
      parameters: Type.Object({}),
      async run(_p, _origin, signal) {
        const r = await localUi.source(signal);
        if (!r.ok) {
          const why =
            r.step === "git"
              ? "git is not available on this computer"
              : r.step === "clone"
                ? "the download failed"
                : "installing what the source needs failed";
          return text(`Not done: ${why}.\n${r.output}`, { step: r.step }, true);
        }
        return text(
          [
            `${r.created ? "Downloaded" : "Already there"}: Orbit's source at ${r.path}, ready to edit.`,
            "- The app's screens: apps/orbit/src (React). The words on screen: apps/orbit/src/i18n/locales/<language>/.",
            "- Orion itself (your instructions, tools and skills): packages/orion/src and packages/orion/resources.",
            "Find the place with grep, edit, then run local_ui_build with a summary of the change.",
          ].join("\n"),
          { path: r.path, created: r.created },
        );
      },
    }),
    tool({
      name: "local_ui_build",
      label: "Build your Orbit",
      description: `Check and build the farm's own copy of Orbit from the source at ${localUi.checkoutDir}, in one step: records your edits, typechecks, builds the app, and, when you changed Orion itself (packages/orion), checks that the new Orion starts. Only a build where every step passes is switched on. The result says what the farmer has to do to see it; pass that on.`,
      parameters: Type.Object({
        summary: OptStr("What you changed, in a few plain words; recorded with the edits"),
      }),
      async run(p, _origin, signal) {
        const r = await localUi.build(signal, p.summary);
        if (!r.ok) {
          return text(
            `Not done: the ${r.step} step failed, so Orbit keeps ${r.status.state === "none" ? "the original app" : "the previous build"}.\n${r.output}`,
            { step: r.step, status: r.status },
            true,
          );
        }
        const how = r.reloads
          ? "The open Orbit window is reloading with the change now; the farmer does not need to do anything."
          : 'The open Orbit window still shows the old version. Tell the farmer to press "Open new version" in the bar at the top of Orbit (or to close Orbit and open it again) to see the change.';
        const orion =
          r.orion === "unchanged"
            ? ""
            : restartOrion()
              ? " Your own change to Orion is checked and switched on: Orion restarts by itself a few seconds after this reply is finished, so finish the reply now and do not start anything else."
              : " Your own change to Orion is checked and switched on: it is used from the next time Orbit starts.";
        return text(
          `Built and checked. ${how}${orion} The farmer can switch back in Settings > Your Orbit.`,
          { status: r.status, reloads: r.reloads, orion: r.orion },
        );
      },
    }),
    tool({
      name: "orbit_update",
      label: "Update your Orbit",
      description: `Move the farm's own Orbit (the source at ${localUi.checkoutDir}) to a newer release with the farm's changes kept: pulls the release from git, puts each of the farm's changes on top, installs what changed, then checks and builds it like local_ui_build. Nothing changes unless every step passes; a failure puts everything back. Read the updating-orbit skill first.`,
      parameters: Type.Object({
        version: OptStr('Release to move to, e.g. "0.1.7"; leave out for the newest'),
        leaveOut: Type.Optional(
          Type.Array(Type.String(), {
            description: "Ids of farm changes to leave out, only after the farmer agreed",
          }),
        ),
      }),
      async run(p, _origin, signal) {
        const moved = await localUi.update({ version: p.version, leaveOut: p.leaveOut }, signal);
        if (!moved.ok) {
          if (moved.step === "current")
            return text(`Nothing to do: ${moved.output}`, { step: moved.step });
          const why =
            moved.step === "clash"
              ? `the farm's change "${moved.clash?.summary}" (id ${moved.clash?.id.slice(0, 10)}) clashes with the new version in ${moved.clash?.files.join(", ")}`
              : moved.step === "fetch"
                ? "the new version could not be downloaded"
                : moved.step === "install"
                  ? "installing what the new version needs failed"
                  : `the ${moved.step} step failed`;
          return text(
            `Not done: ${why}. Nothing changed; Orbit keeps running as before.\n${moved.output}`,
            { step: moved.step, clash: moved.clash },
            true,
          );
        }
        const changes = (list: FarmChange[]) =>
          list
            .map((c) => `- ${c.summary} (id ${c.id.slice(0, 10)}): ${c.files.join(", ")}`)
            .join("\n");
        const built = await localUi.build(signal);
        if (!built.ok) {
          const undo = await localUi.restore(moved.previous);
          const after =
            built.status.state === "none"
              ? "Orbit runs the original app until local_ui_build builds the farm's version again."
              : "Orbit keeps the previous build.";
          return text(
            [
              `Not done: the ${built.step} step failed on ${moved.to}, so the update was undone${undo ? ` (but putting it back also failed: ${undo})` : ""}. ${after}`,
              "The farm's changes and the files they touch:",
              changes(moved.carried),
              built.output,
            ].join("\n"),
            { step: built.step, from: moved.from, to: moved.to, carried: moved.carried },
            true,
          );
        }
        const orion =
          built.orion === "unchanged"
            ? ""
            : restartOrion()
              ? " Orion moves to the new version by itself a few seconds after this reply is finished, so finish the reply now and start nothing else."
              : " Orion moves to the new version the next time Orbit starts.";
        const how = built.reloads
          ? "The open Orbit window is reloading with it now."
          : 'Tell the farmer to press "Open new version" in the bar at the top of Orbit (or close and open Orbit) to see it.';
        return text(
          [
            `Updated the farm's Orbit from ${moved.from} to ${moved.to}, checked and built. ${how}${orion}`,
            moved.carried.length
              ? `The farm's changes kept on top:\n${changes(moved.carried)}`
              : "The farm had no changes of its own to carry.",
            moved.alreadyIncluded.length
              ? `Already in the new version, so not needed any more:\n${changes(moved.alreadyIncluded)}`
              : "",
            moved.leftOut.length
              ? `Left out as agreed, to redo on the new version:\n${changes(moved.leftOut)}`
              : "",
            'To finish, the farmer presses "Restart to update" in the bar at the top of Orbit, so the rest of Orbit moves to the new version too.',
          ]
            .filter(Boolean)
            .join("\n"),
          {
            from: moved.from,
            to: moved.to,
            carried: moved.carried,
            alreadyIncluded: moved.alreadyIncluded,
            leftOut: moved.leftOut,
            status: built.status,
          },
        );
      },
    }),
    tool({
      name: "local_ui_disable",
      label: "Use the original Orbit",
      description:
        "Stop using the farm's own build of Orbit, the app and Orion alike; the original is used from the next start. The source and its changes stay.",
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

export function createFeedbackTools(feedback: FeedbackService): ToolDefinition[] {
  return [
    tool({
      name: "feedback_send",
      label: "Send feedback",
      description:
        "Send a message from the farmer to the Orbit team: a problem with Orbit, something they wish it could do, or any other comment. Show the farmer the exact text first and send only after they say yes. Write it in their words, add what you saw go wrong (the error text, what you tried), and leave out animal records, names, addresses and passwords. Orbit's version and the kind of computer are added automatically.",
      parameters: Type.Object({
        kind: Type.Enum([...FEEDBACK_KINDS], {
          description: "issue = something is broken or confusing; idea = a wish; other = the rest",
        }),
        message: Type.String({ minLength: 1, maxLength: 5000 }),
      }),
      async run(p) {
        const { id } = await feedback.send(p);
        return text(`Sent to the Orbit team (reference ${id.slice(0, 8)}).`, { id });
      },
    }),
    tool({
      name: "share_build",
      label: "Share a build",
      description:
        'Submit a working farm build for the Orbit marketplace: a custom page (kind "page", folder pages/<name>), a connector (kind "connector", folder connectors/<name>) or a skill (kind "skill", folder skills/<name>). Package other software as a self-contained skill with SKILL.md, source and run instructions first, and test that copy. Only text files in that folder are included (60 files, 512 KB maximum); hidden, generated and binary files are skipped. It goes to the Orbit team for review and reaches other farms only if they approve it. Needs a signed-in Orbit account. Before calling: get the farmer\'s yes, and remove this farm\'s name, animal data, addresses and every password or key from the files (settings belong in the connector configuration, not in code). The tool refuses files that still look like they hold a password or key.',
      parameters: Type.Object({
        kind: Type.Enum([...SHARED_BUILD_KINDS]),
        name: Type.String({ description: "Folder name of the page, connector or skill" }),
        title: Type.String({ minLength: 1, maxLength: 120, description: "Short name for it" }),
        description: Type.String({
          minLength: 1,
          maxLength: 2000,
          description: "What it does, which equipment or data it needs, and how to set it up",
        }),
      }),
      async run(p) {
        const sent = await feedback.share(p);
        const left = sent.skipped.length > 0 ? `\nLeft out: ${sent.skipped.join(", ")}` : "";
        return text(
          `Shared for review (reference ${sent.id.slice(0, 8)}): ${sent.files.length} files.${left}\nThe Orbit team reviews it before other farms can install it; share_status shows where it stands.`,
          sent,
        );
      },
    }),
    tool({
      name: "share_status",
      label: "Shared builds",
      description:
        "List what this account has shared and whether each is pending, approved or rejected.",
      parameters: Type.Object({}),
      async run() {
        const { submissions } = await feedback.shared();
        if (submissions.length === 0) return text("Nothing has been shared yet.", { submissions });
        const lines = submissions.map(
          (s) =>
            `- ${s.title} (${s.kind} ${s.name}): ${s.status}${s.reviewNote ? `, note: ${s.reviewNote}` : ""}`,
        );
        return text(lines.join("\n"), { submissions });
      },
    }),
  ];
}

function createModulesTool(modules: ModulesStore): ToolDefinition {
  return tool({
    name: "orbit_modules",
    label: "Orbit screens",
    description:
      'List, enable or disable Orbit\'s built-in screens: "herd" (animal records), "devices" (Connections, existing connectors only), "cameras". Orbit starts with only Home, Chat and Settings; enable a module when the farmer starts using that area. There is no sensor setup screen. Disabling only hides the screen; no data is deleted.',
    parameters: Type.Object({
      action: Type.Enum(["list", "enable", "disable"]),
      id: Opt(Type.Enum([...MODULE_IDS])),
    }),
    run(p) {
      if (p.action === "list") {
        const state = modules.list();
        return text(`Orbit modules:\n${describeModules(state)}`, state);
      }
      if (!p.id)
        return text(`Not done: say which module (id: ${MODULE_IDS.join(", ")}).`, {}, true);
      const was = modules.enabled(p.id);
      const state = p.action === "enable" ? modules.enable(p.id, "orion") : modules.disable(p.id);
      const changed = was !== (p.action === "enable");
      const head = changed
        ? `${p.action === "enable" ? "Enabled" : "Disabled"} the ${p.id} module.`
        : `The ${p.id} module was already ${was ? "on" : "off"}.`;
      return text(`${head}\nOrbit modules:\n${describeModules(state)}`, state);
    },
  });
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
  "orbit_modules",
  "skill_search",
  "skill_install",
  "page_scaffold",
  "connectors_list",
  "connector_scaffold",
  "connector_configure",
  "connector_run",
  "connector_remove",
  "camera_discover",
  "camera_add",
  "orbit_source",
  "local_ui_build",
  "local_ui_disable",
  "orbit_update",
  "memory_remember",
  "memory_forget",
] as const;
