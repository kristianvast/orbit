import type { CameraInput } from "@orbit/protocol";
import type { Camera as CameraRow, CameraStatus } from "@orbit/schema";
import {
  CheckCircle2,
  Edit3,
  Lock,
  MessageSquare,
  Plus,
  Radar,
  RefreshCw,
  ShieldCheck,
  Video,
  WifiOff,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  Select,
  Skeleton,
  useToast,
} from "../../design";
import { useOrion, useOrionQuery } from "../../lib/orion";

function CameraSnapshotPlaceholder({ camera }: { camera: CameraRow }) {
  const isOnline = camera.status === "online";

  return (
    <div
      data-testid={`camera-snapshot-${camera.id}`}
      style={{
        position: "relative",
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
        border: "1px solid var(--border-subtle)",
        backgroundColor: "var(--bg-subtle)",
        aspectRatio: "16 / 9",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 360 202"
        role="img"
        aria-label={`${camera.name} camera snapshot placeholder`}
        style={{ display: "block", inlineSize: "100%", blockSize: "100%" }}
      >
        <rect width="360" height="202" fill="var(--bg-elevated)" />
        <line
          x1="0"
          y1="101"
          x2="360"
          y2="101"
          stroke="var(--border-subtle)"
          strokeWidth="1"
          strokeDasharray="4 6"
        />
        <line
          x1="180"
          y1="0"
          x2="180"
          y2="202"
          stroke="var(--border-subtle)"
          strokeWidth="1"
          strokeDasharray="4 6"
        />
        <circle
          cx="180"
          cy="101"
          r="64"
          fill="none"
          stroke={isOnline ? "var(--orbit-ring-strong)" : "var(--border-strong)"}
          strokeWidth="1.5"
        />
        <circle
          cx="180"
          cy="101"
          r="34"
          fill="var(--orbit-core-bg)"
          stroke={isOnline ? "var(--status-ok)" : "var(--status-warn)"}
          strokeWidth="2"
        />
        <circle
          cx="180"
          cy="101"
          r="6"
          fill={isOnline ? "var(--status-ok)" : "var(--status-warn)"}
        />

        <path
          d="M 24 40 L 24 24 L 40 24"
          fill="none"
          stroke="var(--border-strong)"
          strokeWidth="2"
        />
        <path
          d="M 336 40 L 336 24 L 320 24"
          fill="none"
          stroke="var(--border-strong)"
          strokeWidth="2"
        />
        <path
          d="M 24 162 L 24 178 L 40 178"
          fill="none"
          stroke="var(--border-strong)"
          strokeWidth="2"
        />
        <path
          d="M 336 162 L 336 178 L 320 178"
          fill="none"
          stroke="var(--border-strong)"
          strokeWidth="2"
        />

        <text
          x="180"
          y="184"
          textAnchor="middle"
          fill="var(--text-secondary)"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "10.5px",
            fontWeight: 600,
          }}
        >
          {isOnline ? "LIVE STREAM READY · FARM NETWORK" : "STREAM OFFLINE · CHECK POWER / NETWORK"}
        </text>
      </svg>

      <div
        style={{
          position: "absolute",
          insetBlockStart: "var(--space-2)",
          insetInlineStart: "var(--space-2)",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "var(--space-1) var(--space-2)",
          borderRadius: "var(--radius-sm)",
          backgroundColor: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          fontSize: "var(--text-xs)",
          fontWeight: 700,
        }}
      >
        <Video size={13} style={{ color: isOnline ? "var(--status-ok)" : "var(--status-warn)" }} />
        <span>{camera.location ?? "Barn feed"}</span>
      </div>
    </div>
  );
}

export interface CameraFormDialogProps {
  open: boolean;
  onClose: () => void;
  editingCamera: CameraRow | null;
  onSaved: () => Promise<void>;
}

export function CameraFormDialog({ open, onClose, editingCamera, onSaved }: CameraFormDialogProps) {
  const { client } = useOrion();
  const { pushToast } = useToast();

  const [name, setName] = useState(editingCamera?.name ?? "");
  const [location, setLocation] = useState(editingCamera?.location ?? "");
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
      setError("Please enter a camera name (for example: Calving pen).");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const payload: CameraInput = {
        ...(editingCamera ? { id: editingCamera.id } : {}),
        name: name.trim(),
        location: location.trim() || null,
        rtspUrl: rtspUrl.trim() || null,
        onvifXaddr: onvifXaddr.trim() || null,
        status,
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(password ? { password } : {}),
      };
      await client.mutate("cameras.upsert", { camera: payload });
      setPassword("");
      pushToast({
        title: editingCamera ? "Camera updated" : "Camera saved",
        description: password
          ? `${name.trim()} saved and password stored securely in your OS keychain.`
          : `${name.trim()} saved on this farm PC.`,
        tone: "ok",
      });
      await onSaved();
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
      title={editingCamera ? `Edit ${editingCamera.name}` : "Add barn or stable camera"}
      description="Enter the camera name, barn location, and stream address. Passwords are saved securely in your PC keychain and never shown again."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} data-testid="camera-form-cancel">
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="camera-upsert-form"
            loading={saving}
            data-testid="camera-form-submit"
          >
            {editingCamera ? "Save camera" : "Add camera"}
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
          label="Camera name"
          data-testid="camera-form-name"
          placeholder="e.g. Calving pen, Robot entrance"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          label="Barn location"
          data-testid="camera-form-location"
          placeholder="e.g. Calving pen, Milking parlour, Horse stable"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />

        <div style={{ gridColumn: "1 / -1" }}>
          <Input
            label="Camera stream address"
            data-testid="camera-form-rtsp"
            placeholder="rtsp://192.168.1.35:554/stream1"
            value={rtspUrl}
            onChange={(e) => setRtspUrl(e.target.value)}
          />
        </div>

        <Input
          label="Network discovery address (optional)"
          data-testid="camera-form-onvif"
          placeholder="http://192.168.1.35/onvif/device_service"
          value={onvifXaddr}
          onChange={(e) => setOnvifXaddr(e.target.value)}
        />

        <Select
          label="Status"
          data-testid="camera-form-status"
          value={status}
          onChange={(e) => setStatus(e.target.value as CameraStatus)}
          options={[
            { value: "online", label: "Online" },
            { value: "offline", label: "Offline" },
            { value: "error", label: "Connection error" },
            { value: "unknown", label: "Unknown" },
          ]}
        />

        <Input
          label="Camera username (optional)"
          data-testid="camera-form-username"
          placeholder="e.g. admin"
          autoComplete="off"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />

        <Input
          label={
            editingCamera?.credentialRef
              ? "New password (leave blank to keep stored password)"
              : "Camera password"
          }
          type="password"
          data-testid="camera-form-password"
          placeholder={
            editingCamera?.credentialRef
              ? "Stored in keychain — never shown again"
              : "Sent to Orion keychain only"
          }
          hint="Sent once to Orion's local keychain; never stored in plain text or displayed again."
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

export function CamerasPage() {
  const navigate = useNavigate();
  const [formOpen, setFormOpen] = useState(false);
  const [editingCamera, setEditingCamera] = useState<CameraRow | null>(null);

  const {
    data: camerasData,
    loading: camerasLoading,
    error: camerasError,
    refetch: refetchCameras,
  } = useOrionQuery("cameras.list", {}, { refetchTables: ["cameras"] });

  const cameras = camerasData?.rows ?? [];
  const onlineCount = cameras.filter((c) => c.status === "online").length;

  return (
    <div className="orbit-container" data-testid="cameras-page">
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "var(--space-4)",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
            <h1
              style={{
                margin: 0,
                fontFamily: "var(--font-display)",
                fontSize: "var(--text-h1)",
                fontWeight: 750,
                lineHeight: "var(--leading-tight)",
                letterSpacing: "var(--tracking-display)",
              }}
            >
              Cameras
            </h1>
            <Badge
              variant={onlineCount === cameras.length && cameras.length > 0 ? "ok" : "warn"}
              className="tabular-nums"
            >
              {onlineCount}/{cameras.length} online
            </Badge>
          </div>
          <p
            style={{
              margin: "var(--space-2) 0 0 0",
              color: "var(--text-secondary)",
              fontSize: "var(--text-base)",
              maxInlineSize: "68ch",
            }}
          >
            Barn, parlour, calving pen, and horse stable cameras. Orion can scan your farm network
            with your approval, and camera passwords are stored in your PC keychain (never shown
            again).
          </p>
        </div>

        <div
          style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}
        >
          <Button
            variant="secondary"
            size="md"
            icon={<Radar size={18} />}
            data-testid="cameras-find-network-btn"
            onClick={() =>
              navigate(`/chat?prompt=${encodeURIComponent("Find cameras on my network")}`)
            }
          >
            Find cameras on my network
          </Button>
          <Button
            variant="primary"
            size="md"
            icon={<Plus size={18} />}
            data-testid="cameras-add-btn"
            onClick={() => {
              setEditingCamera(null);
              setFormOpen(true);
            }}
          >
            Add camera
          </Button>
        </div>
      </header>

      <Card
        variant="elevated"
        title="Network Camera Discovery & Password Privacy"
        subtitle="How Orbit protects your barn cameras on the local network"
      >
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
              Clicking <strong>Find cameras on my network</strong> opens a conversation with Orion
              so you can approve scanning your farm network for cameras. When you save a camera
              password, Orion writes it straight into your PC keychain and stores only a reference
              ID.
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={<MessageSquare size={15} />}
            data-testid="cameras-ask-orion-discovery-btn"
            onClick={() =>
              navigate(`/chat?prompt=${encodeURIComponent("Find cameras on my network")}`)
            }
          >
            Scan network with Orion
          </Button>
        </div>
      </Card>

      {camerasError ? (
        <Card title="Could not load cameras" data-testid="cameras-error-state">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "var(--space-4)",
            }}
          >
            <p style={{ margin: 0, color: "var(--status-danger)" }}>{camerasError.message}</p>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw size={15} />}
              onClick={() => void refetchCameras()}
              data-testid="cameras-retry-btn"
            >
              Retry
            </Button>
          </div>
        </Card>
      ) : camerasLoading && !camerasData ? (
        <Card title="Loading barn cameras…" data-testid="cameras-loading-state">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(21rem, 1fr))",
              gap: "var(--space-5)",
            }}
          >
            <Skeleton height="16rem" />
            <Skeleton height="16rem" />
            <Skeleton height="16rem" />
          </div>
        </Card>
      ) : cameras.length === 0 ? (
        <EmptyState
          data-testid="cameras-empty-state"
          title="No cameras added yet"
          description="Let Orion scan your farm network for network cameras or enter a camera stream address manually."
          action={
            <div style={{ display: "flex", gap: "var(--space-3)" }}>
              <Button
                variant="secondary"
                icon={<Radar size={16} />}
                onClick={() =>
                  navigate(`/chat?prompt=${encodeURIComponent("Find cameras on my network")}`)
                }
              >
                Find cameras on my network
              </Button>
              <Button
                variant="primary"
                icon={<Plus size={16} />}
                onClick={() => {
                  setEditingCamera(null);
                  setFormOpen(true);
                }}
              >
                Add camera
              </Button>
            </div>
          }
        />
      ) : (
        <div
          data-testid="cameras-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(22rem, 1fr))",
            gap: "var(--space-5)",
          }}
        >
          {cameras.map((cam) => {
            const statusVariant =
              cam.status === "online" ? "ok" : cam.status === "error" ? "danger" : "warn";

            return (
              <Card
                key={cam.id}
                data-testid={`camera-card-${cam.id}`}
                title={cam.name}
                subtitle={cam.location ?? "Barn camera"}
                actions={
                  <Badge
                    variant={statusVariant}
                    icon={
                      cam.status === "online" ? <CheckCircle2 size={12} /> : <WifiOff size={12} />
                    }
                  >
                    {cam.status}
                  </Badge>
                }
                footer={
                  <>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "var(--space-1)",
                        fontSize: "var(--text-xs)",
                        color: "var(--text-muted)",
                      }}
                    >
                      <Lock size={13} />
                      <span>
                        {cam.credentialRef
                          ? "Password stored in keychain"
                          : "No password configured"}
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                      <Button
                        variant="subtle"
                        size="sm"
                        icon={<MessageSquare size={14} />}
                        data-testid={`camera-ask-orion-${cam.id}`}
                        onClick={() =>
                          navigate(
                            `/chat?prompt=${encodeURIComponent(
                              `Check camera "${cam.name}" in ${cam.location ?? "the barn"}`,
                            )}`,
                          )
                        }
                      >
                        Ask Orion
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Edit3 size={14} />}
                        data-testid={`camera-edit-${cam.id}`}
                        onClick={() => {
                          setEditingCamera(cam);
                          setFormOpen(true);
                        }}
                      >
                        Edit
                      </Button>
                    </div>
                  </>
                }
              >
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
                  <CameraSnapshotPlaceholder camera={cam} />
                  <div
                    className="tabular-nums"
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-xs)",
                      color: "var(--text-secondary)",
                      wordBreak: "break-all",
                    }}
                  >
                    {cam.rtspUrl ?? cam.onvifXaddr ?? "Local LAN stream"}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {formOpen && (
        <CameraFormDialog
          open={formOpen}
          onClose={() => setFormOpen(false)}
          editingCamera={editingCamera}
          onSaved={async () => {
            await refetchCameras();
          }}
        />
      )}
    </div>
  );
}

export default CamerasPage;
