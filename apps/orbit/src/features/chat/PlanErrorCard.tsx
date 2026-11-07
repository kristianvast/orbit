import { CreditCard, KeyRound, X } from "lucide-react";
import { useNavigate } from "react-router";
import { Button } from "../../design";
import { useT } from "../../i18n";

export type PlanErrorCode = "plan_required" | "budget_exceeded";

export function classifyPlanError(
  code?: string | null,
  message?: string | null,
): PlanErrorCode | null {
  if (code === "plan_required") return "plan_required";
  if (code === "budget_exceeded") return "budget_exceeded";
  const text = `${code ?? ""} ${message ?? ""}`.toLowerCase();
  if (
    text.includes("plan_required") ||
    text.includes("choose a plan") ||
    text.includes("sign in with a paid plan")
  ) {
    return "plan_required";
  }
  if (text.includes("budget_exceeded") || text.includes("allowance is used up")) {
    return "budget_exceeded";
  }
  return null;
}

export interface PlanErrorCardProps {
  readonly code: PlanErrorCode;
  readonly message?: string | null;
  readonly onDismiss?: () => void;
}

export function PlanErrorCard({ code, onDismiss }: PlanErrorCardProps) {
  const t = useT();
  const navigate = useNavigate();

  const title =
    code === "plan_required"
      ? t("chat.planError.planRequiredTitle")
      : t("chat.planError.budgetExceededTitle");
  const defaultBody =
    code === "plan_required"
      ? t("chat.planError.planRequiredBody")
      : t("chat.planError.budgetExceededBody");

  return (
    <section
      className="orbit-plan-error"
      role="alert"
      data-testid="chat-plan-error-card"
      data-error-code={code}
    >
      <div className="orbit-plan-error__header">
        <div className="orbit-plan-error__titles">
          <h3 className="orbit-plan-error__title">{title}</h3>
          <p className="orbit-plan-error__body">{defaultBody}</p>
        </div>
        {onDismiss && (
          <button
            type="button"
            className="orbit-thread__icon"
            aria-label={t("chat.page.dismissError")}
            onClick={onDismiss}
            data-testid="chat-plan-error-dismiss"
          >
            <X size={15} aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="orbit-plan-error__actions">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          icon={<KeyRound size={14} />}
          onClick={() => void navigate("/settings#providers")}
          data-testid="chat-plan-error-use-key"
        >
          {t("chat.planError.useOwnKey")}
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          icon={<CreditCard size={14} />}
          onClick={() => void navigate("/settings#account")}
          data-testid="chat-plan-error-see-plans"
        >
          {t("chat.planError.seePlans")}
        </Button>
      </div>
    </section>
  );
}
