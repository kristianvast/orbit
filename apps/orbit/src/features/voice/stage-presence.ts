let mountedStageCount = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

export function markStageMounted(): () => void {
  mountedStageCount += 1;
  notify();
  return () => {
    mountedStageCount = Math.max(0, mountedStageCount - 1);
    notify();
  };
}

export function isStageMounted(): boolean {
  return mountedStageCount > 0;
}

export function subscribeStageMounted(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
