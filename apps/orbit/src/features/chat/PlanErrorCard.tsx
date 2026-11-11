import { CreditCard, KeyRound, X } from "lucide-react";
import { useNavigate } from "react-router";
import { Button } from "../../design";
import { useT } from "../../i18n";

export type PlanErrorCode = "plan_required" | "budget_exceeded" | "model_required";

export function classifyPlanError(
  code?: string | null,
  message?: string | null,
): PlanErrorCode | null {
  if (code === "plan_required") return "plan_required";
  if (code === "budget_exceeded") return "budget_exceeded";
  if (code === "model_required") return "model_required";
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
  // Orion's not_ready refusal when no provider/model is chosen (SessionHub.ensureAgent).
  if (text.includes("no ai model is set up")) return "model_required";
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
      : code === "model_required"
        ? t("chat.planError.modelRequiredTitle")
        : t("chat.planError.budgetExceededTitle");
  const defaultBody =
    code === "plan_required"
      ? t("chat.planError.planRequiredBody")
      : code === "model_required"
        ? t("chat.planError.modelRequiredBody")
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
          {code === "model_required"
            ? t("chat.planError.setUpModel")
            : t("chat.planError.useOwnKey")}
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          icon={<CreditCard size={14} />}
          onClick={() =>
            void navigate(
              "/settings#account",
              code === "model_required" ? { state: { accountMode: "register" } } : undefined,
            )
          }
          data-testid="chat-plan-error-see-plans"
        >
          {code === "model_required"
            ? t("chat.planError.startTrial")
            : t("chat.planError.seePlans")}
        </Button>
      </div>
    </section>
  );
}
