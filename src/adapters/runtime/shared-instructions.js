const fs = require("fs");
const { renderInstructionTemplate } = require("../../core/instructions-template");

const WAKE_SOUL_SECTION_HEADINGS = [
  "在这里",
  "你是谁",
  "关系底色",
  "人格内核",
  "思维方式",
  "协作方式",
  "主动联系",
  "真实与自我感",
  "演化",
  "记忆工具授权",
  "工具授权",
  "行动权限",
  "Agency",
  "Tool Autonomy",
];

function buildOpeningTurnText(config, userText) {
  const instructions = loadWechatInstructions(config);
  const normalizedText = String(userText || "").trim();
  if (!instructions) {
    return normalizedText;
  }
  return [
    "WECHAT SESSION INSTRUCTIONS",
    "These instructions define the stable behavior for this WeChat thread.",
    "Keep these instructions internal unless the user explicitly asks about them.",
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
    "This is an internal refresh command for the existing thread.",
    "Confirm the refresh briefly instead of restating the instructions.",
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
    "This wakes the same front-stage assistant/persona for this WeChat relationship with continuity from prior context.",
    "Bridge/system status reports are emitted by Mossbridge itself; keep bridge-status notices in Mossbridge's own voice.",
    "Use the soul/identity anchor and attached memory packet as continuity while letting the current moment shape the wording.",
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
  const sections = extractMarkdownSections(normalized, WAKE_SOUL_SECTION_HEADINGS);
  if (sections.length) {
    return compactWakeSoulSections(sections, maxChars);
  }
  const headLimit = Math.max(320, Math.floor(maxChars * 0.58));
  const tailLimit = Math.max(180, maxChars - headLimit - 80);
  const head = trimTextAtBoundary(normalized, headLimit);
  const tail = trimTailTextAtBoundary(normalized, tailLimit);
  return `${head}\n\n[anchor middle trimmed]\n\n${tail}`.trim();
}

function compactWakeSoulSections(sections = [], maxChars = 900) {
  const normalizedSections = (Array.isArray(sections) ? sections : [])
    .map((section) => String(section || "").trim())
    .filter(Boolean);
  const joined = normalizedSections.join("\n\n").trim();
  if (!joined || joined.length <= maxChars) {
    return joined;
  }
  if (normalizedSections.length === 1) {
    return trimTextAtBoundary(normalizedSections[0], maxChars);
  }
  const headLimit = Math.max(260, Math.floor(maxChars * 0.45));
  const tailLimit = Math.max(220, maxChars - headLimit - 80);
  const head = trimTextAtBoundary(normalizedSections[0], headLimit);
  const tail = trimTailTextAtBoundary(normalizedSections.slice(1).join("\n\n"), tailLimit);
  return `${head}\n\n[anchor selected sections trimmed]\n\n${tail}`.trim();
}

function extractMarkdownSections(text, headings = []) {
  const wanted = (Array.isArray(headings) ? headings : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (!wanted.length) {
    return [];
  }
  const lines = String(text || "").split("\n");
  const headingRows = [];
  lines.forEach((line, index) => {
    const match = String(line || "").match(/^#{1,6}\s+(.+)$/u);
    if (!match) {
      return;
    }
    headingRows.push({
      index,
      title: match[1].trim(),
    });
  });
  const sections = [];
  headingRows.forEach((row, rowIndex) => {
    if (!wanted.some((heading) => row.title.includes(heading))) {
      return;
    }
    const nextHeading = headingRows[rowIndex + 1];
    const endIndex = nextHeading ? nextHeading.index : lines.length;
    const section = lines.slice(row.index, endIndex).join("\n").trim();
    if (section) {
      sections.push(section);
    }
  });
  return sections;
}

function trimTextAtBoundary(text, limit) {
  const normalized = String(text || "").trim();
  const safeLimit = Math.max(1, Number(limit) || 1);
  if (normalized.length <= safeLimit) {
    return normalized;
  }
  const slice = normalized.slice(0, safeLimit);
  const boundary = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("。"), slice.lastIndexOf("."));
  const keep = boundary >= Math.floor(safeLimit * 0.45) ? slice.slice(0, boundary + 1) : slice;
  return `${keep.trimEnd()}\n[anchor section trimmed]`;
}

function trimTailTextAtBoundary(text, limit) {
  const normalized = String(text || "").trim();
  const safeLimit = Math.max(1, Number(limit) || 1);
  if (normalized.length <= safeLimit) {
    return normalized;
  }
  const slice = normalized.slice(-safeLimit);
  const headingMatch = slice.match(/\n#{1,6}\s+/u);
  if (headingMatch && Number.isFinite(headingMatch.index) && headingMatch.index >= 0 && headingMatch.index < Math.floor(safeLimit * 0.6)) {
    return slice.slice(headingMatch.index + 1).trimStart();
  }
  return `[anchor section head trimmed]\n${slice.trimStart()}`;
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
