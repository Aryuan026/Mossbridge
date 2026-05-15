const fs = require("fs");
const path = require("path");

const CHECKIN_OPPORTUNITY_TTL_MS = 60 * 60_000;
const DREAMING_OPPORTUNITY_TTL_MS = 6 * 60 * 60_000;

class SystemMessageQueueStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { messages: [] };
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
      const normalizedMessages = messages
        .map(normalizeSystemMessage)
        .filter(Boolean);
      this.state = {
        messages: normalizedMessages
          .filter((message) => !isExpiredSystemMessage(message))
          .sort(compareSystemMessages),
      };
      if (this.state.messages.length !== normalizedMessages.length) {
        this.save();
      }
    } catch {
      this.state = { messages: [] };
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  enqueue(message) {
    this.load();
    const normalized = normalizeSystemMessage(message);
    if (!normalized) {
      throw new Error("invalid system message");
    }
    this.state.messages.push(normalized);
    this.state.messages.sort(compareSystemMessages);
    this.save();
    return normalized;
  }

  drainForAccount(accountId) {
    this.load();
    const normalizedAccountId = normalizeText(accountId);
    const drained = [];
    const pending = [];

    for (const message of this.state.messages) {
      if (message.accountId === normalizedAccountId) {
        drained.push(message);
      } else {
        pending.push(message);
      }
    }

    if (drained.length) {
      this.state.messages = pending;
      this.save();
    }

    return drained;
  }

  hasPendingForAccount(accountId) {
    this.load();
    const normalizedAccountId = normalizeText(accountId);
    return this.state.messages.some((message) => message.accountId === normalizedAccountId);
  }
}

function isExpiredSystemMessage(message) {
  const kind = normalizeText(message?.kind);
  if (kind !== "checkin_opportunity" && kind !== "dreaming_opportunity") {
    return false;
  }
  const createdAtMs = Date.parse(message?.createdAt || "");
  if (!Number.isFinite(createdAtMs)) {
    return false;
  }
  const ttlMs = kind === "dreaming_opportunity"
    ? DREAMING_OPPORTUNITY_TTL_MS
    : CHECKIN_OPPORTUNITY_TTL_MS;
  return Date.now() - createdAtMs > ttlMs;
}

function normalizeSystemMessage(message) {
  if (!message || typeof message !== "object") {
    return null;
  }

  const id = normalizeText(message.id);
  const accountId = normalizeText(message.accountId);
  const senderId = normalizeText(message.senderId);
  const workspaceRoot = normalizeText(message.workspaceRoot);
  const text = normalizeText(message.text);
  const createdAt = normalizeIsoTime(message.createdAt);
  const kind = normalizeText(message.kind) || "generic";
  const priority = normalizeText(message.priority) || "normal";
  const title = normalizeText(message.title);
  const metadata = normalizeMetadata(message.metadata);

  if (!id || !accountId || !senderId || !workspaceRoot || !text) {
    return null;
  }

  return {
    id,
    accountId,
    senderId,
    workspaceRoot,
    text,
    kind,
    priority,
    title,
    metadata,
    createdAt: createdAt || new Date().toISOString(),
  };
}

function normalizeMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return {};
  }
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

function compareSystemMessages(left, right) {
  const leftTime = Date.parse(left?.createdAt || "") || 0;
  const rightTime = Date.parse(right?.createdAt || "") || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return String(left?.id || "").localeCompare(String(right?.id || ""));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { SystemMessageQueueStore };
