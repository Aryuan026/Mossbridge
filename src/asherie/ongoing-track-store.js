const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class OngoingTrackStore {
  constructor(activeFilePath, archiveFilePath, maxActiveRecords = 400) {
    this.activeFilePath = path.resolve(activeFilePath);
    this.archiveFilePath = path.resolve(archiveFilePath);
    this.maxActiveRecords = Math.max(50, Number(maxActiveRecords) || 50);
    fs.mkdirSync(path.dirname(this.activeFilePath), { recursive: true });
    fs.mkdirSync(path.dirname(this.archiveFilePath), { recursive: true });
    if (!fs.existsSync(this.activeFilePath)) {
      fs.writeFileSync(this.activeFilePath, "[]\n", "utf8");
    }
  }

  list(scopedUserId = "", {
    query = "",
    statuses = [],
    limit = 20,
  } = {}) {
    const scoped = normalizeText(scopedUserId);
    const normalizedStatuses = normalizeStringList(statuses);
    const rows = this.loadActive()
      .filter((item) => !scoped || normalizeText(item.scoped_user_id) === scoped)
      .filter((item) => !normalizedStatuses.length || normalizedStatuses.includes(normalizeStatus(item.status)))
      .map((item) => normalizeTrack(item));

    const ranked = rows
      .map((item) => ({ item, score: scoreTrack(item, query) }))
      .sort((left, right) => compareTracks(left, right));

    return ranked
      .slice(0, Math.max(1, Math.min(Number(limit) || 20, 200)))
      .map((entry) => ({
        ...entry.item,
        query_score: entry.score,
      }));
  }

  get(scopedUserId = "", trackId = "") {
    const scoped = normalizeText(scopedUserId);
    const target = normalizeText(trackId);
    if (!target) {
      return null;
    }
    return this.loadActive()
      .map((item) => normalizeTrack(item))
      .find((item) => {
        if (normalizeText(item.track_id) !== target) {
          return false;
        }
        if (scoped && normalizeText(item.scoped_user_id) !== scoped) {
          return false;
        }
        return true;
      }) || null;
  }

  upsert(scopedUserId = "", payload = {}) {
    const scoped = normalizeText(scopedUserId);
    if (!scoped) {
      throw new Error("scopedUserId is required");
    }
    const rows = this.loadActive();
    const normalizedPayload = payload && typeof payload === "object" ? payload : {};
    const trackId = normalizeText(normalizedPayload.track_id) || createRecordId("track");
    const existing = rows.find((item) => {
      return normalizeText(item.track_id) === trackId
        && normalizeText(item.scoped_user_id) === scoped;
    }) || null;
    const mergedPayload = mergeTrackPayload(existing, normalizedPayload);
    const next = normalizeTrack({
      ...(existing || {}),
      ...mergedPayload,
      track_id: trackId,
      scoped_user_id: scoped,
      created_at: normalizeText(existing?.created_at) || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_touched_at: normalizeText(normalizedPayload.last_touched_at)
        || normalizeText(normalizedPayload.updated_at)
        || new Date().toISOString(),
    });

    const nextRows = rows.filter((item) => !(
      normalizeText(item.track_id) === trackId
      && normalizeText(item.scoped_user_id) === scoped
    ));
    nextRows.push(next);
    this.saveActive(nextRows);
    return next;
  }

  close(scopedUserId = "", trackId = "", payload = {}) {
    const scoped = normalizeText(scopedUserId);
    const target = normalizeText(trackId);
    if (!scoped || !target) {
      throw new Error("scopedUserId and trackId are required");
    }
    const rows = this.loadActive();
    const existing = rows.find((item) => {
      return normalizeText(item.track_id) === target
        && normalizeText(item.scoped_user_id) === scoped;
    });
    if (!existing) {
      return null;
    }
    const closedAt = new Date().toISOString();
    const normalizedPayload = payload && typeof payload === "object" ? payload : {};
    const mergedPayload = mergeTrackPayload(existing, normalizedPayload);
    const archived = normalizeTrack({
      ...existing,
      ...mergedPayload,
      track_id: target,
      scoped_user_id: scoped,
      status: normalizeStatus(normalizedPayload.status) || "done",
      closure_summary: normalizeText(normalizedPayload.closure_summary || normalizedPayload.closureSummary) || normalizeText(existing.closure_summary),
      afterglow_notes: normalizeText(normalizedPayload.afterglow_notes || normalizedPayload.afterglowNotes) || normalizeText(existing.afterglow_notes),
      updated_at: closedAt,
      last_touched_at: closedAt,
      closed_at: closedAt,
    });
    const nextRows = rows.filter((item) => !(
      normalizeText(item.track_id) === target
      && normalizeText(item.scoped_user_id) === scoped
    ));
    this.saveActive(nextRows);
    this.appendArchive(archived);
    return archived;
  }

  delete(scopedUserId = "", trackId = "") {
    const scoped = normalizeText(scopedUserId);
    const target = normalizeText(trackId);
    const rows = this.loadActive();
    const nextRows = rows.filter((item) => !(
      normalizeText(item.track_id) === target
      && normalizeText(item.scoped_user_id) === scoped
    ));
    if (nextRows.length === rows.length) {
      return false;
    }
    this.saveActive(nextRows);
    return true;
  }

  loadActive() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.activeFilePath, "utf8"));
      return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") : [];
    } catch {
      return [];
    }
  }

  saveActive(rows) {
    const trimmed = Array.isArray(rows) ? rows.slice(-this.maxActiveRecords) : [];
    fs.writeFileSync(this.activeFilePath, `${JSON.stringify(trimmed, null, 2)}\n`, "utf8");
  }

  appendArchive(record = {}) {
    fs.appendFileSync(this.archiveFilePath, `${JSON.stringify(record)}\n`, "utf8");
  }
}

function compareTracks(left, right) {
  if (Boolean(left.item.pinned) !== Boolean(right.item.pinned)) {
    return left.item.pinned ? -1 : 1;
  }
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  const statusDiff = rankStatus(left.item.status) - rankStatus(right.item.status);
  if (statusDiff !== 0) {
    return statusDiff;
  }
  const leftNextCheck = rankTime(left.item.next_check_at);
  const rightNextCheck = rankTime(right.item.next_check_at);
  if (leftNextCheck !== rightNextCheck) {
    return leftNextCheck - rightNextCheck;
  }
  const leftTouched = rankTimeDesc(left.item.last_touched_at || left.item.updated_at);
  const rightTouched = rankTimeDesc(right.item.last_touched_at || right.item.updated_at);
  if (leftTouched !== rightTouched) {
    return leftTouched - rightTouched;
  }
  return String(right.item.updated_at || "").localeCompare(String(left.item.updated_at || ""));
}

function normalizeTrack(track = {}) {
  return {
    track_id: normalizeText(track.track_id) || createRecordId("track"),
    scoped_user_id: normalizeText(track.scoped_user_id),
    title: normalizeText(track.title),
    summary: normalizeText(track.summary),
    kind: normalizeText(track.kind) || "general",
    status: normalizeStatus(track.status) || "active",
    target_window: normalizeText(track.target_window || track.targetWindow),
    why_it_matters: normalizeText(track.why_it_matters || track.whyItMatters),
    next_step: normalizeText(track.next_step || track.nextStep),
    next_check_at: normalizeText(track.next_check_at || track.nextCheckAt),
    closure_summary: normalizeText(track.closure_summary || track.closureSummary),
    afterglow_notes: normalizeText(track.afterglow_notes || track.afterglowNotes),
    tags: normalizeStringList(track.tags),
    related_entities: normalizeStringList(track.related_entities || track.relatedEntities),
    shadow_snippets: normalizeSnippetList(track.shadow_snippets || track.shadowSnippets),
    progress_log: normalizeSnippetList(track.progress_log || track.progressLog),
    source: normalizeText(track.source) || "user",
    source_context: normalizeText(track.source_context || track.sourceContext),
    pinned: Boolean(track.pinned),
    created_at: normalizeText(track.created_at) || new Date().toISOString(),
    updated_at: normalizeText(track.updated_at) || new Date().toISOString(),
    last_touched_at: normalizeText(track.last_touched_at) || normalizeText(track.updated_at) || new Date().toISOString(),
    closed_at: normalizeText(track.closed_at),
  };
}

function normalizeSnippetList(values) {
  return (Array.isArray(values) ? values : [])
    .map((item) => {
      if (item && typeof item === "object") {
        const text = normalizeText(item.text || item.summary || item.snippet);
        if (!text) {
          return null;
        }
        return {
          text,
          ts_utc: normalizeText(item.ts_utc || item.timestamp),
        };
      }
      const text = normalizeText(item);
      return text ? { text, ts_utc: "" } : null;
    })
    .filter(Boolean)
    .slice(-20);
}

function mergeTrackPayload(existing, payload = {}) {
  if (!existing) {
    return payload;
  }
  const next = { ...payload };
  if (Object.prototype.hasOwnProperty.call(payload, "tags")) {
    next.tags = mergeStringLists(existing.tags, payload.tags);
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, "related_entities")
    || Object.prototype.hasOwnProperty.call(payload, "relatedEntities")
  ) {
    next.related_entities = mergeStringLists(
      existing.related_entities || existing.relatedEntities,
      payload.related_entities || payload.relatedEntities,
    );
    delete next.relatedEntities;
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, "shadow_snippets")
    || Object.prototype.hasOwnProperty.call(payload, "shadowSnippets")
  ) {
    next.shadow_snippets = mergeSnippetLists(
      existing.shadow_snippets || existing.shadowSnippets,
      payload.shadow_snippets || payload.shadowSnippets,
    );
    delete next.shadowSnippets;
  }
  if (
    Object.prototype.hasOwnProperty.call(payload, "progress_log")
    || Object.prototype.hasOwnProperty.call(payload, "progressLog")
  ) {
    next.progress_log = mergeSnippetLists(
      existing.progress_log || existing.progressLog,
      payload.progress_log || payload.progressLog,
    );
    delete next.progressLog;
  }
  return next;
}

function mergeStringLists(previous, incoming) {
  const seen = new Set();
  const output = [];
  for (const item of [...normalizeStringList(previous), ...normalizeStringList(incoming)]) {
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    output.push(item);
  }
  return output;
}

function mergeSnippetLists(previous, incoming) {
  const seen = new Set();
  const output = [];
  for (const item of [...normalizeSnippetList(previous), ...normalizeSnippetList(incoming)]) {
    const key = `${normalizeText(item.ts_utc)}\n${normalizeText(item.text)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
  }
  return output.slice(-20);
}

function rankStatus(value) {
  const normalized = normalizeStatus(value);
  if (normalized === "active") {
    return 0;
  }
  if (normalized === "blocked") {
    return 1;
  }
  if (normalized === "paused") {
    return 2;
  }
  return 3;
}

function normalizeStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return "";
  }
  if (["active", "blocked", "paused", "done", "archived"].includes(normalized)) {
    return normalized;
  }
  return normalized;
}

function scoreTrack(track = {}, query = "") {
  const normalizedQuery = normalizeText(query).toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const title = String(track.title || "").toLowerCase();
  const summary = String(track.summary || "").toLowerCase();
  const detail = [
    track.target_window,
    track.why_it_matters,
    track.next_step,
    ...(Array.isArray(track.tags) ? track.tags : []),
    ...(Array.isArray(track.related_entities) ? track.related_entities : []),
    ...(Array.isArray(track.shadow_snippets) ? track.shadow_snippets.map((item) => item?.text) : []),
    ...(Array.isArray(track.progress_log) ? track.progress_log.map((item) => item?.text) : []),
  ].join(" ").toLowerCase();
  let score = 0;
  const targets = [normalizedQuery, ...tokens];
  targets.forEach((token) => {
    if (!token) {
      return;
    }
    if (title.includes(token)) {
      score += 5;
    }
    if (summary.includes(token)) {
      score += 3;
    }
    if (detail.includes(token)) {
      score += 2;
    }
  });
  return score;
}

function rankTime(value) {
  const parsed = parseIso(value);
  if (!parsed) {
    return Number.MAX_SAFE_INTEGER;
  }
  return parsed.getTime();
}

function rankTimeDesc(value) {
  const parsed = parseIso(value);
  if (!parsed) {
    return Number.MAX_SAFE_INTEGER;
  }
  return -parsed.getTime();
}

function parseIso(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(values) {
  return (Array.isArray(values) ? values : [])
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function createRecordId(prefix) {
  if (typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = {
  OngoingTrackStore,
  normalizeTrack,
};
