import { ChevronRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function SettingsTitle({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="settings-title">
      <span className="settings-icon" aria-hidden="true">
        <Icon size={16} />
      </span>
      {children}
    </span>
  );
}

export interface SwitchRowProps {
  readonly icon: LucideIcon;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly testId: string;
}

export function SwitchRow({
  icon: Icon,
  label,
  hint,
  checked,
  disabled,
  onChange,
  testId,
}: SwitchRowProps) {
  return (
    <label className="settings-row">
      <Icon size={18} className="settings-row__icon" aria-hidden="true" />
      <span className="settings-row__text">
        <span className="settings-row__label">{label}</span>
        {hint && <span className="settings-row__hint">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        className="settings-switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        data-testid={testId}
      />
    </label>
  );
}

export function More({
  summary,
  children,
  testId,
}: {
  summary: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <details className="settings-more" data-testid={testId}>
      <summary>
        <ChevronRight size={14} aria-hidden="true" />
        {summary}
      </summary>
      <div className="settings-more__body">{children}</div>
    </details>
  );
}
