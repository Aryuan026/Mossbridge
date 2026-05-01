const fs = require("fs");
const path = require("path");

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
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  recordContext(snapshot = {}) {
    const threadId = normalizeText(snapshot.threadId);
    const runtimeId = normalizeText(snapshot.runtimeId);
    if (!threadId && !runtimeId) {
      return null;
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

module.exports = { RuntimeContextUsageStore };
