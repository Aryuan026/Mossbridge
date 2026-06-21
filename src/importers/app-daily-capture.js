const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { HotScope } = require("../asherie/hot-context-store");

const BUNDLE_SCHEMA = "mossbridge_app_daily_capture_bundle_v0.1";
const STAGED_SCHEMA = "mossbridge_app_daily_capture_v0.1";
const ALLOWED_ROLES = new Set(["user", "assistant", "system", "developer", "tool", "unknown"]);

function validateDailyCaptureTarget(targetPath) {
  const errors = [];
  const normalizedPath = normalizeText(targetPath);
  if (!normalizedPath) {
    return buildResult({ errors: ["target path is required"] });
  }

  const resolvedPath = path.resolve(normalizedPath);
  let stat = null;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    return buildResult({ errors: [`target does not exist: ${resolvedPath}`] });
  }

  if (stat.isDirectory()) {
    return validateDailyCaptureDirectory(resolvedPath);
  }
  if (stat.isFile()) {
    if (!resolvedPath.endsWith(".json")) {
      return buildResult({ errors: [`single-file capture must be a .json file: ${resolvedPath}`] });
    }
    const bundle = readJsonFile(resolvedPath, errors, "bundle");
    if (!bundle) {
      return buildResult({ errors });
    }
    return validateDailyCaptureBundle(bundle, { sourcePath: resolvedPath });
  }
  return buildResult({ errors: [`target is neither a file nor a directory: ${resolvedPath}`] });
}

function loadDailyCaptureTarget(targetPath) {
  const validation = validateDailyCaptureTarget(targetPath);
  if (!validation.ok) {
    return {
      ...validation,
      target_path: "",
      bundle: null,
      manifest: null,
      conversations: [],
      rows: [],
    };
  }

  const resolvedPath = path.resolve(normalizeText(targetPath));
  const stat = fs.statSync(resolvedPath);
  if (stat.isDirectory()) {
    const errors = [];
    const manifest = readJsonFile(path.join(resolvedPath, "manifest.json"), errors, "manifest");
    const rows = readJsonlFile(path.join(resolvedPath, "conversations.jsonl"), errors, "conversations.jsonl");
    return {
      ...validation,
      ok: errors.length === 0,
      errors: [...validation.errors, ...errors],
      target_path: resolvedPath,
      bundle: null,
      manifest,
      conversations: groupRowsIntoConversations(rows, manifest || {}),
      rows,
    };
  }

  const errors = [];
  const bundle = readJsonFile(resolvedPath, errors, "bundle");
  const conversations = normalizeBundleConversations(bundle || {});
  return {
    ...validation,
    ok: errors.length === 0,
    errors: [...validation.errors, ...errors],
    target_path: resolvedPath,
    bundle,
    manifest: null,
    conversations,
    rows: conversations.flatMap((conversation) => conversation.messages),
  };
}

function stageDailyCaptureTarget(targetPath, { appDailyCaptureDir = "" } = {}) {
  const loaded = loadDailyCaptureTarget(targetPath);
  if (!loaded.ok) {
    return {
      ...loaded,
      staged: false,
      staged_dir: "",
    };
  }
  if (loaded.summary.shape === "staged_directory") {
    return {
      ...loaded,
      staged: true,
      wrote: false,
      staged_dir: loaded.target_path,
      stage_ref: buildStageRef(loaded.summary),
    };
  }
  const rootDir = normalizeText(appDailyCaptureDir);
  if (!rootDir) {
    return buildResult({
      errors: ["appDailyCaptureDir is required for staging a capture bundle"],
      summary: loaded.summary,
    });
  }

  const sourceClient = normalizeText(loaded.summary.source_client) || "web_ai";
  const capturedDate = normalizeText(loaded.summary.captured_date) || new Date().toISOString().slice(0, 10);
  const stagedDir = path.join(path.resolve(rootDir), safeName(sourceClient), safeName(capturedDate));
  fs.mkdirSync(stagedDir, { recursive: true });

  const manifest = {
    schema: STAGED_SCHEMA,
    source_client: sourceClient,
    captured_date: capturedDate,
    captured_at: normalizeText(loaded.summary.captured_at) || new Date().toISOString(),
    timezone: normalizeText(loaded.bundle?.timezone),
    exporter: loaded.bundle?.exporter && typeof loaded.bundle.exporter === "object" ? loaded.bundle.exporter : {},
    conversation_count: loaded.conversations.length,
    message_count: loaded.rows.length,
    staged_from: loaded.target_path,
    staged_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(stagedDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(stagedDir, "conversations.jsonl"),
    `${loaded.rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
  if (loaded.bundle) {
    fs.writeFileSync(path.join(stagedDir, "raw-bundle.json"), `${JSON.stringify(loaded.bundle, null, 2)}\n`, "utf8");
  }

  const staged = loadDailyCaptureTarget(stagedDir);
  return {
    ...staged,
    staged: true,
    wrote: true,
    staged_dir: stagedDir,
    stage_ref: buildStageRef(staged.summary),
  };
}

async function importDailyCaptureTarget(targetPath, {
  memoryService,
  memoryMetabolism = null,
  appDailyCaptureDir = "",
  scopeArgs = {},
} = {}) {
  if (!memoryService || typeof memoryService !== "object") {
    throw new Error("memoryService is required");
  }
  if (!memoryService.conversationCache || !memoryService.hotContextStore || !memoryService.hotUpstreamStore) {
    throw new Error("memoryService must expose conversationCache, hotContextStore, and hotUpstreamStore");
  }

  const staged = stageDailyCaptureTarget(targetPath, {
    appDailyCaptureDir: appDailyCaptureDir || memoryService.layout?.appDailyCaptureDir,
  });
  if (!staged.ok) {
    return {
      ...staged,
      imported: false,
    };
  }

  const scopes = typeof memoryService.resolveScopes === "function"
    ? memoryService.resolveScopes(scopeArgs)
    : {};
  const hotScope = typeof memoryService.resolveHotScope === "function"
    ? memoryService.resolveHotScope(scopeArgs)
    : new HotScope({
        ownerId: scopes.coldScope?.owner_id,
        realmId: scopes.coldScope?.realm_id,
        agentId: scopes.coldScope?.agent_id,
      });
  const scopedUserId = normalizeText(scopes.scopedUserId) || "owner";
  const sourceClient = normalizeText(staged.summary.source_client) || "web_ai";
  const stageRef = staged.stage_ref || buildStageRef(staged.summary);

  const stats = {
    conversation_cache_written: 0,
    conversation_cache_skipped: 0,
    hot_turns_written: 0,
    hot_turns_skipped: 0,
    upstream_packages: 0,
    source_events_written: 0,
    source_events_skipped: 0,
    source_events_failed: 0,
    conversation_count: staged.conversations.length,
    message_count: staged.rows.length,
  };
  const warnings = [];
  const headSignals = {
    lastUserAt: "",
    lastAssistantAt: "",
    turnRefs: [],
    openLoops: [],
    activeChannels: [],
    activeThreads: [],
    provenanceRefs: [stageRef],
    projectionSnippets: [],
  };

  for (const conversation of staged.conversations) {
    const rows = conversation.messages.slice().sort(compareMessageRows);
    const endpointId = endpointIdFromUrl(conversation.source_url) || "web_ai_window";
    const threadId = normalizeText(conversation.conversation_id);
    const title = normalizeText(conversation.conversation_title) || threadId || "captured thread";
    const channelId = sourceClient;
    const provenanceRefs = [stageRef, `thread:${threadId}`].filter(Boolean);
    memoryService.hotUpstreamStore.upsertPackage(hotScope, {
      source_client: sourceClient,
      channel_id: channelId,
      endpoint_id: endpointId,
      thread_id: threadId,
      thread_title: title,
      summary: summarizeConversation(conversation),
      recent_messages: rows.slice(-12).map(rowToHotMessage),
      tags: ["web_ai_capture", sourceClient],
      provenance_refs: provenanceRefs,
    });
    noteSourceEventResult(recordCaptureSourceEvent(memoryMetabolism, {
      source_type: "hot_upstream_capture",
      source_id: `${stageRef}:thread:${threadId || title}`,
      source_label: sourceClient,
      object_id: threadId || title,
      action: "upsert_package",
      userId: scopes.resolvedUserId,
      scopedUserId,
      ts_utc: rows[rows.length - 1]?.created_at || staged.summary.captured_at,
      summary: `Captured hot context package: ${title}`,
      content: summarizeConversation(conversation),
      metadata: { stageRef, threadId, title, endpointId, sourceClient },
    }), stats, warnings);
    stats.upstream_packages += 1;
    headSignals.activeChannels.push(channelId);
    if (threadId) {
      headSignals.activeThreads.push(threadId);
    }
    headSignals.provenanceRefs.push(...provenanceRefs);

    for (const row of rows) {
      const turn = memoryService.hotContextStore.appendTurnSlice(hotScope, {
        source_client: sourceClient,
        channel_id: channelId,
        endpoint_id: endpointId,
        thread_id: threadId,
        role: normalizeText(row.role) || "unknown",
        content: messageContent(row),
        attachment_count: Array.isArray(row.attachments) ? row.attachments.length : 0,
        ts_utc: row.created_at,
        provenance_refs: provenanceRefs,
      });
      if (turn.written) {
        stats.hot_turns_written += 1;
      } else {
        stats.hot_turns_skipped += 1;
      }
      if (turn.record?.turn_id) {
        headSignals.turnRefs.push(turn.record.turn_id);
      }
      if (normalizeText(row.role) === "user") {
        headSignals.lastUserAt = maxIso(headSignals.lastUserAt, row.created_at);
      } else if (normalizeText(row.role) === "assistant") {
        headSignals.lastAssistantAt = maxIso(headSignals.lastAssistantAt, row.created_at);
      }
    }

    const pairs = buildConversationPairs(rows);
    for (const pair of pairs) {
      const recordId = buildCaptureRecordId(sourceClient, threadId, pair);
      if (memoryService.conversationCache.hasRecordId(recordId, scopedUserId)) {
        stats.conversation_cache_skipped += 1;
        continue;
      }
      const appended = memoryService.conversationCache.append({
        record_id: recordId,
        ts_utc: pair.user?.created_at || pair.assistant?.created_at || new Date().toISOString(),
        endpoint: "/capture/import",
        status: "ok",
        source_client: sourceClient,
        source_user_agent: exporterName(staged.manifest || staged.bundle || {}),
        user_id: scopes.resolvedUserId || "owner",
        scoped_user_id: scopedUserId,
        route_id: "web_ai_capture_import",
        transport_id: "web_ai_capture",
        runtime_id: "external_ai",
        channel_id: channelId,
        endpoint_id: endpointId,
        thread_id: threadId,
        query: pair.user ? messageContent(pair.user) : "",
        assistant_text_final: pair.assistant ? messageContent(pair.assistant) : "",
        compressed_digest: summarizePair(pair, title),
        system_turn: {
          kind: "web_ai_capture_import",
          stage_ref: stageRef,
          conversation_title: title,
        },
        incoming_messages: pair.user ? [rowToRuntimeMessage(pair.user)] : [],
        outbound_messages: pair.assistant ? [rowToRuntimeMessage(pair.assistant)] : [],
      });
      noteSourceEventResult(recordCaptureSourceEvent(memoryMetabolism, {
        source_type: "app_daily_capture_pair",
        source_id: recordId,
        source_label: sourceClient,
        object_id: threadId,
        action: "append_conversation_pair",
        userId: scopes.resolvedUserId,
        scopedUserId,
        ts_utc: pair.user?.created_at || pair.assistant?.created_at || new Date().toISOString(),
        summary: summarizePair(pair, title),
        content: [
          pair.user ? `user: ${messageContent(pair.user)}` : "",
          pair.assistant ? `assistant: ${messageContent(pair.assistant)}` : "",
        ].filter(Boolean).join("\n"),
        metadata: { stageRef, threadId, title, endpointId, recordPath: appended?.path },
      }), stats, warnings);
      stats.conversation_cache_written += 1;
    }

    const loop = inferOpenLoop(rows, title);
    if (loop) {
      headSignals.openLoops.push(loop);
    }
    const tail = rows.slice(-2).map((row) => `${row.role}: ${truncateText(messageContent(row), 70)}`).join(" / ");
    if (tail) {
      headSignals.projectionSnippets.push(`${sourceClient} | ${title} | ${tail}`);
    }
  }

  const existingHead = memoryService.hotContextStore.loadBasinHead(hotScope);
  const projection = memoryService.hotContextStore.saveProjection(hotScope, {
    projection_id: `hotproj_${hotScope.scopeId()}`,
    summary: buildProjectionSummary(sourceClient, headSignals),
    sources: mergeStringLists(existingHead.active_channels, headSignals.activeChannels, 12),
    open_loops: mergeStringLists(headSignals.openLoops, existingHead.open_loops, 12),
    active_entities: existingHead.active_entities || [],
    active_tasks: existingHead.active_tasks || [],
    sticky_items: headSignals.projectionSnippets.slice(-6),
    recent_turn_refs: mergeStringLists(headSignals.turnRefs.slice(-24), existingHead.recent_turn_refs, 40),
    provenance_refs: mergeStringLists(headSignals.provenanceRefs, existingHead.provenance_refs, 40),
  });
  const basinHead = memoryService.hotContextStore.saveBasinHead(hotScope, {
    ...existingHead,
    last_user_at: maxIso(existingHead.last_user_at, headSignals.lastUserAt),
    last_assistant_at: maxIso(existingHead.last_assistant_at, headSignals.lastAssistantAt),
    open_loops: mergeStringLists(headSignals.openLoops, existingHead.open_loops, 12),
    active_channels: mergeStringLists(headSignals.activeChannels, existingHead.active_channels, 12),
    active_threads: mergeStringLists(headSignals.activeThreads, existingHead.active_threads, 24),
    recent_turn_refs: mergeStringLists(headSignals.turnRefs.slice(-24), existingHead.recent_turn_refs, 40),
    provenance_refs: mergeStringLists(headSignals.provenanceRefs, existingHead.provenance_refs, 40),
    projection_ref: projection.projection_id,
  });

  return {
    ok: true,
    imported: true,
    warnings,
    staged_dir: staged.staged_dir,
    stage_ref: stageRef,
    scope: hotScope.toJSON(),
    stats,
    basin_head: basinHead,
    projection,
  };
}

function validateDailyCaptureBundle(bundle, { sourcePath = "" } = {}) {
  const errors = [];
  const warnings = [];
  const normalized = bundle && typeof bundle === "object" && !Array.isArray(bundle)
    ? bundle
    : null;
  if (!normalized) {
    return buildResult({ errors: ["bundle must be a JSON object"] });
  }

  requireExact(normalized.schema, BUNDLE_SCHEMA, "schema", errors);
  requireText(normalized.source_client, "source_client", errors);
  requireDate(normalized.captured_date, "captured_date", errors);
  requireIso(normalized.captured_at, "captured_at", errors);

  const conversations = Array.isArray(normalized.conversations) ? normalized.conversations : null;
  if (!conversations) {
    errors.push("conversations must be an array");
  }

  const rows = [];
  if (conversations) {
    conversations.forEach((conversation, conversationIndex) => {
      const prefix = `conversations[${conversationIndex}]`;
      if (!conversation || typeof conversation !== "object" || Array.isArray(conversation)) {
        errors.push(`${prefix} must be an object`);
        return;
      }
      const conversationId = requireText(conversation.conversation_id, `${prefix}.conversation_id`, errors);
      const messages = Array.isArray(conversation.messages) ? conversation.messages : null;
      if (!messages) {
        errors.push(`${prefix}.messages must be an array`);
        return;
      }
      messages.forEach((message, messageIndex) => {
        const row = {
          ...message,
          source_client: normalizeText(message?.source_client) || normalizeText(normalized.source_client),
          conversation_id: normalizeText(message?.conversation_id) || conversationId,
          conversation_title: normalizeText(message?.conversation_title) || normalizeText(conversation.conversation_title),
          source_url: normalizeText(message?.source_url) || normalizeText(conversation.source_url),
        };
        validateMessageRow(row, `${prefix}.messages[${messageIndex}]`, errors, warnings);
        rows.push(row);
      });
    });
  }

  return buildResult({
    errors,
    warnings,
    summary: {
      source_path: sourcePath,
      shape: "bundle",
      schema: normalizeText(normalized.schema),
      source_client: normalizeText(normalized.source_client),
      captured_date: normalizeText(normalized.captured_date),
      captured_at: normalizeText(normalized.captured_at),
      conversation_count: conversations ? conversations.length : 0,
      message_count: rows.length,
    },
  });
}

function validateDailyCaptureDirectory(dirPath) {
  const errors = [];
  const warnings = [];
  const manifestPath = path.join(dirPath, "manifest.json");
  const conversationsPath = path.join(dirPath, "conversations.jsonl");
  const manifest = readJsonFile(manifestPath, errors, "manifest");
  const rows = readJsonlFile(conversationsPath, errors, "conversations.jsonl");

  if (manifest) {
    requireExact(manifest.schema, STAGED_SCHEMA, "manifest.schema", errors);
    requireText(manifest.source_client, "manifest.source_client", errors);
    requireDate(manifest.captured_date, "manifest.captured_date", errors);
    requireIso(manifest.captured_at, "manifest.captured_at", errors);
  }

  rows.forEach((row, index) => {
    validateMessageRow(row, `conversations.jsonl:${index + 1}`, errors, warnings);
    if (manifest?.source_client && row?.source_client && normalizeText(row.source_client) !== normalizeText(manifest.source_client)) {
      warnings.push(`conversations.jsonl:${index + 1}.source_client differs from manifest.source_client`);
    }
  });

  if (manifest?.message_count !== undefined && Number(manifest.message_count) !== rows.length) {
    warnings.push(`manifest.message_count is ${manifest.message_count}, but conversations.jsonl has ${rows.length} rows`);
  }

  return buildResult({
    errors,
    warnings,
    summary: {
      source_path: dirPath,
      shape: "staged_directory",
      schema: normalizeText(manifest?.schema),
      source_client: normalizeText(manifest?.source_client),
      captured_date: normalizeText(manifest?.captured_date),
      captured_at: normalizeText(manifest?.captured_at),
      conversation_count: countDistinct(rows.map((row) => normalizeText(row?.conversation_id))),
      message_count: rows.length,
    },
  });
}

function validateMessageRow(row, prefix, errors, warnings) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    errors.push(`${prefix} must be an object`);
    return;
  }

  requireText(row.conversation_id, `${prefix}.conversation_id`, errors);
  const role = normalizeText(row.role);
  if (!role) {
    errors.push(`${prefix}.role is required`);
  } else if (!ALLOWED_ROLES.has(role)) {
    errors.push(`${prefix}.role must be one of ${Array.from(ALLOWED_ROLES).join(", ")}`);
  }
  requireIso(row.created_at, `${prefix}.created_at`, errors);
  if (row.local_date !== undefined && normalizeText(row.local_date)) {
    requireDate(row.local_date, `${prefix}.local_date`, errors);
  }

  const text = normalizeText(row.text);
  const attachments = Array.isArray(row.attachments) ? row.attachments : [];
  if (!text && attachments.length === 0) {
    errors.push(`${prefix} must include text or attachments`);
  }
  if (row.attachments !== undefined && !Array.isArray(row.attachments)) {
    errors.push(`${prefix}.attachments must be an array when provided`);
  }
  if (!normalizeText(row.message_id)) {
    warnings.push(`${prefix}.message_id is recommended for stable deduplication`);
  }
}

function readJsonFile(filePath, errors, label) {
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    errors.push(`${label} file is missing or unreadable: ${filePath}`);
    return null;
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    errors.push(`${label} file is not valid JSON: ${error.message}`);
    return null;
  }
}

function readJsonlFile(filePath, errors, label) {
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    errors.push(`${label} file is missing or unreadable: ${filePath}`);
    return [];
  }
  const rows = [];
  content.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      rows.push(JSON.parse(trimmed));
    } catch (error) {
      errors.push(`${label}:${index + 1} is not valid JSON: ${error.message}`);
    }
  });
  return rows;
}

function requireExact(value, expected, label, errors) {
  const normalized = normalizeText(value);
  if (normalized !== expected) {
    errors.push(`${label} must be ${expected}`);
  }
  return normalized;
}

function requireText(value, label, errors) {
  const normalized = normalizeText(value);
  if (!normalized) {
    errors.push(`${label} is required`);
  }
  return normalized;
}

function requireDate(value, label, errors) {
  const normalized = requireText(value, label, errors);
  if (normalized && !/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    errors.push(`${label} must be YYYY-MM-DD`);
  }
  return normalized;
}

function requireIso(value, label, errors) {
  const normalized = requireText(value, label, errors);
  if (normalized && Number.isNaN(Date.parse(normalized))) {
    errors.push(`${label} must be an ISO timestamp`);
  }
  return normalized;
}

function countDistinct(values) {
  return new Set(values.filter(Boolean)).size;
}

function normalizeBundleConversations(bundle = {}) {
  const sourceClient = normalizeText(bundle.source_client) || "web_ai";
  return (Array.isArray(bundle.conversations) ? bundle.conversations : [])
    .filter((conversation) => conversation && typeof conversation === "object" && !Array.isArray(conversation))
    .map((conversation) => {
      const conversationId = normalizeText(conversation.conversation_id);
      const conversationTitle = normalizeText(conversation.conversation_title);
      const sourceUrl = normalizeText(conversation.source_url);
      const messages = (Array.isArray(conversation.messages) ? conversation.messages : [])
        .filter((message) => message && typeof message === "object" && !Array.isArray(message))
        .map((message) => ({
          ...message,
          source_client: normalizeText(message.source_client) || sourceClient,
          conversation_id: normalizeText(message.conversation_id) || conversationId,
          conversation_title: normalizeText(message.conversation_title) || conversationTitle,
          source_url: normalizeText(message.source_url) || sourceUrl,
        }));
      return {
        conversation_id: conversationId,
        conversation_title: conversationTitle,
        source_url: sourceUrl,
        messages,
      };
    });
}

function groupRowsIntoConversations(rows = [], manifest = {}) {
  const map = new Map();
  for (const rawRow of Array.isArray(rows) ? rows : []) {
    if (!rawRow || typeof rawRow !== "object" || Array.isArray(rawRow)) {
      continue;
    }
    const row = {
      ...rawRow,
      source_client: normalizeText(rawRow.source_client) || normalizeText(manifest.source_client) || "web_ai",
    };
    const conversationId = normalizeText(row.conversation_id) || "unknown_thread";
    if (!map.has(conversationId)) {
      map.set(conversationId, {
        conversation_id: conversationId,
        conversation_title: normalizeText(row.conversation_title),
        source_url: normalizeText(row.source_url),
        messages: [],
      });
    }
    const conversation = map.get(conversationId);
    if (!conversation.conversation_title && normalizeText(row.conversation_title)) {
      conversation.conversation_title = normalizeText(row.conversation_title);
    }
    if (!conversation.source_url && normalizeText(row.source_url)) {
      conversation.source_url = normalizeText(row.source_url);
    }
    conversation.messages.push(row);
  }
  return Array.from(map.values()).map((conversation) => ({
    ...conversation,
    messages: conversation.messages.slice().sort(compareMessageRows),
  }));
}

function buildConversationPairs(rows = []) {
  const pairs = [];
  const sorted = rows.slice().sort(compareMessageRows);
  for (let index = 0; index < sorted.length; index += 1) {
    const row = sorted[index];
    if (normalizeText(row.role) !== "user") {
      continue;
    }
    let assistant = null;
    for (let cursor = index + 1; cursor < sorted.length; cursor += 1) {
      const next = sorted[cursor];
      const role = normalizeText(next.role);
      if (role === "user") {
        break;
      }
      if (role === "assistant") {
        assistant = next;
        break;
      }
    }
    pairs.push({ user: row, assistant });
  }
  return pairs;
}

function compareMessageRows(left, right) {
  const leftTime = Date.parse(left?.created_at || left?.timestamp || "");
  const rightTime = Date.parse(right?.created_at || right?.timestamp || "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return normalizeText(left?.message_id).localeCompare(normalizeText(right?.message_id));
}

function rowToHotMessage(row = {}) {
  return {
    role: normalizeText(row.role) || "unknown",
    content: messageContent(row),
    timestamp: normalizeText(row.created_at),
  };
}

function rowToRuntimeMessage(row = {}) {
  return {
    role: normalizeText(row.role) || "unknown",
    content: messageContent(row),
    timestamp: normalizeText(row.created_at),
  };
}

function messageContent(row = {}) {
  const text = normalizeText(row.text || row.content);
  if (text) {
    return text;
  }
  const attachments = Array.isArray(row.attachments) ? row.attachments : [];
  if (!attachments.length) {
    return "";
  }
  return `[attachments:${attachments.length}]`;
}

function summarizeConversation(conversation = {}) {
  const title = normalizeText(conversation.conversation_title);
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const tail = messages.slice(-2)
    .map((row) => `${normalizeText(row.role) || "unknown"}: ${truncateText(messageContent(row), 80)}`)
    .filter((item) => !item.endsWith(": "))
    .join(" / ");
  return [title, tail].filter(Boolean).join(" | ");
}

function summarizePair(pair = {}, title = "") {
  const query = pair.user ? messageContent(pair.user) : "";
  const reply = pair.assistant ? messageContent(pair.assistant) : "";
  return [
    normalizeText(title),
    query ? `user=${truncateText(query, 80)}` : "",
    reply ? `assistant=${truncateText(reply, 80)}` : "",
  ].filter(Boolean).join(" | ");
}

function inferOpenLoop(rows = [], title = "") {
  const sorted = rows.slice().sort(compareMessageRows);
  const lastUser = [...sorted].reverse().find((row) => normalizeText(row.role) === "user");
  if (!lastUser) {
    return "";
  }
  const hasAssistantAfter = sorted.some((row) => {
    return normalizeText(row.role) === "assistant"
      && Date.parse(row.created_at || "") > Date.parse(lastUser.created_at || "");
  });
  if (hasAssistantAfter) {
    return "";
  }
  return `${normalizeText(title) || normalizeText(lastUser.conversation_id) || "captured thread"}: ${truncateText(messageContent(lastUser), 90)}`;
}

function buildProjectionSummary(sourceClient, signals = {}) {
  const sources = mergeStringLists(signals.activeChannels || [sourceClient], 6).join(", ");
  const snippets = Array.isArray(signals.projectionSnippets) ? signals.projectionSnippets.slice(-2) : [];
  return [
    `web_ai_capture from ${sources || sourceClient || "web_ai"}`,
    snippets.map((item) => truncateText(item, 120)).join(" / "),
  ].filter(Boolean).join(" | ");
}

function buildCaptureRecordId(sourceClient, threadId, pair = {}) {
  const seed = [
    sourceClient,
    threadId,
    pair.user?.message_id || pair.user?.created_at || "",
    pair.assistant?.message_id || pair.assistant?.created_at || "",
    messageContent(pair.user || {}).slice(0, 160),
    messageContent(pair.assistant || {}).slice(0, 160),
  ].join("|");
  return `webcap_${hashText(seed).slice(0, 20)}`;
}

function buildStageRef(summary = {}) {
  return [
    "daily_capture",
    normalizeText(summary.source_client) || "web_ai",
    normalizeText(summary.captured_date) || "unknown_date",
  ].join(":");
}

function endpointIdFromUrl(sourceUrl = "") {
  const normalized = normalizeText(sourceUrl);
  if (!normalized) {
    return "";
  }
  try {
    const parsed = new URL(normalized);
    return safeName(parsed.hostname || "");
  } catch {
    return "";
  }
}

function exporterName(source = {}) {
  const exporter = source.exporter && typeof source.exporter === "object" ? source.exporter : {};
  return normalizeText(exporter.name) || normalizeText(source.source_client) || "web_ai_capture";
}

function maxIso(left = "", right = "") {
  const leftTime = Date.parse(left || "");
  const rightTime = Date.parse(right || "");
  if (!Number.isFinite(leftTime)) {
    return Number.isFinite(rightTime) ? right : "";
  }
  if (!Number.isFinite(rightTime)) {
    return left;
  }
  return rightTime > leftTime ? right : left;
}

function mergeStringLists(...args) {
  let limit = 24;
  let lists = args;
  const last = args[args.length - 1];
  if (typeof last === "number") {
    limit = last;
    lists = args.slice(0, -1);
  }
  const seen = new Set();
  const result = [];
  lists.flat().forEach((item) => {
    const text = normalizeText(item);
    if (!text || seen.has(text)) {
      return;
    }
    seen.add(text);
    result.push(text);
  });
  return result.slice(0, Math.max(1, Math.min(Number(limit) || 24, 100)));
}

function safeName(text) {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "_")
    .replace(/^[._-]+|[._-]+$/gu, "") || "default";
}

function truncateText(text, maxLength = 120) {
  const normalized = normalizeText(text).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}...`;
}

function hashText(text) {
  return crypto.createHash("sha1").update(String(text || "")).digest("hex");
}

function buildResult({ errors = [], warnings = [], summary = {} } = {}) {
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary,
  };
}

function recordCaptureSourceEvent(memoryMetabolism, event = {}) {
  if (!memoryMetabolism || typeof memoryMetabolism.recordSourceEvent !== "function") {
    return { ok: false, skipped: true, reason: "memory metabolism source-event service is not configured" };
  }
  try {
    const recorded = memoryMetabolism.recordSourceEvent(event);
    return { ok: true, event: recorded };
  } catch (error) {
    return {
      ok: false,
      error: `memory metabolism source-event write failed: ${normalizeText(error?.message) || String(error || "unknown error")}`,
    };
  }
}

function noteSourceEventResult(result, stats, warnings) {
  if (!result) {
    return;
  }
  if (result.ok) {
    stats.source_events_written += 1;
    return;
  }
  if (result.skipped) {
    stats.source_events_skipped += 1;
    return;
  }
  stats.source_events_failed += 1;
  if (result.error) {
    warnings.push(result.error);
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ALLOWED_ROLES,
  BUNDLE_SCHEMA,
  STAGED_SCHEMA,
  importDailyCaptureTarget,
  loadDailyCaptureTarget,
  stageDailyCaptureTarget,
  validateDailyCaptureBundle,
  validateDailyCaptureDirectory,
  validateDailyCaptureTarget,
};
