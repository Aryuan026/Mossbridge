const fs = require("fs");
const path = require("path");

const MAX_RECENT_DELIVERIES = 80;

class StickerDeliveryAuditStore {
  constructor({ filePath } = {}) {
    this.filePath = normalizeText(filePath);
    this.state = {
      lastDelivery: null,
      recentDeliveries: [],
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
          lastDelivery: parsed.lastDelivery && typeof parsed.lastDelivery === "object"
            ? parsed.lastDelivery
            : null,
          recentDeliveries: Array.isArray(parsed.recentDeliveries)
            ? parsed.recentDeliveries.slice(-MAX_RECENT_DELIVERIES)
            : [],
        };
      }
    } catch {
      this.state = {
        lastDelivery: null,
        recentDeliveries: [],
      };
    }
  }

  save() {
    if (!this.filePath) {
      return;
    }
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }

  recordDelivery(payload = {}) {
    const event = sanitizeDelivery(payload);
    this.state.lastDelivery = event;
    this.state.recentDeliveries = [
      ...(Array.isArray(this.state.recentDeliveries) ? this.state.recentDeliveries : []),
      event,
    ].slice(-MAX_RECENT_DELIVERIES);
    this.save();
    return event;
  }

  snapshot() {
    return {
      lastDelivery: this.state.lastDelivery ? { ...this.state.lastDelivery } : null,
      recentDeliveries: Array.isArray(this.state.recentDeliveries)
        ? this.state.recentDeliveries.map((item) => ({ ...item }))
        : [],
    };
  }
}

function sanitizeDelivery(payload = {}) {
  const delivery = payload.delivery && typeof payload.delivery === "object" ? payload.delivery : {};
  return {
    kind: "sticker_delivery",
    ts: new Date().toISOString(),
    status: normalizeText(payload.status) || "unknown",
    stickerId: normalizeText(payload.stickerId),
    userId: normalizeText(payload.userId),
    sourceAssetFile: normalizeText(payload.sourceAssetFile),
    sourceFileName: basenameOrEmpty(payload.sourceFilePath),
    sourceMimeType: normalizeText(payload.sourceMimeType),
    sourceActualMimeType: normalizeText(payload.sourceActualMimeType),
    sourceSizeBytes: normalizeNullableNumber(payload.sourceSizeBytes),
    deliveryFileName: basenameOrEmpty(payload.deliveryFilePath),
    deliveryMimeType: normalizeText(payload.deliveryMimeType),
    deliveryActualMimeType: normalizeText(payload.deliveryActualMimeType),
    deliverySizeBytes: normalizeNullableNumber(payload.deliverySizeBytes),
    deliveryTransform: normalizeText(payload.deliveryTransform),
    deliveryTransformError: truncateText(payload.deliveryTransformError, 240),
    channelDeliveryKind: normalizeText(delivery.kind),
    channelFileName: normalizeText(delivery.fileName),
    fallbackFrom: normalizeText(delivery.fallbackFrom),
    fallbackReason: truncateText(delivery.fallbackReason, 240),
    error: truncateText(payload.error, 240),
    attempts: Array.isArray(payload.attempts)
      ? payload.attempts.map(sanitizeAttempt).slice(0, 8)
      : [],
  };
}

function sanitizeAttempt(value = {}) {
  return {
    status: normalizeText(value.status) || "unknown",
    transform: normalizeText(value.transform),
    fileName: basenameOrEmpty(value.filePath),
    mimeType: normalizeText(value.mimeType),
    actualMimeType: normalizeText(value.actualMimeType),
    sizeBytes: normalizeNullableNumber(value.sizeBytes),
    channelDeliveryKind: normalizeText(value.delivery?.kind),
    fallbackFrom: normalizeText(value.delivery?.fallbackFrom),
    fallbackReason: truncateText(value.delivery?.fallbackReason, 180),
    error: truncateText(value.error, 180),
  };
}

function basenameOrEmpty(value) {
  const text = normalizeText(value);
  return text ? path.basename(text) : "";
}

function truncateText(value, maxLength) {
  const text = normalizeText(value);
  const limit = Math.max(1, Number(maxLength) || 160);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNullableNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

module.exports = { StickerDeliveryAuditStore };
