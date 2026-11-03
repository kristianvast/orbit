import type { AnimalListItem, DeviceInput, DeviceListItem } from "@orbit/protocol";
import type { Connector, DeviceKind, DeviceStatus } from "@orbit/schema";
import { isWearableKind } from "@orbit/schema";
import {
  AlertTriangle,
  Battery,
  Link2,
  MessageSquare,
  Plus,
  RefreshCw,
  Sparkles,
  Unlink,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
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
import { useOrion, useOrionQuery } from "../../lib/orion";

export interface DeviceGroupSpec {
  id: string;
  title: string;
  subtitle: string;
  kinds: DeviceKind[];
}

export const DEVICE_GROUPS: DeviceGroupSpec[] = [
  {
    id: "milking_robot",
    title: "Milking Robots",
    subtitle: "Automated milking boxes and parlour controllers",
    kinds: ["milking_robot"],
  },
  {
    id: "collar",
    title: "Neck Collars",
    subtitle: "Wearable activity & rumination neck transponders",
    kinds: ["collar"],
  },
  {
    id: "bolus",
    title: "Rumen Boluses",
    subtitle: "Internal temperature & drinking boluses",
    kinds: ["bolus"],
  },
  {
    id: "ear_tag_sensor",
    title: "Ear Tag Sensors",
    subtitle: "Electronic ear-mounted movement & ear-temperature tags",
    kinds: ["ear_tag_sensor"],
  },
  {
    id: "other",
    title: "Scales, Feeders & Other Equipment",
    subtitle: "Walk-over weigh scales, automated feeders, and stationary barn sensors",
    kinds: ["scale", "feeder", "camera", "other"],
  },
];

export function formatDeviceKindLabel(kind: DeviceKind | string): string {
  switch (kind) {
    case "milking_robot":
      return "Milking robot";
    case "collar":
      return "Collar";
    case "bolus":
      return "Bolus";
    case "ear_tag_sensor":
      return "Ear tag sensor";
    case "scale":
      return "Scale";
    case "feeder":
      return "Feeder";
    default:
      return kind.replace(/_/g, " ");
  }
}

export function articleForKind(label: string): "a" | "an" {
  return /^[aeiou]/i.test(label.trim()) ? "an" : "a";
}

export function formatKindWithArticle(kind: DeviceKind | string): string {
  const label = formatDeviceKindLabel(kind).toLowerCase();
  return `${articleForKind(label)} ${label}`;
}

export function formatVendorLabel(vendor: string): string {
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
      return "CSV Import";
    default:
      return vendor;
  }
}

export function formatLastSeen(iso: string | null | undefined): string {
  if (!iso) return "Never seen";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "Just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
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
        title: conflictingWearable ? "Replaced wearable sensor" : "Sensor attached to animal",
        description: `${formatDeviceKindLabel(device.kind)} ${device.serial ?? ""} is now attached to ${chosenAnimal?.name ?? chosenAnimal?.earTagNumber ?? "animal"}.`,
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
      title={`Attach ${formatDeviceKindLabel(device.kind)} (${device.serial ?? device.vendor ?? "Sensor"}) to an animal`}
      description="Each cow or horse can wear one collar OR one bolus OR one ear tag sensor — never several at once."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} data-testid="device-bind-cancel-btn">
            Cancel
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
              ? `Replace ${formatDeviceKindLabel(conflictingWearable.kind).toLowerCase()} & attach`
              : currentAnimalHolder && currentAnimalHolder.id !== effectiveAnimalId
                ? "Move sensor to animal"
                : "Attach to animal"}
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
            One wearable sensor per animal
          </div>
          <p style={{ margin: 0 }}>
            In real barns, an animal wears one <strong>collar</strong> OR one <strong>bolus</strong>{" "}
            OR one <strong>ear tag sensor</strong> at a time. If the animal you choose already has a
            sensor, Orbit can replace it for you in one step.
          </p>
        </div>

        <Select
          label="Select cow or horse"
          data-testid="device-bind-animal-select"
          value={effectiveAnimalId}
          onChange={(e) => setSelectedAnimalId(e.target.value)}
          options={
            animals.length > 0
              ? animals.map((a) => {
                  const tagText = a.earTagNumber ?? a.nationalId ?? a.species;
                  const existingText = a.wearable
                    ? ` — wears ${formatKindWithArticle(a.wearable.kind)}`
                    : " — no sensor";
                  return {
                    value: a.id,
                    label: `${a.name ?? "Unnamed"} (${tagText})${existingText}`,
                  };
                })
              : [{ value: "", label: "No animals in herd list" }]
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
            This {formatDeviceKindLabel(device.kind).toLowerCase()} is currently attached to{" "}
            <strong style={{ color: "var(--text-primary)" }}>
              {currentAnimalHolder.name ?? currentAnimalHolder.earTagNumber}
            </strong>
            . Confirming will move it to{" "}
            <strong style={{ color: "var(--text-primary)" }}>
              {chosenAnimal?.name ?? chosenAnimal?.earTagNumber}
            </strong>
            .
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
                {chosenAnimal.name ?? chosenAnimal.earTagNumber} already wears{" "}
                {formatKindWithArticle(conflictingWearable.kind)}
              </span>
            </div>
            <p style={{ margin: "var(--space-1) 0 0 0", fontSize: "var(--text-xs)" }}>
              Because each animal can only wear a collar OR a bolus OR an ear tag sensor, confirming
              below will unbind the current{" "}
              <strong>{formatDeviceKindLabel(conflictingWearable.kind).toLowerCase()}</strong>{" "}
              {conflictingWearable.vendor ? `(${conflictingWearable.vendor}) ` : ""}and attach{" "}
              <strong>
                {formatDeviceKindLabel(device.kind)} {device.serial ?? ""}
              </strong>{" "}
              instead.
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
      setError("Please enter a serial number or tag code for this device.");
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
        title: "Device added",
        description: `${formatDeviceKindLabel(kind)} ${serial.trim()} added to farm equipment.`,
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
      title="Add sensor or robot"
      description="Add a spare collar, bolus, ear tag sensor, milking robot, or scale to your farm."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} data-testid="device-form-cancel">
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="device-add-form"
            loading={saving}
            data-testid="device-form-submit"
          >
            Save device
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
          label="Device kind"
          data-testid="device-form-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as DeviceKind)}
          options={[
            { value: "collar", label: "Collar (wearable)" },
            { value: "bolus", label: "Rumen bolus (wearable)" },
            { value: "ear_tag_sensor", label: "Ear tag sensor (wearable)" },
            { value: "milking_robot", label: "Milking robot" },
            { value: "scale", label: "Weigh scale" },
            { value: "feeder", label: "Feeder" },
            { value: "other", label: "Other equipment" },
          ]}
        />
        <Select
          label="Status"
          data-testid="device-form-status"
          value={status}
          onChange={(e) => setStatus(e.target.value as DeviceStatus)}
          options={[
            { value: "online", label: "Online" },
            { value: "offline", label: "Offline / Spare" },
            { value: "error", label: "Needs service" },
          ]}
        />
        <Input
          label="Vendor / Brand"
          data-testid="device-form-vendor"
          placeholder="e.g. Nedap, smaXtec, CowManager, Lely"
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
        />
        <Input
          label="Model"
          data-testid="device-form-model"
          placeholder="e.g. SmartTag Neck, Climate Bolus"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
        <Input
          label="Serial code"
          data-testid="device-form-serial"
          placeholder="e.g. COL-205"
          value={serial}
          onChange={(e) => setSerial(e.target.value)}
        />
        <Input
          label="Battery % (leave blank if mains powered)"
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

const CATALOG_VENDORS = [
  {
    vendor: "delaval",
    name: "DeLaval DelPro",
    kind: "local_api",
    summary: "Import milking sessions, conductivity, and activity from a local DelPro server.",
  },
  {
    vendor: "allflex",
    name: "Allflex SenseHub",
    kind: "cloud_api",
    summary: "Sync ear tag & neck collar rumination and heat alerts.",
  },
] as const;

export interface DevicesPageProps {
  initialTab?: "devices" | "connections";
}

export function DevicesPage({ initialTab = "devices" }: DevicesPageProps = {}) {
  const navigate = useNavigate();
  const { client } = useOrion();
  const { pushToast } = useToast();

  const [activeTab, setActiveTab] = useState<"devices" | "connections">(initialTab);
  const [bindingDevice, setBindingDevice] = useState<DeviceListItem | null>(null);
  const [addDeviceOpen, setAddDeviceOpen] = useState(false);
  const [syncingConnectorId, setSyncingConnectorId] = useState<string | null>(null);
  const [togglingConnectorId, setTogglingConnectorId] = useState<string | null>(null);

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
      { id: "robots", label: "Robots", ring: 1, angleDeg: -45, tone: "ok", count: robots },
      { id: "other", label: "Scales", ring: 1, angleDeg: 135, tone: "ok", count: other },
      { id: "collars", label: "Collars", ring: 2, angleDeg: 15, tone: "ok", count: collars },
      { id: "boluses", label: "Boluses", ring: 2, angleDeg: 195, tone: "accent", count: boluses },
      { id: "eartags", label: "Ear tags", ring: 3, angleDeg: -110, tone: "ok", count: earTags },
      {
        id: "connectors",
        label: "Connectors",
        ring: 3,
        angleDeg: 70,
        tone: "ok",
        count: connectors.length,
      },
    ];
  }, [devices, connectors]);

  const handleUnbindDevice = async (device: DeviceListItem) => {
    if (!client) return;
    try {
      await client.mutate("bindings.clear", { deviceId: device.id });
      pushToast({
        title: "Sensor unbound",
        description: `${formatDeviceKindLabel(device.kind)} ${device.serial ?? ""} is now a spare sensor.`,
        tone: "ok",
      });
      await Promise.all([refetchDevices(), refetchAnimals()]);
    } catch (err) {
      pushToast({
        title: "Could not unbind sensor",
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
        title: nextEnabled ? "Connector switched on" : "Connector switched off",
        description: `${connector.name ?? formatVendorLabel(connector.vendor)} is now ${nextEnabled ? "enabled" : "paused"}.`,
        tone: "ok",
      });
      await refetchConnectors();
    } catch (err) {
      pushToast({
        title: "Could not update connector",
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
        title: "Sync finished",
        description: `Imported latest readings from ${connector.name ?? formatVendorLabel(connector.vendor)}.`,
        tone: "ok",
      });
      await refetchConnectors();
    } catch (err) {
      pushToast({
        title: "Sync notice",
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
              Sensors & Robots
            </h1>
            <Badge variant="neutral" className="tabular-nums">
              {devices.length} devices · {connectors.length} connections
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
            Milking robots, collars, boluses, ear tag sensors, and vendor connections. Each animal
            wears a collar OR a bolus OR an ear tag sensor — never more than one at a time.
          </p>
        </div>

        <div
          style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}
        >
          <div className="orbit-tablist" role="tablist" aria-label="Sensors and connections tabs">
            <button
              type="button"
              role="tab"
              className="orbit-tab"
              aria-selected={activeTab === "devices"}
              data-testid="devices-tab-equipment"
              onClick={() => setActiveTab("devices")}
            >
              Sensors & Robots ({devices.length})
            </button>
            <button
              type="button"
              role="tab"
              className="orbit-tab"
              aria-selected={activeTab === "connections"}
              data-testid="devices-tab-connections"
              onClick={() => setActiveTab("connections")}
            >
              Connections ({connectors.length})
            </button>
          </div>

          <Button
            variant="primary"
            size="md"
            icon={<Plus size={18} />}
            data-testid="devices-add-btn"
            onClick={() => setAddDeviceOpen(true)}
          >
            Add sensor or robot
          </Button>
        </div>
      </header>

      {activeTab === "devices" ? (
        <div
          data-testid="devices-equipment-panel"
          style={{ display: "flex", flexDirection: "column", gap: "var(--space-6)" }}
        >
          <div className="orbit-home-hero">
            <Card
              title="Equipment Overview"
              subtitle="Milking robots, collars, boluses, and ear tag sensors on this farm"
            >
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
                  Click <strong>Attach to animal</strong> on any spare sensor below to assign it, or{" "}
                  <strong>Move / Replace</strong> to swap a sensor between animals.
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
                      label: "Milking robots",
                      count: devices.filter((d) => d.kind === "milking_robot").length,
                    },
                    {
                      label: "Neck collars",
                      count: devices.filter((d) => d.kind === "collar").length,
                    },
                    {
                      label: "Rumen boluses",
                      count: devices.filter((d) => d.kind === "bolus").length,
                    },
                    {
                      label: "Ear tag sensors",
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
              title="Equipment Satellites"
              subtitle="Robots on inner ring · wearables on middle & outer rings"
            >
              <div style={{ display: "flex", justifyContent: "center" }}>
                <OrbitRings
                  size={196}
                  centerLabel="DEVICES"
                  centerSublabel={`${devices.length} total`}
                  satellites={orbitSatellites}
                />
              </div>
            </Card>
          </div>

          {devicesError ? (
            <Card title="Could not load sensors & robots" data-testid="devices-error-state">
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
                  Retry
                </Button>
              </div>
            </Card>
          ) : devicesLoading && !devicesData ? (
            <Card title="Loading equipment…" data-testid="devices-loading-state">
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                <Skeleton height="3.5rem" />
                <Skeleton height="3.5rem" />
                <Skeleton height="3.5rem" />
              </div>
            </Card>
          ) : devices.length === 0 ? (
            <EmptyState
              data-testid="devices-empty-state"
              title="No sensors or robots added yet"
              description="Add your first collar, bolus, ear tag sensor, or milking robot."
              action={
                <Button
                  variant="primary"
                  icon={<Plus size={16} />}
                  onClick={() => setAddDeviceOpen(true)}
                >
                  Add sensor or robot
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
                  title={group.title}
                  subtitle={group.subtitle}
                  actions={
                    <Badge variant="neutral" className="tabular-nums">
                      {items.length} {items.length === 1 ? "device" : "devices"}
                    </Badge>
                  }
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(19rem, 1fr))",
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
                                {dev.serial ?? formatDeviceKindLabel(dev.kind)}
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
                                    {dev.batteryPct}%
                                  </Badge>
                                )}
                                <Badge variant={statusVariant}>{dev.status}</Badge>
                              </div>
                            </div>

                            <div
                              style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}
                            >
                              <strong>{dev.vendor ?? "Farm sensor"}</strong>
                              {dev.model ? ` · ${dev.model}` : ""}
                            </div>

                            <div
                              className="tabular-nums"
                              style={{
                                fontSize: "var(--text-xs)",
                                color: "var(--text-muted)",
                              }}
                            >
                              Last seen: {formatLastSeen(dev.lastSeenAt)}
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
                                    Worn by{" "}
                                    <strong>
                                      {boundAnimal.name ?? "Unnamed"} (
                                      {boundAnimal.earTagNumber ?? boundAnimal.nationalId})
                                    </strong>
                                  </span>
                                ) : (
                                  <span style={{ color: "var(--text-muted)" }}>
                                    Spare sensor — not attached to an animal
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
                                {boundAnimal ? "Move / Replace" : "Attach to animal"}
                              </Button>
                              {boundAnimal && (
                                <Button
                                  variant="subtle"
                                  size="sm"
                                  icon={<Unlink size={14} />}
                                  data-testid={`device-unbind-btn-${dev.serial ?? dev.id}`}
                                  onClick={() => void handleUnbindDevice(dev)}
                                >
                                  Unbind
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
            <Card title="Could not load connectors" data-testid="connectors-error-state">
              <p style={{ margin: 0, color: "var(--status-danger)" }}>{connectorsError.message}</p>
            </Card>
          ) : connectorsLoading && !connectorsData ? (
            <Card title="Loading connections…" data-testid="connectors-loading-state">
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                <Skeleton height="4rem" />
                <Skeleton height="4rem" />
              </div>
            </Card>
          ) : (
            <Card
              title="Configured Farm Connections"
              subtitle="Vendor software, cloud services, and CSV files saved on this PC"
            >
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(22rem, 1fr))",
                  gap: "var(--space-4)",
                }}
              >
                {connectors.map((conn) => {
                  const statusVariant = conn.lastError ? "danger" : conn.enabled ? "ok" : "neutral";
                  const statusLabel = conn.lastError
                    ? "Sync error"
                    : conn.enabled
                      ? "Enabled"
                      : "Paused";

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
                            {conn.name ?? formatVendorLabel(conn.vendor)}
                          </span>
                          <Badge variant={statusVariant}>{statusLabel}</Badge>
                        </div>

                        <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                          Vendor: <strong>{formatVendorLabel(conn.vendor)}</strong> · Mode:{" "}
                          {conn.kind.replace(/_/g, " ")}
                        </div>

                        <div
                          className="tabular-nums"
                          style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)" }}
                        >
                          Last sync: {formatLastSeen(conn.lastSyncAt)}
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
                          {conn.enabled ? "Turn off" : "Turn on"}
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
                          Sync now
                        </Button>
                      </div>
                    </div>
                  );
                })}

                {CATALOG_VENDORS.map((cat) => (
                  <div
                    key={cat.vendor}
                    data-testid={`connector-catalog-${cat.vendor}`}
                    style={{
                      padding: "var(--space-4)",
                      borderRadius: "var(--radius-md)",
                      backgroundColor: "var(--bg-surface)",
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
                          {cat.name}
                        </span>
                        <Badge variant="neutral">Ready to set up</Badge>
                      </div>
                      <p
                        style={{
                          margin: 0,
                          fontSize: "var(--text-xs)",
                          color: "var(--text-secondary)",
                        }}
                      >
                        {cat.summary}
                      </p>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<MessageSquare size={14} />}
                      data-testid={`connector-setup-${cat.vendor}`}
                      onClick={() =>
                        navigate(
                          `/chat?prompt=${encodeURIComponent(`Help me connect ${cat.name} to my farm`)}`,
                        )
                      }
                    >
                      Set up with Orion
                    </Button>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card
            variant="elevated"
            data-testid="connect-something-new-card"
            title="Connect something new"
            subtitle="Have a different milking parlour, bolus reader, weigh scale, or spreadsheet?"
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
                Orion can build a custom connector for your equipment right on this PC. Tell Orion
                what software or sensor box you use in plain words, and approve its steps when
                ready.
              </p>
              <Button
                variant="primary"
                size="lg"
                icon={<Sparkles size={18} />}
                data-testid="connect-something-new-btn"
                onClick={() =>
                  navigate(
                    `/chat?prompt=${encodeURIComponent(
                      "Help me connect a new sensor or milking system to my farm",
                    )}`,
                  )
                }
              >
                Ask Orion to connect equipment
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
