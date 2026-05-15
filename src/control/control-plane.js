const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CONTROL_LAYER = {
  STRATEGIC: "strategic",
  TACTICAL: "tactical",
  EXECUTIVE: "executive",
  OBSERVATION: "observation",
};

const CONTROL_SCOPE = {
  BRIDGE: "bridge",
  CHANNEL: "channel",
  RUNTIME: "runtime",
  MEMORY: "memory",
  SYSTEM_TURN: "system_turn",
};

const CONTROL_SEVERITY = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
};

const DEFAULT_MAX_EVENTS = 1000;
const MAX_STRING_CHARS = 600;
const MAX_ARRAY_ITEMS = 24;
const MAX_OBJECT_KEYS = 48;
const MAX_PAYLOAD_DEPTH = 5;

class ControlLedgerStore {
  constructor({ filePath = "", maxEvents = DEFAULT_MAX_EVENTS } = {}) {
    if (!filePath) {
      throw new Error("ControlLedgerStore requires filePath");
    }
    this.filePath = filePath;
    this.maxEvents = Math.max(50, Number(maxEvents) || DEFAULT_MAX_EVENTS);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  append(event = {}) {
    const normalized = normalizeControlEvent(event);
    fs.appendFileSync(this.filePath, `${JSON.stringify(normalized)}\n`, "utf8");
    this.trimIfNeeded();
    return normalized;
  }

  list({ limit = 50, type = "", scope = "", layer = "", sinceMs = 0 } = {}) {
    const events = this.readAll();
    const normalizedType = normalizeText(type);
    const normalizedScope = normalizeText(scope);
    const normalizedLayer = normalizeText(layer);
    const parsedSinceMs = Number(sinceMs) || 0;
    const filtered = events.filter((event) => {
      if (normalizedType && event.type !== normalizedType) {
        return false;
      }
      if (normalizedScope && event.scope !== normalizedScope) {
        return false;
      }
      if (normalizedLayer && event.layer !== normalizedLayer) {
        return false;
      }
      if (parsedSinceMs > 0) {
        const observedAtMs = Date.parse(event.observedAt || "");
        if (!Number.isFinite(observedAtMs) || observedAtMs < parsedSinceMs) {
          return false;
        }
      }
      return true;
    });
    const count = Math.max(1, Number(limit) || 50);
    return filtered.slice(-count);
  }

  summarize({ limit = 100 } = {}) {
    const events = this.list({ limit });
    const byScope = {};
    const bySeverity = {};
    const recent = events.slice(-10);
    for (const event of events) {
      byScope[event.scope] = (byScope[event.scope] || 0) + 1;
      bySeverity[event.severity] = (bySeverity[event.severity] || 0) + 1;
    }
    return {
      filePath: this.filePath,
      sampleSize: events.length,
      byScope,
      bySeverity,
      recent,
    };
  }

  readAll() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      return raw
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return normalizeControlEvent(JSON.parse(line));
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  trimIfNeeded() {
    if (!this.maxEvents) {
      return;
    }
    const events = this.readAll();
    if (events.length <= this.maxEvents * 2) {
      return;
    }
    const kept = events.slice(-this.maxEvents);
    fs.writeFileSync(this.filePath, kept.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
  }
}

class ControlPlane {
  constructor({ filePath = "", runtimeId = "", source = "mossbridge", maxEvents = DEFAULT_MAX_EVENTS } = {}) {
    this.runtimeId = normalizeText(runtimeId);
    this.source = normalizeText(source) || "mossbridge";
    this.ledger = filePath
      ? new ControlLedgerStore({ filePath, maxEvents })
      : null;
  }

  record(event = {}) {
    if (!this.ledger) {
      return null;
    }
    const next = {
      source: this.source,
      runtimeId: this.runtimeId,
      ...event,
    };
    try {
      return this.ledger.append(next);
    } catch (error) {
      console.warn(`[mossbridge] control event skipped: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  observe(event = {}) {
    return this.record({
      layer: CONTROL_LAYER.OBSERVATION,
      ...event,
    });
  }

  decide(event = {}) {
    return this.record({
      layer: CONTROL_LAYER.TACTICAL,
      ...event,
    });
  }

  act(event = {}) {
    return this.record({
      layer: CONTROL_LAYER.EXECUTIVE,
      ...event,
    });
  }

  status({ limit = 100 } = {}) {
    if (!this.ledger) {
      return null;
    }
    return this.ledger.summarize({ limit });
  }
}

function createControlPlane(config = {}, options = {}) {
  const filePath = normalizeText(options.filePath) || normalizeText(config.controlLedgerFile);
  return new ControlPlane({
    filePath,
    runtimeId: normalizeText(options.runtimeId) || normalizeText(config.runtime),
    source: normalizeText(options.source) || "mossbridge.core",
    maxEvents: options.maxEvents,
  });
}

function normalizeControlEvent(event = {}) {
  const observedAt = normalizeIsoTime(event.observedAt) || new Date().toISOString();
  const type = normalizeEventType(event.type) || "control.event";
  return {
    id: normalizeText(event.id) || safeRandomId(),
    type,
    layer: normalizeEnum(event.layer, Object.values(CONTROL_LAYER), CONTROL_LAYER.EXECUTIVE),
    scope: normalizeEnum(event.scope, Object.values(CONTROL_SCOPE), CONTROL_SCOPE.BRIDGE),
    source: normalizeText(event.source) || "mossbridge",
    subject: truncateText(normalizeText(event.subject), 180),
    severity: normalizeEnum(event.severity, Object.values(CONTROL_SEVERITY), CONTROL_SEVERITY.INFO),
    reason: truncateText(normalizeText(event.reason), 240),
    outcome: truncateText(normalizeText(event.outcome), 120),
    runtimeId: normalizeText(event.runtimeId),
    correlationId: truncateText(normalizeText(event.correlationId), 180),
    observedAt,
    payload: sanitizePayload(event.payload || {}),
  };
}

function sanitizePayload(value, depth = 0) {
  if (depth > MAX_PAYLOAD_DEPTH) {
    return "[truncated-depth]";
  }
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizePayload(item, depth + 1));
  }
  if (typeof value !== "object") {
    return normalizeText(value);
  }
  const out = {};
  const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
  for (const [key, item] of entries) {
    const normalizedKey = normalizeText(key);
    if (!normalizedKey) {
      continue;
    }
    if (isSensitivePayloadKey(normalizedKey)) {
      out[normalizedKey] = "[redacted]";
      continue;
    }
    out[normalizedKey] = sanitizePayload(item, depth + 1);
  }
  return out;
}

function isSensitivePayloadKey(key) {
  return /token|secret|password|authorization|cookie|credential|session[_-]?key/i.test(key);
}

function sanitizeString(value) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return truncateText(normalized, MAX_STRING_CHARS);
}

function normalizeEventType(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return "";
  }
  return normalized
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeEnum(value, allowed, fallback) {
  const normalized = normalizeText(value).toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toISOString();
}

function truncateText(value, limit) {
  const normalized = normalizeText(value);
  if (!normalized || normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function safeRandomId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : String(value || "").trim();
}

module.exports = {
  CONTROL_LAYER,
  CONTROL_SCOPE,
  CONTROL_SEVERITY,
  ControlLedgerStore,
  ControlPlane,
  createControlPlane,
  normalizeControlEvent,
  sanitizePayload,
};
