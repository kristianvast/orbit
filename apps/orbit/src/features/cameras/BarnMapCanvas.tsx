import type { CameraMapLayout, CameraRelayStatus } from "@orbit/protocol";
import type { Camera as CameraRow } from "@orbit/schema";
import { LayoutGrid, RotateCcw, WifiOff } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Badge, Button } from "../../design";
import { useT } from "../../i18n";
import { BarnSelector } from "./BarnSelector";
import { CameraTile } from "./CameraTile";
import { useBarnMapTileGestures } from "./hooks/useBarnMapTileGestures";
import { useBarnMapViewport } from "./hooks/useBarnMapViewport";
import { DEFAULT_CAMERA_AR, GRID_SIZE, reconcileLayouts } from "./lib/default-layout";

export interface BarnMapCanvasProps {
  readonly farmId: string;
  readonly cameras: readonly CameraRow[];
  readonly storedLayouts: CameraMapLayout | null;
  readonly saveLayouts: (layout: CameraMapLayout) => void;
  readonly relayStatus: CameraRelayStatus | null;
  readonly barns: readonly string[];
  readonly selectedBarn: string | null;
  readonly onSelectBarn: (barn: string) => void;
  readonly allBarns: readonly string[];
  readonly favoriteBarn: string | null;
  readonly onToggleFavorite: (barn: string) => void;
  readonly onEditCamera: (camera: CameraRow) => void;
  readonly onAskOrion: (camera: CameraRow) => void;
  readonly onMoveToBarn: (camera: CameraRow, barn: string) => void;
  readonly onRequestNewBarn: (camera: CameraRow) => void;
}

export function BarnMapCanvas({
  farmId,
  cameras,
  storedLayouts,
  saveLayouts,
  relayStatus,
  barns,
  selectedBarn,
  onSelectBarn,
  allBarns,
  favoriteBarn,
  onToggleFavorite,
  onEditCamera,
  onAskOrion,
  onMoveToBarn,
  onRequestNewBarn,
}: BarnMapCanvasProps) {
  const t = useT();
  const layout = useMemo(() => reconcileLayouts(cameras, storedLayouts), [cameras, storedLayouts]);
  const { containerRef, stateRef, resetViewport } = useBarnMapViewport(farmId);

  const [liveById, setLiveById] = useState<Record<string, boolean>>({});
  const handleStatusChange = useCallback((cameraId: string, isLive: boolean) => {
    setLiveById((prev) => (prev[cameraId] === isLive ? prev : { ...prev, [cameraId]: isLive }));
  }, []);

  const streamEnabled = relayStatus ? relayStatus.available : true;
  const liveCount = cameras.filter((c) => liveById[c.id]).length;

  const {
    vGuideRef,
    hGuideRef,
    gridRef,
    handlePointerDown,
    handlePointerMove,
    finishGesture,
    handleTidyUp,
  } = useBarnMapTileGestures({
    cameras,
    layout,
    storedLayouts,
    saveLayouts,
    stateRef,
  });

  return (
    <section className="orbit-barn-map" data-testid="camera-barn-map">
      <div className="orbit-barn-map__toolbar">
        <div className="orbit-barn-map__toolbar-start">
          <Badge variant={liveCount > 0 ? "ok" : "warn"} className="tabular-nums">
            {t("cameras.map.liveCount", { live: liveCount, total: cameras.length })}
          </Badge>
          {relayStatus && !relayStatus.available && (
            <span
              className="orbit-barn-map__relay-notice"
              data-testid="cameras-relay-notice"
              title={relayStatus.reason ?? undefined}
            >
              <WifiOff size={14} aria-hidden="true" />
              <span>{t("cameras.relay.unavailableDefault")}</span>
            </span>
          )}
          {barns.length > 1 && (
            <BarnSelector
              barns={barns}
              selectedBarn={selectedBarn}
              onSelect={onSelectBarn}
              ungroupedLabel={t("cameras.barn.ungrouped")}
              favoriteBarn={favoriteBarn}
              onToggleFavorite={onToggleFavorite}
            />
          )}
        </div>

        <div className="orbit-barn-map__toolbar-actions">
          <Button
            variant="secondary"
            size="sm"
            icon={<RotateCcw size={15} />}
            onClick={resetViewport}
            data-testid="cameras-reset-view-btn"
          >
            {t("cameras.map.resetView")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<LayoutGrid size={15} />}
            onClick={handleTidyUp}
            data-testid="cameras-tidy-btn"
          >
            {t("cameras.map.tidyUp")}
          </Button>
        </div>
      </div>

      <div className="orbit-barn-map__viewport" data-barn-canvas-bg="true">
        <div ref={containerRef} className="orbit-barn-map__world" data-barn-canvas-bg="true">
          <div
            ref={gridRef}
            className="orbit-barn-map__grid"
            data-barn-canvas-bg="true"
            style={{ backgroundSize: `${GRID_SIZE}px ${GRID_SIZE}px` }}
          />
          <div ref={vGuideRef} className="orbit-barn-map__guide-v" />
          <div ref={hGuideRef} className="orbit-barn-map__guide-h" />

          {layout.tiles.map((tile) => {
            const cam = cameras.find((c) => c.id === tile.i);
            if (!cam) return null;
            const ar = tile.ar || DEFAULT_CAMERA_AR;

            return (
              <div
                key={tile.i}
                id={`tile-${tile.i}`}
                data-testid={`camera-tile-${tile.i}`}
                data-camera-tile-root="true"
                className="orbit-barn-map__tile-slot"
                style={{
                  left: `${tile.x}px`,
                  top: `${tile.y}px`,
                  width: `${tile.w}px`,
                  height: `${tile.w / ar}px`,
                }}
                onPointerDown={(e) => handlePointerDown(e, tile)}
                onPointerMove={handlePointerMove}
                onPointerUp={finishGesture}
                onPointerCancel={finishGesture}
              >
                <CameraTile
                  camera={cam}
                  streamEnabled={streamEnabled}
                  currentBarn={(cam.location ?? "").trim()}
                  availableBarns={allBarns}
                  onEditCamera={onEditCamera}
                  onAskOrion={onAskOrion}
                  onMoveToBarn={onMoveToBarn}
                  onRequestNewBarn={onRequestNewBarn}
                  onStatusChange={handleStatusChange}
                />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
