import { type CustomPage, DEV_SERVER_URL } from "@orbit/protocol";
import { LayoutDashboard } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import { EmptyState } from "../../design";
import { useT } from "../../i18n";
import { type OrionEndpoint, useOrion, useOrionEvent } from "../../lib/orion";

export function useCustomPages(): CustomPage[] {
  const { client, state } = useOrion();
  const [pages, setPages] = useState<CustomPage[]>([]);

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      setPages((await client.request("pages.list", {})).pages);
    } catch {
      setPages([]);
    }
  }, [client]);

  useEffect(() => {
    if (state === "open") void refresh();
  }, [state, refresh]);

  // Orion builds pages during a run; pick them up once it finishes.
  useOrionEvent("agent.settled", () => void refresh());

  return pages;
}

export function customPageUrl(endpoint: OrionEndpoint | null, page: CustomPage): string {
  const origin = new URL(endpoint?.url ?? DEV_SERVER_URL);
  origin.protocol = origin.protocol === "wss:" ? "https:" : "http:";
  return new URL(page.path, origin.origin).toString();
}

export const CUSTOM_PAGE_ICON = LayoutDashboard;

export default function CustomPageView() {
  const t = useT();
  const { id } = useParams();
  const { endpoint } = useOrion();
  const pages = useCustomPages();
  const page = pages.find((p) => p.id === id);

  if (!page) {
    return (
      <div className="orbit-container" data-testid="custom-page-missing">
        <EmptyState
          title={t("pages.missing.title")}
          description={t("pages.missing.description")}
          icon={<LayoutDashboard size={28} />}
        />
      </div>
    );
  }

  return (
    <div className="orbit-custom-page" data-testid={`custom-page-${page.id}`}>
      <iframe
        key={page.id}
        title={page.title}
        src={customPageUrl(endpoint, page)}
        sandbox="allow-scripts allow-forms"
        className="orbit-custom-page__frame"
        data-testid="custom-page-frame"
      />
    </div>
  );
}
