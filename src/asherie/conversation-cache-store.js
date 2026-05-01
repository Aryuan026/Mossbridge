const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { canonicalScopedUserId, resolveSingleIdentity } = require("./single-identity");

class ConversationCacheStore {
  constructor(rootDir, bucketDays = 10, options = {}) {
    this.rootDir = path.resolve(rootDir);
    this.bucketDays = Math.max(1, Number(bucketDays) || 1);
    this.identity = resolveSingleIdentity(options.identity || {});
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  append(record = {}) {
    const timestamp = parseIso(record.ts_utc) || new Date();
    const scopedUserId = normalizeText(record.scoped_user_id) || canonicalScopedUserId("", this.identity);
    const filePath = this.bucketPath(scopedUserId, timestamp);
    const payload = {
      ...record,
      record_id: normalizeText(record.record_id) || createRecordId("cap"),
      ts_utc: timestamp.toISOString(),
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
    return {
      record_id: payload.record_id,
      path: filePath,
    };
  }

  listRecent(scopedUserId = "", sourceClient = "", limit = 50, includePayload = false) {
    const maxLimit = Math.max(1, Math.min(Number(limit) || 50, 5000));
    const scopedFilter = normalizeText(scopedUserId);
    const sourceFilter = normalizeText(sourceClient).toLowerCase();
    const files = this.iterBucketFiles();
    const matched = [];
    let scanned = 0;

    for (const filePath of files) {
      if (matched.length >= maxLimit) {
        break;
      }
      let lines = [];
      try {
        lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
      } catch {
        continue;
      }
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (matched.length >= maxLimit) {
          break;
        }
        const line = lines[index].trim();
        if (!line) {
          continue;
        }
        let row = null;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        scanned += 1;
        if (scopedFilter && normalizeText(row.scoped_user_id) !== scopedFilter) {
          continue;
        }
        if (sourceFilter && !String(row.source_client || "").toLowerCase().includes(sourceFilter)) {
          continue;
        }
        matched.push(viewRow(row, includePayload));
      }
    }

    return {
      records: matched,
      stats: {
        bucket_files: files.length,
        scanned_records: scanned,
        returned_records: matched.length,
      },
    };
  }

  listTimeWindow(scopedUserId = "", {
    sourceClient = "",
    startUtc = "",
    endUtc = "",
    limit = 12,
    includePayload = false,
    query = "",
  } = {}) {
    const maxLimit = Math.max(1, Math.min(Number(limit) || 12, 200));
    const scopedFilter = normalizeText(scopedUserId);
    const sourceFilter = normalizeText(sourceClient).toLowerCase();
    const start = parseIso(startUtc);
    const end = parseIso(endUtc);
    if (!start || !end) {
      return {
        records: [],
        stats: {
          bucket_files: 0,
          scanned_records: 0,
          returned_records: 0,
        },
      };
    }

    const files = this.iterBucketFiles();
    const matched = [];
    let scanned = 0;

    for (const filePath of files) {
      let lines = [];
      try {
        lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
      } catch {
        continue;
      }
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
          continue;
        }
        let row = null;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        scanned += 1;
        const rowTs = parseIso(row.ts_utc);
        if (!rowTs || rowTs < start || rowTs > end) {
          continue;
        }
        if (scopedFilter && normalizeText(row.scoped_user_id) !== scopedFilter) {
          continue;
        }
        if (sourceFilter && !String(row.source_client || "").toLowerCase().includes(sourceFilter)) {
          continue;
        }
        matched.push({
          row: viewRow(row, includePayload),
          timestamp: rowTs.getTime(),
          score: scoreRowForQuery(row, query),
        });
      }
    }

    matched.sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return right.timestamp - left.timestamp;
    });
    const records = matched
      .slice(0, maxLimit)
      .sort((left, right) => left.timestamp - right.timestamp)
      .map((entry) => entry.row);

    return {
      records,
      stats: {
        bucket_files: files.length,
        scanned_records: scanned,
        returned_records: records.length,
      },
    };
  }

  iterBucketFiles() {
    return fs.readdirSync(this.rootDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(this.rootDir, entry.name))
      .sort((left, right) => {
        const leftStat = fs.statSync(left);
        const rightStat = fs.statSync(right);
        return rightStat.mtimeMs - leftStat.mtimeMs;
      });
  }

  bucketPath(scopedUserId, timestamp) {
    const safeScope = safeName(scopedUserId);
    const range = windowRange(timestamp, this.bucketDays);
    return path.join(
      this.rootDir,
      `${safeScope}__${formatDate(range.start)}_${formatDate(range.end)}.jsonl`,
    );
  }
}

function viewRow(row, includePayload) {
  const base = {
    record_id: row.record_id || "",
    ts_utc: row.ts_utc || "",
    endpoint: row.endpoint || "",
    status: row.status || "",
    error: row.error || "",
    source_client: row.source_client || "",
    source_user_agent: row.source_user_agent || "",
    user_id: row.user_id || "",
    scoped_user_id: row.scoped_user_id || "",
    route_id: row.route_id || "",
    transport_id: row.transport_id || "",
    runtime_id: row.runtime_id || "",
    channel_id: row.channel_id || "",
    endpoint_id: row.endpoint_id || "",
    thread_id: row.thread_id || "",
    model: row.model || "",
    latency_ms: row.latency_ms || 0,
    query: row.query || "",
    assistant_text_final: row.assistant_text_final || "",
    retrieval_mode: row.retrieval_mode || "",
    retrieval_route: Array.isArray(row.retrieval_route) ? row.retrieval_route : [],
    cold_hits_count: row.cold_hits_count ?? row.curated_hits_count ?? 0,
    lite_fallback_hits_count: row.lite_fallback_hits_count || 0,
  };
  if (!includePayload) {
    return base;
  }
  return {
    ...base,
    compressed_digest: row.compressed_digest || "",
    input_guard: row.input_guard || {},
    context_compaction: row.context_compaction || {},
    token_usage: row.token_usage || {},
    system_turn: row.system_turn || {},
      calendar_write: row.calendar_write || {},
      warm_memory: row.warm_memory || {},
      resident_warm: row.resident_warm || {},
      surfacing: row.surfacing || {},
      gateway_events: Array.isArray(row.gateway_events) ? row.gateway_events : [],
      external_chatbox_writeback: row.external_chatbox_writeback || {},
  };
}

function windowRange(timestamp, bucketDays) {
  const dayMs = 24 * 60 * 60 * 1000;
  const utcDay = Date.UTC(
    timestamp.getUTCFullYear(),
    timestamp.getUTCMonth(),
    timestamp.getUTCDate(),
  );
  const epochDay = Math.floor(utcDay / dayMs);
  const windowStartDay = epochDay - (epochDay % bucketDays);
  const start = new Date(windowStartDay * dayMs);
  const end = new Date(start.getTime() + ((bucketDays - 1) * dayMs));
  return { start, end };
}

function formatDate(value) {
  const year = value.getUTCFullYear();
  const month = String(value.getUTCMonth() + 1).padStart(2, "0");
  const day = String(value.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function safeName(text) {
  return String(text || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "") || "default";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseIso(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function createRecordId(prefix) {
  if (typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function scoreRowForQuery(row, query) {
  const terms = extractQueryTerms(query);
  if (!terms.length) {
    return 0;
  }
  const haystack = [
    row.query,
    row.assistant_text_final,
    row.compressed_digest,
  ].map((item) => String(item || "").toLowerCase()).join("\n");
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term.toLowerCase())) {
      score += term.length >= 3 ? 2 : 1;
    }
  }
  return score;
}

function extractQueryTerms(query) {
  const normalized = normalizeText(query)
    .replace(/20\d{2}[年/-]\s*\d{1,2}[月/-]\s*\d{1,2}(?:日|号)?/gu, " ")
    .replace(/\d{1,2}月\d{1,2}(?:日|号)?/gu, " ")
    .replace(/\d{1,2}[/-]\d{1,2}/gu, " ")
    .replace(/(大前天|前天|昨天|今天|刚才|刚刚|早些时候|方才|这两天|这几天|前两天|前几天|最近几天|上周|上星期|上礼拜|上个月|上月|上次|那天|当时|之前|前面)/gu, " ")
    .replace(/[^\p{Script=Han}a-zA-Z0-9]+/gu, " ")
    .trim();
  if (!normalized) {
    return [];
  }
  const seen = new Set();
  const terms = [];
  const stopwords = new Set(["这个", "那个", "一下", "什么", "怎么", "为什么", "是不是", "有没有", "可以", "就是"]);
  for (const chunk of normalized.split(/\s+/)) {
    if (/^[a-zA-Z0-9]{2,}$/.test(chunk) && !seen.has(chunk.toLowerCase())) {
      seen.add(chunk.toLowerCase());
      terms.push(chunk);
      continue;
    }
    if (/^\p{Script=Han}+$/u.test(chunk)) {
      const text = chunk.length <= 4 ? chunk : "";
      if (text && !stopwords.has(text) && !seen.has(text)) {
        seen.add(text);
        terms.push(text);
      }
      if (chunk.length > 4) {
        for (let index = 0; index < chunk.length - 1; index += 1) {
          const term = chunk.slice(index, index + 2);
          if (stopwords.has(term) || seen.has(term)) {
            continue;
          }
          seen.add(term);
          terms.push(term);
          if (terms.length >= 10) {
            return terms;
          }
        }
      }
    }
    if (terms.length >= 10) {
      return terms;
    }
  }
  return terms.slice(0, 10);
}

module.exports = {
  ConversationCacheStore,
};
