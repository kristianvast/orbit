import type { LocalUiStatus } from "@orbit/protocol";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, useToast } from "../../design";
import { useT } from "../../i18n";
import { localUiBasename, localUiReturnUrl, openLocalUi } from "../../lib/local-ui";
import { useOrion } from "../../lib/orion";

const BADGE = { none: "neutral", ready: "ok", broken: "warn" } as const;

export function YourOrbitCard() {
  const t = useT();
  const { client, state, endpoint } = useOrion();
  const { pushToast } = useToast();
  const [status, setStatus] = useState<LocalUiStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const isLocal = localUiBasename() !== undefined;
  const returnUrl = localUiReturnUrl();

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      setStatus(await client.request("localUi.status", {}));
    } catch (error) {
      // An Orion without local UI support (older sidecar, test mock) just hides the status.
      console.warn("orbit: local UI status unavailable:", error);
      setStatus(null);
    }
  }, [client]);

  useEffect(() => {
    if (state === "open") void refresh();
  }, [state, refresh]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      pushToast({
        title: t("localUi.failed"),
        description: error instanceof Error ? error.message : String(error),
        tone: "danger",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleUseOriginal = () =>
    run(async () => {
      if (!client) return;
      setStatus(await client.request("localUi.disable", {}));
      if (isLocal && returnUrl) window.location.replace(returnUrl);
    });

  const handleOpen = () =>
    run(async () => {
      if (client && endpoint) await openLocalUi(client, endpoint);
    });

  const body = isLocal
    ? t("localUi.local.body")
    : status
      ? t(`localUi.${status.state}.body`)
      : t("localUi.none.body");

  return (
    <Card
      title={t("localUi.title")}
      actions={
        <Badge variant={status ? BADGE[status.state] : "neutral"} data-testid="local-ui-badge">
          {isLocal
            ? t("localUi.badge.ready")
            : status
              ? t(`localUi.badge.${status.state}`)
              : t("localUi.badge.unknown")}
        </Badge>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
        <p style={{ margin: 0, color: "var(--text-secondary)" }} data-testid="local-ui-body">
          {body}
        </p>
        {status?.builtAt && (
          <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)" }}>
            {t("localUi.builtAt", { time: new Date(status.builtAt).toLocaleString() })}
          </span>
        )}
        {isLocal && !returnUrl && (
          <span style={{ fontSize: "var(--text-sm)" }}>{t("localUi.local.noReturn")}</span>
        )}
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
          {!isLocal && status && status.state !== "none" && (
            <Button
              variant="primary"
              size="sm"
              loading={busy}
              onClick={handleOpen}
              data-testid="local-ui-open"
            >
              {t("localUi.open")}
            </Button>
          )}
          {(isLocal || (status && status.state !== "none")) && (
            <Button
              variant="secondary"
              size="sm"
              loading={busy}
              onClick={handleUseOriginal}
              data-testid="local-ui-use-original"
            >
              {t("localUi.useOriginal")}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
