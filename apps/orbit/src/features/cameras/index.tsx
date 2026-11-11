import type { Camera as CameraRow } from "@orbit/schema";
import { Plus, Radar, RefreshCw } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Button, Card, EmptyState, Skeleton, useToast } from "../../design";
import { useT } from "../../i18n";
import { useOrion, useOrionQuery } from "../../lib/orion";
import { BarnMapCanvas } from "./BarnMapCanvas";
import { useFavoriteBarn } from "./BarnSelector";
import { CameraFormDialog, type CameraFormDialogProps } from "./CameraFormDialog";
import { CameraSnapshotPlaceholder } from "./CameraSnapshotPlaceholder";
import { CamerasPageHeader, NewBarnDialog } from "./CamerasPageHeader";
import "./cameras.css";
import { useCameraLayout } from "./hooks/useCameraLayout";

export { CameraFormDialog, type CameraFormDialogProps, CameraSnapshotPlaceholder };

function getBarnKey(camera: CameraRow): string {
  return (camera.location ?? "").trim();
}

export function CamerasPage() {
  const navigate = useNavigate();
  const t = useT();
  const { client } = useOrion();
  const { pushToast } = useToast();

  const findCamerasOnNetwork = () =>
    navigate(`/chat?prompt=${encodeURIComponent(t("cameras.prompt.findCameras"))}`);

  const [formOpen, setFormOpen] = useState(false);
  const [editingCamera, setEditingCamera] = useState<CameraRow | null>(null);
  const [selectedBarn, setSelectedBarn] = useState<string | null>(null);
  const [newBarnTarget, setNewBarnTarget] = useState<CameraRow | null>(null);

  const {
    data: camerasData,
    loading: camerasLoading,
    error: camerasError,
    refetch: refetchCameras,
  } = useOrionQuery("cameras.list", {}, { refetchTables: ["cameras"] });

  const { data: relayData } = useOrionQuery("cameras.relay", {});
  const { layouts: storedLayouts, saveLayouts } = useCameraLayout();

  const cameras = camerasData?.rows ?? [];
  const onlineCount = cameras.filter((c) => c.status === "online").length;
  const farmId = cameras[0]?.farmId ?? client?.server?.farmId ?? "default";
  const { favoriteBarn, setFavoriteBarn } = useFavoriteBarn(farmId);

  const uniqueBarns = useMemo(() => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const cam of cameras) {
      const key = getBarnKey(cam);
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
    return order;
  }, [cameras]);

  const orderedBarns = useMemo(() => {
    if (favoriteBarn === null || !uniqueBarns.includes(favoriteBarn)) return uniqueBarns;
    return [favoriteBarn, ...uniqueBarns.filter((b) => b !== favoriteBarn)];
  }, [uniqueBarns, favoriteBarn]);

  const allBarns = useMemo(
    () => (orderedBarns.includes("") ? orderedBarns : [...orderedBarns, ""]),
    [orderedBarns],
  );

  const hasMultipleBarns = uniqueBarns.length > 1;
  const activeBarn = !hasMultipleBarns
    ? null
    : selectedBarn !== null && uniqueBarns.includes(selectedBarn)
      ? selectedBarn
      : (orderedBarns[0] ?? null);

  const visibleCameras = useMemo(() => {
    if (!hasMultipleBarns || activeBarn === null) return cameras;
    return cameras.filter((c) => getBarnKey(c) === activeBarn);
  }, [cameras, hasMultipleBarns, activeBarn]);

  const handleEditCamera = useCallback((cam: CameraRow) => {
    setEditingCamera(cam);
    setFormOpen(true);
  }, []);

  const handleAskOrion = useCallback(
    (cam: CameraRow) => {
      navigate(
        `/chat?prompt=${encodeURIComponent(
          t("cameras.prompt.checkCamera", {
            name: cam.name,
            location: cam.location ?? t("cameras.prompt.locationFallback"),
          }),
        )}`,
      );
    },
    [navigate, t],
  );

  const handleMoveToBarn = useCallback(
    async (cam: CameraRow, barn: string) => {
      if (!client) return;
      const trimmed = barn.trim();
      try {
        await client.mutate("cameras.upsert", {
          camera: {
            id: cam.id,
            name: cam.name,
            location: trimmed.length > 0 ? trimmed : null,
            rtspUrl: cam.rtspUrl,
            onvifXaddr: cam.onvifXaddr,
            status: cam.status,
          },
        });
        pushToast({
          title: trimmed
            ? t("cameras.barn.toastMoved", { name: cam.name, barn: trimmed })
            : t("cameras.barn.toastMovedUngrouped", { name: cam.name }),
          tone: "ok",
        });
        await refetchCameras();
        if (trimmed !== (activeBarn ?? "")) {
          setSelectedBarn(trimmed);
        }
      } catch (err) {
        pushToast({
          title: t("cameras.error.title"),
          description: err instanceof Error ? err.message : String(err),
          tone: "danger",
        });
      }
    },
    [client, pushToast, refetchCameras, activeBarn, t],
  );

  return (
    <div className="orbit-container" data-testid="cameras-page">
      <CamerasPageHeader
        onlineCount={onlineCount}
        totalCount={cameras.length}
        onFindOnNetwork={findCamerasOnNetwork}
        onAddCamera={() => {
          setEditingCamera(null);
          setFormOpen(true);
        }}
      />

      {camerasError ? (
        <Card title={t("cameras.error.title")} data-testid="cameras-error-state">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
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
              {t("cameras.error.retry")}
            </Button>
          </div>
        </Card>
      ) : camerasLoading && !camerasData ? (
        <Card title={t("cameras.loading.title")} data-testid="cameras-loading-state">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(min(21rem, 100%), 1fr))",
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
          title={t("cameras.empty.title")}
          description={t("cameras.empty.description")}
          action={
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)" }}>
              <Button variant="secondary" icon={<Radar size={16} />} onClick={findCamerasOnNetwork}>
                {t("cameras.page.findOnNetwork")}
              </Button>
              <Button
                variant="primary"
                icon={<Plus size={16} />}
                onClick={() => {
                  setEditingCamera(null);
                  setFormOpen(true);
                }}
              >
                {t("cameras.page.addCamera")}
              </Button>
            </div>
          }
        />
      ) : (
        <BarnMapCanvas
          farmId={farmId}
          cameras={visibleCameras}
          storedLayouts={storedLayouts}
          saveLayouts={saveLayouts}
          relayStatus={relayData ?? null}
          barns={orderedBarns}
          selectedBarn={activeBarn}
          onSelectBarn={setSelectedBarn}
          allBarns={allBarns}
          favoriteBarn={favoriteBarn}
          onToggleFavorite={(barn) => setFavoriteBarn(favoriteBarn === barn ? null : barn)}
          onEditCamera={handleEditCamera}
          onAskOrion={handleAskOrion}
          onMoveToBarn={(cam, barn) => void handleMoveToBarn(cam, barn)}
          onRequestNewBarn={(cam) => setNewBarnTarget(cam)}
        />
      )}

      {formOpen && (
        <CameraFormDialog
          key={editingCamera?.id ?? "new"}
          open={formOpen}
          onClose={() => setFormOpen(false)}
          editingCamera={editingCamera}
          defaultLocation={activeBarn ?? ""}
          onSaved={async (savedLocation) => {
            await refetchCameras();
            if (savedLocation !== undefined && savedLocation !== (activeBarn ?? "")) {
              setSelectedBarn(savedLocation);
            }
          }}
        />
      )}

      <NewBarnDialog
        cameraName={newBarnTarget?.name ?? null}
        onClose={() => setNewBarnTarget(null)}
        onConfirm={async (barnName) => {
          const target = newBarnTarget;
          setNewBarnTarget(null);
          if (target) await handleMoveToBarn(target, barnName);
        }}
      />
    </div>
  );
}

export default CamerasPage;
