import { FEEDBACK_KINDS, type FeedbackKind, type SharedBuild } from "@orbit/protocol";
import { Send, Share2 } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { useNavigate } from "react-router";
import { Badge, Button, Card, Input, Select, useToast } from "../../design";
import { useI18n } from "../../i18n";
import { useOrion, useOrionEvent } from "../../lib/orion";

const STATUS_BADGE = { pending: "info", approved: "ok", rejected: "neutral" } as const;

const column = { display: "flex", flexDirection: "column", gap: "var(--space-3)" } as const;
const muted = { margin: 0, color: "var(--text-secondary)", fontSize: "var(--text-sm)" } as const;

export function FeedbackCard() {
  const { client, state } = useOrion();
  const { t, locale } = useI18n();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const messageId = useId();
  const [account, setAccount] = useState<"unavailable" | "signed_out" | "signed_in" | null>(null);
  const [kind, setKind] = useState<FeedbackKind>("issue");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [shared, setShared] = useState<SharedBuild[]>([]);

  useEffect(() => {
    if (!client || state !== "open") return;
    client.request("account.status", {}).then(
      (status) => setAccount(status.state),
      () => setAccount(null),
    );
  }, [client, state]);
  useOrionEvent("account.updated", (event) => setAccount(event.state));

  useEffect(() => {
    if (!client || account !== "signed_in") {
      setShared([]);
      return;
    }
    client.request("shared.list", {}).then(
      (result) => setShared(result.submissions),
      () => setShared([]),
    );
  }, [client, account]);

  if (account === null) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!client || !message.trim()) return;
    setSending(true);
    try {
      await client.request("feedback.send", {
        kind,
        message: message.trim(),
        locale,
        ...(account === "signed_out" && email.trim() ? { contactEmail: email.trim() } : {}),
      });
      setMessage("");
      pushToast({ title: t("feedback.sent"), tone: "ok" });
    } catch (error) {
      pushToast({
        title: t("feedback.failed"),
        description: error instanceof Error ? error.message : String(error),
        tone: "danger",
      });
    } finally {
      setSending(false);
    }
  };

  const sharePrompt = t("feedback.share.prompt");

  return (
    <div id="feedback">
      <Card
        title={t("feedback.title")}
        subtitle={t("feedback.subtitle")}
        data-testid="feedback-card"
      >
        {account === "unavailable" ? (
          <p style={muted}>{t("feedback.unavailable")}</p>
        ) : (
          <div style={column}>
            <form style={column} onSubmit={(event) => void submit(event)}>
              <Select
                label={t("feedback.kind.label")}
                value={kind}
                onChange={(event) => setKind(event.target.value as FeedbackKind)}
                options={FEEDBACK_KINDS.map((value) => ({
                  value,
                  label: t(`feedback.kind.${value}`),
                }))}
                data-testid="feedback-kind"
              />
              <div className="orbit-field">
                <label htmlFor={messageId} className="orbit-label">
                  {t("feedback.message.label")}
                </label>
                <textarea
                  id={messageId}
                  className="orbit-input"
                  rows={4}
                  required
                  maxLength={5000}
                  value={message}
                  placeholder={t("feedback.message.placeholder")}
                  onChange={(event) => setMessage(event.target.value)}
                  style={{ resize: "vertical", minBlockSize: "6rem", blockSize: "auto" }}
                  data-testid="feedback-message"
                />
              </div>
              {account === "signed_out" && (
                <Input
                  label={t("feedback.email.label")}
                  hint={t("feedback.email.hint")}
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  data-testid="feedback-email"
                />
              )}
              <p style={muted}>{t("feedback.privacy")}</p>
              <div>
                <Button
                  type="submit"
                  variant="primary"
                  loading={sending}
                  disabled={!message.trim()}
                  icon={<Send size={15} />}
                  data-testid="feedback-send"
                >
                  {t("feedback.send")}
                </Button>
              </div>
            </form>

            <div
              style={{
                ...column,
                paddingBlockStart: "var(--space-3)",
                borderBlockStart: "1px solid var(--border-subtle)",
              }}
            >
              <p style={muted}>{t("feedback.share.body")}</p>
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Share2 size={14} />}
                  onClick={() =>
                    void navigate(`/chat?prompt=${encodeURIComponent(sharePrompt)}&send=1`, {
                      state: { prefill: sharePrompt },
                    })
                  }
                  data-testid="feedback-share"
                >
                  {t("feedback.share.action")}
                </Button>
              </div>
              {shared.length > 0 && (
                <ul
                  style={{ ...column, listStyle: "none", margin: 0, padding: 0 }}
                  aria-label={t("feedback.shared.title")}
                  data-testid="feedback-shared-list"
                >
                  {shared.map((build) => (
                    <li key={build.id} style={{ fontSize: "var(--text-sm)" }}>
                      <strong>{build.title}</strong>{" "}
                      <Badge variant={STATUS_BADGE[build.status]}>
                        {t(`feedback.shared.status.${build.status}`)}
                      </Badge>
                      {build.reviewNote && <p style={muted}>{build.reviewNote}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
