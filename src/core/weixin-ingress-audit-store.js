const fs = require("fs");
const path = require("path");

class WeixinIngressAuditStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath;
    this.state = {
      lastPoll: null,
      lastInbound: null,
      recentEvents: [],
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
          lastPoll: parsed.lastPoll && typeof parsed.lastPoll === "object" ? parsed.lastPoll : null,
          lastInbound: parsed.lastInbound && typeof parsed.lastInbound === "object" ? parsed.lastInbound : null,
          recentEvents: Array.isArray(parsed.recentEvents) ? parsed.recentEvents.slice(-100) : [],
        };
      }
    } catch {
      this.state = {
        lastPoll: null,
        lastInbound: null,
        recentEvents: [],
      };
    }
  }

  save() {
    if (!this.filePath) {
      return;
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  recordPoll(payload = {}) {
    const event = this.recordEvent("poll", payload);
    this.state.lastPoll = event;
    this.save();
    return event;
  }

  recordInbound(payload = {}) {
    const event = this.recordEvent("inbound", {
      ...payload,
      textPreview: truncateText(payload.textPreview, 160),
    });
    this.state.lastInbound = event;
    this.save();
    return event;
  }

  recordEvent(kind, payload = {}) {
    const event = {
      ...payload,
      kind: normalizeText(kind),
      ts: new Date().toISOString(),
    };
    this.state.recentEvents = [
      ...(Array.isArray(this.state.recentEvents) ? this.state.recentEvents : []),
      event,
    ].slice(-100);
    return event;
  }

  snapshot() {
    return {
      lastPoll: this.state.lastPoll ? { ...this.state.lastPoll } : null,
      lastInbound: this.state.lastInbound ? { ...this.state.lastInbound } : null,
      recentEvents: Array.isArray(this.state.recentEvents)
        ? this.state.recentEvents.slice()
        : [],
    };
  }
}

function truncateText(value, maxLength) {
  const text = normalizeText(value);
  const limit = Math.max(1, Number(maxLength) || 160);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { WeixinIngressAuditStore };
