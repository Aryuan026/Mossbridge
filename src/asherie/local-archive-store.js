const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MAX_SNIPPETS_PER_ARCHIVE = 12;

class LocalArchiveStore {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
  }

  upsertWarmMaterial(scope, material = {}, { scopedUserId = "", sourceRecord = null } = {}) {
    ensureScope(scope);
    const materialId = normalizeText(material.material_id || material.materialId);
    if (!materialId) {
      return null;
    }
    const existing = this.readWarmArchive(scope, materialId);
    const now = new Date().toISOString();
    const archive = {
      archive_id: buildArchiveId(materialId),
      archive_kind: "warm_material_archive",
      scoped_user_id: normalizeText(scopedUserId) || normalizeText(existing?.scoped_user_id),
      warm_scope_id: scope.scopeId(),
      material_id: materialId,
      title: normalizeText(material.title) || normalizeText(existing?.title),
      summary: normalizeText(material.summary) || normalizeText(existing?.summary),
      tags: mergeStringLists(existing?.tags, material.tags),
      entities: mergeStringLists(existing?.entities, material.entities),
      aliases: mergeStringLists(existing?.aliases, material.aliases),
      source_archive_refs: mergeStringLists(existing?.source_archive_refs, material.source_archive_refs || material.sourceArchiveRefs),
      source_trace_ids: mergeStringLists(existing?.source_trace_ids, material.source_trace_ids || material.sourceTraceIds),
      source_span_ids: mergeStringLists(existing?.source_span_ids, material.source_span_ids || material.sourceSpanIds),
      source_material_ids: mergeStringLists(existing?.source_material_ids, material.source_material_ids || material.sourceMaterialIds),
      source_backfill_required: material.source_backfill_required === true
        || material.sourceBackfillRequired === true
        || existing?.source_backfill_required === true,
      source_status: normalizeText(material.source_status || material.sourceStatus) || normalizeText(existing?.source_status),
      episode_refs: mergeStringLists(existing?.episode_refs, material.episode_refs || material.episodeRefs),
      case_refs: mergeStringLists(existing?.case_refs, material.case_refs || material.caseRefs),
      material_excerpt: truncateText(
        normalizeText(material.body_markdown || material.bodyMarkdown || material.content || material.summary)
          || normalizeText(existing?.material_excerpt),
        900,
      ),
      created_at: normalizeText(existing?.created_at) || now,
      updated_at: now,
      snippets: Array.isArray(existing?.snippets) ? existing.snippets.slice() : [],
    };
    const snippet = buildSnippet(sourceRecord);
    if (snippet) {
      archive.snippets = mergeSnippets(archive.snippets, [snippet]);
    }
    this.writeWarmArchive(scope, archive);
    return archive;
  }

  upsertTurnEvidence(scope, { scopedUserId = "", record = {}, memoryContextPacket = null } = {}) {
    ensureScope(scope);
    const hits = collectWarmHits(memoryContextPacket).slice(0, 4);
    if (!hits.length) {
      return {
        detected: false,
        count: 0,
        archives: [],
      };
    }
    const snippet = buildSnippet(record);
    if (!snippet) {
      return {
        detected: false,
        count: 0,
        archives: [],
      };
    }
    const archives = [];
    for (const hit of hits) {
      const archive = this.upsertWarmMaterial(scope, hit, { scopedUserId });
      if (!archive) {
        continue;
      }
      archive.snippets = mergeSnippets(archive.snippets, [snippet]);
      archive.updated_at = new Date().toISOString();
      this.writeWarmArchive(scope, archive);
      archives.push(compactArchive(archive));
    }
    return {
      detected: archives.length > 0,
      count: archives.length,
      archives,
    };
  }

  search(scope, { scopedUserId = "", query = "", limit = 2, minScore = 2 } = {}) {
    ensureScope(scope);
    const normalizedQuery = normalizeText(query);
    const resolvedLimit = Math.max(0, Math.min(Number(limit) || 0, 8));
    if (!normalizedQuery || resolvedLimit <= 0) {
      return emptyPacket(scope, normalizedQuery, "local_archive_query_empty");
    }
    const scopedFilter = normalizeText(scopedUserId);
    const archives = this.listWarmArchives(scope)
      .filter((archive) => !scopedFilter || normalizeText(archive.scoped_user_id) === scopedFilter);
    const rows = archives
      .map((archive) => {
        const score = scoreArchive(archive, normalizedQuery);
        return {
          archive,
          score,
          snippet: selectBestSnippet(archive, normalizedQuery),
        };
      })
      .filter((entry) => entry.score >= Math.max(1, Number(minScore) || 1))
      .sort((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        return String(right.archive.updated_at || "").localeCompare(String(left.archive.updated_at || ""));
      });
    const hits = rows.slice(0, resolvedLimit).map(({ archive, score, snippet }) => ({
      archive_id: archive.archive_id,
      archive_kind: archive.archive_kind,
      material_id: archive.material_id,
      title: archive.title,
      summary: archive.summary,
      snippet: formatSnippet(snippet, archive),
      source_record_id: normalizeText(snippet?.source_record_id),
      source_ts_utc: normalizeText(snippet?.ts_utc),
      score,
      tags: stringList(archive.tags),
      entities: stringList(archive.entities),
      source_archive_refs: stringList(archive.source_archive_refs),
      source_trace_ids: stringList(archive.source_trace_ids),
      source_span_ids: stringList(archive.source_span_ids),
      source_material_ids: stringList(archive.source_material_ids),
      source_backfill_required: archive.source_backfill_required === true,
      source_status: normalizeText(archive.source_status),
      episode_refs: stringList(archive.episode_refs),
      case_refs: stringList(archive.case_refs),
    }));
    return {
      ok: true,
      mode: "local_archive_fallback",
      route_tag: hits.length ? "local_archive_hit" : "local_archive_empty",
      scope_id: scope.scopeId(),
      query: normalizedQuery,
      hit_count: hits.length,
      hits,
      stats: {
        scanned_records: archives.length,
      },
    };
  }

  listWarmArchives(scope) {
    ensureScope(scope);
    const dir = this.warmArchiveDir(scope);
    if (!fs.existsSync(dir)) {
      return [];
    }
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, entry.name), "utf8"));
        } catch {
          return null;
        }
      })
      .filter((item) => item && typeof item === "object");
  }

  readWarmArchive(scope, materialId) {
    const filePath = this.warmArchivePath(scope, materialId);
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  writeWarmArchive(scope, archive = {}) {
    const materialId = normalizeText(archive.material_id);
    if (!materialId) {
      throw new Error("material_id is required for local archive");
    }
    const filePath = this.warmArchivePath(scope, materialId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(archive, null, 2)}\n`, "utf8");
  }

  warmArchivePath(scope, materialId) {
    return path.join(this.warmArchiveDir(scope), `${safeName(materialId)}.json`);
  }

  warmArchiveDir(scope) {
    return path.join(this.rootDir, ...scope.toPathParts(), "warm_materials");
  }
}

function collectWarmHits(packet = {}) {
  const memoryPacket = packet && typeof packet === "object" ? packet : {};
  const sources = [
    memoryPacket.warm_memory_packet?.hits,
    memoryPacket.resident_warm_packet?.hits,
  ];
  const seen = new Set();
  const output = [];
  for (const source of sources) {
    for (const item of Array.isArray(source) ? source : []) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const materialId = normalizeText(item.material_id || item.materialId);
      if (!materialId || seen.has(materialId)) {
        continue;
      }
      seen.add(materialId);
      output.push(item);
    }
  }
  return output;
}

function buildSnippet(record = {}) {
  if (!record || typeof record !== "object") {
    return null;
  }
  const query = normalizeText(record.query);
  const assistantText = normalizeText(record.assistant_text_final || record.assistantTextFinal);
  const digest = normalizeText(record.compressed_digest || record.compressedDigest);
  if (!query && !assistantText && !digest) {
    return null;
  }
  return {
    source_record_id: normalizeText(record.record_id || record.recordId) || createRecordId("arcsrc"),
    ts_utc: normalizeText(record.ts_utc || record.tsUtc) || new Date().toISOString(),
    query: truncateText(query, 260),
    assistant_text_final: truncateText(assistantText, 320),
    compressed_digest: truncateText(digest, 320),
  };
}

function mergeSnippets(existing = [], incoming = []) {
  const byKey = new Map();
  for (const snippet of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!snippet || typeof snippet !== "object") {
      continue;
    }
    const key = normalizeText(snippet.source_record_id)
      || `${normalizeText(snippet.ts_utc)}::${normalizeText(snippet.query)}::${normalizeText(snippet.assistant_text_final)}`;
    if (!key) {
      continue;
    }
    byKey.set(key, {
      source_record_id: normalizeText(snippet.source_record_id),
      ts_utc: normalizeText(snippet.ts_utc),
      query: truncateText(snippet.query, 260),
      assistant_text_final: truncateText(snippet.assistant_text_final, 320),
      compressed_digest: truncateText(snippet.compressed_digest, 320),
    });
  }
  return [...byKey.values()]
    .sort((left, right) => String(right.ts_utc || "").localeCompare(String(left.ts_utc || "")))
    .slice(0, MAX_SNIPPETS_PER_ARCHIVE);
}

function scoreArchive(archive = {}, query = "") {
  const terms = extractQueryTerms(query);
  if (!terms.length) {
    return 0;
  }
  const haystack = [
    archive.title,
    archive.summary,
    archive.material_excerpt,
    ...(Array.isArray(archive.tags) ? archive.tags : []),
    ...(Array.isArray(archive.entities) ? archive.entities : []),
    ...(Array.isArray(archive.aliases) ? archive.aliases : []),
    ...(Array.isArray(archive.episode_refs) ? archive.episode_refs : []),
    ...(Array.isArray(archive.case_refs) ? archive.case_refs : []),
    ...(Array.isArray(archive.snippets) ? archive.snippets.flatMap((snippet) => [
      snippet.query,
      snippet.assistant_text_final,
      snippet.compressed_digest,
    ]) : []),
  ].map((item) => String(item || "").toLowerCase()).join("\n");
  let score = 0;
  for (const term of terms) {
    if (!haystack.includes(term.toLowerCase())) {
      continue;
    }
    score += term.length >= 3 ? 2 : 1;
  }
  if (normalizeText(archive.material_excerpt)) {
    score += 0.5;
  }
  if (Array.isArray(archive.snippets) && archive.snippets.length) {
    score += Math.min(1.5, archive.snippets.length * 0.25);
  }
  return score;
}

function selectBestSnippet(archive = {}, query = "") {
  const snippets = Array.isArray(archive.snippets) ? archive.snippets : [];
  if (!snippets.length) {
    return null;
  }
  return snippets
    .map((snippet) => ({
      snippet,
      score: scoreSnippet(snippet, query),
    }))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return String(right.snippet.ts_utc || "").localeCompare(String(left.snippet.ts_utc || ""));
    })[0]?.snippet || null;
}

function scoreSnippet(snippet = {}, query = "") {
  const terms = extractQueryTerms(query);
  const haystack = [snippet.query, snippet.assistant_text_final, snippet.compressed_digest]
    .map((item) => String(item || "").toLowerCase())
    .join("\n");
  return terms.reduce((total, term) => total + (haystack.includes(term.toLowerCase()) ? 1 : 0), 0);
}

function formatSnippet(snippet = null, archive = {}) {
  if (snippet && typeof snippet === "object") {
    const bits = [
      normalizeText(snippet.query) ? `用户: ${truncateText(snippet.query, 90)}` : "",
      normalizeText(snippet.assistant_text_final) ? `你: ${truncateText(snippet.assistant_text_final, 110)}` : "",
      normalizeText(snippet.compressed_digest) && !normalizeText(snippet.assistant_text_final)
        ? truncateText(snippet.compressed_digest, 120)
        : "",
    ].filter(Boolean);
    if (bits.length) {
      return bits.join(" | ");
    }
  }
  return truncateText(normalizeText(archive.material_excerpt || archive.summary), 160);
}

function emptyPacket(scope, query = "", routeTag = "local_archive_empty") {
  return {
    ok: true,
    mode: "local_archive_fallback",
    route_tag: routeTag,
    scope_id: scope.scopeId(),
    query,
    hit_count: 0,
    hits: [],
    stats: {
      scanned_records: 0,
    },
  };
}

function compactArchive(archive = {}) {
  return {
    archive_id: normalizeText(archive.archive_id),
    material_id: normalizeText(archive.material_id),
    title: normalizeText(archive.title),
    snippet_count: Array.isArray(archive.snippets) ? archive.snippets.length : 0,
    updated_at: normalizeText(archive.updated_at),
  };
}

function extractQueryTerms(query) {
  const normalized = normalizeText(query)
    .replace(/20\d{2}[年/-]\s*\d{1,2}[月/-]\s*\d{1,2}(?:日|号)?/gu, " ")
    .replace(/\d{1,2}月\d{1,2}(?:日|号)?/gu, " ")
    .replace(/\d{1,2}[/-]\d{1,2}/gu, " ")
    .replace(/(还记得|记不记得|记得|上次|以前|之前|过去|长期记忆|历史背景|冷记忆|重要的事|什么|怎么|是不是|有没有|可以|就是)/gu, " ")
    .replace(/[^\p{Script=Han}a-zA-Z0-9]+/gu, " ")
    .trim();
  if (!normalized) {
    return [];
  }
  const seen = new Set();
  const terms = [];
  for (const chunk of normalized.split(/\s+/)) {
    if (/^[a-zA-Z0-9]{2,}$/u.test(chunk)) {
      const key = chunk.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        terms.push(chunk);
      }
      continue;
    }
    if (!/^\p{Script=Han}+$/u.test(chunk)) {
      continue;
    }
    if (chunk.length <= 4 && !seen.has(chunk)) {
      seen.add(chunk);
      terms.push(chunk);
    }
    if (chunk.length > 2) {
      for (let index = 0; index < chunk.length - 1; index += 1) {
        const term = chunk.slice(index, index + 2);
        if (!seen.has(term)) {
          seen.add(term);
          terms.push(term);
        }
        if (terms.length >= 12) {
          return terms;
        }
      }
    }
    if (terms.length >= 12) {
      return terms;
    }
  }
  return terms.slice(0, 12);
}

function buildArchiveId(materialId) {
  return `warm_${safeName(materialId)}`;
}

function safeName(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff-]+/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "archive";
}

function stringList(items, limit = 24) {
  const source = Array.isArray(items) ? items : [items];
  const seen = new Set();
  const output = [];
  for (const item of source) {
    const value = normalizeText(item);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
    if (output.length >= limit) {
      break;
    }
  }
  return output;
}

function mergeStringLists(left, right, limit = 24) {
  return stringList([
    ...(Array.isArray(left) ? left : [left]),
    ...(Array.isArray(right) ? right : [right]),
  ], limit);
}

function truncateText(value, limit = 240) {
  const text = normalizeText(value).replace(/\s+/gu, " ");
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function createRecordId(prefix) {
  if (typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function ensureScope(scope) {
  if (!scope || typeof scope.scopeId !== "function" || typeof scope.toPathParts !== "function") {
    throw new Error("LocalArchiveStore expects a warm-memory-like scope");
  }
}

module.exports = {
  LocalArchiveStore,
};
