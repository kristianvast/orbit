import { flushSync } from "react-dom";
import {
  isDangerTarget,
  isElementDisabled,
  isElementVisible,
  isInsideExcludedSurface,
} from "./dom-predicates";
import { captureScreenSnapshot } from "./dom-snapshot";
import { isValidInAppPath, parseAppAction } from "./parse";
import {
  dismissGuideOverlay,
  type GuideHost,
  getActiveGuideHost,
  getLastPointerPoint,
  getStoredRef,
  type StoredRefTarget,
  setLastPointerPoint,
  setLatestRefs,
  updateGuideVisualState,
  withSuppressedDismissClick,
} from "./store";
import type { AppAction, AppActionResult, Point } from "./types";

const NOT_READY_MESSAGE = "Not done: the app is not ready to be shown around." as const;
const GLIDE_DURATION_MS = 200;
const PRESS_DURATION_MS = 110;

let actionQueue: Promise<void> = Promise.resolve();

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function measureElementCenter(el: Element): Point {
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) {
    return {
      x: rect.left + Math.min(rect.width * 0.78, Math.max(14, rect.width - 14)),
      y: rect.top + Math.min(rect.height * 0.76, Math.max(14, rect.height - 8)),
    };
  }
  return { x: 160, y: 120 };
}

function scrollTargetIntoView(el: Element): void {
  if (typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function snapshotAndStoreRefs(host: GuideHost): string {
  const snap = captureScreenSnapshot(document, host.getPath());
  const nextRefs = new Map<number, StoredRefTarget>();
  for (const item of snap.items) {
    nextRefs.set(item.ref, { element: item.element, label: item.label });
  }
  setLatestRefs(nextRefs);
  return snap.formatted;
}

function resolveLiveRef(ref: number): StoredRefTarget | null {
  const entry = getStoredRef(ref);
  if (!entry) return null;
  const { element } = entry;
  if (
    !element.isConnected ||
    isInsideExcludedSurface(element) ||
    isElementDisabled(element) ||
    !isElementVisible(element)
  ) {
    return null;
  }
  return entry;
}

function showHighlightOnElement(
  host: GuideHost,
  target: StoredRefTarget,
  note: string | undefined,
): void {
  scrollTargetIntoView(target.element);
  const point = measureElementCenter(target.element);
  setLastPointerPoint(point);
  updateGuideVisualState({
    mode: "active",
    targetElement: target.element,
    targetLabel: target.label,
    note,
    pointerPhase: "idle",
    pointerFrom: point,
    pointerTo: point,
    routePath: host.getPath(),
  });
}

function performRealClick(element: Element): void {
  withSuppressedDismissClick(() => {
    flushSync(() => {
      if (element instanceof HTMLElement) {
        element.focus({ preventScroll: true });
        element.click();
      } else {
        element.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
        );
      }
    });
  });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled guide action: ${JSON.stringify(value)}`);
}

async function executeAction(rawAction: AppAction): Promise<AppActionResult> {
  const host = getActiveGuideHost();
  if (!host || typeof document === "undefined") {
    return { result: NOT_READY_MESSAGE, isError: true };
  }

  const action = parseAppAction(rawAction);
  if (!action) {
    return { result: "Not done: invalid app action parameters.", isError: true };
  }

  switch (action.action) {
    case "look": {
      dismissGuideOverlay();
      return { result: snapshotAndStoreRefs(host), isError: false };
    }
    case "clear": {
      dismissGuideOverlay();
      const listing = snapshotAndStoreRefs(host);
      return { result: `Done: cleared the screen guide.\n${listing}`, isError: false };
    }
    case "highlight": {
      const target = resolveLiveRef(action.ref);
      if (!target) {
        dismissGuideOverlay();
        return {
          result: `Not done: item [${action.ref}] is no longer on this screen. Use look to list the current screen first.`,
          isError: true,
        };
      }
      showHighlightOnElement(host, target, action.note);
      const listing = snapshotAndStoreRefs(host);
      return { result: `Done: highlighted "${target.label}".\n${listing}`, isError: false };
    }
    case "click": {
      const target = resolveLiveRef(action.ref);
      if (!target) {
        dismissGuideOverlay();
        return {
          result: `Not done: item [${action.ref}] is no longer on this screen. Use look to list the current screen first.`,
          isError: true,
        };
      }
      if (isDangerTarget(target.element)) {
        showHighlightOnElement(host, target, action.note);
        snapshotAndStoreRefs(host);
        return {
          result: `Not done: "${target.label}" requires confirmation from the farmer. It is highlighted on screen; ask the farmer to press it.`,
          isError: true,
        };
      }

      scrollTargetIntoView(target.element);
      const destination = measureElementCenter(target.element);
      const origin: Point = getLastPointerPoint() ?? {
        x: Math.max(24, destination.x - 72),
        y: Math.max(24, destination.y + 52),
      };
      const reduced = prefersReducedMotion();
      const beforePath = host.getPath();

      if (!reduced) {
        updateGuideVisualState({
          mode: "active",
          targetElement: target.element,
          targetLabel: target.label,
          note: action.note,
          pointerPhase: "moving",
          pointerFrom: origin,
          pointerTo: destination,
          routePath: beforePath,
        });
        await waitMs(GLIDE_DURATION_MS);
      }

      updateGuideVisualState({
        mode: "active",
        targetElement: target.element,
        targetLabel: target.label,
        note: action.note,
        pointerPhase: "pressing",
        pointerFrom: destination,
        pointerTo: destination,
        routePath: beforePath,
      });

      if (!reduced) {
        await waitMs(PRESS_DURATION_MS);
      }

      setLastPointerPoint(destination);
      performRealClick(target.element);
      await waitMs(0);
      await waitMs(0);

      const afterPath = host.getPath();
      dismissGuideOverlay();
      const listing = snapshotAndStoreRefs(host);
      const outcome =
        afterPath !== beforePath
          ? `clicked "${target.label}" and navigated to ${afterPath}`
          : `clicked "${target.label}" on ${afterPath}`;
      return { result: `Done: ${outcome}.\n${listing}`, isError: false };
    }
    case "go": {
      if (!isValidInAppPath(action.path)) {
        return {
          result: `Not done: "${action.path}" is not an in-app path. Pass a route starting with "/".`,
          isError: true,
        };
      }
      dismissGuideOverlay();
      flushSync(() => {
        host.navigate(action.path);
      });
      await waitMs(0);
      await waitMs(0);
      const afterPath = host.getPath();
      if (action.note) {
        const headingEl =
          document.querySelector("main h1") ?? document.querySelector("main") ?? document.body;
        if (headingEl) {
          showHighlightOnElement(host, { element: headingEl, label: afterPath }, action.note);
        }
      }
      const listing = snapshotAndStoreRefs(host);
      return { result: `Done: navigated to ${afterPath}.\n${listing}`, isError: false };
    }
    default:
      return assertNever(action);
  }
}

export function runAppAction(action: AppAction): Promise<AppActionResult> {
  const scheduled = actionQueue.then(async () => {
    try {
      return await executeAction(action);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unexpected error";
      return { result: `Not done: ${reason}`, isError: true };
    }
  });
  actionQueue = scheduled.then(
    () => undefined,
    () => undefined,
  );
  return scheduled;
}
