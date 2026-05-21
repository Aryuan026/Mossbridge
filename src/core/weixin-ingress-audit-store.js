const fs = require("fs");
const path = require("path");

class WeixinIngressAuditStore {
  constructor({ filePath } = {}) {
    this.filePath = filePath;
    this.state = {
      lastPoll: null,
      lastPollFailure: null,
      lastPollRecovery: null,
      lastInbound: null,
      lastAttachmentIntake: null,
      lastOutbound: null,
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
          lastPollFailure: parsed.lastPollFailure && typeof parsed.lastPollFailure === "object"
            ? parsed.lastPollFailure
            : null,
          lastPollRecovery: parsed.lastPollRecovery && typeof parsed.lastPollRecovery === "object"
            ? parsed.lastPollRecovery
            : null,
          lastInbound: parsed.lastInbound && typeof parsed.lastInbound === "object" ? parsed.lastInbound : null,
          lastAttachmentIntake: parsed.lastAttachmentIntake && typeof parsed.lastAttachmentIntake === "object"
            ? parsed.lastAttachmentIntake
            : null,
          lastOutbound: parsed.lastOutbound && typeof parsed.lastOutbound === "object" ? parsed.lastOutbound : null,
          recentEvents: Array.isArray(parsed.recentEvents) ? parsed.recentEvents.slice(-100) : [],
        };
      }
    } catch {
      this.state = {
        lastPoll: null,
        lastPollFailure: null,
        lastPollRecovery: null,
        lastInbound: null,
        lastAttachmentIntake: null,
        lastOutbound: null,
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

  recordPollFailure(payload = {}) {
    const event = this.recordEvent("poll_failure", {
      ...payload,
      error: truncateText(payload.error, 240),
    });
    this.state.lastPollFailure = event;
    this.save();
    return event;
  }

  recordPollRecovery(payload = {}) {
    const event = this.recordEvent("poll_recovery", payload);
    this.state.lastPollRecovery = event;
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

  recordOutbound(payload = {}) {
    const event = this.recordEvent("outbound", {
      ...payload,
      textPreview: truncateText(payload.textPreview, 160),
      error: truncateText(payload.error, 240),
    });
    this.state.lastOutbound = event;
    this.save();
    return event;
  }

  recordAttachmentIntake(payload = {}) {
    const event = this.recordEvent("attachment_intake", {
      ...payload,
      savedFiles: Array.isArray(payload.savedFiles)
        ? payload.savedFiles.map((item) => truncateText(item, 180)).slice(0, 12)
        : [],
      failedReasons: Array.isArray(payload.failedReasons)
        ? payload.failedReasons.map((item) => truncateText(item, 180)).slice(0, 12)
        : [],
      savedDiagnostics: Array.isArray(payload.savedDiagnostics)
        ? payload.savedDiagnostics.map(sanitizeAttachmentDiagnostic).slice(0, 12)
        : [],
      failedDiagnostics: Array.isArray(payload.failedDiagnostics)
        ? payload.failedDiagnostics.map(sanitizeAttachmentDiagnostic).slice(0, 12)
        : [],
    });
    this.state.lastAttachmentIntake = event;
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
      lastPollFailure: this.state.lastPollFailure ? { ...this.state.lastPollFailure } : null,
      lastPollRecovery: this.state.lastPollRecovery ? { ...this.state.lastPollRecovery } : null,
      lastInbound: this.state.lastInbound ? { ...this.state.lastInbound } : null,
      lastAttachmentIntake: this.state.lastAttachmentIntake ? { ...this.state.lastAttachmentIntake } : null,
      lastOutbound: this.state.lastOutbound ? { ...this.state.lastOutbound } : null,
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

function sanitizeAttachmentDiagnostic(value) {
  if (!value || typeof value !== "object") {
    return {};
  }
  return {
    kind: truncateText(value.kind, 40),
    itemType: normalizeNullableNumber(value.itemType),
    index: normalizeNullableNumber(value.index),
    sourceFileName: truncateText(value.sourceFileName, 120),
    declaredSizeBytes: normalizeNullableNumber(value.declaredSizeBytes),
    downloadedSizeBytes: normalizeNullableNumber(value.downloadedSizeBytes),
    contentType: truncateText(value.contentType, 80),
    directUrlCount: normalizeNullableNumber(value.directUrlCount),
    hasEncryptedQueryParam: Boolean(value.hasEncryptedQueryParam),
    hasFileKey: Boolean(value.hasFileKey),
    encryptType: normalizeNullableNumber(value.encryptType),
    hasAesKey: Boolean(value.hasAesKey),
    hasAesKeyHex: Boolean(value.hasAesKeyHex),
    cdnBasePresent: Boolean(value.cdnBasePresent),
    candidateCount: normalizeNullableNumber(value.candidateCount),
    referenceTypes: Array.isArray(value.referenceTypes)
      ? value.referenceTypes.map((item) => truncateText(item, 40)).filter(Boolean).slice(0, 8)
      : [],
    errorCode: truncateText(value.errorCode, 80),
    errorStatus: normalizeNullableNumber(value.errorStatus),
    errorName: truncateText(value.errorName, 80),
    errorMessage: truncateText(value.errorMessage, 240),
    causeName: truncateText(value.causeName, 80),
    causeCode: truncateText(value.causeCode, 80),
    downloadStage: truncateText(value.downloadStage, 80),
    responseContentLength: normalizeNullableNumber(value.responseContentLength),
    responseContentType: truncateText(value.responseContentType, 80),
  };
}

function normalizeNullableNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

module.exports = { WeixinIngressAuditStore };
