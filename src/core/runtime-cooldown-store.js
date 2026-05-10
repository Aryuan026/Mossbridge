const fs = require("fs");
const path = require("path");

const { isRuntimeCapacityNotice } = require("./runtime-notices");

const DEFAULT_CAPACITY_COOLDOWN_MS = 60 * 60_000;
const CAPACITY_COOLDOWN_GRACE_MS = 2 * 60_000;
const STORE_VERSION = 1;

class RuntimeCooldownStore {
  constructor({ filePath }) {
    if (!filePath) {
      throw new Error("RuntimeCooldownStore requires filePath");
    }
    this.filePath = filePath;
  }

  setCapacityCooldown({ runtimeId = "", text = "", source = "", threadId = "", nowMs = Date.now() } = {}) {
    if (!isRuntimeCapacityNotice(text)) {
      return null;
    }
    const resetAtMs = resolveCapacityResetAtMs(text, {
      nowMs,
      fallbackMs: DEFAULT_CAPACITY_COOLDOWN_MS,
      graceMs: CAPACITY_COOLDOWN_GRACE_MS,
    });
    return this.setCooldown({
      runtimeId,
      reason: "runtime_capacity",
      resetAtMs,
      source,
      threadId,
      messagePreview: String(text || "").trim().slice(0, 240),
      nowMs,
    });
  }

  setCooldown({
    runtimeId = "",
    reason = "runtime_capacity",
    resetAtMs,
    source = "",
    threadId = "",
    messagePreview = "",
    nowMs = Date.now(),
  } = {}) {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    const normalizedResetAtMs = Number(resetAtMs);
    if (!Number.isFinite(normalizedResetAtMs) || normalizedResetAtMs <= nowMs) {
      return null;
    }
    const store = this.readStore();
    const record = {
      runtimeId: normalizedRuntimeId,
      reason: normalizeText(reason) || "runtime_capacity",
      resetAt: new Date(normalizedResetAtMs).toISOString(),
      resetAtMs: normalizedResetAtMs,
      source: normalizeText(source),
      threadId: normalizeText(threadId),
      messagePreview: normalizeText(messagePreview),
      recordedAt: new Date(nowMs).toISOString(),
    };
    store.cooldowns[normalizedRuntimeId] = record;
    this.writeStore(store);
    return {
      ...record,
      active: true,
      remainingMs: normalizedResetAtMs - nowMs,
    };
  }

  getActiveCooldown(runtimeId = "", nowMs = Date.now()) {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    const store = this.readStore();
    const record = store.cooldowns[normalizedRuntimeId];
    if (!record) {
      return null;
    }
    const resetAtMs = Number(record.resetAtMs || Date.parse(record.resetAt));
    if (!Number.isFinite(resetAtMs) || resetAtMs <= nowMs) {
      delete store.cooldowns[normalizedRuntimeId];
      this.writeStore(store);
      return null;
    }
    return {
      ...record,
      resetAtMs,
      active: true,
      remainingMs: resetAtMs - nowMs,
    };
  }

  clear(runtimeId = "") {
    const normalizedRuntimeId = normalizeRuntimeId(runtimeId);
    const store = this.readStore();
    if (!store.cooldowns[normalizedRuntimeId]) {
      return false;
    }
    delete store.cooldowns[normalizedRuntimeId];
    this.writeStore(store);
    return true;
  }

  readStore() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const cooldowns = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed.cooldowns
        : null;
      return {
        version: STORE_VERSION,
        cooldowns: cooldowns && typeof cooldowns === "object" && !Array.isArray(cooldowns)
          ? { ...cooldowns }
          : {},
      };
    } catch {
      return { version: STORE_VERSION, cooldowns: {} };
    }
  }

  writeStore(store) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify({
      version: STORE_VERSION,
      cooldowns: store?.cooldowns && typeof store.cooldowns === "object" ? store.cooldowns : {},
    }, null, 2)}\n`, "utf8");
  }
}

function resolveCapacityResetAtMs(text, {
  nowMs = Date.now(),
  fallbackMs = DEFAULT_CAPACITY_COOLDOWN_MS,
  graceMs = CAPACITY_COOLDOWN_GRACE_MS,
} = {}) {
  const parsed = parseResetDateTimeText(text) || parseResetClockText(text);
  if (!parsed) {
    return nowMs + fallbackMs;
  }
  const dateParts = getShanghaiDateParts(nowMs);
  let year = Number.isFinite(parsed.year) ? parsed.year : dateParts.year;
  const month = Number.isFinite(parsed.month) ? parsed.month : dateParts.month;
  const day = Number.isFinite(parsed.day) ? parsed.day : dateParts.day;
  let resetAtMs = Date.UTC(
    year,
    month - 1,
    day,
    parsed.hour - 8,
    parsed.minute,
    0,
    0
  );

  if (parsed.hasDate && !Number.isFinite(parsed.year) && resetAtMs <= nowMs + 60_000) {
    year += 1;
    resetAtMs = Date.UTC(
      year,
      month - 1,
      day,
      parsed.hour - 8,
      parsed.minute,
      0,
      0
    );
  } else if (!parsed.hasDate && resetAtMs <= nowMs + 60_000) {
    resetAtMs += 24 * 60 * 60_000;
  }
  return resetAtMs + graceMs;
}

function parseResetDateTimeText(text) {
  const normalized = normalizeText(text);
  const monthNamePattern = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const resetPrefixPattern = "(?:resets?|reset(?:s|ting)?(?:\\s+at)?|will\\s+reset\\s+at)";
  const namedMonthPattern = new RegExp(
    `${resetPrefixPattern}\\s+(?:on\\s+)?${monthNamePattern}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\s*(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?`,
    "i"
  );
  const namedMonthMatch = normalized.match(namedMonthPattern);
  if (namedMonthMatch) {
    const clock = normalizeClockParts(namedMonthMatch[4], namedMonthMatch[5], namedMonthMatch[6]);
    const month = monthNameToNumber(namedMonthMatch[1]);
    const day = Number.parseInt(namedMonthMatch[2], 10);
    const year = Number.parseInt(namedMonthMatch[3] || "", 10);
    if (clock && Number.isFinite(month) && isValidMonthDay(month, day)) {
      return {
        ...clock,
        hasDate: true,
        month,
        day,
        year: Number.isFinite(year) ? year : undefined,
      };
    }
  }

  const numericDatePattern = new RegExp(
    `${resetPrefixPattern}\\s+(?:on\\s+)?(\\d{1,2})[/-](\\d{1,2})(?:[/-](\\d{2,4}))?\\s*(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?`,
    "i"
  );
  const numericDateMatch = normalized.match(numericDatePattern);
  if (numericDateMatch) {
    const month = Number.parseInt(numericDateMatch[1], 10);
    const day = Number.parseInt(numericDateMatch[2], 10);
    const rawYear = numericDateMatch[3];
    const year = rawYear ? normalizeYear(rawYear) : undefined;
    const clock = normalizeClockParts(numericDateMatch[4], numericDateMatch[5], numericDateMatch[6]);
    if (clock && isValidMonthDay(month, day)) {
      return {
        ...clock,
        hasDate: true,
        month,
        day,
        year,
      };
    }
  }

  return null;
}

function parseResetClockText(text) {
  const normalized = normalizeText(text);
  if (parseResetDateTimeText(normalized)) {
    return null;
  }
  const match = normalized.match(/(?:resets?|reset(?:s|ting)?(?:\s+at)?|will\s+reset\s+at)[^\d]{0,40}(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) {
    return null;
  }
  return normalizeClockParts(match[1], match[2], match[3]);
}

function normalizeClockParts(hourText, minuteText, meridiemText) {
  let hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText || "0", 10);
  const meridiem = normalizeText(meridiemText).toLowerCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) {
    return null;
  }
  if (meridiem === "am") {
    hour = hour === 12 ? 0 : hour;
  } else if (meridiem === "pm") {
    hour = hour === 12 ? 12 : hour + 12;
  }
  if (hour < 0 || hour > 23) {
    return null;
  }
  return { hour, minute };
}

function monthNameToNumber(value) {
  const normalized = normalizeText(value).toLowerCase().slice(0, 3);
  const months = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  return months[normalized];
}

function normalizeYear(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed < 100 ? 2000 + parsed : parsed;
}

function isValidMonthDay(month, day) {
  return Number.isInteger(month) && month >= 1 && month <= 12
    && Number.isInteger(day) && day >= 1 && day <= 31;
}

function getShanghaiDateParts(nowMs) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number.parseInt(byType.year, 10),
    month: Number.parseInt(byType.month, 10),
    day: Number.parseInt(byType.day, 10),
  };
}

function normalizeRuntimeId(value) {
  return normalizeText(value) || "codex";
}

function normalizeText(value) {
  return String(value || "").trim();
}

module.exports = {
  RuntimeCooldownStore,
  parseResetDateTimeText,
  parseResetClockText,
  resolveCapacityResetAtMs,
};
