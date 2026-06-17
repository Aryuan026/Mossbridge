const RUNTIME_NOTICE_KIND = {
  NONE: "",
  CAPACITY: "runtime_capacity",
  CAPACITY_WARNING: "runtime_capacity_warning",
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

const CAPACITY_WARNING_PATTERNS = [
  /\b(?:claude(?:\s+code)?|anthropic)\b[\s\S]{0,120}\b(?:usage|message|rate|request|weekly)\s+limit\b[\s\S]{0,120}\b(?:remaining|left|near|approach(?:ing)?|close)\b/i,
  /\b(?:approach(?:ing)?|near|close\s+to)\b[\s\S]{0,80}\b(?:usage|message|rate|request|weekly)\s+limit\b/i,
  /\b(?:you\s+have|you(?:'|’)ve\s+got)\b[\s\S]{0,80}\b(?:messages?|requests?|usage)\b[\s\S]{0,40}\b(?:remaining|left)\b/i,
  /\b(?:messages?|requests?)\b[\s\S]{0,40}\b(?:remaining|left)\b[\s\S]{0,80}\b(?:until|before)\b[\s\S]{0,40}\b(?:reset|resets?)\b/i,
];

function classifyRuntimeNotice(text) {
  const normalized = normalizeText(text);
  if (!normalized || normalized.length > 4000) {
    return RUNTIME_NOTICE_KIND.NONE;
  }
  if (CAPACITY_NOTICE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return RUNTIME_NOTICE_KIND.CAPACITY;
  }
  if (CAPACITY_WARNING_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return RUNTIME_NOTICE_KIND.CAPACITY_WARNING;
  }
  return RUNTIME_NOTICE_KIND.NONE;
}

function isRuntimeCapacityNotice(text) {
  return classifyRuntimeNotice(text) === RUNTIME_NOTICE_KIND.CAPACITY;
}

function isRuntimeCapacityWarning(text) {
  return classifyRuntimeNotice(text) === RUNTIME_NOTICE_KIND.CAPACITY_WARNING;
}

function isRuntimeCapacitySignal(text) {
  const kind = classifyRuntimeNotice(text);
  return kind === RUNTIME_NOTICE_KIND.CAPACITY || kind === RUNTIME_NOTICE_KIND.CAPACITY_WARNING;
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
  if (kind === RUNTIME_NOTICE_KIND.CAPACITY_WARNING) {
    return {
      shielded: true,
      kind,
      action: "replace",
      text: buildRuntimeCapacityWarningNotice(text),
    };
  }
  return { shielded: true, kind, action: "silent", text: "" };
}

function buildRuntimeCapacityNotice(text, { runtimeId = "" } = {}) {
  const reset = extractResetTime(text);
  const runtimeLabel = resolveRuntimeLabel(runtimeId, text);
  const lines = [
    "source: bridge",
    `runtime: ${runtimeLabel}`,
    "status: rate_or_quota_limited",
    "result: no_runtime_reply",
    "action: retry_after_reset",
  ];
  if (reset) {
    lines.push(`reset: ${reset}`);
  }
  return formatBridgeNotice("runtime_limit", lines);
}

function buildRuntimeCapacityWarningNotice(text, { runtimeId = "" } = {}) {
  const reset = extractResetTime(text);
  const runtimeLabel = resolveRuntimeLabel(runtimeId, text);
  const lines = [
    "source: bridge",
    `runtime: ${runtimeLabel}`,
    "status: usage_warning",
    "result: runtime_still_available",
    "action: continue_normally",
  ];
  if (reset) {
    lines.push(`reset: ${reset}`);
  }
  return formatBridgeNotice("runtime_usage_warning", lines);
}

function formatBridgeNotice(code, detailLines = []) {
  const normalizedCode = normalizeText(code) || "status";
  const lines = [`[Mossbridge] ${normalizedCode}`];
  for (const line of Array.isArray(detailLines) ? detailLines : [detailLines]) {
    const normalized = normalizeText(line);
    if (normalized) {
      lines.push(normalized);
    }
  }
  return lines.join("\n");
}

function resolveRuntimeLabel(runtimeId, text) {
  const normalizedRuntime = normalizeText(runtimeId).toLowerCase();
  if (normalizedRuntime === "claudecode") {
    return "ClaudeCode";
  }
  if (normalizedRuntime === "codex") {
    return "Codex";
  }
  const normalizedText = normalizeText(text);
  if (/\bclaude(?:\s+code)?\b/i.test(normalizedText)) {
    return "ClaudeCode";
  }
  if (/\bcodex\b/i.test(normalizedText)) {
    return "Codex";
  }
  return "runtime";
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
  buildRuntimeCapacityWarningNotice,
  buildRuntimeCapacityNotice,
  classifyRuntimeNotice,
  formatBridgeNotice,
  isRuntimeCapacitySignal,
  isRuntimeCapacityNotice,
  isRuntimeCapacityWarning,
  shieldRuntimeNoticeForDelivery,
};
