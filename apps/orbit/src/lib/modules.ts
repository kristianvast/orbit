import { MODULE_IDS, type ModuleId, type ModulesState, type OrbitModule } from "@orbit/protocol";
import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useOrion, useOrionQuery } from "./orion";

export { MODULE_IDS, type ModuleId, type ModulesState, type OrbitModule } from "@orbit/protocol";

export interface UseModulesResult {
  modules: OrbitModule[];
  loading: boolean;
  error: Error | null;
  isEnabled: (id: ModuleId) => boolean;
  anyEnabled: boolean;
  enableModule: (id: ModuleId) => Promise<ModulesState | null>;
  disableModule: (id: ModuleId) => Promise<ModulesState | null>;
  refetch: () => Promise<void>;
}

const DEFAULT_MODULES: OrbitModule[] = MODULE_IDS.map((id) => ({
  id,
  enabled: false,
  enabledAt: null,
  enabledBy: null,
}));

const ModulesContext = createContext<UseModulesResult | null>(null);

function useModulesInternal(): UseModulesResult {
  const { client, state } = useOrion();
  const { data: summary } = useOrionQuery("farm.summary");
  const [modules, setModules] = useState<OrbitModule[] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refetch = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const res = await client.request("modules.list", {});
      if (mountedRef.current) {
        if (Array.isArray(res?.modules)) {
          setModules(res.modules);
        } else {
          setModules(null);
        }
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err : new Error(String(err)));
        setModules(null);
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [client]);

  useEffect(() => {
    if (!client) return;
    if (state === "open") {
      void refetch();
    }
  }, [client, state, refetch]);

  useEffect(() => {
    if (!client) return;
    return client.on("modules.updated", (ev) => {
      if (mountedRef.current && Array.isArray(ev?.modules)) {
        setModules(ev.modules);
        setLoading(false);
      }
    });
  }, [client]);

  const resolvedModules = useMemo<OrbitModule[]>(() => {
    if (modules) return modules;
    const cattle = summary?.counts?.cattle ?? 0;
    const horses = summary?.counts?.horses ?? 0;
    const devices = summary?.counts?.devices ?? 0;
    const cameras = summary?.counts?.cameras ?? 0;
    return [
      {
        id: "herd",
        enabled: cattle + horses > 0,
        enabledAt: null,
        enabledBy: cattle + horses > 0 ? "auto" : null,
      },
      {
        id: "devices",
        enabled: devices > 0,
        enabledAt: null,
        enabledBy: devices > 0 ? "auto" : null,
      },
      {
        id: "cameras",
        enabled: cameras > 0,
        enabledAt: null,
        enabledBy: cameras > 0 ? "auto" : null,
      },
    ];
  }, [modules, summary]);

  const enableModule = useCallback(
    async (id: ModuleId): Promise<ModulesState | null> => {
      if (!client) return null;
      const res = await client.request("modules.enable", { moduleId: id });
      if (mountedRef.current) {
        if (Array.isArray(res?.modules)) {
          setModules(res.modules);
        } else {
          setModules((prev) =>
            (prev ?? DEFAULT_MODULES).map((m) =>
              m.id === id
                ? { ...m, enabled: true, enabledAt: new Date().toISOString(), enabledBy: "user" }
                : m,
            ),
          );
        }
        setLoading(false);
      }
      return res;
    },
    [client],
  );

  const disableModule = useCallback(
    async (id: ModuleId): Promise<ModulesState | null> => {
      if (!client) return null;
      const res = await client.request("modules.disable", { moduleId: id });
      if (mountedRef.current) {
        if (Array.isArray(res?.modules)) {
          setModules(res.modules);
        } else {
          setModules((prev) =>
            (prev ?? DEFAULT_MODULES).map((m) =>
              m.id === id ? { ...m, enabled: false, enabledAt: null, enabledBy: null } : m,
            ),
          );
        }
        setLoading(false);
      }
      return res;
    },
    [client],
  );

  const isEnabled = useCallback(
    (id: ModuleId) => !loading && resolvedModules.some((m) => m.id === id && m.enabled),
    [loading, resolvedModules],
  );

  const anyEnabled = useMemo(
    () => !loading && resolvedModules.some((m) => m.enabled),
    [loading, resolvedModules],
  );

  return useMemo(
    () => ({
      modules: resolvedModules,
      loading,
      error,
      isEnabled,
      anyEnabled,
      enableModule,
      disableModule,
      refetch,
    }),
    [resolvedModules, loading, error, isEnabled, anyEnabled, enableModule, disableModule, refetch],
  );
}

export function ModulesProvider({ children }: { children: ReactNode }) {
  const value = useModulesInternal();
  return createElement(ModulesContext.Provider, { value }, children);
}

export function useModules(): UseModulesResult {
  const ctx = useContext(ModulesContext);
  const fallback = useModulesInternal();
  return ctx ?? fallback;
}
