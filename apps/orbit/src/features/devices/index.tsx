import type { AnimalListItem, DeviceInput, DeviceListItem } from "@orbit/protocol";
import type { Connector, DeviceKind, DeviceStatus } from "@orbit/schema";
import { isWearableKind } from "@orbit/schema";
import {
  AlertTriangle,
  Battery,
  KeyRound,
  Link2,
  Plus,
  RefreshCw,
  Sparkles,
  Unlink,
} from "lucide-react";
import { createElement, type FormEvent, Fragment, type ReactNode, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  OrbitRings,
  type OrbitSatellite,
  Select,
  Skeleton,
  useToast,
} from "../../design";
import { type MessageKey, type TranslateFn, useT } from "../../i18n";
import { useOrion, useOrionQuery } from "../../lib/orion";

export interface DeviceGroupSpec {
  id: string;
  titleKey: MessageKey;
  subtitleKey: MessageKey;
  kinds: DeviceKind[];
}

export const DEVICE_GROUPS: DeviceGroupSpec[] = [
  {
    id: "milking_robot",
    titleKey: "devices.group.milkingRobot.title",
    subtitleKey: "devices.group.milkingRobot.subtitle",
    kinds: ["milking_robot"],
  },
  {
    id: "collar",
    titleKey: "devices.group.collar.title",
    subtitleKey: "devices.group.collar.subtitle",
    kinds: ["collar"],
  },
  {
    id: "bolus",
    titleKey: "devices.group.bolus.title",
    subtitleKey: "devices.group.bolus.subtitle",
    kinds: ["bolus"],
  },
  {
    id: "ear_tag_sensor",
    titleKey: "devices.group.earTag.title",
    subtitleKey: "devices.group.earTag.subtitle",
    kinds: ["ear_tag_sensor"],
  },
  {
    id: "other",
    titleKey: "devices.group.other.title",
    subtitleKey: "devices.group.other.subtitle",
    kinds: ["scale", "feeder", "camera", "other"],
  },
];

export function formatDeviceKindLabel(t: TranslateFn, kind: DeviceKind): string {
  return t(`devices.kind.${kind}`);
}

/** "a collar" / "an ear tag sensor": the article lives in the catalog so each language picks its own. */
export function formatKindWithArticle(t: TranslateFn, kind: DeviceKind): string {
  return isWearableKind(kind)
    ? t(`devices.kindArticle.${kind}`)
    : formatDeviceKindLabel(t, kind).toLowerCase();
}

/** Splits a translated template on `{part}` placeholders and drops React nodes into them. */
function rich(template: string, parts: Readonly<Record<string, ReactNode>>): ReactNode {
  const pieces = template
    .split(/\{(\w+)\}/)
    .map((piece, index) => (index % 2 === 1 ? (parts[piece] ?? `{${piece}}`) : piece));
  return createElement(Fragment, null, ...pieces);
}

export function formatVendorLabel(t: TranslateFn, vendor: string): string {
  switch (vendor) {
    case "lely":
      return "Lely";
    case "delaval":
      return "DeLaval";
    case "gea":
      return "GEA";
    case "boumatic":
      return "BouMatic";
    case "allflex":
      return "Allflex";
    case "smaxtec":
      return "smaXtec";
    case "cowmanager":
      return "CowManager";
    case "generic_csv":
      return t("devices.vendor.generic_csv");
    case "custom":
      return t("devices.vendor.custom");
    default:
      return vendor;
  }
}

export function formatLastSeen(t: TranslateFn, iso: string | null | undefined): string {
  if (!iso) return t("devices.time.never");
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return t("devices.time.justNow");
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return t("devices.time.minutesAgo", { count: Math.max(1, mins) });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("devices.time.hoursAgo", { count: hours });
  const days = Math.floor(hours / 24);
  return t("devices.time.daysAgo", { count: days });
}

export interface AttachDeviceDialogProps {
  open: boolean;
  onClose: () => void;
  device: DeviceListItem;
  animals: AnimalListItem[];
  onCompleted: () => Promise<void>;
}

export function AttachDeviceDialog({
  open,
  onClose,
  device,
  animals,
  onCompleted,
}: AttachDeviceDialogProps) {
  const t = useT();
  const { client } = useOrion();
  const { pushToast } = useToast();
  const [selectedAnimalId, setSelectedAnimalId] = useState<string>(
    device.boundAnimalId ?? animals[0]?.id ?? "",
  );
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const effectiveAnimalId = selectedAnimalId || animals[0]?.id || "";
  const chosenAnimal = animals.find((a) => a.id === effectiveAnimalId) ?? null;
  const currentAnimalHolder = device.boundAnimalId
    ? (animals.find((a) => a.id === device.boundAnimalId) ?? null)
    : null;

  const isWearable = isWearableKind(device.kind);
  const conflictingWearable =
    isWearable && chosenAnimal?.wearable && chosenAnimal.wearable.deviceId !== device.id
      ? chosenAnimal.wearable
      : null;

  const handleConfirm = async (e: FormEvent) => {
    e.preventDefault();
    if (!client || !effectiveAnimalId) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      if (conflictingWearable) {
        await client.mutate("bindings.clear", {
          deviceId: conflictingWearable.deviceId,
        });
      }
      await client.mutate("bindings.set", {
        deviceId: device.id,
        animalId: effectiveAnimalId,
      });
      pushToast({
        title: conflictingWearable
          ? t("devices.bind.toast.replaced")
          : t("devices.bind.toast.attached"),
        description: t("devices.bind.toast.description", {
          kind: formatDeviceKindLabel(t, device.kind),
          serial: device.serial ?? "",
          animal:
            chosenAnimal?.name ?? chosenAnimal?.earTagNumber ?? t("devices.bind.animalFallback"),
        }),
        tone: "ok",
      });
      await onCompleted();
      onClose();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("devices.bind.title", {
        kind: formatDeviceKindLabel(t, device.kind),
        device: device.serial ?? device.vendor ?? t("devices.bind.sensorFallback"),
      })}
      description={t("devices.bind.description")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} data-testid="device-bind-cancel-btn">
            {t("devices.common.cancel")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="device-bind-form"
            loading={submitting}
            disabled={!effectiveAnimalId}
            data-testid="device-bind-confirm-btn"
          >
            {conflictingWearable
              ? t("devices.bind.replace", {
                  kind: formatDeviceKindLabel(t, conflictingWearable.kind).toLowerCase(),
                })
              : currentAnimalHolder && currentAnimalHolder.id !== effectiveAnimalId
                ? t("devices.bind.move")
                : t("devices.bind.attach")}
          </Button>
        </>
      }
    >
      <form
        id="device-bind-form"
        onSubmit={handleConfirm}
        data-testid="device-bind-dialog"
        style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
      >
        <div
          data-testid="device-bind-rule-explanation"
          style={{
            padding: "var(--space-3) var(--space-4)",
            borderRadius: "var(--radius-md)",
            backgroundColor: "var(--bg-elevated)",
            border: "1px solid var(--border-subtle)",
            fontSize: "var(--text-sm)",
            color: "var(--text-secondary)",
          }}
        >
          <div
            style={{
              fontWeight: 700,
              color: "var(--text-primary)",
              marginBottom: "var(--space-1)",
            }}
          >
            {t("devices.bind.rule.title")}
          </div>
          <p style={{ margin: 0 }}>
            {rich(t("devices.bind.rule.body"), {
              collar: <strong>{t("devices.bind.rule.collar")}</strong>,
              bolus: <strong>{t("devices.bind.rule.bolus")}</strong>,
              earTag: <strong>{t("devices.bind.rule.earTag")}</strong>,
            })}
          </p>
        </div>

        <Select
          label={t("devices.bind.select.label")}
          data-testid="device-bind-animal-select"
          value={effectiveAnimalId}
          onChange={(e) => setSelectedAnimalId(e.target.value)}
          options={
            animals.length > 0
              ? animals.map((a) => {
                  const vars = {
                    animal: a.name ?? t("devices.common.unnamed"),
                    tag: a.earTagNumber ?? a.nationalId ?? a.species,
                  };
                  return {
                    value: a.id,
                    label: a.wearable
                      ? t("devices.bind.option.wears", {
                          ...vars,
                          wearable: formatKindWithArticle(t, a.wearable.kind),
                        })
                      : t("devices.bind.option.bare", vars),
                  };
                })
              : [{ value: "", label: t("devices.bind.option.empty") }]
          }
        />

        {currentAnimalHolder && currentAnimalHolder.id !== effectiveAnimalId && (
          <div
            data-testid="device-bind-move-notice"
            style={{
              padding: "var(--space-3) var(--space-4)",
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--bg-elevated)",
              border: "1px solid var(--border-subtle)",
              fontSize: "var(--text-xs)",
              color: "var(--text-secondary)",
            }}
          >
            {rich(
              t("devices.bind.moveNotice", {
                kind: formatDeviceKindLabel(t, device.kind).toLowerCase(),
              }),
              {
                from: (
                  <strong style={{ color: "var(--text-primary)" }}>
                    {currentAnimalHolder.name ?? currentAnimalHolder.earTagNumber}
                  </strong>
                ),
                to: (
                  <strong style={{ color: "var(--text-primary)" }}>
                    {chosenAnimal?.name ?? chosenAnimal?.earTagNumber}
                  </strong>
                ),
              },
            )}
          </div>
        )}

        {conflictingWearable && chosenAnimal && (
          <div
            data-testid="device-bind-conflict-warning"
            role="status"
            style={{
              padding: "var(--space-3) var(--space-4)",
              borderRadius: "var(--radius-md)",
              backgroundColor: "var(--status-warn-bg)",
              border: "1px solid var(--status-warn-border)",
              fontSize: "var(--text-sm)",
              color: "var(--text-primary)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                fontWeight: 700,
              }}
            >
              <AlertTriangle size={16} style={{ color: "var(--status-warn)" }} />
              <span>
                {t("devices.bind.conflict.title", {
                  animal: chosenAnimal.name ?? chosenAnimal.earTagNumber ?? "",
                  wearable: formatKindWithArticle(t, conflictingWearable.kind),
                })}
              </span>
            </div>
            <p style={{ margin: "var(--space-1) 0 0 0", fontSize: "var(--text-xs)" }}>
              {rich(
                conflictingWearable.vendor
                  ? t("devices.bind.conflict.bodyWithVendor", {
                      vendor: conflictingWearable.vendor,
                    })
                  : t("devices.bind.conflict.body"),
                {
                  current: (
                    <strong>
                      {formatDeviceKindLabel(t, conflictingWearable.kind).toLowerCase()}
                    </strong>
                  ),
                  next: (
                    <strong>{`${formatDeviceKindLabel(t, device.kind)} ${device.serial ?? ""}`}</strong>
                  ),
                },
              )}
            </p>
          </div>
        )}

        {errorMessage && (
          <p className="orbit-field__error" role="alert">
            {errorMessage}
          </p>
        )}
      </form>
    </Dialog>
  );
}

interface AddDeviceDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}

function AddDeviceDialog({ open, onClose, onSaved }: AddDeviceDialogProps) {
  const t = useT();
  const { client } = useOrion();
  const { pushToast } = useToast();

  const [kind, setKind] = useState<DeviceKind>("collar");
  const [vendor, setVendor] = useState("Nedap");
  const [model, setModel] = useState("SmartTag Neck");
  const [serial, setSerial] = useState("");
  const [status, setStatus] = useState<DeviceStatus>("online");
  const [batteryPct, setBatteryPct] = useState("100");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!client) return;
    if (!serial.trim()) {
      setError(t("devices.add.error.serial"));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const parsedBattery = batteryPct.trim() === "" ? null : Number(batteryPct.trim());
      const payload: DeviceInput = {
        kind,
        vendor: vendor.trim() || null,
        model: model.trim() || null,
        serial: serial.trim(),
        status,
        batteryPct:
          parsedBattery !== null && Number.isFinite(parsedBattery)
            ? Math.max(0, Math.min(100, parsedBattery))
            : null,
      };
      await client.mutate("devices.upsert", { device: payload });
      pushToast({
        title: t("devices.add.toast.title"),
        description: t("devices.add.toast.description", {
          kind: formatDeviceKindLabel(t, kind),
          serial: serial.trim(),
        }),
        tone: "ok",
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("devices.add.title")}
      description={t("devices.add.description")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} data-testid="device-form-cancel">
            {t("devices.common.cancel")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="device-add-form"
            loading={saving}
            data-testid="device-form-submit"
          >
            {t("devices.add.save")}
          </Button>
        </>
      }
    >
      <form
        id="device-add-form"
        onSubmit={handleSubmit}
        data-testid="device-form-dialog"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: "var(--space-4)",
        }}
      >
        <Select
          label={t("devices.add.kind.label")}
          data-testid="device-form-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as DeviceKind)}
          options={[
            { value: "collar", label: t("devices.add.kind.collar") },
            { value: "bolus", label: t("devices.add.kind.bolus") },
            { value: "ear_tag_sensor", label: t("devices.add.kind.earTag") },
            { value: "milking_robot", label: t("devices.add.kind.milkingRobot") },
            { value: "scale", label: t("devices.add.kind.scale") },
            { value: "feeder", label: t("devices.add.kind.feeder") },
            { value: "other", label: t("devices.add.kind.other") },
          ]}
        />
        <Select
          label={t("devices.add.status.label")}
          data-testid="device-form-status"
          value={status}
          onChange={(e) => setStatus(e.target.value as DeviceStatus)}
          options={[
            { value: "online", label: t("devices.add.status.online") },
            { value: "offline", label: t("devices.add.status.offline") },
            { value: "error", label: t("devices.add.status.error") },
          ]}
        />
        <Input
          label={t("devices.add.vendor.label")}
          data-testid="device-form-vendor"
          placeholder={t("devices.add.vendor.placeholder")}
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
        />
        <Input
          label={t("devices.add.model.label")}
          data-testid="device-form-model"
          placeholder={t("devices.add.model.placeholder")}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
        <Input
          label={t("devices.add.serial.label")}
          data-testid="device-form-serial"
          placeholder={t("devices.add.serial.placeholder")}
          value={serial}
          onChange={(e) => setSerial(e.target.value)}
        />
        <Input
          label={t("devices.add.battery.label")}
          type="number"
          min={0}
          max={100}
          data-testid="device-form-battery"
          value={batteryPct}
          onChange={(e) => setBatteryPct(e.target.value)}
        />
        {error && (
          <div style={{ gridColumn: "1 / -1" }}>
            <p className="orbit-field__error" role="alert">
              {error}
            </p>
          </div>
        )}
      </form>
    </Dialog>
  );
}

export interface ConnectorPasswordDialogProps {
  connector: Connector | null;
  onClose: () => void;
  onSaved: () => void;
}

/** Sends the password once over db.mutate; Orion keeps it in the OS keychain, never in the database. */
export function ConnectorPasswordDialog({
  connector,
  onClose,
  onSaved,
}: ConnectorPasswordDialogProps) {
  const t = useT();
  const { client } = useOrion();
  const { pushToast } = useToast();
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const name = connector ? (connector.name ?? formatVendorLabel(t, connector.vendor)) : "";

  const close = () => {
    setPassword("");
    onClose();
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!client || !connector || !password) return;
    setSaving(true);
    try {
      await client.mutate("connectors.upsert", {
        connector: {
          id: connector.id,
          vendor: connector.vendor,
          kind: connector.kind,
          name: connector.name,
          secret: password,
        },
      });
      pushToast({ title: t("devices.password.toast.saved"), description: name, tone: "ok" });
      setPassword("");
      onSaved();
    } catch (err) {
      pushToast({
        title: t("devices.password.toast.error"),
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={connector !== null}
      onClose={close}
      title={t("devices.password.title", { name })}
      description={t("devices.password.description")}
      footer={
        <>
          <Button variant="secondary" onClick={close} data-testid="connector-password-cancel">
            {t("devices.common.cancel")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="connector-password-form"
            loading={saving}
            disabled={!password}
            data-testid="connector-password-save"
          >
            {t("devices.password.save")}
          </Button>
        </>
      }
    >
      <form id="connector-password-form" onSubmit={(e) => void save(e)}>
        <Input
          label={t("devices.password.label")}
          type="password"
          autoComplete="new-password"
          data-testid="connector-password-input"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </form>
    </Dialog>
  );
}

export interface DevicesPageProps {
  initialTab?: "devices" | "connections";
}

export function DevicesPage({ initialTab = "devices" }: DevicesPageProps = {}) {
  const t = useT();
  const navigate = useNavigate();
  const { client } = useOrion();
  const { pushToast } = useToast();

  const [activeTab, setActiveTab] = useState<"devices" | "connections">(initialTab);
  const [bindingDevice, setBindingDevice] = useState<DeviceListItem | null>(null);
  const [addDeviceOpen, setAddDeviceOpen] = useState(false);
  const [syncingConnectorId, setSyncingConnectorId] = useState<string | null>(null);
  const [togglingConnectorId, setTogglingConnectorId] = useState<string | null>(null);
  const [passwordConnector, setPasswordConnector] = useState<Connector | null>(null);

  const {
    data: devicesData,
    loading: devicesLoading,
    error: devicesError,
    refetch: refetchDevices,
  } = useOrionQuery("devices.list", {}, { refetchTables: ["devices", "device_bindings"] });

  const { data: animalsData, refetch: refetchAnimals } = useOrionQuery(
    "animals.list",
    { limit: 500 },
    { refetchTables: ["animals", "device_bindings", "devices"] },
  );

  const {
    data: connectorsData,
    loading: connectorsLoading,
    error: connectorsError,
    refetch: refetchConnectors,
  } = useOrionQuery("connectors.list", {}, { refetchTables: ["connectors"] });

  const devices = devicesData?.rows ?? [];
  const animals = animalsData?.rows ?? [];
  const connectors = connectorsData?.rows ?? [];

  const animalById = useMemo(() => new Map(animals.map((a) => [a.id, a])), [animals]);

  const orbitSatellites = useMemo<OrbitSatellite[]>(() => {
    const robots = devices.filter((d) => d.kind === "milking_robot").length;
    const collars = devices.filter((d) => d.kind === "collar").length;
    const boluses = devices.filter((d) => d.kind === "bolus").length;
    const earTags = devices.filter((d) => d.kind === "ear_tag_sensor").length;
    const other = devices.filter(
      (d) =>
        d.kind !== "milking_robot" &&
        d.kind !== "collar" &&
        d.kind !== "bolus" &&
        d.kind !== "ear_tag_sensor",
    ).length;

    return [
      {
        id: "robots",
        label: t("devices.satellites.robots"),
        ring: 1,
        angleDeg: -45,
        tone: "ok",
        count: robots,
      },
      {
        id: "other",
        label: t("devices.satellites.other"),
        ring: 1,
        angleDeg: 135,
        tone: "ok",
        count: other,
      },
      {
        id: "collars",
        label: t("devices.satellites.collars"),
        ring: 2,
        angleDeg: 15,
        tone: "ok",
        count: collars,
      },
      {
        id: "boluses",
        label: t("devices.satellites.boluses"),
        ring: 2,
        angleDeg: 195,
        tone: "accent",
        count: boluses,
      },
      {
        id: "eartags",
        label: t("devices.satellites.earTags"),
        ring: 3,
        angleDeg: -110,
        tone: "ok",
        count: earTags,
      },
      {
        id: "connectors",
        label: t("devices.satellites.connectors"),
        ring: 3,
        angleDeg: 70,
        tone: "ok",
        count: connectors.length,
      },
    ];
  }, [devices, connectors, t]);

  const handleUnbindDevice = async (device: DeviceListItem) => {
    if (!client) return;
    try {
      await client.mutate("bindings.clear", { deviceId: device.id });
      pushToast({
        title: t("devices.unbind.toast.title"),
        description: t("devices.unbind.toast.description", {
          kind: formatDeviceKindLabel(t, device.kind),
          serial: device.serial ?? "",
        }),
        tone: "ok",
      });
      await Promise.all([refetchDevices(), refetchAnimals()]);
    } catch (err) {
      pushToast({
        title: t("devices.unbind.toast.error"),
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    }
  };

  const handleToggleConnector = async (connector: Connector) => {
    if (!client) return;
    setTogglingConnectorId(connector.id);
    try {
      const nextEnabled = !connector.enabled;
      await client.mutate("connectors.upsert", {
        connector: {
          id: connector.id,
          vendor: connector.vendor,
          kind: connector.kind,
          name: connector.name,
          enabled: nextEnabled,
        },
      });
      pushToast({
        title: nextEnabled ? t("devices.connector.toast.on") : t("devices.connector.toast.off"),
        description: t(
          nextEnabled ? "devices.connector.toast.enabled" : "devices.connector.toast.paused",
          { name: connector.name ?? formatVendorLabel(t, connector.vendor) },
        ),
        tone: "ok",
      });
      await refetchConnectors();
    } catch (err) {
      pushToast({
        title: t("devices.connector.toast.error"),
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    } finally {
      setTogglingConnectorId(null);
    }
  };

  const handleSyncNow = async (connector: Connector) => {
    if (!client) return;
    setSyncingConnectorId(connector.id);
    try {
      await client.mutate("connectors.syncNow", { id: connector.id });
      pushToast({
        title: t("devices.sync.toast.done"),
        description: t("devices.sync.toast.description", {
          name: connector.name ?? formatVendorLabel(t, connector.vendor),
        }),
        tone: "ok",
      });
      await refetchConnectors();
    } catch (err) {
      pushToast({
        title: t("devices.sync.toast.notice"),
        description: err instanceof Error ? err.message : String(err),
        tone: "warn",
      });
      await refetchConnectors();
    } finally {
      setSyncingConnectorId(null);
    }
  };

  return (
    <div className="orbit-container" data-testid="devices-page">
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "var(--space-4)",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
            <h1
              style={{
                margin: 0,
                fontFamily: "var(--font-display)",
                fontSize: "var(--text-h1)",
                fontWeight: 750,
                lineHeight: "var(--leading-tight)",
                letterSpacing: "var(--tracking-display)",
              }}
            >
              {t("devices.page.title")}
            </h1>
            <Badge variant="neutral" className="tabular-nums">
              {t("devices.page.summary", {
                devices: devices.length,
                connections: connectors.length,
              })}
            </Badge>
          </div>
          <p
            style={{
              margin: "var(--space-2) 0 0 0",
              color: "var(--text-secondary)",
              fontSize: "var(--text-base)",
              maxInlineSize: "68ch",
            }}
          >
            {t("devices.page.intro")}
          </p>
        </div>

        <div
          style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}
        >
          <div className="orbit-tablist" role="tablist" aria-label={t("devices.tabs.label")}>
            <button
              type="button"
              role="tab"
              className="orbit-tab"
              aria-selected={activeTab === "devices"}
              data-testid="devices-tab-equipment"
              onClick={() => setActiveTab("devices")}
            >
              {t("devices.tabs.equipment", { count: devices.length })}
            </button>
            <button
              type="button"
              role="tab"
              className="orbit-tab"
              aria-selected={activeTab === "connections"}
              data-testid="devices-tab-connections"
              onClick={() => setActiveTab("connections")}
            >
              {t("devices.tabs.connections", { count: connectors.length })}
            </button>
          </div>

          <Button
            variant="primary"
            size="md"
            icon={<Plus size={18} />}
            data-testid="devices-add-btn"
            onClick={() => setAddDeviceOpen(true)}
          >
            {t("devices.page.add")}
          </Button>
        </div>
      </header>

      {activeTab === "devices" ? (
        <div
          data-testid="devices-equipment-panel"
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}
        >
          <div className="orbit-home-hero">
            <Card title={t("devices.overview.title")} subtitle={t("devices.overview.subtitle")}>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "space-between",
                  gap: "var(--space-4)",
                  blockSize: "100%",
                }}
              >
                <p
                  style={{
                    margin: 0,
                    fontSize: "var(--text-base)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {rich(t("devices.overview.hint"), {
                    attach: <strong>{t("devices.bind.attach")}</strong>,
                    move: <strong>{t("devices.card.move")}</strong>,
                  })}
                </p>

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                    gap: "var(--space-3)",
                  }}
                >
                  {[
                    {
                      label: t("devices.overview.stat.robots"),
                      count: devices.filter((d) => d.kind === "milking_robot").length,
                    },
                    {
                      label: t("devices.overview.stat.collars"),
                      count: devices.filter((d) => d.kind === "collar").length,
                    },
                    {
                      label: t("devices.overview.stat.boluses"),
                      count: devices.filter((d) => d.kind === "bolus").length,
                    },
                    {
                      label: t("devices.overview.stat.earTags"),
                      count: devices.filter((d) => d.kind === "ear_tag_sensor").length,
                    },
                  ].map((stat) => (
                    <div
                      key={stat.label}
                      style={{
                        padding: "var(--space-3)",
                        borderRadius: "var(--radius-md)",
                        backgroundColor: "var(--bg-elevated)",
                        border: "1px solid var(--border-subtle)",
                      }}
                    >
                      <div
                        className="tabular-nums"
                        style={{
                          fontFamily: "var(--font-display)",
                          fontSize: "var(--text-h2)",
                          fontWeight: 750,
                        }}
                      >
                        {stat.count}
                      </div>
                      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                        {stat.label}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </Card>

            <Card
              variant="elevated"
              title={t("devices.satellites.title")}
              subtitle={t("devices.satellites.subtitle")}
            >
              <div style={{ display: "flex", justifyContent: "center" }}>
                <OrbitRings
                  size={196}
                  centerLabel={t("devices.satellites.center")}
                  centerSublabel={t("devices.satellites.total", { count: devices.length })}
                  satellites={orbitSatellites}
                />
              </div>
            </Card>
          </div>

          {devicesError ? (
            <Card title={t("devices.list.error.title")} data-testid="devices-error-state">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "var(--space-4)",
                }}
              >
                <p style={{ margin: 0, color: "var(--status-danger)" }}>{devicesError.message}</p>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<RefreshCw size={15} />}
                  onClick={() => void refetchDevices()}
                >
                  {t("devices.common.retry")}
                </Button>
              </div>
            </Card>
          ) : devicesLoading && !devicesData ? (
            <Card title={t("devices.list.loading")} data-testid="devices-loading-state">
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                <Skeleton height="3.5rem" />
                <Skeleton height="3.5rem" />
                <Skeleton height="3.5rem" />
              </div>
            </Card>
          ) : devices.length === 0 ? (
            <EmptyState
              data-testid="devices-empty-state"
              title={t("devices.list.empty.title")}
              description={t("devices.list.empty.description")}
              action={
                <Button
                  variant="primary"
                  icon={<Plus size={16} />}
                  onClick={() => setAddDeviceOpen(true)}
                >
                  {t("devices.page.add")}
                </Button>
              }
            />
          ) : (
            DEVICE_GROUPS.map((group) => {
              const items = devices.filter((d) => group.kinds.includes(d.kind));
              if (items.length === 0) return null;

              return (
                <Card
                  key={group.id}
                  data-testid={`device-group-${group.id}`}
                  title={t(group.titleKey)}
                  subtitle={t(group.subtitleKey)}
                  actions={
                    <Badge variant="neutral" className="tabular-nums">
                      {t("devices.group.count", { count: items.length })}
                    </Badge>
                  }
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(min(19rem, 100%), 1fr))",
                      gap: "var(--space-4)",
                    }}
                  >
                    {items.map((dev) => {
                      const boundAnimal = dev.boundAnimalId
                        ? (animalById.get(dev.boundAnimalId) ?? null)
                        : null;
                      const wearable = isWearableKind(dev.kind);
                      const statusVariant =
                        dev.status === "online" ? "ok" : dev.status === "error" ? "danger" : "warn";

                      return (
                        <div
                          key={dev.id}
                          data-testid={`device-card-${dev.serial ?? dev.id}`}
                          style={{
                            padding: "var(--space-4)",
                            borderRadius: "var(--radius-md)",
                            backgroundColor: "var(--bg-elevated)",
                            border: "1px solid var(--border-subtle)",
                            display: "flex",
                            flexDirection: "column",
                            justifyContent: "space-between",
                            gap: "var(--space-3)",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              gap: "var(--space-2)",
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: "var(--space-2)",
                              }}
                            >
                              <span
                                className="tabular-nums"
                                style={{
                                  fontFamily: "var(--font-mono)",
                                  fontWeight: 700,
                                  fontSize: "var(--text-base)",
                                }}
                              >
                                {dev.serial ?? formatDeviceKindLabel(t, dev.kind)}
                              </span>
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "var(--space-2)",
                                }}
                              >
                                {dev.batteryPct !== null && (
                                  <Badge
                                    variant={dev.batteryPct < 25 ? "warn" : "neutral"}
                                    icon={<Battery size={12} />}
                                    className="tabular-nums"
                                  >
                                    {t("devices.card.battery", { pct: dev.batteryPct })}
                                  </Badge>
                                )}
                                <Badge variant={statusVariant}>
                                  {t(`devices.status.${dev.status}`)}
                                </Badge>
                              </div>
                            </div>

                            <div
                              style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}
                            >
                              <strong>{dev.vendor ?? t("devices.card.vendorFallback")}</strong>
                              {dev.model ? ` · ${dev.model}` : ""}
                            </div>

                            <div
                              className="tabular-nums"
                              style={{
                                fontSize: "var(--text-xs)",
                                color: "var(--text-muted)",
                              }}
                            >
                              {t("devices.card.lastSeen", {
                                time: formatLastSeen(t, dev.lastSeenAt),
                              })}
                            </div>

                            {wearable && (
                              <div
                                style={{
                                  marginTop: "var(--space-1)",
                                  padding: "var(--space-2) var(--space-3)",
                                  borderRadius: "var(--radius-sm)",
                                  backgroundColor: "var(--bg-surface)",
                                  border: "1px solid var(--border-subtle)",
                                  fontSize: "var(--text-xs)",
                                }}
                              >
                                {boundAnimal ? (
                                  <span>
                                    {rich(t("devices.card.wornBy"), {
                                      animal: (
                                        <strong>
                                          {`${boundAnimal.name ?? t("devices.common.unnamed")} (${boundAnimal.earTagNumber ?? boundAnimal.nationalId ?? ""})`}
                                        </strong>
                                      ),
                                    })}
                                  </span>
                                ) : (
                                  <span style={{ color: "var(--text-muted)" }}>
                                    {t("devices.card.spare")}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>

                          {wearable && (
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "var(--space-2)",
                                flexWrap: "wrap",
                              }}
                            >
                              <Button
                                variant={boundAnimal ? "secondary" : "primary"}
                                size="sm"
                                icon={<Link2 size={14} />}
                                data-testid={`device-attach-btn-${dev.serial ?? dev.id}`}
                                onClick={() => setBindingDevice(dev)}
                              >
                                {boundAnimal ? t("devices.card.move") : t("devices.bind.attach")}
                              </Button>
                              {boundAnimal && (
                                <Button
                                  variant="subtle"
                                  size="sm"
                                  icon={<Unlink size={14} />}
                                  data-testid={`device-unbind-btn-${dev.serial ?? dev.id}`}
                                  onClick={() => void handleUnbindDevice(dev)}
                                >
                                  {t("devices.card.unbind")}
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </Card>
              );
            })
          )}
        </div>
      ) : (
        <div
          data-testid="devices-connections-panel"
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}
        >
          {connectorsError ? (
            <Card title={t("devices.connectors.error.title")} data-testid="connectors-error-state">
              <p style={{ margin: 0, color: "var(--status-danger)" }}>{connectorsError.message}</p>
            </Card>
          ) : connectorsLoading && !connectorsData ? (
            <Card title={t("devices.connectors.loading")} data-testid="connectors-loading-state">
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                <Skeleton height="4rem" />
                <Skeleton height="4rem" />
              </div>
            </Card>
          ) : connectors.length > 0 ? (
            <Card title={t("devices.connectors.title")} subtitle={t("devices.connectors.subtitle")}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(min(22rem, 100%), 1fr))",
                  gap: "var(--space-4)",
                }}
              >
                {connectors.map((conn) => {
                  const statusVariant = conn.lastError ? "danger" : conn.enabled ? "ok" : "neutral";
                  const statusLabel = conn.lastError
                    ? t("devices.connector.status.error")
                    : conn.enabled
                      ? t("devices.connector.status.enabled")
                      : t("devices.connector.status.paused");

                  return (
                    <div
                      key={conn.id}
                      data-testid={`connector-card-${conn.vendor}`}
                      style={{
                        padding: "var(--space-4)",
                        borderRadius: "var(--radius-md)",
                        backgroundColor: "var(--bg-elevated)",
                        border: "1px solid var(--border-subtle)",
                        display: "flex",
                        flexDirection: "column",
                        justifyContent: "space-between",
                        gap: "var(--space-4)",
                      }}
                    >
                      <div
                        style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "var(--space-2)",
                          }}
                        >
                          <span
                            style={{
                              fontFamily: "var(--font-display)",
                              fontSize: "var(--text-lg)",
                              fontWeight: 700,
                            }}
                          >
                            {conn.name ?? formatVendorLabel(t, conn.vendor)}
                          </span>
                          <Badge variant={statusVariant}>{statusLabel}</Badge>
                        </div>

                        <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                          {rich(
                            t("devices.connector.meta", { mode: t(`devices.mode.${conn.kind}`) }),
                            { vendor: <strong>{formatVendorLabel(t, conn.vendor)}</strong> },
                          )}
                        </div>

                        <div
                          className="tabular-nums"
                          style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}
                        >
                          {t("devices.connector.lastSync", {
                            time: formatLastSeen(t, conn.lastSyncAt),
                          })}
                        </div>

                        {conn.lastError && (
                          <div
                            style={{
                              padding: "var(--space-2) var(--space-3)",
                              borderRadius: "var(--radius-sm)",
                              backgroundColor: "var(--status-danger-bg)",
                              border: "1px solid var(--status-danger-border)",
                              color: "var(--status-danger)",
                              fontSize: "var(--text-xs)",
                            }}
                          >
                            {conn.lastError}
                          </div>
                        )}
                      </div>

                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "var(--space-2)",
                          flexWrap: "wrap",
                        }}
                      >
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={togglingConnectorId === conn.id}
                          data-testid={`connector-toggle-${conn.vendor}`}
                          onClick={() => void handleToggleConnector(conn)}
                        >
                          {conn.enabled
                            ? t("devices.connector.turnOff")
                            : t("devices.connector.turnOn")}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<KeyRound size={14} />}
                          data-testid={`connector-password-${conn.vendor}`}
                          onClick={() => setPasswordConnector(conn)}
                        >
                          {t("devices.connector.password")}
                        </Button>
                        <Button
                          variant="primary"
                          size="sm"
                          icon={<RefreshCw size={14} />}
                          loading={syncingConnectorId === conn.id}
                          disabled={!conn.enabled}
                          data-testid={`connector-sync-${conn.vendor}`}
                          onClick={() => void handleSyncNow(conn)}
                        >
                          {t("devices.connector.syncNow")}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          ) : null}

          <ConnectorPasswordDialog
            connector={passwordConnector}
            onClose={() => setPasswordConnector(null)}
            onSaved={() => {
              setPasswordConnector(null);
              void refetchConnectors();
            }}
          />

          <Card
            variant="elevated"
            data-testid="connect-something-new-card"
            title={t("devices.connectNew.title")}
            subtitle={t("devices.connectNew.subtitle")}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: "var(--space-4)",
              }}
            >
              <p
                style={{
                  margin: 0,
                  fontSize: "var(--text-base)",
                  color: "var(--text-secondary)",
                  maxInlineSize: "62ch",
                }}
              >
                {t("devices.connectNew.body")}
              </p>
              <Button
                variant="primary"
                size="lg"
                icon={<Sparkles size={18} />}
                data-testid="connect-something-new-btn"
                onClick={() =>
                  navigate(`/chat?prompt=${encodeURIComponent(t("devices.connectNew.prompt"))}`)
                }
              >
                {t("devices.connectNew.button")}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {bindingDevice && (
        <AttachDeviceDialog
          open={Boolean(bindingDevice)}
          onClose={() => setBindingDevice(null)}
          device={bindingDevice}
          animals={animals}
          onCompleted={async () => {
            await Promise.all([refetchDevices(), refetchAnimals()]);
          }}
        />
      )}

      {addDeviceOpen && (
        <AddDeviceDialog
          open={addDeviceOpen}
          onClose={() => setAddDeviceOpen(false)}
          onSaved={async () => {
            await refetchDevices();
          }}
        />
      )}
    </div>
  );
}

export default DevicesPage;
