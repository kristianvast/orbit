import { X } from "lucide-react";
import {
  type CSSProperties,
  type JSX,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useLocation, useNavigate } from "react-router";
import { BrandMark } from "../../design";
import { useT } from "../../i18n";
import { computeOverlayPlacement } from "./geometry";
import {
  dismissGuideOverlay,
  getGuideVisualState,
  isSuppressingDismissClick,
  registerGuideHost,
  subscribeGuideState,
} from "./store";
import type { BoxRect } from "./types";

const FALLBACK_TARGET_BOX: BoxRect = { left: 120, top: 96, width: 160, height: 44 };
const DEFAULT_NOTE_SIZE = { width: 240, height: 52 } as const;

function readTargetBox(element: Element | null): BoxRect {
  if (!element?.isConnected) return FALLBACK_TARGET_BOX;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0
    ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    : FALLBACK_TARGET_BOX;
}

function readViewport(): { readonly width: number; readonly height: number } {
  return typeof window === "undefined"
    ? { width: 1280, height: 800 }
    : { width: window.innerWidth || 1280, height: window.innerHeight || 800 };
}

export function GuideOverlay(): JSX.Element | null {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const currentPath = `${location.pathname}${location.search}`;

  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const pathRef = useRef(currentPath);
  pathRef.current = currentPath;

  const state = useSyncExternalStore(subscribeGuideState, getGuideVisualState, getGuideVisualState);

  const noteRef = useRef<HTMLDivElement | null>(null);
  const [targetBox, setTargetBox] = useState<BoxRect>(FALLBACK_TARGET_BOX);
  const [noteSize, setNoteSize] = useState<{ readonly width: number; readonly height: number }>(
    DEFAULT_NOTE_SIZE,
  );
  const [viewport, setViewport] = useState(readViewport);

  useEffect(() => {
    return registerGuideHost({
      navigate: (path) => {
        navigateRef.current(path);
      },
      getPath: () => pathRef.current,
    });
  }, []);

  useEffect(() => {
    if (state.mode === "active" && currentPath !== state.routePath) {
      dismissGuideOverlay();
    }
  }, [currentPath, state.mode, state.routePath]);

  const syncGeometry = useCallback(() => {
    if (state.mode !== "active") return;
    if (state.targetElement && !state.targetElement.isConnected) {
      dismissGuideOverlay();
      return;
    }
    setTargetBox(readTargetBox(state.targetElement));
    setViewport(readViewport());
    const noteRect = noteRef.current?.getBoundingClientRect();
    if (noteRect && noteRect.width > 0 && noteRect.height > 0) {
      setNoteSize({ width: noteRect.width, height: noteRect.height });
    }
  }, [state.mode, state.targetElement]);

  useLayoutEffect(() => {
    if (state.mode !== "active" || state.sequence < 0) return;
    syncGeometry();
  }, [state.mode, state.sequence, syncGeometry]);

  useEffect(() => {
    if (state.mode !== "active") return;
    const handleScrollOrResize = () => {
      syncGeometry();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismissGuideOverlay();
      }
    };
    const handleDocumentClick = () => {
      if (isSuppressingDismissClick()) return;
      dismissGuideOverlay();
    };

    window.addEventListener("resize", handleScrollOrResize, { passive: true });
    document.addEventListener("scroll", handleScrollOrResize, { capture: true, passive: true });
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("click", handleDocumentClick, true);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && state.targetElement) {
      observer = new ResizeObserver(handleScrollOrResize);
      observer.observe(state.targetElement);
    }

    return () => {
      window.removeEventListener("resize", handleScrollOrResize);
      document.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("click", handleDocumentClick, true);
      observer?.disconnect();
    };
  }, [state.mode, state.targetElement, syncGeometry]);

  if (state.mode !== "active") return null;

  const placement = computeOverlayPlacement(targetBox, noteSize, viewport);

  const activePointer =
    state.pointerPhase !== "idle" && state.pointerTo
      ? { x: state.pointerTo.x - 6, y: state.pointerTo.y - 4 }
      : placement.pointer;

  const glideDx =
    state.pointerPhase === "moving" && state.pointerFrom && state.pointerTo
      ? state.pointerFrom.x - state.pointerTo.x
      : 0;
  const glideDy =
    state.pointerPhase === "moving" && state.pointerFrom && state.pointerTo
      ? state.pointerFrom.y - state.pointerTo.y
      : 0;

  const pointerStyle: CSSProperties & { "--guide-dx"?: string; "--guide-dy"?: string } = {
    transform: `translate3d(${Math.round(activePointer.x)}px, ${Math.round(activePointer.y)}px, 0)`,
    "--guide-dx": `${Math.round(glideDx)}px`,
    "--guide-dy": `${Math.round(glideDy)}px`,
  };

  const noteMessage = state.note
    ? t("guide.note.withText", { note: state.note })
    : state.targetLabel
      ? t("guide.note.pointing", { label: state.targetLabel })
      : t("guide.note.pointingFallback");

  const announcement = state.note
    ? state.targetLabel
      ? t("guide.announcement.withText", { label: state.targetLabel, note: state.note })
      : t("guide.announcement.noteOnly", { note: state.note })
    : state.targetLabel
      ? t("guide.announcement.pointing", { label: state.targetLabel })
      : t("guide.note.pointingFallback");

  return (
    <section
      className="orbit-guide-layer"
      data-guide-overlay="true"
      aria-label={t("guide.overlay.region")}
    >
      <output className="orbit-visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </output>

      <div
        data-testid="guide-highlight"
        className="orbit-guide-highlight"
        style={{
          transform: `translate3d(${Math.round(placement.ring.left)}px, ${Math.round(placement.ring.top)}px, 0)`,
          inlineSize: `${Math.round(placement.ring.width)}px`,
          blockSize: `${Math.round(placement.ring.height)}px`,
        }}
      />

      <div
        key={state.sequence}
        data-testid="guide-pointer"
        data-phase={state.pointerPhase}
        className="orbit-guide-pointer"
        style={pointerStyle}
        aria-hidden="true"
      >
        <span className="orbit-guide-pointer__badge">
          <BrandMark size={18} />
        </span>
      </div>

      <div
        ref={noteRef}
        data-testid="guide-note"
        className="orbit-guide-note"
        style={{
          transform: `translate3d(${Math.round(placement.note.left)}px, ${Math.round(placement.note.top)}px, 0)`,
          maxInlineSize: `${Math.round(placement.note.maxWidth)}px`,
        }}
      >
        <span className="orbit-guide-note__mark" aria-hidden="true">
          <BrandMark size={16} />
        </span>
        <p className="orbit-guide-note__text">{noteMessage}</p>
        <button
          type="button"
          className="orbit-guide-note__close"
          onClick={() => dismissGuideOverlay()}
          aria-label={t("guide.note.close")}
          title={t("guide.note.close")}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
