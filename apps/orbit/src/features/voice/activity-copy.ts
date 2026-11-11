import type { Species } from "@orbit/schema";
import type { TranslateFn } from "../../i18n";
import { getFriendlyToolMeta } from "../chat/ToolCard";
import type { ActivityRecord, ActivityRowView } from "./types";

function asObject(val: unknown): Record<string, unknown> | null {
  return val !== null && typeof val === "object" && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

function parseResultPayload(row: ActivityRecord): Record<string, unknown> | unknown[] | null {
  const detailsObj = asObject(row.details);
  if (detailsObj) {
    const inner = detailsObj.result;
    if (Array.isArray(inner)) return inner;
    return asObject(inner) ?? detailsObj;
  }
  if (!row.result) return null;
  try {
    const parsed: unknown = JSON.parse(row.result);
    if (Array.isArray(parsed)) return parsed;
    const obj = asObject(parsed);
    if (!obj) return null;
    if (Array.isArray(obj.result)) return obj.result;
    return asObject(obj.result) ?? obj;
  } catch {
    return null;
  }
}

function extractCount(payload: Record<string, unknown> | unknown[] | null): number | null {
  if (!payload) return null;
  if (Array.isArray(payload)) return payload.length;
  if (typeof payload.total === "number" && Number.isFinite(payload.total)) return payload.total;
  for (const key of ["rows", "cameras", "devices"] as const) {
    if (Array.isArray(payload[key])) return payload[key].length;
  }
  return null;
}

function extractHost(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return null;
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export function isCleanPlainSentence(text: string, rawToolName: string): boolean {
  if (!text || text === rawToolName || /[{}[\]_]/.test(text)) return false;
  return !/\b(tool|tools|function|functions|verktøy|funksjon)\b/i.test(text);
}

function describeDbQuery(row: ActivityRecord, t: TranslateFn, species: Species): string {
  if (row.status === "error") return t("voice.activity.records.error");
  if (row.status === "stopped") return t("voice.activity.generic.stopped");
  const q = String(asObject(row.args)?.query ?? "");
  const running = row.status === "running";
  const payload = running ? null : parseResultPayload(row);
  const count = extractCount(payload);

  if (q.startsWith("animals.")) {
    if (running) {
      return t(
        species === "horse"
          ? "voice.activity.herd.running.horse"
          : "voice.activity.herd.running.cattle",
      );
    }
    if (count !== null) return t("voice.activity.herd.doneCount", { count });
    const obj = asObject(payload);
    const animal = asObject(obj?.animal) ?? obj;
    const name = typeof animal?.name === "string" ? animal.name.trim() : "";
    return name && isCleanPlainSentence(name, "")
      ? t("voice.activity.herd.doneNamed", { name })
      : t("voice.activity.herd.done");
  }
  if (q === "farm.summary") {
    return t(running ? "voice.activity.summary.running" : "voice.activity.summary.done");
  }
  if (q.startsWith("observations.")) {
    if (running) return t("voice.activity.alerts.running");
    return count !== null
      ? t("voice.activity.alerts.doneCount", { count })
      : t("voice.activity.alerts.done");
  }
  if (q.startsWith("devices.")) {
    if (running) return t("voice.activity.devices.running");
    return count !== null
      ? t("voice.activity.devices.doneCount", { count })
      : t("voice.activity.devices.done");
  }
  if (q.startsWith("cameras.")) {
    if (running) return t("voice.activity.cameras.running");
    return count !== null
      ? t("voice.activity.cameras.doneCount", { count })
      : t("voice.activity.cameras.done");
  }
  if (q.startsWith("connectors.")) {
    return t(running ? "voice.activity.connectors.running" : "voice.activity.connectors.done");
  }
  return t(running ? "voice.activity.records.running" : "voice.activity.records.done");
}

function describeDbMutate(row: ActivityRecord, t: TranslateFn): string {
  if (row.status === "error") return t("voice.activity.saveRecords.error");
  if (row.status === "stopped") return t("voice.activity.generic.stopped");
  const m = String(asObject(row.args)?.mutation ?? "");
  const running = row.status === "running";
  if (m === "animals.delete") {
    return t(running ? "voice.activity.removeAnimal.running" : "voice.activity.removeAnimal.done");
  }
  if (m.startsWith("animals.")) {
    return t(running ? "voice.activity.saveAnimal.running" : "voice.activity.saveAnimal.done");
  }
  if (m.startsWith("observations.")) {
    return t(running ? "voice.activity.saveNote.running" : "voice.activity.saveNote.done");
  }
  if (m.startsWith("devices.")) {
    return t(running ? "voice.activity.saveDevice.running" : "voice.activity.saveDevice.done");
  }
  if (m.startsWith("cameras.") || m.startsWith("cameraLayouts.")) {
    return t(running ? "voice.activity.saveCamera.running" : "voice.activity.saveCamera.done");
  }
  if (m.startsWith("farms.")) {
    return t(running ? "voice.activity.saveFarm.running" : "voice.activity.saveFarm.done");
  }
  return t(running ? "voice.activity.saveRecords.running" : "voice.activity.saveRecords.done");
}

function describeBrowser(row: ActivityRecord, t: TranslateFn): string {
  if (row.status === "error") return t("voice.activity.browser.error");
  if (row.status === "stopped") return t("voice.activity.generic.stopped");
  const args = asObject(row.args);
  const action = typeof args?.action === "string" ? args.action : "";
  const host = extractHost(args?.url);
  const running = row.status === "running";
  if (action === "open" && host) {
    return t(running ? "voice.activity.browserOpen.running" : "voice.activity.browserOpen.done", {
      host,
    });
  }
  if (action === "highlight") {
    return t(
      running ? "voice.activity.browserHighlight.running" : "voice.activity.browserHighlight.done",
    );
  }
  if (action === "open" || action === "look" || action === "snapshot" || !action) {
    return t(running ? "voice.activity.browserPage.running" : "voice.activity.browserPage.done");
  }
  return t(running ? "voice.activity.browserAction.running" : "voice.activity.browserAction.done");
}

function describeApp(row: ActivityRecord, t: TranslateFn): string {
  if (row.status === "error") return t("voice.activity.app.error");
  if (row.status === "stopped") return t("voice.activity.generic.stopped");
  const action = String(asObject(row.args)?.action ?? "look");
  const running = row.status === "running";
  switch (action) {
    case "highlight":
      return t(
        running ? "voice.activity.appHighlight.running" : "voice.activity.appHighlight.done",
      );
    case "click":
      return t(running ? "voice.activity.appClick.running" : "voice.activity.appClick.done");
    case "go":
      return t(running ? "voice.activity.appGo.running" : "voice.activity.appGo.done");
    case "clear":
      return t(running ? "voice.activity.appClear.running" : "voice.activity.appClear.done");
    default:
      return t(running ? "voice.activity.appLook.running" : "voice.activity.appLook.done");
  }
}

export function describeActivityRecord(
  row: ActivityRecord,
  t: TranslateFn,
  species: Species = "cattle",
): ActivityRowView {
  let text: string;
  switch (row.name) {
    case "db_query":
      text = describeDbQuery(row, t, species);
      break;
    case "db_mutate":
      text = describeDbMutate(row, t);
      break;
    case "browser":
      text = describeBrowser(row, t);
      break;
    case "orion_task":
      text = t(
        row.status === "running"
          ? "voice.activity.task.running"
          : row.status === "stopped"
            ? "voice.activity.task.stopped"
            : row.status === "error"
              ? "voice.activity.task.error"
              : "voice.activity.task.done",
      );
      break;
    case "app":
      text = describeApp(row, t);
      break;
    default: {
      if (row.status === "error") text = t("voice.activity.generic.error");
      else if (row.status === "stopped") text = t("voice.activity.generic.stopped");
      else {
        const meta = getFriendlyToolMeta(t, row.name, row.label);
        const candidate = row.status === "running" ? meta.runningTitle : meta.title;
        text = isCleanPlainSentence(candidate, row.name)
          ? candidate
          : t(
              row.status === "running"
                ? "voice.activity.generic.running"
                : "voice.activity.generic.done",
            );
      }
      break;
    }
  }

  return {
    id: row.id,
    name: row.name,
    status: row.status,
    text,
    chipLabel: text,
    startedAt: row.startedAt,
    ...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
    canStop: row.name === "orion_task" && row.status === "running",
  };
}
