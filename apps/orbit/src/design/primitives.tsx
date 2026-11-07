import { AlertCircle, CheckCircle2, Info, Loader2, Orbit as OrbitIcon, X } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  createContext,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { useT } from "../i18n";

export type ButtonVariant = "primary" | "secondary" | "subtle" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  children,
  className = "",
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  const classes = ["orbit-btn", `orbit-btn--${variant}`, `orbit-btn--${size}`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      <span
        className={loading ? "orbit-btn__content orbit-btn__content--hidden" : "orbit-btn__content"}
      >
        {icon}
        {children}
      </span>
      {loading && (
        <span className="orbit-btn__spinner" aria-hidden="true">
          <Loader2 size={18} className="orbit-spin" />
        </span>
      )}
    </button>
  );
}

export type CardVariant = "default" | "elevated" | "subtle";

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  variant?: CardVariant;
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
}

export function Card({
  variant = "default",
  title,
  subtitle,
  actions,
  footer,
  children,
  className = "",
  ...rest
}: CardProps) {
  const variantClass = variant === "default" ? "" : `orbit-card--${variant}`;
  const classes = ["orbit-card", variantClass, className].filter(Boolean).join(" ");

  return (
    <section className={classes} {...rest}>
      {(title || subtitle || actions) && (
        <header className="orbit-card__header">
          <div>
            {title && <h2 className="orbit-card__title">{title}</h2>}
            {subtitle && <p className="orbit-card__subtitle">{subtitle}</p>}
          </div>
          {actions && <div>{actions}</div>}
        </header>
      )}
      <div className="orbit-card__body">{children}</div>
      {footer && <footer className="orbit-card__footer">{footer}</footer>}
    </section>
  );
}

export type BadgeVariant = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  icon?: ReactNode;
}

export function Badge({
  variant = "neutral",
  icon,
  children,
  className = "",
  ...rest
}: BadgeProps) {
  const classes = ["orbit-badge", `orbit-badge--${variant}`, className].filter(Boolean).join(" ");
  return (
    <span className={classes} {...rest}>
      {icon}
      {children}
    </span>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

export function Input({ label, hint, error, id, className = "", ...rest }: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;

  return (
    <div className={`orbit-field ${className}`.trim()}>
      {label && (
        <label htmlFor={inputId} className="orbit-label">
          {label}
        </label>
      )}
      <input
        id={inputId}
        className="orbit-input"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        {...rest}
      />
      {error ? (
        <p id={errorId} className="orbit-field__error" role="alert">
          {error}
        </p>
      ) : (
        hint && (
          <p id={hintId} className="orbit-field__hint">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  options?: SelectOption[];
}

export function Select({
  label,
  hint,
  error,
  options,
  children,
  id,
  className = "",
  ...rest
}: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const hintId = `${selectId}-hint`;
  const errorId = `${selectId}-error`;

  return (
    <div className={`orbit-field ${className}`.trim()}>
      {label && (
        <label htmlFor={selectId} className="orbit-label">
          {label}
        </label>
      )}
      <select
        id={selectId}
        className="orbit-select"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        {...rest}
      >
        {options
          ? options.map((opt) => (
              <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                {opt.label}
              </option>
            ))
          : children}
      </select>
      {error ? (
        <p id={errorId} className="orbit-field__error" role="alert">
          {error}
        </p>
      ) : (
        hint && (
          <p id={hintId} className="orbit-field__hint">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

export function Dialog({ open, onClose, title, description, children, footer }: DialogProps) {
  const t = useT();
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="orbit-overlay-scrim">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className="orbit-dialog"
      >
        <header className="orbit-card__header">
          <div>
            <h2 id={titleId} className="orbit-card__title">
              {title}
            </h2>
            {description && (
              <p id={descId} className="orbit-card__subtitle">
                {description}
              </p>
            )}
          </div>
          <Button
            variant="subtle"
            size="sm"
            onClick={onClose}
            aria-label={t("design.dialog.close")}
            icon={<X size={18} />}
          />
        </header>
        <div className="orbit-card__body" style={{ overflowY: "auto" }}>
          {children}
        </div>
        {footer && <footer className="orbit-card__footer">{footer}</footer>}
      </div>
    </div>
  );
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

export function Drawer({ open, onClose, title, subtitle, children, footer }: DrawerProps) {
  const t = useT();
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="orbit-drawer-scrim">
      <aside role="dialog" aria-modal="true" aria-labelledby={titleId} className="orbit-drawer">
        <header className="orbit-card__header">
          <div>
            <h2 id={titleId} className="orbit-card__title">
              {title}
            </h2>
            {subtitle && <p className="orbit-card__subtitle">{subtitle}</p>}
          </div>
          <Button
            variant="subtle"
            size="sm"
            onClick={onClose}
            aria-label={t("design.drawer.close")}
            icon={<X size={18} />}
          />
        </header>
        <div className="orbit-card__body" style={{ overflowY: "auto" }}>
          {children}
        </div>
        {footer && <footer className="orbit-card__footer">{footer}</footer>}
      </aside>
    </div>
  );
}

export interface TabItem {
  id: string;
  label: ReactNode;
  content?: ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  value?: string;
  defaultValue?: string;
  onChange?: (id: string) => void;
  ariaLabel?: string;
}

export function Tabs({ items, value, defaultValue, onChange, ariaLabel }: TabsProps) {
  const t = useT();
  const [internal, setInternal] = useState<string>(defaultValue ?? items[0]?.id ?? "");
  const activeId = value ?? internal;
  const baseId = useId();

  const selectTab = (id: string) => {
    if (value === undefined) setInternal(id);
    onChange?.(id);
  };

  const activeItem = items.find((item) => item.id === activeId) ?? items[0];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      <div
        role="tablist"
        aria-label={ariaLabel ?? t("design.tabs.label")}
        className="orbit-tablist"
      >
        {items.map((item) => {
          const selected = item.id === activeItem?.id;
          return (
            <button
              key={item.id}
              id={`${baseId}-tab-${item.id}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${item.id}`}
              className="orbit-tab"
              onClick={() => selectTab(item.id)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {activeItem?.content !== undefined && (
        <div
          id={`${baseId}-panel-${activeItem.id}`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-${activeItem.id}`}
        >
          {activeItem.content}
        </div>
      )}
    </div>
  );
}

export type ToastTone = "info" | "ok" | "warn" | "danger";

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  tone?: ToastTone;
}

interface ToastContextValue {
  toasts: ToastItem[];
  pushToast: (toast: Omit<ToastItem, "id">) => string;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (toast: Omit<ToastItem, "id">) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev, { ...toast, id }]);
      setTimeout(() => {
        dismissToast(id);
      }, 5000);
      return id;
    },
    [dismissToast],
  );

  const value = useMemo(
    () => ({ toasts, pushToast, dismissToast }),
    [toasts, pushToast, dismissToast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toasts.length > 0 && (
        <aside
          aria-label={t("design.toast.region")}
          style={{
            position: "fixed",
            insetBlockEnd: "var(--space-5)",
            insetInlineEnd: "var(--space-5)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
            zIndex: 60,
            maxInlineSize: "24rem",
          }}
        >
          {toasts.map((toast) => (
            <Toast key={toast.id} item={toast} onDismiss={() => dismissToast(toast.id)} />
          ))}
        </aside>
      )}
    </ToastContext.Provider>
  );
}

export function Toast({ item, onDismiss }: { item: ToastItem; onDismiss?: () => void }) {
  const t = useT();
  const tone = item.tone ?? "info";
  const icon =
    tone === "ok" ? (
      <CheckCircle2 size={18} style={{ color: "var(--status-ok)" }} />
    ) : tone === "danger" || tone === "warn" ? (
      <AlertCircle
        size={18}
        style={{
          color: tone === "danger" ? "var(--status-danger)" : "var(--status-warn)",
        }}
      />
    ) : (
      <Info size={18} style={{ color: "var(--status-info)" }} />
    );

  return (
    <output
      className="orbit-card"
      style={{
        padding: "var(--space-3) var(--space-4)",
        flexDirection: "row",
        alignItems: "flex-start",
        gap: "var(--space-3)",
        boxShadow: "var(--shadow-md)",
      }}
    >
      <span style={{ marginTop: "2px" }}>{icon}</span>
      <div style={{ flex: 1, minInlineSize: 0 }}>
        <div style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>{item.title}</div>
        {item.description && (
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--text-secondary)",
              marginTop: "var(--space-1)",
            }}
          >
            {item.description}
          </div>
        )}
      </div>
      {onDismiss && (
        <Button
          variant="subtle"
          size="sm"
          onClick={onDismiss}
          aria-label={t("design.toast.dismiss")}
          icon={<X size={14} />}
        />
      )}
    </output>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return {
      toasts: [],
      pushToast: () => "",
      dismissToast: () => {},
    };
  }
  return ctx;
}

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "var(--space-8) var(--space-6)",
        gap: "var(--space-3)",
        backgroundColor: "var(--bg-elevated)",
        borderRadius: "var(--radius-lg)",
      }}
    >
      <div
        style={{
          inlineSize: "3rem",
          blockSize: "3rem",
          borderRadius: "var(--radius-md)",
          backgroundColor: "var(--accent-primary-subtle)",
          color: "var(--accent-primary)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {icon ?? <OrbitIcon size={22} />}
      </div>
      <h3
        style={{
          margin: 0,
          fontSize: "var(--text-h3)",
        }}
      >
        {title}
      </h3>
      {description && (
        <p
          style={{
            margin: 0,
            maxInlineSize: "38ch",
            color: "var(--text-secondary)",
            fontSize: "var(--text-sm)",
          }}
        >
          {description}
        </p>
      )}
      {action && <div style={{ marginTop: "var(--space-2)" }}>{action}</div>}
    </div>
  );
}

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  width?: string | number;
  height?: string | number;
}

export function Skeleton({
  width = "100%",
  height = "1.25rem",
  style,
  className = "",
  ...rest
}: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={`orbit-skeleton ${className}`.trim()}
      style={{
        inlineSize: width,
        blockSize: height,
        ...style,
      }}
      {...rest}
    />
  );
}
