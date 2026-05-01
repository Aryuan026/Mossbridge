const path = require("path");
const {
  canonicalAgentId,
  canonicalRealmId,
  canonicalUserId,
  resolveSingleIdentity,
} = require("../single-identity");

const MATERIAL_TYPES = new Set([
  "memo",
  "diary",
  "journal",
  "obsidian_card",
  "markdown",
  "note",
  "snippet",
  "case",
]);

const CERTAINTY_STATES = new Set([
  "anchor",
  "settled",
  "tentative",
  "conflict_open",
  "unknown",
]);

class WarmMemoryScope {
  constructor({ ownerId = "", realmId = "default", agentId = "assistant-main", identity = null } = {}) {
    const resolvedIdentity = resolveSingleIdentity(identity || {});
    void ownerId;
    void realmId;
    void agentId;
    this.ownerId = canonicalUserId("", resolvedIdentity);
    this.realmId = canonicalRealmId("", resolvedIdentity);
    this.agentId = canonicalAgentId("", resolvedIdentity);
  }

  toPathParts() {
    return [
      slugify(this.ownerId),
      slugify(this.realmId),
      slugify(this.agentId),
    ];
  }

  scopeId() {
    return [this.ownerId, this.realmId, this.agentId].join("::");
  }
}

function normalizeMaterialRecord(payload = {}, { nowIso = "" } = {}) {
  const now = normalizeText(nowIso) || new Date().toISOString();
  const title = trimText(payload.title || payload.filename || payload.material_id || "untitled", 120);
  let materialType = normalizeText(payload.material_type || payload.materialType || "memo").toLowerCase();
  if (!MATERIAL_TYPES.has(materialType)) {
    materialType = "memo";
  }
  const bodyMarkdown = normalizeLineEndings(payload.body_markdown || payload.bodyMarkdown || payload.content || "");
  const summary = trimText(payload.summary || bodyMarkdown, 500);
  const materialId = normalizeText(payload.material_id || payload.materialId) || slugify(`${materialType}-${title}`).slice(0, 64);
  const tags = stringList(payload.tags || [], 24);
  const entities = stringList(payload.entities || payload.related_entities || payload.relatedEntities || [], 64);
  const aliases = stringList(payload.aliases || payload.entity_aliases || payload.entityAliases || [], 64);
  const storylineId = normalizeText(payload.storyline_id || payload.storylineId);
  const memoryFamily = normalizeText(payload.memory_family || payload.memoryFamily);
  const provenanceRefs = stringList(payload.provenance_refs || payload.provenanceRefs || [], 24);
  let accessLog = isoStringList(payload.access_log || payload.accessLog || [], 128);
  if (!accessLog.length) {
    accessLog = isoStringList([payload.updated_at || payload.updatedAt || payload.created_at || payload.createdAt || now], 128);
  }
  const source = {
    source_client: normalizeText(payload.source_client || payload.sourceClient),
    channel_id: normalizeText(payload.channel_id || payload.channelId),
    endpoint_id: normalizeText(payload.endpoint_id || payload.endpointId),
    thread_id: normalizeText(payload.thread_id || payload.threadId),
    source_path: normalizeText(payload.source_path || payload.sourcePath),
  };
  const routingText = [tags.join(" "), entities.join(" "), aliases.join(" "), storylineId, memoryFamily].join(" ");
  const keywords = tokenize([title, summary, bodyMarkdown.slice(0, 400), routingText].join(" "));
  const ngrams = charNgrams([title, summary, bodyMarkdown.slice(0, 400), routingText].join(" "));
  const storageStrength = floatOrNull(
    payload.storage_strength
      ?? payload.storageStrength
      ?? payload.storage_strength_ref
      ?? payload.storageStrengthRef
      ?? payload.repeat_weight
      ?? payload.repeatWeight
      ?? parseStorageHint(tags)
      ?? 1,
  ) || 1;
  const certaintyState = parseCertaintyHint(tags) || normalizeCertaintyState(payload.certainty_state || payload.certaintyState);
  const pinned = parsePinnedHint(tags, payload);
  const storageBoost = floatOrNull(payload.storage_boost ?? payload.storageBoost) || 1;
  const desirableDifficultyHits = intOrZero(payload.desirable_difficulty_hits ?? payload.desirableDifficultyHits);
  const recallCount = intOrZero(payload.recall_count ?? payload.recallCount);
  const writeCount = Math.max(1, intOrZero((payload.write_count ?? payload.writeCount) || 1));
  const createdAt = normalizeIso(payload.created_at || payload.createdAt) || now;
  const updatedAt = normalizeIso(payload.updated_at || payload.updatedAt) || now;
  const lastAccessedAt = normalizeIso(payload.last_accessed_at || payload.lastAccessedAt) || accessLog[accessLog.length - 1] || updatedAt;
  return {
    material_id: materialId,
    title,
    material_type: materialType,
    summary,
    body_markdown: bodyMarkdown,
    tags,
    entities,
    aliases,
    storyline_id: storylineId,
    memory_family: memoryFamily,
    provenance_refs: provenanceRefs,
    source,
    keywords,
    ngrams,
    access_log: accessLog,
    storage_strength: storageStrength,
    storage_boost: storageBoost,
    certainty_state: certaintyState,
    pinned,
    desirable_difficulty_hits: desirableDifficultyHits,
    recall_count: recallCount,
    write_count: writeCount,
    created_at: createdAt,
    updated_at: updatedAt,
    last_accessed_at: lastAccessedAt,
  };
}

function materialRelativePath(scope, record) {
  return path.join(...scope.toPathParts(), "materials", `${slugify(record.material_id || record.title || "material")}.md`);
}

function buildMaterialMarkdown(record = {}) {
  const lines = [
    `# ${normalizeText(record.title) || "Untitled"}`,
  ];
  if (normalizeText(record.summary)) {
    lines.push("");
    lines.push(`> ${normalizeText(record.summary)}`);
  }
  if (normalizeText(record.body_markdown)) {
    lines.push("");
    lines.push(String(record.body_markdown).trim());
  }
  lines.push("");
  lines.push("---");
  lines.push(`material_id: ${normalizeText(record.material_id)}`);
  lines.push(`material_type: ${normalizeText(record.material_type) || "memo"}`);
  lines.push(`certainty_state: ${normalizeText(record.certainty_state) || "unknown"}`);
  if (record.pinned === true) {
    lines.push("pinned: true");
  }
  lines.push(`storage_strength: ${Number(record.storage_strength) || 1}`);
  lines.push(`storage_boost: ${Number(record.storage_boost) || 1}`);
  if (Array.isArray(record.tags) && record.tags.length) {
    lines.push(`tags: ${record.tags.join(", ")}`);
  }
  if (Array.isArray(record.entities) && record.entities.length) {
    lines.push(`entities: ${record.entities.join(", ")}`);
  }
  if (Array.isArray(record.aliases) && record.aliases.length) {
    lines.push(`aliases: ${record.aliases.join(", ")}`);
  }
  if (normalizeText(record.storyline_id)) {
    lines.push(`storyline_id: ${normalizeText(record.storyline_id)}`);
  }
  if (normalizeText(record.memory_family)) {
    lines.push(`memory_family: ${normalizeText(record.memory_family)}`);
  }
  if (Array.isArray(record.provenance_refs) && record.provenance_refs.length) {
    lines.push(`provenance_refs: ${record.provenance_refs.join(", ")}`);
  }
  const source = record.source && typeof record.source === "object" ? record.source : {};
  if (normalizeText(source.source_client)) {
    lines.push(`source_client: ${normalizeText(source.source_client)}`);
  }
  if (normalizeText(source.channel_id)) {
    lines.push(`channel_id: ${normalizeText(source.channel_id)}`);
  }
  if (normalizeText(source.endpoint_id)) {
    lines.push(`endpoint_id: ${normalizeText(source.endpoint_id)}`);
  }
  if (normalizeText(source.thread_id)) {
    lines.push(`thread_id: ${normalizeText(source.thread_id)}`);
  }
  if (normalizeText(record.created_at)) {
    lines.push(`created_at: ${normalizeText(record.created_at)}`);
  }
  if (normalizeText(record.updated_at)) {
    lines.push(`updated_at: ${normalizeText(record.updated_at)}`);
  }
  return `${lines.join("\n").trim()}\n`;
}

function tokenize(text) {
  const raw = normalizeText(String(text || "").toLowerCase());
  if (!raw) {
    return [];
  }
  const seen = new Set();
  const output = [];
  raw
    .split(/[\s,，。！？!?:：;；、】【（）()<>《》/\\|]+/u)
    .forEach((part) => {
      const token = part.trim();
      if (token.length >= 2 && !seen.has(token)) {
        seen.add(token);
        output.push(token);
      }
    });
  const cjk = [...raw].filter((char) => char >= "\u4e00" && char <= "\u9fff");
  for (let index = 0; index < cjk.length - 1; index += 1) {
    const bigram = cjk[index] + cjk[index + 1];
    if (!seen.has(bigram)) {
      seen.add(bigram);
      output.push(bigram);
    }
  }
  for (let index = 0; index < cjk.length - 2; index += 1) {
    const trigram = cjk[index] + cjk[index + 1] + cjk[index + 2];
    if (!seen.has(trigram)) {
      seen.add(trigram);
      output.push(trigram);
    }
  }
  return output;
}

function charNgrams(text, size = 2, limit = 240) {
  const raw = String(text || "").toLowerCase().replace(/\s+/g, "").slice(0, limit);
  if (!raw) {
    return [];
  }
  if (raw.length <= size) {
    return [raw];
  }
  const output = [];
  for (let index = 0; index <= raw.length - size; index += 1) {
    output.push(raw.slice(index, index + size));
  }
  return output;
}

function slugify(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "") || "card";
}

function trimText(value, limit = 240) {
  const text = normalizeLineEndings(value).trim();
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function stringList(items, limit = 24) {
  const output = [];
  const seen = new Set();
  const source = Array.isArray(items) ? items : [items];
  source.forEach((item) => {
    const value = normalizeText(item);
    if (!value || seen.has(value)) {
      return;
    }
    seen.add(value);
    output.push(value);
  });
  return output.slice(0, limit);
}

function isoStringList(items, limit = 128) {
  const output = [];
  const seen = new Set();
  const source = Array.isArray(items) ? items : [items];
  source.forEach((item) => {
    const value = normalizeIso(item);
    if (!value || seen.has(value)) {
      return;
    }
    seen.add(value);
    output.push(value);
  });
  return output.slice(0, limit);
}

function parseStorageHint(tags) {
  const source = Array.isArray(tags) ? tags : [];
  for (const raw of source) {
    const text = normalizeText(raw);
    if (!text) {
      continue;
    }
    const match = text.match(/(?:storage[_\s-]*strength|repeat[_\s-]*weight|重复权重|存储强度)\s*[:=：]?\s*(\d+(?:\.\d+)?)/iu);
    if (!match) {
      continue;
    }
    const parsed = floatOrNull(match[1]);
    if (parsed && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function normalizeCertaintyState(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) {
    return "unknown";
  }
  const mapping = {
    anchor: "anchor",
    anchored: "anchor",
    resident_anchor: "anchor",
    "常驻": "anchor",
    "常驻锚点": "anchor",
    "锚点": "anchor",
    settled: "settled",
    stable: "settled",
    confirmed: "settled",
    "定论": "settled",
    "稳定": "settled",
    tentative: "tentative",
    open: "tentative",
    maybe: "tentative",
    "暂定": "tentative",
    "待定": "tentative",
    conflict_open: "conflict_open",
    conflicted: "conflict_open",
    conflict: "conflict_open",
    "冲突": "conflict_open",
    "有张力": "conflict_open",
    unknown: "unknown",
    "未定": "unknown",
    "不明": "unknown",
  };
  const normalized = mapping[text] || "unknown";
  return CERTAINTY_STATES.has(normalized) ? normalized : "unknown";
}

function parseCertaintyHint(tags) {
  const source = Array.isArray(tags) ? tags : [];
  for (const raw of source) {
    const text = normalizeText(raw);
    if (!text) {
      continue;
    }
    const match = text.match(/(?:certainty[_\s-]*state|certainty|确定性|稳态|冲突状态)\s*[:=：]?\s*([\u4e00-\u9fffA-Za-z_]+)/iu);
    if (!match) {
      continue;
    }
    const normalized = normalizeCertaintyState(match[1]);
    if (normalized !== "unknown") {
      return normalized;
    }
  }
  return null;
}

function parsePinnedHint(tags, payload = {}) {
  if (typeof payload?.pinned === "boolean") {
    return payload.pinned;
  }
  if (typeof payload?.pinned === "string") {
    const normalized = normalizeText(payload.pinned).toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  const certaintyState = normalizeCertaintyState(payload?.certainty_state || payload?.certaintyState);
  if (certaintyState === "anchor") {
    return true;
  }
  const source = Array.isArray(tags) ? tags : [];
  for (const raw of source) {
    const text = normalizeText(raw).toLowerCase();
    if (!text) {
      continue;
    }
    if (["pinned", "pin", "resident_anchor", "resident", "常驻", "常驻锚点"].includes(text)) {
      return true;
    }
    const match = text.match(/(?:pinned|pin|resident[_\s-]*anchor|常驻)\s*[:=：]?\s*(true|1|yes|on)/iu);
    if (match) {
      return true;
    }
  }
  return false;
}

function normalizeIso(value) {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return parsed.toISOString();
}

function floatOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function intOrZero(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function normalizeLineEndings(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  MATERIAL_TYPES,
  WarmMemoryScope,
  buildMaterialMarkdown,
  charNgrams,
  materialRelativePath,
  normalizeCertaintyState,
  normalizeMaterialRecord,
  tokenize,
};
