import type { ApprovalDecision } from "@orbit/protocol";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { useState } from "react";
import { Badge, Button } from "../../design";
import type { PendingApprovalItem } from "./reducer";

export interface ApprovalCardProps {
  approval: PendingApprovalItem;
  onRespond: (approvalId: string, decision: ApprovalDecision) => Promise<void> | void;
}

function formatDecisionLabel(decision?: ApprovalDecision): string {
  switch (decision) {
    case "allow_once":
      return "Allowed once";
    case "always_allow":
      return "Always allowed";
    case "deny":
      return "Not allowed";
    default:
      return "Resolved";
  }
}

export function ApprovalCard({ approval, onRespond }: ApprovalCardProps) {
  const [showDetails, setShowDetails] = useState(false);
  const [submitting, setSubmitting] = useState<ApprovalDecision | null>(null);

  const isPending = approval.status === "pending";
  const isHighRisk = approval.risk === "always_ask";

  const handleDecision = async (decision: ApprovalDecision) => {
    if (!isPending || submitting) return;
    setSubmitting(decision);
    try {
      await onRespond(approval.approvalId, decision);
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <section
      aria-label={`Approval request: ${approval.title}`}
      className={`orbit-approval-card orbit-approval-card--${approval.risk}`}
      data-testid={`approval-card-${approval.approvalId}`}
      data-approval-status={approval.status}
      data-approval-risk={approval.risk}
    >
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "var(--space-3)",
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "var(--space-3)",
            minInlineSize: 0,
            flex: 1,
          }}
        >
          <span
            style={{
              marginTop: "2px",
              color: isHighRisk ? "var(--status-danger)" : "var(--status-warn)",
              flexShrink: 0,
            }}
          >
            {isHighRisk ? (
              <ShieldAlert size={22} aria-hidden="true" />
            ) : (
              <AlertTriangle size={22} aria-hidden="true" />
            )}
          </span>
          <div style={{ minInlineSize: 0, flex: 1 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "var(--space-2)",
              }}
            >
              <h3
                style={{
                  margin: 0,
                  fontFamily: "var(--font-display)",
                  fontSize: "var(--text-h3)",
                  fontWeight: 700,
                  color: "var(--text-primary)",
                }}
              >
                {approval.title}
              </h3>
              <Badge variant={isHighRisk ? "danger" : "warn"}>
                {isHighRisk ? "High-risk action" : "Needs your approval"}
              </Badge>
            </div>
            <p
              style={{
                margin: "var(--space-2) 0 0 0",
                fontSize: "var(--text-base)",
                color: "var(--text-primary)",
              }}
              data-testid={`approval-plain-${approval.approvalId}`}
            >
              {approval.plainLanguage}
            </p>
          </div>
        </div>

        {!isPending && (
          <Badge
            variant={approval.decision === "deny" ? "neutral" : "ok"}
            data-testid={`approval-resolved-badge-${approval.approvalId}`}
          >
            {formatDecisionLabel(approval.decision)}
          </Badge>
        )}
      </div>

      <div
        data-testid={`approval-notice-${approval.approvalId}`}
        style={{
          padding: "var(--space-2) var(--space-3)",
          borderRadius: "var(--radius-md)",
          backgroundColor: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          fontSize: "var(--text-xs)",
          fontWeight: 600,
          color: "var(--text-secondary)",
        }}
      >
        AI can make mistakes. Check what Orion wants to do.
      </div>

      <div>
        <button
          type="button"
          className="orbit-icon-btn"
          aria-expanded={showDetails}
          onClick={() => setShowDetails((prev) => !prev)}
          data-testid={`approval-details-toggle-${approval.approvalId}`}
        >
          {showDetails ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <span>Show details</span>
        </button>

        {showDetails && (
          <div
            data-testid={`approval-details-${approval.approvalId}`}
            style={{
              marginTop: "var(--space-2)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2)",
            }}
          >
            <div
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--text-secondary)",
                fontFamily: "var(--font-mono)",
              }}
            >
              Tool: {approval.toolName}
            </div>
            {approval.command ? (
              <pre
                className="orbit-code-block"
                data-testid={`approval-command-${approval.approvalId}`}
              >
                {approval.command}
              </pre>
            ) : (
              <pre
                className="orbit-code-block"
                data-testid={`approval-command-${approval.approvalId}`}
              >
                {`${approval.toolName} (${approval.title})`}
              </pre>
            )}
          </div>
        )}
      </div>

      {isPending && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "var(--space-3)",
          }}
        >
          <Button
            variant="primary"
            size="md"
            loading={submitting === "allow_once"}
            disabled={submitting !== null}
            onClick={() => handleDecision("allow_once")}
            icon={<Check size={16} />}
            data-testid={`approval-allow-once-${approval.approvalId}`}
          >
            Allow once
          </Button>
          <Button
            variant="secondary"
            size="md"
            loading={submitting === "always_allow"}
            disabled={submitting !== null}
            onClick={() => handleDecision("always_allow")}
            icon={<ShieldCheck size={16} />}
            data-testid={`approval-always-allow-${approval.approvalId}`}
          >
            Always allow this
          </Button>
          <Button
            variant="danger"
            size="md"
            loading={submitting === "deny"}
            disabled={submitting !== null}
            onClick={() => handleDecision("deny")}
            icon={<X size={16} />}
            data-testid={`approval-deny-${approval.approvalId}`}
          >
            Don&apos;t allow
          </Button>
        </div>
      )}
    </section>
  );
}
