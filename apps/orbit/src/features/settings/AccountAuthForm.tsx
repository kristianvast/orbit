import type { AccountStatus } from "@orbit/protocol";
import { type FormEvent, useState } from "react";
import { useLocation } from "react-router";
import { Button, Input, useToast } from "../../design";
import { useT } from "../../i18n";
import { useOrion } from "../../lib/orion";
import { openExternalUrl } from "./BillingSection";

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

export interface AccountAuthFormProps {
  readonly busy: boolean;
  readonly run: (action: () => Promise<void>) => Promise<void>;
  readonly onStatus: (next: AccountStatus) => void;
}

export function AccountAuthForm({ busy, run, onStatus }: AccountAuthFormProps) {
  const t = useT();
  const { client } = useOrion();
  const { pushToast } = useToast();
  const wantsRegister = (useLocation().state as { accountMode?: string } | null)?.accountMode;
  const [mode, setMode] = useState<"login" | "register">(
    wantsRegister === "register" ? "register" : "login",
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [googleUrl, setGoogleUrl] = useState<string | null>(null);

  const google = () =>
    void run(async () => {
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
    void run(async () => {
      if (!client) return;
      if (!email.trim()) throw new Error(t("account.forgot.needEmail"));
      await client.request("account.requestPasswordReset", { email: email.trim() });
      pushToast({ title: t("account.forgot.sent"), tone: "ok" });
    });

  return (
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
    </>
  );
}
