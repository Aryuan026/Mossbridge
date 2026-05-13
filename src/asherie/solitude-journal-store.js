const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KNOWN_ENTRY_TYPES = new Set([
  "reflection",
  "experience",
  "hypothesis",
  "evolution_candidate",
  "capability_request",
  "user_contact_candidate",
  "maintenance_note",
]);

class SolitudeJournalStore {
  constructor(rootDir, { identity = {} } = {}) {
    this.rootDir = rootDir;
    this.identity = identity || {};
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  append(scopedUserId, args = {}) {
    const summary = normalizeText(args.summary || args.title);
    if (!summary) {
      throw new Error("summary is required");
    }
    const now = new Date();
    const tsUtc = normalizeText(args.ts_utc || args.tsUtc) || now.toISOString();
    const record = {
      solitude_id: normalizeText(args.solitude_id || args.solitudeId) || createSolitudeId(tsUtc),
      ts_utc: tsUtc,
      scoped_user_id: normalizeText(scopedUserId) || normalizeText(args.scoped_user_id || args.scopedUserId) || normalizeText(this.identity.userId) || "owner",
      user_id: normalizeText(args.user_id || args.userId) || normalizeText(this.identity.userId) || "owner",
      realm_id: normalizeText(args.realm_id || args.realmId) || normalizeText(this.identity.realmId) || "default",
      agent_id: normalizeText(args.agent_id || args.agentId) || normalizeText(this.identity.agentId) || "moss",
      entry_type: normalizeEntryType(args.entry_type || args.entryType || args.kind),
      wake_context: normalizeText(args.wake_context || args.wakeContext),
      summary,
      reasoning_summary: normalizeText(args.reasoning_summary || args.reasoningSummary || args.reflection),
      evidence: normalizeStringList(args.evidence || args.evidence_refs || args.evidenceRefs),
      lesson: normalizeText(args.lesson || args.experience),
      next_actions: normalizeStringList(args.next_actions || args.nextActions),
      proposed_changes: normalizeStringList(args.proposed_changes || args.proposedChanges),
      contact_user: normalizeText(args.contact_user || args.contactUser || "none") || "none",
      contact_channel: normalizeText(args.contact_channel || args.contactChannel),
      related_case_ids: normalizeStringList(args.related_case_ids || args.relatedCaseIds || args.case_refs || args.caseRefs),
      related_memory_refs: normalizeStringList(args.related_memory_refs || args.relatedMemoryRefs || args.memory_refs || args.memoryRefs),
      tags: normalizeStringList(args.tags).slice(0, 12),
      confidence: normalizeConfidence(args.confidence, 0.45),
      visibility: normalizeText(args.visibility || "backstage") || "backstage",
      chain_of_thought_policy: "Store concise, shareable reasoning summaries only; do not store raw hidden chain-of-thought.",
    };
    const filePath = this.filePathForTimestamp(tsUtc);
    appendJsonLine(filePath, record);
    return {
      ok: true,
      scoped_user_id: record.scoped_user_id,
      solitude_id: record.solitude_id,
      filePath,
      record,
    };
  }

  search(scopedUserId, args = {}) {
    const query = normalizeText(args.query || args.text);
    const limit = Math.max(1, Math.min(Number(args.limit) || 8, 50));
    const typeFilter = new Set(normalizeStringList(args.entry_types || args.entryTypes || args.entry_type || args.entryType));
    const records = this.loadRecords()
      .filter(({ record }) => this.matchesScope(record, scopedUserId))
      .filter(({ record }) => !typeFilter.size || typeFilter.has(normalizeEntryType(record.entry_type)));
    const scored = records
      .map((item) => ({ ...item, score: scoreRecord(item.record, query) }))
      .filter((item) => !query || item.score > 0)
      .sort((left, right) => right.score - left.score || compareTimestampDesc(left.record, right.record))
      .slice(0, limit)
      .map(({ record, score, filePath }) => ({
        solitude_id: record.solitude_id,
        ts_utc: record.ts_utc,
        entry_type: record.entry_type,
        wake_context: record.wake_context,
        summary: record.summary,
        reasoning_summary: record.reasoning_summary,
        lesson: record.lesson,
        next_actions: Array.isArray(record.next_actions) ? record.next_actions : [],
        proposed_changes: Array.isArray(record.proposed_changes) ? record.proposed_changes : [],
        contact_user: record.contact_user,
        contact_channel: record.contact_channel,
        related_case_ids: Array.isArray(record.related_case_ids) ? record.related_case_ids : [],
        tags: Array.isArray(record.tags) ? record.tags : [],
        score,
        filePath,
      }));
    return {
      ok: true,
      scoped_user_id: normalizeText(scopedUserId),
      query,
      count: scored.length,
      total_scanned: records.length,
      hits: scored,
    };
  }

  buildDigest(scopedUserId, args = {}) {
    const query = normalizeText(args.query || args.text);
    const scanLimit = Math.max(1, Math.min(Number(args.scan_limit || args.scanLimit) || 80, 240));
    const recentLimit = Math.max(0, Math.min(Number(args.recent_limit || args.recentLimit) || 2, 8));
    const patternLimit = Math.max(0, Math.min(Number(args.pattern_limit || args.patternLimit) || 4, 12));
    const candidateLimit = Math.max(0, Math.min(Number(args.candidate_limit || args.candidateLimit) || 3, 10));
    const minRepeat = Math.max(2, Math.min(Number(args.min_repeat || args.minRepeat) || 2, 8));
    const records = this.loadRecords()
      .filter(({ record }) => this.matchesScope(record, scopedUserId))
      .sort((left, right) => compareTimestampDesc(left.record, right.record))
      .slice(0, scanLimit);
    const queryMatched = query
      ? records
        .map((item) => ({ ...item, score: scoreRecord(item.record, query) }))
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || compareTimestampDesc(left.record, right.record))
      : [];
    const recentSource = query ? queryMatched : records;
    const recentNotes = recentSource
      .map(({ record, score = 0 }) => compactDigestRecord(record, score))
      .filter((item) => item.summary || item.lesson || item.next_actions.length)
      .slice(0, recentLimit);
    const recurringTags = countListValues(records, (record) => normalizeStringList(record.tags))
      .filter((item) => item.count >= minRepeat)
      .slice(0, patternLimit);
    const recurringLessons = countListValues(records, (record) => [record.lesson])
      .filter((item) => item.count >= minRepeat)
      .slice(0, patternLimit);
    const recurringNextActions = countListValues(records, (record) => normalizeStringList(record.next_actions))
      .filter((item) => item.count >= minRepeat)
      .slice(0, patternLimit);
    const repeatedTags = new Set(recurringTags.map((item) => item.value));
    const promotionCandidates = records
      .map(({ record }) => record)
      .filter((record) => isPromotionCandidate(record, repeatedTags, minRepeat))
      .map((record) => compactDigestRecord(record, 0))
      .slice(0, candidateLimit);
    const hitCount = recentNotes.length
      + recurringTags.length
      + recurringLessons.length
      + recurringNextActions.length
      + promotionCandidates.length;
    return {
      ok: true,
      scoped_user_id: normalizeText(scopedUserId),
      query,
      total_scanned: records.length,
      hit_count: hitCount,
      recent_notes: recentNotes,
      recurring_patterns: {
        tags: recurringTags,
        lessons: recurringLessons,
        next_actions: recurringNextActions,
      },
      promotion_candidates: promotionCandidates,
      summary: [
        recentNotes.length ? `recent=${recentNotes.length}` : "",
        recurringTags.length ? `tags=${recurringTags.length}` : "",
        recurringLessons.length ? `lessons=${recurringLessons.length}` : "",
        promotionCandidates.length ? `candidates=${promotionCandidates.length}` : "",
      ].filter(Boolean).join(" | "),
      policy: "Use this as backstage operating experience only; it is not a front-stage voice rule.",
    };
  }

  loadRecords() {
    return this.listFiles().flatMap((filePath) => {
      return readJsonLines(filePath).map((record) => ({ filePath, record }));
    });
  }

  listFiles() {
    if (!fs.existsSync(this.rootDir)) {
      return [];
    }
    return fs.readdirSync(this.rootDir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .map((name) => path.join(this.rootDir, name));
  }

  filePathForTimestamp(tsUtc) {
    const month = normalizeText(tsUtc).slice(0, 7) || formatMonth(new Date());
    return path.join(this.rootDir, `${month}.jsonl`);
  }

  matchesScope(record, scopedUserId) {
    const expected = normalizeText(scopedUserId);
    if (!expected) {
      return true;
    }
    const actual = normalizeText(record?.scoped_user_id || record?.user_id);
    return !actual || actual === expected;
  }
}

function scoreRecord(record = {}, query = "") {
  const terms = extractTerms(query);
  if (!terms.length) {
    return 0;
  }
  const haystack = [
    record.solitude_id,
    record.entry_type,
    record.wake_context,
    record.summary,
    record.reasoning_summary,
    record.lesson,
    record.contact_user,
    record.contact_channel,
    ...(Array.isArray(record.evidence) ? record.evidence : []),
    ...(Array.isArray(record.next_actions) ? record.next_actions : []),
    ...(Array.isArray(record.proposed_changes) ? record.proposed_changes : []),
    ...(Array.isArray(record.related_case_ids) ? record.related_case_ids : []),
    ...(Array.isArray(record.related_memory_refs) ? record.related_memory_refs : []),
    ...(Array.isArray(record.tags) ? record.tags : []),
  ].join("\n").toLowerCase();
  return terms.reduce((sum, term) => sum + (haystack.includes(term.toLowerCase()) ? Math.max(1, Math.min(4, term.length)) : 0), 0);
}

function compactDigestRecord(record = {}, score = 0) {
  return {
    solitude_id: normalizeText(record.solitude_id),
    ts_utc: normalizeText(record.ts_utc),
    entry_type: normalizeEntryType(record.entry_type),
    wake_context: normalizeText(record.wake_context),
    summary: normalizeText(record.summary),
    lesson: normalizeText(record.lesson),
    next_actions: normalizeStringList(record.next_actions).slice(0, 3),
    proposed_changes: normalizeStringList(record.proposed_changes).slice(0, 3),
    contact_user: normalizeText(record.contact_user || "none") || "none",
    contact_channel: normalizeText(record.contact_channel),
    related_case_ids: normalizeStringList(record.related_case_ids).slice(0, 3),
    related_memory_refs: normalizeStringList(record.related_memory_refs).slice(0, 3),
    tags: normalizeStringList(record.tags).slice(0, 6),
    confidence: normalizeConfidence(record.confidence, 0.45),
    score: Number(score) || 0,
  };
}

function countListValues(items = [], pickValues) {
  const counts = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const record = item?.record || item;
    const values = typeof pickValues === "function" ? pickValues(record) : [];
    for (const rawValue of Array.isArray(values) ? values : [values]) {
      const value = normalizeText(rawValue);
      if (!value) {
        continue;
      }
      const current = counts.get(value) || { value, count: 0, latest_ts_utc: "" };
      current.count += 1;
      const tsUtc = normalizeText(record?.ts_utc);
      if (tsUtc && (!current.latest_ts_utc || tsUtc > current.latest_ts_utc)) {
        current.latest_ts_utc = tsUtc;
      }
      counts.set(value, current);
    }
  }
  return Array.from(counts.values())
    .sort((left, right) => right.count - left.count || normalizeText(right.latest_ts_utc).localeCompare(normalizeText(left.latest_ts_utc)));
}

function isPromotionCandidate(record = {}, repeatedTags = new Set(), minRepeat = 2) {
  const entryType = normalizeEntryType(record.entry_type);
  if (entryType === "evolution_candidate" || entryType === "capability_request") {
    return true;
  }
  const contactUser = normalizeText(record.contact_user);
  if (contactUser && contactUser !== "none") {
    return true;
  }
  const confidence = normalizeConfidence(record.confidence, 0);
  if (confidence < 0.65) {
    return false;
  }
  const tags = normalizeStringList(record.tags);
  const repeatedHitCount = tags.filter((tag) => repeatedTags.has(tag)).length;
  return repeatedHitCount >= Math.min(2, Math.max(1, minRepeat - 1));
}

function extractTerms(query = "") {
  return normalizeText(query)
    .split(/[^a-zA-Z0-9._/-\u4e00-\u9fff]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 16);
}

function normalizeEntryType(value) {
  const normalized = normalizeText(value).toLowerCase();
  return KNOWN_ENTRY_TYPES.has(normalized) ? normalized : "reflection";
}

function normalizeStringList(value) {
  const source = Array.isArray(value) ? value : [value];
  return source.map(normalizeText).filter(Boolean);
}

function normalizeConfidence(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, number));
}

function compareTimestampDesc(left = {}, right = {}) {
  return normalizeText(right.ts_utc).localeCompare(normalizeText(left.ts_utc));
}

function createSolitudeId(tsUtc) {
  const date = normalizeText(tsUtc).slice(0, 10) || new Date().toISOString().slice(0, 10);
  return `solitude-${date}-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

function formatMonth(date) {
  return date.toISOString().slice(0, 7);
}

function appendJsonLine(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(data)}\n`, "utf8");
}

function readJsonLines(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : String(value || "").trim();
}

module.exports = { SolitudeJournalStore };
