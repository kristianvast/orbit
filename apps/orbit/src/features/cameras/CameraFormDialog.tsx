import type { CameraInput } from "@orbit/protocol";
import type { Camera as CameraRow, CameraStatus } from "@orbit/schema";
import { type FormEvent, useState } from "react";
import { Button, Dialog, Input, Select, useToast } from "../../design";
import { useT } from "../../i18n";
import { useOrion } from "../../lib/orion";

export interface CameraFormDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly editingCamera: CameraRow | null;
  readonly defaultLocation?: string;
  readonly onSaved: (savedLocation?: string) => Promise<void>;
}

export function CameraFormDialog({
  open,
  onClose,
  editingCamera,
  defaultLocation = "",
  onSaved,
}: CameraFormDialogProps) {
  const { client } = useOrion();
  const { pushToast } = useToast();
  const t = useT();

  const [name, setName] = useState(editingCamera?.name ?? "");
  const [location, setLocation] = useState(editingCamera?.location ?? defaultLocation);
  const [rtspUrl, setRtspUrl] = useState(editingCamera?.rtspUrl ?? "");
  const [onvifXaddr, setOnvifXaddr] = useState(editingCamera?.onvifXaddr ?? "");
  const [status, setStatus] = useState<CameraStatus>(editingCamera?.status ?? "online");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!client) return;
    if (!name.trim()) {
      setError(t("cameras.form.errorNameRequired"));
      return;
    }

    setSaving(true);
    setError(null);
    const trimmedLocation = location.trim();
    try {
      const payload: CameraInput = {
        ...(editingCamera ? { id: editingCamera.id } : {}),
        name: name.trim(),
        location: trimmedLocation || null,
        rtspUrl: rtspUrl.trim() || null,
        onvifXaddr: onvifXaddr.trim() || null,
        status,
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(password ? { password } : {}),
      };
      await client.mutate("cameras.upsert", { camera: payload });
      setPassword("");
      pushToast({
        title: editingCamera ? t("cameras.form.toastUpdated") : t("cameras.form.toastSaved"),
        description: password
          ? t("cameras.form.toastSavedWithPassword", { name: name.trim() })
          : t("cameras.form.toastSavedLocal", { name: name.trim() }),
        tone: "ok",
      });
      await onSaved(trimmedLocation);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        editingCamera
          ? t("cameras.form.titleEdit", { name: editingCamera.name })
          : t("cameras.form.titleAdd")
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} data-testid="camera-form-cancel">
            {t("cameras.form.cancel")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="camera-upsert-form"
            loading={saving}
            data-testid="camera-form-submit"
          >
            {editingCamera ? t("cameras.form.submitSave") : t("cameras.form.submitAdd")}
          </Button>
        </>
      }
    >
      <form
        id="camera-upsert-form"
        onSubmit={handleSubmit}
        data-testid="camera-form-dialog"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          gap: "var(--space-4)",
        }}
      >
        <Input
          label={t("cameras.form.nameLabel")}
          data-testid="camera-form-name"
          placeholder={t("cameras.form.namePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          label={t("cameras.form.locationLabel")}
          data-testid="camera-form-location"
          placeholder={t("cameras.form.locationPlaceholder")}
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />

        <div style={{ gridColumn: "1 / -1" }}>
          <Input
            label={t("cameras.form.rtspLabel")}
            data-testid="camera-form-rtsp"
            placeholder="rtsp://192.168.1.35:554/stream1"
            value={rtspUrl}
            onChange={(e) => setRtspUrl(e.target.value)}
          />
        </div>

        <Input
          label={t("cameras.form.onvifLabel")}
          data-testid="camera-form-onvif"
          placeholder="http://192.168.1.35/onvif/device_service"
          value={onvifXaddr}
          onChange={(e) => setOnvifXaddr(e.target.value)}
        />

        <Select
          label={t("cameras.form.statusLabel")}
          data-testid="camera-form-status"
          value={status}
          onChange={(e) => setStatus(e.target.value as CameraStatus)}
          options={[
            { value: "online", label: t("cameras.form.statusOnline") },
            { value: "offline", label: t("cameras.form.statusOffline") },
            { value: "error", label: t("cameras.form.statusError") },
            { value: "unknown", label: t("cameras.form.statusUnknown") },
          ]}
        />

        <Input
          label={t("cameras.form.usernameLabel")}
          data-testid="camera-form-username"
          placeholder={t("cameras.form.usernamePlaceholder")}
          autoComplete="off"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />

        <Input
          label={
            editingCamera?.credentialRef
              ? t("cameras.form.passwordLabelNew")
              : t("cameras.form.passwordLabel")
          }
          type="password"
          data-testid="camera-form-password"
          placeholder={
            editingCamera?.credentialRef
              ? t("cameras.form.passwordPlaceholderStored")
              : t("cameras.form.passwordPlaceholder")
          }
          hint={t("cameras.form.passwordHint")}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error && (
          <div style={{ gridColumn: "1 / -1" }}>
            <p className="orbit-field__error" role="alert">
              {error}
            </p>
          </div>
        )}
      </form>
    </Dialog>
  );
}
