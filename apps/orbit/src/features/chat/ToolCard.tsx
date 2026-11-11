import type { AnimalListItem, ToolItem } from "@orbit/protocol";
import {
  Activity,
  AlertCircle,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Edit3,
  FileCode2,
  FileText,
  FolderPlus,
  Loader2,
  Play,
  Plug,
  PlusCircle,
  Radio,
  Search,
  Tag,
  Terminal,
  Wrench,
  XCircle,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Badge, type BadgeVariant } from "../../design";
import { type I18nContextValue, type MessageKey, type TranslateFn, useI18n } from "../../i18n";

export interface FriendlyToolMeta {
  title: string;
  icon: typeof Tag;
}

/** Placeholder label the chat reducer gives a tool.end that arrived without its tool.start. */
const UNKNOWN_TOOL_LABEL = "Tool call";

function toolMetaKey(name: string): { key: MessageKey; icon: typeof Tag } | null {
  switch (name) {
    case "herd_query":
      return { key: "chat.tool.herdQuery", icon: Tag };
    case "herd_upsert_animal":
      return { key: "chat.tool.herdUpsertAnimal", icon: PlusCircle };
    case "devices_list":
      return { key: "chat.tool.devicesList", icon: Radio };
    case "device_bind":
      return { key: "chat.tool.deviceBind", icon: Radio };
    case "observations_query":
      return { key: "chat.tool.observationsQuery", icon: Activity };
    case "orbit_modules":
      return { key: "chat.tool.orbitModules", icon: Wrench };
    case "connectors_list":
      return { key: "chat.tool.connectorsList", icon: Plug };
    case "connector_scaffold":
      return { key: "chat.tool.connectorScaffold", icon: FolderPlus };
    case "connector_run":
      return { key: "chat.tool.connectorRun", icon: Play };
    case "camera_discover":
      return { key: "chat.tool.cameraDiscover", icon: Camera };
    case "camera_add":
      return { key: "chat.tool.cameraAdd", icon: Camera };
    case "bash":
    case "powershell":
      return { key: "chat.tool.runCommand", icon: Terminal };
    case "write":
      return { key: "chat.tool.writeFile", icon: FileCode2 };
    case "edit":
      return { key: "chat.tool.editFile", icon: Edit3 };
    case "read":
      return { key: "chat.tool.readFile", icon: FileText };
    case "ls":
    case "find":
    case "grep":
      return { key: "chat.tool.searchFiles", icon: Search };
    case "db_query":
      return { key: "chat.tool.dbQuery", icon: Tag };
    case "db_mutate":
      return { key: "chat.tool.dbMutate", icon: PlusCircle };
    default:
      return null;
  }
}

export function getFriendlyToolMeta(
  t: TranslateFn,
  name: string,
  fallbackLabel?: string,
): FriendlyToolMeta {
  const known = toolMetaKey(name);
  if (known) return { title: t(known.key), icon: known.icon };
  if (fallbackLabel === UNKNOWN_TOOL_LABEL) return { title: t("chat.tool.fallback"), icon: Wrench };
  return {
    title: fallbackLabel && fallbackLabel !== name ? fallbackLabel : name,
    icon: Wrench,
  };
}

export function formatToolDuration(
  { t, formatNumber }: Pick<I18nContextValue, "t" | "formatNumber">,
  durationMs?: number,
): string | null {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
    return null;
  }
  if (durationMs < 1000) {
    return t("chat.duration.ms", { value: formatNumber(Math.max(1, Math.round(durationMs))) });
  }
  const seconds = formatNumber(durationMs / 1000, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return t("chat.duration.s", { value: seconds });
}

export function formatToolStatusBadge(
  status: ToolItem["status"],
  t: TranslateFn,
): {
  label: string;
  variant: BadgeVariant;
  icon: ReactNode;
} {
  switch (status) {
    case "running":
      return {
        label: t("chat.status.running"),
        variant: "info",
        icon: <Loader2 size={12} className="orbit-spin" />,
      };
    case "done":
      return {
        label: t("chat.status.done"),
        variant: "ok",
        icon: <CheckCircle2 size={12} />,
      };
    case "aborted":
      return {
        label: t("chat.status.stopped"),
        variant: "neutral",
        icon: <XCircle size={12} />,
      };
    case "error":
      return {
        label: t("chat.status.failed"),
        variant: "danger",
        icon: <AlertCircle size={12} />,
      };
  }
}

function speciesLabel(species: string, t: TranslateFn): string {
  switch (species) {
    case "cattle":
      return t("chat.species.cattle");
    case "horse":
      return t("chat.species.horse");
    default:
      return species;
  }
}

function summarizeToolArgs(name: string, args: unknown, t: TranslateFn): string {
  if (!args || typeof args !== "object") return "";
  const rec = args as Record<string, unknown>;
  if (name === "herd_query") {
    if (rec.id) return t("chat.args.animal", { id: String(rec.id) });
    const parts: string[] = [];
    if (rec.species) parts.push(speciesLabel(String(rec.species), t));
    if (rec.groupName) parts.push(t("chat.args.group", { name: String(rec.groupName) }));
    if (rec.search) parts.push(`"${String(rec.search)}"`);
    return parts.join(" · ") || t("chat.args.allAnimals");
  }
  if (name === "device_bind") {
    const device = String(rec.deviceId ?? "");
    const action =
      rec.action === "unbind" ? t("chat.args.unbind", { device }) : t("chat.args.bind", { device });
    return `${action}${rec.animalId ? ` → ${String(rec.animalId)}` : ""}`;
  }
  if (name === "camera_discover") {
    return rec.timeoutMs
      ? t("chat.args.networkScanTimeout", { ms: String(rec.timeoutMs) })
      : t("chat.args.networkScan");
  }
  if (name === "write" || name === "edit" || name === "read") {
    return String(rec.path ?? rec.file_path ?? "");
  }
  if (name === "bash" || name === "powershell") {
    return String(rec.command ?? "");
  }
  if (name === "db_query" && typeof rec.query === "string") {
    return rec.query;
  }
  if (name === "db_mutate" && typeof rec.mutation === "string") {
    return rec.mutation;
  }
  const entries = Object.entries(rec).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (entries.length === 0) return "";
  return entries
    .slice(0, 2)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" · ");
}

function extractAnimalRows(item: ToolItem): AnimalListItem[] | null {
  if (!item.details || typeof item.details !== "object") return null;
  const details = item.details as Record<string, unknown>;

  if (Array.isArray(details.rows) && details.rows.length > 0) {
    const first = details.rows[0] as Record<string, unknown> | undefined;
    if (
      first &&
      typeof first === "object" &&
      ("species" in first || "earTagNumber" in first || "wearable" in first)
    ) {
      return details.rows as AnimalListItem[];
    }
  }

  if (
    details.animal &&
    typeof details.animal === "object" &&
    "species" in (details.animal as Record<string, unknown>)
  ) {
    const single = details.animal as AnimalListItem;
    const wearable = (details.wearable as AnimalListItem["wearable"] | undefined) ?? null;
    return [{ ...single, wearable }];
  }

  return null;
}

function wearableKindLabel(kind: string, t: TranslateFn): string {
  switch (kind) {
    case "collar":
      return t("chat.wearable.collar");
    case "bolus":
      return t("chat.wearable.bolus");
    case "ear_tag_sensor":
      return t("chat.wearable.earTagSensor");
    default:
      return kind.replaceAll("_", " ");
  }
}

function formatWearableLabel(wearable: AnimalListItem["wearable"], t: TranslateFn): string {
  if (!wearable) return t("chat.wearable.none");
  const kind = wearableKindLabel(wearable.kind, t);
  const battery = typeof wearable.batteryPct === "number" ? ` (${wearable.batteryPct}%)` : "";
  return `${kind}${battery}`;
}

export interface ToolCardProps {
  item: ToolItem;
  defaultExpanded?: boolean;
}

export function ToolCard({ item, defaultExpanded = false }: ToolCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const i18n = useI18n();
  const { t } = i18n;
  const meta = getFriendlyToolMeta(t, item.name, item.label);
  const statusBadge = formatToolStatusBadge(item.status, t);
  const durationText = formatToolDuration(i18n, item.durationMs);
  const argSummary = summarizeToolArgs(item.name, item.args, t);
  const animalRows = extractAnimalRows(item);
  const Icon = meta.icon;

  const isFailedOrDenied = item.status === "error";
  // Orbit's own tools explain a refusal in plain words ("Not done: ..."); raw errors from file and shell tools stay behind the Failed badge.
  const showErrorSummary = isFailedOrDenied && !!item.result?.startsWith("Not done:") && !expanded;

  return (
    <div
      className="orbit-tool-card"
      data-testid={`tool-card-${item.toolCallId}`}
      data-tool-name={item.name}
      data-tool-status={item.status}
    >
      <button
        type="button"
        className="orbit-tool-card__summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
        data-testid={`tool-card-toggle-${item.toolCallId}`}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-3)",
            minInlineSize: 0,
            flex: 1,
          }}
        >
          <span
            style={{
              inlineSize: "2rem",
              blockSize: "2rem",
              borderRadius: "var(--radius-sm)",
              backgroundColor: "var(--bg-surface)",
              border: "1px solid var(--border-subtle)",
              color: "var(--accent-primary)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Icon size={16} aria-hidden="true" />
          </span>
          <div style={{ minInlineSize: 0, flex: 1 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "var(--space-2)",
              }}
            >
              <span style={{ fontWeight: 650, color: "var(--text-primary)" }}>{meta.title}</span>
              {argSummary && (
                <span
                  style={{
                    fontSize: "var(--text-xs)",
                    color: "var(--text-secondary)",
                    fontFamily: "var(--font-mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxInlineSize: "24rem",
                  }}
                >
                  {argSummary}
                </span>
              )}
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            flexShrink: 0,
          }}
        >
          {durationText && (
            <span
              className="tabular-nums"
              data-testid={`tool-card-duration-${item.toolCallId}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--space-1)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-xs)",
                color: "var(--text-muted)",
              }}
            >
              <Clock size={12} aria-hidden="true" />
              {durationText}
            </span>
          )}
          <Badge
            variant={statusBadge.variant}
            icon={statusBadge.icon}
            data-testid={`tool-card-status-${item.toolCallId}`}
          >
            {statusBadge.label}
          </Badge>
          <span style={{ color: "var(--text-secondary)", display: "flex" }}>
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
        </div>
      </button>

      {showErrorSummary && (
        <div
          data-testid={`tool-card-error-summary-${item.toolCallId}`}
          style={{
            padding: "var(--space-3) var(--space-4)",
            borderBlockStart: "1px solid var(--border-subtle)",
            backgroundColor: "var(--status-danger-bg)",
            color: "var(--text-primary)",
            fontSize: "var(--text-sm)",
          }}
        >
          {item.result}
        </div>
      )}

      {expanded && (
        <div
          className="orbit-tool-card__details"
          data-testid={`tool-card-details-${item.toolCallId}`}
        >
          {item.args !== undefined && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-1)",
              }}
            >
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: 600,
                  color: "var(--text-secondary)",
                }}
              >
                {t("chat.card.inputs", { name: item.name })}
              </span>
              <pre className="orbit-code-block" data-testid={`tool-card-args-${item.toolCallId}`}>
                {typeof item.args === "string" ? item.args : JSON.stringify(item.args, null, 2)}
              </pre>
            </div>
          )}

          {animalRows && animalRows.length > 0 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-2)",
              }}
            >
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: 600,
                  color: "var(--text-secondary)",
                }}
              >
                {t("chat.card.animals", { count: animalRows.length })}
              </span>
              <div
                className="orbit-mini-table-wrap"
                data-testid={`tool-card-animal-table-${item.toolCallId}`}
              >
                <table className="orbit-mini-table">
                  <thead>
                    <tr>
                      <th>{t("chat.table.name")}</th>
                      <th>{t("chat.table.earTag")}</th>
                      <th>{t("chat.table.speciesBreed")}</th>
                      <th>{t("chat.table.group")}</th>
                      <th>{t("chat.table.sensor")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {animalRows.map((animal) => (
                      <tr key={animal.id}>
                        <td style={{ fontWeight: 600 }}>{animal.name ?? t("chat.card.unnamed")}</td>
                        <td className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
                          {animal.earTagNumber ?? "—"}
                        </td>
                        <td>
                          {animal.breed
                            ? `${animal.breed} (${speciesLabel(animal.species, t)})`
                            : speciesLabel(animal.species, t)}
                        </td>
                        <td>{animal.groupName ?? "—"}</td>
                        <td>{formatWearableLabel(animal.wearable, t)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {item.result !== undefined && item.result.length > 0 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-1)",
              }}
            >
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: 600,
                  color: isFailedOrDenied ? "var(--status-danger)" : "var(--text-secondary)",
                }}
              >
                {isFailedOrDenied ? t("chat.card.whatHappened") : t("chat.card.result")}
              </span>
              {isFailedOrDenied ? (
                <div
                  role="alert"
                  data-testid={`tool-card-result-${item.toolCallId}`}
                  style={{
                    padding: "var(--space-3) var(--space-4)",
                    borderRadius: "var(--radius-md)",
                    backgroundColor: "var(--status-danger-bg)",
                    border: "1px solid var(--status-danger-border)",
                    color: "var(--text-primary)",
                    fontSize: "var(--text-sm)",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {item.result}
                </div>
              ) : (
                <pre
                  className="orbit-code-block"
                  data-testid={`tool-card-result-${item.toolCallId}`}
                >
                  {item.result}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
