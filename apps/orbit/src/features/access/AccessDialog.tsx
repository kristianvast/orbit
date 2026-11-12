import type { AccessTool, EventBody } from "@orbit/protocol";
import { Globe, MousePointer2, ShieldCheck, Terminal } from "lucide-react";
import { useCallback, useState } from "react";
import { Button, Dialog } from "../../design";
import { type MessageKey, useT } from "../../i18n";
import { useOrion, useOrionEvent } from "../../lib/orion";

const COPY: Record<
  AccessTool,
  { icon: typeof Terminal; title: MessageKey; points: [MessageKey, MessageKey] }
> = {
  shell: {
    icon: Terminal,
    title: "access.shell.title",
    points: ["access.shell.what", "access.shell.care"],
  },
  browser: {
    icon: Globe,
    title: "access.browser.title",
    points: ["access.browser.what", "access.browser.care"],
  },
  computer: {
    icon: MousePointer2,
    title: "access.computer.title",
    points: ["access.computer.what", "access.computer.care"],
  },
};

type Request = EventBody<"access.request">;

export function AccessDialog() {
  const { client } = useOrion();
  const t = useT();
  const [requests, setRequests] = useState<Request[]>([]);
  const [busy, setBusy] = useState(false);
  const request = requests[0] ?? null;

  useOrionEvent("access.request", (ev) =>
    setRequests((open) => (open.some((r) => r.requestId === ev.requestId) ? open : [...open, ev])),
  );
  useOrionEvent("access.resolved", (ev) =>
    setRequests((open) => open.filter((r) => r.requestId !== ev.requestId)),
  );

  const answer = useCallback(
    async (allow: boolean) => {
      if (!client || !request) return;
      setBusy(true);
      try {
        await client.request("access.respond", { requestId: request.requestId, allow });
      } finally {
        setBusy(false);
        setRequests((open) => open.filter((r) => r.requestId !== request.requestId));
      }
    },
    [client, request],
  );

  if (!request) return null;
  const copy = COPY[request.tool];
  const Icon = copy.icon;
  return (
    <Dialog
      open
      onClose={() => void answer(false)}
      title={
        <span className="orbit-access__title">
          <span className="orbit-access__icon" aria-hidden="true">
            <Icon size={18} />
          </span>
          {t(copy.title)}
        </span>
      }
      description={t("access.lead")}
      footer={
        <div className="orbit-access__actions">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void answer(false)}
            data-testid="access-decline"
          >
            {t("access.decline")}
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => void answer(true)}
            data-testid="access-allow"
          >
            {t("access.allow")}
          </Button>
        </div>
      }
    >
      <div className="orbit-access" data-testid="access-dialog" data-tool={request.tool}>
        <ul className="orbit-access__points">
          <li>
            <Icon size={16} aria-hidden="true" />
            <span>{t(copy.points[0])}</span>
          </li>
          <li>
            <ShieldCheck size={16} aria-hidden="true" />
            <span>{t(copy.points[1])}</span>
          </li>
        </ul>
        <p className="orbit-access__risk">{t("access.risk")}</p>
      </div>
    </Dialog>
  );
}
