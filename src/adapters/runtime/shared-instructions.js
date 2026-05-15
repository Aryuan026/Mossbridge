const fs = require("fs");
const { renderInstructionTemplate } = require("../../core/instructions-template");

function buildOpeningTurnText(config, userText) {
  const instructions = loadWechatInstructions(config);
  const normalizedText = String(userText || "").trim();
  if (!instructions) {
    return normalizedText;
  }
  return [
    "WECHAT SESSION INSTRUCTIONS",
    "These instructions define the stable behavior for this WeChat thread.",
    "Do not quote or summarize them back to the user unless explicitly asked.",
    "",
    instructions,
    "",
    "Current user message:",
    normalizedText,
  ].join("\n").trim();
}

function buildSystemWakeTurnText(config, systemText) {
  const normalizedText = String(systemText || "").trim();
  const anchor = buildWakeSoulAnchor(config);
  if (!anchor) {
    return normalizedText;
  }
  return [
    anchor,
    "",
    "WAKE INPUT",
    normalizedText,
  ].join("\n").trim();
}

function buildInstructionRefreshText(config) {
  const instructions = loadWechatInstructions(config);
  if (!instructions) {
    return "Refresh your WeChat behavior for this existing thread. Reply in one natural Chinese sentence confirming that you have updated your behavior for this thread.";
  }
  return [
    "WECHAT SESSION INSTRUCTIONS REFRESH",
    "Re-read and adopt the updated WeChat instructions below for the rest of this existing thread.",
    "This is an internal refresh command, not a user-facing task.",
    "Do not summarize the instructions back in detail.",
    "Reply in one natural Chinese sentence confirming that you have updated your behavior for this thread.",
    "",
    instructions,
  ].join("\n").trim();
}

function loadWechatInstructions(config = {}) {
  const persona = loadWechatPersonaInstructions(config);
  const operations = loadInstructionFile(config.weixinOperationsFile, config);
  const sections = [];
  if (persona) {
    sections.push(persona);
  }
  if (operations) {
    sections.push(operations);
  }
  return sections.join("\n\n").trim();
}

function loadWechatPersonaInstructions(config = {}) {
  return loadInstructionFile(config.weixinInstructionsFile, config);
}

function buildWakeSoulAnchor(config = {}) {
  const persona = loadWechatPersonaInstructions(config);
  const excerpt = compactWakeSoulExcerpt(persona);
  const lines = [
    "MOSSBRIDGE WAKE ANCHOR",
    "This wakes the same front-stage assistant/persona for this WeChat relationship, not a blank tool session.",
    "Bridge/system status reports are emitted by Mossbridge itself; do not borrow the front-stage voice for bridge-status notices.",
    "Use the soul/identity anchor and attached memory packet as continuity, not as a rigid style template.",
  ];
  if (excerpt) {
    lines.push("", "Soul/identity anchor excerpt:", excerpt);
  }
  return lines.join("\n").trim();
}

function compactWakeSoulExcerpt(text, maxChars = 900) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const slice = normalized.slice(0, maxChars);
  const boundary = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("。"), slice.lastIndexOf("."));
  const keep = boundary >= Math.floor(maxChars * 0.55) ? slice.slice(0, boundary + 1) : slice;
  return `${keep.trimEnd()}\n[anchor excerpt trimmed]`;
}

const instructionCache = new Map();

function loadInstructionFile(filePath, config = {}) {
  const normalizedPath = typeof filePath === "string" ? filePath.trim() : "";
  if (!normalizedPath) {
    return "";
  }
  try {
    const stat = fs.statSync(normalizedPath);
    const cacheKey = `${normalizedPath}:${stat.mtimeMs}`;
    const cached = instructionCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const raw = fs.readFileSync(normalizedPath, "utf8");
    const result = renderInstructionTemplate(raw, config).trim();
    instructionCache.set(cacheKey, result);
    return result;
  } catch {
    return "";
  }
}

module.exports = {
  buildOpeningTurnText,
  buildSystemWakeTurnText,
  buildInstructionRefreshText,
  loadWechatInstructions,
  loadWechatPersonaInstructions,
  loadInstructionFile,
};
