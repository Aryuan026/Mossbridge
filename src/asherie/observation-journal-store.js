const fs = require("fs");
const path = require("path");

const ACTIVE_STATUSES = new Set(["active", "tentative"]);
const KNOWN_STATUSES = new Set(["active", "tentative", "corrected", "rejected", "stale", "promoted"]);

class ObservationJournalStore {
  constructor(rootDir, { identity = {} } = {}) {
    this.rootDir = rootDir;
    this.identity = identity || {};
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  append(scopedUserId, args = {}) {
    const observation = normalizeText(args.observation || args.text);
    if (!observation) {
      throw new Error("observation is required");
    }
    const now = new Date();
    const tsUtc = normalizeText(args.ts_utc || args.tsUtc) || now.toISOString();
    const record = {
      observation_id: normalizeText(args.observation_id || args.observationId) || createObservationId(tsUtc),
      ts_utc: tsUtc,
      updated_at_utc: tsUtc,
      observed_at_utc: normalizeText(args.observed_at_utc || args.observedAtUtc || args.observed_at || args.observedAt) || tsUtc,
      period: normalizeText(args.period),
      scoped_user_id: normalizeText(scopedUserId) || normalizeText(args.scoped_user_id || args.scopedUserId) || normalizeText(this.identity.userId) || "owner",
      user_id: normalizeText(args.user_id || args.userId) || normalizeText(this.identity.userId) || "owner",
      realm_id: normalizeText(args.realm_id || args.realmId) || normalizeText(this.identity.realmId) || "default",
      agent_id: normalizeText(args.agent_id || args.agentId) || normalizeText(this.identity.agentId) || "moss",
      kind: normalizeKind(args.kind),
      status: normalizeStatus(args.status) || "tentative",
      confidence: normalizeConfidence(args.confidence, 0.35),
      observation,
      evidence: normalizeStringList(args.evidence || args.evidence_refs || args.evidenceRefs),
      source_refs: normalizeStringList(args.source_refs || args.sourceRefs),
      inference: normalizeText(args.inference),
      suggested_use: normalizeText(args.suggested_use || args.suggestedUse),
      correction_policy: normalizeText(args.correction_policy || args.correctionPolicy)
        || "If the user rejects or corrects this observation, revise it or mark it rejected.",
      tags: normalizeStringList(args.tags).slice(0, 8),
      entities: normalizeStringList(args.entities).slice(0, 8),
      promoted_to: normalizeStringList(args.promoted_to || args.promotedTo),
      corrections: [],
    };
    const filePath = this.filePathForTimestamp(tsUtc);
    appendJsonLine(filePath, record);
    return {
      ok: true,
      scoped_user_id: record.scoped_user_id,
      observation_id: record.observation_id,
      filePath,
      record,
    };
  }

  read(scopedUserId, observationId) {
    const normalizedId = normalizeText(observationId);
    if (!normalizedId) {
      throw new Error("observation_id is required");
    }
    const found = this.findById(scopedUserId, normalizedId);
    return {
      ok: Boolean(found),
      scoped_user_id: normalizeText(scopedUserId),
      observation_id: normalizedId,
      record: found ? { ...found.record } : null,
      filePath: found?.filePath || "",
      error: found ? "" : `observation not found: ${normalizedId}`,
    };
  }

  search(scopedUserId, args = {}) {
    const query = normalizeText(args.query || args.text);
    const includeInactive = args.include_inactive === true || args.includeInactive === true;
    const limit = Math.max(1, Math.min(Number(args.limit) || 8, 50));
    const minScore = Math.max(0, Number(args.min_score ?? args.minScore) || 0);
    const kinds = new Set(normalizeStringList(args.kinds || args.kind ? (args.kinds || [args.kind]) : []));
    const statusFilter = new Set(normalizeStringList(args.statuses || args.status ? (args.statuses || [args.status]) : []));
    const tagFilter = normalizeStringList(args.tags || args.tag ? (args.tags || [args.tag]) : []);
    const records = this.loadRecords()
      .filter(({ record }) => this.matchesScope(record, scopedUserId))
      .filter(({ record }) => includeInactive || ACTIVE_STATUSES.has(normalizeStatus(record.status) || "tentative"))
      .filter(({ record }) => !kinds.size || kinds.has(normalizeKind(record.kind)))
      .filter(({ record }) => !statusFilter.size || statusFilter.has(normalizeStatus(record.status) || "tentative"))
      .filter(({ record }) => !tagFilter.length || tagFilter.some((tag) => normalizeStringList(record.tags).includes(tag)));
    const scored = records
      .map((item) => ({
        ...item,
        score: scoreRecord(item.record, query),
      }))
      .filter((item) => !query || item.score > minScore)
      .sort((left, right) => right.score - left.score || compareTimestampDesc(left.record, right.record))
      .slice(0, limit)
      .map(({ record, score, filePath }) => ({
        observation_id: record.observation_id,
        kind: record.kind,
        status: record.status,
        confidence: record.confidence,
        observation: record.observation,
        inference: record.inference,
        suggested_use: record.suggested_use,
        tags: Array.isArray(record.tags) ? record.tags : [],
        entities: Array.isArray(record.entities) ? record.entities : [],
        ts_utc: record.ts_utc,
        observed_at_utc: record.observed_at_utc,
        updated_at_utc: record.updated_at_utc,
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

  update(scopedUserId, args = {}) {
    const observationId = normalizeText(args.observation_id || args.observationId);
    if (!observationId) {
      throw new Error("observation_id is required");
    }
    const found = this.findById(scopedUserId, observationId);
    if (!found) {
      throw new Error(`observation not found: ${observationId}`);
    }
    const now = new Date().toISOString();
    const previous = { ...found.record };
    const next = { ...found.record, updated_at_utc: now };
    mergeIfText(next, "observation", args.observation || args.text);
    mergeIfText(next, "period", args.period);
    mergeIfText(next, "inference", args.inference);
    mergeIfText(next, "suggested_use", args.suggested_use || args.suggestedUse);
    mergeIfText(next, "correction_policy", args.correction_policy || args.correctionPolicy);
    if ("kind" in args) {
      next.kind = normalizeKind(args.kind);
    }
    if ("status" in args) {
      next.status = normalizeStatus(args.status) || "tentative";
    }
    if ("confidence" in args) {
      next.confidence = normalizeConfidence(args.confidence, next.confidence);
    }
    mergeIfArray(next, "evidence", args.evidence || args.evidence_refs || args.evidenceRefs);
    mergeIfArray(next, "source_refs", args.source_refs || args.sourceRefs);
    mergeIfArray(next, "tags", args.tags);
    mergeIfArray(next, "entities", args.entities);
    mergeIfArray(next, "promoted_to", args.promoted_to || args.promotedTo);
    const correctionNote = normalizeText(args.correction_note || args.correctionNote);
    if (correctionNote) {
      next.corrections = Array.isArray(next.corrections) ? next.corrections.slice() : [];
      next.corrections.push({
        corrected_at_utc: now,
        note: correctionNote,
        previous_status: previous.status,
        previous_observation: previous.observation,
      });
    }
    found.records[found.index] = next;
    writeJsonLines(found.filePath, found.records);
    return {
      ok: true,
      scoped_user_id: normalizeText(scopedUserId),
      observation_id: observationId,
      filePath: found.filePath,
      previous,
      record: next,
    };
  }

  findById(scopedUserId, observationId) {
    const normalizedId = normalizeText(observationId);
    for (const filePath of this.listFiles()) {
      const records = readJsonLines(filePath);
      const index = records.findIndex((record) => {
        return normalizeText(record?.observation_id) === normalizedId && this.matchesScope(record, scopedUserId);
      });
      if (index >= 0) {
        return {
          filePath,
          records,
          index,
          record: records[index],
        };
      }
    }
    return null;
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

function appendJsonLine(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

function writeJsonLines(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = records.map((record) => JSON.stringify(record)).join("\n");
  fs.writeFileSync(filePath, payload ? `${payload}\n` : "", "utf8");
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_error) {
        return null;
      }
    })
    .filter((item) => item && typeof item === "object" && !Array.isArray(item));
}

function scoreRecord(record, query) {
  const normalizedQuery = normalizeText(query).toLowerCase();
  const recency = recencyScore(record.updated_at_utc || record.ts_utc);
  const confidence = Number(record.confidence) || 0;
  if (!normalizedQuery) {
    return recency + confidence;
  }
  const haystack = [
    record.observation,
    record.inference,
    record.suggested_use,
    record.kind,
    ...(Array.isArray(record.evidence) ? record.evidence : []),
    ...(Array.isArray(record.tags) ? record.tags : []),
    ...(Array.isArray(record.entities) ? record.entities : []),
  ].map((item) => normalizeText(item).toLowerCase()).filter(Boolean).join("\n");
  if (!haystack) {
    return 0;
  }
  const intentScore = hasObservationIntent(normalizedQuery) ? 2 : 0;
  let lexicalScore = haystack.includes(normalizedQuery) ? 8 : 0;
  const terms = queryTerms(normalizedQuery);
  terms.forEach((term) => {
    if (haystack.includes(term)) {
      lexicalScore += 2;
    }
  });
  const activationScore = intentScore + lexicalScore;
  if (activationScore <= 0) {
    return 0;
  }
  return activationScore + recency + confidence;
}

function queryTerms(query) {
  const normalized = normalizeText(query).toLowerCase();
  const terms = new Set(normalized.split(/\s+/).filter((token) => token.length >= 2 && /[a-z0-9]/iu.test(token)));
  queryCjkSignalTerms(normalized).forEach((token) => terms.add(token));
  queryExpansionTerms(normalized).forEach((token) => terms.add(token));
  return Array.from(terms);
}

function queryCjkSignalTerms(query) {
  const terms = new Set();
  const stopWordPattern = /(这个|那个|这些|那些|这里|那里|今天|昨天|前天|现在|刚刚|所以|然后|因为|如果|但是|已经|可能|有人|一下|一点|什么|怎么|为什么|还有|还是|就是|觉得|知道|记得|看看|我|你|他|她|它|我们|你们|他们|的|一|是|在|了|有|和|就|都|不|这|那|啊|呀|吗|呢|吧|啦|嘛|哦|哈|呜|嘤|个|们|到|说|想|会|能|可|要|用|给|把|被|让|又|还|很|也|但|才|再|先|去|来|里|中|上|下|前|后|等|着|之|于)/gu;
  const cjkRuns = normalizeText(query).match(/[\u4e00-\u9fff]{2,}/gu) || [];
  cjkRuns.forEach((run) => {
    run.split(stopWordPattern)
      .filter((chunk) => chunk && chunk.length >= 2)
      .forEach((chunk) => {
        if (chunk.length <= 8) {
          terms.add(chunk);
        }
        for (let size = 2; size <= Math.min(4, chunk.length); size += 1) {
          for (let index = 0; index <= chunk.length - size; index += 1) {
            terms.add(chunk.slice(index, index + size));
          }
        }
      });
  });
  return Array.from(terms);
}

function queryExpansionTerms(query) {
  const terms = new Set();
  if (["房梁", "门梁", "横梁", "框架梁", "梁切", "切梁", "破房梁"].some((token) => query.includes(token))) {
    ["梁切割", "切梁", "门框", "水泥门框", "框架梁", "结构验证", "匠心", "美居"].forEach((token) => terms.add(token));
  }
  if (["业主群", "邻居群", "大群", "举报", "内鬼"].some((token) => query.includes(token))) {
    ["业主群", "邻居群", "内鬼", "开发商信息", "结构安全"].forEach((token) => terms.add(token));
  }
  if (["水电", "点位", "底稿", "插座", "布线"].some((token) => query.includes(token))) {
    ["水电定位", "电源点位", "全屋电源", "智能布线", "插座规划", "底稿"].forEach((token) => terms.add(token));
  }
  if (["网购", "电脑", "苹果店", "macbook", "m5 air", "m5 pro"].some((token) => query.includes(token))) {
    ["网购电脑", "苹果店", "macbook", "m5 air", "m5 pro"].forEach((token) => terms.add(token));
  }
  if (["手指", "甲刺", "伤口", "甲沟炎"].some((token) => query.includes(token))) {
    ["手指", "甲刺", "伤口", "甲沟炎", "疼痛"].forEach((token) => terms.add(token));
  }
  return Array.from(terms);
}

function hasObservationIntent(query) {
  return [
    "印象",
    "了解我",
    "适合我",
    "偏好",
    "习惯",
    "边界",
    "节奏",
    "风格",
  ].some((token) => query.includes(token));
}

function recencyScore(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    return 0;
  }
  const ageDays = Math.max(0, (Date.now() - time) / 86400000);
  return Math.max(0, 4 - Math.min(ageDays, 30) / 7.5);
}

function compareTimestampDesc(left = {}, right = {}) {
  return Date.parse(right.updated_at_utc || right.ts_utc || 0) - Date.parse(left.updated_at_utc || left.ts_utc || 0);
}

function createObservationId(tsUtc) {
  const stamp = normalizeText(tsUtc).replace(/[^0-9]/g, "").slice(0, 14) || String(Date.now());
  const suffix = Math.random().toString(36).slice(2, 8);
  return `obs_${stamp}_${suffix}`;
}

function formatMonth(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).format(date);
}

function normalizeKind(value) {
  return normalizeText(value).toLowerCase() || "life_rhythm";
}

function normalizeStatus(value) {
  const status = normalizeText(value).toLowerCase();
  if (!status) {
    return "";
  }
  return KNOWN_STATUSES.has(status) ? status : "tentative";
}

function normalizeConfidence(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return Number(fallback) || 0;
  }
  return Math.max(0, Math.min(number, 1));
}

function normalizeStringList(value) {
  const source = Array.isArray(value) ? value : [value];
  return source
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function mergeIfText(target, key, value) {
  if (typeof value === "string") {
    target[key] = normalizeText(value);
  }
}

function mergeIfArray(target, key, value) {
  if (Array.isArray(value)) {
    target[key] = normalizeStringList(value);
  }
}

module.exports = {
  ObservationJournalStore,
};
