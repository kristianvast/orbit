import "./chat.css";
import type { ApprovalDecision, SessionSummary, TranscriptItem } from "@orbit/protocol";
import {
  AlertCircle,
  ArrowDown,
  Bot,
  Camera,
  Check,
  Clock,
  GitBranch,
  Loader2,
  MessageSquarePlus,
  Orbit as OrbitIcon,
  Pencil,
  Radio,
  Send,
  ShieldAlert,
  Square,
  Tag,
  Trash2,
  User,
  X,
} from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router";
import { Badge, Button, Dialog, Input, useToast } from "../../design";
import { useOrion } from "../../lib/orion";
import { ApprovalCard } from "./ApprovalCard";
import {
  clearSessionApprovals,
  recordApprovalRequest,
  resolveApprovalRecord,
  usePendingApprovals,
} from "./approvals";
import { SafeMarkdown } from "./markdown";
import { chatReducer, createInitialChatState, type PendingApprovalItem } from "./reducer";
import { ToolCard } from "./ToolCard";

export {
  ApprovalCard,
  type ApprovalCardProps,
} from "./ApprovalCard";
export {
  clearSessionApprovals,
  getPendingApprovalsSnapshot,
  recordApprovalRequest,
  resetPendingApprovalsForTests,
  resolveApprovalRecord,
  usePendingApprovalCount,
  usePendingApprovals,
} from "./approvals";
export { parseMarkdownBlocks, SafeMarkdown } from "./markdown";
export {
  type ChatAction,
  type ChatState,
  chatReducer,
  createInitialChatState,
  type PendingApprovalItem,
} from "./reducer";
export {
  formatToolDuration,
  formatToolStatusBadge,
  getFriendlyToolMeta,
  ToolCard,
  type ToolCardProps,
} from "./ToolCard";

export interface StarterPrompt {
  id: string;
  label: string;
  prompt: string;
  category: string;
  icon: typeof Tag;
}

export const STARTER_PROMPTS: StarterPrompt[] = [
  {
    id: "milk-yield",
    label: "Which cows had lower milk yield this week?",
    prompt: "Which cows had lower milk yield this week?",
    category: "Herd & milking",
    icon: Tag,
  },
  {
    id: "list-cows",
    label: "List cows in my herd and their sensors",
    prompt: "List cows in my herd",
    category: "Cows & horses",
    icon: Tag,
  },
  {
    id: "find-cameras",
    label: "Find cameras on my network",
    prompt: "Find cameras on my network",
    category: "Barn cameras",
    icon: Camera,
  },
  {
    id: "connect-ear-tags",
    label: "Connect my ear tag sensors",
    prompt: "Connect my ear tag sensors and check active bindings",
    category: "Sensors",
    icon: Radio,
  },
];

function formatActivityTime(iso: string): string {
  const date = new Date(iso);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return iso;
  const diffMin = Math.round((Date.now() - ms) / 60_000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.round(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export default function ChatPage() {
  const { client, state: connState } = useOrion();
  const { pushToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const { pendingApprovals, pendingCount } = usePendingApprovals();

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionSearch, setSessionSearch] = useState("");

  const [chatState, dispatch] = useReducer(chatReducer, undefined, () =>
    createInitialChatState(null),
  );

  const [composerText, setComposerText] = useState(() => {
    return searchParams.get("prompt") ?? "";
  });
  const [sendingMode, setSendingMode] = useState<"prompt" | "steer" | "followUp" | null>(null);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deletingSession, setDeletingSession] = useState<SessionSummary | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);

  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const activeSessionIdRef = useRef<string | null>(null);
  activeSessionIdRef.current = chatState.sessionId;

  useEffect(() => {
    const promptParam = searchParams.get("prompt");
    if (promptParam && promptParam.trim().length > 0) {
      setComposerText(promptParam);
      const next = new URLSearchParams(searchParams);
      next.delete("prompt");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const openSession = useCallback(
    async (sessionId: string) => {
      if (!client) return;
      try {
        const res = await client.request("sessions.open", { sessionId });
        dispatch({
          type: "session.opened",
          session: res.session,
          items: res.items,
        });
        setSessions((prev) => {
          const exists = prev.some((s) => s.id === res.session.id);
          if (!exists) return [res.session, ...prev];
          return prev.map((s) => (s.id === res.session.id ? res.session : s));
        });
        setAutoScroll(true);
      } catch (err) {
        pushToast({
          title: "Could not open conversation",
          description: err instanceof Error ? err.message : String(err),
          tone: "danger",
        });
      }
    },
    [client, pushToast],
  );

  const loadSessions = useCallback(async () => {
    if (!client) return;
    setSessionsLoading(true);
    try {
      const res = await client.request("sessions.list");
      setSessions(res.sessions);
      if (res.sessions.length > 0 && !activeSessionIdRef.current) {
        const first = res.sessions[0];
        if (first) {
          await openSession(first.id);
        }
      }
    } catch (err) {
      pushToast({
        title: "Could not load conversations",
        description: err instanceof Error ? err.message : String(err),
        tone: "warn",
      });
    } finally {
      setSessionsLoading(false);
    }
  }, [client, openSession, pushToast]);

  useEffect(() => {
    if (!client) return;
    if (connState === "open" || connState === "connecting") {
      void loadSessions();
    }
  }, [client, connState, loadSessions]);

  useEffect(() => {
    if (!client) return;
    return client.on("*", (event) => {
      if (event.type === "session.updated") {
        setSessions((prev) => {
          const exists = prev.some((s) => s.id === event.session.id);
          const updated = exists
            ? prev.map((s) => (s.id === event.session.id ? event.session : s))
            : [event.session, ...prev];
          return [...updated].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        });
      }
      if (event.type === "approval.request") {
        recordApprovalRequest(event);
      }
      if (event.type === "approval.resolved") {
        resolveApprovalRecord(event.approvalId);
      }
      if (event.type === "agent.settled" && event.reason === "aborted") {
        clearSessionApprovals(event.sessionId);
      }
      dispatch({ type: "server.event", event });
    });
  }, [client]);

  useEffect(() => {
    if (!autoScroll) return;
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  });

  const handleTranscriptScroll = () => {
    const el = transcriptRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAutoScroll(distanceFromBottom <= 48);
  };

  const scrollToBottom = () => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setAutoScroll(true);
  };

  const handleCreateSession = async () => {
    if (!client) return;
    try {
      const res = await client.request("sessions.create", {});
      setSessions((prev) => [res.session, ...prev]);
      dispatch({
        type: "session.opened",
        session: res.session,
        items: [],
      });
      setAutoScroll(true);
    } catch (err) {
      pushToast({
        title: "Could not start new conversation",
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    }
  };

  const handleStartRename = (session: SessionSummary) => {
    setRenamingId(session.id);
    setRenameDraft(session.title);
  };

  const handleCommitRename = async (sessionId: string) => {
    const trimmed = renameDraft.trim();
    if (!client || !trimmed) {
      setRenamingId(null);
      return;
    }
    try {
      const res = await client.request("sessions.rename", {
        sessionId,
        title: trimmed,
      });
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? res.session : s)));
      if (chatState.sessionId === sessionId) {
        dispatch({
          type: "session.opened",
          session: res.session,
          items: chatState.items,
        });
      }
    } catch (err) {
      pushToast({
        title: "Could not rename conversation",
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    } finally {
      setRenamingId(null);
    }
  };

  const handleForkSession = async (sessionId: string, fromItemId?: string) => {
    if (!client) return;
    try {
      const forked = await client.request("sessions.fork", {
        sessionId,
        ...(fromItemId ? { fromItemId } : {}),
      });
      setSessions((prev) => [forked.session, ...prev]);
      await openSession(forked.session.id);
      pushToast({
        title: "Branched conversation ready",
        description: `Opened "${forked.session.title}" so you can try a different answer.`,
        tone: "ok",
      });
    } catch (err) {
      pushToast({
        title: "Could not fork conversation",
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    }
  };

  const handleConfirmDelete = async () => {
    if (!client || !deletingSession) return;
    setDeletingBusy(true);
    const targetId = deletingSession.id;
    try {
      await client.request("sessions.delete", { sessionId: targetId });
      clearSessionApprovals(targetId);
      const remaining = sessions.filter((s) => s.id !== targetId);
      setSessions(remaining);
      setDeletingSession(null);

      if (chatState.sessionId === targetId) {
        const nextSession = remaining[0];
        if (nextSession) {
          await openSession(nextSession.id);
        } else {
          dispatch({ type: "session.cleared" });
        }
      }
      pushToast({
        title: "Conversation deleted",
        tone: "info",
      });
    } catch (err) {
      pushToast({
        title: "Could not delete conversation",
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    } finally {
      setDeletingBusy(false);
    }
  };

  const sendToOrion = async (textToSend: string, mode: "prompt" | "steer" | "followUp") => {
    const trimmed = textToSend.trim();
    if (!client || !trimmed) return;

    setSendingMode(mode);
    try {
      let targetSessionId = chatState.sessionId;
      if (!targetSessionId) {
        const created = await client.request("sessions.create", {});
        targetSessionId = created.session.id;
        setSessions((prev) => [created.session, ...prev]);
        dispatch({
          type: "session.opened",
          session: created.session,
          items: [],
        });
      }

      dispatch({
        type: "optimistic.user_message",
        text: trimmed,
      });
      setComposerText("");
      setAutoScroll(true);

      if (mode === "steer") {
        await client.request("chat.steer", {
          sessionId: targetSessionId,
          text: trimmed,
        });
      } else if (mode === "followUp") {
        await client.request("chat.followUp", {
          sessionId: targetSessionId,
          text: trimmed,
        });
      } else {
        await client.request("chat.prompt", {
          sessionId: targetSessionId,
          text: trimmed,
        });
      }
    } catch (err) {
      pushToast({
        title: "Could not send message to Orion",
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    } finally {
      setSendingMode(null);
    }
  };

  const handleStopRun = async () => {
    if (!client || !chatState.sessionId) return;
    try {
      await client.request("chat.abort", { sessionId: chatState.sessionId });
    } catch (err) {
      pushToast({
        title: "Could not stop Orion",
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    }
  };

  const handleApprovalRespond = async (approvalId: string, decision: ApprovalDecision) => {
    if (!client) return;
    try {
      await client.request("approval.respond", { approvalId, decision });
      resolveApprovalRecord(approvalId);
    } catch (err) {
      pushToast({
        title: "Could not send approval response",
        description: err instanceof Error ? err.message : String(err),
        tone: "danger",
      });
    }
  };

  const handleComposerKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!composerText.trim() || sendingMode !== null) return;
      const mode = chatState.streaming ? "steer" : "prompt";
      void sendToOrion(composerText, mode);
    }
  };

  const filteredSessions = useMemo(() => {
    const q = sessionSearch.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(q));
  }, [sessions, sessionSearch]);

  const sessionApprovals = useMemo(() => {
    const map = new Map<string, PendingApprovalItem>();
    for (const a of chatState.approvals) {
      if (!chatState.sessionId || a.sessionId === chatState.sessionId) {
        map.set(a.approvalId, a);
      }
    }
    for (const globalReq of pendingApprovals) {
      if (!chatState.sessionId || globalReq.sessionId === chatState.sessionId) {
        if (!map.has(globalReq.approvalId)) {
          map.set(globalReq.approvalId, {
            ...globalReq,
            status: "pending",
          });
        }
      }
    }
    return [...map.values()];
  }, [chatState.approvals, chatState.sessionId, pendingApprovals]);

  const approvalsByToolCallId = useMemo(() => {
    const map = new Map<string, PendingApprovalItem[]>();
    for (const a of sessionApprovals) {
      if (a.toolCallId) {
        const list = map.get(a.toolCallId) ?? [];
        list.push(a);
        map.set(a.toolCallId, list);
      }
    }
    return map;
  }, [sessionApprovals]);

  const standaloneApprovals = useMemo(() => {
    const toolIds = new Set(
      chatState.items
        .filter((it): it is Extract<TranscriptItem, { kind: "tool" }> => it.kind === "tool")
        .map((it) => it.toolCallId),
    );
    return sessionApprovals.filter((a) => !a.toolCallId || !toolIds.has(a.toolCallId));
  }, [chatState.items, sessionApprovals]);

  return (
    <div className="orbit-container" data-testid="chat-page">
      <div className="orbit-chat-layout">
        <aside
          className="orbit-chat-sidebar"
          aria-label="Conversations with Orion"
          data-testid="sessions-sidebar"
        >
          <div className="orbit-chat-sidebar__header">
            <div className="orbit-chat-sidebar__title-row">
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                }}
              >
                <h2
                  style={{
                    margin: 0,
                    fontFamily: "var(--font-display)",
                    fontSize: "var(--text-lg)",
                    fontWeight: 700,
                  }}
                >
                  Conversations
                </h2>
                {pendingCount > 0 && (
                  <Badge
                    variant="warn"
                    className="tabular-nums"
                    data-testid="pending-approvals-badge"
                  >
                    {pendingCount} waiting
                  </Badge>
                )}
              </div>

              <Button
                variant="primary"
                size="sm"
                onClick={handleCreateSession}
                icon={<MessageSquarePlus size={15} />}
                data-testid="session-new-button"
              >
                New chat
              </Button>
            </div>

            <Input
              type="search"
              placeholder="Search conversations…"
              aria-label="Search conversations"
              value={sessionSearch}
              onChange={(e) => setSessionSearch(e.target.value)}
              data-testid="session-search-input"
            />
          </div>

          <ul className="orbit-chat-sidebar__list" data-testid="sessions-list">
            {sessionsLoading && sessions.length === 0 ? (
              <li
                style={{
                  padding: "var(--space-4)",
                  fontSize: "var(--text-sm)",
                  color: "var(--text-secondary)",
                }}
              >
                Loading conversations…
              </li>
            ) : filteredSessions.length === 0 ? (
              <li
                style={{
                  padding: "var(--space-4)",
                  fontSize: "var(--text-sm)",
                  color: "var(--text-secondary)",
                  textAlign: "center",
                }}
                data-testid="sessions-empty"
              >
                {sessionSearch
                  ? "No conversations match your search."
                  : "No past conversations yet."}
              </li>
            ) : (
              filteredSessions.map((session) => {
                const isActive = session.id === chatState.sessionId;
                const isRenaming = renamingId === session.id;
                const hasPendingApproval = pendingApprovals.some((a) => a.sessionId === session.id);

                return (
                  <li
                    key={session.id}
                    className="orbit-session-item"
                    data-active={isActive ? "true" : "false"}
                    data-testid={`session-item-${session.id}`}
                  >
                    {isRenaming ? (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "var(--space-2)",
                        }}
                      >
                        <input
                          type="text"
                          className="orbit-input"
                          aria-label="Conversation title"
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              void handleCommitRename(session.id);
                            } else if (e.key === "Escape") {
                              setRenamingId(null);
                            }
                          }}
                          data-testid={`session-rename-input-${session.id}`}
                        />
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "flex-end",
                            gap: "var(--space-2)",
                          }}
                        >
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setRenamingId(null)}
                            icon={<X size={14} />}
                            data-testid={`session-rename-cancel-${session.id}`}
                          >
                            Cancel
                          </Button>
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => handleCommitRename(session.id)}
                            icon={<Check size={14} />}
                            data-testid={`session-rename-save-${session.id}`}
                          >
                            Save
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="orbit-session-select-btn"
                          onClick={() => openSession(session.id)}
                          data-testid={`session-open-${session.id}`}
                        >
                          <span className="orbit-session-title">{session.title}</span>
                          <div className="orbit-session-meta">
                            <span
                              className="tabular-nums"
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "var(--space-1)",
                              }}
                            >
                              <Clock size={11} aria-hidden="true" />
                              {formatActivityTime(session.updatedAt)}
                            </span>
                            <span className="tabular-nums">
                              {session.messageCount} msg
                              {session.messageCount === 1 ? "" : "s"}
                            </span>
                            {session.streaming && <Badge variant="info">Running</Badge>}
                            {hasPendingApproval && <Badge variant="warn">Needs approval</Badge>}
                          </div>
                        </button>

                        <div className="orbit-session-actions">
                          <button
                            type="button"
                            className="orbit-icon-btn"
                            title="Rename conversation"
                            aria-label={`Rename ${session.title}`}
                            onClick={() => handleStartRename(session)}
                            data-testid={`session-rename-button-${session.id}`}
                          >
                            <Pencil size={13} aria-hidden="true" />
                            <span>Rename</span>
                          </button>
                          <button
                            type="button"
                            className="orbit-icon-btn"
                            title="Try a different answer (fork conversation)"
                            aria-label={`Try a different answer from ${session.title}`}
                            onClick={() => handleForkSession(session.id)}
                            data-testid={`session-fork-button-${session.id}`}
                          >
                            <GitBranch size={13} aria-hidden="true" />
                            <span>Try a different answer</span>
                          </button>
                          <button
                            type="button"
                            className="orbit-icon-btn orbit-icon-btn--danger"
                            title="Delete conversation"
                            aria-label={`Delete ${session.title}`}
                            onClick={() => setDeletingSession(session)}
                            data-testid={`session-delete-button-${session.id}`}
                          >
                            <Trash2 size={13} aria-hidden="true" />
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                );
              })
            )}
          </ul>
        </aside>

        <section className="orbit-chat-main" aria-label="Conversation with Orion">
          <header className="orbit-chat-header">
            <div style={{ minInlineSize: 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "var(--space-2)",
                }}
              >
                <h1
                  style={{
                    margin: 0,
                    fontFamily: "var(--font-display)",
                    fontSize: "var(--text-h3)",
                    fontWeight: 700,
                    lineHeight: "var(--leading-heading)",
                    letterSpacing: "var(--tracking-heading)",
                  }}
                  data-testid="chat-active-title"
                >
                  {chatState.session?.title ?? "Ask Orion"}
                </h1>
                {chatState.streaming && (
                  <Badge
                    variant="info"
                    icon={<Loader2 size={12} className="orbit-spin" />}
                    data-testid="chat-streaming-indicator"
                  >
                    Orion is working…
                  </Badge>
                )}
                {pendingCount > 0 && (
                  <Badge
                    variant="warn"
                    icon={<ShieldAlert size={12} />}
                    data-testid="chat-header-approval-badge"
                  >
                    {pendingCount} approval{pendingCount === 1 ? "" : "s"} waiting
                  </Badge>
                )}
              </div>
              <p
                style={{
                  margin: "var(--space-1) 0 0 0",
                  fontSize: "var(--text-xs)",
                  color: "var(--text-secondary)",
                }}
              >
                Ask about your cattle, horses, sensors, milking robot, or barn cameras. Undo is on
                for every change.
              </p>
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
              }}
            >
              {chatState.session && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    if (chatState.session) {
                      void handleForkSession(chatState.session.id);
                    }
                  }}
                  icon={<GitBranch size={15} />}
                  data-testid="chat-header-fork-button"
                >
                  Try a different answer
                </Button>
              )}
              {chatState.streaming && (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={handleStopRun}
                  icon={<Square size={14} />}
                  data-testid="chat-stop-button"
                >
                  Stop
                </Button>
              )}
            </div>
          </header>

          <div
            ref={transcriptRef}
            onScroll={handleTranscriptScroll}
            className="orbit-chat-transcript"
            data-testid="chat-transcript"
          >
            {chatState.items.length === 0 && standaloneApprovals.length === 0 ? (
              <div
                style={{
                  marginInline: "auto",
                  inlineSize: "100%",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  textAlign: "center",
                  gap: "var(--space-3)",
                  padding: "var(--space-2) var(--space-3)",
                  maxInlineSize: "44rem",
                }}
                data-testid="chat-empty-state"
              >
                <div
                  style={{
                    inlineSize: "2.75rem",
                    blockSize: "2.75rem",
                    borderRadius: "var(--radius-full)",
                    backgroundColor: "var(--accent-primary-subtle)",
                    border: "1px solid var(--accent-primary-border)",
                    color: "var(--accent-primary)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <OrbitIcon size={22} />
                </div>

                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--space-1)",
                  }}
                >
                  <h2
                    style={{
                      margin: 0,
                      fontFamily: "var(--font-display)",
                      fontSize: "var(--text-h3)",
                      fontWeight: 700,
                    }}
                  >
                    How can Orion help in the barn today?
                  </h2>
                  <p
                    style={{
                      margin: 0,
                      color: "var(--text-secondary)",
                      fontSize: "var(--text-sm)",
                      maxInlineSize: "50ch",
                    }}
                  >
                    Pick a question below or type your own. Orion reads your herd records on this PC
                    and asks before changing records or scanning your network.
                  </p>
                </div>

                <div className="orbit-starter-grid" data-testid="starter-prompts-grid">
                  {STARTER_PROMPTS.map((starter) => {
                    const StarterIcon = starter.icon;
                    return (
                      <button
                        key={starter.id}
                        type="button"
                        className="orbit-starter-btn"
                        onClick={() => void sendToOrion(starter.prompt, "prompt")}
                        data-testid={`starter-prompt-${starter.id}`}
                      >
                        <span
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "var(--space-2)",
                            fontSize: "var(--text-xs)",
                            fontWeight: 650,
                            color: "var(--accent-primary)",
                          }}
                        >
                          <StarterIcon size={14} aria-hidden="true" />
                          {starter.category}
                        </span>
                        <span
                          style={{
                            fontSize: "var(--text-sm)",
                            fontWeight: 600,
                            color: "var(--text-primary)",
                          }}
                        >
                          {starter.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <>
                {chatState.items.map((item) => {
                  if (item.kind === "user") {
                    const activeId = chatState.sessionId;
                    const canForkItem =
                      Boolean(activeId) &&
                      !item.id.startsWith("optimistic-") &&
                      !item.id.startsWith("msg_");
                    return (
                      <article
                        key={item.id}
                        className="orbit-msg-user"
                        data-testid={`message-user-${item.id}`}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "var(--space-3)",
                          }}
                        >
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "var(--space-1)",
                              fontSize: "var(--text-xs)",
                              fontWeight: 700,
                              color: "var(--accent-primary)",
                            }}
                          >
                            <User size={13} aria-hidden="true" />
                            You
                          </span>
                          {canForkItem && activeId && (
                            <button
                              type="button"
                              className="orbit-icon-btn"
                              onClick={() => handleForkSession(activeId, item.id)}
                              title="Branch conversation from this question"
                              data-testid={`message-fork-${item.id}`}
                            >
                              <GitBranch size={12} aria-hidden="true" />
                              <span>Try a different answer</span>
                            </button>
                          )}
                        </div>
                        <div
                          style={{
                            fontSize: "var(--text-base)",
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            color: "var(--text-primary)",
                          }}
                        >
                          {item.text}
                        </div>
                      </article>
                    );
                  }

                  if (item.kind === "assistant") {
                    return (
                      <article
                        key={item.id}
                        className="orbit-msg-assistant"
                        data-testid={`message-assistant-${item.id}`}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "var(--space-2)",
                          }}
                        >
                          <span
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "var(--space-2)",
                              fontSize: "var(--text-xs)",
                              fontWeight: 700,
                              color: "var(--accent-secondary)",
                            }}
                          >
                            <Bot size={15} aria-hidden="true" />
                            Orion
                          </span>
                          {item.model && (
                            <span
                              style={{
                                fontFamily: "var(--font-mono)",
                                fontSize: "var(--text-xs)",
                                color: "var(--text-muted)",
                              }}
                            >
                              {item.model}
                            </span>
                          )}
                        </div>

                        {item.thinking && (
                          <div
                            data-testid={`message-thinking-${item.id}`}
                            style={{
                              padding: "var(--space-2) var(--space-3)",
                              borderRadius: "var(--radius-md)",
                              backgroundColor: "var(--bg-surface)",
                              border: "1px solid var(--border-subtle)",
                              fontSize: "var(--text-xs)",
                              color: "var(--text-secondary)",
                              fontStyle: "italic",
                            }}
                          >
                            Thinking: {item.thinking}
                          </div>
                        )}

                        {item.text ? (
                          <SafeMarkdown text={item.text} />
                        ) : (
                          chatState.streaming && (
                            <div
                              data-testid="thinking-indicator"
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "var(--space-2)",
                                fontSize: "var(--text-sm)",
                                color: "var(--text-secondary)",
                              }}
                            >
                              <Loader2 size={15} className="orbit-spin" aria-hidden="true" />
                              <span>Orion is thinking…</span>
                            </div>
                          )
                        )}

                        {item.errorMessage && (
                          <div
                            role="alert"
                            style={{
                              padding: "var(--space-2) var(--space-3)",
                              borderRadius: "var(--radius-md)",
                              backgroundColor: "var(--status-danger-bg)",
                              border: "1px solid var(--status-danger-border)",
                              color: "var(--status-danger)",
                              fontSize: "var(--text-xs)",
                              fontWeight: 600,
                            }}
                          >
                            {item.errorMessage}
                          </div>
                        )}
                      </article>
                    );
                  }

                  if (item.kind === "tool") {
                    const linkedApprovals = approvalsByToolCallId.get(item.toolCallId) ?? [];
                    return (
                      <div
                        key={item.id}
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: "var(--space-3)",
                        }}
                      >
                        <ToolCard item={item} />
                        {linkedApprovals.map((app) => (
                          <ApprovalCard
                            key={app.approvalId}
                            approval={app}
                            onRespond={handleApprovalRespond}
                          />
                        ))}
                      </div>
                    );
                  }

                  return (
                    <div
                      key={item.id}
                      className="orbit-msg-system"
                      data-testid={`message-system-${item.id}`}
                    >
                      {item.text}
                    </div>
                  );
                })}

                {standaloneApprovals.map((app) => (
                  <ApprovalCard
                    key={app.approvalId}
                    approval={app}
                    onRespond={handleApprovalRespond}
                  />
                ))}

                {chatState.streaming &&
                  chatState.items[chatState.items.length - 1]?.kind === "user" && (
                    <div
                      data-testid="thinking-indicator"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "var(--space-2)",
                        padding: "var(--space-3) var(--space-4)",
                        borderRadius: "var(--radius-md)",
                        backgroundColor: "var(--bg-elevated)",
                        border: "1px solid var(--border-subtle)",
                        fontSize: "var(--text-sm)",
                        color: "var(--text-secondary)",
                        alignSelf: "flex-start",
                      }}
                    >
                      <Loader2 size={16} className="orbit-spin" aria-hidden="true" />
                      <span>Orion is checking your farm records…</span>
                    </div>
                  )}
              </>
            )}

            {chatState.lastError && (
              <div
                role="alert"
                data-testid="chat-error-banner"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "var(--space-3)",
                  padding: "var(--space-3) var(--space-4)",
                  borderRadius: "var(--radius-md)",
                  backgroundColor: "var(--status-danger-bg)",
                  border: "1px solid var(--status-danger-border)",
                  color: "var(--text-primary)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-2)",
                    fontSize: "var(--text-sm)",
                  }}
                >
                  <AlertCircle size={18} style={{ color: "var(--status-danger)", flexShrink: 0 }} />
                  <span>{chatState.lastError}</span>
                </div>
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={() => dispatch({ type: "error.clear" })}
                >
                  Dismiss
                </Button>
              </div>
            )}
          </div>

          <footer className="orbit-chat-composer-bar">
            {!autoScroll && (
              <div style={{ display: "flex", justifyContent: "center" }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={scrollToBottom}
                  icon={<ArrowDown size={14} />}
                  data-testid="chat-scroll-bottom-button"
                >
                  Jump to latest message
                </Button>
              </div>
            )}

            <label
              htmlFor="orion-composer-input"
              style={{
                fontSize: "var(--text-xs)",
                fontWeight: 600,
                color: "var(--text-secondary)",
              }}
            >
              {chatState.streaming
                ? "Orion is working — add to the current task or queue for after:"
                : "Message Orion (Enter to send, Shift+Enter for new line)"}
            </label>

            <textarea
              id="orion-composer-input"
              className="orbit-chat-textarea"
              placeholder="Ask Orion about your cows, horses, sensors, milking robot, or cameras…"
              value={composerText}
              onChange={(e) => setComposerText(e.target.value)}
              onKeyDown={handleComposerKeyDown}
              data-testid="chat-composer-input"
            />

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                flexWrap: "wrap",
                gap: "var(--space-3)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "var(--space-2)",
                }}
              >
                {chatState.streaming ? (
                  <>
                    <Button
                      variant="primary"
                      size="md"
                      loading={sendingMode === "steer"}
                      disabled={!composerText.trim() || sendingMode !== null}
                      onClick={() => void sendToOrion(composerText, "steer")}
                      icon={<Send size={16} />}
                      data-testid="chat-steer-button"
                    >
                      Add to current task
                    </Button>
                    <Button
                      variant="secondary"
                      size="md"
                      loading={sendingMode === "followUp"}
                      disabled={!composerText.trim() || sendingMode !== null}
                      onClick={() => void sendToOrion(composerText, "followUp")}
                      data-testid="chat-followup-button"
                    >
                      After this
                    </Button>
                    <Button
                      variant="danger"
                      size="md"
                      onClick={handleStopRun}
                      icon={<Square size={15} />}
                      data-testid="chat-composer-stop-button"
                    >
                      Stop
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="primary"
                    size="md"
                    loading={sendingMode === "prompt"}
                    disabled={!composerText.trim() || sendingMode !== null}
                    onClick={() => void sendToOrion(composerText, "prompt")}
                    icon={<Send size={16} />}
                    data-testid="chat-send-button"
                  >
                    Ask Orion
                  </Button>
                )}
              </div>
            </div>
          </footer>
        </section>
      </div>

      <Dialog
        open={deletingSession !== null}
        onClose={() => setDeletingSession(null)}
        title="Delete conversation?"
        description={
          deletingSession
            ? `Are you sure you want to delete "${deletingSession.title}"? Your herd records and farm snapshots are kept safe.`
            : undefined
        }
        footer={
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: "var(--space-3)",
              inlineSize: "100%",
            }}
          >
            <Button
              variant="secondary"
              onClick={() => setDeletingSession(null)}
              data-testid="session-delete-cancel"
            >
              Keep conversation
            </Button>
            <Button
              variant="danger"
              loading={deletingBusy}
              onClick={handleConfirmDelete}
              icon={<Trash2 size={16} />}
              data-testid="session-delete-confirm"
            >
              Delete conversation
            </Button>
          </div>
        }
      >
        <p style={{ margin: 0, fontSize: "var(--text-sm)" }}>
          This removes the chat transcript from this PC. Any database or workspace changes Orion
          made can still be undone in Settings.
        </p>
      </Dialog>
    </div>
  );
}
