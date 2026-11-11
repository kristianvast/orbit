import type { FarmInvite, FarmMember, FarmRole } from "@orbit/protocol";
import { assignableRoles, canManageMember, canManageMembers } from "@orbit/schema/roles";
import { type FormEvent, useEffect, useState } from "react";
import { Badge, Button, Card, Input, Select, useToast } from "../../design";
import { useI18n } from "../../i18n";
import { useOrion } from "../../lib/orion";

const column = { display: "flex", flexDirection: "column", gap: "var(--space-3)" } as const;
const row = {
  display: "flex",
  gap: "var(--space-2)",
  flexWrap: "wrap",
  alignItems: "center",
} as const;
const muted = { margin: 0, color: "var(--text-secondary)" } as const;

export function MembersCard({
  role,
  userId,
}: {
  readonly role: FarmRole;
  readonly userId: string;
}) {
  const { t, formatDate } = useI18n();
  const { client } = useOrion();
  const { pushToast } = useToast();
  const [busy, setBusy] = useState(false);
  const [members, setMembers] = useState<FarmMember[]>([]);
  const [invites, setInvites] = useState<FarmInvite[]>([]);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<FarmRole>("worker");
  const [created, setCreated] = useState<{ email: string; code: string } | null>(null);

  const manage = canManageMembers(role);
  const roles = assignableRoles(role);
  const roleOptions = roles.map((r) => ({ value: r, label: t(`account.role.${r}`) }));

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

  const apply = (next: { members: FarmMember[]; invites: FarmInvite[] }) => {
    setMembers(next.members);
    setInvites(next.invites);
  };

  const refresh = async () => {
    if (client) apply(await client.request("members.list", {}));
  };

  useEffect(() => {
    if (!client) return;
    let live = true;
    client.request("members.list", {}).then(
      (next) => {
        if (!live) return;
        setMembers(next.members);
        setInvites(next.invites);
      },
      (error: unknown) =>
        pushToast({
          title: t("account.failed"),
          description: error instanceof Error ? error.message : String(error),
          tone: "danger",
        }),
    );
    return () => {
      live = false;
    };
  }, [client, pushToast, t]);

  const invite = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (!client) return;
      const res = await client.request("invites.create", { email, role: inviteRole });
      setCreated({ email: res.invite.email, code: res.code });
      setEmail("");
      await refresh();
    });
  };

  return (
    <Card title={t("account.members.title")}>
      <div style={column}>
        <ul
          style={{ ...column, listStyle: "none", margin: 0, padding: 0 }}
          data-testid="members-list"
        >
          {members.map((m) => {
            const editable = manage && m.userId !== userId && canManageMember(role, m.role);
            return (
              <li
                key={m.userId}
                style={{ ...row, justifyContent: "space-between" }}
                data-testid="member-row"
              >
                <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                  <strong>{m.name ?? m.email}</strong>
                  {m.userId === userId && <span style={muted}> ({t("account.members.you")})</span>}
                  {m.name && <span style={{ ...muted, display: "block" }}>{m.email}</span>}
                </span>
                {editable ? (
                  <span style={row}>
                    <Select
                      aria-label={t("account.members.role")}
                      value={m.role}
                      options={roleOptions}
                      disabled={busy}
                      onChange={(e) =>
                        void run(async () => {
                          if (!client) return;
                          apply(
                            await client.request("members.update", {
                              userId: m.userId,
                              role: e.target.value as FarmRole,
                            }),
                          );
                        })
                      }
                      data-testid="member-role"
                    />
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          if (client) {
                            apply(await client.request("members.remove", { userId: m.userId }));
                          }
                        })
                      }
                      data-testid="member-remove"
                    >
                      {t("account.members.remove")}
                    </Button>
                  </span>
                ) : (
                  <Badge variant="neutral">{t(`account.role.${m.role}`)}</Badge>
                )}
              </li>
            );
          })}
          {members.length <= 1 && <li style={muted}>{t("account.members.empty")}</li>}
        </ul>

        {!manage && <p style={muted}>{t("account.members.readOnly")}</p>}

        {manage && (
          <form style={column} onSubmit={invite} data-testid="invite-form">
            <strong>{t("account.members.inviteTitle")}</strong>
            <div style={{ ...row, alignItems: "flex-end" }}>
              <Input
                label={t("account.field.email")}
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="invite-email"
              />
              <Select
                label={t("account.members.role")}
                value={inviteRole}
                options={roleOptions}
                onChange={(e) => setInviteRole(e.target.value as FarmRole)}
                data-testid="invite-role"
              />
              <Button
                type="submit"
                variant="primary"
                size="sm"
                loading={busy}
                data-testid="invite-submit"
              >
                {t("account.members.invite")}
              </Button>
            </div>
          </form>
        )}

        {created && (
          <div role="status" style={column} data-testid="invite-created">
            <strong>{t("account.members.codeTitle", { email: created.email })}</strong>
            <code
              style={{
                fontFamily: "var(--font-mono)",
                padding: "var(--space-2) var(--space-3)",
                background: "var(--bg-subtle)",
                borderRadius: "var(--radius-sm)",
                overflowWrap: "anywhere",
                userSelect: "all",
              }}
              data-testid="invite-code"
            >
              {created.code}
            </code>
            <p style={{ ...muted, fontSize: "var(--text-sm)" }}>{t("account.members.codeHint")}</p>
          </div>
        )}

        {manage && invites.length > 0 && (
          <div style={column}>
            <strong>{t("account.members.pending")}</strong>
            <ul
              style={{ ...column, listStyle: "none", margin: 0, padding: 0 }}
              data-testid="invites-list"
            >
              {invites.map((i) => (
                <li key={i.id} style={{ ...row, justifyContent: "space-between" }}>
                  <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                    {i.email} · {t(`account.role.${i.role}`)}
                    <span style={{ ...muted, display: "block", fontSize: "var(--text-sm)" }}>
                      {t("account.members.expires", {
                        date: formatDate(i.expiresAt, {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        }),
                      })}
                    </span>
                  </span>
                  <Button
                    variant="subtle"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        if (client)
                          apply(await client.request("invites.revoke", { inviteId: i.id }));
                      })
                    }
                    data-testid="invite-revoke"
                  >
                    {t("account.members.revoke")}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
