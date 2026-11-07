import { Pin, PinOff } from "lucide-react";
import { useCallback, useSyncExternalStore } from "react";
import { useT } from "../../i18n";

const FAVORITE_BARN_PREFIX = "orbit_barn_favorite_";
const listeners = new Set<() => void>();
let storageListenerBound = false;

function notifyFavoriteListeners(): void {
  for (const listener of listeners) listener();
}

function ensureStorageListener(): void {
  if (storageListenerBound || typeof window === "undefined") return;
  storageListenerBound = true;
  window.addEventListener("storage", (e) => {
    if (e.key === null || e.key.startsWith(FAVORITE_BARN_PREFIX)) {
      notifyFavoriteListeners();
    }
  });
}

function subscribeFavorite(onStoreChange: () => void): () => void {
  ensureStorageListener();
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function readFavoriteBarn(farmId: string): string | null {
  if (!farmId) return null;
  try {
    return localStorage.getItem(`${FAVORITE_BARN_PREFIX}${farmId}`);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return null;
  }
}

export function useFavoriteBarn(farmId: string): {
  readonly favoriteBarn: string | null;
  readonly setFavoriteBarn: (barn: string | null) => void;
} {
  const favoriteBarn = useSyncExternalStore(
    subscribeFavorite,
    () => readFavoriteBarn(farmId),
    () => null,
  );

  const setFavoriteBarn = useCallback(
    (barn: string | null) => {
      if (!farmId) return;
      try {
        const key = `${FAVORITE_BARN_PREFIX}${farmId}`;
        if (barn === null) {
          localStorage.removeItem(key);
        } else {
          localStorage.setItem(key, barn);
        }
      } catch (err) {
        if (!(err instanceof Error)) throw err;
      }
      notifyFavoriteListeners();
    },
    [farmId],
  );

  return { favoriteBarn, setFavoriteBarn };
}

export interface BarnSelectorProps {
  readonly barns: readonly string[];
  readonly selectedBarn: string | null;
  readonly onSelect: (barn: string) => void;
  readonly ungroupedLabel: string;
  readonly favoriteBarn?: string | null;
  readonly onToggleFavorite?: (barn: string) => void;
}

export function BarnSelector({
  barns,
  selectedBarn,
  onSelect,
  ungroupedLabel,
  favoriteBarn = null,
  onToggleFavorite,
}: BarnSelectorProps) {
  const t = useT();

  return (
    <nav
      className="orbit-barn-selector"
      data-testid="camera-barn-selector"
      aria-label={t("cameras.barn.selectorAria")}
    >
      {barns.map((barn) => {
        const isActive = barn === (selectedBarn ?? "");
        const label = barn === "" ? ungroupedLabel : barn;
        const isPinned = favoriteBarn === barn;
        const slug = barn || "ungrouped";

        return (
          <div
            key={slug}
            className={
              isActive
                ? "orbit-barn-selector__pill orbit-barn-selector__pill--active"
                : "orbit-barn-selector__pill"
            }
          >
            <button
              type="button"
              onClick={() => onSelect(barn)}
              aria-pressed={isActive}
              data-testid={`camera-barn-option-${slug}`}
              className="orbit-barn-selector__btn"
            >
              {isPinned && <Pin size={13} aria-hidden="true" />}
              <span>{label}</span>
            </button>
            {isActive && onToggleFavorite && (
              <button
                type="button"
                onClick={() => onToggleFavorite(barn)}
                aria-label={isPinned ? t("cameras.barn.unpin") : t("cameras.barn.pin")}
                title={isPinned ? t("cameras.barn.unpin") : t("cameras.barn.pin")}
                data-testid={`camera-barn-pin-${slug}`}
                className="orbit-barn-selector__pin"
              >
                {isPinned ? <PinOff size={13} /> : <Pin size={13} />}
              </button>
            )}
          </div>
        );
      })}
    </nav>
  );
}
