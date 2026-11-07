import type { CameraMapLayout } from "@orbit/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOrion, useOrionQuery } from "../../../lib/orion";

export const CAMERA_LAYOUT_SAVE_DEBOUNCE_MS = 1000;

export function useCameraLayout() {
  const { client } = useOrion();
  const {
    data,
    loading: isLoading,
    error,
    refetch,
  } = useOrionQuery("cameraLayout.get", {}, { refetchTables: ["camera_layouts"] });

  const [optimisticLayout, setOptimisticLayout] = useState<CameraMapLayout | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingLayoutRef = useRef<CameraMapLayout | null>(null);
  const lastSavedSerializedRef = useRef<string | null>(null);
  const clientRef = useRef(client);
  clientRef.current = client;

  useEffect(() => {
    if (data?.layout && !pendingLayoutRef.current) {
      setOptimisticLayout(data.layout);
      lastSavedSerializedRef.current = JSON.stringify(data.layout);
    }
  }, [data?.layout]);

  const flushSave = useCallback(async (layoutToSave: CameraMapLayout) => {
    const activeClient = clientRef.current;
    if (!activeClient) return;
    setIsSaving(true);
    try {
      await activeClient.mutate("cameraLayout.save", { layout: layoutToSave });
    } catch (err) {
      if (!(err instanceof Error)) throw err;
    } finally {
      setIsSaving(false);
    }
  }, []);

  const saveLayouts = useCallback(
    (nextLayout: CameraMapLayout) => {
      const serialized = JSON.stringify(nextLayout);
      setOptimisticLayout(nextLayout);
      if (serialized === lastSavedSerializedRef.current && !pendingLayoutRef.current) {
        return;
      }
      pendingLayoutRef.current = nextLayout;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        debounceTimerRef.current = null;
        const toPersist = pendingLayoutRef.current;
        pendingLayoutRef.current = null;
        if (!toPersist) return;
        const nextSerialized = JSON.stringify(toPersist);
        if (nextSerialized === lastSavedSerializedRef.current) return;
        lastSavedSerializedRef.current = nextSerialized;
        void flushSave(toPersist);
      }, CAMERA_LAYOUT_SAVE_DEBOUNCE_MS);
    },
    [flushSave],
  );

  useEffect(() => {
    const flushPendingSync = () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      const pending = pendingLayoutRef.current;
      pendingLayoutRef.current = null;
      if (pending && clientRef.current) {
        const nextSerialized = JSON.stringify(pending);
        if (nextSerialized !== lastSavedSerializedRef.current) {
          lastSavedSerializedRef.current = nextSerialized;
          void clientRef.current
            .mutate("cameraLayout.save", { layout: pending })
            .catch(() => undefined);
        }
      }
    };
    window.addEventListener("beforeunload", flushPendingSync);
    return () => {
      window.removeEventListener("beforeunload", flushPendingSync);
      flushPendingSync();
    };
  }, []);

  return {
    layouts: optimisticLayout ?? data?.layout ?? null,
    saveLayouts,
    isLoading,
    isSaving,
    error,
    refetch,
  };
}
