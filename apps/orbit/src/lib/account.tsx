import type { AccountStatus, FarmRole } from "@orbit/protocol";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { forgetChat } from "../features/chat/last-chat";
import { useOrion, useOrionEvent } from "./orion";

export interface FarmPickerEntry {
  readonly id: string;
  readonly name: string | null;
  readonly kind: "cloud" | "local";
  readonly role: FarmRole | null;
  readonly isOpen: boolean;
}

export function isValidAccountStatus(value: unknown): value is AccountStatus {
  if (typeof value !== "object" || value === null || !("state" in value)) return false;
  const s = (value as { state?: unknown }).state;
  return s === "unavailable" || s === "signed_out" || s === "signed_in";
}

export function buildFarmPickerEntries(status: AccountStatus | null): readonly FarmPickerEntry[] {
  if (status?.state !== "signed_in") return [];
  const entries: FarmPickerEntry[] = [];
  const cloudFarms = status.farms ?? [];
  const seen = new Set<string>();

  if (status.farm && !cloudFarms.some((f) => f.id === status.farm?.id)) {
    seen.add(status.farm.id);
    entries.push({
      id: status.farm.id,
      name: status.farm.name,
      kind: "cloud",
      role: status.farm.role,
      isOpen: true,
    });
  }

  for (const f of cloudFarms) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    entries.push({
      id: f.id,
      name: f.name,
      kind: "cloud",
      role: f.role,
      isOpen: status.farm?.id === f.id,
    });
  }

  if (status.localFarm) {
    entries.push({
      id: "local",
      name: status.localFarm.name,
      kind: "local",
      role: null,
      isOpen: status.farm === null,
    });
  }

  return entries;
}

export interface AccountContextValue {
  readonly status: AccountStatus | null;
  readonly setStatus: (next: AccountStatus | null) => void;
  readonly refreshStatus: () => Promise<AccountStatus | null>;
  readonly ensureLoaded: () => void;
  readonly openingFarmName: string | null;
  readonly openFarm: (farmId: string, label: string) => Promise<{ restarting: boolean }>;
}

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({ children }: { readonly children: ReactNode }) {
  const { client, state } = useOrion();
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [openingFarmName, setOpeningFarmName] = useState<string | null>(null);
  const sawDisconnectRef = useRef(false);

  const ensureLoaded = useCallback(() => {
    setSubscribed(true);
  }, []);

  const refreshStatus = useCallback(async (): Promise<AccountStatus | null> => {
    if (!client) return null;
    try {
      const pending = client.request("account.status", {});
      const next = pending instanceof Promise ? await pending : pending;
      if (isValidAccountStatus(next)) {
        setStatus(next);
        return next;
      }
      setStatus(null);
      return null;
    } catch {
      setStatus(null);
      return null;
    }
  }, [client]);

  useEffect(() => {
    if (state !== "open") {
      sawDisconnectRef.current = true;
      return;
    }
    if (!client || !subscribed) return;
    let live = true;
    try {
      const pending = client.request("account.status", {});
      if (pending instanceof Promise) {
        pending.then(
          (next) => {
            if (!live) return;
            setStatus(isValidAccountStatus(next) ? next : null);
            if (sawDisconnectRef.current) {
              sawDisconnectRef.current = false;
              setOpeningFarmName(null);
            }
          },
          () => {
            if (live) setStatus(null);
          },
        );
      } else {
        setStatus(isValidAccountStatus(pending) ? pending : null);
      }
    } catch {
      setStatus(null);
    }
    return () => {
      live = false;
    };
  }, [client, state, subscribed]);

  useOrionEvent("account.updated", (event) => {
    const { type: _type, ...next } = event;
    setStatus(next);
    setOpeningFarmName(null);
    sawDisconnectRef.current = false;
  });

  useOrionEvent("sessions.reset", () => {
    forgetChat();
  });

  const openFarm = useCallback(
    async (farmId: string, label: string): Promise<{ restarting: boolean }> => {
      if (!client) return { restarting: false };
      const res = await client.request("farms.open", { farmId });
      if (res.restarting) {
        sawDisconnectRef.current = false;
        setOpeningFarmName(label);
      } else {
        setOpeningFarmName(null);
        await refreshStatus();
      }
      return res;
    },
    [client, refreshStatus],
  );

  const value = useMemo<AccountContextValue>(
    () => ({ status, setStatus, refreshStatus, ensureLoaded, openingFarmName, openFarm }),
    [status, refreshStatus, ensureLoaded, openingFarmName, openFarm],
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

const FALLBACK_ACCOUNT: AccountContextValue = {
  status: null,
  setStatus: () => {},
  refreshStatus: async () => null,
  ensureLoaded: () => {},
  openingFarmName: null,
  openFarm: async () => ({ restarting: false }),
};

export function useAccount(): AccountContextValue {
  const ctx = useContext(AccountContext);
  const ensureLoaded = ctx?.ensureLoaded;
  useEffect(() => {
    ensureLoaded?.();
  }, [ensureLoaded]);
  return ctx ?? FALLBACK_ACCOUNT;
}
