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
  ShieldX,
  Tag,
  Terminal,
  Wrench,
  XCircle,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { Badge, type BadgeVariant } from "../../design";

export interface FriendlyToolMeta {
  title: string;
  icon: typeof Tag;
}

export function getFriendlyToolMeta(name: string, fallbackLabel?: string): FriendlyToolMeta {
  switch (name) {
    case "herd_query":
      return { title: "Look up herd animals", icon: Tag };
    case "herd_upsert_animal":
      return { title: "Update herd records", icon: PlusCircle };
    case "devices_list":
      return { title: "List sensors & equipment", icon: Radio };
    case "device_bind":
      return { title: "Put sensor on animal", icon: Radio };
    case "observations_query":
      return { title: "Look at sensor data", icon: Activity };
    case "connectors_list":
      return { title: "List data connectors", icon: Plug };
    case "connector_scaffold":
      return { title: "Create a new connector", icon: FolderPlus };
    case "connector_run":
      return { title: "Run connector sync", icon: Play };
    case "camera_discover":
      return { title: "Find cameras on network", icon: Camera };
    case "camera_add":
      return { title: "Add a barn camera", icon: Camera };
    case "bash":
    case "powershell":
      return { title: "Run workspace command", icon: Terminal };
    case "write":
      return { title: "Write workspace file", icon: FileCode2 };
    case "edit":
      return { title: "Edit workspace file", icon: Edit3 };
    case "read":
      return { title: "Read workspace file", icon: FileText };
    case "ls":
    case "find":
    case "grep":
      return { title: "Search workspace files", icon: Search };
    default:
      return {
        title: fallbackLabel && fallbackLabel !== name ? fallbackLabel : name,
        icon: Wrench,
      };
  }
}

export function formatToolDuration(durationMs?: number): string | null {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
    return null;
  }
  if (durationMs < 1000) {
    return `${Math.max(1, Math.round(durationMs))} ms`;
  }
  return `${(durationMs / 1000).toFixed(1)} s`;
}

export function formatToolStatusBadge(status: ToolItem["status"]): {
  label: string;
  variant: BadgeVariant;
  icon: ReactNode;
} {
  switch (status) {
    case "running":
      return {
        label: "Running",
        variant: "info",
        icon: <Loader2 size={12} className="orbit-spin" />,
      };
    case "done":
      return {
        label: "Done",
        variant: "ok",
        icon: <CheckCircle2 size={12} />,
      };
    case "denied":
      return {
        label: "Not allowed",
        variant: "warn",
        icon: <ShieldX size={12} />,
      };
    case "aborted":
      return {
        label: "Stopped",
        variant: "neutral",
        icon: <XCircle size={12} />,
      };
    case "error":
      return {
        label: "Failed",
        variant: "danger",
        icon: <AlertCircle size={12} />,
      };
  }
}

function summarizeToolArgs(name: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const rec = args as Record<string, unknown>;
  if (name === "herd_query") {
    if (rec.id) return `Animal: ${String(rec.id)}`;
    const parts: string[] = [];
    if (rec.species) parts.push(String(rec.species));
    if (rec.groupName) parts.push(`group ${String(rec.groupName)}`);
    if (rec.search) parts.push(`"${String(rec.search)}"`);
    return parts.join(" · ") || "All active animals";
  }
  if (name === "device_bind") {
    const action = rec.action === "unbind" ? "Remove" : "Bind";
    return `${action} device ${String(rec.deviceId ?? "")}${rec.animalId ? ` → ${String(rec.animalId)}` : ""}`;
  }
  if (name === "camera_discover") {
    return rec.timeoutMs
      ? `Local network scan (${String(rec.timeoutMs)} ms)`
      : "Local network scan";
  }
  if (name === "write" || name === "edit" || name === "read") {
    return String(rec.path ?? rec.file_path ?? "");
  }
  if (name === "bash" || name === "powershell") {
    return String(rec.command ?? "");
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

function formatWearableLabel(wearable: AnimalListItem["wearable"]): string {
  if (!wearable) return "None";
  const kind = wearable.kind.replaceAll("_", " ");
  const battery = typeof wearable.batteryPct === "number" ? ` (${wearable.batteryPct}%)` : "";
  return `${kind}${battery}`;
}

export interface ToolCardProps {
  item: ToolItem;
  defaultExpanded?: boolean;
}

export function ToolCard({ item, defaultExpanded = false }: ToolCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const meta = getFriendlyToolMeta(item.name, item.label);
  const statusBadge = formatToolStatusBadge(item.status);
  const durationText = formatToolDuration(item.durationMs);
  const argSummary = summarizeToolArgs(item.name, item.args);
  const animalRows = extractAnimalRows(item);
  const Icon = meta.icon;

  const isFailedOrDenied = item.status === "error" || item.status === "denied";

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

      {isFailedOrDenied && item.result && !expanded && (
        <div
          data-testid={`tool-card-error-summary-${item.toolCallId}`}
          style={{
            padding: "var(--space-3) var(--space-4)",
            borderBlockStart: "1px solid var(--border-subtle)",
            backgroundColor:
              item.status === "denied" ? "var(--status-warn-bg)" : "var(--status-danger-bg)",
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
                Inputs ({item.name})
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
                Animals ({animalRows.length})
              </span>
              <div
                className="orbit-mini-table-wrap"
                data-testid={`tool-card-animal-table-${item.toolCallId}`}
              >
                <table className="orbit-mini-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Ear Tag</th>
                      <th>Species / Breed</th>
                      <th>Group</th>
                      <th>Sensor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {animalRows.map((animal) => (
                      <tr key={animal.id}>
                        <td style={{ fontWeight: 600 }}>{animal.name ?? "Unnamed"}</td>
                        <td className="tabular-nums" style={{ fontFamily: "var(--font-mono)" }}>
                          {animal.earTagNumber ?? "—"}
                        </td>
                        <td>
                          {animal.breed ? `${animal.breed} (${animal.species})` : animal.species}
                        </td>
                        <td>{animal.groupName ?? "—"}</td>
                        <td>{formatWearableLabel(animal.wearable)}</td>
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
                {isFailedOrDenied ? "What happened" : "Result"}
              </span>
              {isFailedOrDenied ? (
                <div
                  role="alert"
                  data-testid={`tool-card-result-${item.toolCallId}`}
                  style={{
                    padding: "var(--space-3) var(--space-4)",
                    borderRadius: "var(--radius-md)",
                    backgroundColor:
                      item.status === "denied"
                        ? "var(--status-warn-bg)"
                        : "var(--status-danger-bg)",
                    border: `1px solid ${
                      item.status === "denied"
                        ? "var(--status-warn-border)"
                        : "var(--status-danger-border)"
                    }`,
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
