import type { EventFrame } from "@orbit/protocol";
import { Globe } from "lucide-react";
import { type JSX, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { useOrionEvent } from "../../lib/orion";
import { computeScaledBrowserHighlight } from "./geometry";

interface ActiveBrowserFrame {
  readonly url: string;
  readonly title: string;
  readonly imageSrc: string;
  readonly width: number;
  readonly height: number;
  readonly highlight: NonNullable<EventFrame<"browser.view">["highlight"]> | null;
}

interface RenderedImageBox {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
}

function toDataImageSrc(image: string): string {
  return image.startsWith("data:") ? image : `data:image/jpeg;base64,${image}`;
}

export function BrowserView(props: { sessionId: string | null }): JSX.Element | null {
  const { sessionId } = props;
  const t = useT();
  const [framesBySession, setFramesBySession] = useState<
    Readonly<Record<string, ActiveBrowserFrame>>
  >({});
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [renderedBox, setRenderedBox] = useState<RenderedImageBox | null>(null);

  useOrionEvent("browser.view", (ev) => {
    setFramesBySession((prev) => {
      if (ev.image === null || ev.image.length === 0) {
        if (!(ev.sessionId in prev)) return prev;
        const next: Record<string, ActiveBrowserFrame> = {};
        for (const [key, val] of Object.entries(prev)) {
          if (key !== ev.sessionId) next[key] = val;
        }
        return next;
      }
      return {
        ...prev,
        [ev.sessionId]: {
          url: ev.url,
          title: ev.title,
          imageSrc: toDataImageSrc(ev.image),
          width: ev.width,
          height: ev.height,
          highlight: ev.highlight,
        },
      };
    });
  });

  const activeFrame = sessionId ? (framesBySession[sessionId] ?? null) : null;

  const measureRenderedImage = useCallback(() => {
    const img = imgRef.current;
    const stage = stageRef.current;
    if (!img || !stage) {
      setRenderedBox(null);
      return;
    }
    const imgRect = img.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    const width = imgRect.width || img.clientWidth;
    const height = imgRect.height || img.clientHeight;
    if (width > 0 && height > 0) {
      setRenderedBox({
        offsetX: imgRect.width > 0 ? imgRect.left - stageRect.left : 0,
        offsetY: imgRect.height > 0 ? imgRect.top - stageRect.top : 0,
        width,
        height,
      });
    } else {
      setRenderedBox(null);
    }
  }, []);

  useLayoutEffect(() => {
    if (!activeFrame) {
      setRenderedBox(null);
      return;
    }
    measureRenderedImage();
  }, [activeFrame, measureRenderedImage]);

  useEffect(() => {
    if (!activeFrame) return;
    const handleResize = () => {
      measureRenderedImage();
    };
    window.addEventListener("resize", handleResize, { passive: true });
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(handleResize);
      if (stageRef.current) observer.observe(stageRef.current);
      if (imgRef.current) observer.observe(imgRef.current);
    }
    return () => {
      window.removeEventListener("resize", handleResize);
      observer?.disconnect();
    };
  }, [activeFrame, measureRenderedImage]);

  if (!activeFrame) return null;

  const displayTitle = activeFrame.title.trim() || t("guide.browser.untitled");
  const scaledHighlight = activeFrame.highlight
    ? computeScaledBrowserHighlight(
        { width: activeFrame.width, height: activeFrame.height },
        activeFrame.highlight,
        renderedBox,
      )
    : null;

  const noteText = activeFrame.highlight?.note
    ? t("guide.browser.noteWithText", { note: activeFrame.highlight.note })
    : t("guide.browser.pointing");

  return (
    <section
      className="orbit-browser-view"
      data-testid="browser-view"
      aria-label={t("guide.browser.region")}
    >
      <header className="orbit-browser-view__header">
        <div className="orbit-browser-view__title-row">
          <Globe size={15} className="orbit-browser-view__icon" aria-hidden="true" />
          <h3 className="orbit-browser-view__title">{displayTitle}</h3>
        </div>
        {activeFrame.url && (
          <p className="orbit-browser-view__url" title={activeFrame.url}>
            {activeFrame.url}
          </p>
        )}
      </header>

      <div ref={stageRef} className="orbit-browser-view__stage">
        <img
          ref={imgRef}
          data-testid="browser-view-frame"
          className="orbit-browser-view__frame"
          src={activeFrame.imageSrc}
          width={activeFrame.width}
          height={activeFrame.height}
          alt={t("guide.browser.frameAlt", { title: displayTitle })}
          onLoad={measureRenderedImage}
        />

        {activeFrame.highlight && scaledHighlight && (
          <div
            data-testid="browser-highlight"
            className="orbit-browser-view__highlight"
            style={scaledHighlight.style}
          >
            {activeFrame.highlight.note && (
              <span
                className="orbit-browser-view__note"
                data-position={scaledHighlight.notePosition}
                data-align={scaledHighlight.noteAlign}
              >
                {noteText}
              </span>
            )}
          </div>
        )}
      </div>

      {activeFrame.highlight?.note && (
        <output className="orbit-visually-hidden" aria-live="polite" aria-atomic="true">
          {noteText}
        </output>
      )}
    </section>
  );
}
