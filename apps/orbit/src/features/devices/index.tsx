import type { Connector } from "@orbit/schema";
import { KeyRound, MessageSquare, Plug, RefreshCw } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { Badge, Button, Card, Dialog, EmptyState, Input, Skeleton, useToast } from "../../design";
import { type TranslateFn, useT } from "../../i18n";
import { useOrion, useOrionQuery } from "../../lib/orion";

export function formatVendorLabel(t: TranslateFn, vendor: string): string {
  switch (vendor) {
    case "gea":
      return "GEA";
    case "boumatic":
      return "BouMatic";
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

export function DevicesPage() {
  const t = useT();
  const navigate = useNavigate();
  const { client } = useOrion();
  const { pushToast } = useToast();

  const [syncingConnectorId, setSyncingConnectorId] = useState<string | null>(null);
  const [togglingConnectorId, setTogglingConnectorId] = useState<string | null>(null);
  const [passwordConnector, setPasswordConnector] = useState<Connector | null>(null);

  const {
    data: connectorsData,
    loading: connectorsLoading,
    error: connectorsError,
    refetch: refetchConnectors,
  } = useOrionQuery("connectors.list", {}, { refetchTables: ["connectors"] });

  const connectors = connectorsData?.rows ?? [];

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
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "var(--space-4)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <h1
            style={{
              margin: 0,
              fontFamily: "var(--font-display)",
              fontSize: "var(--text-h1)",
              fontWeight: "var(--display-weight)",
              lineHeight: "var(--leading-tight)",
              letterSpacing: "var(--tracking-display)",
            }}
          >
            {t("devices.page.title")}
          </h1>
          {connectors.length > 0 && (
            <Badge variant="neutral" className="tabular-nums">
              {connectors.length}
            </Badge>
          )}
        </div>
      </header>

      {connectorsError ? (
        <Card title={t("devices.connectors.error.title")} data-testid="connectors-error-state">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "var(--space-4)",
            }}
          >
            <p style={{ margin: 0, color: "var(--status-danger)" }}>{connectorsError.message}</p>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw size={15} />}
              onClick={() => void refetchConnectors()}
            >
              {t("devices.common.retry")}
            </Button>
          </div>
        </Card>
      ) : connectorsLoading && !connectorsData ? (
        <Card title={t("devices.connectors.loading")} data-testid="connectors-loading-state">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            <Skeleton height="4rem" />
            <Skeleton height="4rem" />
          </div>
        </Card>
      ) : connectors.length === 0 ? (
        <EmptyState
          icon={<Plug size={22} />}
          title={t("devices.empty.title")}
          action={
            <Button
              variant="primary"
              icon={<MessageSquare size={16} />}
              data-testid="connect-something-new-btn"
              onClick={() =>
                navigate(`/chat?prompt=${encodeURIComponent(t("devices.connectNew.prompt"))}`)
              }
            >
              {t("devices.connectNew.button")}
            </Button>
          }
        />
      ) : (
        <div
          data-testid="devices-connections-panel"
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
                className="orbit-card"
                data-testid={`connector-card-${conn.vendor}`}
                style={{
                  padding: "var(--space-5)",
                  justifyContent: "space-between",
                  gap: "var(--space-4)",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
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
                        fontFamily: "var(--font-sans)",
                        fontSize: "var(--text-h3)",
                        fontWeight: 600,
                      }}
                    >
                      {conn.name ?? formatVendorLabel(t, conn.vendor)}
                    </span>
                    <Badge variant={statusVariant}>{statusLabel}</Badge>
                  </div>

                  <div style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
                    <strong>{formatVendorLabel(t, conn.vendor)}</strong>
                    {" · "}
                    {t(`devices.mode.${conn.kind}`)}
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
                    {conn.enabled ? t("devices.connector.turnOff") : t("devices.connector.turnOn")}
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
      )}

      <ConnectorPasswordDialog
        connector={passwordConnector}
        onClose={() => setPasswordConnector(null)}
        onSaved={() => {
          setPasswordConnector(null);
          void refetchConnectors();
        }}
      />
    </div>
  );
}

export default DevicesPage;
