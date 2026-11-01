const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class RuntimeContextUsageStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath;
    this.state = {
      contextsByThreadId: {},
      latestContextByRuntimeId: {},
      autoCompactEvents: [],
    };
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
      if (parsed && typeof parsed === "object") {
        this.state = {
          contextsByThreadId: parsed.contextsByThreadId || {},
          latestContextByRuntimeId: parsed.latestContextByRuntimeId || {},
          autoCompactEvents: Array.isArray(parsed.autoCompactEvents) ? parsed.autoCompactEvents.slice(-50) : [],
        };
      }
    } catch {
      this.state = {
        contextsByThreadId: {},
        latestContextByRuntimeId: {},
        autoCompactEvents: [],
      };
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

  recordContext(snapshot = {}) {
    const threadId = normalizeText(snapshot.threadId);
    const runtimeId = normalizeText(snapshot.runtimeId);
    if (!threadId && !runtimeId) {
      return null;
    }
    const existing = threadId ? this.state.contextsByThreadId[threadId] : null;
    if (existing && hasPositiveContextUsage(existing) && !hasPositiveContextUsage(snapshot)) {
      return { ...existing };
    }
    const next = {
      ...snapshot,
      threadId,
      runtimeId,
      workspaceRoot: normalizeText(snapshot.workspaceRoot),
      bindingKey: normalizeText(snapshot.bindingKey),
      updatedAt: new Date().toISOString(),
    };
    if (threadId) {
      this.state.contextsByThreadId[threadId] = next;
    }
    if (runtimeId) {
      this.state.latestContextByRuntimeId[runtimeId] = next;
    }
    this.save();
    return next;
  }

  getContext({ threadId = "", runtimeId = "" } = {}) {
    const normalizedThreadId = normalizeText(threadId);
    if (normalizedThreadId && this.state.contextsByThreadId[normalizedThreadId]) {
      return { ...this.state.contextsByThreadId[normalizedThreadId] };
    }
    const normalizedRuntimeId = normalizeText(runtimeId);
    if (normalizedRuntimeId && this.state.latestContextByRuntimeId[normalizedRuntimeId]) {
      return { ...this.state.latestContextByRuntimeId[normalizedRuntimeId] };
    }
    return null;
  }

  getExactContext(threadId = "") {
    const normalizedThreadId = normalizeText(threadId);
    const snapshot = normalizedThreadId ? this.state.contextsByThreadId[normalizedThreadId] : null;
    return snapshot ? { ...snapshot } : null;
  }

  recordAutoCompact(event = {}) {
    const next = {
      ...event,
      threadId: normalizeText(event.threadId),
      workspaceRoot: normalizeText(event.workspaceRoot),
      reason: normalizeText(event.reason),
      requestedAt: new Date().toISOString(),
    };
    this.state.autoCompactEvents = [
      ...(Array.isArray(this.state.autoCompactEvents) ? this.state.autoCompactEvents : []),
      next,
    ].slice(-50);
    this.save();
    return next;
  }

  snapshot() {
    return {
      contextsByThreadId: { ...this.state.contextsByThreadId },
      latestContextByRuntimeId: { ...this.state.latestContextByRuntimeId },
      autoCompactEvents: Array.isArray(this.state.autoCompactEvents)
        ? this.state.autoCompactEvents.slice()
        : [],
    };
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hasPositiveContextUsage(snapshot = {}) {
  return Number(snapshot.currentTokens) > 0 && Number(snapshot.contextWindow) > 0;
}

module.exports = { RuntimeContextUsageStore };
