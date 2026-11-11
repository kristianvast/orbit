import { MessageSquare, Plus, Radar, ShieldCheck } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Badge, Button, Card, Dialog, Input } from "../../design";
import { useT } from "../../i18n";

export interface CamerasPageHeaderProps {
  readonly onlineCount: number;
  readonly totalCount: number;
  readonly onFindOnNetwork: () => void;
  readonly onAddCamera: () => void;
}

export function CamerasPageHeader({
  onlineCount,
  totalCount,
  onFindOnNetwork,
  onAddCamera,
}: CamerasPageHeaderProps) {
  const t = useT();

  return (
    <>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "var(--space-4)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <h1
            style={{
              margin: 0,
              fontFamily: "var(--font-display)",
              fontSize: "var(--text-h1)",
              fontWeight: "var(--display-weight)",
              lineHeight: "var(--leading-tight)",
              letterSpacing: "var(--tracking-display)",
            }}
          >
            {t("cameras.page.title")}
          </h1>
          <Badge
            variant={onlineCount === totalCount && totalCount > 0 ? "ok" : "warn"}
            className="tabular-nums"
          >
            {t("cameras.page.onlineCount", { online: onlineCount, total: totalCount })}
          </Badge>
        </div>

        <div
          style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}
        >
          <Button
            variant="secondary"
            size="md"
            icon={<Radar size={18} />}
            data-testid="cameras-find-network-btn"
            onClick={onFindOnNetwork}
          >
            {t("cameras.page.findOnNetwork")}
          </Button>
          <Button
            variant="primary"
            size="md"
            icon={<Plus size={18} />}
            data-testid="cameras-add-btn"
            onClick={onAddCamera}
          >
            {t("cameras.page.addCamera")}
          </Button>
        </div>
      </header>

      <Card variant="elevated" title={t("cameras.privacy.title")}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "var(--space-4)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "var(--space-3)",
              maxInlineSize: "64ch",
            }}
          >
            <ShieldCheck
              size={22}
              style={{ color: "var(--status-ok)", flexShrink: 0, marginTop: "2px" }}
            />
            <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
              {t("cameras.privacy.bodyBefore")}
              <strong>{t("cameras.privacy.bodyAction")}</strong>
              {t("cameras.privacy.bodyAfter")}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={<MessageSquare size={15} />}
            data-testid="cameras-ask-orion-discovery-btn"
            onClick={onFindOnNetwork}
          >
            {t("cameras.privacy.scan")}
          </Button>
        </div>
      </Card>
    </>
  );
}

export interface NewBarnDialogProps {
  readonly cameraName: string | null;
  readonly onClose: () => void;
  readonly onConfirm: (barnName: string) => Promise<void>;
}

export function NewBarnDialog({ cameraName, onClose, onConfirm }: NewBarnDialogProps) {
  const t = useT();
  const [name, setName] = useState("");

  if (cameraName === null) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setName("");
    await onConfirm(trimmed);
  };

  return (
    <Dialog
      open
      onClose={() => {
        setName("");
        onClose();
      }}
      title={t("cameras.barn.newTitle")}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={() => {
              setName("");
              onClose();
            }}
            data-testid="camera-new-barn-cancel"
          >
            {t("cameras.form.cancel")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="camera-new-barn-form"
            disabled={!name.trim()}
            data-testid="camera-new-barn-submit"
          >
            {t("cameras.barn.newConfirm")}
          </Button>
        </>
      }
    >
      <form id="camera-new-barn-form" onSubmit={handleSubmit}>
        <Input
          label={t("cameras.form.locationLabel")}
          placeholder={t("cameras.barn.newPlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="camera-new-barn-input"
          autoFocus
        />
      </form>
    </Dialog>
  );
}
