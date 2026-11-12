import type { AccessTool, EventBody } from "@orbit/protocol";
import { Globe, MousePointer2, ShieldCheck, Terminal } from "lucide-react";
import { useCallback, useState } from "react";
import { BrandMark, Button, Dialog } from "../../design";
import { type MessageKey, useT } from "../../i18n";
import { useOrion, useOrionEvent } from "../../lib/orion";

const LEAD: Record<AccessTool, MessageKey> = {
  shell: "access.lead.shell",
  browser: "access.lead.browser",
  computer: "access.lead.computer",
};

const POINTS: { icon: typeof Terminal; key: MessageKey }[] = [
  { icon: Terminal, key: "access.point.commands" },
  { icon: Globe, key: "access.point.browser" },
  { icon: MousePointer2, key: "access.point.screen" },
  { icon: ShieldCheck, key: "access.point.asks" },
];

export function AccessDialog() {
  const { client } = useOrion();
  const t = useT();
  const [request, setRequest] = useState<EventBody<"access.request"> | null>(null);
  const [busy, setBusy] = useState(false);

  useOrionEvent("access.request", (ev) => setRequest(ev));
  useOrionEvent("access.resolved", (ev) =>
    setRequest((open) => (open?.requestId === ev.requestId ? null : open)),
  );

  const answer = useCallback(
    async (allow: boolean) => {
      if (!client || !request) return;
      setBusy(true);
      try {
        await client.request("access.respond", { requestId: request.requestId, allow });
      } finally {
        setBusy(false);
        setRequest(null);
      }
    },
    [client, request],
  );

  if (!request) return null;
  return (
    <Dialog
      open
      onClose={() => void answer(false)}
      title={
        <span className="orbit-access__title">
          <BrandMark />
          {t("access.title")}
        </span>
      }
      description={t(LEAD[request.tool])}
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
          {POINTS.map(({ icon: Icon, key }) => (
            <li key={key}>
              <Icon size={16} aria-hidden="true" />
              <span>{t(key)}</span>
            </li>
          ))}
        </ul>
        <p className="orbit-access__risk">{t("access.risk")}</p>
      </div>
    </Dialog>
  );
}
