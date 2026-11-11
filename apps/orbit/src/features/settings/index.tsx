import type { Settings, SnapshotSummary, ThinkingLevel } from "@orbit/protocol";
import {
  Clock,
  Cpu,
  FolderOpen,
  History,
  Languages,
  RefreshCw,
  RotateCcw,
  Scale,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router";
import { Badge, Button, Card, EmptyState, Select, Skeleton, useToast } from "../../design";
import { isLocale, LOCALE_NAMES, LOCALES, type MessageKey, useI18n } from "../../i18n";
import { useOrion, useOrionEvent } from "../../lib/orion";
import { AccountCard, AccountSection, BillingSection } from "./AccountCard";
import { FeedbackCard } from "./FeedbackCard";
import { OrbitModulesCard } from "./OrbitModulesCard";
import { ProvidersCard } from "./ProvidersCard";
import { YourOrbitCard } from "./YourOrbitCard";

export { AccountCard, AccountSection, BillingSection, OrbitModulesCard };

const THINKING_OPTIONS: { value: ThinkingLevel; labelKey: MessageKey }[] = [
  { value: "off", labelKey: "settings.thinking.off" },
  { value: "minimal", labelKey: "settings.thinking.minimal" },
  { value: "low", labelKey: "settings.thinking.low" },
  { value: "medium", labelKey: "settings.thinking.medium" },
  { value: "high", labelKey: "settings.thinking.high" },
  { value: "xhigh", labelKey: "settings.thinking.xhigh" },
];

const COMMON_PROVIDERS = ["anthropic", "openai", "google", "orbit-gateway", "orion-mock"];

const SNAPSHOT_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

function defaultPlatformDataPath(): string {
  if (typeof navigator === "undefined") {
    return "~/Library/Application Support/Orbit";
  }
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("win")) return "%APPDATA%\\Orbit";
  if (ua.includes("linux")) return "~/.local/share/Orbit";
  return "~/Library/Application Support/Orbit";
}

export default function SettingsPage() {
  const { client, state: connState, endpoint } = useOrion();
  const { pushToast } = useToast();
  const { t, locale, setLocale, formatDate } = useI18n();
  const location = useLocation();
  const formatSnapshotTimestamp = (iso: string) => formatDate(iso, SNAPSHOT_TIME_FORMAT);

  useEffect(() => {
    const hash = location.hash.replace(/^#/, "");
    if (!hash) return;
    const el = document.getElementById(hash);
    el?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [location.hash]);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedThinking, setSelectedThinking] = useState<ThinkingLevel>("off");
  const [savingModel, setSavingModel] = useState(false);

  const [undoingId, setUndoingId] = useState<string | null>(null);
  const [savingSharing, setSavingSharing] = useState(false);

  const loadAll = useCallback(async (): Promise<Settings | null> => {
    if (!client) return null;
    setLoading(true);
    try {
      const [loadedSettings, loadedSnapshots] = await Promise.all([
        client.request("settings.get"),
        client.request("snapshots.list", { limit: 30 }),
      ]);
      setSettings(loadedSettings);
      setSnapshots(loadedSnapshots.snapshots);

      const initialProvider =
        loadedSettings.provider ?? loadedSettings.availableModels[0]?.provider ?? "orion-mock";
      const initialModel =
        loadedSettings.model ??
        loadedSettings.availableModels.find((m) => m.provider === initialProvider)?.id ??
        loadedSettings.availableModels[0]?.id ??
        "";

      setSelectedProvider(initialProvider);
      setSelectedModel(initialModel);
      setSelectedThinking(loadedSettings.thinkingLevel);
      return loadedSettings;
    } catch (err) {
      pushToast({
        title: t("settings.toast.loadFailed"),
        description: err instanceof Error ? err.message : String(err),
        tone: "warn",
      });
      return null;
    } finally {
      setLoading(false);
    }
  }, [client, pushToast, t]);

  useEffect(() => {
    if (!client) return;
    if (connState === "open" || connState === "connecting") {
      void loadAll();
    }
  }, [client, connState, loadAll]);
  // Signing in or out switches the default model to or from the Orbit cloud model.
  useOrionEvent("account.updated", () => void loadAll());

  useEffect(() => {
    if (!client) return;
    return client.on("db.changed", () => {
      void client
        .request("snapshots.list", { limit: 30 })
        .then((res) => setSnapshots(res.snapshots))
        .catch(() => undefined);
    });
  }, [client]);

  const providersList = useMemo(() => {
    const set = new Set<string>();
    for (const m of settings?.availableModels ?? []) {
      set.add(m.provider);
    }
    if (settings?.provider) set.add(settings.provider);
    for (const p of Object.keys(settings?.apiKeys ?? {})) {
      set.add(p);
    }
    if (set.size === 0) {
      for (const p of COMMON_PROVIDERS) set.add(p);
    }
    return [...set];
  }, [settings]);

  const modelsForProvider = useMemo(() => {
    return (settings?.availableModels ?? []).filter((m) => m.provider === selectedProvider);
  }, [settings, selectedProvider]);

  const handleProviderChange = (nextProvider: string) => {
    setSelectedProvider(nextProvider);
    const firstModel = (settings?.availableModels ?? []).find((m) => m.provider === nextProvider);
    setSelectedModel(firstModel?.id ?? "");
  };

  const handleProvidersChanged = async (connectedProviderId?: string) => {
    const loaded = await loadAll();
    const first = loaded?.availableModels.find((m) => m.provider === connectedProviderId);
    if (connectedProviderId && first) {
      setSelectedProvider(connectedProviderId);
      setSelectedModel(first.id);
    }
  };

  const handleSaveModelSettings = async () => {
    if (!client) return;
    setSavingModel(true);
    try {
      const updated = await client.request("settings.update", {
        provider: selectedProvider || null,
        model: selectedModel || null,
        thinkingLevel: selectedThinking,
      });
      setSettings(updated);
      pushToast({
        title: t("settings.toast.modelSaved"),
        description:
          updated.provider && updated.model
            ? t("settings.toast.modelSavedDesc", { model: `${updated.provider}/${updated.model}` })
            : t("settings.toast.modelSavedDefault"),
        tone: "ok",
      });
    } catch (err) {
      pushToast({
        title: t("settings.toast.modelSaveFailed"),
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    } finally {
      setSavingModel(false);
    }
  };

  const handleShareDataChange = async (shareAnonymousData: boolean) => {
    if (!client) return;
    setSavingSharing(true);
    try {
      setSettings(await client.request("settings.update", { shareAnonymousData }));
    } catch (err) {
      pushToast({
        title: t("settings.privacy.saveFailed"),
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    } finally {
      setSavingSharing(false);
    }
  };

  const handleUndoSnapshot = async (snapshotId: string) => {
    if (!client) return;
    setUndoingId(snapshotId);
    try {
      const res = await client.request("snapshots.undo", { snapshotId });
      setSnapshots((prev) => prev.map((s) => (s.id === snapshotId ? res.snapshot : s)));
      pushToast({
        title: t("settings.toast.undone"),
        description: t("settings.toast.undoneDesc", { description: res.snapshot.description }),
        tone: "ok",
      });
    } catch (err) {
      pushToast({
        title: t("settings.toast.undoFailed"),
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    } finally {
      setUndoingId(null);
    }
  };

  const latestUndoableSnapshot = useMemo(() => {
    return snapshots.find((s) => s.undoneAt === null) ?? null;
  }, [snapshots]);

  const dataFolderPath = defaultPlatformDataPath();

  return (
    <div className="orbit-container" data-testid="settings-page">
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
          <h1
            style={{
              margin: 0,
              fontFamily: "var(--font-display)",
              fontSize: "var(--text-h1)",
              fontWeight: 700,
              lineHeight: "var(--leading-tight)",
              letterSpacing: "var(--tracking-display)",
            }}
          >
            {t("settings.title")}
          </h1>
          <p
            style={{
              margin: "var(--space-2) 0 0 0",
              color: "var(--text-secondary)",
              fontSize: "var(--text-base)",
            }}
          >
            {t("settings.intro")}
          </p>
        </div>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => void loadAll()}
          icon={<RefreshCw size={15} />}
          data-testid="settings-refresh-button"
        >
          {t("settings.refresh")}
        </Button>
      </header>

      <AccountSection />

      <Card
        title={t("settings.language.title")}
        subtitle={t("settings.language.subtitle")}
        actions={
          <Badge variant="neutral" icon={<Languages size={12} />}>
            {LOCALE_NAMES[locale]}
          </Badge>
        }
      >
        <Select
          label={t("settings.language.label")}
          value={locale}
          onChange={(e) => {
            if (isLocale(e.target.value)) setLocale(e.target.value);
          }}
          options={LOCALES.map((code) => ({ value: code, label: LOCALE_NAMES[code] }))}
          hint={t("settings.language.hint")}
          data-testid="settings-language-select"
        />
      </Card>

      <div className="orbit-split-grid">
        <Card
          title={t("settings.model.title")}
          subtitle={t("settings.model.subtitle")}
          actions={
            <Badge variant="accent" icon={<Cpu size={12} />}>
              {settings?.provider && settings?.model
                ? `${settings.provider}/${settings.model}`
                : t("settings.model.default")}
            </Badge>
          }
        >
          {loading && !settings ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-3)",
              }}
            >
              <Skeleton height="2.75rem" />
              <Skeleton height="2.75rem" />
              <Skeleton height="2.75rem" />
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-4)",
              }}
            >
              <Select
                label={t("settings.model.provider")}
                value={selectedProvider}
                onChange={(e) => handleProviderChange(e.target.value)}
                options={providersList.map((p) => ({
                  value: p,
                  label:
                    p === "orion-mock"
                      ? t("settings.model.providerMock")
                      : p === "orbit-gateway"
                        ? t("settings.model.providerGateway")
                        : p,
                }))}
                data-testid="settings-provider-select"
              />

              <Select
                label={t("settings.model.model")}
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                options={
                  modelsForProvider.length > 0
                    ? modelsForProvider.map((m) => ({
                        value: m.id,
                        label: `${m.name} (${m.id})`,
                      }))
                    : [
                        {
                          value: selectedModel || "mock-1",
                          label: selectedModel || "mock-1",
                        },
                      ]
                }
                hint={t("settings.model.modelHint")}
                data-testid="settings-model-select"
              />

              <Select
                label={t("settings.model.thinking")}
                value={selectedThinking}
                onChange={(e) => setSelectedThinking(e.target.value as ThinkingLevel)}
                options={THINKING_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                hint={t("settings.model.thinkingHint")}
                data-testid="settings-thinking-select"
              />

              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <Button
                  variant="primary"
                  loading={savingModel}
                  onClick={handleSaveModelSettings}
                  data-testid="settings-save-model-button"
                >
                  {t("settings.model.save")}
                </Button>
              </div>
            </div>
          )}
        </Card>

        <ProvidersCard onChanged={(id) => void handleProvidersChanged(id)} />
      </div>

      <Card
        title={t("settings.undo.title")}
        subtitle={t("settings.undo.subtitle")}
        actions={
          latestUndoableSnapshot ? (
            <Button
              variant="primary"
              size="sm"
              loading={undoingId === latestUndoableSnapshot.id}
              onClick={() => handleUndoSnapshot(latestUndoableSnapshot.id)}
              icon={<RotateCcw size={15} />}
              data-testid="settings-undo-last-button"
            >
              {t("settings.undo.last")}
            </Button>
          ) : (
            <Badge variant="neutral" icon={<History size={12} />}>
              {t("settings.undo.upToDate")}
            </Badge>
          )
        }
      >
        {snapshots.length === 0 ? (
          <EmptyState
            title={t("settings.undo.emptyTitle")}
            description={t("settings.undo.emptyDesc")}
          />
        ) : (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-3)",
            }}
            data-testid="settings-snapshots-list"
          >
            {snapshots.map((snap) => {
              const isUndone = snap.undoneAt !== null;
              return (
                <li
                  key={snap.id}
                  data-testid={`settings-snapshot-row-${snap.id}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: "var(--space-3)",
                    padding: "var(--space-3) var(--space-4)",
                    borderRadius: "var(--radius-md)",
                    backgroundColor: "var(--bg-elevated)",
                    border: "1px solid var(--border-subtle)",
                    opacity: isUndone ? 0.72 : 1,
                  }}
                >
                  <div style={{ minInlineSize: 0, flex: 1 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        flexWrap: "wrap",
                        gap: "var(--space-2)",
                      }}
                    >
                      <span
                        style={{
                          fontWeight: 650,
                          fontSize: "var(--text-sm)",
                          color: "var(--text-primary)",
                        }}
                      >
                        {snap.description}
                      </span>
                      {snap.tables.map((t) => (
                        <Badge key={t} variant="neutral">
                          {t}
                        </Badge>
                      ))}
                      <Badge variant={isUndone ? "neutral" : "info"}>
                        {isUndone
                          ? t("settings.undo.undone")
                          : t("settings.undo.items", { count: snap.rowCount })}
                      </Badge>
                    </div>
                    <div
                      className="tabular-nums"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "var(--space-1)",
                        marginTop: "var(--space-1)",
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--text-xs)",
                        color: "var(--text-muted)",
                      }}
                    >
                      <Clock size={11} aria-hidden="true" />
                      {formatSnapshotTimestamp(snap.createdAt)}
                      {snap.undoneAt &&
                        t("settings.undo.undoneAt", {
                          time: formatSnapshotTimestamp(snap.undoneAt),
                        })}
                    </div>
                  </div>

                  <div>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={isUndone || undoingId !== null}
                      loading={undoingId === snap.id}
                      onClick={() => handleUndoSnapshot(snap.id)}
                      icon={<RotateCcw size={14} />}
                      data-testid={`settings-snapshot-undo-${snap.id}`}
                    >
                      {isUndone ? t("settings.undo.alreadyUndone") : t("settings.undo.undo")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <OrbitModulesCard />

      <YourOrbitCard />

      <FeedbackCard />

      <Card title={t("settings.privacy.title")} subtitle={t("settings.privacy.subtitle")}>
        <label
          style={{
            display: "flex",
            gap: "var(--space-2)",
            alignItems: "flex-start",
            fontSize: "var(--text-sm)",
          }}
        >
          <input
            type="checkbox"
            checked={settings?.shareAnonymousData ?? true}
            disabled={!settings || savingSharing}
            onChange={(e) => void handleShareDataChange(e.target.checked)}
            data-testid="settings-share-anonymous-data"
          />
          <span>
            {t("settings.privacy.shareData")}
            <br />
            <span style={{ color: "var(--text-secondary)" }}>
              {t("settings.privacy.shareDataHint")}
            </span>
          </span>
        </label>
      </Card>

      <div className="orbit-split-grid">
        <Card
          title={t("settings.data.title")}
          subtitle={t("settings.data.subtitle")}
          actions={
            <Badge variant="ok" icon={<FolderOpen size={12} />}>
              {t("settings.data.badge")}
            </Badge>
          }
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-3)",
              fontSize: "var(--text-sm)",
            }}
          >
            <div>
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: 600,
                  color: "var(--text-secondary)",
                  marginBottom: "var(--space-1)",
                }}
              >
                {t("settings.data.folder")}
              </div>
              <pre className="orbit-code-block" data-testid="settings-data-folder-path">
                {dataFolderPath}
              </pre>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-1)",
                fontSize: "var(--text-xs)",
                color: "var(--text-secondary)",
              }}
            >
              <div>
                <strong>{t("settings.data.dbFile")}</strong>{" "}
                <code style={{ fontFamily: "var(--font-mono)" }}>orbit.sqlite</code>{" "}
                {t("settings.data.dbContents")}
              </div>
              <div>
                <strong>{t("settings.data.endpoint")}</strong>{" "}
                <code
                  style={{ fontFamily: "var(--font-mono)" }}
                  data-testid="settings-orion-endpoint"
                >
                  {endpoint?.url ?? "ws://127.0.0.1:7717/ws"}
                </code>
              </div>
              <div>
                <strong>{t("settings.data.serverVersion")}</strong>{" "}
                <code style={{ fontFamily: "var(--font-mono)" }}>
                  {client?.server?.serverVersion ?? "0.1.0"}
                </code>
              </div>
            </div>
          </div>
        </Card>

        <Card
          title={t("settings.about.title")}
          subtitle={t("settings.about.subtitle")}
          actions={
            <Badge variant="accent" icon={<Scale size={12} />}>
              {t("settings.about.badge")}
            </Badge>
          }
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-3)",
              fontSize: "var(--text-sm)",
              color: "var(--text-secondary)",
            }}
            data-testid="settings-license-card"
          >
            <p style={{ margin: 0, color: "var(--text-primary)" }}>
              <strong>Orbit &amp; Orion</strong> {t("settings.about.licenseBefore")}{" "}
              <strong>GNU Affero General Public License v3.0 (AGPL-3.0-only)</strong>{" "}
              {t("settings.about.licenseAfter")}
            </p>
            <p style={{ margin: 0 }}>{t("settings.about.ownData")}</p>
            <div
              style={{
                padding: "var(--space-2) var(--space-3)",
                borderRadius: "var(--radius-md)",
                backgroundColor: "var(--bg-elevated)",
                border: "1px solid var(--border-subtle)",
                fontSize: "var(--text-xs)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {t("settings.about.footer")}
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
