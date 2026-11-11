import type { Species } from "@orbit/schema";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { TranslateFn } from "../i18n";
import { useOrion, useOrionQuery } from "./orion";

const STORAGE_KEY = "orbit.species";

export function resolveEffectiveSpecies(
  configured: Species | null,
  cattleCount: number,
  horseCount: number,
): Species {
  if (configured) {
    if (configured === "cattle" && cattleCount === 0 && horseCount > 0) return "horse";
    if (configured === "horse" && horseCount === 0 && cattleCount > 0) return "cattle";
    return configured;
  }
  if (horseCount > 0 && cattleCount === 0) return "horse";
  return "cattle";
}

export function formatPrimaryAnimalCount(
  cattle: number,
  horses: number,
  species: Species,
  t: TranslateFn,
): string {
  if (species === "horse" && horses > 0) {
    return t("home.counts.horses", { count: horses });
  }
  if (cattle > 0) {
    return t("home.counts.cattle", { count: cattle });
  }
  if (horses > 0) {
    return t("home.counts.horses", { count: horses });
  }
  return species === "horse"
    ? t("home.counts.horses", { count: 0 })
    : t("home.counts.cattle", { count: 0 });
}

export interface FarmSpeciesContextValue {
  species: Species;
  configuredSpecies: Species | null;
  setSpecies: (next: Species) => Promise<void>;
}

const FarmSpeciesContext = createContext<FarmSpeciesContextValue>({
  species: "cattle",
  configuredSpecies: null,
  setSpecies: async () => {},
});

function readStoredSpecies(): Species | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    return raw === "cattle" || raw === "horse" ? raw : null;
  } catch {
    return null;
  }
}

export function FarmSpeciesProvider({
  children,
  initialSpecies,
}: {
  children: ReactNode;
  initialSpecies?: Species;
}) {
  const { client, state } = useOrion();
  const { data: summary } = useOrionQuery("farm.summary", undefined, {
    refetchTables: ["farms", "animals"],
  });

  const [configuredSpecies, setConfiguredSpecies] = useState<Species | null>(
    () => initialSpecies ?? readStoredSpecies(),
  );

  useEffect(() => {
    if (initialSpecies) return;
    if (!client || (state !== "open" && state !== "connecting")) return;
    let cancelled = false;
    Promise.resolve(client.request("settings.get"))
      .then((loaded) => {
        if (cancelled) return;
        const next = loaded?.species;
        if (next === "cattle" || next === "horse") {
          setConfiguredSpecies(next);
          try {
            window.localStorage?.setItem(STORAGE_KEY, next);
          } catch {}
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, state, initialSpecies]);

  const setSpecies = useCallback(
    async (next: Species) => {
      setConfiguredSpecies(next);
      try {
        window.localStorage?.setItem(STORAGE_KEY, next);
      } catch {}
      if (client) {
        await Promise.resolve(client.request("settings.update", { species: next }));
      }
    },
    [client],
  );

  const cattle = summary?.counts?.cattle ?? 0;
  const horses = summary?.counts?.horses ?? 0;
  const species = resolveEffectiveSpecies(configuredSpecies, cattle, horses);

  const value = useMemo<FarmSpeciesContextValue>(
    () => ({ species, configuredSpecies, setSpecies }),
    [species, configuredSpecies, setSpecies],
  );

  return <FarmSpeciesContext.Provider value={value}>{children}</FarmSpeciesContext.Provider>;
}

export function useFarmSpecies(): FarmSpeciesContextValue {
  return useContext(FarmSpeciesContext);
}
