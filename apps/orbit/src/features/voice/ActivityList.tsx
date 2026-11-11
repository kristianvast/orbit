import { AlertCircle, CheckCircle2, Loader2, Square, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../design";
import { useT } from "../../i18n";
import { formatActivityElapsed } from "./activity";
import type { ActivityRowView, ActivityStatus } from "./types";

function StatusGlyph({ status }: { readonly status: ActivityStatus }) {
  switch (status) {
    case "running":
      return <Loader2 size={14} className="orbit-spin" aria-hidden="true" />;
    case "done":
      return <CheckCircle2 size={14} aria-hidden="true" />;
    case "error":
      return <AlertCircle size={14} aria-hidden="true" />;
    case "stopped":
      return <XCircle size={14} aria-hidden="true" />;
  }
}

export interface ActivityListProps {
  readonly activities: readonly ActivityRowView[];
  readonly onAbortTask: () => void;
}

export function ActivityList({ activities, onAbortTask }: ActivityListProps) {
  const t = useT();
  const hasRunning = activities.some((row) => row.status === "running");
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!hasRunning) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [hasRunning]);

  if (activities.length === 0) return null;

  return (
    <ul className="orbit-voice-activities" aria-label={t("voice.activity.heading")}>
      {activities.map((row) => {
        const elapsed =
          row.status === "running" ? formatActivityElapsed(row.startedAt, nowMs, t) : null;
        return (
          <li
            key={row.id}
            className="orbit-voice-activity"
            data-testid="activity-row"
            data-status={row.status}
          >
            <span className="orbit-voice-activity__icon" data-status={row.status}>
              <StatusGlyph status={row.status} />
            </span>
            <span className="orbit-voice-activity__text">{row.text}</span>
            {elapsed && (
              <span className="orbit-voice-activity__elapsed tabular-nums">{elapsed}</span>
            )}
            {row.canStop && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon={<Square size={11} fill="currentColor" />}
                aria-label={t("voice.action.stopJobAria")}
                onClick={onAbortTask}
                data-testid="activity-stop"
              >
                {t("voice.action.stopJob")}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
