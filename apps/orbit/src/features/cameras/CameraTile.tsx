import type { Camera as CameraRow, CameraStatus } from "@orbit/schema";
import {
  CheckCircle2,
  Edit3,
  Maximize2,
  MessageSquare,
  Minimize2,
  MoreVertical,
  WifiOff,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { Badge } from "../../design";
import { type MessageKey, useT } from "../../i18n";
import { CameraPoster } from "./CameraPoster";
import { CameraSnapshotPlaceholder } from "./CameraSnapshotPlaceholder";
import { CameraTileMenu } from "./CameraTileMenu";
import { useCameraSnapshot } from "./hooks/useCameraSnapshot";
import { useCameraStream } from "./hooks/useCameraStream";
import {
  CAMERA_ID_ATTR,
  captureVideoFrame,
  getCameraPoster,
  rememberCameraPoster,
} from "./lib/camera-poster";

const POSTER_REFRESH_MS = 5000;

export const STATUS_BADGE_KEYS = {
  online: "cameras.card.status.online",
  offline: "cameras.card.status.offline",
  error: "cameras.card.status.error",
  unknown: "cameras.card.status.unknown",
} as const satisfies Record<CameraStatus, MessageKey>;

export interface CameraTileProps {
  readonly camera: CameraRow;
  readonly streamEnabled: boolean;
  readonly currentBarn: string;
  readonly availableBarns: readonly string[];
  readonly onEditCamera: (camera: CameraRow) => void;
  readonly onAskOrion: (camera: CameraRow) => void;
  readonly onMoveToBarn: (camera: CameraRow, barn: string) => void;
  readonly onRequestNewBarn: (camera: CameraRow) => void;
  readonly onStatusChange?: (cameraId: string, isLive: boolean) => void;
}

function CameraTileImpl({
  camera,
  streamEnabled,
  currentBarn,
  availableBarns,
  onEditCamera,
  onAskOrion,
  onMoveToBarn,
  onRequestNewBarn,
  onStatusChange,
}: CameraTileProps) {
  const t = useT();
  const { videoRef, containerRef, isLive, hasError } = useCameraStream(camera.id, {
    enabled: streamEnabled,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [fallbackFullscreen, setFallbackFullscreen] = useState(false);
  const menuContainerRef = useRef<HTMLDivElement>(null);

  const streamReady = streamEnabled && isLive && !hasError;
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  useEffect(() => {
    onStatusChangeRef.current?.(camera.id, streamReady);
  }, [camera.id, streamReady]);

  const snapshotSrc = useCameraSnapshot(camera.id, {
    enabled: streamEnabled && !streamReady && !hasError,
  });
  const posterSrc = streamEnabled ? (getCameraPoster(camera.id) ?? snapshotSrc) : undefined;
  const [posterShown, setPosterShown] = useState(false);

  useEffect(() => {
    if (!streamReady) return;
    const video = videoRef.current;
    if (!video) return;
    const timerId = window.setInterval(
      () => rememberCameraPoster(camera.id, captureVideoFrame(video)),
      POSTER_REFRESH_MS,
    );
    return () => window.clearInterval(timerId);
  }, [streamReady, camera.id, videoRef]);

  useEffect(() => {
    if (!menuOpen && !fallbackFullscreen) return;
    const handlePointerDownOutside = (e: PointerEvent) => {
      if (
        menuOpen &&
        menuContainerRef.current &&
        e.target instanceof Node &&
        !menuContainerRef.current.contains(e.target)
      ) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        setFallbackFullscreen(false);
      }
    };
    window.addEventListener("pointerdown", handlePointerDownOutside);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDownOutside);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen, fallbackFullscreen]);

  const toggleFullscreen = () => {
    const rootEl = containerRef.current?.closest("[data-camera-tile-root]") ?? containerRef.current;
    if (typeof document !== "undefined" && document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => undefined);
      setFallbackFullscreen(false);
      return;
    }
    if (rootEl && typeof rootEl.requestFullscreen === "function") {
      rootEl.requestFullscreen().catch(() => setFallbackFullscreen((prev) => !prev));
    } else {
      setFallbackFullscreen((prev) => !prev);
    }
  };

  const statusVariant =
    camera.status === "online" ? "ok" : camera.status === "error" ? "danger" : "warn";

  return (
    <div
      ref={containerRef}
      className={
        fallbackFullscreen ? "orbit-camera-tile orbit-camera-tile--fullscreen" : "orbit-camera-tile"
      }
      data-fullscreen={fallbackFullscreen ? "true" : undefined}
    >
      <button
        type="button"
        className="orbit-camera-tile__surface"
        aria-label={t("cameras.tile.fullscreenAria", { name: camera.name })}
        data-testid={`camera-fullscreen-trigger-${camera.id}`}
        onClick={(e) => {
          const tileRoot = e.currentTarget.closest("[data-camera-tile-root]") as HTMLElement | null;
          if (tileRoot?.dataset.justDragged === "true") return;
          toggleFullscreen();
        }}
      >
        {!streamReady && !posterShown && <CameraSnapshotPlaceholder camera={camera} />}
        {streamEnabled && !streamReady && !hasError && (
          <CameraPoster src={posterSrc} onShownChange={setPosterShown} />
        )}
        <video
          ref={videoRef}
          {...{ [CAMERA_ID_ATTR]: camera.id }}
          className="orbit-camera-tile__video"
          style={{ opacity: streamReady ? 1 : 0 }}
          autoPlay
          muted
          playsInline
        />
      </button>

      <div className="orbit-camera-tile__top-bar">
        <Badge
          variant={statusVariant}
          icon={camera.status === "online" ? <CheckCircle2 size={12} /> : <WifiOff size={12} />}
        >
          {t(STATUS_BADGE_KEYS[camera.status])}
        </Badge>

        <div ref={menuContainerRef} className="orbit-camera-tile__actions" data-no-drag>
          {fallbackFullscreen && (
            <button
              type="button"
              data-no-drag
              className="orbit-camera-tile__icon-btn"
              onClick={() => setFallbackFullscreen(false)}
              aria-label={t("cameras.tile.exitFullscreen")}
              title={t("cameras.tile.exitFullscreen")}
            >
              <Minimize2 size={15} />
            </button>
          )}
          <button
            type="button"
            data-no-drag
            data-testid={menuOpen ? undefined : `camera-ask-orion-${camera.id}`}
            className="orbit-camera-tile__icon-btn"
            onClick={() => onAskOrion(camera)}
            aria-label={t("cameras.card.askOrion")}
            title={t("cameras.card.askOrion")}
          >
            <MessageSquare size={15} />
          </button>
          <button
            type="button"
            data-no-drag
            data-testid={menuOpen ? undefined : `camera-edit-${camera.id}`}
            className="orbit-camera-tile__icon-btn"
            onClick={() => onEditCamera(camera)}
            aria-label={t("cameras.card.edit")}
            title={t("cameras.card.edit")}
          >
            <Edit3 size={15} />
          </button>
          <button
            type="button"
            data-no-drag
            data-testid={`camera-tile-menu-${camera.id}`}
            className="orbit-camera-tile__icon-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t("cameras.tile.menuAria", { name: camera.name })}
            title={t("cameras.tile.menuAria", { name: camera.name })}
            onClick={() => setMenuOpen((prev) => !prev)}
          >
            <MoreVertical size={15} />
          </button>

          {menuOpen && (
            <CameraTileMenu
              camera={camera}
              currentBarn={currentBarn}
              availableBarns={availableBarns}
              onClose={() => setMenuOpen(false)}
              onEditCamera={onEditCamera}
              onAskOrion={onAskOrion}
              onMoveToBarn={onMoveToBarn}
              onRequestNewBarn={onRequestNewBarn}
            />
          )}
        </div>
      </div>

      <div className="orbit-camera-tile__bottom-bar">
        <div className="orbit-camera-tile__identity">
          <span className="orbit-camera-tile__name">{camera.name}</span>
          <span className="orbit-camera-tile__meta tabular-nums">
            {camera.rtspUrl ?? camera.onvifXaddr ?? t("cameras.card.streamFallback")}
          </span>
        </div>
        <span className="orbit-camera-tile__fullscreen-hint" aria-hidden="true">
          <Maximize2 size={13} />
        </span>
      </div>

      <div
        className="orbit-camera-tile__resize-handle"
        data-resize-handle
        data-testid={`camera-resize-${camera.id}`}
        aria-label={t("cameras.tile.resizeAria", { name: camera.name })}
        role="presentation"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path fill="currentColor" d="M22 22H10v-2h10v-10h2v12zM18 18H6v-2h10V6h2v12z" />
        </svg>
      </div>
    </div>
  );
}

export const CameraTile = memo(CameraTileImpl);
