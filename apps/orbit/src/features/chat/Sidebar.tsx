import type { SessionSummary } from "@orbit/protocol";
import { Check, GitBranch, Pencil, Search, SquarePen, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { type I18nContextValue, useI18n } from "../../i18n";
import { groupSessionsByRecency } from "./turns";

function formatActivityTime(
  iso: string,
  { t, formatDate }: Pick<I18nContextValue, "t" | "formatDate">,
): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const diffMin = Math.round((Date.now() - ms) / 60_000);
  if (diffMin < 1) return t("chat.time.now");
  if (diffMin < 60) return t("chat.time.minutes", { count: diffMin });
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return t("chat.time.hours", { count: diffHr });
  const diffDays = Math.round(diffHr / 24);
  if (diffDays < 7) return t("chat.time.days", { count: diffDays });
  return formatDate(ms, { month: "short", day: "numeric" });
}

export interface ThreadSidebarProps {
  sessions: SessionSummary[];
  activeId: string | null;
  isDraft: boolean;
  loading: boolean;
  open: boolean;
  onNew: () => void;
  onOpen: (sessionId: string) => void;
  onRename: (sessionId: string, title: string) => Promise<void>;
  onFork: (sessionId: string) => void;
  onDelete: (session: SessionSummary) => void;
}

export function ThreadSidebar({
  sessions,
  activeId,
  isDraft,
  loading,
  open,
  onNew,
  onOpen,
  onRename,
  onFork,
  onDelete,
}: ThreadSidebarProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const [search, setSearch] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const sections = useMemo(() => {
    const q = search.trim().toLowerCase();
    const visible = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
    return groupSessionsByRecency(visible);
  }, [sessions, search]);

  const commitRename = async (sessionId: string) => {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (title) await onRename(sessionId, title);
  };

  return (
    <aside
      className="orbit-threads"
      data-open={open ? "true" : "false"}
      aria-label={t("chat.sidebar.label")}
      data-testid="sessions-sidebar"
    >
      <div className="orbit-threads__top">
        <button
          type="button"
          className="orbit-threads__new"
          data-active={isDraft ? "true" : "false"}
          onClick={onNew}
          data-testid="session-new-button"
        >
          <SquarePen size={16} aria-hidden="true" />
          <span>{t("chat.page.newChat")}</span>
        </button>
        <label className="orbit-threads__search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            placeholder={t("chat.sidebar.searchPlaceholder")}
            aria-label={t("chat.sidebar.searchLabel")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="session-search-input"
          />
        </label>
      </div>

      <nav className="orbit-threads__list" data-testid="sessions-list">
        {loading && sessions.length === 0 ? (
          <p className="orbit-threads__empty">{t("chat.sidebar.loading")}</p>
        ) : sections.length === 0 ? (
          <p className="orbit-threads__empty" data-testid="sessions-empty">
            {search ? t("chat.sidebar.emptySearch") : t("chat.sidebar.empty")}
          </p>
        ) : (
          sections.map((section) => (
            <section key={section.bucket} className="orbit-threads__section">
              <h3 className="orbit-threads__label">{t(section.labelKey)}</h3>
              <ul>
                {section.sessions.map((session) => {
                  const isActive = session.id === activeId;
                  if (renamingId === session.id) {
                    return (
                      <li
                        key={session.id}
                        className="orbit-thread orbit-thread--editing"
                        data-active={isActive ? "true" : "false"}
                        data-testid={`session-item-${session.id}`}
                      >
                        <input
                          ref={(el) => el?.focus()}
                          type="text"
                          className="orbit-thread__rename"
                          aria-label={t("chat.sidebar.renameInput")}
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void commitRename(session.id);
                            else if (e.key === "Escape") setRenamingId(null);
                          }}
                          data-testid={`session-rename-input-${session.id}`}
                        />
                        <button
                          type="button"
                          className="orbit-thread__icon"
                          aria-label={t("chat.sidebar.saveTitle")}
                          onClick={() => void commitRename(session.id)}
                          data-testid={`session-rename-save-${session.id}`}
                        >
                          <Check size={14} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="orbit-thread__icon"
                          aria-label={t("chat.sidebar.cancelRename")}
                          onClick={() => setRenamingId(null)}
                          data-testid={`session-rename-cancel-${session.id}`}
                        >
                          <X size={14} aria-hidden="true" />
                        </button>
                      </li>
                    );
                  }
                  return (
                    <li
                      key={session.id}
                      className="orbit-thread"
                      data-active={isActive ? "true" : "false"}
                      data-streaming={session.streaming ? "true" : "false"}
                      data-testid={`session-item-${session.id}`}
                    >
                      <button
                        type="button"
                        className="orbit-thread__open"
                        aria-current={isActive ? "page" : undefined}
                        onClick={() => onOpen(session.id)}
                        data-testid={`session-open-${session.id}`}
                      >
                        <span
                          className="orbit-thread__status"
                          data-testid={
                            session.streaming ? `session-running-${session.id}` : undefined
                          }
                        >
                          {session.streaming && (
                            <span className="orbit-visually-hidden">
                              {t("chat.sidebar.running")}
                            </span>
                          )}
                        </span>
                        <span className="orbit-thread__title">{session.title}</span>
                        <span className="orbit-thread__time tabular-nums">
                          {formatActivityTime(session.updatedAt, i18n)}
                        </span>
                      </button>
                      <div className="orbit-thread__actions">
                        <button
                          type="button"
                          className="orbit-thread__icon"
                          title={t("chat.sidebar.rename")}
                          aria-label={t("chat.sidebar.renameLabel", { title: session.title })}
                          onClick={() => {
                            setRenamingId(session.id);
                            setRenameDraft(session.title);
                          }}
                          data-testid={`session-rename-button-${session.id}`}
                        >
                          <Pencil size={13} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="orbit-thread__icon"
                          title={t("chat.page.branch")}
                          aria-label={t("chat.sidebar.branchLabel", { title: session.title })}
                          onClick={() => onFork(session.id)}
                          data-testid={`session-fork-button-${session.id}`}
                        >
                          <GitBranch size={13} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="orbit-thread__icon orbit-thread__icon--danger"
                          title={t("chat.sidebar.delete")}
                          aria-label={t("chat.sidebar.deleteLabel", { title: session.title })}
                          onClick={() => onDelete(session)}
                          data-testid={`session-delete-button-${session.id}`}
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </nav>
    </aside>
  );
}
