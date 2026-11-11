import type { CustomPage } from "@orbit/protocol";
import { LayoutDashboard } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";
import { EmptyState } from "../../design";
import { useI18n } from "../../i18n";
import { useOrion, useOrionEvent } from "../../lib/orion";
import { customPageUrl, type PageTheme } from "./url";

export { PageCards } from "./PageCards";
export { customPageUrl, type PageTheme } from "./url";

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
  // Undoing a change can remove or bring back a page without any run.
  useOrionEvent("db.changed", (event) => {
    if (event.table === "workspace") void refresh();
  });

  return pages;
}

export const CUSTOM_PAGE_ICON = LayoutDashboard;

export default function CustomPageView({ theme }: { theme: PageTheme }) {
  const { t, intlLocale } = useI18n();
  const { id } = useParams();
  const { endpoint } = useOrion();
  const pages = useCustomPages();
  const page = pages.find((p) => p.id === id);

  if (!page) {
    return (
      <div className="orbit-container" data-testid="custom-page-missing">
        <EmptyState title={t("pages.missing.title")} icon={<LayoutDashboard size={28} />} />
      </div>
    );
  }

  return (
    <div className="orbit-custom-page" data-testid={`custom-page-${page.id}`}>
      <iframe
        key={page.id}
        title={page.title}
        src={customPageUrl(endpoint, page.path, { theme, lang: intlLocale })}
        sandbox="allow-scripts allow-forms"
        className="orbit-custom-page__frame"
        data-testid="custom-page-frame"
      />
    </div>
  );
}
