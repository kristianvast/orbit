import type { ApprovalMode, Settings, SnapshotSummary, ThinkingLevel } from "@orbit/protocol";
import {
  CheckCircle2,
  Clock,
  Cpu,
  FolderOpen,
  History,
  KeyRound,
  RefreshCw,
  RotateCcw,
  Scale,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, EmptyState, Input, Select, Skeleton, useToast } from "../../design";
import { useOrion } from "../../lib/orion";

const THINKING_OPTIONS: { value: ThinkingLevel; label: string }[] = [
  { value: "off", label: "Off (fastest replies)" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium (balanced)" },
  { value: "high", label: "High (thorough checks)" },
  { value: "xhigh", label: "Extra high" },
];

const APPROVAL_MODES: {
  mode: ApprovalMode;
  title: string;
  description: string;
  badge: string;
}[] = [
  {
    mode: "ask",
    title: "Ask every time",
    description:
      "Orion asks for your permission before updating herd records, binding sensors, scanning for cameras, or editing files in the farm workspace.",
    badge: "Recommended",
  },
  {
    mode: "auto",
    title: "Auto-approve normal actions (dangerous actions always ask)",
    description:
      "Orion runs normal farm and workspace tools automatically. Deleting files, changing network/firewall rules, installing software, or touching files outside the workspace always ask.",
    badge: "Hands-free",
  },
  {
    mode: "read_only",
    title: "Read-only mode",
    description:
      "Orion can look up cows, horses, sensors, and alerts, but cannot make any changes or run commands.",
    badge: "View only",
  },
];

const COMMON_PROVIDERS = ["anthropic", "openai", "google", "orbit-gateway", "orion-mock"];

function formatSnapshotTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

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

  const [settings, setSettings] = useState<Settings | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedProvider, setSelectedProvider] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedThinking, setSelectedThinking] = useState<ThinkingLevel>("off");
  const [savingModel, setSavingModel] = useState(false);

  const [keyProvider, setKeyProvider] = useState<string>("anthropic");
  const [apiKeyInput, setApiKeyInput] = useState<string>("");
  const [savingKey, setSavingKey] = useState(false);

  const [savingApprovalMode, setSavingApprovalMode] = useState<ApprovalMode | null>(null);
  const [undoingId, setUndoingId] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    if (!client) return;
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
    } catch (err) {
      pushToast({
        title: "Could not load settings",
        description: err instanceof Error ? err.message : String(err),
        tone: "warn",
      });
    } finally {
      setLoading(false);
    }
  }, [client, pushToast]);

  useEffect(() => {
    if (!client) return;
    if (connState === "open" || connState === "connecting") {
      void loadAll();
    }
  }, [client, connState, loadAll]);

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

  const keyProvidersList = useMemo(() => {
    const set = new Set<string>(COMMON_PROVIDERS);
    for (const p of providersList) set.add(p);
    return [...set];
  }, [providersList]);

  const modelsForProvider = useMemo(() => {
    return (settings?.availableModels ?? []).filter((m) => m.provider === selectedProvider);
  }, [settings, selectedProvider]);

  const handleProviderChange = (nextProvider: string) => {
    setSelectedProvider(nextProvider);
    const firstModel = (settings?.availableModels ?? []).find((m) => m.provider === nextProvider);
    setSelectedModel(firstModel?.id ?? "");
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
        title: "Model settings saved",
        description:
          updated.provider && updated.model
            ? `Orion will use ${updated.provider}/${updated.model}.`
            : "Updated Orion model preferences.",
        tone: "ok",
      });
    } catch (err) {
      pushToast({
        title: "Could not save model settings",
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    } finally {
      setSavingModel(false);
    }
  };

  const handleSaveApiKey = async () => {
    const trimmed = apiKeyInput.trim();
    if (!client || !keyProvider || !trimmed) return;
    setSavingKey(true);
    try {
      const updated = await client.request("settings.update", {
        apiKey: { provider: keyProvider, key: trimmed },
      });
      setSettings(updated);
      setApiKeyInput("");
      pushToast({
        title: "API key stored in keychain",
        description: `Saved key for ${keyProvider}. The raw key is never echoed back.`,
        tone: "ok",
      });
    } catch (err) {
      pushToast({
        title: "Could not save API key",
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    } finally {
      setSavingKey(false);
    }
  };

  const handleRemoveApiKey = async (provider: string) => {
    if (!client) return;
    setSavingKey(true);
    try {
      const updated = await client.request("settings.update", {
        apiKey: { provider, key: null },
      });
      setSettings(updated);
      pushToast({
        title: `Removed ${provider} API key`,
        tone: "info",
      });
    } catch (err) {
      pushToast({
        title: "Could not remove API key",
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    } finally {
      setSavingKey(false);
    }
  };

  const handleSelectApprovalMode = async (mode: ApprovalMode) => {
    if (!client) return;
    setSavingApprovalMode(mode);
    try {
      const updated = await client.request("settings.update", {
        approvalMode: mode,
      });
      setSettings(updated);
      pushToast({
        title: "Approval mode updated",
        description:
          mode === "ask"
            ? "Orion will ask before changing records or running commands."
            : mode === "auto"
              ? "Normal farm actions will run automatically; dangerous actions still ask."
              : "Orion is now in read-only mode.",
        tone: "ok",
      });
    } catch (err) {
      pushToast({
        title: "Could not update approval mode",
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    } finally {
      setSavingApprovalMode(null);
    }
  };

  const handleRemoveAlwaysAllow = async (toolName: string) => {
    if (!client || !settings) return;
    const nextList = settings.alwaysAllow.filter((t) => t !== toolName);
    try {
      const updated = await client.request("settings.update", {
        alwaysAllow: nextList,
      });
      setSettings(updated);
      pushToast({
        title: `Removed "${toolName}" from always-allowed tools`,
        tone: "info",
      });
    } catch (err) {
      pushToast({
        title: "Could not update always-allowed list",
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    }
  };

  const handleUndoSnapshot = async (snapshotId: string) => {
    if (!client) return;
    setUndoingId(snapshotId);
    try {
      const res = await client.request("snapshots.undo", { snapshotId });
      setSnapshots((prev) => prev.map((s) => (s.id === snapshotId ? res.snapshot : s)));
      pushToast({
        title: "Change undone",
        description: `Restored "${res.snapshot.description}".`,
        tone: "ok",
      });
    } catch (err) {
      pushToast({
        title: "Could not undo change",
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
            Settings
          </h1>
          <p
            style={{
              margin: "var(--space-2) 0 0 0",
              color: "var(--text-secondary)",
              fontSize: "var(--text-base)",
            }}
          >
            Configure Orion&apos;s AI model, API keys, approval rules, local data folder, and undo
            recent changes.
          </p>
        </div>

        <Button
          variant="secondary"
          size="sm"
          onClick={() => void loadAll()}
          icon={<RefreshCw size={15} />}
          data-testid="settings-refresh-button"
        >
          Refresh
        </Button>
      </header>

      <div className="orbit-split-grid">
        <Card
          title="AI Model & Thinking"
          subtitle="Choose which provider and model Orion uses when answering questions"
          actions={
            <Badge variant="accent" icon={<Cpu size={12} />}>
              {settings?.provider && settings?.model
                ? `${settings.provider}/${settings.model}`
                : "Default"}
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
                label="AI Provider"
                value={selectedProvider}
                onChange={(e) => handleProviderChange(e.target.value)}
                options={providersList.map((p) => ({
                  value: p,
                  label:
                    p === "orion-mock"
                      ? "orion-mock (Local offline test model)"
                      : p === "orbit-gateway"
                        ? "orbit-gateway (Orbit subscription)"
                        : p,
                }))}
                data-testid="settings-provider-select"
              />

              <Select
                label="Model"
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
                hint="Models come from the local Pi runtime and configured providers."
                data-testid="settings-model-select"
              />

              <Select
                label="Thinking Depth"
                value={selectedThinking}
                onChange={(e) => setSelectedThinking(e.target.value as ThinkingLevel)}
                options={THINKING_OPTIONS}
                hint="Higher thinking depth takes longer but checks complex herd data more carefully."
                data-testid="settings-thinking-select"
              />

              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <Button
                  variant="primary"
                  loading={savingModel}
                  onClick={handleSaveModelSettings}
                  data-testid="settings-save-model-button"
                >
                  Save model settings
                </Button>
              </div>
            </div>
          )}
        </Card>

        <Card
          title="Provider API Keys"
          subtitle="Stored securely in your system keychain — stored keys are never echoed back"
          actions={
            <Badge variant="neutral" icon={<KeyRound size={12} />}>
              Keychain protected
            </Badge>
          }
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-4)",
            }}
          >
            <Select
              label="Provider for API key"
              value={keyProvider}
              onChange={(e) => setKeyProvider(e.target.value)}
              options={keyProvidersList.map((p) => ({
                value: p,
                label: p,
              }))}
              data-testid="settings-apikey-provider-select"
            />

            <Input
              type="password"
              label="New API Key"
              placeholder="Paste API key (e.g. sk-...)"
              autoComplete="off"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              hint="Once saved, the input is cleared and only the last 4 characters are shown as a hint."
              data-testid="settings-apikey-input"
            />

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <Button
                variant="primary"
                loading={savingKey}
                disabled={!apiKeyInput.trim()}
                onClick={handleSaveApiKey}
                data-testid="settings-save-apikey-button"
              >
                Save API key
              </Button>
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-2)",
                paddingBlockStart: "var(--space-2)",
                borderBlockStart: "1px solid var(--border-subtle)",
              }}
            >
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: 600,
                  color: "var(--text-secondary)",
                }}
              >
                Configured Keys
              </span>

              {Object.entries(settings?.apiKeys ?? {}).length === 0 ? (
                <p
                  style={{
                    margin: 0,
                    fontSize: "var(--text-xs)",
                    color: "var(--text-muted)",
                  }}
                >
                  No external API keys stored yet.
                </p>
              ) : (
                <ul
                  style={{
                    listStyle: "none",
                    margin: 0,
                    padding: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--space-2)",
                  }}
                  data-testid="settings-configured-keys-list"
                >
                  {Object.entries(settings?.apiKeys ?? {}).map(([provider, info]) => (
                    <li
                      key={provider}
                      data-testid={`settings-key-row-${provider}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "var(--space-3)",
                        padding: "var(--space-2) var(--space-3)",
                        borderRadius: "var(--radius-md)",
                        backgroundColor: "var(--bg-elevated)",
                        border: "1px solid var(--border-subtle)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "var(--space-2)",
                        }}
                      >
                        <span
                          style={{
                            fontWeight: 650,
                            fontSize: "var(--text-sm)",
                          }}
                        >
                          {provider}
                        </span>
                        <Badge variant="ok" icon={<CheckCircle2 size={11} />}>
                          Configured
                        </Badge>
                        {info.hint && (
                          <span
                            className="tabular-nums"
                            data-testid={`settings-key-hint-${provider}`}
                            style={{
                              fontFamily: "var(--font-mono)",
                              fontSize: "var(--text-xs)",
                              color: "var(--text-muted)",
                            }}
                          >
                            {info.hint}
                          </span>
                        )}
                      </div>
                      {provider !== "orion-mock" && (
                        <Button
                          variant="subtle"
                          size="sm"
                          onClick={() => handleRemoveApiKey(provider)}
                          icon={<Trash2 size={14} />}
                          data-testid={`settings-remove-key-${provider}`}
                        >
                          Remove
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Card>
      </div>

      <Card
        title="Command Approval Rules"
        subtitle="AI can make mistakes. Choose when Orion must ask for your permission before acting."
        actions={
          <Badge
            variant={settings?.approvalMode === "auto" ? "warn" : "ok"}
            icon={
              settings?.approvalMode === "auto" ? (
                <ShieldAlert size={12} />
              ) : (
                <ShieldCheck size={12} />
              )
            }
          >
            {settings?.approvalMode === "ask"
              ? "Ask every time"
              : settings?.approvalMode === "auto"
                ? "Auto-approve normal"
                : "Read-only"}
          </Badge>
        }
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-4)",
          }}
        >
          <div
            role="radiogroup"
            aria-label="Approval mode"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(min(18rem, 100%), 1fr))",
              gap: "var(--space-3)",
            }}
          >
            {APPROVAL_MODES.map((option) => {
              const isSelected = settings?.approvalMode === option.mode;
              return (
                <div
                  key={option.mode}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    gap: "var(--space-3)",
                    padding: "var(--space-4)",
                    borderRadius: "var(--radius-lg)",
                    backgroundColor: isSelected
                      ? "var(--accent-primary-subtle)"
                      : "var(--bg-elevated)",
                    border: `1px solid ${
                      isSelected ? "var(--accent-primary-border)" : "var(--border-subtle)"
                    }`,
                  }}
                  data-testid={`settings-approval-card-${option.mode}`}
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
                        style={{
                          fontFamily: "var(--font-display)",
                          fontSize: "var(--text-base)",
                          fontWeight: 700,
                          color: "var(--text-primary)",
                        }}
                      >
                        {option.title}
                      </span>
                      <Badge variant={isSelected ? "accent" : "neutral"}>
                        {isSelected ? "Active" : option.badge}
                      </Badge>
                    </div>
                    <p
                      style={{
                        margin: 0,
                        fontSize: "var(--text-sm)",
                        color: "var(--text-secondary)",
                      }}
                    >
                      {option.description}
                    </p>
                  </div>

                  <Button
                    variant={isSelected ? "primary" : "secondary"}
                    size="sm"
                    loading={savingApprovalMode === option.mode}
                    onClick={() => handleSelectApprovalMode(option.mode)}
                    data-testid={`settings-approval-mode-${option.mode}`}
                  >
                    {isSelected ? "Selected" : `Choose "${option.title}"`}
                  </Button>
                </div>
              );
            })}
          </div>

          {settings && settings.alwaysAllow.length > 0 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-2)",
                paddingBlockStart: "var(--space-3)",
                borderBlockStart: "1px solid var(--border-subtle)",
              }}
              data-testid="settings-always-allow-section"
            >
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: 600,
                  color: "var(--text-secondary)",
                }}
              >
                Tools you marked &quot;Always allow&quot;
              </span>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "var(--space-2)",
                }}
              >
                {settings.alwaysAllow.map((toolName) => (
                  <div
                    key={toolName}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "var(--space-2)",
                      padding: "var(--space-1) var(--space-3)",
                      borderRadius: "var(--radius-full)",
                      backgroundColor: "var(--bg-elevated)",
                      border: "1px solid var(--border-subtle)",
                      fontSize: "var(--text-xs)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    <span>{toolName}</span>
                    <button
                      type="button"
                      className="orbit-icon-btn"
                      onClick={() => handleRemoveAlwaysAllow(toolName)}
                      aria-label={`Stop always allowing ${toolName}`}
                      data-testid={`settings-remove-always-allow-${toolName}`}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card
        title="Undo & Change History"
        subtitle="Undo is on — every update Orion makes is recorded here so you can undo mistakes in one click"
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
              Undo last change
            </Button>
          ) : (
            <Badge variant="neutral" icon={<History size={12} />}>
              Up to date
            </Badge>
          )
        }
      >
        {snapshots.length === 0 ? (
          <EmptyState
            title="No snapshots recorded yet"
            description="When Orion adds an animal, changes a sensor binding, or edits a connector file, a snapshot appears here so you can undo it in one click."
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
                          ? "Undone"
                          : `${snap.rowCount} item${snap.rowCount === 1 ? "" : "s"}`}
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
                      {snap.undoneAt && ` · Undone ${formatSnapshotTimestamp(snap.undoneAt)}`}
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
                      {isUndone ? "Already undone" : "Undo"}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <div className="orbit-split-grid">
        <Card
          title="Farm Data on This PC"
          subtitle="Where Orbit saves your herd records, conversations, and files on this computer"
          actions={
            <Badge variant="ok" icon={<FolderOpen size={12} />}>
              Saved on this PC
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
                Data Folder Path
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
                <strong>Database file:</strong>{" "}
                <code style={{ fontFamily: "var(--font-mono)" }}>orbit.sqlite</code> (animals,
                devices, sensor bindings, observations)
              </div>
              <div>
                <strong>Orion endpoint:</strong>{" "}
                <code
                  style={{ fontFamily: "var(--font-mono)" }}
                  data-testid="settings-orion-endpoint"
                >
                  {endpoint?.url ?? "ws://127.0.0.1:7717/ws"}
                </code>
              </div>
              <div>
                <strong>Server version:</strong>{" "}
                <code style={{ fontFamily: "var(--font-mono)" }}>
                  {client?.server?.serverVersion ?? "0.1.0"}
                </code>
              </div>
            </div>
          </div>
        </Card>

        <Card
          title="About & License"
          subtitle="Open-source farm desktop software for cattle and horse operations"
          actions={
            <Badge variant="accent" icon={<Scale size={12} />}>
              AGPL-3.0 + Commercial
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
              <strong>Orbit &amp; Orion</strong> are dual-licensed under the{" "}
              <strong>GNU Affero General Public License v3.0 (AGPL-3.0-only)</strong> and a paid
              commercial license for enterprise and OEM partners.
            </p>
            <p style={{ margin: 0 }}>
              You own your farm data on your own PC, with optional sync when you choose to turn it
              on.
            </p>
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
              License: AGPL-3.0-only OR Commercial · Fonts: Bricolage Grotesque, Atkinson
              Hyperlegible Next, Azeret Mono (SIL OFL 1.1)
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
