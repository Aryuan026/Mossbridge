const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HOT_CONTEXT_SCHEMA = "mossbridge_hot_context_v0.1";

class HotScope {
  constructor({ ownerId = "owner", realmId = "default", agentId = "moss", basinId = "default" } = {}) {
    this.ownerId = normalizeText(ownerId) || "owner";
    this.realmId = normalizeText(realmId) || "default";
    this.agentId = normalizeText(agentId) || "moss";
    this.basinId = normalizeText(basinId) || "default";
  }

  scopeId() {
    return [
      this.ownerId,
      this.realmId,
      this.agentId,
      this.basinId,
    ].map(safeName).join("__");
  }

  toJSON() {
    return {
      owner_id: this.ownerId,
      realm_id: this.realmId,
      agent_id: this.agentId,
      basin_id: this.basinId,
      scope_id: this.scopeId(),
    };
  }
}

class UpstreamContextMergeStore {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  upsertPackage(scope, input = {}) {
    const hotScope = normalizeScope(scope);
    const now = new Date().toISOString();
    const existing = this.loadAll(hotScope);
    const packageId = normalizeText(input.package_id || input.packageId)
      || buildPackageId(input);
    const index = existing.packages.findIndex((item) => normalizeText(item.package_id) === packageId);
    const previous = index >= 0 ? existing.packages[index] : {};
    const record = normalizePackageRecord({
      ...previous,
      ...input,
      package_id: packageId,
      created_at: normalizeText(previous.created_at) || normalizeText(input.created_at || input.createdAt) || now,
      updated_at: now,
      recent_messages: mergeMessages(previous.recent_messages, input.recent_messages || input.recentMessages, 24),
      tags: mergeStringLists(previous.tags, input.tags, 16),
      provenance_refs: mergeStringLists(previous.provenance_refs, input.provenance_refs || input.provenanceRefs, 16),
    });
    if (index >= 0) {
      existing.packages[index] = record;
    } else {
      existing.packages.push(record);
    }
    existing.updated_at = now;
    existing.packages.sort((left, right) => {
      return Date.parse(right.updated_at || right.created_at || 0) - Date.parse(left.updated_at || left.created_at || 0);
    });
    this.saveAll(hotScope, existing);
    return record;
  }

  listPackages(scope, limit = 12) {
    const hotScope = normalizeScope(scope);
    const maxLimit = Math.max(1, Math.min(Number(limit) || 12, 50));
    return this.loadAll(hotScope).packages
      .slice()
      .sort((left, right) => {
        return Date.parse(right.updated_at || right.created_at || 0) - Date.parse(left.updated_at || left.created_at || 0);
      })
      .slice(0, maxLimit);
  }

  loadAll(scope) {
    const filePath = this.filePath(scope);
    if (!fs.existsSync(filePath)) {
      return {
        schema: HOT_CONTEXT_SCHEMA,
        scope: scope.toJSON(),
        updated_at: "",
        packages: [],
      };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return {
        schema: normalizeText(parsed.schema) || HOT_CONTEXT_SCHEMA,
        scope: parsed.scope || scope.toJSON(),
        updated_at: normalizeText(parsed.updated_at),
        packages: Array.isArray(parsed.packages) ? parsed.packages.map(normalizePackageRecord) : [],
      };
    } catch {
      return {
        schema: HOT_CONTEXT_SCHEMA,
        scope: scope.toJSON(),
        updated_at: "",
        packages: [],
      };
    }
  }

  saveAll(scope, payload) {
    const filePath = this.filePath(scope);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({
      schema: HOT_CONTEXT_SCHEMA,
      scope: scope.toJSON(),
      updated_at: normalizeText(payload.updated_at) || new Date().toISOString(),
      packages: Array.isArray(payload.packages) ? payload.packages.map(normalizePackageRecord) : [],
    }, null, 2)}\n`, "utf8");
  }

  filePath(scope) {
    return path.join(this.rootDir, `${scope.scopeId()}.json`);
  }
}

class HotContextStore {
  constructor({ basinRoot, projectionRoot, snapshotRoot } = {}) {
    this.basinRoot = path.resolve(basinRoot || path.join(process.cwd(), "hot_context_basin"));
    this.projectionRoot = path.resolve(projectionRoot || path.join(process.cwd(), "hot_context_projection"));
    this.snapshotRoot = path.resolve(snapshotRoot || path.join(process.cwd(), "hot_context_snapshot"));
    fs.mkdirSync(this.basinRoot, { recursive: true });
    fs.mkdirSync(this.projectionRoot, { recursive: true });
    fs.mkdirSync(this.snapshotRoot, { recursive: true });
  }

  loadBasinHead(scope) {
    const hotScope = normalizeScope(scope);
    const filePath = this.basinHeadPath(hotScope);
    if (!fs.existsSync(filePath)) {
      return defaultBasinHead(hotScope);
    }
    try {
      return normalizeBasinHead({
        ...defaultBasinHead(hotScope),
        ...JSON.parse(fs.readFileSync(filePath, "utf8")),
      }, hotScope);
    } catch {
      return defaultBasinHead(hotScope);
    }
  }

  saveBasinHead(scope, head = {}) {
    const hotScope = normalizeScope(scope);
    const payload = normalizeBasinHead({
      ...defaultBasinHead(hotScope),
      ...head,
      updated_at: new Date().toISOString(),
    }, hotScope);
    const filePath = this.basinHeadPath(hotScope);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return payload;
  }

  appendTurnSlice(scope, input = {}) {
    const hotScope = normalizeScope(scope);
    const record = normalizeTurnSlice({
      ...input,
      turn_id: normalizeText(input.turn_id || input.turnId) || buildTurnId(input),
    });
    if (!record.content && !record.attachment_count) {
      return { written: false, duplicate: false, record };
    }
    const recent = this.listRecentTurnSlices(hotScope, 80);
    const duplicate = recent.some((item) => isDuplicateTurnSlice(item, record));
    if (duplicate) {
      return { written: false, duplicate: true, record };
    }
    const filePath = this.turnSlicesPath(hotScope);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
    return { written: true, duplicate: false, record };
  }

  listRecentTurnSlices(scope, limit = 12) {
    const hotScope = normalizeScope(scope);
    const filePath = this.turnSlicesPath(hotScope);
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const maxLimit = Math.max(1, Math.min(Number(limit) || 12, 100));
    const rows = [];
    try {
      const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim();
        if (!line) {
          continue;
        }
        try {
          rows.push(normalizeTurnSlice(JSON.parse(line)));
        } catch {
          // Ignore malformed cache rows. The hot layer is a reversible cache.
        }
        if (rows.length >= maxLimit) {
          break;
        }
      }
    } catch {
      return [];
    }
    return rows;
  }

  loadProjection(scope) {
    const hotScope = normalizeScope(scope);
    const filePath = this.projectionPath(hotScope);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      return normalizeProjection(JSON.parse(fs.readFileSync(filePath, "utf8")), hotScope);
    } catch {
      return null;
    }
  }

  saveProjection(scope, projection = {}) {
    const hotScope = normalizeScope(scope);
    const payload = normalizeProjection({
      ...projection,
      schema: HOT_CONTEXT_SCHEMA,
      scope: hotScope.toJSON(),
      updated_at: new Date().toISOString(),
    }, hotScope);
    const filePath = this.projectionPath(hotScope);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return payload;
  }

  listSnapshots(scope, limit = 3) {
    const hotScope = normalizeScope(scope);
    const filePath = this.snapshotPath(hotScope);
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const maxLimit = Math.max(1, Math.min(Number(limit) || 3, 20));
    const rows = [];
    try {
      const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim();
        if (!line) {
          continue;
        }
        try {
          rows.push(JSON.parse(line));
        } catch {
          // Ignore malformed cache rows.
        }
        if (rows.length >= maxLimit) {
          break;
        }
      }
    } catch {
      return [];
    }
    return rows;
  }

  saveSnapshot(scope, snapshot = {}) {
    const hotScope = normalizeScope(scope);
    const payload = {
      ...snapshot,
      snapshot_id: normalizeText(snapshot.snapshot_id || snapshot.snapshotId) || `hotsnap_${hashText(JSON.stringify(snapshot)).slice(0, 16)}`,
      schema: HOT_CONTEXT_SCHEMA,
      scope: hotScope.toJSON(),
      created_at: normalizeText(snapshot.created_at || snapshot.createdAt) || new Date().toISOString(),
    };
    const filePath = this.snapshotPath(hotScope);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
    return payload;
  }

  basinHeadPath(scope) {
    return path.join(this.basinRoot, `${scope.scopeId()}.head.json`);
  }

  turnSlicesPath(scope) {
    return path.join(this.basinRoot, `${scope.scopeId()}.turns.jsonl`);
  }

  projectionPath(scope) {
    return path.join(this.projectionRoot, `${scope.scopeId()}.json`);
  }

  snapshotPath(scope) {
    return path.join(this.snapshotRoot, `${scope.scopeId()}.jsonl`);
  }
}

function buildHotContextPacket({
  scope,
  upstreamStore,
  hotContextStore,
  query = "",
  upstreamLimit = 8,
  turnLimit = 8,
  snapshotLimit = 3,
} = {}) {
  const hotScope = normalizeScope(scope);
  const upstreamPackages = upstreamStore
    ? rankPackages(upstreamStore.listPackages(hotScope, Math.max(12, upstreamLimit * 2)), query).slice(0, upstreamLimit)
    : [];
  const basinHead = hotContextStore ? hotContextStore.loadBasinHead(hotScope) : defaultBasinHead(hotScope);
  const recentTurns = hotContextStore ? hotContextStore.listRecentTurnSlices(hotScope, turnLimit) : [];
  const projection = hotContextStore ? hotContextStore.loadProjection(hotScope) : null;
  const snapshots = hotContextStore ? hotContextStore.listSnapshots(hotScope, snapshotLimit) : [];
  return {
    ok: true,
    schema: HOT_CONTEXT_SCHEMA,
    scope: hotScope.toJSON(),
    query: normalizeText(query),
    upstream: {
      package_count: upstreamPackages.length,
      packages: upstreamPackages,
    },
    basin: {
      head: basinHead,
      recent_turns: recentTurns,
    },
    projection,
    snapshots,
    summary: summarizeHotContext({
      upstreamPackages,
      basinHead,
      recentTurns,
      projection,
      snapshots,
    }),
  };
}

function buildHotContextPreludeLines(packet = {}, limit = 5) {
  const lines = [];
  const maxLimit = Math.max(1, Math.min(Number(limit) || 5, 12));
  const projection = packet?.projection || {};
  const basinHead = packet?.basin?.head || {};
  const packages = Array.isArray(packet?.upstream?.packages) ? packet.upstream.packages : [];
  const recentTurns = Array.isArray(packet?.basin?.recent_turns) ? packet.basin.recent_turns : [];
  const projectionSummary = normalizeText(projection.summary);
  const rawHistoricalTextRequested = isExplicitHistoricalWordingRequest(packet?.query);
  if (projectionSummary) {
    lines.push(
      rawHistoricalTextRequested
        ? `- hot-projection: ${normalizePreludeText(projectionSummary)}`
        : `- hot-projection: ${normalizePreludeText(extractStructuredProjectionSummary(projectionSummary))}`,
    );
  }
  const openLoops = mergeStringLists(projection.open_loops, basinHead.open_loops, 4);
  if (openLoops.length) {
    if (rawHistoricalTextRequested) {
      openLoops.slice(0, 2).forEach((item) => {
        lines.push(`- hot-open-loop: ${normalizePreludeText(item)}`);
      });
    } else {
      lines.push(`- hot-open-loop: pending=${openLoops.length}`);
    }
  }
  packages.slice(0, maxLimit).forEach((item) => {
    const source = normalizePreludeText(item.source_client) || "web_ai";
    const title = normalizePreludeText(item.thread_title || item.summary) || normalizePreludeText(item.thread_id) || "captured thread";
    const summary = normalizePreludeText(item.summary);
    const messages = Array.isArray(item.recent_messages) ? item.recent_messages : [];
    if (rawHistoricalTextRequested) {
      const tail = messages.slice(-2)
        .map((message) => {
          const role = normalizePreludeText(message.role) || "unknown";
          const content = normalizePreludeText(message.content);
          return content ? `${role}: ${truncateText(content, 70)}` : "";
        })
        .filter(Boolean)
        .join(" / ");
      lines.push(`- hot-source: ${source} | ${title}${tail ? ` | ${tail}` : ""}`);
      return;
    }
    const messageCount = messages.length;
    const structuredDetail = summary ? extractStructuredProjectionSummary(summary) : "";
    lines.push(
      `- hot-source: ${source} | ${title}`
      + `${structuredDetail && structuredDetail !== title ? ` | ${structuredDetail}` : ""}`
      + `${messageCount ? ` | recent_messages=${messageCount}` : ""}`,
    );
  });
  if (!packages.length) {
    recentTurns.slice(0, Math.min(maxLimit, 3)).forEach((item) => {
      const source = normalizePreludeText(item.source_client) || "hot";
      const role = normalizePreludeText(item.role) || "unknown";
      if (rawHistoricalTextRequested) {
        const content = normalizePreludeText(item.content);
        if (content) {
          lines.push(`- hot-turn: ${source} | ${role}: ${truncateText(content, 90)}`);
        }
        return;
      }
      const threadId = normalizePreludeText(item.thread_id);
      const attachmentCount = Number(item.attachment_count) || 0;
      lines.push(
        `- hot-turn: ${source} | role=${role}`
        + `${threadId ? ` | thread=${threadId}` : ""}`
        + `${attachmentCount ? ` | attachments=${attachmentCount}` : ""}`,
      );
    });
  }
  return lines;
}

function isExplicitHistoricalWordingRequest(query = "") {
  const text = normalizeText(query);
  if (!text) {
    return false;
  }
  return /(?:原话|原文|逐字|一字不差|准确措辞|具体措辞|怎么说的|说了什么|复述|引用|照原样|verbatim|exact wording|quote)/iu.test(text);
}

function extractStructuredProjectionSummary(text = "") {
  const normalized = normalizeText(text);
  if (!normalized) {
    return "";
  }
  const [head] = normalized.split(/\s+\|\s+/u);
  return head || normalized;
}

function defaultBasinHead(scope) {
  return {
    schema: HOT_CONTEXT_SCHEMA,
    scope: scope.toJSON(),
    updated_at: "",
    last_user_at: "",
    last_assistant_at: "",
    expires_at: "",
    open_loops: [],
    active_entities: [],
    active_tasks: [],
    affective_trace: [],
    recent_turn_refs: [],
    active_channels: [],
    active_threads: [],
    projection_ref: "",
    dreaming_cursor: "",
    provenance_refs: [],
  };
}

function normalizeBasinHead(head, scope) {
  return {
    schema: normalizeText(head.schema) || HOT_CONTEXT_SCHEMA,
    scope: scope.toJSON(),
    updated_at: normalizeText(head.updated_at),
    last_user_at: normalizeText(head.last_user_at || head.lastUserAt),
    last_assistant_at: normalizeText(head.last_assistant_at || head.lastAssistantAt),
    expires_at: normalizeText(head.expires_at || head.expiresAt),
    open_loops: normalizeStringList(head.open_loops || head.openLoops).slice(0, 12),
    active_entities: normalizeStringList(head.active_entities || head.activeEntities).slice(0, 16),
    active_tasks: normalizeStringList(head.active_tasks || head.activeTasks).slice(0, 12),
    affective_trace: normalizeStringList(head.affective_trace || head.affectiveTrace).slice(0, 12),
    recent_turn_refs: normalizeStringList(head.recent_turn_refs || head.recentTurnRefs).slice(0, 40),
    active_channels: normalizeStringList(head.active_channels || head.activeChannels).slice(0, 12),
    active_threads: normalizeStringList(head.active_threads || head.activeThreads).slice(0, 24),
    projection_ref: normalizeText(head.projection_ref || head.projectionRef),
    dreaming_cursor: normalizeText(head.dreaming_cursor || head.dreamingCursor),
    provenance_refs: normalizeStringList(head.provenance_refs || head.provenanceRefs).slice(0, 40),
  };
}

function normalizeProjection(projection, scope) {
  return {
    schema: normalizeText(projection.schema) || HOT_CONTEXT_SCHEMA,
    scope: scope.toJSON(),
    projection_id: normalizeText(projection.projection_id || projection.projectionId) || `hotproj_${scope.scopeId()}`,
    updated_at: normalizeText(projection.updated_at || projection.updatedAt),
    summary: normalizeText(projection.summary),
    sources: normalizeStringList(projection.sources).slice(0, 12),
    open_loops: normalizeStringList(projection.open_loops || projection.openLoops).slice(0, 12),
    active_entities: normalizeStringList(projection.active_entities || projection.activeEntities).slice(0, 16),
    active_tasks: normalizeStringList(projection.active_tasks || projection.activeTasks).slice(0, 12),
    sticky_items: normalizeStringList(projection.sticky_items || projection.stickyItems).slice(0, 12),
    recent_turn_refs: normalizeStringList(projection.recent_turn_refs || projection.recentTurnRefs).slice(0, 40),
    provenance_refs: normalizeStringList(projection.provenance_refs || projection.provenanceRefs).slice(0, 40),
  };
}

function normalizePackageRecord(input = {}) {
  return {
    package_id: normalizeText(input.package_id || input.packageId),
    source_client: normalizeText(input.source_client || input.sourceClient) || "web_ai",
    channel_id: normalizeText(input.channel_id || input.channelId),
    endpoint_id: normalizeText(input.endpoint_id || input.endpointId),
    thread_id: normalizeText(input.thread_id || input.threadId),
    thread_title: normalizeText(input.thread_title || input.threadTitle || input.conversation_title || input.conversationTitle),
    summary: normalizeText(input.summary),
    recent_messages: normalizeMessageList(input.recent_messages || input.recentMessages).slice(-24),
    tags: normalizeStringList(input.tags).slice(0, 16),
    provenance_refs: normalizeStringList(input.provenance_refs || input.provenanceRefs).slice(0, 16),
    created_at: normalizeText(input.created_at || input.createdAt),
    updated_at: normalizeText(input.updated_at || input.updatedAt),
  };
}

function normalizeTurnSlice(input = {}) {
  const attachments = Array.isArray(input.attachments) ? input.attachments : [];
  return {
    turn_id: normalizeText(input.turn_id || input.turnId),
    ts_utc: normalizeText(input.ts_utc || input.tsUtc || input.created_at || input.createdAt) || new Date().toISOString(),
    source_client: normalizeText(input.source_client || input.sourceClient) || "web_ai",
    channel_id: normalizeText(input.channel_id || input.channelId),
    endpoint_id: normalizeText(input.endpoint_id || input.endpointId),
    thread_id: normalizeText(input.thread_id || input.threadId || input.conversation_id || input.conversationId),
    role: normalizeText(input.role) || "unknown",
    content: normalizeText(input.content || input.text),
    attachment_count: Number(input.attachment_count || input.attachmentCount || attachments.length) || 0,
    open_loops: normalizeStringList(input.open_loops || input.openLoops).slice(0, 6),
    active_entities: normalizeStringList(input.active_entities || input.activeEntities).slice(0, 6),
    active_tasks: normalizeStringList(input.active_tasks || input.activeTasks).slice(0, 6),
    affective_trace: normalizeStringList(input.affective_trace || input.affectiveTrace).slice(0, 6),
    provenance_refs: normalizeStringList(input.provenance_refs || input.provenanceRefs).slice(0, 8),
  };
}

function normalizeMessageList(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      role: normalizeText(item.role) || "unknown",
      content: normalizeText(item.content || item.text),
      timestamp: normalizeText(item.timestamp || item.ts_utc || item.created_at || item.createdAt),
    }))
    .filter((item) => item.content);
}

function mergeMessages(left, right, limit = 24) {
  const seen = new Set();
  const result = [];
  for (const item of [...normalizeMessageList(left), ...normalizeMessageList(right)]) {
    const key = [
      item.role,
      item.timestamp,
      item.content.slice(0, 120),
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result.slice(-Math.max(1, Math.min(Number(limit) || 24, 80)));
}

function rankPackages(packages, query) {
  const terms = extractTerms(query);
  return (Array.isArray(packages) ? packages : [])
    .map((item) => ({
      item,
      score: scorePackage(item, terms),
      timestamp: Date.parse(item.updated_at || item.created_at || 0) || 0,
    }))
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return right.timestamp - left.timestamp;
    })
    .map((entry) => entry.item);
}

function scorePackage(item, terms) {
  if (!terms.length) {
    return 0;
  }
  const haystack = [
    item.source_client,
    item.thread_title,
    item.summary,
    item.thread_id,
    ...(Array.isArray(item.recent_messages) ? item.recent_messages.map((message) => message.content) : []),
  ].join("\n").toLowerCase();
  let score = 0;
  terms.forEach((term) => {
    if (haystack.includes(term.toLowerCase())) {
      score += term.length >= 3 ? 2 : 1;
    }
  });
  return score;
}

function summarizeHotContext({ upstreamPackages = [], basinHead = {}, recentTurns = [], projection = null, snapshots = [] } = {}) {
  return [
    upstreamPackages.length ? `upstream=${upstreamPackages.length}` : "",
    recentTurns.length ? `recent_turns=${recentTurns.length}` : "",
    Array.isArray(basinHead.open_loops) && basinHead.open_loops.length ? `open_loops=${basinHead.open_loops.length}` : "",
    projection?.summary ? "projection=ready" : "",
    snapshots.length ? `snapshots=${snapshots.length}` : "",
  ].filter(Boolean).join(" | ");
}

function buildPackageId(input = {}) {
  return `hotpkg_${hashText([
    normalizeText(input.source_client || input.sourceClient),
    normalizeText(input.channel_id || input.channelId),
    normalizeText(input.endpoint_id || input.endpointId),
    normalizeText(input.thread_id || input.threadId),
  ].join("|")).slice(0, 18)}`;
}

function buildTurnId(input = {}) {
  return `hotturn_${hashText([
    normalizeText(input.source_client || input.sourceClient),
    normalizeText(input.thread_id || input.threadId || input.conversation_id || input.conversationId),
    normalizeText(input.role),
    normalizeText(input.ts_utc || input.tsUtc || input.created_at || input.createdAt),
    normalizeText(input.content || input.text).slice(0, 200),
  ].join("|")).slice(0, 18)}`;
}

function isDuplicateTurnSlice(left, right) {
  const leftTs = Date.parse(left.ts_utc || "");
  const rightTs = Date.parse(right.ts_utc || "");
  const sameTimeWindow = Number.isFinite(leftTs) && Number.isFinite(rightTs)
    ? Math.abs(leftTs - rightTs) <= 60 * 1000
    : true;
  return sameTimeWindow
    && normalizeText(left.source_client) === normalizeText(right.source_client)
    && normalizeText(left.thread_id) === normalizeText(right.thread_id)
    && normalizeText(left.role) === normalizeText(right.role)
    && normalizeText(left.content) === normalizeText(right.content);
}

function normalizeScope(scope) {
  if (scope instanceof HotScope) {
    return scope;
  }
  if (scope && typeof scope === "object") {
    return new HotScope({
      ownerId: scope.ownerId || scope.owner_id,
      realmId: scope.realmId || scope.realm_id,
      agentId: scope.agentId || scope.agent_id,
      basinId: scope.basinId || scope.basin_id,
    });
  }
  return new HotScope();
}

function normalizeStringList(value) {
  const source = Array.isArray(value) ? value : (normalizeText(value) ? [value] : []);
  const seen = new Set();
  const result = [];
  source.forEach((item) => {
    const text = normalizeText(item);
    if (!text || seen.has(text)) {
      return;
    }
    seen.add(text);
    result.push(text);
  });
  return result;
}

function mergeStringLists(...args) {
  let limit = 24;
  let lists = args;
  const last = args[args.length - 1];
  if (typeof last === "number") {
    limit = last;
    lists = args.slice(0, -1);
  }
  return normalizeStringList(lists.flat()).slice(0, Math.max(1, Math.min(Number(limit) || 24, 100)));
}

function extractTerms(query) {
  const normalized = normalizeText(query)
    .replace(/[^\p{Script=Han}a-zA-Z0-9]+/gu, " ")
    .trim();
  if (!normalized) {
    return [];
  }
  const terms = [];
  const seen = new Set();
  normalized.split(/\s+/).forEach((chunk) => {
    if (!chunk) {
      return;
    }
    if (/^[a-zA-Z0-9]{2,}$/u.test(chunk)) {
      const key = chunk.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        terms.push(chunk);
      }
      return;
    }
    if (/^\p{Script=Han}+$/u.test(chunk)) {
      if (chunk.length <= 4 && !seen.has(chunk)) {
        seen.add(chunk);
        terms.push(chunk);
      } else {
        for (let index = 0; index < chunk.length - 1 && terms.length < 10; index += 1) {
          const term = chunk.slice(index, index + 2);
          if (!seen.has(term)) {
            seen.add(term);
            terms.push(term);
          }
        }
      }
    }
  });
  return terms.slice(0, 10);
}

function normalizePreludeText(text) {
  return normalizeText(text)
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(text, maxLength = 120) {
  const normalized = normalizePreludeText(text);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}...`;
}

function safeName(text) {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "_")
    .replace(/^[._-]+|[._-]+$/gu, "") || "default";
}

function hashText(text) {
  return crypto.createHash("sha1").update(String(text || "")).digest("hex");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  HOT_CONTEXT_SCHEMA,
  HotScope,
  HotContextStore,
  UpstreamContextMergeStore,
  buildHotContextPacket,
  buildHotContextPreludeLines,
};
