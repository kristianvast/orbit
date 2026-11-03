import type { EventFrame } from "@orbit/protocol";
import { useEffect, useState } from "react";
import { useOrion } from "../../lib/orion";

type PendingMap = Map<string, EventFrame<"approval.request">>;

const globalPendingApprovals: PendingMap = new Map();
const approvalStoreListeners = new Set<() => void>();

function notifyApprovalStore() {
  for (const listener of approvalStoreListeners) {
    listener();
  }
}

export function getPendingApprovalsSnapshot(): EventFrame<"approval.request">[] {
  return [...globalPendingApprovals.values()];
}

export function recordApprovalRequest(ev: EventFrame<"approval.request">) {
  globalPendingApprovals.set(ev.approvalId, ev);
  notifyApprovalStore();
}

export function resolveApprovalRecord(approvalId: string) {
  if (globalPendingApprovals.delete(approvalId)) {
    notifyApprovalStore();
  }
}

export function clearSessionApprovals(sessionId: string) {
  let changed = false;
  for (const [id, req] of globalPendingApprovals.entries()) {
    if (req.sessionId === sessionId) {
      globalPendingApprovals.delete(id);
      changed = true;
    }
  }
  if (changed) notifyApprovalStore();
}

export function resetPendingApprovalsForTests() {
  globalPendingApprovals.clear();
  notifyApprovalStore();
}

export function usePendingApprovals(): {
  pendingApprovals: EventFrame<"approval.request">[];
  pendingCount: number;
} {
  const { client } = useOrion();
  const [pendingApprovals, setPendingApprovals] = useState<EventFrame<"approval.request">[]>(() =>
    getPendingApprovalsSnapshot(),
  );

  useEffect(() => {
    const sync = () => setPendingApprovals(getPendingApprovalsSnapshot());
    approvalStoreListeners.add(sync);
    sync();
    return () => {
      approvalStoreListeners.delete(sync);
    };
  }, []);

  useEffect(() => {
    if (!client) return;
    const offReq = client.on("approval.request", (ev) => {
      recordApprovalRequest(ev);
    });
    const offRes = client.on("approval.resolved", (ev) => {
      resolveApprovalRecord(ev.approvalId);
    });
    const offSettled = client.on("agent.settled", (ev) => {
      if (ev.reason === "aborted") {
        clearSessionApprovals(ev.sessionId);
      }
    });
    return () => {
      offReq();
      offRes();
      offSettled();
    };
  }, [client]);

  return {
    pendingApprovals,
    pendingCount: pendingApprovals.length,
  };
}

export function usePendingApprovalCount(): number {
  return usePendingApprovals().pendingCount;
}
