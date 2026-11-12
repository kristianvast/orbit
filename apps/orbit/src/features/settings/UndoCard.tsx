import type { SnapshotSummary } from "@orbit/protocol";
import { Check, History, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, useToast } from "../../design";
import { useI18n } from "../../i18n";
import { useOrion } from "../../lib/orion";
import { More, SettingsTitle } from "./parts";

const TIME_FORMAT: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

export function UndoCard() {
  const { client, state } = useOrion();
  const { pushToast } = useToast();
  const { t, formatDate } = useI18n();
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [undoingId, setUndoingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      setSnapshots((await client.request("snapshots.list", { limit: 30 })).snapshots);
    } catch (err) {
      pushToast({
        title: t("settings.toast.loadFailed"),
        description: err instanceof Error ? err.message : String(err),
        tone: "warn",
      });
    }
  }, [client, pushToast, t]);

  useEffect(() => {
    if (state === "open" || state === "connecting") void load();
  }, [state, load]);

  useEffect(() => {
    if (!client) return;
    return client.on("db.changed", () => void load());
  }, [client, load]);

  const undo = async (snapshotId: string) => {
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

  const latest = snapshots.find((s) => s.undoneAt === null) ?? null;
  const time = (iso: string) => formatDate(iso, TIME_FORMAT);

  return (
    <Card
      id="undo"
      title={<SettingsTitle icon={RotateCcw}>{t("settings.undo.title")}</SettingsTitle>}
      actions={
        latest ? (
          <Button
            variant="primary"
            size="sm"
            loading={undoingId === latest.id}
            onClick={() => void undo(latest.id)}
            icon={<RotateCcw size={15} />}
            data-testid="settings-undo-last-button"
          >
            {t("settings.undo.last")}
          </Button>
        ) : (
          <Badge variant="neutral" icon={<Check size={12} />}>
            {t("settings.undo.upToDate")}
          </Badge>
        )
      }
    >
      {snapshots.length === 0 ? (
        <p className="settings-muted">{t("settings.undo.emptyTitle")}</p>
      ) : (
        <div className="settings-stack">
          {latest && (
            <div className="settings-row">
              <History size={18} className="settings-row__icon" aria-hidden="true" />
              <span className="settings-row__text">
                <span className="settings-row__label">{latest.description}</span>
                <span className="settings-row__hint tabular-nums">{time(latest.createdAt)}</span>
              </span>
            </div>
          )}
          <More
            summary={`${t("settings.undo.history")} · ${t("settings.undo.items", { count: snapshots.length })}`}
          >
            <ul className="settings-rows" data-testid="settings-snapshots-list">
              {snapshots.map((snap) => {
                const isUndone = snap.undoneAt !== null;
                return (
                  <li
                    key={snap.id}
                    className="settings-row"
                    data-done={isUndone}
                    data-testid={`settings-snapshot-row-${snap.id}`}
                  >
                    <span className="settings-row__text">
                      <span className="settings-row__label">{snap.description}</span>
                      <span className="settings-row__hint tabular-nums">
                        {time(snap.createdAt)}
                        {snap.undoneAt &&
                          t("settings.undo.undoneAt", { time: time(snap.undoneAt) })}
                      </span>
                    </span>
                    <Button
                      variant="subtle"
                      size="sm"
                      disabled={isUndone || undoingId !== null}
                      loading={undoingId === snap.id}
                      onClick={() => void undo(snap.id)}
                      icon={isUndone ? <Check size={14} /> : <RotateCcw size={14} />}
                      aria-label={
                        isUndone ? t("settings.undo.alreadyUndone") : t("settings.undo.undo")
                      }
                      title={isUndone ? t("settings.undo.alreadyUndone") : t("settings.undo.undo")}
                      data-testid={`settings-snapshot-undo-${snap.id}`}
                    />
                  </li>
                );
              })}
            </ul>
          </More>
        </div>
      )}
    </Card>
  );
}
