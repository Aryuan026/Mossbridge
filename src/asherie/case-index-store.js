const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CASE_STATUSES = new Set(["active", "paused", "blocked", "completed", "archived"]);

class CaseIndexStore {
  constructor(rootDir, options = {}) {
    this.rootDir = path.resolve(rootDir || path.join(process.cwd(), "case_index"));
    this.identity = options.identity || {};
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  upsert(scopedUserId, payload = {}) {
    const scoped = normalizeText(scopedUserId) || normalizeText(payload.scoped_user_id || payload.scopedUserId) || "owner";
    const realmId = safeId(payload.realm_id || payload.realmId || "default");
    const agentId = safeId(payload.agent_id || payload.agentId || "moss");
    const data = isObject(payload) ? { ...payload } : {};
    const existingId = safeId(data.case_id || data.caseId);
    const caseId = existingId || newCaseId(data.title || data.summary || "case");
    const existing = this.get(scoped, caseId, { realmId, agentId }) || null;
    const now = new Date().toISOString();
    const merged = normalizeCase({
      ...(existing || {}),
      ...data,
      case_id: caseId,
      scoped_user_id: scoped,
      owner_id: normalizeText(data.owner_id || data.ownerId || existing?.owner_id || scoped),
      realm_id: realmId,
      agent_id: agentId,
      created_at: normalizeText(existing?.created_at) || now,
      updated_at: now,
      last_touched_at: normalizeText(data.last_touched_at || data.lastTouchedAt || data.updated_at) || now,
    });
    if (existing) {
      merged.tags = mergeStrings(existing.tags, data.tags);
      merged.actions = mergeObjects(existing.actions, data.actions);
      merged.artifacts = mergeObjects(existing.artifacts, data.artifacts);
      merged.changed_files = mergeStrings(existing.changed_files, data.changed_files || data.changedFiles);
      merged.tests = mergeObjects(existing.tests, data.tests);
      merged.decisions = mergeObjects(existing.decisions, data.decisions);
      merged.followups = mergeObjects(existing.followups, data.followups);
      merged.source_refs = mergeStrings(existing.source_refs, data.source_refs || data.sourceRefs);
      merged.related_episode_refs = mergeStrings(existing.related_episode_refs, data.related_episode_refs || data.relatedEpisodeRefs);
      merged.related_track_ids = mergeStrings(existing.related_track_ids, data.related_track_ids || data.relatedTrackIds);
      merged.related_warm_refs = mergeStrings(existing.related_warm_refs, data.related_warm_refs || data.relatedWarmRefs);
    }
    fs.mkdirSync(this.caseDir(scoped, realmId, agentId, caseId), { recursive: true });
    writeJson(this.caseFile(scoped, realmId, agentId, caseId), merged);
    this.exportMarkdown(scoped, caseId, { realmId, agentId });
    return this.projectCase(scoped, realmId, agentId, caseId);
  }

  appendEvent(scopedUserId, caseId, payload = {}) {
    const scoped = normalizeText(scopedUserId) || "owner";
    const realmId = safeId(payload.realm_id || payload.realmId || "default");
    const agentId = safeId(payload.agent_id || payload.agentId || "moss");
    const target = safeId(caseId);
    if (!target) {
      throw new Error("case_id is required");
    }
    let record = this.get(scoped, target, { realmId, agentId });
    if (!record) {
      record = this.upsert(scoped, {
        case_id: target,
        title: target,
        realm_id: realmId,
        agent_id: agentId,
      });
    }
    const event = normalizeEvent({
      ...(isObject(payload) ? payload : {}),
      event_id: normalizeText(payload.event_id || payload.eventId) || newEventId(),
      case_id: target,
      scoped_user_id: scoped,
      realm_id: realmId,
      agent_id: agentId,
    });
    appendJsonLine(this.eventsFile(scoped, realmId, agentId, target), event);
    this.upsert(scoped, {
      ...eventToCasePatch(event),
      case_id: target,
      realm_id: realmId,
      agent_id: agentId,
      last_touched_at: event.created_at,
    });
    return event;
  }

  linkArtifact(scopedUserId, caseId, payload = {}) {
    const artifact = normalizeArtifact(payload);
    const event = this.appendEvent(scopedUserId, caseId, {
      ...payload,
      event_type: "artifact",
      summary: artifact.title || artifact.path || "artifact linked",
      artifacts: [artifact],
    });
    return {
      ok: true,
      artifact,
      event,
      record: this.get(scopedUserId, caseId, payload),
    };
  }

  close(scopedUserId, caseId, payload = {}) {
    const scoped = normalizeText(scopedUserId) || "owner";
    const realmId = safeId(payload.realm_id || payload.realmId || "default");
    const agentId = safeId(payload.agent_id || payload.agentId || "moss");
    const target = safeId(caseId);
    if (!target) {
      throw new Error("case_id is required");
    }
    const existing = this.get(scoped, target, { realmId, agentId });
    if (!existing) {
      return { ok: false, case_id: target, error: `case not found: ${target}` };
    }
    const record = this.upsert(scoped, {
      ...existing,
      case_id: target,
      realm_id: realmId,
      agent_id: agentId,
      status: normalizeStatus(payload.status) || "completed",
      closure_summary: normalizeText(payload.closure_summary || payload.closureSummary) || existing.closure_summary,
      followups: payload.followups || existing.followups,
    });
    this.appendEvent(scoped, target, {
      realm_id: realmId,
      agent_id: agentId,
      event_type: "case_closed",
      summary: record.closure_summary || "case closed",
    });
    return { ok: true, case_id: target, record };
  }

  list(scopedUserId = "", options = {}) {
    const scoped = normalizeText(scopedUserId);
    const query = normalizeText(options.query || options.text);
    const statuses = new Set(stringList(options.statuses).map(normalizeStatus).filter(Boolean));
    const limit = Math.max(1, Math.min(Number(options.limit) || 20, 200));
    const rows = [];
    for (const item of this.iterCases(scoped)) {
      const record = normalizeCase(readJson(item.caseFile) || {});
      if (!record.case_id) {
        continue;
      }
      if (statuses.size && !statuses.has(normalizeStatus(record.status))) {
        continue;
      }
      const score = scoreCase(record, query);
      if (query && score <= 0) {
        continue;
      }
      rows.push({ ...record, query_score: score });
    }
    rows.sort(compareCaseRows);
    return rows.slice(0, limit).map((item) => ({
      ...this.projectCase(item.scoped_user_id, item.realm_id, item.agent_id, item.case_id),
      query_score: item.query_score,
    }));
  }

  get(scopedUserId, caseId, options = {}) {
    const scoped = normalizeText(scopedUserId);
    const target = safeId(caseId);
    if (!scoped || !target) {
      return null;
    }
    const realmId = safeId(options.realm_id || options.realmId || "default");
    const agentId = safeId(options.agent_id || options.agentId || "moss");
    const record = readJson(this.caseFile(scoped, realmId, agentId, target));
    if (!isObject(record)) {
      return null;
    }
    const projected = this.projectCase(scoped, realmId, agentId, target);
    if (options.includeEvents || options.include_events) {
      projected.events = this.listEvents(scoped, target, { realmId, agentId, limit: options.limit || 500 });
    }
    return projected;
  }

  listEvents(scopedUserId, caseId, options = {}) {
    const scoped = normalizeText(scopedUserId);
    const target = safeId(caseId);
    const realmId = safeId(options.realm_id || options.realmId || "default");
    const agentId = safeId(options.agent_id || options.agentId || "moss");
    const rows = readJsonLines(this.eventsFile(scoped, realmId, agentId, target)).map(normalizeEvent);
    rows.sort((a, b) => `${a.created_at}${a.event_id}`.localeCompare(`${b.created_at}${b.event_id}`));
    const limit = Math.max(1, Math.min(Number(options.limit) || 100, 1000));
    return rows.slice(-limit);
  }

  exportMarkdown(scopedUserId, caseId, options = {}) {
    const scoped = normalizeText(scopedUserId);
    const target = safeId(caseId);
    const realmId = safeId(options.realm_id || options.realmId || "default");
    const agentId = safeId(options.agent_id || options.agentId || "moss");
    const record = this.get(scoped, target, { realmId, agentId });
    if (!record) {
      return { ok: false, case_id: target, error: `case not found: ${target}` };
    }
    const events = this.listEvents(scoped, target, { realmId, agentId, limit: 1000 });
    const filePath = this.markdownFile(scoped, realmId, agentId, target);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, renderMarkdown(record, events), "utf8");
    return { ok: true, case_id: target, path: filePath, event_count: events.length };
  }

  projectCase(scopedUserId, realmId, agentId, caseId) {
    const scoped = normalizeText(scopedUserId);
    const realm = safeId(realmId || "default");
    const agent = safeId(agentId || "moss");
    const target = safeId(caseId);
    const record = normalizeCase(readJson(this.caseFile(scoped, realm, agent, target)) || {});
    const events = this.listEvents(scoped, target, { realmId: realm, agentId: agent, limit: 1000 });
    return {
      ...record,
      event_count: events.length,
      case_dir: this.caseDir(scoped, realm, agent, target),
      markdown_path: this.markdownFile(scoped, realm, agent, target),
    };
  }

  iterCases(scopedUserId = "") {
    const roots = [];
    const scoped = safeId(scopedUserId);
    if (scoped) {
      roots.push(path.join(this.rootDir, scoped));
    } else if (fs.existsSync(this.rootDir)) {
      roots.push(...fs.readdirSync(this.rootDir, { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => path.join(this.rootDir, item.name)));
    }
    const rows = [];
    for (const scopeRoot of roots) {
      if (!fs.existsSync(scopeRoot)) {
        continue;
      }
      for (const realm of fs.readdirSync(scopeRoot, { withFileTypes: true }).filter((item) => item.isDirectory())) {
        const realmDir = path.join(scopeRoot, realm.name);
        for (const agent of fs.readdirSync(realmDir, { withFileTypes: true }).filter((item) => item.isDirectory())) {
          const agentDir = path.join(realmDir, agent.name);
          for (const caseDir of fs.readdirSync(agentDir, { withFileTypes: true }).filter((item) => item.isDirectory())) {
            rows.push({
              caseFile: path.join(agentDir, caseDir.name, "case.json"),
            });
          }
        }
      }
    }
    return rows;
  }

  scopeDir(scopedUserId, realmId = "default", agentId = "moss") {
    return path.join(this.rootDir, safeId(scopedUserId || "owner"), safeId(realmId), safeId(agentId));
  }

  caseDir(scopedUserId, realmId, agentId, caseId) {
    return path.join(this.scopeDir(scopedUserId, realmId, agentId), safeId(caseId));
  }

  caseFile(scopedUserId, realmId, agentId, caseId) {
    return path.join(this.caseDir(scopedUserId, realmId, agentId, caseId), "case.json");
  }

  eventsFile(scopedUserId, realmId, agentId, caseId) {
    return path.join(this.caseDir(scopedUserId, realmId, agentId, caseId), "events.jsonl");
  }

  markdownFile(scopedUserId, realmId, agentId, caseId) {
    return path.join(this.caseDir(scopedUserId, realmId, agentId, caseId), "case.md");
  }
}

function normalizeCase(payload = {}) {
  const source = isObject(payload) ? payload : {};
  return {
    case_id: safeId(source.case_id || source.caseId),
    scoped_user_id: normalizeText(source.scoped_user_id || source.scopedUserId),
    owner_id: normalizeText(source.owner_id || source.ownerId),
    realm_id: safeId(source.realm_id || source.realmId || "default"),
    agent_id: safeId(source.agent_id || source.agentId || "moss"),
    title: normalizeText(source.title) || normalizeText(source.case_title || source.caseTitle) || safeId(source.case_id || source.caseId),
    kind: normalizeText(source.kind || source.event_type || source.eventType) || "work_case",
    status: normalizeStatus(source.status) || "active",
    summary: normalizeText(source.summary),
    user_goal: normalizeText(source.user_goal || source.userGoal),
    closure_summary: normalizeText(source.closure_summary || source.closureSummary),
    tags: stringList(source.tags),
    actions: objectList(source.actions).map(normalizeAction),
    artifacts: objectList(source.artifacts).map(normalizeArtifact),
    changed_files: stringList(source.changed_files || source.changedFiles),
    tests: objectList(source.tests).map(normalizeTest),
    decisions: objectList(source.decisions).map(normalizeDecision),
    followups: objectList(source.followups).map(normalizeFollowup),
    source_refs: stringList(source.source_refs || source.sourceRefs),
    related_episode_refs: stringList(source.related_episode_refs || source.relatedEpisodeRefs || source.episode_refs || source.episodeRefs),
    related_track_ids: stringList(source.related_track_ids || source.relatedTrackIds),
    related_warm_refs: stringList(source.related_warm_refs || source.relatedWarmRefs || source.warm_refs || source.warmRefs),
    created_at: normalizeIso(source.created_at || source.createdAt) || new Date().toISOString(),
    updated_at: normalizeIso(source.updated_at || source.updatedAt) || new Date().toISOString(),
    last_touched_at: normalizeIso(source.last_touched_at || source.lastTouchedAt || source.updated_at || source.updatedAt) || new Date().toISOString(),
  };
}

function normalizeEvent(payload = {}) {
  const source = isObject(payload) ? payload : {};
  const now = new Date().toISOString();
  return {
    event_id: normalizeText(source.event_id || source.eventId) || newEventId(),
    case_id: safeId(source.case_id || source.caseId),
    scoped_user_id: normalizeText(source.scoped_user_id || source.scopedUserId),
    realm_id: safeId(source.realm_id || source.realmId || "default"),
    agent_id: safeId(source.agent_id || source.agentId || "moss"),
    event_type: normalizeText(source.event_type || source.eventType) || "note",
    summary: normalizeText(source.summary || source.text || source.note),
    actor: normalizeText(source.actor) || "assistant",
    created_at: normalizeIso(source.created_at || source.createdAt || source.happened_at_utc || source.happenedAtUtc) || now,
    actions: objectList(source.actions).map(normalizeAction),
    artifacts: objectList(source.artifacts).map(normalizeArtifact),
    changed_files: stringList(source.changed_files || source.changedFiles),
    tests: objectList(source.tests).map(normalizeTest),
    decisions: objectList(source.decisions).map(normalizeDecision),
    followups: objectList(source.followups).map(normalizeFollowup),
    source_refs: stringList(source.source_refs || source.sourceRefs),
  };
}

function eventToCasePatch(event = {}) {
  const actions = [...objectList(event.actions)];
  if (normalizeText(event.summary) && !["artifact", "case_closed"].includes(normalizeText(event.event_type))) {
    actions.push({ summary: event.summary, kind: event.event_type || "note", at: event.created_at });
  }
  return {
    actions,
    artifacts: objectList(event.artifacts),
    changed_files: stringList(event.changed_files),
    tests: objectList(event.tests),
    decisions: objectList(event.decisions),
    followups: objectList(event.followups),
    source_refs: stringList(event.source_refs),
  };
}

function normalizeAction(item = {}) {
  const source = isObject(item) ? item : { summary: item };
  return compactObject({
    summary: normalizeText(source.summary || source.text || source.command),
    kind: normalizeText(source.kind || source.type),
    at: normalizeIso(source.at || source.ts_utc || source.timestamp),
  });
}

function normalizeArtifact(item = {}) {
  const source = isObject(item) ? item : { path: item };
  return compactObject({
    artifact_id: normalizeText(source.artifact_id || source.artifactId),
    final_artifact_id: normalizeText(source.final_artifact_id || source.finalArtifactId),
    storage_id: normalizeText(source.storage_id || source.storageId),
    title: normalizeText(source.title || source.name),
    kind: normalizeText(source.kind || source.type) || "file",
    path: normalizeText(source.path || source.file_path || source.filePath || source.url),
    note: normalizeText(source.note || source.description || source.summary),
    status: normalizeText(source.status || source.result),
    checksum: normalizeText(source.checksum || source.hash || source.sha256),
    size_bytes: normalizeInteger(source.size_bytes || source.sizeBytes || source.bytes),
    approved_at: normalizeIso(source.approved_at || source.approvedAt),
    manual_archive_ref: normalizeText(source.manual_archive_ref || source.manualArchiveRef || source.archive_ref || source.archiveRef),
    manual_archive_note: normalizeText(source.manual_archive_note || source.manualArchiveNote || source.archive_note || source.archiveNote),
  });
}

function normalizeTest(item = {}) {
  const source = isObject(item) ? item : { command: item };
  return compactObject({
    command: normalizeText(source.command || source.name),
    status: normalizeText(source.status || source.result),
    note: normalizeText(source.note || source.summary),
  });
}

function normalizeDecision(item = {}) {
  const source = isObject(item) ? item : { summary: item };
  return compactObject({
    summary: normalizeText(source.summary || source.text),
    reason: normalizeText(source.reason || source.why),
    at: normalizeIso(source.at || source.ts_utc || source.timestamp),
  });
}

function normalizeFollowup(item = {}) {
  const source = isObject(item) ? item : { summary: item };
  return compactObject({
    summary: normalizeText(source.summary || source.text || source.next_action || source.nextAction),
    due_at: normalizeIso(source.due_at || source.dueAt),
    status: normalizeText(source.status) || "open",
  });
}

function renderMarkdown(record = {}, events = []) {
  const lines = [
    "---",
    `case_id: ${yamlString(record.case_id)}`,
    `title: ${yamlString(record.title)}`,
    `kind: ${yamlString(record.kind)}`,
    `status: ${yamlString(record.status)}`,
    `owner_id: ${yamlString(record.owner_id)}`,
    `realm_id: ${yamlString(record.realm_id)}`,
    `agent_id: ${yamlString(record.agent_id)}`,
    `created_at: ${yamlString(record.created_at)}`,
    `updated_at: ${yamlString(record.updated_at)}`,
    "tags:",
    ...yamlList(record.tags),
    "---",
    "",
    `# ${record.title || record.case_id}`,
    "",
  ];
  pushSection(lines, "Summary", record.summary);
  pushSection(lines, "User Goal", record.user_goal);
  pushListSection(lines, "Actions", record.actions, (item) => [item.kind, item.summary, item.at].filter(Boolean).join(" | "));
  pushListSection(lines, "Changed Files", record.changed_files, (item) => item);
  pushListSection(lines, "Artifacts", record.artifacts, (item) => [item.status, item.kind, item.storage_id || item.final_artifact_id || item.artifact_id, item.title || item.path, item.note, item.manual_archive_ref].filter(Boolean).join(" | "));
  pushListSection(lines, "Tests", record.tests, (item) => [item.status, item.command, item.note].filter(Boolean).join(" | "));
  pushListSection(lines, "Decisions", record.decisions, (item) => [item.summary, item.reason].filter(Boolean).join(" | "));
  pushListSection(lines, "Followups", record.followups, (item) => [item.status, item.summary, item.due_at].filter(Boolean).join(" | "));
  pushListSection(lines, "Source Refs", record.source_refs, (item) => item);
  if (events.length) {
    lines.push("", "## Events");
    events.forEach((event) => {
      lines.push(`- ${[event.created_at, event.event_type, event.summary].filter(Boolean).join(" | ")}`);
    });
  }
  return `${lines.join("\n").trim()}\n`;
}

function pushSection(lines, title, text) {
  const value = normalizeText(text);
  if (value) {
    lines.push(`## ${title}`, "", value, "");
  }
}

function pushListSection(lines, title, items, render) {
  const source = Array.isArray(items) ? items : [];
  const rows = source.map(render).map(normalizeText).filter(Boolean);
  if (!rows.length) {
    return;
  }
  lines.push(`## ${title}`);
  rows.forEach((row) => lines.push(`- ${row}`));
  lines.push("");
}

function scoreCase(record = {}, query = "") {
  const terms = extractTerms(query);
  if (!terms.length) {
    return 0;
  }
  const haystack = [
    record.case_id,
    record.title,
    record.kind,
    record.summary,
    record.user_goal,
    ...(record.tags || []),
    ...(record.changed_files || []),
    ...(record.source_refs || []),
    ...(record.related_episode_refs || []),
    ...(record.related_track_ids || []),
    ...(record.related_warm_refs || []),
    ...(record.actions || []).map((item) => item.summary),
    ...(record.artifacts || []).flatMap((item) => [item.title, item.path, item.note, item.status, item.artifact_id, item.final_artifact_id, item.storage_id, item.manual_archive_ref, item.manual_archive_note]),
    ...(record.tests || []).flatMap((item) => [item.command, item.status, item.note]),
    ...(record.decisions || []).flatMap((item) => [item.summary, item.reason]),
    ...(record.followups || []).flatMap((item) => [item.summary, item.status]),
  ].join("\n").toLowerCase();
  return terms.reduce((sum, term) => sum + (haystack.includes(term.toLowerCase()) ? Math.max(1, Math.min(4, term.length)) : 0), 0);
}

function compareCaseRows(a = {}, b = {}) {
  const scoreDiff = (Number(b.query_score) || 0) - (Number(a.query_score) || 0);
  if (scoreDiff) {
    return scoreDiff;
  }
  return normalizeText(b.last_touched_at || b.updated_at).localeCompare(normalizeText(a.last_touched_at || a.updated_at));
}

function extractTerms(query = "") {
  const normalized = normalizeText(query)
    .replace(/[^\p{Script=Han}a-zA-Z0-9._/-]+/gu, " ")
    .trim();
  if (!normalized) {
    return [];
  }
  const seen = new Set();
  const terms = [];
  normalized.split(/\s+/u).forEach((chunk) => {
    if (!chunk) {
      return;
    }
    if (/^[a-zA-Z0-9._/-]{2,}$/u.test(chunk)) {
      const key = chunk.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        terms.push(chunk);
      }
      return;
    }
    if (/^\p{Script=Han}+$/u.test(chunk)) {
      if (chunk.length <= 4) {
        if (!seen.has(chunk)) {
          seen.add(chunk);
          terms.push(chunk);
        }
        return;
      }
      for (let index = 0; index < chunk.length - 1 && terms.length < 12; index += 1) {
        const term = chunk.slice(index, index + 2);
        if (!seen.has(term)) {
          seen.add(term);
          terms.push(term);
        }
      }
    }
  });
  return terms.slice(0, 12);
}

function mergeStrings(left, right) {
  const seen = new Set();
  const merged = [];
  [...stringList(left), ...stringList(right)].forEach((item) => {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  });
  return merged;
}

function mergeObjects(left, right) {
  const seen = new Set();
  const merged = [];
  [...objectList(left), ...objectList(right)].forEach((item) => {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  });
  return merged;
}

function objectList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => item !== null && item !== undefined).map((item) => (isObject(item) ? { ...item } : item));
}

function stringList(value) {
  const source = Array.isArray(value) ? value : [value];
  return source.map(normalizeText).filter(Boolean);
}

function compactObject(source = {}) {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => {
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return value !== "" && value !== null && value !== undefined;
  }));
}

function normalizeStatus(value) {
  const normalized = normalizeText(value).toLowerCase();
  return CASE_STATUSES.has(normalized) ? normalized : "";
}

function normalizeIso(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? normalized : parsed.toISOString();
}

function normalizeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : undefined;
}

function safeId(value) {
  return normalizeText(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function newCaseId(title = "case") {
  const slug = safeId(title).slice(0, 40) || "case";
  return `${slug}-${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function newEventId() {
  return `event-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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

function yamlString(value) {
  return JSON.stringify(normalizeText(value));
}

function yamlList(value) {
  const items = stringList(value);
  return items.length ? items.map((item) => `  - ${yamlString(item)}`) : ["  []"];
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : String(value || "").trim();
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

module.exports = {
  CaseIndexStore,
};
