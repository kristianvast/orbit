import "./chat.css";
import { OrionRequestError, type SessionSummary } from "@orbit/protocol";
import {
  AlertCircle,
  ArrowDown,
  Camera,
  GitBranch,
  LayoutDashboard,
  Orbit as OrbitIcon,
  PanelLeft,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import { Button, Dialog, useToast } from "../../design";
import { type MessageKey, useT } from "../../i18n";
import { useOrion } from "../../lib/orion";
import { Composer, type SendMode } from "./Composer";
import { forgetChat, lastChat, rememberChat } from "./last-chat";
import { classifyPlanError, PlanErrorCard } from "./PlanErrorCard";
import { chatReducer, createInitialChatState } from "./reducer";
import { ThreadSidebar } from "./Sidebar";
import { Timeline } from "./Timeline";
import { isListedSession } from "./turns";
import { VoicePanel } from "./VoicePanel";

export { Composer, type SendMode } from "./Composer";
export { parseMarkdownBlocks, SafeMarkdown } from "./markdown";
export {
  classifyPlanError,
  PlanErrorCard,
  type PlanErrorCardProps,
  type PlanErrorCode,
} from "./PlanErrorCard";
export {
  type ChatAction,
  type ChatState,
  chatReducer,
  createInitialChatState,
  type QueuedMessage,
} from "./reducer";
export { ThreadSidebar } from "./Sidebar";
export { Timeline } from "./Timeline";
export {
  formatToolDuration,
  formatToolStatusBadge,
  getFriendlyToolMeta,
  summarizeToolArgs,
  ToolCard,
  type ToolCardProps,
} from "./ToolCard";
export {
  buildTurnBlocks,
  buildTurns,
  type CollapsedToolRun,
  classifyToolKind,
  collapseToolRuns,
  groupSessionsByRecency,
  isListedSession,
  selectLiveTool,
  summarizeToolGroup,
  type ToolActivityKind,
  type ToolActivitySummary,
  type ToolKindCount,
  turnDurationMs,
} from "./turns";
export { VoicePanel, type VoicePanelProps, type VoiceState } from "./VoicePanel";
export {
  base64ToPcm16Float32,
  pcm16ToBase64,
  resampleTo16kHzPcm16,
} from "./voice-audio";

export interface StarterPrompt {
  id: string;
  labelKey: MessageKey;
  promptKey: MessageKey;
  categoryKey: MessageKey;
  icon: typeof Tag;
}

export const STARTER_PROMPTS: StarterPrompt[] = [
  {
    id: "milk-yield",
    labelKey: "chat.starter.milkYield.label",
    promptKey: "chat.starter.milkYield.prompt",
    categoryKey: "chat.starter.milkYield.category",
    icon: Tag,
  },
  {
    id: "list-cows",
    labelKey: "chat.starter.listCows.label",
    promptKey: "chat.starter.listCows.prompt",
    categoryKey: "chat.starter.listCows.category",
    icon: Tag,
  },
  {
    id: "find-cameras",
    labelKey: "chat.starter.findCameras.label",
    promptKey: "chat.starter.findCameras.prompt",
    categoryKey: "chat.starter.findCameras.category",
    icon: Camera,
  },
  {
    id: "build-page",
    labelKey: "chat.starter.buildPage.label",
    promptKey: "chat.starter.buildPage.prompt",
    categoryKey: "chat.starter.buildPage.category",
    icon: LayoutDashboard,
  },
];

const SESSION_PARAM = "s";

function shortModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const slash = model.indexOf("/");
  return slash >= 0 ? model.slice(slash + 1) : model;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function ChatPage() {
  const { client, state: connState } = useOrion();
  const { pushToast } = useToast();
  const t = useT();
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const statePrefill =
    typeof (location.state as { prefill?: unknown } | null)?.prefill === "string"
      ? ((location.state as { prefill: string }).prefill ?? "")
      : typeof (location.state as { prompt?: unknown } | null)?.prompt === "string"
        ? ((location.state as { prompt: string }).prompt ?? "")
        : "";

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [chatState, dispatch] = useReducer(chatReducer, undefined, () =>
    createInitialChatState(null),
  );
  const [composerText, setComposerText] = useState(
    () => searchParams.get("prompt") ?? statePrefill,
  );
  const [sendingPrompt, setSendingPrompt] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [deletingSession, setDeletingSession] = useState<SessionSummary | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const initialSessionParam = useRef(searchParams.get(SESSION_PARAM));
  // Arriving with a question to ask (from Home, say) starts a new conversation instead.
  const resumeLast = useRef(!searchParams.get("prompt") && !statePrefill.trim());
  const sessionIdRef = useRef(chatState.sessionId);
  sessionIdRef.current = chatState.sessionId;

  useEffect(() => {
    if (chatState.sessionId) rememberChat(chatState.sessionId);
  }, [chatState.sessionId]);

  // Leaving Chat is the moment "last used" is counted from.
  useEffect(
    () => () => {
      if (sessionIdRef.current) rememberChat(sessionIdRef.current);
    },
    [],
  );

  const isDraft = chatState.sessionId === null;

  const setSessionParam = useCallback(
    (sessionId: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (sessionId) next.set(SESSION_PARAM, sessionId);
          else next.delete(SESSION_PARAM);
          next.delete("prompt");
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // `?prompt=...&send=1` (Home and "Ask Orion to add it") sends once Orion is connected.
  const [autoSend, setAutoSend] = useState<string | null>(null);

  useEffect(() => {
    const promptParam = searchParams.get("prompt");
    if (promptParam?.trim()) {
      setComposerText(promptParam);
      if (searchParams.get("send") === "1") setAutoSend(promptParam);
      const next = new URLSearchParams(searchParams);
      next.delete("prompt");
      next.delete("send");
      setSearchParams(next, { replace: true });
    } else if (statePrefill.trim()) {
      setComposerText(statePrefill);
    }
  }, [searchParams, setSearchParams, statePrefill]);

  const upsertSession = useCallback((session: SessionSummary) => {
    setSessions((prev) => {
      const exists = prev.some((s) => s.id === session.id);
      const next = exists
        ? prev.map((s) => (s.id === session.id ? session : s))
        : [session, ...prev];
      return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }, []);

  const openSession = useCallback(
    async (sessionId: string) => {
      if (!client) return;
      try {
        const res = await client.request("sessions.open", { sessionId });
        dispatch({ type: "session.opened", session: res.session, items: res.items });
        upsertSession(res.session);
        setSessionParam(res.session.id);
        setAtBottom(true);
        setSidebarOpen(false);
        composerRef.current?.focus();
      } catch (err) {
        pushToast({
          title: t("chat.toast.openFailed"),
          description: errorText(err),
          tone: "danger",
        });
      }
    },
    [client, pushToast, setSessionParam, upsertSession, t],
  );

  const openSessionRef = useRef(openSession);
  openSessionRef.current = openSession;

  const startDraft = useCallback(() => {
    dispatch({ type: "session.cleared" });
    forgetChat();
    setSessionParam(null);
    setAtBottom(true);
    setSidebarOpen(false);
    composerRef.current?.focus();
  }, [setSessionParam]);

  useEffect(() => {
    if (!client || connState !== "open") return;
    let cancelled = false;
    setSessionsLoading(true);
    void (async () => {
      try {
        const [list, settings] = await Promise.all([
          client.request("sessions.list"),
          client.request("settings.get").catch(() => null),
        ]);
        if (cancelled) return;
        setSessions(list.sessions);
        if (settings?.model) setDefaultModel(settings.model);
        const last = resumeLast.current ? lastChat() : null;
        resumeLast.current = false;
        const wanted = initialSessionParam.current ?? last?.id ?? null;
        const fromLink = initialSessionParam.current !== null;
        initialSessionParam.current = null;
        const found = list.sessions.find((s) => s.id === wanted);
        // A conversation Orion is still working in is returned to however long it has been.
        if (found && (fromLink || last?.recent || found.streaming)) {
          await openSessionRef.current(found.id);
        }
      } catch (err) {
        if (!cancelled) {
          pushToast({
            title: t("chat.toast.loadFailed"),
            description: errorText(err),
            tone: "warn",
          });
        }
      } finally {
        if (!cancelled) setSessionsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, connState, pushToast, t]);

  useEffect(() => {
    if (!client) return;
    return client.on("*", (event) => {
      if (event.type === "session.updated") upsertSession(event.session);
      dispatch({ type: "server.event", event });
    });
  }, [client, upsertSession]);

  useEffect(() => {
    if (!atBottom) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight <= 48);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  };

  const ensureSession = useCallback(async (): Promise<string> => {
    if (chatState.sessionId) return chatState.sessionId;
    if (!client) throw new Error("Orion client is not connected");
    const created = await client.request("sessions.create", {});
    upsertSession(created.session);
    dispatch({ type: "session.opened", session: created.session, items: [] });
    setSessionParam(created.session.id);
    return created.session.id;
  }, [chatState.sessionId, client, setSessionParam, upsertSession]);

  const send = async (mode: SendMode, override?: string) => {
    const text = (override ?? composerText).trim();
    if (!client || !text) return;
    if (mode === "prompt") {
      if (sendingPrompt) return;
      setSendingPrompt(true);
    }
    let sessionId = chatState.sessionId;
    const optimisticId = `optimistic-${crypto.randomUUID()}`;
    try {
      if (!sessionId) {
        sessionId = await ensureSession();
      }
      if (mode === "prompt") {
        dispatch({ type: "optimistic.user_message", text, id: optimisticId });
        setComposerText("");
        setAtBottom(true);
        await client.request("chat.prompt", { sessionId, text });
      } else {
        const id = crypto.randomUUID();
        dispatch({ type: "queue.add", message: { id, text, mode } });
        setComposerText("");
        try {
          await client.request(mode === "steer" ? "chat.steer" : "chat.followUp", {
            sessionId,
            text,
          });
        } catch (err) {
          dispatch({ type: "queue.remove", id });
          throw err;
        }
      }
    } catch (err) {
      const code = err instanceof OrionRequestError ? err.code : undefined;
      const msg = errorText(err);
      const planCode = classifyPlanError(code, msg);
      // Orion refused the prompt, so no run started: undo the optimistic turn and hand the text back.
      if (mode === "prompt") dispatch({ type: "optimistic.rollback", id: optimisticId });
      setComposerText((current) => current || text);
      if (planCode) {
        dispatch({ type: "error.set", code: planCode, message: msg });
      } else {
        pushToast({
          title: t("chat.toast.sendFailed"),
          description: msg,
          tone: "danger",
        });
      }
    } finally {
      if (mode === "prompt") setSendingPrompt(false);
    }
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    if (!autoSend || !client || connState !== "open") return;
    setAutoSend(null);
    void sendRef.current("prompt", autoSend);
  }, [autoSend, client, connState]);

  const stopRun = async () => {
    const sessionId = chatState.sessionId;
    // Nothing running on Orion's side means nothing will settle the run; settle it here.
    if (!sessionId) return;
    const settleLocally = () =>
      dispatch({
        type: "server.event",
        event: { type: "agent.settled", sessionId, reason: "aborted" },
      });
    if (!client) {
      settleLocally();
      return;
    }
    try {
      const res = await client.request("chat.abort", { sessionId });
      if (!res.accepted) settleLocally();
    } catch (err) {
      settleLocally();
      pushToast({
        title: t("chat.toast.stopFailed"),
        description: errorText(err),
        tone: "danger",
      });
    }
  };

  const renameSession = async (sessionId: string, title: string) => {
    if (!client) return;
    try {
      const res = await client.request("sessions.rename", { sessionId, title });
      upsertSession(res.session);
      dispatch({
        type: "server.event",
        event: { type: "session.updated", sessionId, session: res.session },
      });
    } catch (err) {
      pushToast({
        title: t("chat.toast.renameFailed"),
        description: errorText(err),
        tone: "danger",
      });
    }
  };

  const forkSession = async (sessionId: string, fromItemId?: string) => {
    if (!client) return;
    try {
      const forked = await client.request("sessions.fork", {
        sessionId,
        ...(fromItemId ? { fromItemId } : {}),
      });
      upsertSession(forked.session);
      await openSession(forked.session.id);
      pushToast({
        title: t("chat.toast.branched"),
        description: t("chat.toast.branchedDescription", { title: forked.session.title }),
        tone: "ok",
      });
    } catch (err) {
      pushToast({
        title: t("chat.toast.branchFailed"),
        description: errorText(err),
        tone: "danger",
      });
    }
  };

  const confirmDelete = async () => {
    if (!client || !deletingSession) return;
    setDeletingBusy(true);
    const targetId = deletingSession.id;
    try {
      await client.request("sessions.delete", { sessionId: targetId });
      setSessions((prev) => prev.filter((s) => s.id !== targetId));
      setDeletingSession(null);
      if (chatState.sessionId === targetId) startDraft();
      pushToast({ title: t("chat.toast.deleted"), tone: "info" });
    } catch (err) {
      pushToast({
        title: t("chat.toast.deleteFailed"),
        description: errorText(err),
        tone: "danger",
      });
    } finally {
      setDeletingBusy(false);
    }
  };

  const listedSessions = useMemo(
    () => sessions.filter((s) => isListedSession(s, chatState.sessionId)),
    [sessions, chatState.sessionId],
  );

  const showHero = chatState.items.length === 0 && !chatState.streaming && !voiceOpen;
  const title = chatState.session?.title ?? t("chat.page.newChat");
  const modelLabel = shortModel(chatState.session?.model ?? defaultModel);
  const activeSessionId = chatState.sessionId;

  return (
    <div className="orbit-container orbit-chat-page" data-testid="chat-page">
      <div className="orbit-chat" data-sidebar-open={sidebarOpen ? "true" : "false"}>
        <ThreadSidebar
          sessions={listedSessions}
          activeId={chatState.sessionId}
          isDraft={isDraft}
          loading={sessionsLoading}
          open={sidebarOpen}
          onNew={startDraft}
          onOpen={(id) => void openSession(id)}
          onRename={renameSession}
          onFork={(id) => void forkSession(id)}
          onDelete={setDeletingSession}
        />
        {sidebarOpen && (
          <button
            type="button"
            className="orbit-chat__scrim"
            aria-label={t("chat.page.closeSidebar")}
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <section className="orbit-thread-pane" aria-label={t("chat.page.paneLabel")}>
          <header className="orbit-thread-pane__header">
            <button
              type="button"
              className="orbit-thread-pane__toggle"
              aria-label={t("chat.page.showSidebar")}
              onClick={() => setSidebarOpen(true)}
              data-testid="chat-sidebar-toggle"
            >
              <PanelLeft size={18} aria-hidden="true" />
            </button>
            <h1 className="orbit-thread-pane__title" data-testid="chat-active-title">
              {title}
            </h1>
            {chatState.streaming && (
              <span className="orbit-thread-pane__running" data-testid="chat-streaming-indicator">
                <span className="orbit-thread-pane__dot" aria-hidden="true" />
                {t("chat.page.working")}
              </span>
            )}
            <div className="orbit-thread-pane__actions">
              {activeSessionId && chatState.items.length > 0 && (
                <button
                  type="button"
                  className="orbit-thread__icon"
                  title={t("chat.page.branch")}
                  aria-label={t("chat.page.branch")}
                  onClick={() => void forkSession(activeSessionId)}
                  data-testid="chat-header-fork-button"
                >
                  <GitBranch size={15} aria-hidden="true" />
                </button>
              )}
            </div>
          </header>

          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="orbit-thread-pane__scroll"
            data-testid="chat-transcript"
          >
            {showHero ? (
              <div className="orbit-hero" data-testid="chat-empty-state">
                <span className="orbit-hero__mark" aria-hidden="true">
                  <OrbitIcon size={22} />
                </span>
                <h2 className="orbit-hero__title">{t("chat.hero.title")}</h2>
                <div className="orbit-starter-grid" data-testid="starter-prompts-grid">
                  {STARTER_PROMPTS.map((starter) => {
                    const StarterIcon = starter.icon;
                    return (
                      <button
                        key={starter.id}
                        type="button"
                        className="orbit-starter-btn"
                        onClick={() => void send("prompt", t(starter.promptKey))}
                        data-testid={`starter-prompt-${starter.id}`}
                      >
                        <span className="orbit-starter-btn__category">
                          <StarterIcon size={13} aria-hidden="true" />
                          {t(starter.categoryKey)}
                        </span>
                        <span className="orbit-starter-btn__label">{t(starter.labelKey)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <Timeline
                items={chatState.items}
                streaming={chatState.streaming}
                runStartedAt={chatState.runStartedAt}
                {...(activeSessionId
                  ? { onFork: (itemId: string) => void forkSession(activeSessionId, itemId) }
                  : {})}
              />
            )}

            {(() => {
              const planErrorCode = classifyPlanError(chatState.lastErrorCode, chatState.lastError);
              if (planErrorCode) {
                return (
                  <PlanErrorCard
                    code={planErrorCode}
                    message={chatState.lastError}
                    onDismiss={() => dispatch({ type: "error.clear" })}
                  />
                );
              }
              if (!chatState.lastError) return null;
              return (
                <div className="orbit-chat-error" role="alert" data-testid="chat-error-banner">
                  <AlertCircle size={16} aria-hidden="true" />
                  <span>{chatState.lastError}</span>
                  <button
                    type="button"
                    className="orbit-thread__icon"
                    aria-label={t("chat.page.dismissError")}
                    onClick={() => dispatch({ type: "error.clear" })}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
              );
            })()}
          </div>

          <footer className="orbit-thread-pane__footer">
            {!atBottom && (
              <button
                type="button"
                className="orbit-jump"
                onClick={jumpToLatest}
                data-testid="chat-scroll-bottom-button"
              >
                <ArrowDown size={14} aria-hidden="true" />
                {t("chat.page.jumpToLatest")}
              </button>
            )}
            {voiceOpen && (
              <VoicePanel
                sessionId={activeSessionId}
                ensureSession={ensureSession}
                onClose={() => setVoiceOpen(false)}
              />
            )}
            <Composer
              value={composerText}
              onChange={setComposerText}
              onSend={(mode) => void send(mode)}
              onStop={() => void stopRun()}
              onStartVoice={() => setVoiceOpen((v) => !v)}
              voiceOpen={voiceOpen}
              streaming={chatState.streaming}
              sendingPrompt={sendingPrompt}
              queued={chatState.queued}
              modelLabel={modelLabel}
              inputRef={composerRef}
            />
          </footer>
        </section>
      </div>

      <Dialog
        open={deletingSession !== null}
        onClose={() => setDeletingSession(null)}
        title={t("chat.delete.title")}
        description={
          deletingSession
            ? t("chat.delete.description", { title: deletingSession.title })
            : undefined
        }
        footer={
          <div className="orbit-dialog-actions">
            <Button
              variant="secondary"
              onClick={() => setDeletingSession(null)}
              data-testid="session-delete-cancel"
            >
              {t("chat.delete.keep")}
            </Button>
            <Button
              variant="danger"
              loading={deletingBusy}
              onClick={confirmDelete}
              icon={<Trash2 size={16} />}
              data-testid="session-delete-confirm"
            >
              {t("chat.delete.confirm")}
            </Button>
          </div>
        }
      >
        <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>{t("chat.delete.body")}</p>
      </Dialog>
    </div>
  );
}
