import type { AccountStatus } from "@orbit/protocol";
import { type FormEvent, useEffect, useState } from "react";
import { useLocation } from "react-router";
import { Badge, Button, Card, Input, useToast } from "../../design";
import { useT } from "../../i18n";
import { calmAccountSyncState, useOrion, useOrionEvent } from "../../lib/orion";
import { BillingSection, openExternalUrl } from "./BillingSection";
import { MembersCard } from "./MembersCard";

export { BillingSection, openExternalUrl } from "./BillingSection";
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
const check = {
  display: "flex",
  gap: "var(--space-2)",
  alignItems: "flex-start",
  fontSize: "var(--text-sm)",
} as const;

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
  const { client, state } = useOrion();
  const [status, setStatus] = useState<AccountStatus | null>(null);

  useEffect(() => {
    if (!client || state !== "open") return;
    client.request("account.status", {}).then(setStatus, (error: unknown) => {
      // An Orion without account support (older sidecar, test mock) hides the section.
      console.warn("orbit: account status unavailable:", error);
      setStatus(null);
    });
  }, [client, state]);
  useOrionEvent("account.updated", (event) => {
    const { type: _type, ...next } = event;
    setStatus(next);
  });

  if (!status) return null;
  return (
    <div id="account" style={column}>
      <AccountCard status={status} onStatus={setStatus} />
      {status.state === "signed_in" && status.farm && (
        <MembersCard role={status.farm.role} userId={status.user?.id ?? ""} />
      )}
    </div>
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
  const wantsRegister = (useLocation().state as { accountMode?: string } | null)?.accountMode;
  const [mode, setMode] = useState<"login" | "register">(
    wantsRegister === "register" ? "register" : "login",
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [googleUrl, setGoogleUrl] = useState<string | null>(null);
  const { pushToast } = useToast();

  const google = () =>
    run(async () => {
      if (!client) return;
      const { url, opened } = await client.request("account.googleStart", {});
      if (!opened) await openExternalUrl(url);
      setGoogleUrl(url);
    });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (!client) return;
      const next =
        mode === "login"
          ? await client.request("account.login", { email, password })
          : await client.request("account.register", {
              email,
              password,
              acceptTerms: true,
              ...(name.trim() ? { name: name.trim() } : {}),
            });
      setPassword("");
      onStatus(next);
    });
  };

  const forgot = () =>
    run(async () => {
      if (!client) return;
      if (!email.trim()) throw new Error(t("account.forgot.needEmail"));
      await client.request("account.requestPasswordReset", { email: email.trim() });
      pushToast({ title: t("account.forgot.sent"), tone: "ok" });
    });

  const resend = () =>
    run(async () => {
      if (!client) return;
      await client.request("account.resendVerification", {});
      pushToast({ title: t("account.verify.sent"), tone: "ok" });
    });

  const refresh = () =>
    run(async () => {
      if (client) onStatus(await client.request("account.refresh", {}));
    });

  const accept = () =>
    run(async () => {
      if (!client) return;
      onStatus(await client.request("account.acceptInvite", { code }));
      setCode("");
      pushToast({ title: t("account.invite.joined"), tone: "ok" });
    });

  const logout = () =>
    run(async () => {
      if (client) onStatus(await client.request("account.logout", {}));
    });

  const signedIn = status.state === "signed_in";
  return (
    <Card
      title={t("account.title")}
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
          <div style={column} data-testid="account-google">
            <Button
              type="button"
              variant="secondary"
              loading={busy}
              onClick={google}
              data-testid="account-google-button"
            >
              {t("account.google.continue")}
            </Button>
            {googleUrl ? (
              <div role="status" style={column} data-testid="account-google-waiting">
                <p style={muted}>{t("account.google.waiting")}</p>
                <div style={row}>
                  <Button
                    type="button"
                    variant="subtle"
                    size="sm"
                    onClick={() => void run(() => openExternalUrl(googleUrl))}
                    data-testid="account-google-reopen"
                  >
                    {t("account.google.reopen")}
                  </Button>
                </div>
              </div>
            ) : (
              <p style={{ ...muted, fontSize: "var(--text-sm)" }}>{t("account.google.terms")}</p>
            )}
            <p style={{ ...muted, fontSize: "var(--text-sm)", textAlign: "center" }}>
              {t("account.google.or")}
            </p>
          </div>
          <form style={column} onSubmit={submit} data-testid="account-form">
            <div style={row} role="tablist">
              {(["login", "register"] as const).map((m) => (
                <Button
                  key={m}
                  type="button"
                  size="sm"
                  variant={mode === m ? "primary" : "subtle"}
                  aria-pressed={mode === m}
                  onClick={() => setMode(m)}
                  data-testid={`account-mode-${m}`}
                >
                  {t(`account.mode.${m}`)}
                </Button>
              ))}
            </div>
            {mode === "register" && (
              <Input
                label={t("account.field.name")}
                value={name}
                autoComplete="name"
                onChange={(e) => setName(e.target.value)}
                data-testid="account-name"
              />
            )}
            <Input
              label={t("account.field.email")}
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="account-email"
            />
            <Input
              label={t("account.field.password")}
              type="password"
              required
              minLength={mode === "register" ? 10 : 1}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              hint={mode === "register" ? t("account.field.passwordHint") : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              data-testid="account-password"
            />
            {mode === "register" && (
              <label style={check}>
                <input
                  type="checkbox"
                  required
                  checked={acceptTerms}
                  onChange={(e) => setAcceptTerms(e.target.checked)}
                  data-testid="account-terms"
                />
                <span>{t("account.field.terms")}</span>
              </label>
            )}
            <div style={row}>
              <Button
                type="submit"
                variant="primary"
                loading={busy}
                disabled={mode === "register" && !acceptTerms}
                data-testid="account-submit"
              >
                {t(`account.submit.${mode}`)}
              </Button>
              {mode === "login" && (
                <Button
                  type="button"
                  variant="subtle"
                  size="sm"
                  onClick={forgot}
                  data-testid="account-forgot"
                >
                  {t("account.forgot.link")}
                </Button>
              )}
            </div>
          </form>
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
                {(() => {
                  const displayState = calmAccountSyncState(syncStatus);
                  return (
                    <Badge variant={SYNC_BADGE[displayState]} data-testid="account-sync">
                      {t(`account.sync.${displayState}`)}
                    </Badge>
                  );
                })()}
              </dd>
            </dl>
          ) : (
            <div role="status" data-testid="account-link-error">
              <strong>{t("account.linkError.title")}</strong>
              <p style={muted}>{t("account.linkError.body")}</p>
            </div>
          )}

          <BillingSection status={status} />

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
