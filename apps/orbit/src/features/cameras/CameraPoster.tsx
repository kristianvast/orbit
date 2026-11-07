import { useEffect, useRef, useState } from "react";

export interface CameraPosterProps {
  readonly src: string | null | undefined;
  readonly onShownChange?: (shown: boolean) => void;
}

export function CameraPoster({ src, onShownChange }: CameraPosterProps) {
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const shown = Boolean(src) && loadedSrc === src && failedSrc !== src;
  const onShownChangeRef = useRef(onShownChange);
  onShownChangeRef.current = onShownChange;

  useEffect(() => {
    onShownChangeRef.current?.(shown);
  }, [shown]);

  if (!src || failedSrc === src) return null;

  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      decoding="async"
      onLoad={() => setLoadedSrc(src)}
      onError={() => setFailedSrc(src)}
      className="orbit-camera-tile__poster"
      style={{ opacity: shown ? 1 : 0 }}
    />
  );
}
