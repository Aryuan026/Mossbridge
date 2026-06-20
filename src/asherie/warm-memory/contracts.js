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
  const provenanceRefs = stringList(payload.provenance_refs || payload.provenanceRefs || [], 24);
  const sourceArchiveRefs = stringList(payload.source_archive_refs || payload.sourceArchiveRefs || [], 64);
  const sourceTraceIds = stringList(payload.source_trace_ids || payload.sourceTraceIds || [], 64);
  const sourceSpanIds = stringList(payload.source_span_ids || payload.sourceSpanIds || [], 64);
  const sourceMaterialIds = stringList(payload.source_material_ids || payload.sourceMaterialIds || [], 64);
  const hasInlineSourceEvidence = Boolean(normalizeText(
    payload.source_query
      || payload.sourceQuery
      || payload.evidence_query
      || payload.evidenceQuery
      || payload.source_assistant_text
      || payload.sourceAssistantText
      || payload.evidence_assistant_text
      || payload.evidenceAssistantText
      || payload.source_excerpt
      || payload.sourceExcerpt
      || payload.evidence_excerpt
      || payload.evidenceExcerpt
      || payload.source_record_id
      || payload.sourceRecordId,
  ));
  const source = {
    source_client: normalizeText(payload.source_client || payload.sourceClient),
    channel_id: normalizeText(payload.channel_id || payload.channelId),
    endpoint_id: normalizeText(payload.endpoint_id || payload.endpointId),
    thread_id: normalizeText(payload.thread_id || payload.threadId),
    source_path: normalizeText(payload.source_path || payload.sourcePath),
  };
  const hasSourceEvidence = Boolean(
    provenanceRefs.length
      || sourceArchiveRefs.length
      || sourceTraceIds.length
      || sourceSpanIds.length
      || sourceMaterialIds.length
      || hasInlineSourceEvidence
      || source.source_path,
  );
  const explicitSourceBackfillRequired = boolOrNull(payload.source_backfill_required ?? payload.sourceBackfillRequired);
  const sourceBackfillRequired = explicitSourceBackfillRequired === null
    ? !hasSourceEvidence
    : explicitSourceBackfillRequired;
  const explicitDreamingReviewRequired = boolOrNull(payload.dreaming_review_required ?? payload.dreamingReviewRequired);
  const dreamingReviewRequired = explicitDreamingReviewRequired === null
    ? sourceBackfillRequired
    : explicitDreamingReviewRequired;
  const sourceStatus = normalizeText(payload.source_status || payload.sourceStatus)
    || (sourceBackfillRequired ? "pending_backfill" : "bound");
  const memoryLayer = normalizeText(payload.memory_layer || payload.memoryLayer) || "warm_diary";
  const tags = buildWarmMemoryTags(payload.tags || [], {
    memoryLayer,
    sourceBackfillRequired,
    dreamingReviewRequired,
  });
  const entities = stringList(payload.entities || payload.related_entities || payload.relatedEntities || [], 64);
  const aliases = stringList(payload.aliases || payload.entity_aliases || payload.entityAliases || [], 64);
  const storylineId = normalizeText(payload.storyline_id || payload.storylineId);
  const memoryFamily = normalizeText(payload.memory_family || payload.memoryFamily);
  const episodeRefs = stringList(
    payload.episode_refs
      || payload.episodeRefs
      || payload.related_episode_refs
      || payload.relatedEpisodeRefs
      || [],
    24,
  );
  const caseRefs = stringList(
    payload.case_refs
      || payload.caseRefs
      || payload.related_case_refs
      || payload.relatedCaseRefs
      || [],
    24,
  );
  let accessLog = isoStringList(payload.access_log || payload.accessLog || [], 128);
  if (!accessLog.length) {
    accessLog = isoStringList([payload.updated_at || payload.updatedAt || payload.created_at || payload.createdAt || now], 128);
  }
  const routingText = [tags.join(" "), entities.join(" "), aliases.join(" "), storylineId, memoryFamily, episodeRefs.join(" "), caseRefs.join(" ")].join(" ");
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
  const resident = parseResidentHint(tags, payload);
  const residentKind = trimText(
    payload.resident_kind
      || payload.residentKind
      || payload.resident_category
      || payload.residentCategory
      || "",
    80,
  );
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
    memory_layer: memoryLayer,
    entities,
    aliases,
    storyline_id: storylineId,
    memory_family: memoryFamily,
    provenance_refs: provenanceRefs,
    source_archive_refs: sourceArchiveRefs,
    source_trace_ids: sourceTraceIds,
    source_span_ids: sourceSpanIds,
    source_material_ids: sourceMaterialIds,
    source_backfill_required: sourceBackfillRequired,
    dreaming_review_required: dreamingReviewRequired,
    source_status: sourceStatus,
    episode_refs: episodeRefs,
    case_refs: caseRefs,
    source,
    keywords,
    ngrams,
    access_log: accessLog,
    storage_strength: storageStrength,
    storage_boost: storageBoost,
    certainty_state: certaintyState,
    pinned,
    resident,
    resident_kind: residentKind,
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
  lines.push(`memory_layer: ${normalizeText(record.memory_layer) || "warm_diary"}`);
  lines.push(`certainty_state: ${normalizeText(record.certainty_state) || "unknown"}`);
  lines.push(`source_status: ${normalizeText(record.source_status) || "unknown"}`);
  lines.push(`source_backfill_required: ${record.source_backfill_required === true ? "true" : "false"}`);
  lines.push(`dreaming_review_required: ${record.dreaming_review_required === true ? "true" : "false"}`);
  if (record.pinned === true) {
    lines.push("pinned: true");
  }
  if (typeof record.resident === "boolean") {
    lines.push(`resident: ${record.resident ? "true" : "false"}`);
  }
  if (normalizeText(record.resident_kind)) {
    lines.push(`resident_kind: ${normalizeText(record.resident_kind)}`);
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
  if (Array.isArray(record.source_archive_refs) && record.source_archive_refs.length) {
    lines.push(`source_archive_refs: ${record.source_archive_refs.join(", ")}`);
  }
  if (Array.isArray(record.source_trace_ids) && record.source_trace_ids.length) {
    lines.push(`source_trace_ids: ${record.source_trace_ids.join(", ")}`);
  }
  if (Array.isArray(record.source_span_ids) && record.source_span_ids.length) {
    lines.push(`source_span_ids: ${record.source_span_ids.join(", ")}`);
  }
  if (Array.isArray(record.source_material_ids) && record.source_material_ids.length) {
    lines.push(`source_material_ids: ${record.source_material_ids.join(", ")}`);
  }
  if (Array.isArray(record.episode_refs) && record.episode_refs.length) {
    lines.push(`episode_refs: ${record.episode_refs.join(", ")}`);
  }
  if (Array.isArray(record.case_refs) && record.case_refs.length) {
    lines.push(`case_refs: ${record.case_refs.join(", ")}`);
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

function buildWarmMemoryTags(rawTags = [], {
  memoryLayer = "warm_diary",
  sourceBackfillRequired = false,
  dreamingReviewRequired = false,
} = {}) {
  const managed = new Set(["layer:warm_diary", "source:pending", "dreaming:must_review"]);
  const tags = (Array.isArray(rawTags) ? rawTags : [rawTags])
    .filter((tag) => !managed.has(normalizeText(tag).toLowerCase()));
  if (memoryLayer === "warm_diary") {
    tags.push("layer:warm_diary");
  }
  if (sourceBackfillRequired) {
    tags.push("source:pending");
  }
  if (dreamingReviewRequired) {
    tags.push("dreaming:must_review");
  }
  return stringList(tags, 32);
}

function boolOrNull(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = normalizeText(value).toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return null;
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
    if (["pinned", "pin", "resident_anchor", "常驻锚点"].includes(text)) {
      return true;
    }
    const match = text.match(/(?:pinned|pin)\s*[:=：]?\s*(true|1|yes|on|false|0|no|off)/iu);
    if (match) {
      const parsed = booleanOrNull(match[1]);
      if (typeof parsed === "boolean") {
        return parsed;
      }
    }
  }
  return false;
}

function parseResidentHint(tags, payload = {}) {
  const explicitKeys = ["resident", "residentMemory", "resident_memory", "residentWarm", "resident_warm"];
  for (const key of explicitKeys) {
    if (Object.prototype.hasOwnProperty.call(payload || {}, key)) {
      const parsed = booleanOrNull(payload[key]);
      if (typeof parsed === "boolean") {
        return parsed;
      }
    }
  }
  const source = Array.isArray(tags) ? tags : [];
  for (const raw of source) {
    const text = normalizeText(raw).toLowerCase();
    if (!text) {
      continue;
    }
    if (["resident", "resident_anchor", "常驻", "常驻锚点"].includes(text)) {
      return true;
    }
    const match = text.match(/(?:resident|resident[_\s-]*warm|常驻)\s*[:=：]?\s*(true|1|yes|on|false|0|no|off)/iu);
    if (match) {
      const parsed = booleanOrNull(match[1]);
      if (typeof parsed === "boolean") {
        return parsed;
      }
    }
  }
  return null;
}

function booleanOrNull(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = normalizeText(String(value)).toLowerCase();
  if (["true", "1", "yes", "on", "y", "常驻", "是"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off", "n", "否", "不要", "不常驻"].includes(normalized)) {
    return false;
  }
  return null;
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
