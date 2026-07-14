const fs = require("fs");
const path = require("path");

const MAX_TAIL_BYTES = 256 * 1024;
const COUNT_FIELDS = [
  "count",
  "item_count",
  "sent_count",
  "saved_count",
  "written_count",
  "updated_count",
  "deleted_count",
  "patched_count",
  "closed_count",
  "appended_count",
  "imported_count",
  "ok_count",
  "failed_count",
];

class ToolInvocationAuditStore {
  constructor({ filePath } = {}) {
    this.filePath = normalizeText(filePath);
  }

  append({ toolName = "", toolProfile = "", context = {}, startedAtMs = 0, completedAtMs = 0, result = null, error = null } = {}) {
    if (!this.filePath) {
      return null;
    }
    const started = Math.max(0, Number(startedAtMs) || 0);
    const completed = Math.max(0, Number(completedAtMs) || Date.now());
    const record = {
      kind: "mossbridge_tool_invocation_receipt.v0",
      invocation_id: `tool_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      ts: new Date(completed).toISOString(),
      started_at_ms: started,
      completed_at_ms: completed,
      duration_ms: Math.max(0, completed - (started || completed)),
      tool_name: normalizeText(toolName),
      tool_profile: normalizeText(toolProfile) || "full",
      runtime_id: normalizeText(context.runtimeId),
      thread_id: normalizeText(context.threadId),
      binding_key: normalizeText(context.bindingKey),
      route_id: normalizeText(context.routeId),
      message_id: normalizeText(context.messageId),
      status: error ? "failed" : "completed",
      result: summarizeResult(result, error),
      arguments_included: false,
      result_payload_included: false,
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }

  recent({ threadId = "", bindingKey = "", sinceMs = 0, untilMs = 0, limit = 24 } = {}) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedBindingKey = normalizeText(bindingKey);
    const lowerBound = Math.max(0, Number(sinceMs) || 0);
    const upperBound = Math.max(0, Number(untilMs) || 0);
    return readTailRecords(this.filePath)
      .filter((record) => !normalizedThreadId || normalizeText(record.thread_id) === normalizedThreadId)
      .filter((record) => !normalizedBindingKey || normalizeText(record.binding_key) === normalizedBindingKey)
      .filter((record) => !lowerBound || Number(record.completed_at_ms || 0) >= lowerBound)
      .filter((record) => !upperBound || Number(record.completed_at_ms || 0) <= upperBound)
      .slice(-Math.max(1, Math.min(Number(limit) || 24, 100)));
  }
}

function summarizeResult(result, error) {
  const source = result && typeof result === "object" ? result : {};
  const data = source.data && typeof source.data === "object" ? source.data : source;
  const counts = {};
  for (const field of COUNT_FIELDS) {
    const value = Number(source[field] ?? data[field]);
    if (Number.isFinite(value)) {
      counts[field] = Math.max(0, Math.trunc(value));
    }
  }
  return {
    ok: !error && source.ok !== false && data.ok !== false,
    error_present: Boolean(error || source.error || data.error || (Array.isArray(source.errors) && source.errors.length)),
    item_count: Array.isArray(source.items)
      ? source.items.length
      : Array.isArray(data.items)
        ? data.items.length
        : Array.isArray(data.results)
          ? data.results.length
          : 0,
    counts,
  };
}

function readTailRecords(filePath) {
  const target = normalizeText(filePath);
  if (!target || !fs.existsSync(target)) {
    return [];
  }
  const stat = fs.statSync(target);
  const length = Math.min(stat.size, MAX_TAIL_BYTES);
  if (!length) {
    return [];
  }
  const offset = Math.max(0, stat.size - length);
  const handle = fs.openSync(target, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, offset);
    let text = buffer.toString("utf8");
    if (offset > 0) {
      const firstLineBreak = text.indexOf("\n");
      text = firstLineBreak >= 0 ? text.slice(firstLineBreak + 1) : "";
    }
    return text.split(/\r?\n/u).map((line) => {
      try {
        return line.trim() ? JSON.parse(line) : null;
      } catch {
        return null;
      }
    }).filter(Boolean);
  } finally {
    fs.closeSync(handle);
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { ToolInvocationAuditStore };
