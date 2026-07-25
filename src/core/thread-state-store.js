class ThreadStateStore {
  constructor() {
    this.stateByThreadId = new Map();
    this.latestContextByRuntime = new Map();
  }

  applyRuntimeEvent(event) {
    if (event?.type === "runtime.context.updated") {
      const updatedAt = new Date().toISOString();
      const runtimeId = normalizeRuntimeId(event?.payload?.runtimeId);
      const snapshot = {
        ...event.payload,
        updatedAt,
      };
      if (runtimeId) {
        this.latestContextByRuntime.set(runtimeId, snapshot);
      }
      const threadId = normalizeThreadId(event?.payload?.threadId);
      if (threadId) {
        const current = this.stateByThreadId.get(threadId) || createEmptyThreadState(threadId);
        this.stateByThreadId.set(threadId, {
          ...current,
          context: snapshot,
          updatedAt,
        });
      }
      return;
    }
    if (!event || !event.payload || !event.payload.threadId) {
      return;
    }

    const threadId = event.payload.threadId;
    const current = this.stateByThreadId.get(threadId) || createEmptyThreadState(threadId);
    const next = {
      ...current,
      updatedAt: new Date().toISOString(),
    };

    switch (event.type) {
      case "runtime.turn.started":
        next.status = "running";
        next.turnId = event.payload.turnId || next.turnId;
        next.lastError = "";
        break;
      case "runtime.reply.delta":
        next.status = "running";
        next.turnId = event.payload.turnId || next.turnId;
        next.lastReplyText = event.payload.text || next.lastReplyText;
        break;
      case "runtime.reply.completed":
        next.status = "running";
        next.turnId = event.payload.turnId || next.turnId;
        next.lastReplyText = event.payload.text || next.lastReplyText;
        break;
      case "runtime.approval.requested":
        next.status = "waiting_approval";
        {
          const incomingApproval = normalizeApprovalPayload(event.payload);
          const currentApprovalId = normalizeApprovalRequestId(current.pendingApproval);
          const incomingApprovalId = normalizeApprovalRequestId(incomingApproval);
          const queuedApprovals = normalizeApprovalQueue(current.pendingApprovals);
          if (
            currentApprovalId
            && incomingApprovalId
            && currentApprovalId !== incomingApprovalId
          ) {
            next.pendingApproval = current.pendingApproval;
            next.pendingApprovals = queueApprovalIfMissing(queuedApprovals, incomingApproval);
          } else {
            next.pendingApproval = incomingApproval;
            next.pendingApprovals = queuedApprovals;
          }
        }
        break;
      case "runtime.turn.completed":
        next.status = "idle";
        next.turnId = event.payload.turnId || next.turnId;
        next.pendingApproval = null;
        next.pendingApprovals = [];
        break;
      case "runtime.turn.failed":
        next.status = "failed";
        next.turnId = event.payload.turnId || next.turnId;
        next.lastError = event.payload.text || "❌ Execution failed";
        next.pendingApproval = null;
        next.pendingApprovals = [];
        break;
      default:
        break;
    }

    this.stateByThreadId.set(threadId, next);
  }

  getThreadState(threadId) {
    return this.stateByThreadId.get(threadId) || null;
  }

  markStaleTurnRecovered(threadId, { turnId = "", reason = "" } = {}) {
    const normalizedThreadId = normalizeThreadId(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    const current = this.stateByThreadId.get(normalizedThreadId) || createEmptyThreadState(normalizedThreadId);
    const normalizedTurnId = normalizeThreadId(turnId) || current.turnId || "";
    const next = {
      ...current,
      status: "failed",
      turnId: normalizedTurnId,
      lastError: reason || "stale claudecode running state recovered",
      pendingApproval: null,
      pendingApprovals: [],
      updatedAt: new Date().toISOString(),
    };
    this.stateByThreadId.set(normalizedThreadId, next);
    return next;
  }

  markRuntimeThreadUnhealthy(threadId, { turnId = "", reason = "" } = {}) {
    const normalizedThreadId = normalizeThreadId(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    const current = this.stateByThreadId.get(normalizedThreadId) || createEmptyThreadState(normalizedThreadId);
    const normalizedTurnId = normalizeThreadId(turnId) || current.turnId || "";
    const next = {
      ...current,
      status: "unhealthy",
      turnId: normalizedTurnId,
      lastError: reason || "runtime_prestart_failure",
      pendingApproval: null,
      pendingApprovals: [],
      updatedAt: new Date().toISOString(),
    };
    this.stateByThreadId.set(normalizedThreadId, next);
    return next;
  }

  resolveApproval(threadId, status = "running", requestId = "") {
    const current = this.stateByThreadId.get(threadId);
    if (!current) {
      return null;
    }
    const resolvedRequestId = normalizeApprovalRequestId({ requestId });
    const currentRequestId = normalizeApprovalRequestId(current.pendingApproval);
    const queuedApprovals = normalizeApprovalQueue(current.pendingApprovals);

    if (resolvedRequestId && currentRequestId && resolvedRequestId !== currentRequestId) {
      const nextQueue = queuedApprovals.filter((approval) => normalizeApprovalRequestId(approval) !== resolvedRequestId);
      const next = {
        ...current,
        status: current.pendingApproval ? "waiting_approval" : status,
        pendingApprovals: nextQueue,
        updatedAt: new Date().toISOString(),
      };
      this.stateByThreadId.set(threadId, next);
      return next;
    }

    const nextApproval = queuedApprovals.shift() || null;
    const next = {
      ...current,
      status: nextApproval ? "waiting_approval" : status,
      pendingApproval: nextApproval,
      pendingApprovals: queuedApprovals,
      updatedAt: new Date().toISOString(),
    };
    this.stateByThreadId.set(threadId, next);
    return next;
  }

  snapshot() {
    return Array.from(this.stateByThreadId.values()).map((entry) => ({ ...entry }));
  }

  getLatestContext(runtimeId) {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    if (!normalizedRuntimeId) {
      return null;
    }
    const snapshot = this.latestContextByRuntime.get(normalizedRuntimeId);
    return snapshot ? { ...snapshot } : null;
  }
}

function createEmptyThreadState(threadId) {
  return {
    threadId,
    turnId: "",
    status: "idle",
    lastReplyText: "",
    lastError: "",
    context: null,
    pendingApproval: null,
    pendingApprovals: [],
    updatedAt: new Date().toISOString(),
  };
}

function normalizeApprovalPayload(payload = {}) {
  return {
    kind: payload.kind || "command",
    requestId: payload.requestId ?? null,
    reason: payload.reason || "",
    command: payload.command || "",
    commandTokens: Array.isArray(payload.commandTokens) ? payload.commandTokens : [],
    filePath: payload.filePath || "",
    filePaths: Array.isArray(payload.filePaths) ? payload.filePaths.slice() : [],
    elicitation: payload.elicitation || null,
    responseTemplate: payload.responseTemplate || null,
  };
}

function normalizeApprovalQueue(value) {
  return Array.isArray(value)
    ? value.filter(Boolean).map((approval) => normalizeApprovalPayload(approval))
    : [];
}

function normalizeApprovalRequestId(approval) {
  const requestId = approval?.requestId;
  return requestId == null ? "" : String(requestId).trim();
}

function queueApprovalIfMissing(queue, approval) {
  const requestId = normalizeApprovalRequestId(approval);
  if (!requestId || queue.some((item) => normalizeApprovalRequestId(item) === requestId)) {
    return queue;
  }
  return [...queue, approval];
}

function normalizeRuntimeId(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeThreadId(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { ThreadStateStore };
