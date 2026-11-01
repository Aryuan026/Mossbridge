const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_POST_REFRESH_GRACE_TURNS = 4;
const DEFAULT_POST_REFRESH_GRACE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

class SessionRefreshRequestStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath || "";
    this.state = createEmptyState();
    if (this.filePath) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    }
    this.load();
    this.reconcileStartup();
  }

  load() {
    if (!this.filePath) {
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.state = {
        ...createEmptyState(),
        ...(parsed && typeof parsed === "object" ? parsed : {}),
        requests: Array.isArray(parsed?.requests) ? parsed.requests : [],
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.state = createEmptyState();
        return;
      }
      const wrapped = new Error(`invalid session refresh state: ${error.message}`);
      wrapped.code = "MOSSBRIDGE_SESSION_REFRESH_STATE_INVALID";
      throw wrapped;
    }
  }

  save() {
    if (!this.filePath) {
      return;
    }
    const tempPath = `${this.filePath}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(this.state, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      try { fs.unlinkSync(tempPath); } catch {}
      throw error;
    }
  }

  requestRefresh({
    bindingKey = "",
    workspaceRoot = "",
    runtimeId = "",
    oldThreadId = "",
    reason = "",
    requestedBy = "codex_maintenance",
    causalMessageId = "",
    redispatchGeneration = 0,
    supersededRun = null,
  } = {}) {
    const normalized = normalizeScope({ bindingKey, workspaceRoot, runtimeId });
    if (!normalized.bindingKey || !normalized.workspaceRoot || !normalized.runtimeId) {
      throw new Error("bindingKey, workspaceRoot, and runtimeId are required for a session refresh request");
    }

    this.load();
    const now = new Date().toISOString();
    const initialSupersededRun = normalizeSupersededRun(supersededRun);
    const next = {
      id: `session-refresh-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
      ...normalized,
      oldThreadId: normalizeText(oldThreadId),
      newThreadId: "",
      newTurnId: "",
      causalMessageId: normalizeText(causalMessageId),
      redispatchGeneration: Math.max(0, Number(redispatchGeneration) || 0),
      supersededRuns: initialSupersededRun.threadId ? [initialSupersededRun] : [],
      reason: normalizeText(reason) || "manual_maintenance",
      requestedBy: normalizeText(requestedBy) || "codex_maintenance",
      requestedAt: now,
      appliedAt: "",
      completedAt: "",
      skippedAt: "",
      skipReason: "",
      status: "pending",
    };
    this.state.requests = [
      ...this.state.requests.filter((entry) => !isSamePendingScope(entry, normalized)),
      next,
    ].slice(-100);
    this.save();
    return { ...next };
  }

  getPendingRequest({
    bindingKey = "",
    workspaceRoot = "",
    runtimeId = "",
    currentThreadId = "",
  } = {}) {
    const normalized = normalizeScope({ bindingKey, workspaceRoot, runtimeId });
    if (!normalized.bindingKey || !normalized.workspaceRoot || !normalized.runtimeId) {
      return null;
    }
    const normalizedCurrentThreadId = normalizeText(currentThreadId);
    this.load();
    const requests = Array.isArray(this.state.requests) ? this.state.requests : [];
    for (let index = requests.length - 1; index >= 0; index -= 1) {
      const candidate = requests[index];
      if (
        isSamePendingScope(candidate, normalized)
        && pendingRequestMatchesCurrentThread(candidate, normalizedCurrentThreadId)
      ) {
        return { ...candidate };
      }
    }
    return null;
  }

  markApplied(id, patch = {}) {
    return this.updateRequest(id, {
      ...patch,
      status: "applied",
      appliedAt: new Date().toISOString(),
      skippedAt: "",
      skipReason: "",
    });
  }

  markSuccessorStarted(id, patch = {}) {
    const normalizedPatch = normalizePatch(patch);
    const next = this.updateRequest(id, {
      ...normalizedPatch,
      status: "successor_started",
      successorStartedAt: new Date().toISOString(),
      completedAt: "",
    });
    if (!next) {
      return null;
    }
    const earlyStart = this.consumeEarlyRuntimeStart(next.newThreadId, next.newTurnId);
    const reconciled = earlyStart
      ? this.markFirstTurnStarted({
          threadId: next.newThreadId,
          turnId: next.newTurnId,
          observedAt: earlyStart.observedAt,
        })
      : next;
    const earlyOutcome = this.consumeEarlyRuntimeOutcome(next.newThreadId, next.newTurnId);
    return earlyOutcome
      ? this.completeFromRuntimeOutcome(earlyOutcome)
      : reconciled;
  }

  markFirstTurnStarted({ threadId = "", turnId = "", observedAt = "" } = {}) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTurnId = normalizeText(turnId);
    if (!normalizedThreadId) {
      return null;
    }
    this.load();
    const index = findLiveSuccessorIndex(this.state.requests, normalizedThreadId, normalizedTurnId);
    if (index < 0) {
      const hasAppliedTransition = this.state.requests.some((entry) => normalizeText(entry?.status) === "applied");
      if (!hasAppliedTransition) {
        return null;
      }
      this.recordEarlyRuntimeStart({ threadId: normalizedThreadId, turnId: normalizedTurnId, observedAt });
      return null;
    }
    const current = this.state.requests[index];
    const updated = {
      ...current,
      status: "first_turn_started",
      firstTurnStartedAt: normalizeText(observedAt) || new Date().toISOString(),
    };
    this.state.requests[index] = updated;
    this.save();
    return { ...updated };
  }

  completeFromRuntimeOutcome({
    threadId = "",
    turnId = "",
    runtimeStatus = "completed",
    writebackSettled = false,
    assistantOutcome = "",
  } = {}) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTurnId = normalizeText(turnId);
    if (!normalizedThreadId) {
      return null;
    }
    this.load();
    const index = findLiveSuccessorIndex(this.state.requests, normalizedThreadId, normalizedTurnId);
    if (index < 0) {
      const hasAppliedTransition = this.state.requests.some((entry) => normalizeText(entry?.status) === "applied");
      if (hasAppliedTransition) {
        this.recordEarlyRuntimeOutcome({
          threadId: normalizedThreadId,
          turnId: normalizedTurnId,
          runtimeStatus,
          writebackSettled,
          assistantOutcome,
        });
      }
      return null;
    }
    const current = this.state.requests[index];
    const runtimeStarted = normalizeText(current.status) === "first_turn_started";
    const outcomePresent = normalizeText(assistantOutcome) === "present";
    if (!runtimeStarted || normalizeText(runtimeStatus) !== "completed" || !writebackSettled || !outcomePresent) {
      const failureCode = !runtimeStarted
        ? "runtime_start_evidence_missing"
        : normalizeText(runtimeStatus) !== "completed"
          ? "runtime_turn_failed"
          : !outcomePresent
            ? "assistant_outcome_missing"
            : "writeback_failed";
      const failed = {
        ...current,
        status: "terminal_failed",
        terminalAt: new Date().toISOString(),
        terminalStatus: normalizeText(runtimeStatus) || "failed",
        writebackSettled: Boolean(writebackSettled),
        assistantOutcome: normalizeText(assistantOutcome),
        failureCode,
      };
      this.state.requests[index] = failed;
      this.save();
      return { ...failed };
    }
    const completedAt = new Date().toISOString();
    const completed = {
      ...current,
      status: "completed",
      terminalAt: completedAt,
      terminalStatus: "completed",
      writebackSettled: true,
      assistantOutcome: normalizeText(assistantOutcome),
      completedAt,
      postRefreshGraceThreadId: normalizedThreadId,
      postRefreshGraceRemaining: resolveCompletionGraceTurns(current),
      postRefreshGraceStartedAt: completedAt,
      postRefreshGraceLastUsedAt: "",
    };
    this.state.requests[index] = completed;
    this.save();
    return { ...completed };
  }

  recordSupersededRun(id, run = {}) {
    const normalizedId = normalizeText(id);
    const threadId = normalizeText(run.threadId);
    if (!normalizedId || !threadId) {
      return null;
    }
    const record = normalizeSupersededRun(run);
    const current = this.listRequests().find((entry) => normalizeText(entry.id) === normalizedId);
    if (!current) {
      return null;
    }
    const supersededRuns = mergeSupersededRuns(current.supersededRuns, record);
    return this.updateRequest(normalizedId, { supersededRuns });
  }

  listSupersededRuns() {
    this.load();
    return this.state.requests.flatMap((entry) => (
      Array.isArray(entry?.supersededRuns) ? entry.supersededRuns : []
    )).map((entry) => ({ ...entry }));
  }

  markCompleted(id, patch = {}) {
    const completedAt = new Date().toISOString();
    const normalizedPatch = normalizePatch(patch);
    const nextPatch = {
      ...normalizedPatch,
      status: "completed",
      completedAt,
    };
    const newThreadId = normalizeText(normalizedPatch.newThreadId);
    const graceTurns = resolveGraceTurns(normalizedPatch);
    if (newThreadId && graceTurns > 0) {
      nextPatch.postRefreshGraceThreadId = newThreadId;
      nextPatch.postRefreshGraceRemaining = graceTurns;
      nextPatch.postRefreshGraceStartedAt = completedAt;
      nextPatch.postRefreshGraceLastUsedAt = "";
    }
    return this.updateRequest(id, nextPatch);
  }

  requeueAfterPreStartFailure(id, patch = {}) {
    const normalizedId = normalizeText(id);
    if (!normalizedId) {
      return null;
    }
    this.load();
    const now = new Date().toISOString();
    const supersededRun = normalizeSupersededRun(patch?.supersededRun);
    const normalizedPatch = normalizePatch(patch);
    delete normalizedPatch.supersededRun;
    let updated = null;
    this.state.requests = (Array.isArray(this.state.requests) ? this.state.requests : []).map((entry) => {
      if (
        normalizeText(entry?.id) !== normalizedId
        || !["applied", "successor_started", "first_turn_started", "completed"].includes(normalizeText(entry?.status))
      ) {
        return entry;
      }
      updated = {
        ...entry,
        ...normalizedPatch,
        supersededRuns: supersededRun.threadId
          ? mergeSupersededRuns(entry.supersededRuns, supersededRun)
          : entry.supersededRuns,
        status: "pending",
        appliedAt: "",
        lastAppliedAt: normalizeText(entry?.appliedAt) || normalizeText(entry?.lastAppliedAt),
        lastCompletedAt: normalizeText(entry?.completedAt) || normalizeText(entry?.lastCompletedAt),
        requeuedAt: now,
        lastPreStartFailureAt: now,
        preStartRecoveryCount: Math.max(0, Number(entry?.preStartRecoveryCount) || 0) + 1,
        completedAt: "",
        newThreadId: "",
        newTurnId: "",
        successorStartedAt: "",
        firstTurnStartedAt: "",
        terminalAt: "",
        terminalStatus: "",
        writebackSettled: false,
        redispatchGeneration: Math.max(0, Number(entry?.redispatchGeneration) || 0) + 1,
        postRefreshGraceThreadId: "",
        postRefreshGraceRemaining: 0,
        postRefreshGraceStartedAt: "",
        postRefreshGraceLastUsedAt: "",
      };
      return updated;
    });
    if (!updated) {
      return null;
    }
    this.save();
    return { ...updated };
  }

  markSkipped(id, reason = "", patch = {}) {
    return this.updateRequest(id, {
      ...patch,
      status: "skipped",
      skippedAt: new Date().toISOString(),
      skipReason: normalizeText(reason) || "skipped",
    });
  }

  listRequests() {
    this.load();
    return (Array.isArray(this.state.requests) ? this.state.requests : []).map((entry) => ({ ...entry }));
  }

  reconcileStartup() {
    const now = new Date().toISOString();
    let changed = false;
    this.state.requests = (Array.isArray(this.state.requests) ? this.state.requests : []).map((entry) => {
      const status = normalizeText(entry?.status);
      const retryBodyUnavailable = status === "pending" && Number(entry?.redispatchGeneration) > 0;
      if (!["applied", "successor_started", "first_turn_started"].includes(status) && !retryBodyUnavailable) {
        return entry;
      }
      changed = true;
      return {
        ...entry,
        status: "terminal_failed",
        terminalAt: now,
        terminalStatus: "restart_incomplete",
        failureCode: status === "first_turn_started"
          ? "restart_after_runtime_started_without_terminal_receipt"
          : "restart_pre_start_retry_body_unavailable",
      };
    });
    if (changed) {
      this.save();
    }
  }

  consumePostRefreshGrace({
    bindingKey = "",
    workspaceRoot = "",
    runtimeId = "",
    threadId = "",
    maxAgeMs = DEFAULT_POST_REFRESH_GRACE_MAX_AGE_MS,
  } = {}) {
    const normalized = normalizeScope({ bindingKey, workspaceRoot, runtimeId });
    const normalizedThreadId = normalizeText(threadId);
    if (!normalized.bindingKey || !normalized.workspaceRoot || !normalized.runtimeId || !normalizedThreadId) {
      return null;
    }
    this.load();
    const requests = Array.isArray(this.state.requests) ? this.state.requests : [];
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    for (let index = requests.length - 1; index >= 0; index -= 1) {
      const candidate = requests[index];
      if (!isSameCompletedScope(candidate, normalized)) {
        continue;
      }
      const graceThreadId = normalizeText(candidate.postRefreshGraceThreadId || candidate.newThreadId);
      if (graceThreadId !== normalizedThreadId) {
        continue;
      }
      const remaining = Math.max(0, Number(candidate.postRefreshGraceRemaining) || 0);
      if (remaining <= 0) {
        return null;
      }
      const startedAtMs = Date.parse(normalizeText(candidate.postRefreshGraceStartedAt || candidate.completedAt));
      if (Number.isFinite(startedAtMs) && maxAgeMs > 0 && nowMs - startedAtMs > maxAgeMs) {
        const expired = {
          ...candidate,
          postRefreshGraceRemaining: 0,
          postRefreshGraceExpiredAt: nowIso,
        };
        this.state.requests[index] = expired;
        this.save();
        return null;
      }
      const updated = {
        ...candidate,
        postRefreshGraceRemaining: remaining - 1,
        postRefreshGraceLastUsedAt: nowIso,
      };
      this.state.requests[index] = updated;
      this.save();
      return {
        active: true,
        request: { ...updated },
        remainingBefore: remaining,
        remainingAfter: remaining - 1,
      };
    }
    return null;
  }

  updateRequest(id, patch = {}) {
    const normalizedId = normalizeText(id);
    if (!normalizedId) {
      return null;
    }
    this.load();
    let updated = null;
    this.state.requests = (Array.isArray(this.state.requests) ? this.state.requests : []).map((entry) => {
      if (normalizeText(entry?.id) !== normalizedId) {
        return entry;
      }
      updated = {
        ...entry,
        ...normalizePatch(patch),
      };
      return updated;
    });
    this.save();
    return updated ? { ...updated } : null;
  }
}

function createEmptyState() {
  return {
    requests: [],
    earlyRuntimeStarts: [],
    earlyRuntimeOutcomes: [],
  };
}

SessionRefreshRequestStore.prototype.recordEarlyRuntimeStart = function recordEarlyRuntimeStart({
  threadId = "",
  turnId = "",
  observedAt = "",
} = {}) {
  const normalizedThreadId = normalizeText(threadId);
  if (!normalizedThreadId) {
    return null;
  }
  const next = {
    threadId: normalizedThreadId,
    turnId: normalizeText(turnId),
    observedAt: normalizeText(observedAt) || new Date().toISOString(),
  };
  this.state.earlyRuntimeStarts = [
    ...(Array.isArray(this.state.earlyRuntimeStarts) ? this.state.earlyRuntimeStarts : []),
    next,
  ].slice(-50);
  this.save();
  return next;
};

SessionRefreshRequestStore.prototype.consumeEarlyRuntimeStart = function consumeEarlyRuntimeStart(threadId = "", turnId = "") {
  const normalizedThreadId = normalizeText(threadId);
  const normalizedTurnId = normalizeText(turnId);
  this.load();
  const starts = Array.isArray(this.state.earlyRuntimeStarts) ? this.state.earlyRuntimeStarts : [];
  const index = starts.findIndex((entry) => (
    normalizeText(entry?.threadId) === normalizedThreadId
    && (!normalizedTurnId || !normalizeText(entry?.turnId) || normalizeText(entry?.turnId) === normalizedTurnId)
  ));
  if (index < 0) {
    return null;
  }
  const [matched] = starts.splice(index, 1);
  this.state.earlyRuntimeStarts = starts;
  this.save();
  return matched;
};

SessionRefreshRequestStore.prototype.recordEarlyRuntimeOutcome = function recordEarlyRuntimeOutcome({
  threadId = "",
  turnId = "",
  runtimeStatus = "completed",
  writebackSettled = false,
  assistantOutcome = "",
} = {}) {
  const normalizedThreadId = normalizeText(threadId);
  if (!normalizedThreadId) {
    return null;
  }
  const next = {
    threadId: normalizedThreadId,
    turnId: normalizeText(turnId),
    runtimeStatus: normalizeText(runtimeStatus) || "completed",
    writebackSettled: Boolean(writebackSettled),
    assistantOutcome: normalizeText(assistantOutcome),
    observedAt: new Date().toISOString(),
  };
  this.state.earlyRuntimeOutcomes = [
    ...(Array.isArray(this.state.earlyRuntimeOutcomes) ? this.state.earlyRuntimeOutcomes : []),
    next,
  ].slice(-50);
  this.save();
  return next;
};

SessionRefreshRequestStore.prototype.consumeEarlyRuntimeOutcome = function consumeEarlyRuntimeOutcome(threadId = "", turnId = "") {
  const normalizedThreadId = normalizeText(threadId);
  const normalizedTurnId = normalizeText(turnId);
  this.load();
  const outcomes = Array.isArray(this.state.earlyRuntimeOutcomes) ? this.state.earlyRuntimeOutcomes : [];
  const index = outcomes.findIndex((entry) => (
    normalizeText(entry?.threadId) === normalizedThreadId
    && (!normalizedTurnId || !normalizeText(entry?.turnId) || normalizeText(entry?.turnId) === normalizedTurnId)
  ));
  if (index < 0) {
    return null;
  }
  const [matched] = outcomes.splice(index, 1);
  this.state.earlyRuntimeOutcomes = outcomes;
  this.save();
  return matched;
};

function normalizeScope({ bindingKey = "", workspaceRoot = "", runtimeId = "" } = {}) {
  return {
    bindingKey: normalizeText(bindingKey),
    workspaceRoot: normalizeText(workspaceRoot),
    runtimeId: normalizeText(runtimeId) || "codex",
  };
}

function normalizePatch(patch = {}) {
  const out = {};
  for (const [key, value] of Object.entries(patch || {})) {
    out[key] = typeof value === "string" ? value.trim() : value;
  }
  return out;
}

function resolveGraceTurns(patch = {}) {
  if (Object.prototype.hasOwnProperty.call(patch, "postRefreshGraceRemaining")) {
    return Math.max(0, Number(patch.postRefreshGraceRemaining) || 0);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "postRefreshGraceTurns")) {
    return Math.max(0, Number(patch.postRefreshGraceTurns) || 0);
  }
  return DEFAULT_POST_REFRESH_GRACE_TURNS;
}

function resolveCompletionGraceTurns(entry = {}) {
  if (Object.prototype.hasOwnProperty.call(entry, "postRefreshGraceTurns")) {
    return Math.max(0, Number(entry.postRefreshGraceTurns) || 0);
  }
  return DEFAULT_POST_REFRESH_GRACE_TURNS;
}

function normalizeSupersededRun(run = {}) {
  const source = run && typeof run === "object" ? run : {};
  return {
    threadId: normalizeText(source.threadId),
    turnId: normalizeText(source.turnId),
    causalMessageId: normalizeText(source.causalMessageId),
    redispatchGeneration: Math.max(0, Number(source.redispatchGeneration) || 0),
    supersededAt: normalizeText(source.supersededAt) || new Date().toISOString(),
  };
}

function mergeSupersededRuns(existing = [], run = {}) {
  const next = normalizeSupersededRun(run);
  if (!next.threadId) {
    return Array.isArray(existing) ? existing.slice(-4) : [];
  }
  return [
    ...(Array.isArray(existing) ? existing : []).filter((entry) => (
      normalizeText(entry?.threadId) !== next.threadId
      || normalizeText(entry?.turnId) !== next.turnId
    )),
    next,
  ].slice(-4);
}

function isSamePendingScope(entry = {}, scope = {}) {
  return normalizeText(entry?.status) === "pending"
    && normalizeText(entry?.bindingKey) === scope.bindingKey
    && normalizeText(entry?.workspaceRoot) === scope.workspaceRoot
    && normalizeText(entry?.runtimeId) === scope.runtimeId;
}

function isSameCompletedScope(entry = {}, scope = {}) {
  return normalizeText(entry?.status) === "completed"
    && normalizeText(entry?.bindingKey) === scope.bindingKey
    && normalizeText(entry?.workspaceRoot) === scope.workspaceRoot
    && normalizeText(entry?.runtimeId) === scope.runtimeId;
}

function findLiveSuccessorIndex(requests = [], threadId = "", turnId = "") {
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const entry = requests[index];
    if (!["successor_started", "first_turn_started"].includes(normalizeText(entry?.status))) {
      continue;
    }
    if (normalizeText(entry?.newThreadId) !== threadId) {
      continue;
    }
    const expectedTurnId = normalizeText(entry?.newTurnId);
    if (turnId && expectedTurnId && turnId !== expectedTurnId) {
      continue;
    }
    return index;
  }
  return -1;
}

function pendingRequestMatchesCurrentThread(entry = {}, currentThreadId = "") {
  const normalizedCurrentThreadId = normalizeText(currentThreadId);
  const requestedOldThreadId = normalizeText(entry?.oldThreadId);
  return !normalizedCurrentThreadId
    || !requestedOldThreadId
    || normalizedCurrentThreadId === requestedOldThreadId;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { SessionRefreshRequestStore };
