import type { CustomPage } from "@orbit/protocol";
import { ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { useI18n } from "../../i18n";
import { useOrion } from "../../lib/orion";
import { customPageUrl, type PageTheme } from "./url";
import "./pages.css";

export function PageCards({ pages, theme }: { pages: CustomPage[]; theme: PageTheme }) {
  const { t, intlLocale } = useI18n();
  const { endpoint } = useOrion();
  const cards = pages.flatMap((page) => (page.card ? [{ page, card: page.card }] : []));
  if (cards.length === 0) return null;

  return (
    <section aria-label={t("pages.cards.label")} data-testid="home-cards">
      <ul className="orbit-page-cards">
        {cards.map(({ page, card }) => (
          <li
            key={page.id}
            className="orbit-card orbit-page-card"
            data-testid={`home-card-${page.id}`}
          >
            <Link
              to={`/pages/${page.id}`}
              className="orbit-page-card__link"
              title={page.description}
              data-testid={`home-card-link-${page.id}`}
            >
              <span className="orbit-page-card__title">{page.title}</span>
              <ChevronRight size={16} aria-hidden="true" />
            </Link>
            <iframe
              title={t("pages.cards.frameTitle", { title: page.title })}
              src={customPageUrl(endpoint, card.path, { theme, lang: intlLocale })}
              sandbox="allow-scripts"
              tabIndex={-1}
              loading="lazy"
              className="orbit-page-card__frame"
              data-testid={`home-card-frame-${page.id}`}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
