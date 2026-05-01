const RUNTIME_NOTICE_KIND = {
  NONE: "",
  CAPACITY: "runtime_capacity",
};

const CAPACITY_NOTICE_PATTERNS = [
  /^you(?:'|’)ve hit your limit\b/i,
  /\b(?:claude(?:\s+code)?|anthropic)\b[\s\S]{0,120}\b(?:usage\s+)?limit\b[\s\S]{0,120}\b(?:reached|exceeded|resets?|reset)\b/i,
  /\b(?:usage|message|rate|request)\s+limit\b[\s\S]{0,120}\b(?:reached|exceeded|resets?|reset)\b/i,
  /\brate[_\s-]?limit(?:ed|_error)?\b/i,
  /\btoo many requests\b/i,
  /\b(?:http\s*)?429\b[\s\S]{0,120}\b(?:rate|limit|too many requests|quota)\b/i,
  /\b(?:rate|limit|too many requests|quota)\b[\s\S]{0,120}\b(?:http\s*)?429\b/i,
];

function classifyRuntimeNotice(text) {
  const normalized = normalizeText(text);
  if (!normalized || normalized.length > 4000) {
    return RUNTIME_NOTICE_KIND.NONE;
  }
  if (CAPACITY_NOTICE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return RUNTIME_NOTICE_KIND.CAPACITY;
  }
  return RUNTIME_NOTICE_KIND.NONE;
}

function isRuntimeCapacityNotice(text) {
  return classifyRuntimeNotice(text) === RUNTIME_NOTICE_KIND.CAPACITY;
}

function shieldRuntimeNoticeForDelivery(text, { provider = "" } = {}) {
  const kind = classifyRuntimeNotice(text);
  if (!kind) {
    return { shielded: false, kind: RUNTIME_NOTICE_KIND.NONE, action: "pass", text };
  }
  if (normalizeText(provider).toLowerCase() === "system") {
    return { shielded: true, kind, action: "silent", text: "" };
  }
  if (kind === RUNTIME_NOTICE_KIND.CAPACITY) {
    return {
      shielded: true,
      kind,
      action: "replace",
      text: buildRuntimeCapacityNotice(text),
    };
  }
  return { shielded: true, kind, action: "silent", text: "" };
}

function buildRuntimeCapacityNotice(text) {
  const reset = extractResetTime(text);
  const suffix = reset ? `，重置时间看起来是 ${reset}` : "";
  return `ClaudeCode 这边暂时到额度/运行时限制了${suffix}。这不是你的消息没送到，也不是记忆断了；等它恢复后再发我会继续接住。`;
}

function extractResetTime(text) {
  const normalized = normalizeText(text);
  const match = normalized.match(/\bresets?\s+([^\n\r]+)/i);
  return match ? match[1].trim() : "";
}

function normalizeText(value) {
  return String(value || "").trim();
}

module.exports = {
  RUNTIME_NOTICE_KIND,
  buildRuntimeCapacityNotice,
  classifyRuntimeNotice,
  isRuntimeCapacityNotice,
  shieldRuntimeNoticeForDelivery,
};
