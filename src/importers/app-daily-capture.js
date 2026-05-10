const fs = require("fs");
const path = require("path");

const BUNDLE_SCHEMA = "mossbridge_app_daily_capture_bundle_v0.1";
const STAGED_SCHEMA = "mossbridge_app_daily_capture_v0.1";
const ALLOWED_ROLES = new Set(["user", "assistant", "system", "developer", "tool", "unknown"]);

function validateDailyCaptureTarget(targetPath) {
  const errors = [];
  const normalizedPath = normalizeText(targetPath);
  if (!normalizedPath) {
    return buildResult({ errors: ["target path is required"] });
  }

  const resolvedPath = path.resolve(normalizedPath);
  let stat = null;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    return buildResult({ errors: [`target does not exist: ${resolvedPath}`] });
  }

  if (stat.isDirectory()) {
    return validateDailyCaptureDirectory(resolvedPath);
  }
  if (stat.isFile()) {
    if (!resolvedPath.endsWith(".json")) {
      return buildResult({ errors: [`single-file capture must be a .json file: ${resolvedPath}`] });
    }
    const bundle = readJsonFile(resolvedPath, errors, "bundle");
    if (!bundle) {
      return buildResult({ errors });
    }
    return validateDailyCaptureBundle(bundle, { sourcePath: resolvedPath });
  }
  return buildResult({ errors: [`target is neither a file nor a directory: ${resolvedPath}`] });
}

function validateDailyCaptureBundle(bundle, { sourcePath = "" } = {}) {
  const errors = [];
  const warnings = [];
  const normalized = bundle && typeof bundle === "object" && !Array.isArray(bundle)
    ? bundle
    : null;
  if (!normalized) {
    return buildResult({ errors: ["bundle must be a JSON object"] });
  }

  requireExact(normalized.schema, BUNDLE_SCHEMA, "schema", errors);
  requireText(normalized.source_client, "source_client", errors);
  requireDate(normalized.captured_date, "captured_date", errors);
  requireIso(normalized.captured_at, "captured_at", errors);

  const conversations = Array.isArray(normalized.conversations) ? normalized.conversations : null;
  if (!conversations) {
    errors.push("conversations must be an array");
  }

  const rows = [];
  if (conversations) {
    conversations.forEach((conversation, conversationIndex) => {
      const prefix = `conversations[${conversationIndex}]`;
      if (!conversation || typeof conversation !== "object" || Array.isArray(conversation)) {
        errors.push(`${prefix} must be an object`);
        return;
      }
      const conversationId = requireText(conversation.conversation_id, `${prefix}.conversation_id`, errors);
      const messages = Array.isArray(conversation.messages) ? conversation.messages : null;
      if (!messages) {
        errors.push(`${prefix}.messages must be an array`);
        return;
      }
      messages.forEach((message, messageIndex) => {
        const row = {
          ...message,
          source_client: normalizeText(message?.source_client) || normalizeText(normalized.source_client),
          conversation_id: normalizeText(message?.conversation_id) || conversationId,
          conversation_title: normalizeText(message?.conversation_title) || normalizeText(conversation.conversation_title),
          source_url: normalizeText(message?.source_url) || normalizeText(conversation.source_url),
        };
        validateMessageRow(row, `${prefix}.messages[${messageIndex}]`, errors, warnings);
        rows.push(row);
      });
    });
  }

  return buildResult({
    errors,
    warnings,
    summary: {
      source_path: sourcePath,
      shape: "bundle",
      schema: normalizeText(normalized.schema),
      source_client: normalizeText(normalized.source_client),
      captured_date: normalizeText(normalized.captured_date),
      captured_at: normalizeText(normalized.captured_at),
      conversation_count: conversations ? conversations.length : 0,
      message_count: rows.length,
    },
  });
}

function validateDailyCaptureDirectory(dirPath) {
  const errors = [];
  const warnings = [];
  const manifestPath = path.join(dirPath, "manifest.json");
  const conversationsPath = path.join(dirPath, "conversations.jsonl");
  const manifest = readJsonFile(manifestPath, errors, "manifest");
  const rows = readJsonlFile(conversationsPath, errors, "conversations.jsonl");

  if (manifest) {
    requireExact(manifest.schema, STAGED_SCHEMA, "manifest.schema", errors);
    requireText(manifest.source_client, "manifest.source_client", errors);
    requireDate(manifest.captured_date, "manifest.captured_date", errors);
    requireIso(manifest.captured_at, "manifest.captured_at", errors);
  }

  rows.forEach((row, index) => {
    validateMessageRow(row, `conversations.jsonl:${index + 1}`, errors, warnings);
    if (manifest?.source_client && row?.source_client && normalizeText(row.source_client) !== normalizeText(manifest.source_client)) {
      warnings.push(`conversations.jsonl:${index + 1}.source_client differs from manifest.source_client`);
    }
  });

  if (manifest?.message_count !== undefined && Number(manifest.message_count) !== rows.length) {
    warnings.push(`manifest.message_count is ${manifest.message_count}, but conversations.jsonl has ${rows.length} rows`);
  }

  return buildResult({
    errors,
    warnings,
    summary: {
      source_path: dirPath,
      shape: "staged_directory",
      schema: normalizeText(manifest?.schema),
      source_client: normalizeText(manifest?.source_client),
      captured_date: normalizeText(manifest?.captured_date),
      captured_at: normalizeText(manifest?.captured_at),
      conversation_count: countDistinct(rows.map((row) => normalizeText(row?.conversation_id))),
      message_count: rows.length,
    },
  });
}

function validateMessageRow(row, prefix, errors, warnings) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    errors.push(`${prefix} must be an object`);
    return;
  }

  requireText(row.conversation_id, `${prefix}.conversation_id`, errors);
  const role = normalizeText(row.role);
  if (!role) {
    errors.push(`${prefix}.role is required`);
  } else if (!ALLOWED_ROLES.has(role)) {
    errors.push(`${prefix}.role must be one of ${Array.from(ALLOWED_ROLES).join(", ")}`);
  }
  requireIso(row.created_at, `${prefix}.created_at`, errors);
  if (row.local_date !== undefined && normalizeText(row.local_date)) {
    requireDate(row.local_date, `${prefix}.local_date`, errors);
  }

  const text = normalizeText(row.text);
  const attachments = Array.isArray(row.attachments) ? row.attachments : [];
  if (!text && attachments.length === 0) {
    errors.push(`${prefix} must include text or attachments`);
  }
  if (row.attachments !== undefined && !Array.isArray(row.attachments)) {
    errors.push(`${prefix}.attachments must be an array when provided`);
  }
  if (!normalizeText(row.message_id)) {
    warnings.push(`${prefix}.message_id is recommended for stable deduplication`);
  }
}

function readJsonFile(filePath, errors, label) {
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    errors.push(`${label} file is missing or unreadable: ${filePath}`);
    return null;
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    errors.push(`${label} file is not valid JSON: ${error.message}`);
    return null;
  }
}

function readJsonlFile(filePath, errors, label) {
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    errors.push(`${label} file is missing or unreadable: ${filePath}`);
    return [];
  }
  const rows = [];
  content.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      rows.push(JSON.parse(trimmed));
    } catch (error) {
      errors.push(`${label}:${index + 1} is not valid JSON: ${error.message}`);
    }
  });
  return rows;
}

function requireExact(value, expected, label, errors) {
  const normalized = normalizeText(value);
  if (normalized !== expected) {
    errors.push(`${label} must be ${expected}`);
  }
  return normalized;
}

function requireText(value, label, errors) {
  const normalized = normalizeText(value);
  if (!normalized) {
    errors.push(`${label} is required`);
  }
  return normalized;
}

function requireDate(value, label, errors) {
  const normalized = requireText(value, label, errors);
  if (normalized && !/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    errors.push(`${label} must be YYYY-MM-DD`);
  }
  return normalized;
}

function requireIso(value, label, errors) {
  const normalized = requireText(value, label, errors);
  if (normalized && Number.isNaN(Date.parse(normalized))) {
    errors.push(`${label} must be an ISO timestamp`);
  }
  return normalized;
}

function countDistinct(values) {
  return new Set(values.filter(Boolean)).size;
}

function buildResult({ errors = [], warnings = [], summary = {} } = {}) {
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary,
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ALLOWED_ROLES,
  BUNDLE_SCHEMA,
  STAGED_SCHEMA,
  validateDailyCaptureBundle,
  validateDailyCaptureDirectory,
  validateDailyCaptureTarget,
};
