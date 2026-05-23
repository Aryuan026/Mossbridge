const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

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

  getPendingRequest({ bindingKey = "", workspaceRoot = "", runtimeId = "" } = {}) {
    const normalized = normalizeScope({ bindingKey, workspaceRoot, runtimeId });
    if (!normalized.bindingKey || !normalized.workspaceRoot || !normalized.runtimeId) {
      return null;
    }
    this.load();
    const requests = Array.isArray(this.state.requests) ? this.state.requests : [];
    for (let index = requests.length - 1; index >= 0; index -= 1) {
      const candidate = requests[index];
      if (isSamePendingScope(candidate, normalized)) {
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
    return this.updateRequest(id, {
      ...patch,
      status: "completed",
      completedAt: new Date().toISOString(),
    });
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

function isSamePendingScope(entry = {}, scope = {}) {
  return normalizeText(entry?.status) === "pending"
    && normalizeText(entry?.bindingKey) === scope.bindingKey
    && normalizeText(entry?.workspaceRoot) === scope.workspaceRoot
    && normalizeText(entry?.runtimeId) === scope.runtimeId;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { SessionRefreshRequestStore };
