import type { AccountStatus } from "@orbit/protocol";
import { CloudUpload, UserRound } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Badge, Button, Card, Input, useToast } from "../../design";
import { useT } from "../../i18n";
import { useAccount } from "../../lib/account";
import { calmAccountSyncState, useOrion } from "../../lib/orion";
import { AccountAuthForm } from "./AccountAuthForm";
import { BillingSection } from "./BillingSection";
import { MembersCard } from "./MembersCard";
import { SettingsTitle } from "./parts";

export { BillingSection, openExternalUrl } from "./BillingSection";
export { FarmPickerList } from "./FarmPicker";
export { MembersCard } from "./MembersCard";

const SYNC_BADGE = {
  disabled: "neutral",
  offline: "warn",
  connecting: "info",
  syncing: "info",
  up_to_date: "ok",
  error: "danger",
} as const;

const column = { display: "flex", flexDirection: "column", gap: "var(--space-3)" } as const;
const row = {
  display: "flex",
  gap: "var(--space-2)",
  flexWrap: "wrap",
  alignItems: "center",
} as const;
const muted = { margin: 0, color: "var(--text-secondary)" } as const;

function useRun() {
  const t = useT();
  const { pushToast } = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      pushToast({
        title: t("account.failed"),
        description: error instanceof Error ? error.message : String(error),
        tone: "danger",
      });
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

export function AccountSection() {
  const { status, setStatus } = useAccount();

  if (!status) return null;
  return (
    <div id="account" style={column}>
      <AccountCard status={status} onStatus={setStatus} />
    </div>
  );
}

export function FarmTeamSection() {
  const { status, refreshStatus } = useAccount();

  if (status?.state !== "signed_in" || !status.farm) return null;
  return (
    <MembersCard
      role={status.farm.role}
      userId={status.user?.id ?? ""}
      onLeft={() => void refreshStatus()}
    />
  );
}

export interface AccountCardProps {
  readonly status: AccountStatus;
  readonly onStatus: (s: AccountStatus) => void;
}

export function AccountCard({ status, onStatus }: AccountCardProps) {
  const t = useT();
  const { client, syncStatus } = useOrion();
  const { busy, run } = useRun();
  const [code, setCode] = useState("");
  const [cloudFarmName, setCloudFarmName] = useState(status.localFarm?.name ?? "");
  const { pushToast } = useToast();

  useEffect(() => {
    setCloudFarmName(status.localFarm?.name ?? "");
  }, [status.localFarm?.name]);

  const resend = () =>
    void run(async () => {
      if (!client) return;
      await client.request("account.resendVerification", {});
      pushToast({ title: t("account.verify.sent"), tone: "ok" });
    });

  const refresh = () =>
    void run(async () => {
      if (client) onStatus(await client.request("account.refresh", {}));
    });

  const accept = () =>
    void run(async () => {
      if (!client) return;
      onStatus(await client.request("account.acceptInvite", { code }));
      setCode("");
      pushToast({ title: t("account.invite.joined"), tone: "ok" });
    });

  const createCloudFarm = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (!client) return;
      const trimmed = cloudFarmName.trim();
      const next = await client.request("farms.create", trimmed ? { name: trimmed } : {});
      onStatus(next);
      pushToast({ title: t("account.farms.putInCloudDone"), tone: "ok" });
    });
  };

  const logout = () =>
    void run(async () => {
      if (client) onStatus(await client.request("account.logout", {}));
    });

  const signedIn = status.state === "signed_in";
  const displayState = calmAccountSyncState(syncStatus);

  return (
    <Card
      title={<SettingsTitle icon={UserRound}>{t("account.title")}</SettingsTitle>}
      data-testid="account-card"
      actions={
        <Badge variant={signedIn ? "ok" : "neutral"} data-testid="account-badge">
          {signedIn ? t("account.badge.signedIn") : t("account.badge.local")}
        </Badge>
      }
    >
      {status.state === "unavailable" && <p style={muted}>{t("account.unavailable.body")}</p>}

      {status.state === "signed_out" && (
        <>
          <AccountAuthForm busy={busy} run={run} onStatus={onStatus} />
          <BillingSection status={status} />
        </>
      )}

      {signedIn && (
        <div style={column} data-testid="account-signed-in">
          <p style={{ margin: 0 }}>
            {t("account.signedInAs", { email: status.user?.email ?? "" })}
          </p>
          {status.user?.emailVerified === false && (
            <div role="status" style={column} data-testid="account-unverified">
              <strong>{t("account.verify.title")}</strong>
              <p style={muted}>{t("account.verify.body", { email: status.user.email })}</p>
              <div style={row}>
                <Button size="sm" variant="secondary" loading={busy} onClick={resend}>
                  {t("account.verify.resend")}
                </Button>
                <Button size="sm" variant="subtle" onClick={refresh} data-testid="account-refresh">
                  {t("account.verify.done")}
                </Button>
              </div>
            </div>
          )}

          {status.farm ? (
            <dl
              style={{
                margin: 0,
                display: "grid",
                gridTemplateColumns: "minmax(7rem, auto) 1fr",
                gap: "var(--space-2) var(--space-4)",
              }}
            >
              <dt style={muted}>{t("account.farm")}</dt>
              <dd style={{ margin: 0 }} data-testid="account-farm">
                {status.farm.name ?? status.farm.id}
              </dd>
              <dt style={muted}>{t("account.role")}</dt>
              <dd style={{ margin: 0 }}>
                <Badge variant="accent" data-testid="account-role">
                  {t(`account.role.${status.farm.role}`)}
                </Badge>
              </dd>
              <dt style={muted}>{t("account.sync")}</dt>
              <dd style={{ margin: 0 }}>
                <Badge variant={SYNC_BADGE[displayState]} data-testid="account-sync">
                  {t(`account.sync.${displayState}`)}
                </Badge>
              </dd>
            </dl>
          ) : status.linkError ? (
            <div role="status" data-testid="account-link-error">
              <strong>{t("account.linkError.title")}</strong>
              <p style={muted}>{status.linkError || t("account.linkError.body")}</p>
            </div>
          ) : status.localFarm ? (
            <form
              className="settings-cloud-farm"
              onSubmit={createCloudFarm}
              data-testid="account-create-farm"
            >
              <div className="settings-cloud-farm__head">
                <CloudUpload size={16} className="settings-accent" aria-hidden="true" />
                <strong>{t("account.farms.putInCloudTitle")}</strong>
              </div>
              <p className="settings-muted">{t("account.farms.putInCloudBody")}</p>
              <div className="settings-cloud-farm__row">
                <Input
                  label={t("settings.farm.name")}
                  value={cloudFarmName}
                  onChange={(e) => setCloudFarmName(e.target.value)}
                  data-testid="account-create-farm-name"
                />
                <Button
                  type="submit"
                  variant="secondary"
                  size="sm"
                  loading={busy}
                  icon={<CloudUpload size={15} />}
                  data-testid="account-create-farm-submit"
                >
                  {t("account.farms.putInCloudAction")}
                </Button>
              </div>
            </form>
          ) : null}

          <div
            style={{
              ...row,
              alignItems: "flex-end",
              marginBlockStart: "var(--space-2)",
              paddingBlockStart: "var(--space-3)",
              borderBlockStart: "1px solid var(--border-subtle)",
            }}
          >
            <Input
              label={t("account.invite.label")}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              data-testid="account-invite-code"
            />
            <Button
              variant="secondary"
              size="sm"
              loading={busy}
              disabled={!code.trim()}
              onClick={accept}
              data-testid="account-invite-accept"
            >
              {t("account.invite.accept")}
            </Button>
          </div>
          <BillingSection status={status} />

          <div style={row}>
            <Button variant="subtle" size="sm" onClick={logout} data-testid="account-logout">
              {t("account.logout")}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
