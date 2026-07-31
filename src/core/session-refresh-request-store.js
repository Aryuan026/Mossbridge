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
    } catch {
      this.state = createEmptyState();
    }
  }

  save() {
    if (!this.filePath) {
      return;
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  requestRefresh({
    bindingKey = "",
    workspaceRoot = "",
    runtimeId = "",
    oldThreadId = "",
    reason = "",
    requestedBy = "codex_maintenance",
  } = {}) {
    const normalized = normalizeScope({ bindingKey, workspaceRoot, runtimeId });
    if (!normalized.bindingKey || !normalized.workspaceRoot || !normalized.runtimeId) {
      throw new Error("bindingKey, workspaceRoot, and runtimeId are required for a session refresh request");
    }

    this.load();
    const now = new Date().toISOString();
    const next = {
      id: `session-refresh-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
      ...normalized,
      oldThreadId: normalizeText(oldThreadId),
      newThreadId: "",
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
    let updated = null;
    this.state.requests = (Array.isArray(this.state.requests) ? this.state.requests : []).map((entry) => {
      if (
        normalizeText(entry?.id) !== normalizedId
        || !["applied", "completed"].includes(normalizeText(entry?.status))
      ) {
        return entry;
      }
      updated = {
        ...entry,
        ...normalizePatch(patch),
        status: "pending",
        appliedAt: "",
        lastAppliedAt: normalizeText(entry?.appliedAt) || normalizeText(entry?.lastAppliedAt),
        lastCompletedAt: normalizeText(entry?.completedAt) || normalizeText(entry?.lastCompletedAt),
        requeuedAt: now,
        lastPreStartFailureAt: now,
        preStartRecoveryCount: Math.max(0, Number(entry?.preStartRecoveryCount) || 0) + 1,
        completedAt: "",
        newThreadId: "",
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
  };
}

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
