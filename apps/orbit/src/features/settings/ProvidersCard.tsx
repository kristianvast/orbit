import "./providers.css";
import type {
  AuthMethod,
  AuthNotice,
  AuthPromptInfo,
  AuthProviderInfo,
  EventBody,
} from "@orbit/protocol";
import { Check, Copy, ExternalLink, KeyRound, Loader2, Search, Sparkles } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, Dialog, Input, useToast } from "../../design";
import { useT } from "../../i18n";
import { useOrion } from "../../lib/orion";

type Tab = "subscriptions" | "apiKeys";

interface Target {
  provider: AuthProviderInfo;
  method: AuthMethod;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={copied ? <Check size={14} /> : <Copy size={14} />}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? t("providers.dialog.copied") : label}
    </Button>
  );
}

function NoticeView({ notice }: { notice: AuthNotice }) {
  const t = useT();
  switch (notice.type) {
    case "auth_url":
      return (
        <div className="orbit-login__step" data-testid="login-auth-url">
          <p>
            {notice.opened ? t("providers.dialog.browserOpened") : t("providers.dialog.openPage")}
          </p>
          {notice.instructions && <p className="orbit-login__muted">{notice.instructions}</p>}
          <div className="orbit-login__row">
            <a
              className="orbit-btn orbit-btn--primary orbit-btn--sm"
              href={notice.url}
              target="_blank"
              rel="noreferrer noopener"
              data-testid="login-open-link"
            >
              <ExternalLink size={14} aria-hidden="true" />
              {t("providers.dialog.openButton")}
            </a>
            <CopyButton text={notice.url} label={t("providers.dialog.copyLink")} />
          </div>
        </div>
      );
    case "device_code":
      return (
        <div className="orbit-login__step" data-testid="login-device-code">
          <p>{t("providers.dialog.deviceCode")}</p>
          <code className="orbit-login__code">{notice.userCode}</code>
          <div className="orbit-login__row">
            <a
              className="orbit-btn orbit-btn--primary orbit-btn--sm"
              href={notice.verificationUri}
              target="_blank"
              rel="noreferrer noopener"
            >
              <ExternalLink size={14} aria-hidden="true" />
              {t("providers.dialog.openButton")}
            </a>
            <CopyButton text={notice.userCode} label={t("providers.dialog.copyCode")} />
          </div>
          {notice.expiresInSeconds ? (
            <p className="orbit-login__muted">
              {t("providers.dialog.expires", {
                minutes: Math.max(1, Math.round(notice.expiresInSeconds / 60)),
              })}
            </p>
          ) : null}
        </div>
      );
    case "info":
      return (
        <div className="orbit-login__step">
          <p>{notice.message}</p>
          {notice.links?.map((link) => (
            <a key={link.url} href={link.url} target="_blank" rel="noreferrer noopener">
              {link.label ?? link.url}
            </a>
          ))}
        </div>
      );
    case "progress":
      return null;
  }
}

function PromptForm({
  prompt,
  onSubmit,
}: {
  prompt: AuthPromptInfo;
  onSubmit: (value: string) => void;
}) {
  const t = useT();
  const [value, setValue] = useState("");
  if (prompt.type === "select") {
    return (
      <fieldset className="orbit-login__choices" data-testid="login-prompt-select">
        <legend>{prompt.message}</legend>
        {prompt.options?.map((option) => (
          <button
            key={option.id}
            type="button"
            className="orbit-login__choice"
            onClick={() => onSubmit(option.id)}
            data-testid={`login-option-${option.id}`}
          >
            <span>{option.label}</span>
            {option.description && <small>{option.description}</small>}
          </button>
        ))}
      </fieldset>
    );
  }
  const secret = prompt.type === "secret";
  const allowBlank = prompt.type === "text";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (allowBlank || value.trim()) onSubmit(value.trim());
  };
  return (
    <form className="orbit-login__form" onSubmit={submit} data-testid="login-prompt-form">
      <Input
        type={secret ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        label={prompt.message}
        placeholder={prompt.placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        {...(secret ? { hint: t("providers.dialog.secretNote") } : {})}
        data-testid="login-prompt-input"
      />
      <div className="orbit-login__row orbit-login__row--end">
        <Button
          type="submit"
          disabled={!allowBlank && !value.trim()}
          data-testid="login-prompt-submit"
        >
          {t("providers.dialog.submit")}
        </Button>
      </div>
    </form>
  );
}

function LoginDialog({
  target,
  onClose,
  onFinished,
  onRetry,
}: {
  target: Target;
  onClose: () => void;
  onFinished: (ok: boolean, error?: string) => void;
  onRetry: () => void;
}) {
  const t = useT();
  const { client } = useOrion();
  const [loginId, setLoginId] = useState<string | null>(null);
  const [notices, setNotices] = useState<Array<{ id: number; notice: AuthNotice }>>([]);
  const [prompt, setPrompt] = useState<{ id: string; info: AuthPromptInfo } | null>(null);
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const loginIdRef = useRef<string | null>(null);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  useEffect(() => {
    if (!client) return;
    let current: string | null = null;
    let disposed = false;
    const early: Array<() => void> = [];
    const forThisLogin = (id: string, apply: () => void) => {
      if (current === null) early.push(() => current === id && apply());
      else if (id === current) apply();
    };
    const offs = [
      client.on("auth.notice", (ev) => {
        const body = ev as unknown as EventBody<"auth.notice">;
        forThisLogin(body.loginId, () =>
          setNotices((prev) => [...prev, { id: prev.length, notice: body.notice }]),
        );
      }),
      client.on("auth.prompt", (ev) => {
        const body = ev as unknown as EventBody<"auth.prompt">;
        forThisLogin(body.loginId, () => setPrompt({ id: body.promptId, info: body.prompt }));
      }),
      client.on("auth.finished", (ev) => {
        const body = ev as unknown as EventBody<"auth.finished">;
        forThisLogin(body.loginId, () => {
          setPrompt(null);
          loginIdRef.current = null;
          if (body.cancelled) return;
          const next = body.error ? { ok: body.ok, error: body.error } : { ok: body.ok };
          setResult(next);
          finishedRef.current(next.ok, next.error);
        });
      }),
    ];
    setNotices([]);
    setPrompt(null);
    setResult(null);
    void client
      .request("auth.login", { providerId: target.provider.id, method: target.method })
      .then((res) => {
        if (disposed) {
          void client.request("auth.cancel", { loginId: res.loginId }).catch(() => undefined);
          return;
        }
        current = res.loginId;
        loginIdRef.current = res.loginId;
        setLoginId(res.loginId);
        for (const run of early.splice(0)) run();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setResult({ ok: false, error: message });
        finishedRef.current(false, message);
      });
    return () => {
      disposed = true;
      for (const off of offs) off();
      const running = loginIdRef.current;
      if (running) void client.request("auth.cancel", { loginId: running }).catch(() => undefined);
      loginIdRef.current = null;
    };
  }, [client, target]);

  const respond = (value: string) => {
    if (!client || !loginId || !prompt) return;
    const promptId = prompt.id;
    setPrompt(null);
    void client.request("auth.respond", { loginId, promptId, value });
  };

  const progress = [...notices].reverse().find((n) => n.notice.type === "progress")?.notice;
  const steps = notices.filter((n) => n.notice.type !== "progress");
  const running = result === null;
  const title =
    target.method === "oauth"
      ? t("providers.dialog.titleOauth", {
          provider: target.provider.oauth?.name ?? target.provider.name,
        })
      : t("providers.dialog.titleKey", { provider: target.provider.name });

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      footer={
        <div className="orbit-login__row orbit-login__row--end">
          {running ? (
            <Button variant="secondary" onClick={onClose} data-testid="login-cancel">
              {t("providers.dialog.cancel")}
            </Button>
          ) : result.ok ? (
            <Button onClick={onClose} data-testid="login-done">
              {t("providers.dialog.done")}
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose}>
                {t("providers.dialog.close")}
              </Button>
              <Button onClick={onRetry} data-testid="login-retry">
                {t("providers.dialog.retry")}
              </Button>
            </>
          )}
        </div>
      }
    >
      <div className="orbit-login" data-testid="login-dialog">
        {steps.map((step) => (
          <NoticeView key={step.id} notice={step.notice} />
        ))}
        {running && prompt && (
          <PromptForm key={prompt.id} prompt={prompt.info} onSubmit={respond} />
        )}
        {running && !prompt && (
          <p className="orbit-login__progress" data-testid="login-progress">
            <Loader2 size={15} className="orbit-spin" aria-hidden="true" />
            {progress?.type === "progress"
              ? progress.message
              : steps.length > 0
                ? t("providers.dialog.waiting")
                : t("providers.dialog.starting")}
          </p>
        )}
        {result?.ok && (
          <p className="orbit-login__success" data-testid="login-success">
            <Check size={16} aria-hidden="true" />
            {t("providers.dialog.success", { provider: target.provider.name })}
          </p>
        )}
        {result && !result.ok && (
          <div className="orbit-login__error" role="alert" data-testid="login-error">
            <strong>{t("providers.dialog.failed")}</strong>
            {result.error && <span>{result.error}</span>}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function statusLabel(provider: AuthProviderInfo, t: ReturnType<typeof useT>): string | null {
  const { status } = provider;
  if (!status.configured) return null;
  if (status.source === "environment") return t("providers.status.fromEnvironment");
  return status.method === "oauth" ? t("providers.status.viaOauth") : t("providers.status.viaKey");
}

export function ProvidersCard({
  onChanged,
}: {
  onChanged: (connectedProviderId?: string) => void;
}) {
  const t = useT();
  const { client, state } = useOrion();
  const { pushToast } = useToast();
  const [providers, setProviders] = useState<AuthProviderInfo[] | null>(null);
  const [tab, setTab] = useState<Tab>("subscriptions");
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<Target | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      setProviders((await client.request("auth.providers", {})).providers);
    } catch (error) {
      pushToast({
        title: t("providers.toast.loadFailed"),
        description: error instanceof Error ? error.message : String(error),
        tone: "warn",
      });
    }
  }, [client, pushToast, t]);

  useEffect(() => {
    if (state === "open") void refresh();
  }, [state, refresh]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (providers ?? [])
      .filter((p) => (tab === "subscriptions" ? p.oauth !== null : p.apiKey !== null))
      .filter(
        (p) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          p.id.includes(q) ||
          (p.oauth?.name.toLowerCase().includes(q) ?? false),
      )
      .sort((a, b) => {
        const rank = (p: AuthProviderInfo) =>
          (p.status.configured ? 0 : 2) +
          (tab === "subscriptions" && p.oauth?.subscription ? 0 : 1);
        return rank(a) - rank(b) || a.name.localeCompare(b.name);
      });
  }, [providers, tab, query]);

  const connectedCount = (providers ?? []).filter(
    (p) => p.status.configured && p.status.source !== "environment",
  ).length;

  const disconnect = async (provider: AuthProviderInfo) => {
    if (!client) return;
    setBusyId(provider.id);
    try {
      setProviders((await client.request("auth.logout", { providerId: provider.id })).providers);
      onChanged();
      pushToast({
        title: t("providers.toast.disconnected", { provider: provider.name }),
        tone: "info",
      });
    } catch (error) {
      pushToast({
        title: t("providers.toast.disconnectFailed", { provider: provider.name }),
        description: error instanceof Error ? error.message : String(error),
        tone: "danger",
      });
    } finally {
      setBusyId(null);
    }
  };

  const handleFinished = (ok: boolean) => {
    if (!target) return;
    void refresh();
    if (ok) {
      onChanged(target.provider.id);
      pushToast({
        title: t("providers.toast.connected", { provider: target.provider.name }),
        description: t("providers.toast.connectedDesc"),
        tone: "ok",
      });
    }
  };

  return (
    <Card
      id="providers"
      title={t("providers.card.title")}
      actions={
        <Badge
          variant={connectedCount > 0 ? "ok" : "neutral"}
          data-testid="providers-connected-count"
        >
          {t("providers.card.connectedCount", { count: connectedCount })}
        </Badge>
      }
      data-testid="providers-card"
    >
      <div className="orbit-providers">
        <div className="orbit-providers__toolbar">
          <div className="orbit-providers__tabs" role="tablist">
            {(["subscriptions", "apiKeys"] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className="orbit-providers__tab"
                onClick={() => setTab(id)}
                data-testid={`providers-tab-${id}`}
              >
                {id === "subscriptions" ? <Sparkles size={14} /> : <KeyRound size={14} />}
                {t(
                  id === "subscriptions" ? "providers.tab.subscriptions" : "providers.tab.apiKeys",
                )}
              </button>
            ))}
          </div>
          <label className="orbit-providers__search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              aria-label={t("providers.search.label")}
              placeholder={t("providers.search.placeholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="providers-search"
            />
          </label>
        </div>

        <ul className="orbit-providers__list" data-testid="providers-list">
          {providers === null ? (
            <li className="orbit-providers__empty">{t("providers.list.loading")}</li>
          ) : visible.length === 0 ? (
            <li className="orbit-providers__empty">{t("providers.list.empty")}</li>
          ) : (
            visible.map((provider) => {
              const method: AuthMethod = tab === "subscriptions" ? "oauth" : "api_key";
              const label = statusLabel(provider, t);
              const stored = provider.status.configured && provider.status.source !== "environment";
              return (
                <li
                  key={provider.id}
                  className="orbit-provider"
                  data-configured={provider.status.configured ? "true" : "false"}
                  data-testid={`provider-row-${provider.id}`}
                >
                  <div className="orbit-provider__text">
                    <span className="orbit-provider__name">
                      {tab === "subscriptions" && provider.oauth
                        ? provider.oauth.name
                        : provider.name}
                    </span>
                    <span className="orbit-provider__meta">
                      {tab === "subscriptions" && provider.oauth?.subscription && (
                        <span className="orbit-provider__tag">
                          {t("providers.row.subscription")}
                        </span>
                      )}
                      {tab === "subscriptions" &&
                        provider.oauth &&
                        !provider.oauth.name
                          .toLowerCase()
                          .includes(provider.name.toLowerCase()) && <span>{provider.name}</span>}
                      {t("providers.row.models", { count: provider.modelCount })}
                    </span>
                  </div>
                  {label && (
                    <Badge
                      variant="ok"
                      icon={<Check size={11} />}
                      data-testid={`provider-status-${provider.id}`}
                    >
                      {label}
                    </Badge>
                  )}
                  <div className="orbit-provider__actions">
                    {stored ? (
                      <Button
                        variant="subtle"
                        size="sm"
                        loading={busyId === provider.id}
                        onClick={() => void disconnect(provider)}
                        data-testid={`provider-disconnect-${provider.id}`}
                      >
                        {t("providers.action.disconnect")}
                      </Button>
                    ) : (
                      <Button
                        variant={provider.status.configured ? "secondary" : "primary"}
                        size="sm"
                        onClick={() => setTarget({ provider, method })}
                        data-testid={`provider-connect-${provider.id}`}
                      >
                        {method === "oauth"
                          ? t("providers.action.signIn")
                          : t("providers.action.addKey")}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })
          )}
        </ul>
      </div>

      {target && (
        <LoginDialog
          target={target}
          onClose={() => setTarget(null)}
          onFinished={handleFinished}
          onRetry={() => setTarget({ ...target })}
        />
      )}
    </Card>
  );
}
