const posters = new Map<string, string>();
const MAX_POSTERS = 12;

export const CAMERA_ID_ATTR = "data-camera-id";

export function drawVideoToCanvas(video: HTMLVideoElement): HTMLCanvasElement | null {
  if (video.videoWidth <= 0 || video.videoHeight <= 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return null;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function captureVideoFrame(
  video: HTMLVideoElement,
  mimeType = "image/jpeg",
  quality = 0.72,
): string | null {
  return drawVideoToCanvas(video)?.toDataURL(mimeType, quality) ?? null;
}

export function getCameraPoster(cameraId: string | undefined | null): string | undefined {
  return cameraId ? posters.get(cameraId) : undefined;
}

export function rememberCameraPoster(
  cameraId: string | undefined | null,
  dataUrl: string | null | undefined,
): void {
  if (!cameraId || !dataUrl) return;
  posters.delete(cameraId);
  posters.set(cameraId, dataUrl);
  while (posters.size > MAX_POSTERS) {
    const oldest = posters.keys().next().value;
    if (oldest === undefined) break;
    posters.delete(oldest);
  }
}

export function captureCameraPoster(cameraId: string | undefined | null): string | undefined {
  if (!cameraId || typeof document === "undefined") return undefined;

  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(cameraId)
      : cameraId.replace(/"/g, '\\"');
  const selector = `video[${CAMERA_ID_ATTR}="${escaped}"]`;
  for (const video of document.querySelectorAll<HTMLVideoElement>(selector)) {
    const frame = captureVideoFrame(video);
    if (frame) {
      rememberCameraPoster(cameraId, frame);
      return frame;
    }
  }
  return getCameraPoster(cameraId);
}

export function clearCameraPosters(): void {
  posters.clear();
}
