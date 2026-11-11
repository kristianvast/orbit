import type { AssistantItem, ToolItem, TranscriptItem } from "@orbit/protocol";
import {
  AlertCircle,
  Brain,
  Check,
  ChevronRight,
  Copy,
  GitBranch,
  Loader2,
  Mic,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { SafeMarkdown } from "./markdown";
import { getFriendlyToolMeta, summarizeToolArgs, ToolCard } from "./ToolCard";
import {
  buildTurnBlocks,
  buildTurns,
  collapseToolRuns,
  formatElapsed,
  selectLiveTool,
  summarizeToolGroup,
  type Turn,
  turnDurationMs,
} from "./turns";

function useElapsedLabel(since: string | null, active: boolean): string {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  const start = since ? Date.parse(since) : Number.NaN;
  if (Number.isNaN(start)) return t("chat.timeline.working");
  return t("chat.timeline.workingFor", { elapsed: formatElapsed(Math.max(0, now - start), t) });
}

function WorkingLine({ since }: { since: string | null }) {
  const label = useElapsedLabel(since, true);
  return (
    <div className="orbit-working" data-testid="thinking-indicator" aria-live="polite">
      <span className="orbit-working__pulse" aria-hidden="true" />
      <span className="orbit-working__label">{label}</span>
    </div>
  );
}

function WorkedFor({ ms }: { ms: number }) {
  const t = useT();
  return (
    <div className="orbit-worked" data-testid="turn-worked-for">
      <span>{t("chat.timeline.workedFor", { elapsed: formatElapsed(ms, t) })}</span>
    </div>
  );
}

function ToolGroup({ tools, live }: { tools: ToolItem[]; live: boolean }) {
  const t = useT();
  const running = tools.some((tool) => tool.status === "running");
  const isLiveRunning = live || running;
  const [open, setOpen] = useState(false);
  const expanded = open;

  const first = tools[0];
  if (tools.length === 1 && first && !isLiveRunning) {
    return (
      <div className="orbit-tools">
        <ToolCard item={first} />
      </div>
    );
  }

  const activeTool = selectLiveTool(tools);
  const activeMeta = activeTool ? getFriendlyToolMeta(t, activeTool.name, activeTool.label) : null;
  const activeArg = activeTool ? summarizeToolArgs(activeTool.name, activeTool.args, t) : "";
  const liveText = activeMeta
    ? activeArg
      ? `${activeMeta.runningTitle} - ${activeArg}`
      : activeMeta.runningTitle
    : "";

  const summary = summarizeToolGroup(tools);
  const kindSummary = summary.kinds.map((k) => t(k.labelKey, { count: k.count })).join(", ");
  const collapsedRuns = collapseToolRuns(tools, (tool) =>
    summarizeToolArgs(tool.name, tool.args, t),
  );

  return (
    <div className="orbit-tools" data-expanded={expanded ? "true" : "false"}>
      <button
        type="button"
        className="orbit-tools__summary"
        aria-expanded={expanded}
        onClick={() => setOpen((v) => !v)}
        data-testid="tool-group-toggle"
      >
        {isLiveRunning ? (
          <>
            <Loader2 size={13} className="orbit-spin" aria-hidden="true" />
            <span className="orbit-tools__live" data-testid="tool-group-live">
              {liveText}
            </span>
            <span className="orbit-tools__count tabular-nums" data-testid="tool-group-steps">
              {t("chat.timeline.steps", { count: tools.length })}
            </span>
          </>
        ) : (
          <>
            <Wrench size={13} aria-hidden="true" />
            <span className="orbit-tools__count tabular-nums" data-testid="tool-group-steps">
              {t("chat.timeline.steps", { count: summary.total })}
            </span>
            <span className="orbit-tools__sep" aria-hidden="true">
              -
            </span>
            <span className="orbit-tools__names" data-testid="tool-group-kinds">
              {kindSummary}
            </span>
            {summary.failed > 0 && (
              <span className="orbit-tools__failed tabular-nums" data-testid="tool-group-failed">
                {t("chat.timeline.didNotWork", { count: summary.failed })}
              </span>
            )}
          </>
        )}
        <ChevronRight size={14} className="orbit-tools__chevron" aria-hidden="true" />
      </button>
      {expanded && (
        <div className="orbit-tools__list" data-testid="tool-group-list">
          {collapsedRuns.map((run) => (
            <ToolCard key={run.key} item={run.item} repeatCount={run.count} />
          ))}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="orbit-msg-action"
      title={t("chat.timeline.copy")}
      aria-label={t("chat.timeline.copyReply")}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
  );
}

function AssistantMessage({ item }: { item: AssistantItem }) {
  const t = useT();
  if (!item.text && !item.thinking && !item.errorMessage) return null;
  return (
    <article
      className="orbit-msg-assistant"
      data-testid={`message-assistant-${item.id}`}
      data-voice={item.voice ? "true" : undefined}
    >
      {item.voice && (
        <span
          className="orbit-msg-voice-mark"
          role="img"
          title={t("voice.spokenTurn")}
          aria-label={t("voice.spokenTurn")}
          data-testid="message-voice-mark"
        >
          <Mic size={12} aria-hidden="true" />
        </span>
      )}
      {item.thinking && (
        <details className="orbit-thinking" data-testid={`message-thinking-${item.id}`}>
          <summary>
            <Brain size={13} aria-hidden="true" />
            {t("chat.timeline.thinking")}
          </summary>
          <p>{item.thinking}</p>
        </details>
      )}
      {item.text && <SafeMarkdown text={item.text} />}
      {item.errorMessage && (
        <div className="orbit-msg-error" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          {item.errorMessage}
        </div>
      )}
      {item.text && (
        <div className="orbit-msg-actions">
          <CopyButton text={item.text} />
        </div>
      )}
    </article>
  );
}

function TurnView({
  turn,
  live,
  runStartedAt,
  onFork,
}: {
  turn: Turn;
  live: boolean;
  runStartedAt: string | null;
  onFork?: (itemId: string) => void;
}) {
  const t = useT();
  const blocks = buildTurnBlocks(turn.steps);
  const duration = live ? null : turnDurationMs(turn);
  let finalReplyIdx = -1;
  blocks.forEach((b, i) => {
    if (b.kind === "step" && b.item.kind === "assistant" && b.item.text) finalReplyIdx = i;
  });
  const markerAt = duration === null ? -1 : finalReplyIdx >= 0 ? finalReplyIdx : blocks.length;
  const user = turn.user;
  const canFork =
    Boolean(onFork) && user && !user.id.startsWith("optimistic-") && !user.id.startsWith("msg_");

  return (
    <section className="orbit-turn" data-testid={`turn-${turn.id}`}>
      {user?.text && (
        <article
          className="orbit-msg-user"
          data-testid={`message-user-${user.id}`}
          data-voice={user.voice ? "true" : undefined}
        >
          <div className="orbit-msg-user__bubble">
            {user.voice && (
              <span
                className="orbit-msg-voice-mark"
                role="img"
                title={t("voice.spokenTurn")}
                aria-label={t("voice.spokenTurn")}
                data-testid="message-voice-mark"
              >
                <Mic size={12} aria-hidden="true" />
              </span>
            )}
            {user.text}
          </div>
          {canFork && (
            <div className="orbit-msg-actions orbit-msg-actions--end">
              <button
                type="button"
                className="orbit-msg-action"
                title={t("chat.timeline.branchHere")}
                aria-label={t("chat.timeline.branchHereLabel")}
                onClick={() => onFork?.(user.id)}
                data-testid={`message-fork-${user.id}`}
              >
                <GitBranch size={13} aria-hidden="true" />
              </button>
            </div>
          )}
        </article>
      )}
      {blocks.map((block, i) => (
        <div key={block.kind === "tools" ? block.id : block.item.id} className="orbit-turn__block">
          {i === markerAt && duration !== null && <WorkedFor ms={duration} />}
          {block.kind === "tools" ? (
            <ToolGroup tools={block.tools} live={live} />
          ) : block.item.kind === "assistant" ? (
            <AssistantMessage item={block.item} />
          ) : (
            <div className="orbit-msg-system" data-testid={`message-system-${block.item.id}`}>
              {block.item.text}
            </div>
          )}
        </div>
      ))}
      {markerAt === blocks.length && duration !== null && <WorkedFor ms={duration} />}
      {live && <WorkingLine since={runStartedAt} />}
    </section>
  );
}

export interface TimelineProps {
  items: TranscriptItem[];
  streaming: boolean;
  runStartedAt: string | null;
  onFork?: (itemId: string) => void;
}

export function Timeline({ items, streaming, runStartedAt, onFork }: TimelineProps) {
  const turns = buildTurns(items);
  return (
    <div className="orbit-timeline">
      {turns.map((turn, i) => (
        <TurnView
          key={turn.id}
          turn={turn}
          live={streaming && i === turns.length - 1}
          runStartedAt={runStartedAt}
          {...(onFork ? { onFork } : {})}
        />
      ))}
      {streaming && turns.length === 0 && <WorkingLine since={runStartedAt} />}
    </div>
  );
}
