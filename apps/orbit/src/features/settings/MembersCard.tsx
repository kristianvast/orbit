import type { FarmInvite, FarmMember, FarmRole } from "@orbit/protocol";
import { assignableRoles, canManageMember, canManageMembers } from "@orbit/schema/roles";
import { LogOut, Trash2, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Card, Dialog, useToast } from "../../design";
import { useT } from "../../i18n";
import { useOrion } from "../../lib/orion";
import { MemberInvites } from "./MemberInvites";
import { MemberRow } from "./MemberRow";
import { SettingsTitle } from "./parts";

export { formatCompactTokens, parseTokenLimitInput } from "./MemberRow";

const column = { display: "flex", flexDirection: "column", gap: "var(--space-3)" } as const;
const row = {
  display: "flex",
  gap: "var(--space-2)",
  flexWrap: "wrap",
  alignItems: "center",
} as const;
const muted = { margin: 0, color: "var(--text-secondary)" } as const;

export interface MembersCardProps {
  readonly role: FarmRole;
  readonly userId: string;
  readonly onLeft?: () => void;
}

export function MembersCard({ role, userId, onLeft }: MembersCardProps) {
  const t = useT();
  const { client } = useOrion();
  const { pushToast } = useToast();
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [members, setMembers] = useState<FarmMember[]>([]);
  const [invites, setInvites] = useState<FarmInvite[]>([]);
  const [confirmRemove, setConfirmRemove] = useState<FarmMember | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const manage = canManageMembers(role);
  const roles = assignableRoles(role);
  const roleOptions = roles.map((r) => ({ value: r, label: t(`account.role.${r}`) }));

  const run = async <R,>(action: () => Promise<R>): Promise<R> => {
    setBusy(true);
    try {
      return await action();
    } catch (error) {
      pushToast({
        title: t("account.failed"),
        description: error instanceof Error ? error.message : String(error),
        tone: "danger",
      });
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const apply = (next: { members: FarmMember[]; invites: FarmInvite[] }) => {
    setMembers(next.members);
    setInvites(next.invites);
  };

  useEffect(() => {
    if (!client) return;
    let live = true;
    client.request("members.list", {}).then(
      (next) => {
        if (!live) return;
        setMembers(next.members);
        setInvites(next.invites);
        setLoaded(true);
      },
      (error: unknown) => {
        if (live) setLoaded(true);
        pushToast({
          title: t("account.failed"),
          description: error instanceof Error ? error.message : String(error),
          tone: "danger",
        });
      },
    );
    return () => {
      live = false;
    };
  }, [client, pushToast, t]);

  const hasSelfRow = members.some((m) => m.userId === userId);
  const canSelfLeave = role !== "owner" && Boolean(userId);

  return (
    <Card
      title={<SettingsTitle icon={Users}>{t("account.members.title")}</SettingsTitle>}
      data-testid="members-card"
    >
      <div style={column}>
        <ul className="settings-rows" data-testid="members-list">
          {members.map((m) => {
            const isSelf = m.userId === userId;
            const editable = manage && !isSelf && canManageMember(role, m.role);
            return (
              <MemberRow
                key={m.userId}
                member={m}
                isSelf={isSelf}
                canManageTeam={manage}
                editable={editable}
                canLeave={isSelf && canSelfLeave}
                busy={busy}
                roleOptions={roleOptions}
                onUpdate={(patch) =>
                  void run(async () => {
                    if (!client) return;
                    apply(
                      await client.request("members.update", {
                        userId: m.userId,
                        ...patch,
                      }),
                    );
                  }).catch(() => undefined)
                }
                onRequestRemove={() => setConfirmRemove(m)}
                onRequestLeave={() => setConfirmLeave(true)}
              />
            );
          })}
          {loaded && members.length <= 1 && (
            <li className="settings-muted">{t("account.members.empty")}</li>
          )}
        </ul>

        {loaded && canSelfLeave && !hasSelfRow && (
          <div style={row}>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              icon={<LogOut size={14} />}
              onClick={() => setConfirmLeave(true)}
              data-testid="member-leave"
            >
              {t("account.members.leave")}
            </Button>
          </div>
        )}

        {!manage && <p style={muted}>{t("account.members.readOnly")}</p>}

        {manage && (
          <MemberInvites
            busy={busy}
            invites={invites}
            roleOptions={roleOptions}
            onCreateInvite={(input) =>
              run(async () => {
                if (!client) throw new Error("Orion client disconnected");
                const res = await client.request("invites.create", input);
                apply(await client.request("members.list", {}));
                return { email: res.invite.email, code: res.code };
              })
            }
            onRevokeInvite={(inviteId) =>
              void run(async () => {
                if (client) {
                  apply(await client.request("invites.revoke", { inviteId }));
                }
              }).catch(() => undefined)
            }
          />
        )}
      </div>

      <Dialog
        open={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        title={t("account.members.removeConfirmTitle")}
        footer={
          <div style={row}>
            <Button
              variant="secondary"
              onClick={() => setConfirmRemove(null)}
              data-testid="member-remove-cancel"
            >
              {t("account.members.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              icon={<Trash2 size={15} />}
              onClick={() => {
                const target = confirmRemove;
                if (!target) return;
                void run(async () => {
                  if (client) {
                    apply(await client.request("members.remove", { userId: target.userId }));
                  }
                  setConfirmRemove(null);
                }).catch(() => undefined);
              }}
              data-testid="member-remove-confirm"
            >
              {t("account.members.remove")}
            </Button>
          </div>
        }
      >
        <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>
          {t("account.members.removeConfirmBody", {
            member: confirmRemove?.name ?? confirmRemove?.email ?? "",
          })}
        </p>
      </Dialog>

      <Dialog
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title={t("account.members.leaveConfirmTitle")}
        footer={
          <div style={row}>
            <Button
              variant="secondary"
              onClick={() => setConfirmLeave(false)}
              data-testid="member-leave-cancel"
            >
              {t("account.members.cancel")}
            </Button>
            <Button
              variant="danger"
              loading={busy}
              icon={<LogOut size={15} />}
              onClick={() =>
                void run(async () => {
                  if (client) {
                    apply(await client.request("members.remove", { userId }));
                  }
                  setConfirmLeave(false);
                  onLeft?.();
                }).catch(() => undefined)
              }
              data-testid="member-leave-confirm"
            >
              {t("account.members.leave")}
            </Button>
          </div>
        }
      >
        <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>
          {t("account.members.leaveConfirmBody")}
        </p>
      </Dialog>
    </Card>
  );
}
