const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KNOWN_STATUSES = new Set(["active", "settled", "archived"]);
const KNOWN_ENTRY_TYPES = new Set([
  "chat_tail",
  "photo",
  "day_note",
  "milestone",
  "reflection",
  "import_summary",
  "artifact",
]);
const TOPOLOGY_REF_KEYS = Object.freeze([
  "people",
  "places",
  "activities",
  "objects",
  "themes",
  "relationship_roots",
  "cold_roots",
  "warm_refs",
  "case_refs",
]);

class EpisodeJournalStore {
  constructor(rootDir, options = {}) {
    this.rootDir = path.resolve(rootDir || path.join(process.cwd(), "episode_journal"));
    this.identity = options.identity || {};
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  upsert(scopedUserId, payload = {}) {
    const scoped = normalizeText(scopedUserId) || normalizeText(payload.scoped_user_id || payload.scopedUserId) || "owner";
    const data = isObject(payload) ? { ...payload } : {};
    let episodeId = safeId(normalizeText(data.episode_id || data.episodeId));
    const existing = episodeId ? this.get(scoped, episodeId) : null;
    if (!episodeId) {
      episodeId = newEpisodeId(data.title);
    }
    const now = new Date().toISOString();
    const merged = normalizeEpisode({
      ...(existing || {}),
      ...data,
      episode_id: episodeId,
      scoped_user_id: scoped,
      created_at: normalizeText(existing?.created_at) || now,
      updated_at: now,
      last_touched_at: normalizeText(data.last_touched_at || data.lastTouchedAt || data.updated_at) || now,
    });
    if (existing) {
      merged.tags = mergeStringLists(existing.tags, data.tags);
      merged.entities = mergeStringLists(existing.entities, data.entities);
      merged.source_refs = mergeStringLists(existing.source_refs, data.source_refs || data.sourceRefs);
      merged.related_track_ids = mergeStringLists(existing.related_track_ids, data.related_track_ids || data.relatedTrackIds);
      merged.topology_refs = mergeTopologyRefs(existing.topology_refs, data.topology_refs || data.topologyRefs);
    }
    fs.mkdirSync(this.episodeDir(scoped, episodeId), { recursive: true });
    fs.writeFileSync(this.episodeFile(scoped, episodeId), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    this.exportMarkdown(scoped, episodeId);
    return this.projectEpisode(scoped, episodeId);
  }

  appendEntry(scopedUserId, episodeId, payload = {}) {
    const scoped = normalizeText(scopedUserId) || "owner";
    const target = safeId(episodeId);
    if (!target) {
      throw new Error("episode_id is required");
    }
    let episode = this.get(scoped, target);
    if (!episode) {
      episode = this.upsert(scoped, { episode_id: target, title: target });
    }
    const entry = normalizeEntry({
      ...(isObject(payload) ? payload : {}),
      entry_id: normalizeText(payload.entry_id || payload.entryId) || newEntryId(),
      episode_id: target,
      scoped_user_id: scoped,
    });
    appendJsonLine(this.entriesFile(scoped, target), entry);
    this.upsert(scoped, {
      ...episode,
      episode_id: target,
      last_touched_at: entry.created_at,
    });
    return entry;
  }

  list(scopedUserId = "", options = {}) {
    const scoped = normalizeText(scopedUserId);
    const query = normalizeText(options.query || options.text);
    const statuses = new Set(stringList(options.statuses).map(normalizeStatus).filter(Boolean));
    const minScore = Math.max(0, Number(options.min_score ?? options.minScore) || 0);
    const roots = scoped
      ? [path.join(this.rootDir, safeId(scoped))]
      : fs.readdirSync(this.rootDir, { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => path.join(this.rootDir, item.name));
    const rows = [];
    for (const scopeDir of roots) {
      if (!fs.existsSync(scopeDir)) {
        continue;
      }
      for (const item of fs.readdirSync(scopeDir, { withFileTypes: true })) {
        if (!item.isDirectory()) {
          continue;
        }
        const record = readJson(path.join(scopeDir, item.name, "episode.json"));
        if (!isObject(record)) {
          continue;
        }
        const normalized = normalizeEpisode(record);
        if (statuses.size && !statuses.has(normalizeStatus(normalized.status))) {
          continue;
        }
        const entries = this.listEntries(normalized.scoped_user_id, normalized.episode_id, { limit: 300 });
        const match = scoreEpisodeMatch(normalized, query, { entries });
        const score = Number(match.score) || 0;
        if (query && score <= minScore) {
          continue;
        }
        rows.push({ ...normalized, query_score: score, matched_entries: match.matched_entries || [] });
      }
    }
    rows.sort((a, b) => compareEpisodeRows(a, b));
    const limit = Math.max(1, Math.min(Number(options.limit) || 20, 200));
    return rows.slice(0, limit).map((item) => ({
      ...this.projectEpisode(item.scoped_user_id, item.episode_id),
      query_score: item.query_score,
      matched_entries: item.matched_entries || [],
    }));
  }

  get(scopedUserId, episodeId, options = {}) {
    const scoped = normalizeText(scopedUserId);
    const target = safeId(episodeId);
    if (!scoped || !target) {
      return null;
    }
    const record = readJson(this.episodeFile(scoped, target));
    if (!isObject(record)) {
      return null;
    }
    const projected = this.projectEpisode(scoped, target);
    if (options.includeEntries || options.include_entries) {
      projected.entries = this.listEntries(scoped, target, { limit: options.limit || 500 });
    }
    return projected;
  }

  listEntries(scopedUserId, episodeId, options = {}) {
    const rows = readJsonLines(this.entriesFile(scopedUserId, episodeId)).map(normalizeEntry);
    rows.sort((a, b) => `${a.happened_at_utc || a.created_at}${a.entry_id}`.localeCompare(`${b.happened_at_utc || b.created_at}${b.entry_id}`));
    const limit = Math.max(1, Math.min(Number(options.limit) || 100, 1000));
    return rows.slice(-limit);
  }

  exportMarkdown(scopedUserId, episodeId) {
    const scoped = normalizeText(scopedUserId);
    const target = safeId(episodeId);
    const episode = this.get(scoped, target);
    if (!episode) {
      return { ok: false, episode_id: target, error: `episode not found: ${target}` };
    }
    const entries = this.listEntries(scoped, target, { limit: 1000 });
    const filePath = this.exportFile(scoped, target);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, renderMarkdown(episode, entries), "utf8");
    return { ok: true, episode_id: target, path: filePath, entry_count: entries.length };
  }

  projectEpisode(scopedUserId, episodeId) {
    const scoped = normalizeText(scopedUserId);
    const target = safeId(episodeId);
    const episode = normalizeEpisode(readJson(this.episodeFile(scoped, target)) || {});
    const entries = this.listEntries(scoped, target, { limit: 1000 });
    const attachmentCount = entries.reduce((sum, entry) => sum + attachmentRefs(entry.attachment_refs).length, 0);
    const topologyCandidate = buildEpisodeTopologyCandidate(episode, entries);
    return {
      ...episode,
      entry_count: entries.length,
      attachment_count: attachmentCount,
      topology_edge_count: topologyCandidate.edge_count,
      topology_candidate: topologyCandidate,
      episode_dir: this.episodeDir(scoped, target),
      markdown_path: this.exportFile(scoped, target),
    };
  }

  episodeDir(scopedUserId, episodeId) {
    return path.join(this.rootDir, safeId(scopedUserId || "owner"), safeId(episodeId));
  }

  episodeFile(scopedUserId, episodeId) {
    return path.join(this.episodeDir(scopedUserId, episodeId), "episode.json");
  }

  entriesFile(scopedUserId, episodeId) {
    return path.join(this.episodeDir(scopedUserId, episodeId), "entries.jsonl");
  }

  exportFile(scopedUserId, episodeId) {
    return path.join(this.episodeDir(scopedUserId, episodeId), "episode.md");
  }
}

function buildEpisodeJournalPacket(store, scopedUserId, options = {}) {
  const hits = store.list(scopedUserId, {
    query: options.query || options.text,
    statuses: options.statuses || ["active", "settled"],
    limit: options.limit || 4,
    minScore: options.minScore ?? options.min_score ?? 4,
  });
  const compactHits = hits.map(compactEpisodeHit);
  const titles = compactHits.slice(0, 3).map((item) => normalizeText(item.title)).filter(Boolean);
  return {
    scope_id: normalizeText(scopedUserId),
    query: normalizeText(options.query || options.text),
    hits: compactHits,
    hit_count: compactHits.length,
    route_tag: compactHits.length ? "episode_journal_hit" : "episode_journal_empty",
    summary: [compactHits.length ? `episodes=${compactHits.length}` : "", ...titles].filter(Boolean).join(" | "),
  };
}

function compactEpisodeHit(item = {}) {
  const topology = isObject(item.topology_refs) ? item.topology_refs : {};
  const compactTopology = {};
  TOPOLOGY_REF_KEYS.forEach((key) => {
    compactTopology[key] = stringList(topology[key]).slice(0, 8);
  });
  return {
    episode_id: normalizeText(item.episode_id),
    scoped_user_id: normalizeText(item.scoped_user_id),
    title: normalizeText(item.title),
    summary: truncateText(normalizeText(item.summary), 360),
    kind: normalizeText(item.kind),
    status: normalizeText(item.status),
    time_range: normalizeTimeRange(item.time_range),
    tags: stringList(item.tags).slice(0, 12),
    entities: stringList(item.entities).slice(0, 16),
    entry_count: Number(item.entry_count) || 0,
    attachment_count: Number(item.attachment_count) || 0,
    topology_edge_count: Number(item.topology_edge_count) || 0,
    topology_refs: compactTopology,
    source_refs: stringList(item.source_refs).slice(0, 6),
    related_track_ids: stringList(item.related_track_ids).slice(0, 8),
    matched_entries: (Array.isArray(item.matched_entries) ? item.matched_entries : []).slice(0, 3).map(compactEntryHit),
    query_score: Number(item.query_score) || 0,
    last_touched_at: normalizeText(item.last_touched_at),
    markdown_path: normalizeText(item.markdown_path),
  };
}

function compactEntryHit(item = {}) {
  return {
    entry_id: normalizeText(item.entry_id),
    entry_type: normalizeText(item.entry_type),
    day_label: normalizeText(item.day_label),
    happened_at_utc: normalizeText(item.happened_at_utc),
    text: truncateText(normalizeText(item.text), 260),
    tags: stringList(item.tags).slice(0, 8),
    source_refs: stringList(item.source_refs).slice(0, 4),
    attachment_refs: attachmentRefs(item.attachment_refs).slice(0, 3),
    query_score: Number(item.query_score) || 0,
  };
}

function normalizeEpisode(row = {}) {
  const now = new Date().toISOString();
  return {
    episode_id: safeId(normalizeText(row.episode_id || row.episodeId)) || newEpisodeId(row.title),
    scoped_user_id: normalizeText(row.scoped_user_id || row.scopedUserId || row.user_id) || "owner",
    title: normalizeText(row.title) || "Untitled episode",
    summary: normalizeText(row.summary),
    kind: normalizeText(row.kind) || "life_event",
    status: normalizeStatus(row.status) || "active",
    time_range: normalizeTimeRange(row.time_range || row.timeRange),
    tags: stringList(row.tags).slice(0, 16),
    entities: stringList(row.entities).slice(0, 24),
    source_refs: stringList(row.source_refs || row.sourceRefs).slice(0, 80),
    related_track_ids: stringList(row.related_track_ids || row.relatedTrackIds).slice(0, 20),
    topology_refs: topologyRefs(row.topology_refs || row.topologyRefs),
    created_at: normalizeText(row.created_at) || now,
    updated_at: normalizeText(row.updated_at) || now,
    last_touched_at: normalizeText(row.last_touched_at || row.updated_at) || now,
  };
}

function normalizeEntry(row = {}) {
  const now = new Date().toISOString();
  return {
    entry_id: normalizeText(row.entry_id || row.entryId) || newEntryId(),
    episode_id: safeId(normalizeText(row.episode_id || row.episodeId)),
    scoped_user_id: normalizeText(row.scoped_user_id || row.scopedUserId) || "owner",
    entry_type: normalizeEntryType(row.entry_type || row.entryType),
    day_label: normalizeText(row.day_label || row.dayLabel),
    happened_at_utc: normalizeText(row.happened_at_utc || row.happenedAtUtc || row.ts_utc || row.timestamp) || now,
    text: normalizeText(row.text || row.summary || row.content),
    mood: stringList(row.mood).slice(0, 8),
    tags: stringList(row.tags).slice(0, 16),
    source: normalizeText(row.source) || "front_chat",
    source_refs: stringList(row.source_refs || row.sourceRefs).slice(0, 80),
    attachment_refs: attachmentRefs(row.attachment_refs || row.attachmentRefs),
    topology_refs: topologyRefs(row.topology_refs || row.topologyRefs),
    created_at: normalizeText(row.created_at) || now,
  };
}

function renderMarkdown(episode, entries) {
  const lines = [
    `# ${normalizeText(episode.title) || "Untitled episode"}`,
    "",
    `- episode_id: ${normalizeText(episode.episode_id)}`,
    `- status: ${normalizeText(episode.status)}`,
    `- kind: ${normalizeText(episode.kind)}`,
  ];
  if (normalizeText(episode?.time_range?.label)) {
    lines.push(`- time_range: ${normalizeText(episode.time_range.label)}`);
  }
  if (Array.isArray(episode.tags) && episode.tags.length) {
    lines.push(`- tags: ${episode.tags.join(", ")}`);
  }
  const topologyLines = renderTopologyRefs(episode.topology_refs);
  if (topologyLines.length) {
    lines.push("", "## Topology Refs", "", ...topologyLines);
  }
  if (normalizeText(episode.summary)) {
    lines.push("", "## Summary", "", normalizeText(episode.summary));
  }
  lines.push("", "## Timeline");
  if (!entries.length) {
    lines.push("", "_No entries yet._");
  }
  for (const entry of entries) {
    const title = [entry.day_label, entry.happened_at_utc, entry.entry_type].map(normalizeText).filter(Boolean).join(" · ");
    lines.push("", `### ${title || entry.entry_id}`, "");
    if (normalizeText(entry.text)) {
      lines.push(normalizeText(entry.text));
    }
    const entryTopologyLines = renderTopologyRefs(entry.topology_refs);
    if (entryTopologyLines.length) {
      lines.push("", "Topology:");
      entryTopologyLines.forEach((line) => lines.push(`- ${line}`));
    }
    const refs = attachmentRefs(entry.attachment_refs);
    if (refs.length) {
      lines.push("", "Attachments:");
      for (const ref of refs) {
        const label = normalizeText(ref.caption || ref.description || ref.path || ref.note_path) || "attachment";
        lines.push(`- ${label}`);
        if (normalizeText(ref.path)) {
          lines.push(`  - file: ${normalizeText(ref.path)}`);
        }
        if (normalizeText(ref.note_path)) {
          lines.push(`  - note: ${normalizeText(ref.note_path)}`);
        }
      }
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

function buildEpisodeTopologyCandidate(episode = {}, entries = []) {
  const normalizedEpisode = normalizeEpisode(episode);
  const normalizedEntries = (Array.isArray(entries) ? entries : []).map(normalizeEntry);
  const refs = mergeTopologyRefs(
    normalizedEpisode.topology_refs,
    ...normalizedEntries.map((entry) => entry.topology_refs),
  );
  const episodeId = normalizeText(normalizedEpisode.episode_id);
  const fromRoot = {
    root_key: `episode::${episodeId}`,
    anchor_type: "event",
    canonical_name: normalizeText(normalizedEpisode.title) || episodeId,
    tree_path: `episode/${safeId(episodeId)}`,
  };
  const evidenceRefs = mergeStringLists(
    [`episode_journal:${episodeId}`],
    normalizedEpisode.source_refs,
    normalizedEntries.flatMap((entry) => entry.source_refs || []),
    normalizedEntries.flatMap((entry) => attachmentRefs(entry.attachment_refs).flatMap((ref) => [ref.path, ref.note_path])),
  ).slice(0, 80);
  const relationByKey = {
    people: "with_person",
    places: "visited_place",
    activities: "activity",
    objects: "object_or_symbol",
    themes: "theme",
    relationship_roots: "relationship_context",
    cold_roots: "related_cold_root",
    warm_refs: "related_warm_card",
    case_refs: "related_case",
  };
  const kindByKey = {
    people: "person",
    places: "place",
    activities: "activity",
    objects: "object",
    themes: "theme",
    relationship_roots: "cold_root",
    cold_roots: "cold_root",
    warm_refs: "warm_memory",
    case_refs: "case",
  };
  const edges = [];
  TOPOLOGY_REF_KEYS.forEach((key) => {
    refs[key].forEach((label) => {
      edges.push({
        from_root: fromRoot,
        relation: relationByKey[key] || key,
        to_ref: {
          kind: kindByKey[key] || key,
          label,
          root_key: key.includes("roots") ? label : "",
        },
        evidence_refs: evidenceRefs.slice(0, 24),
        source: "episode_journal",
        status: "candidate",
      });
    });
  });
  return {
    schema: "episode_topology_candidate_v0.1",
    episode_id: episodeId,
    title: normalizeText(normalizedEpisode.title),
    kind: normalizeText(normalizedEpisode.kind),
    status: normalizeText(normalizedEpisode.status),
    from_root: fromRoot,
    refs,
    evidence_refs: evidenceRefs,
    edges,
    edge_count: edges.length,
    guard: "candidate_only_not_cold_truth",
  };
}

function normalizeTimeRange(value) {
  if (!isObject(value)) {
    return { start: "", end: "", label: normalizeText(value) };
  }
  return {
    start: normalizeText(value.start || value.start_utc || value.startUtc),
    end: normalizeText(value.end || value.end_utc || value.endUtc),
    label: normalizeText(value.label),
  };
}

function attachmentRefs(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows.map((item) => {
    if (typeof item === "string") {
      return { path: normalizeText(item), note_path: "", caption: "", description: "" };
    }
    if (!isObject(item)) {
      return null;
    }
    return {
      path: normalizeText(item.path || item.file || item.saved_file || item.savedFile),
      note_path: normalizeText(item.note_path || item.note || item.note_file || item.noteFile),
      caption: normalizeText(item.caption),
      description: normalizeText(item.description || item.summary),
    };
  }).filter((item) => item && (item.path || item.note_path || item.caption || item.description));
}

function scoreEpisode(row, query) {
  return scoreEpisodeMatch(row, query).score;
}

function scoreEpisodeMatch(row, query, { entries = [] } = {}) {
  const q = normalizeText(query).toLowerCase();
  if (!q) {
    return { score: 0, matched_entries: [] };
  }
  const haystack = [
    row.title,
    row.summary,
    row.kind,
    ...(Array.isArray(row.tags) ? row.tags : []),
    ...(Array.isArray(row.entities) ? row.entities : []),
    ...(Array.isArray(row.source_refs) ? row.source_refs : []),
    ...Object.values(topologyRefs(row.topology_refs)).flat(),
  ].map((item) => normalizeText(item).toLowerCase()).join("\n");
  const terms = queryTerms(q);
  let score = scoreHaystack(q, terms, haystack);
  const matchedEntries = [];
  (Array.isArray(entries) ? entries : []).forEach((entry) => {
    const normalizedEntry = normalizeEntry(entry);
    const entryScore = scoreHaystack(q, terms, entrySearchText(normalizedEntry).toLowerCase());
    if (entryScore > 0) {
      matchedEntries.push({ ...normalizedEntry, query_score: entryScore });
      score += Math.min(entryScore, 10);
    }
  });
  matchedEntries.sort((a, b) => {
    const diff = (Number(b.query_score) || 0) - (Number(a.query_score) || 0);
    if (diff) {
      return diff;
    }
    return `${normalizeText(a.happened_at_utc)}${normalizeText(a.entry_id)}`
      .localeCompare(`${normalizeText(b.happened_at_utc)}${normalizeText(b.entry_id)}`);
  });
  return { score, matched_entries: matchedEntries.slice(0, 3) };
}

function scoreHaystack(query, terms, haystack) {
  let score = query && haystack.includes(query) ? 8 : 0;
  terms.forEach((token) => {
    if (haystack.includes(token)) {
      score += 2;
    }
  });
  return score;
}

function entrySearchText(entry = {}) {
  return [
    entry.text,
    entry.entry_type,
    entry.day_label,
    ...stringList(entry.tags),
    ...stringList(entry.source_refs),
    ...Object.values(topologyRefs(entry.topology_refs)).flat(),
    ...attachmentRefs(entry.attachment_refs)
      .map((ref) => normalizeText(ref.caption || ref.description || ref.path || ref.note_path)),
  ].map(normalizeText).filter(Boolean).join("\n");
}

function queryTerms(query) {
  const normalized = normalizeText(query).toLowerCase();
  const terms = new Set(normalized.split(/\s+/u).filter(Boolean));
  const cjkRuns = normalized.match(/[\u4e00-\u9fff]{2,}/gu) || [];
  cjkRuns.forEach((run) => {
    for (let size = 2; size <= Math.min(4, run.length); size += 1) {
      for (let index = 0; index <= run.length - size; index += 1) {
        terms.add(run.slice(index, index + size));
      }
    }
  });
  return Array.from(terms);
}

function compareEpisodeRows(a, b) {
  const scoreDiff = (Number(b.query_score) || 0) - (Number(a.query_score) || 0);
  if (scoreDiff) {
    return scoreDiff;
  }
  return normalizeText(b.last_touched_at).localeCompare(normalizeText(a.last_touched_at));
}

function normalizeStatus(value) {
  const status = normalizeText(value).toLowerCase();
  return KNOWN_STATUSES.has(status) ? status : "";
}

function normalizeEntryType(value) {
  const entryType = normalizeText(value).toLowerCase();
  return KNOWN_ENTRY_TYPES.has(entryType) ? entryType : "chat_tail";
}

function safeId(value) {
  return normalizeText(value).toLowerCase().replace(/[^0-9a-zA-Z\u4e00-\u9fff._-]+/gu, "-").replace(/^[-._]+|[-._]+$/gu, "").slice(0, 96);
}

function newEpisodeId(title = "") {
  const slug = safeId(title).slice(0, 40);
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `episode_${date}_${slug || crypto.randomUUID().slice(0, 8)}`;
}

function newEntryId() {
  return `entry_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function appendJsonLine(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readJsonLines(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)).filter(isObject);
  } catch {
    return [];
  }
}

function stringList(value) {
  const raw = typeof value === "string" ? [value] : (Array.isArray(value) ? value : []);
  const out = [];
  const seen = new Set();
  raw.forEach((item) => {
    const text = normalizeText(isObject(item) ? item.text : item);
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  });
  return out;
}

function mergeStringLists(...values) {
  const out = [];
  values.forEach((value) => {
    stringList(value).forEach((item) => {
      if (!out.includes(item)) {
        out.push(item);
      }
    });
  });
  return out;
}

function topologyRefs(value) {
  const source = isObject(value) ? value : {};
  const aliases = {
    people: ["people", "persons", "person_refs", "personRefs", "participants"],
    places: ["places", "place_refs", "placeRefs", "locations"],
    activities: ["activities", "activity_refs", "activityRefs"],
    objects: ["objects", "object_refs", "objectRefs", "symbols", "symbol_refs", "symbolRefs"],
    themes: ["themes", "theme_refs", "themeRefs"],
    relationship_roots: ["relationship_roots", "relationshipRoots", "relationship_root_refs", "relationshipRootRefs"],
    cold_roots: ["cold_roots", "coldRoots", "cold_root_refs", "coldRootRefs"],
    warm_refs: ["warm_refs", "warmRefs", "warm_memory_refs", "warmMemoryRefs"],
    case_refs: ["case_refs", "caseRefs", "case_ids", "caseIds"],
  };
  const out = {};
  TOPOLOGY_REF_KEYS.forEach((key) => {
    out[key] = mergeStringLists(...(aliases[key] || [key]).map((alias) => source[alias]));
  });
  return out;
}

function mergeTopologyRefs(...values) {
  const out = {};
  TOPOLOGY_REF_KEYS.forEach((key) => {
    out[key] = [];
  });
  values.forEach((value) => {
    const refs = topologyRefs(value);
    TOPOLOGY_REF_KEYS.forEach((key) => {
      out[key] = mergeStringLists(out[key], refs[key]).slice(0, 80);
    });
  });
  return out;
}

function renderTopologyRefs(value) {
  const refs = topologyRefs(value);
  return TOPOLOGY_REF_KEYS
    .map((key) => (refs[key].length ? `- ${key}: ${refs[key].join(", ")}` : ""))
    .filter(Boolean);
}

function truncateText(value, limit = 360) {
  const text = normalizeText(value);
  const max = Math.max(1, Number(limit) || 360);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : (value == null ? "" : String(value).trim());
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  EpisodeJournalStore,
  buildEpisodeJournalPacket,
  buildEpisodeTopologyCandidate,
};
