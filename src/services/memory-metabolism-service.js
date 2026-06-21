const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STORE_VERSION = 1;
const DEFAULT_POLL_INTERVAL_MS = 15 * 60_000;
const DEFAULT_QUIET_WINDOW_MS = 45 * 60_000;
const DEFAULT_RETRY_DELAY_MS = 20 * 60_000;
const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_MAX_SOURCE_RECORDS = 24;
const DEFAULT_MIN_SOURCE_RECORDS = 2;
const ACTIVE_ATTEMPT_MAX_AGE_MS = 6 * 60 * 60_000;
const MAX_STORED_ATTEMPTS = 120;
const MAX_STORED_COMPLETED_RECORD_IDS = 500;
const MAX_SOURCE_EVENT_FILES = 0;
const MAX_LEDGER_FILES = 45;
const COMPLETED_SOURCE_DISPOSITIONS = new Set(["promoted", "evaluated", "rejected_as_noise"]);
const RETRY_SOURCE_DISPOSITIONS = new Set(["deferred", "conflict_open", "failed_retryable"]);
const ALLOWED_SOURCE_DISPOSITIONS = new Set([
  "pending",
  "evaluated",
  "promoted",
  "deferred",
  "rejected_as_noise",
  "conflict_open",
  "failed_retryable",
]);

class MemoryMetabolismService {
  constructor({ config = {}, memoryService = null } = {}) {
    this.config = config || {};
    this.memoryService = memoryService;
    this.stateFile = normalizeText(config.memoryMetabolismStateFile)
      || path.join(config.stateDir || process.cwd(), "memory-metabolism-state.json");
    this.logDir = normalizeText(memoryService?.layout?.dreamingMutationLogDir)
      || path.join(config.asherieDataRoot || config.stateDir || process.cwd(), "storage", "dreaming_mutation_log");
    const storageRoot = normalizeText(memoryService?.layout?.storageRoot)
      || path.dirname(this.logDir)
      || path.join(config.asherieDataRoot || config.stateDir || process.cwd(), "storage");
    this.sourceEventDir = normalizeText(config.memoryMetabolismSourceEventDir)
      || path.join(storageRoot, "memory_metabolism_source_events");
    this.mutationLedgerDir = normalizeText(config.memoryMetabolismMutationLedgerDir)
      || path.join(storageRoot, "memory_metabolism_mutation_ledger");
    this.lastPollAtMs = 0;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.mkdirSync(this.logDir, { recursive: true });
    fs.mkdirSync(this.sourceEventDir, { recursive: true });
    fs.mkdirSync(this.mutationLedgerDir, { recursive: true });
  }

  describe() {
    const state = this.readState();
    return {
      id: "memory_metabolism",
      enabled: this.isEnabled(),
      state_file: this.stateFile,
      mutation_log_dir: this.logDir,
      source_event_dir: this.sourceEventDir,
      mutation_ledger_dir: this.mutationLedgerDir,
      last_success_at: normalizeText(state.last_success_at),
      last_successful_record_ts_utc: normalizeText(state.last_successful_record_ts_utc),
      active_attempt: summarizeAttempt(findActiveAttempt(state, Date.now())),
    };
  }

  isEnabled() {
    return Boolean(this.config.startWithDreaming || this.config.dreamingEnabled);
  }

  getPollIntervalMs() {
    return resolvePositiveMsFromMinutes(
      this.config.dreamingPollIntervalMinutes,
      DEFAULT_POLL_INTERVAL_MS,
    );
  }

  maybeQueueDreaming({
    accountId = "",
    senderId = "",
    workspaceRoot = "",
    contextToken = "",
    queue = null,
    queueHasPending = false,
    runtimeCooldown = null,
    lastActivityAt = 0,
    nowMs = Date.now(),
  } = {}) {
    const normalizedNowMs = normalizeNowMs(nowMs);
    if (!this.isEnabled()) {
      return { queued: false, reason: "disabled" };
    }
    if (this.lastPollAtMs && normalizedNowMs - this.lastPollAtMs < this.getPollIntervalMs()) {
      return { queued: false, reason: "poll_interval" };
    }
    this.lastPollAtMs = normalizedNowMs;

    const readiness = this.resolveReadiness({
      accountId,
      senderId,
      workspaceRoot,
      contextToken,
      queueHasPending,
      runtimeCooldown,
      lastActivityAt,
      nowMs: normalizedNowMs,
    });
    if (!readiness.ready) {
      return { queued: false, reason: readiness.reason, readiness };
    }

    if (!queue || typeof queue.enqueue !== "function") {
      return { queued: false, reason: "missing_system_queue" };
    }

    const state = this.readState();
    const activeAttempt = findActiveAttempt(state, normalizedNowMs);
    if (activeAttempt) {
      return {
        queued: false,
        reason: "active_attempt",
        attempt_id: activeAttempt.attempt_id,
        status: activeAttempt.status,
      };
    }
    const retryableAttempt = findRetryableAttempt(state, normalizedNowMs);
    if (retryableAttempt) {
      const message = this.buildDreamingSystemMessage(retryableAttempt);
      const queued = queue.enqueue(message);
      retryableAttempt.queue_message_id = queued.id;
      retryableAttempt.status = "queued";
      retryableAttempt.queued_at = new Date(normalizedNowMs).toISOString();
      retryableAttempt.last_status = "requeued";
      state.retry_after_ms = 0;
      state.last_queued_at = retryableAttempt.queued_at;
      this.writeState(pruneState(state));
      this.appendLog({
        event: "attempt_requeued",
        attempt_id: retryableAttempt.attempt_id,
        queue_message_id: queued.id,
        retry_count: Number(retryableAttempt.retry_count) || 0,
        source_record_ids: retryableAttempt.source_record_ids,
        source_record_count: normalizeStringList(retryableAttempt.source_record_ids).length,
        ts_utc: retryableAttempt.queued_at,
      });
      return {
        queued: true,
        requeued: true,
        attempt_id: retryableAttempt.attempt_id,
        message: queued,
        source_record_count: normalizeStringList(retryableAttempt.source_record_ids).length,
        source_record_ids: normalizeStringList(retryableAttempt.source_record_ids),
      };
    }

    const source = this.collectSourceRecords({
      userId: senderId,
      nowMs: normalizedNowMs,
    });
    if (source.records.length < this.getMinSourceRecords()) {
      return {
        queued: false,
        reason: "insufficient_source_records",
        source_count: source.records.length,
        min_source_records: this.getMinSourceRecords(),
      };
    }

    const attempt = this.createAttempt({
      accountId,
      senderId,
      workspaceRoot,
      source,
      nowMs: normalizedNowMs,
    });
    const message = this.buildDreamingSystemMessage(attempt);
    const queued = queue.enqueue(message);

    state.attempts[attempt.attempt_id] = {
      ...attempt,
      queue_message_id: queued.id,
      status: "queued",
      queued_at: new Date(normalizedNowMs).toISOString(),
    };
    state.last_queued_at = new Date(normalizedNowMs).toISOString();
    this.writeState(pruneState(state));
    this.appendLog({
      event: "attempt_queued",
      attempt_id: attempt.attempt_id,
      queue_message_id: queued.id,
      source_record_ids: attempt.source_record_ids,
      source_record_count: attempt.source_record_ids.length,
      ts_utc: new Date(normalizedNowMs).toISOString(),
    });

    return {
      queued: true,
      attempt_id: attempt.attempt_id,
      message: queued,
      source_record_count: attempt.source_record_ids.length,
      source_record_ids: attempt.source_record_ids,
    };
  }

  resolveReadiness({
    accountId = "",
    senderId = "",
    workspaceRoot = "",
    contextToken = "",
    queueHasPending = false,
    runtimeCooldown = null,
    lastActivityAt = 0,
    nowMs = Date.now(),
  } = {}) {
    const normalizedNowMs = normalizeNowMs(nowMs);
    if (!normalizeText(accountId)) {
      return { ready: false, reason: "missing_account" };
    }
    if (!normalizeText(senderId)) {
      return { ready: false, reason: "missing_user" };
    }
    if (!normalizeText(workspaceRoot)) {
      return { ready: false, reason: "missing_workspace" };
    }
    if (!normalizeText(contextToken)) {
      return { ready: false, reason: "missing_context_token" };
    }
    if (queueHasPending) {
      return { ready: false, reason: "pending_system_queue" };
    }
    if (runtimeCooldown) {
      return { ready: false, reason: "runtime_cooldown", runtimeCooldown };
    }
    const quietWindowMs = this.getQuietWindowMs();
    const normalizedLastActivityAt = Number(lastActivityAt) || 0;
    if (normalizedLastActivityAt > 0 && normalizedNowMs - normalizedLastActivityAt < quietWindowMs) {
      return {
        ready: false,
        reason: "conversation_active",
        quiet_window_ms: quietWindowMs,
        last_activity_at: new Date(normalizedLastActivityAt).toISOString(),
      };
    }
    const state = this.readState();
    const activeAttempt = findActiveAttempt(state, normalizedNowMs);
    if (activeAttempt) {
      return {
        ready: false,
        reason: "active_attempt",
        attempt_id: activeAttempt.attempt_id,
        status: activeAttempt.status,
      };
    }
    const retryAfterMs = Number(state.retry_after_ms) || 0;
    if (retryAfterMs > normalizedNowMs) {
      return {
        ready: false,
        reason: "retry_after",
        retry_after: new Date(retryAfterMs).toISOString(),
      };
    }
    return {
      ready: true,
      reason: "ready",
      quiet_window_ms: quietWindowMs,
    };
  }

  collectSourceRecords({ userId = "", nowMs = Date.now() } = {}) {
    const state = this.readState();
    const closedSourceIds = buildClosedSourceIdSet(state);
    if (!this.memoryService?.conversationCache || typeof this.memoryService.resolveScopes !== "function") {
      const eventRecords = this.collectSourceEventRecords({
        userId,
        nowMs,
        completedIds: closedSourceIds,
      });
      return {
        records: eventRecords.slice(-this.getMaxSourceRecords()),
        stats: {
          reason: eventRecords.length ? "source_event_only" : "missing_memory_service",
          source_event_count: eventRecords.length,
        },
      };
    }
    const scopes = this.memoryService.resolveScopes({ userId });
    const windowStartMs = normalizeNowMs(nowMs) - (this.getWindowHours() * 60 * 60_000);
    const cutoffMs = windowStartMs;
    const fetchLimit = Math.max(this.getMaxSourceRecords() * 20, 500);
    const recent = this.memoryService.conversationCache.listRecent(
      scopes.scopedUserId,
      "",
      fetchLimit,
      true,
    );
    const conversationRecords = (recent.records || [])
      .filter((record) => isMetabolizableRecord(record, { cutoffMs, nowMs, completedIds: closedSourceIds }))
      .sort(compareRecordAsc)
      .map(compactSourceRecord);
    const eventRecords = this.collectSourceEventRecords({
      userId,
      scopedUserId: scopes.scopedUserId,
      nowMs,
      completedIds: closedSourceIds,
    });
    const records = mergeSourceRecords(conversationRecords, eventRecords)
      .sort(compareRecordAsc)
      .slice(-this.getMaxSourceRecords());
    return {
      records,
      warmDuplicateClusters: this.collectWarmDuplicateClusters({ userId, limit: 6 }),
      warmReviewCandidates: this.collectWarmReviewCandidates({ userId, limit: 8 }),
      stats: {
        ...(recent.stats || {}),
        conversation_record_count: conversationRecords.length,
        source_event_count: eventRecords.length,
      },
      scoped_user_id: scopes.scopedUserId,
      cutoff_utc: new Date(cutoffMs).toISOString(),
    };
  }

  collectSourceEventRecords({
    userId = "",
    scopedUserId = "",
    nowMs = Date.now(),
    completedIds = new Set(),
  } = {}) {
    const targetScopedUserId = normalizeText(scopedUserId) || this.resolveScopedUserId(userId);
    const normalizedNowMs = normalizeNowMs(nowMs);
    const events = this.readSourceEvents()
      .filter((event) => isMetabolizableSourceEvent(event, {
        scopedUserId: targetScopedUserId,
        userId,
        nowMs: normalizedNowMs,
        completedIds,
      }))
      .sort(compareRecordAsc);
    return uniqueSourceEvents(events).map(compactSourceEvent);
  }

  resolveScopedUserId(userId = "") {
    if (this.memoryService && typeof this.memoryService.resolveScopes === "function") {
      try {
        return normalizeText(this.memoryService.resolveScopes({ userId })?.scopedUserId);
      } catch {
        return normalizeText(userId);
      }
    }
    return normalizeText(userId);
  }

  recordSourceEvent(args = {}) {
    const nowIso = normalizeText(args.ts_utc || args.tsUtc) || new Date().toISOString();
    const sourceType = normalizeText(args.source_type || args.sourceType) || "memory_event";
    const sourceId = normalizeText(
      args.source_id
        || args.sourceId
        || args.record_id
        || args.recordId
        || args.object_id
        || args.objectId,
    );
    const content = normalizeText(args.content || args.text || args.summary);
    const contentHash = normalizeText(args.content_hash || args.contentHash)
      || hashStableJson({ sourceType, sourceId, content, metadata: args.metadata || {} });
    const eventId = normalizeText(args.event_id || args.eventId)
      || `src_${hashStableJson({ sourceType, sourceId, contentHash }).slice(0, 20)}`;
    const scopedUserId = normalizeText(args.scoped_user_id || args.scopedUserId)
      || this.resolveScopedUserId(args.user_id || args.userId);
    const event = {
      event_id: eventId,
      source_id: sourceId || eventId,
      source_type: sourceType,
      source_label: normalizeText(args.source_label || args.sourceLabel),
      object_id: normalizeText(args.object_id || args.objectId),
      action: normalizeText(args.action),
      user_id: normalizeText(args.user_id || args.userId),
      scoped_user_id: scopedUserId,
      ts_utc: nowIso,
      content_hash: contentHash,
      content: content ? truncateText(content, 1600) : "",
      summary: normalizeText(args.summary),
      metadata: compactMetadata(args.metadata),
      status: "pending",
      created_at: new Date().toISOString(),
    };
    this.appendJsonl(this.sourceEventDir, event);
    this.appendLog({
      event: "source_event_recorded",
      event_id: event.event_id,
      source_type: event.source_type,
      source_id: event.source_id,
      scoped_user_id: event.scoped_user_id,
      ts_utc: event.created_at,
    });
    return event;
  }

  collectWarmDuplicateClusters({ userId = "", limit = 6 } = {}) {
    if (!this.memoryService?.warmMemoryStore || typeof this.memoryService.resolveScopes !== "function") {
      return [];
    }
    try {
      const scopes = this.memoryService.resolveScopes({ userId });
      const index = this.memoryService.warmMemoryStore.readIndex(scopes.warmScope);
      const records = Object.values(index || {});
      return identifyDuplicateWarmClusters(records)
        .slice(0, Math.max(1, Number(limit) || 6))
        .map((cluster) => ({
          score: cluster.score,
          material_ids: cluster.materialIds,
          titles: cluster.records.map((record) => normalizeText(record.title)).filter(Boolean).slice(0, 6),
          source_archive_refs: uniqueStrings(cluster.records.flatMap((record) => normalizeStringList(record.source_archive_refs))).slice(0, 12),
          episode_refs: uniqueStrings(cluster.records.flatMap((record) => normalizeStringList(record.episode_refs))).slice(0, 12),
          case_refs: uniqueStrings(cluster.records.flatMap((record) => normalizeStringList(record.case_refs))).slice(0, 12),
        }));
    } catch {
      return [];
    }
  }

  collectWarmReviewCandidates({ userId = "", limit = 8 } = {}) {
    if (!this.memoryService?.warmMemoryStore || typeof this.memoryService.resolveScopes !== "function") {
      return [];
    }
    try {
      const scopes = this.memoryService.resolveScopes({ userId });
      const index = this.memoryService.warmMemoryStore.readIndex(scopes.warmScope);
      return Object.values(index || {})
        .filter((record) => record && typeof record === "object" && isWarmReviewCandidate(record))
        .sort(compareWarmReviewCandidate)
        .slice(0, Math.max(1, Number(limit) || 8))
        .map(compactWarmReviewCandidate);
    } catch {
      return [];
    }
  }

  createAttempt({
    accountId = "",
    senderId = "",
    workspaceRoot = "",
    source = {},
    nowMs = Date.now(),
  } = {}) {
    const records = Array.isArray(source.records) ? source.records : [];
    const warmDuplicateClusters = Array.isArray(source.warmDuplicateClusters)
      ? source.warmDuplicateClusters
      : [];
    const warmReviewCandidates = Array.isArray(source.warmReviewCandidates)
      ? source.warmReviewCandidates
      : [];
    const sourceRecordIds = records.map((record) => normalizeText(record.record_id)).filter(Boolean);
    const timestamps = records
      .map((record) => Date.parse(record.ts_utc || ""))
      .filter(Number.isFinite);
    const startMs = timestamps.length ? Math.min(...timestamps) : normalizeNowMs(nowMs);
    const endMs = timestamps.length ? Math.max(...timestamps) : normalizeNowMs(nowMs);
    const attemptId = `dream-${formatDateForId(new Date(normalizeNowMs(nowMs)))}-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
    return {
      attempt_id: attemptId,
      status: "created",
      account_id: normalizeText(accountId),
      sender_id: normalizeText(senderId),
      workspace_root: normalizeText(workspaceRoot),
      created_at: new Date(normalizeNowMs(nowMs)).toISOString(),
      source_window_start_utc: new Date(startMs).toISOString(),
      source_window_end_utc: new Date(endMs).toISOString(),
      source_record_ids: sourceRecordIds,
      source_records: records,
      warm_duplicate_clusters: warmDuplicateClusters,
      warm_review_candidates: warmReviewCandidates,
      receipts: [],
      retry_count: 0,
    };
  }

  buildDreamingSystemMessage(attempt = {}) {
    return {
      id: crypto.randomUUID(),
      accountId: attempt.account_id,
      senderId: attempt.sender_id,
      workspaceRoot: attempt.workspace_root,
      kind: "dreaming_opportunity",
      priority: "low",
      title: "memory_metabolism",
      text: buildDreamingTriggerText(attempt),
      metadata: {
        dreamingAttemptId: attempt.attempt_id,
        sourceRecordIds: attempt.source_record_ids,
        sourceRecordCount: attempt.source_record_ids.length,
        sourceWindowStartUtc: attempt.source_window_start_utc,
        sourceWindowEndUtc: attempt.source_window_end_utc,
        contract: "mossbridge_dreaming_v0.1",
      },
      createdAt: new Date().toISOString(),
    };
  }

  markAttemptDispatched(attemptId = "", { threadId = "", turnId = "", nowMs = Date.now() } = {}) {
    const id = normalizeText(attemptId);
    if (!id) {
      return { ok: false, error: "attempt_id is required" };
    }
    const state = this.readState();
    const attempt = state.attempts[id];
    if (!attempt) {
      return { ok: false, error: `attempt not found: ${id}` };
    }
    attempt.status = "dispatched";
    attempt.dispatched_at = new Date(normalizeNowMs(nowMs)).toISOString();
    attempt.thread_id = normalizeText(threadId);
    attempt.turn_id = normalizeText(turnId);
    this.writeState(pruneState(state));
    this.appendLog({
      event: "attempt_dispatched",
      attempt_id: id,
      thread_id: attempt.thread_id,
      turn_id: attempt.turn_id,
      ts_utc: attempt.dispatched_at,
    });
    return { ok: true, attempt };
  }

  deferAttempt(attemptId = "", {
    reason = "deferred",
    retryAfterMs = 0,
    nowMs = Date.now(),
  } = {}) {
    const id = normalizeText(attemptId);
    if (!id) {
      return { ok: false, error: "attempt_id is required" };
    }
    const normalizedNowMs = normalizeNowMs(nowMs);
    const state = this.readState();
    const attempt = state.attempts[id];
    if (!attempt) {
      return { ok: false, error: `attempt not found: ${id}` };
    }
    const nextRetryAtMs = Math.max(
      normalizedNowMs + this.getRetryDelayMs(),
      Number(retryAfterMs) || 0,
    );
    attempt.status = "retrying";
    attempt.defer_count = Math.max(0, Number(attempt.defer_count) || 0) + 1;
    attempt.retry_after = new Date(nextRetryAtMs).toISOString();
    attempt.last_error = normalizeText(reason) || "deferred";
    state.retry_after_ms = nextRetryAtMs;
    this.writeState(pruneState(state));
    this.appendLog({
      event: "attempt_deferred",
      attempt_id: id,
      reason: attempt.last_error,
      defer_count: attempt.defer_count,
      retry_after: attempt.retry_after,
      ts_utc: new Date(normalizedNowMs).toISOString(),
    });
    return {
      ok: true,
      reason: attempt.last_error,
      retry_after: attempt.retry_after,
      attempt: summarizeAttempt(attempt),
    };
  }

  recordMutation(args = {}) {
    const attemptId = normalizeText(args.attempt_id || args.attemptId);
    const sourceIds = normalizeStringList(args.source_ids || args.sourceIds || args.source_record_ids || args.sourceRecordIds);
    const validation = this.validateMutation({
      attempt_id: attemptId,
      source_ids: sourceIds,
      require_source_ids: true,
    });
    if (!validation.ok) {
      return validation;
    }
    const state = this.readState();
    const attempt = state.attempts[attemptId] || null;
    const nowIso = new Date().toISOString();
    const target = normalizeText(args.target);
    const action = normalizeText(args.action);
    const objectId = normalizeText(args.object_id || args.objectId || args.id);
    const beforeHash = normalizeText(args.before_hash || args.beforeHash)
      || hashStableJson(args.before === undefined ? null : args.before);
    const afterHash = normalizeText(args.after_hash || args.afterHash)
      || hashStableJson(args.after === undefined ? null : args.after);
    const mutation = {
      mutation_id: normalizeText(args.mutation_id || args.mutationId)
        || `mut_${hashStableJson({ attemptId, target, action, objectId, sourceIds, beforeHash, afterHash }).slice(0, 18)}`,
      attempt_id: attemptId,
      target,
      object_id: objectId,
      action,
      before_hash: beforeHash,
      after_hash: afterHash,
      source_ids: sourceIds,
      tool_name: normalizeText(args.tool_name || args.toolName),
      summary: normalizeText(args.summary),
      committed_at: nowIso,
      policy: "Server-generated mutation ledger entry. The model may report judgment, but this entry records a real tool/store mutation.",
    };
    if (!mutation.target || !mutation.action || !mutation.object_id) {
      return { ok: false, error: "target, action, and object_id are required for mutation ledger entries" };
    }
    this.appendJsonl(this.mutationLedgerDir, mutation);
    attempt.mutation_ledger = Array.isArray(attempt.mutation_ledger) ? attempt.mutation_ledger : [];
    attempt.mutation_ledger.push(mutation);
    attempt.status = "mutation_seen";
    attempt.last_mutation_at = nowIso;
    this.writeState(pruneState(state));
    this.appendLog({
      event: "mutation_committed",
      attempt_id: attemptId,
      mutation_id: mutation.mutation_id,
      target: mutation.target,
      action: mutation.action,
      object_id: mutation.object_id,
      source_ids: mutation.source_ids,
      ts_utc: nowIso,
    });
    return { ok: true, mutation, attempt: summarizeAttempt(attempt) };
  }

  validateMutation(args = {}) {
    const attemptId = normalizeText(args.attempt_id || args.attemptId);
    if (!attemptId) {
      return { ok: false, error: "metabolism_attempt_id is required for memory mutations during dreaming" };
    }
    const state = this.readState();
    const attempt = state.attempts[attemptId] || null;
    if (!attempt) {
      return { ok: false, error: `attempt not found: ${attemptId}` };
    }
    const status = normalizeText(attempt.status);
    if (["receipt_verified", "completed", "completed_partial"].includes(status)) {
      return { ok: false, error: `attempt already has a verified receipt or completion: ${attemptId}` };
    }
    if (!["queued", "dispatched", "mutation_seen", "receipt_failed"].includes(status)) {
      return { ok: false, error: `attempt is not open for memory mutation: ${status || "(unknown)"}` };
    }
    const sourceIds = normalizeStringList(args.source_ids || args.sourceIds || args.source_record_ids || args.sourceRecordIds);
    if (args.require_source_ids !== false && !sourceIds.length) {
      return { ok: false, error: "source_record_ids are required for memory mutations during dreaming" };
    }
    const attemptSourceIds = new Set(normalizeStringList(attempt.source_record_ids));
    const invalidSourceIds = sourceIds.filter((id) => !attemptSourceIds.has(id));
    if (invalidSourceIds.length) {
      return {
        ok: false,
        error: `mutation source ids do not belong to attempt: ${invalidSourceIds.join(", ")}`,
        invalid_source_ids: invalidSourceIds,
      };
    }
    return { ok: true, attempt: summarizeAttempt(attempt) };
  }

  hasActiveAttempt(nowMs = Date.now()) {
    return Boolean(findActiveAttempt(this.readState(), nowMs));
  }

  hasActiveAttemptForContext({
    threadId = "",
    nowMs = Date.now(),
  } = {}) {
    const active = findActiveAttempt(this.readState(), nowMs);
    if (!active) {
      return false;
    }
    const currentThreadId = normalizeText(threadId);
    if (currentThreadId && normalizeText(active.thread_id) === currentThreadId) {
      return true;
    }
    return false;
  }

  recordReceipt(args = {}) {
    const attemptId = normalizeText(args.attempt_id || args.attemptId);
    if (!attemptId) {
      throw new Error("attempt_id is required");
    }
    const state = this.readState();
    const attempt = state.attempts[attemptId] || null;
    const ledger = attempt ? this.readMutationLedgerForAttempt(attemptId, attempt) : [];
    const mutationCount = ledger.length;
    const status = normalizeReceiptStatus(args.status, mutationCount);
    const sourceRecordIds = normalizeStringList(args.source_record_ids || args.sourceRecordIds);
    const verification = verifyReceipt({
      attempt,
      status,
      ledger,
      requestedSourceIds: sourceRecordIds,
      dispositions: normalizeSourceDispositions(
        args.source_dispositions
          || args.sourceDispositions
          || args.dispositions,
      ),
    });
    const receipt = {
      receipt_id: `receipt-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      attempt_id: attemptId,
      attempt_known: Boolean(attempt),
      status,
      ok: verification.ok,
      mutation_count: mutationCount,
      source_record_ids: verification.source_record_ids,
      completed_source_record_ids: verification.completed_source_record_ids,
      retry_source_record_ids: verification.retry_source_record_ids,
      source_dispositions: verification.source_dispositions,
      mutations: compactMutationLedger(ledger),
      summary: normalizeText(args.summary),
      error: normalizeText(args.error) || verification.error,
      verification,
      ts_utc: new Date().toISOString(),
      policy: "Receipt stores model judgment plus server verification. Tool-host mutation ledger, not model self-report, proves memory writes.",
    };

    if (attempt) {
      attempt.receipts = Array.isArray(attempt.receipts) ? attempt.receipts : [];
      attempt.receipts.push(receipt);
      attempt.source_dispositions = {
        ...(attempt.source_dispositions && typeof attempt.source_dispositions === "object" ? attempt.source_dispositions : {}),
        ...Object.fromEntries(receipt.source_dispositions.map((item) => [item.source_id, item])),
      };
      attempt.status = receipt.ok ? "receipt_verified" : "receipt_failed";
      attempt.last_receipt_at = receipt.ts_utc;
      attempt.last_error = receipt.ok ? "" : (receipt.error || "metabolism receipt did not pass server verification");
      this.writeState(pruneState(state));
    }
    this.appendLog({
      event: "receipt_recorded",
      ...receipt,
    });
    return {
      ok: receipt.ok,
      receipt,
      attempt: attempt ? summarizeAttempt(attempt) : null,
    };
  }

  completeRuntimeAttempt({
    systemTurn = null,
    eventType = "",
    assistantTextFinal = "",
    writebackResult = null,
    writebackError = null,
    nowMs = Date.now(),
  } = {}) {
    if (!isDreamingSystemTurn(systemTurn)) {
      return { handled: false, reason: "not_dreaming_turn" };
    }
    const attemptId = resolveDreamingAttemptId(systemTurn);
    if (!attemptId) {
      return { handled: true, ok: false, reason: "missing_attempt_id" };
    }
    const normalizedNowMs = normalizeNowMs(nowMs);
    const state = this.readState();
    const attempt = state.attempts[attemptId];
    if (!attempt) {
      this.appendLog({
        event: "completion_unknown_attempt",
        attempt_id: attemptId,
        event_type: normalizeText(eventType),
        ts_utc: new Date(normalizedNowMs).toISOString(),
      });
      return { handled: true, ok: false, reason: "unknown_attempt" };
    }

    if (normalizeText(eventType) !== "runtime.turn.completed") {
      return this.markAttemptFailed(state, attempt, "runtime_turn_failed", {
        eventType,
        assistantTextFinal,
        writebackError,
        nowMs: normalizedNowMs,
      });
    }
    if (writebackError || writebackResult?.ok === false) {
      return this.markAttemptFailed(state, attempt, "conversation_writeback_failed", {
        eventType,
        assistantTextFinal,
        writebackError,
        nowMs: normalizedNowMs,
      });
    }

    const receipt = findLatestSuccessfulReceipt(attempt);
    if (!receipt) {
      return this.markAttemptFailed(state, attempt, "missing_metabolism_receipt", {
        eventType,
        assistantTextFinal,
        writebackError,
        nowMs: normalizedNowMs,
      });
    }
    const latestLedger = this.readMutationLedgerForAttempt(attemptId, attempt);
    if (latestLedger.length !== Number(receipt.mutation_count || 0)) {
      return this.markAttemptFailed(state, attempt, "stale_metabolism_receipt", {
        eventType,
        assistantTextFinal,
        writebackError,
        nowMs: normalizedNowMs,
      });
    }
    const completionVerification = verifyReceipt({
      attempt,
      status: receipt.status,
      ledger: latestLedger,
      requestedSourceIds: receipt.source_record_ids,
      dispositions: receipt.source_dispositions,
    });
    if (!completionVerification.ok) {
      return this.markAttemptFailed(state, attempt, completionVerification.error || "metabolism_receipt_failed_reverification", {
        eventType,
        assistantTextFinal,
        writebackError,
        nowMs: normalizedNowMs,
      });
    }

    const completedAt = new Date(normalizedNowMs).toISOString();
    const completedSourceIds = normalizeStringList(receipt.completed_source_record_ids);
    const retrySourceIds = normalizeStringList(receipt.retry_source_record_ids);
    attempt.status = retrySourceIds.length ? "completed_partial" : "completed";
    attempt.completed_at = completedAt;
    attempt.completion = {
      event_type: normalizeText(eventType),
      receipt_id: receipt.receipt_id,
      status: receipt.status,
      mutation_count: receipt.mutation_count,
      summary: receipt.summary,
      completed_source_record_ids: completedSourceIds,
      retry_source_record_ids: retrySourceIds,
    };
    attempt.last_error = "";
    state.last_success_at = completedAt;
    state.last_successful_record_ts_utc = maxRecordTimestamp(
      filterRecordsByIds(attempt.source_records, completedSourceIds),
    ) || completedAt;
    state.completed_record_ids = mergeCompletedRecordIds(
      state.completed_record_ids,
      completedSourceIds,
    );
    state.source_record_statuses = mergeSourceRecordStatuses(
      state.source_record_statuses,
      receipt.source_dispositions,
    );
    if (retrySourceIds.length) {
      const retryAttempt = this.createRetryAttempt({
        attempt,
        retrySourceIds,
        nowMs: normalizedNowMs,
      });
      state.attempts[retryAttempt.attempt_id] = retryAttempt;
      state.retry_after_ms = Date.parse(retryAttempt.retry_after || "") || 0;
    } else {
      state.retry_after_ms = 0;
    }
    this.writeState(pruneState(state));
    this.appendLog({
      event: "attempt_completed",
      attempt_id: attempt.attempt_id,
      receipt_id: receipt.receipt_id,
      status: receipt.status,
      mutation_count: receipt.mutation_count,
      source_record_ids: completedSourceIds,
      retry_source_record_ids: retrySourceIds,
      ts_utc: completedAt,
    });
    return {
      handled: true,
      ok: true,
      attempt: summarizeAttempt(attempt),
      receipt,
    };
  }

  createRetryAttempt({ attempt = {}, retrySourceIds = [], nowMs = Date.now() } = {}) {
    const normalizedNowMs = normalizeNowMs(nowMs);
    const sourceIds = normalizeStringList(retrySourceIds);
    const sourceSet = new Set(sourceIds);
    const sourceRecords = (Array.isArray(attempt.source_records) ? attempt.source_records : [])
      .filter((record) => sourceSet.has(normalizeText(record.record_id)));
    const retryAfterMs = normalizedNowMs + this.getRetryDelayMs();
    const retryCount = Math.max(0, Number(attempt.retry_count) || 0) + 1;
    const sourceTimestamps = sourceRecords
      .map((record) => Date.parse(record.ts_utc || ""))
      .filter(Number.isFinite);
    return {
      attempt_id: `${normalizeText(attempt.attempt_id) || "dream"}-retry-${retryCount}-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`,
      parent_attempt_id: normalizeText(attempt.attempt_id),
      status: "retrying",
      account_id: normalizeText(attempt.account_id),
      sender_id: normalizeText(attempt.sender_id),
      workspace_root: normalizeText(attempt.workspace_root),
      created_at: new Date(normalizedNowMs).toISOString(),
      retry_after: new Date(retryAfterMs).toISOString(),
      retry_count: retryCount,
      last_error: "source_retry_pending",
      source_window_start_utc: sourceTimestamps.length
        ? new Date(Math.min(...sourceTimestamps)).toISOString()
        : normalizeText(attempt.source_window_start_utc),
      source_window_end_utc: maxRecordTimestamp(sourceRecords) || normalizeText(attempt.source_window_end_utc),
      source_record_ids: sourceIds,
      source_records: sourceRecords,
      warm_duplicate_clusters: Array.isArray(attempt.warm_duplicate_clusters) ? attempt.warm_duplicate_clusters : [],
      warm_review_candidates: Array.isArray(attempt.warm_review_candidates) ? attempt.warm_review_candidates : [],
      receipts: [],
      mutation_ledger: [],
    };
  }

  markAttemptFailed(state, attempt, reason, {
    eventType = "",
    assistantTextFinal = "",
    writebackError = null,
    nowMs = Date.now(),
  } = {}) {
    const normalizedNowMs = normalizeNowMs(nowMs);
    const retryAfterMs = normalizedNowMs + this.getRetryDelayMs();
    attempt.status = "retrying";
    attempt.retry_count = Math.max(0, Number(attempt.retry_count) || 0) + 1;
    attempt.retry_after = new Date(retryAfterMs).toISOString();
    attempt.last_status = normalizeText(eventType);
    attempt.last_error = normalizeText(reason)
      || normalizeText(writebackError?.message)
      || normalizeText(assistantTextFinal)
      || "dreaming attempt failed";
    state.retry_after_ms = retryAfterMs;
    this.writeState(pruneState(state));
    this.appendLog({
      event: "attempt_retry_scheduled",
      attempt_id: attempt.attempt_id,
      reason: attempt.last_error,
      retry_count: attempt.retry_count,
      retry_after: attempt.retry_after,
      event_type: normalizeText(eventType),
      ts_utc: new Date(normalizedNowMs).toISOString(),
    });
    return {
      handled: true,
      ok: false,
      reason: attempt.last_error,
      retry_after: attempt.retry_after,
      attempt: summarizeAttempt(attempt),
    };
  }

  getQuietWindowMs() {
    return resolvePositiveMsFromMinutes(
      this.config.dreamingQuietMinutes,
      DEFAULT_QUIET_WINDOW_MS,
    );
  }

  getRetryDelayMs() {
    return resolvePositiveMsFromMinutes(
      this.config.dreamingRetryMinutes,
      DEFAULT_RETRY_DELAY_MS,
    );
  }

  getWindowHours() {
    return Math.max(1, Number(this.config.dreamingWindowHours) || DEFAULT_WINDOW_HOURS);
  }

  getMaxSourceRecords() {
    return Math.max(1, Math.min(Number(this.config.dreamingMaxSourceRecords) || DEFAULT_MAX_SOURCE_RECORDS, 80));
  }

  getMinSourceRecords() {
    return Math.max(1, Math.min(Number(this.config.dreamingMinSourceRecords) || DEFAULT_MIN_SOURCE_RECORDS, this.getMaxSourceRecords()));
  }

  readState() {
    try {
      const raw = fs.readFileSync(this.stateFile, "utf8");
      const parsed = JSON.parse(raw);
      return normalizeState(parsed);
    } catch {
      return normalizeState({});
    }
  }

  writeState(state) {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    writeJsonFileAtomic(this.stateFile, normalizeState(state));
  }

  appendLog(entry = {}) {
    return this.appendJsonl(this.logDir, entry);
  }

  appendJsonl(dir, entry = {}) {
    const ts = normalizeText(entry.ts_utc || entry.tsUtc) || new Date().toISOString();
    const filePath = path.join(dir, `${ts.slice(0, 10)}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify({
      ...entry,
      ts_utc: ts,
    })}\n`, "utf8");
    return filePath;
  }

  readSourceEvents() {
    return readJsonlDir(this.sourceEventDir, MAX_SOURCE_EVENT_FILES);
  }

  readMutationLedgerForAttempt(attemptId = "", attempt = null) {
    const id = normalizeText(attemptId);
    const stateMutations = Array.isArray(attempt?.mutation_ledger) ? attempt.mutation_ledger : [];
    const diskMutations = readJsonlDir(this.mutationLedgerDir, MAX_LEDGER_FILES)
      .filter((entry) => normalizeText(entry.attempt_id || entry.attemptId) === id);
    return uniqueMutations([...stateMutations, ...diskMutations])
      .sort((left, right) => String(left.committed_at || "").localeCompare(String(right.committed_at || "")));
  }
}

function buildDreamingTriggerText(attempt = {}) {
  const lines = [
    `Dreaming attempt: ${attempt.attempt_id}.`,
    `Source window: ${attempt.source_window_start_utc} -> ${attempt.source_window_end_utc}.`,
    "",
    "This is a quiet memory-metabolism pass. Review the source digest, then decide whether any small grounded memory mutation belongs in Mossbridge's local brain.",
    "Memory layer contract: hot memory is active/captured context; warm memory is first-person soul diary that may be fuzzy-recalled; cold memory includes notebook, ongoing, observation, episode, case, memory_tree, source archives, and cold-root projections.",
    "Allowed routes: warm diary memory, ongoing tracks, observation journal, episode journal, case index, memory_tree/cold-root patch or version, solitude journal, or no-op when there is no durable candidate.",
    "Warm diary cards must read as inner-view 'I' memory for the soul/persona, not a user profile, external analysis, or response policy sheet. They may contain self-warning or future-use promises when the scene supports it.",
    "When warm cards decay, duplicate, or carry source_backfill_required/source:pending/dreaming:must_review, re-read the warm card plus available source, then either bind source refs, keep it warm, or sediment exact facts/structure into cold memory with source ids. Do not promote untraceable guesses.",
    "Duplicate warm-card consolidation is a first-class dreaming job: if warm cards clearly describe the same stable subject, consolidate the relationship/structure into cold memory while preserving source_material_ids, source_archive_refs, source_trace_ids, source_span_ids, episode_refs, and case_refs. Leave source warm cards in place unless an explicit cleanup path handles them.",
    "Memory writes should contain grounded, reusable user continuity. Operational failures, quota notices, debug chatter, raw hidden chain-of-thought, credentials, and ungrounded guesses stay outside memory.",
    "When you use memory-writing tools during this pass, include metabolism_attempt_id plus the exact source_record_ids/source_ids that justify that mutation. The tool host records the real server-side mutation ledger with before/after hashes; do not rely on self-reported mutation_count as proof.",
    "After reviewing every source, call mossbridge_memory_metabolism_receipt_write with this attempt_id, the examined source_record_ids, and source_dispositions. Every source id needs one shareable reason and one status: promoted, evaluated, rejected_as_noise, deferred, conflict_open, or failed_retryable.",
    "If nothing should be promoted, call the receipt tool with status=no_op and per-source rejected_as_noise/evaluated dispositions. A batch no_op without per-source reasons is incomplete and will be retried.",
    "If a source needs more evidence or a conflict is open, mark it deferred/conflict_open/failed_retryable so the bridge does not permanently consume it.",
    "A final JSON reply without a verified receipt is treated as an incomplete dreaming attempt and will be retried.",
    "Usually finish with {\"action\":\"silent\"}; contact the user only if the source records reveal a timely obligation that cannot wait.",
    "",
    "Source digest:",
    ...formatSourceDigest(attempt.source_records),
    "",
    "Warm duplicate cluster candidates:",
    ...formatWarmDuplicateClusters(attempt.warm_duplicate_clusters),
    "",
    "Warm diary review/backfill candidates:",
    ...formatWarmReviewCandidates(attempt.warm_review_candidates),
  ];
  return lines.join("\n").trim();
}

function formatSourceDigest(records = []) {
  const source = Array.isArray(records) ? records : [];
  if (!source.length) {
    return ["(no source records)"];
  }
  return source.map((record, index) => [
    `[${index + 1}] id=${record.record_id} ts=${record.ts_utc} type=${record.source_type || "conversation_cache"} source=${record.source_client || "(unknown)"} hash=${record.content_hash || "(none)"}`,
    record.query ? `user: ${truncateText(record.query, 420)}` : "",
    record.assistant_text_final ? `assistant: ${truncateText(record.assistant_text_final, 420)}` : "",
    record.content ? `content: ${truncateText(record.content, 520)}` : "",
  ].filter(Boolean).join("\n"));
}

function formatWarmDuplicateClusters(clusters = []) {
  const source = Array.isArray(clusters) ? clusters : [];
  if (!source.length) {
    return ["(none detected)"];
  }
  return source.map((cluster, index) => {
    const ids = normalizeStringList(cluster.material_ids || cluster.materialIds);
    const titles = normalizeStringList(cluster.titles);
    const sourceRefs = normalizeStringList(cluster.source_archive_refs || cluster.sourceArchiveRefs);
    const episodeRefs = normalizeStringList(cluster.episode_refs || cluster.episodeRefs);
    const caseRefs = normalizeStringList(cluster.case_refs || cluster.caseRefs);
    return [
      `[${index + 1}] score=${Number(cluster.score || 0).toFixed(3)} ids=${ids.join(", ")}`,
      titles.length ? `titles: ${titles.map((item) => truncateText(item, 120)).join(" | ")}` : "",
      sourceRefs.length ? `source_archive_refs: ${sourceRefs.join(", ")}` : "",
      episodeRefs.length ? `episode_refs: ${episodeRefs.join(", ")}` : "",
      caseRefs.length ? `case_refs: ${caseRefs.join(", ")}` : "",
    ].filter(Boolean).join("\n");
  });
}

function formatWarmReviewCandidates(candidates = []) {
  const source = Array.isArray(candidates) ? candidates : [];
  if (!source.length) {
    return ["(none detected)"];
  }
  return source.map((candidate, index) => {
    const sourceRefs = normalizeStringList(candidate.source_archive_refs || candidate.sourceArchiveRefs);
    const traceIds = normalizeStringList(candidate.source_trace_ids || candidate.sourceTraceIds);
    const spanIds = normalizeStringList(candidate.source_span_ids || candidate.sourceSpanIds);
    const materialIds = normalizeStringList(candidate.source_material_ids || candidate.sourceMaterialIds);
    const reasons = normalizeStringList(candidate.review_reasons || candidate.reviewReasons);
    return [
      `[${index + 1}] id=${normalizeText(candidate.material_id)} title=${truncateText(candidate.title, 120)}`,
      candidate.summary ? `summary: ${truncateText(candidate.summary, 180)}` : "",
      candidate.snippet ? `warm_diary: ${truncateText(candidate.snippet, 220)}` : "",
      reasons.length ? `review_reasons: ${reasons.join(", ")}` : "",
      candidate.source_status ? `source_status: ${normalizeText(candidate.source_status)}` : "",
      sourceRefs.length ? `source_archive_refs: ${sourceRefs.join(", ")}` : "",
      traceIds.length ? `source_trace_ids: ${traceIds.join(", ")}` : "",
      spanIds.length ? `source_span_ids: ${spanIds.join(", ")}` : "",
      materialIds.length ? `source_material_ids: ${materialIds.join(", ")}` : "",
    ].filter(Boolean).join("\n");
  });
}

function isWarmReviewCandidate(record = {}) {
  if (!record || typeof record !== "object") {
    return false;
  }
  if (record.source_backfill_required === true || record.dreaming_review_required === true) {
    return true;
  }
  const tags = recordTags(record);
  return tags.includes("source:pending") || tags.includes("dreaming:must_review");
}

function compareWarmReviewCandidate(left = {}, right = {}) {
  const priorityDelta = warmReviewPriority(right) - warmReviewPriority(left);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return String(right.updated_at || "").localeCompare(String(left.updated_at || ""));
}

function warmReviewPriority(record = {}) {
  let score = 0;
  if (record.source_backfill_required === true) score += 8;
  if (record.dreaming_review_required === true) score += 4;
  if (record.pinned === true || normalizeText(record.certainty_state) === "anchor") score += 3;
  if (record.resident === true) score += 2;
  return score;
}

function compactWarmReviewCandidate(record = {}) {
  return {
    material_id: normalizeText(record.material_id),
    title: normalizeText(record.title),
    summary: normalizeText(record.summary),
    material_type: normalizeText(record.material_type),
    memory_layer: normalizeText(record.memory_layer),
    certainty_state: normalizeText(record.certainty_state),
    pinned: record.pinned === true,
    resident: record.resident === true,
    source_status: normalizeText(record.source_status),
    source_backfill_required: record.source_backfill_required === true,
    dreaming_review_required: record.dreaming_review_required === true,
    review_reasons: buildWarmReviewReasons(record),
    source_archive_refs: normalizeStringList(record.source_archive_refs).slice(0, 12),
    source_trace_ids: normalizeStringList(record.source_trace_ids).slice(0, 12),
    source_span_ids: normalizeStringList(record.source_span_ids).slice(0, 12),
    source_material_ids: normalizeStringList(record.source_material_ids).slice(0, 12),
    provenance_refs: normalizeStringList(record.provenance_refs).slice(0, 12),
    episode_refs: normalizeStringList(record.episode_refs).slice(0, 8),
    case_refs: normalizeStringList(record.case_refs).slice(0, 8),
    snippet: truncateText(normalizeText(record.body_markdown || record.summary), 260),
    updated_at: normalizeText(record.updated_at),
  };
}

function buildWarmReviewReasons(record = {}) {
  const reasons = [];
  if (record.source_backfill_required === true) reasons.push("source_backfill_required");
  if (record.dreaming_review_required === true) reasons.push("dreaming_review_required");
  const tags = recordTags(record);
  if (tags.includes("source:pending")) reasons.push("tag:source:pending");
  if (tags.includes("dreaming:must_review")) reasons.push("tag:dreaming:must_review");
  if (record.pinned === true || normalizeText(record.certainty_state) === "anchor") reasons.push("resident_or_anchor");
  return uniqueStrings(reasons);
}

function identifyDuplicateWarmClusters(warmRecords = [], { minSimilarity = 0.50, scanLimit = 240 } = {}) {
  const records = (Array.isArray(warmRecords) ? warmRecords : [])
    .slice(0, Math.max(1, Number(scanLimit) || 240))
    .filter((record) => record && typeof record === "object" && isDuplicateClusterCandidate(record));
  if (records.length < 2) {
    return [];
  }
  const parent = records.map((_, index) => index);
  const pairScores = new Map();
  const find = (index) => {
    let current = index;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]];
      current = parent[current];
    }
    return current;
  };
  const union = (left, right) => {
    const rootLeft = find(left);
    const rootRight = find(right);
    if (rootLeft !== rootRight) {
      parent[rootRight] = rootLeft;
    }
  };
  for (let leftIndex = 0; leftIndex < records.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < records.length; rightIndex += 1) {
      const score = warmDuplicateScore(records[leftIndex], records[rightIndex]);
      if (score < Number(minSimilarity)) {
        continue;
      }
      pairScores.set(`${leftIndex}:${rightIndex}`, score);
      union(leftIndex, rightIndex);
    }
  }
  const groups = new Map();
  records.forEach((_, index) => {
    const root = find(index);
    groups.set(root, [...(groups.get(root) || []), index]);
  });
  return [...groups.values()]
    .filter((indices) => indices.length >= 2)
    .map((indices) => {
      const materialIds = uniqueStrings(indices.map((index) => normalizeText(records[index].material_id)));
      const localScores = [];
      for (const [key, score] of pairScores.entries()) {
        const [left, right] = key.split(":").map((item) => Number(item));
        if (indices.includes(left) && indices.includes(right)) {
          localScores.push(score);
        }
      }
      return {
        materialIds,
        records: indices.map((index) => records[index]),
        score: Math.max(...localScores, 0),
      };
    })
    .filter((cluster) => cluster.materialIds.length >= 2)
    .sort((left, right) => (right.score - left.score) || (right.materialIds.length - left.materialIds.length));
}

const SHORT_CYCLE_TAGS = new Set([
  "ongoing", "active", "open_loop", "deadline", "todo", "task", "in_progress", "current",
  "近期追踪", "进行中", "未收口", "待办", "任务", "热记忆", "今日场景",
]);
const CLOSED_CYCLE_TAGS = new Set(["closed", "completed", "done", "settled", "已收口", "已完成", "完成"]);
const STRUCTURAL_TAGS = new Set([
  "anchor", "identity", "relationship", "family", "person", "people", "thing", "object", "symbol",
  "nickname", "alias", "锚点", "身份", "关系", "家族", "家庭", "亲属", "人物", "人际", "象征物", "物件", "别名",
]);
const GENERIC_CLUSTER_TAGS = new Set(["rikkahub导入", "长期记忆", "legacy", "imported", "导入", "memo", "note", "dreaming", "温卡聚合", "warm_cluster"]);
const CLUSTER_STOP_TOKENS = new Set([
  "一个", "一种", "一些", "这个", "那个", "现在", "今天", "明天", "昨天", "已经", "还是", "没有", "可以", "需要",
  "觉得", "知道", "因为", "所以", "但是", "不过", "如果", "就是", "我们", "你们", "他们", "信息", "内容", "记录",
  "系统", "记忆", "温卡", "冷树", "dreaming", "用户", "长期", "导入", "年月", "月日", "年日",
]);

function isDuplicateClusterCandidate(record = {}) {
  if (!normalizeText(record.material_id)) {
    return false;
  }
  const tags = recordTags(record);
  if (tags.some((tag) => ["warm_clustered", "clustered", "superseded"].includes(tag))) {
    return false;
  }
  const shortCycle = tags.some((tag) => SHORT_CYCLE_TAGS.has(tag));
  const closed = tags.some((tag) => CLOSED_CYCLE_TAGS.has(tag));
  if (shortCycle && !closed) {
    return isStructuralRecord(record);
  }
  return true;
}

function isStructuralRecord(record = {}) {
  const tags = recordTags(record);
  if (tags.some((tag) => STRUCTURAL_TAGS.has(tag))) {
    return true;
  }
  return ["person", "relationship", "identity", "thing", "object"].includes(normalizeText(record.material_type).toLowerCase());
}

function warmDuplicateScore(left = {}, right = {}) {
  const leftTokens = clusterTokens(left);
  const rightTokens = clusterTokens(right);
  const shared = intersection(leftTokens, rightTokens);
  if (shared.size < 4) {
    return 0;
  }
  const tokenOverlap = setOverlapRatio(leftTokens, rightTokens);
  const unionSize = Math.max(1, new Set([...leftTokens, ...rightTokens]).size);
  const jaccard = shared.size / unionSize;
  const titleRatio = sequenceRatio(clusterCompareText(left.title, 140), clusterCompareText(right.title, 140));
  const summaryRatio = sequenceRatio(clusterCompareText(left.summary, 220), clusterCompareText(right.summary, 220));
  const tagOverlap = setOverlapRatio(meaningfulTags(left), meaningfulTags(right));
  const refOverlap = setOverlapRatio(warmRecordRefSet(left), warmRecordRefSet(right));
  if (refOverlap <= 0 && tagOverlap <= 0 && titleRatio < 0.32 && summaryRatio < 0.34 && tokenOverlap < 0.24) {
    return 0;
  }
  const score = Math.max(
    0.58 * titleRatio + 0.24 * summaryRatio + 0.18 * tagOverlap,
    0.40 * summaryRatio + 0.34 * tokenOverlap + 0.16 * tagOverlap + 0.18 * refOverlap,
    0.32 * jaccard + 0.34 * tokenOverlap + 0.22 * titleRatio + 0.18 * refOverlap,
  ) + (refOverlap > 0 ? 0.08 : 0);
  return Math.min(1, Number(score.toFixed(4)));
}

function clusterTokens(record = {}) {
  const text = [
    record.title,
    record.summary,
    normalizeText(record.body_markdown).slice(0, 900),
    ...normalizeStringList(record.tags),
    ...normalizeStringList(record.entities),
    ...normalizeStringList(record.aliases),
    record.storyline_id,
    record.memory_family,
  ].map(normalizeText).join(" ").toLowerCase();
  const tokens = new Set();
  text.split(/[\s,，。！？!?:：;；、【】\[\]（）()<>《》/\\|]+/u).forEach((part) => {
    const token = normalizeText(part);
    if (/^\d+(?:\.\d+)?$/.test(token)) {
      return;
    }
    if (token.length >= 2 && !CLUSTER_STOP_TOKENS.has(token)) {
      tokens.add(token);
    }
  });
  const cjk = [...text].filter((char) => char >= "\u4e00" && char <= "\u9fff");
  [2, 3].forEach((size) => {
    for (let index = 0; index <= cjk.length - size; index += 1) {
      const token = cjk.slice(index, index + size).join("");
      if (!CLUSTER_STOP_TOKENS.has(token)) {
        tokens.add(token);
      }
    }
  });
  return tokens;
}

function clusterCompareText(value, limit = 260) {
  let text = normalizeText(value).toLowerCase().slice(0, Math.max(1, Number(limit) || 260));
  text = text.replace(/20\d{2}\s*年\s*\d{1,2}\s*月\s*\d{0,2}\s*日?/g, " ");
  text = text.replace(/\d+(?:\.\d+)?/g, " ");
  ["用户", "长期记忆", "rikkahub导入"].forEach((token) => {
    text = text.replaceAll(token.toLowerCase(), " ");
  });
  return text.replace(/[\s,，。！？!?:：;；、【】\[\]（）()<>《》/\\|"“”'‘’\-]+/gu, "");
}

function sequenceRatio(left = "", right = "") {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) {
    return 0;
  }
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return (2 * dp[a.length][b.length]) / Math.max(1, a.length + b.length);
}

function recordTags(record = {}) {
  return normalizeStringList(record.tags).map((tag) => tag.toLowerCase());
}

function meaningfulTags(record = {}) {
  return new Set(recordTags(record).filter((tag) => tag && !GENERIC_CLUSTER_TAGS.has(tag)));
}

function warmRecordRefSet(record = {}) {
  return new Set([
    ...normalizeStringList(record.source_archive_refs),
    ...normalizeStringList(record.episode_refs),
    ...normalizeStringList(record.case_refs),
    ...normalizeStringList(record.provenance_refs),
  ]);
}

function setOverlapRatio(left = new Set(), right = new Set()) {
  if (!left.size || !right.size) {
    return 0;
  }
  return intersection(left, right).size / Math.max(1, Math.min(left.size, right.size));
}

function intersection(left = new Set(), right = new Set()) {
  return new Set([...left].filter((item) => right.has(item)));
}

function uniqueStrings(value = []) {
  const seen = new Set();
  const output = [];
  for (const item of Array.isArray(value) ? value : [value]) {
    const text = normalizeText(item);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    output.push(text);
  }
  return output;
}

function isDreamingSystemTurn(systemTurn = {}) {
  const kind = normalizeText(systemTurn?.trigger_kind || systemTurn?.triggerKind).toLowerCase();
  return kind === "dreaming_opportunity" || kind === "memory_metabolism";
}

function resolveDreamingAttemptId(systemTurn = {}) {
  const metadata = systemTurn?.metadata && typeof systemTurn.metadata === "object"
    ? systemTurn.metadata
    : {};
  return normalizeText(
    metadata.dreamingAttemptId
      || metadata.dreaming_attempt_id
      || metadata.attempt_id
      || metadata.attemptId,
  );
}

function normalizeState(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    version: STORE_VERSION,
    attempts: source.attempts && typeof source.attempts === "object" && !Array.isArray(source.attempts)
      ? { ...source.attempts }
      : {},
    last_queued_at: normalizeText(source.last_queued_at),
    last_success_at: normalizeText(source.last_success_at),
    last_successful_record_ts_utc: normalizeText(source.last_successful_record_ts_utc),
    retry_after_ms: Number(source.retry_after_ms) || 0,
    completed_record_ids: normalizeStringList(source.completed_record_ids),
    source_record_statuses: source.source_record_statuses && typeof source.source_record_statuses === "object" && !Array.isArray(source.source_record_statuses)
      ? { ...source.source_record_statuses }
      : {},
  };
}

function pruneState(state) {
  const normalized = normalizeState(state);
  const attempts = Object.values(normalized.attempts)
    .filter((item) => item && typeof item === "object")
    .sort((left, right) => (Date.parse(right.created_at || "") || 0) - (Date.parse(left.created_at || "") || 0))
    .slice(0, MAX_STORED_ATTEMPTS);
  normalized.attempts = {};
  for (const attempt of attempts) {
    const id = normalizeText(attempt.attempt_id);
    if (id) {
      normalized.attempts[id] = attempt;
    }
  }
  normalized.completed_record_ids = normalized.completed_record_ids.slice(-MAX_STORED_COMPLETED_RECORD_IDS);
  return normalized;
}

function findActiveAttempt(state, nowMs = Date.now()) {
  const normalizedNowMs = normalizeNowMs(nowMs);
  const attempts = Object.values(normalizeState(state).attempts);
  return attempts.find((attempt) => {
    const status = normalizeText(attempt?.status);
    if (status === "retrying") {
      const retryAfterMs = Date.parse(attempt.retry_after || "") || 0;
      return retryAfterMs > normalizedNowMs;
    }
  if (!["queued", "dispatched", "mutation_seen", "receipt_verified", "receipt_failed"].includes(status)) {
      return false;
    }
    const createdAtMs = Date.parse(attempt.created_at || "") || 0;
    return !createdAtMs || normalizedNowMs - createdAtMs < ACTIVE_ATTEMPT_MAX_AGE_MS;
  }) || null;
}

function findRetryableAttempt(state, nowMs = Date.now()) {
  const normalizedNowMs = normalizeNowMs(nowMs);
  const attempts = Object.values(normalizeState(state).attempts);
  return attempts
    .filter((attempt) => {
      if (normalizeText(attempt?.status) !== "retrying") {
        return false;
      }
      const retryAfterMs = Date.parse(attempt.retry_after || "") || Number(attempt.retry_after_ms) || 0;
      return !retryAfterMs || retryAfterMs <= normalizedNowMs;
    })
    .sort((left, right) => (Date.parse(left.created_at || "") || 0) - (Date.parse(right.created_at || "") || 0))[0] || null;
}

function isMetabolizableRecord(record = {}, { cutoffMs = 0, nowMs = Date.now(), completedIds = new Set() } = {}) {
  const recordId = normalizeText(record.record_id);
  if (!recordId || completedIds.has(recordId)) {
    return false;
  }
  const tsMs = Date.parse(record.ts_utc || "");
  if (!Number.isFinite(tsMs) || tsMs <= cutoffMs || tsMs > normalizeNowMs(nowMs) + 60_000) {
    return false;
  }
  if (normalizeText(record.status) && normalizeText(record.status) !== "ok") {
    return false;
  }
  if (normalizeText(record.error)) {
    return false;
  }
  const sourceClient = normalizeText(record.source_client).toLowerCase();
  if (sourceClient.includes("system_turn") || sourceClient.includes("diagnostic")) {
    return false;
  }
  return Boolean(normalizeText(record.query) || normalizeText(record.assistant_text_final));
}

function compactSourceRecord(record = {}) {
  const contentHash = hashStableJson({
    query: normalizeText(record.query),
    assistant_text_final: normalizeText(record.assistant_text_final),
    ts_utc: normalizeText(record.ts_utc),
  });
  return {
    record_id: normalizeText(record.record_id),
    source_type: "conversation_cache",
    source_id: normalizeText(record.record_id),
    ts_utc: normalizeText(record.ts_utc),
    source_client: normalizeText(record.source_client),
    route_id: normalizeText(record.route_id),
    thread_id: normalizeText(record.thread_id),
    model: normalizeText(record.model),
    query: normalizeText(record.query),
    assistant_text_final: normalizeText(record.assistant_text_final),
    content_hash: contentHash,
  };
}

function compactSourceEvent(event = {}) {
  const eventId = normalizeText(event.event_id || event.eventId);
  const content = normalizeText(event.content || event.text || event.summary);
  return {
    record_id: eventId,
    source_type: normalizeText(event.source_type || event.sourceType) || "memory_event",
    source_id: normalizeText(event.source_id || event.sourceId) || eventId,
    source_client: normalizeText(event.source_label || event.sourceLabel) || "memory_event",
    route_id: normalizeText(event.action),
    thread_id: normalizeText(event.object_id || event.objectId),
    model: "",
    ts_utc: normalizeText(event.ts_utc || event.tsUtc || event.created_at || event.createdAt),
    query: normalizeText(event.summary) || truncateText(content, 280),
    assistant_text_final: "",
    content: truncateText(content, 1600),
    content_hash: normalizeText(event.content_hash || event.contentHash) || hashStableJson(content),
    event_metadata: compactMetadata(event.metadata),
  };
}

function mergeSourceRecords(...groups) {
  const seen = new Set();
  const output = [];
  for (const record of groups.flat()) {
    const id = normalizeText(record?.record_id);
    const canonicalId = normalizeText(record?.source_id) || id;
    const key = canonicalId ? `source:${canonicalId}` : `record:${id}`;
    if (!id || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(record);
  }
  return output;
}

function uniqueSourceEvents(events = []) {
  const seen = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const id = normalizeText(event?.event_id || event?.eventId);
    if (!id) {
      continue;
    }
    seen.set(id, event);
  }
  return Array.from(seen.values());
}

function isMetabolizableSourceEvent(event = {}, {
  scopedUserId = "",
  userId = "",
  nowMs = Date.now(),
  completedIds = new Set(),
} = {}) {
  const eventId = normalizeText(event.event_id || event.eventId);
  const sourceId = normalizeText(event.source_id || event.sourceId);
  if (!eventId || completedIds.has(eventId) || (sourceId && completedIds.has(sourceId))) {
    return false;
  }
  const status = normalizeText(event.status).toLowerCase();
  if (status && status !== "pending") {
    return false;
  }
  const eventScopedUserId = normalizeText(event.scoped_user_id || event.scopedUserId);
  const eventUserId = normalizeText(event.user_id || event.userId);
  if (normalizeText(scopedUserId) && eventScopedUserId && eventScopedUserId !== normalizeText(scopedUserId)) {
    return false;
  }
  if (!eventScopedUserId && normalizeText(userId) && eventUserId && eventUserId !== normalizeText(userId)) {
    return false;
  }
  const tsMs = Date.parse(event.ts_utc || event.tsUtc || event.created_at || event.createdAt || "");
  if (Number.isFinite(tsMs) && tsMs > normalizeNowMs(nowMs) + 60_000) {
    return false;
  }
  return Boolean(normalizeText(event.content || event.text || event.summary || event.source_id || event.sourceId));
}

function compareRecordAsc(left, right) {
  return (Date.parse(left.ts_utc || "") || 0) - (Date.parse(right.ts_utc || "") || 0)
    || normalizeText(left.record_id).localeCompare(normalizeText(right.record_id));
}

function normalizeReceiptStatus(value, mutationCount = 0) {
  const status = normalizeText(value).toLowerCase();
  if (status === "no_op" || status === "noop" || status === "no-op") {
    return "no_op";
  }
  if (status === "failed" || status === "error") {
    return "failed";
  }
  if (status === "mutated" || status === "mutation_recorded" || Number(mutationCount) > 0) {
    return "mutated";
  }
  return "failed";
}

function normalizeMutationList(value) {
  const source = Array.isArray(value) ? value : [];
  return source
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      target: normalizeText(item.target || item.route || item.store),
      action: normalizeText(item.action || item.mode),
      id: normalizeText(item.id || item.material_id || item.track_id || item.episode_id || item.case_id || item.root_key),
      summary: normalizeText(item.summary || item.title),
    }))
    .filter((item) => item.target || item.action || item.id || item.summary)
    .slice(0, 30);
}

function normalizeSourceDispositions(value) {
  const source = Array.isArray(value) ? value : [];
  return source
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const status = normalizeSourceDispositionStatus(item.status || item.disposition);
      return {
        source_id: normalizeText(item.source_id || item.sourceId || item.record_id || item.recordId),
        status,
        reason: normalizeText(item.reason || item.summary),
        target_refs: normalizeStringList(item.target_refs || item.targetRefs || item.object_ids || item.objectIds),
      };
    })
    .filter((item) => item.source_id || item.status || item.reason)
    .slice(0, 120);
}

function normalizeSourceDispositionStatus(value) {
  const status = normalizeText(value).toLowerCase().replace(/-/g, "_");
  if (status === "rejected" || status === "noise" || status === "no_op") {
    return "rejected_as_noise";
  }
  if (status === "done" || status === "checked") {
    return "evaluated";
  }
  if (status === "mutated" || status === "promote") {
    return "promoted";
  }
  if (ALLOWED_SOURCE_DISPOSITIONS.has(status)) {
    return status;
  }
  return "";
}

function verifyReceipt({
  attempt = null,
  status = "",
  ledger = [],
  requestedSourceIds = [],
  dispositions = [],
} = {}) {
  if (!attempt) {
    return buildReceiptVerification({
      ok: false,
      error: "attempt not found",
      status,
    });
  }
  if (status === "failed") {
    return buildReceiptVerification({
      ok: false,
      error: "failed receipt cannot complete a metabolism attempt",
      status,
    });
  }
  if (!["mutated", "no_op"].includes(status)) {
    return buildReceiptVerification({
      ok: false,
      error: `unsupported receipt status: ${status || "(empty)"}`,
      status,
    });
  }
  const attemptSourceIds = normalizeStringList(attempt.source_record_ids);
  const attemptSourceSet = new Set(attemptSourceIds);
  const sourceRecordIds = normalizeStringList(requestedSourceIds).length
    ? normalizeStringList(requestedSourceIds)
    : attemptSourceIds;
  const invalidSourceIds = sourceRecordIds.filter((id) => !attemptSourceSet.has(id));
  if (invalidSourceIds.length) {
    return buildReceiptVerification({
      ok: false,
      error: `receipt source ids do not belong to attempt: ${invalidSourceIds.join(", ")}`,
      status,
      sourceRecordIds,
      invalidSourceIds,
    });
  }
  const receiptSourceSet = new Set(sourceRecordIds);
  const missingAttemptSourceIds = attemptSourceIds.filter((id) => !receiptSourceSet.has(id));
  if (missingAttemptSourceIds.length) {
    return buildReceiptVerification({
      ok: false,
      error: `receipt must cover every attempt source id: ${missingAttemptSourceIds.join(", ")}`,
      status,
      sourceRecordIds,
      missingAttemptSourceIds,
    });
  }
  const dispositionById = new Map();
  for (const disposition of dispositions) {
    if (!disposition.source_id) {
      continue;
    }
    dispositionById.set(disposition.source_id, disposition);
  }
  const missingDispositionIds = sourceRecordIds.filter((id) => !dispositionById.has(id));
  if (missingDispositionIds.length) {
    return buildReceiptVerification({
      ok: false,
      error: `source dispositions required for every receipt source: ${missingDispositionIds.join(", ")}`,
      status,
      sourceRecordIds,
      missingDispositionIds,
      sourceDispositions: Array.from(dispositionById.values()),
    });
  }
  const normalizedDispositions = sourceRecordIds.map((id) => {
    const disposition = dispositionById.get(id) || {};
    return {
      source_id: id,
      status: disposition.status,
      reason: disposition.reason,
      target_refs: normalizeStringList(disposition.target_refs),
    };
  });
  const invalidDispositions = normalizedDispositions
    .filter((item) => !ALLOWED_SOURCE_DISPOSITIONS.has(item.status) || !item.reason)
    .map((item) => item.source_id);
  if (invalidDispositions.length) {
    return buildReceiptVerification({
      ok: false,
      error: `each source disposition needs an allowed status and reason: ${invalidDispositions.join(", ")}`,
      status,
      sourceRecordIds,
      sourceDispositions: normalizedDispositions,
    });
  }
  const retrySourceIds = normalizedDispositions
    .filter((item) => RETRY_SOURCE_DISPOSITIONS.has(item.status) || item.status === "pending")
    .map((item) => item.source_id);
  const completedSourceIds = normalizedDispositions
    .filter((item) => COMPLETED_SOURCE_DISPOSITIONS.has(item.status))
    .map((item) => item.source_id);
  const ledgerSourceIds = new Set(normalizeStringList(ledger.flatMap((mutation) => mutation.source_ids || mutation.sourceIds)));
  const invalidLedgerSourceIds = [...ledgerSourceIds].filter((id) => !attemptSourceSet.has(id));
  if (invalidLedgerSourceIds.length) {
    return buildReceiptVerification({
      ok: false,
      error: `mutation ledger has source ids outside attempt: ${invalidLedgerSourceIds.join(", ")}`,
      status,
      sourceRecordIds,
      invalidLedgerSourceIds,
      sourceDispositions: normalizedDispositions,
    });
  }
  const promotedSourceIds = normalizedDispositions
    .filter((item) => item.status === "promoted")
    .map((item) => item.source_id);
  if (status === "mutated") {
    if (!ledger.length) {
      return buildReceiptVerification({
        ok: false,
        error: "mutated receipt requires at least one server-generated mutation ledger entry",
        status,
        sourceRecordIds,
        sourceDispositions: normalizedDispositions,
      });
    }
    const ledgerSourceIdList = Array.from(ledgerSourceIds);
    const unprovenPromotedIds = promotedSourceIds.filter((id) => !ledgerSourceIds.has(id));
    if (unprovenPromotedIds.length) {
      return buildReceiptVerification({
        ok: false,
        error: `promoted source ids have no matching mutation ledger entry: ${unprovenPromotedIds.join(", ")}`,
        status,
        sourceRecordIds,
        sourceDispositions: normalizedDispositions,
      });
    }
    const unpromotedLedgerSourceIds = ledgerSourceIdList.filter((id) => !promotedSourceIds.includes(id));
    if (unpromotedLedgerSourceIds.length) {
      return buildReceiptVerification({
        ok: false,
        error: `mutation ledger source ids must be marked promoted: ${unpromotedLedgerSourceIds.join(", ")}`,
        status,
        sourceRecordIds,
        sourceDispositions: normalizedDispositions,
      });
    }
  }
  if (status === "no_op" && (ledger.length || promotedSourceIds.length)) {
    return buildReceiptVerification({
      ok: false,
      error: "no_op receipt cannot include committed mutations or promoted source dispositions",
      status,
      sourceRecordIds,
      sourceDispositions: normalizedDispositions,
    });
  }
  return buildReceiptVerification({
    ok: true,
    status,
    sourceRecordIds,
    completedSourceIds,
    retrySourceIds,
    sourceDispositions: normalizedDispositions,
  });
}

function buildReceiptVerification({
  ok = false,
  error = "",
  status = "",
  sourceRecordIds = [],
  completedSourceIds = [],
  retrySourceIds = [],
  invalidSourceIds = [],
  missingAttemptSourceIds = [],
  missingDispositionIds = [],
  invalidLedgerSourceIds = [],
  sourceDispositions = [],
} = {}) {
  return {
    ok: Boolean(ok),
    error: normalizeText(error),
    status: normalizeText(status),
    source_record_ids: normalizeStringList(sourceRecordIds),
    completed_source_record_ids: normalizeStringList(completedSourceIds),
    retry_source_record_ids: normalizeStringList(retrySourceIds),
    invalid_source_ids: normalizeStringList(invalidSourceIds),
    missing_attempt_source_ids: normalizeStringList(missingAttemptSourceIds),
    missing_disposition_ids: normalizeStringList(missingDispositionIds),
    invalid_ledger_source_ids: normalizeStringList(invalidLedgerSourceIds),
    source_dispositions: Array.isArray(sourceDispositions) ? sourceDispositions : [],
  };
}

function compactMutationLedger(ledger = []) {
  return (Array.isArray(ledger) ? ledger : [])
    .map((item) => ({
      mutation_id: normalizeText(item.mutation_id || item.mutationId),
      target: normalizeText(item.target),
      action: normalizeText(item.action),
      object_id: normalizeText(item.object_id || item.objectId || item.id),
      before_hash: normalizeText(item.before_hash || item.beforeHash),
      after_hash: normalizeText(item.after_hash || item.afterHash),
      source_ids: normalizeStringList(item.source_ids || item.sourceIds),
      committed_at: normalizeText(item.committed_at || item.committedAt),
      tool_name: normalizeText(item.tool_name || item.toolName),
      summary: normalizeText(item.summary),
    }))
    .filter((item) => item.mutation_id || item.target || item.object_id)
    .slice(0, 80);
}

function findLatestSuccessfulReceipt(attempt = {}) {
  const receipts = Array.isArray(attempt.receipts) ? attempt.receipts : [];
  return receipts
    .filter((receipt) => receipt?.ok === true)
    .sort((left, right) => (Date.parse(right.ts_utc || "") || 0) - (Date.parse(left.ts_utc || "") || 0))[0] || null;
}

function maxRecordTimestamp(records = []) {
  const timestamps = (Array.isArray(records) ? records : [])
    .map((record) => Date.parse(record.ts_utc || ""))
    .filter(Number.isFinite);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : "";
}

function filterRecordsByIds(records = [], ids = []) {
  const idSet = new Set(normalizeStringList(ids));
  if (!idSet.size) {
    return [];
  }
  return (Array.isArray(records) ? records : [])
    .filter((record) => idSet.has(normalizeText(record.record_id)));
}

function mergeCompletedRecordIds(existing = [], next = []) {
  const merged = new Set(normalizeStringList(existing));
  for (const id of normalizeStringList(next)) {
    merged.add(id);
  }
  return Array.from(merged).slice(-MAX_STORED_COMPLETED_RECORD_IDS);
}

function buildClosedSourceIdSet(state = {}) {
  const normalized = normalizeState(state);
  const closed = new Set(normalized.completed_record_ids);
  Object.entries(normalized.source_record_statuses || {}).forEach(([id, record]) => {
    const sourceId = normalizeText(id);
    const status = normalizeText(record?.status || record).toLowerCase();
    if (sourceId && COMPLETED_SOURCE_DISPOSITIONS.has(status)) {
      closed.add(sourceId);
    }
  });
  return closed;
}

function mergeSourceRecordStatuses(existing = {}, dispositions = []) {
  const output = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing } : {};
  for (const disposition of Array.isArray(dispositions) ? dispositions : []) {
    const id = normalizeText(disposition?.source_id || disposition?.sourceId);
    if (!id) {
      continue;
    }
    output[id] = {
      status: normalizeText(disposition.status),
      reason: normalizeText(disposition.reason),
      updated_at: new Date().toISOString(),
    };
  }
  return output;
}

function uniqueMutations(mutations = []) {
  const seen = new Map();
  for (const mutation of Array.isArray(mutations) ? mutations : []) {
    const id = normalizeText(mutation?.mutation_id || mutation?.mutationId);
    if (!id) {
      continue;
    }
    seen.set(id, mutation);
  }
  return Array.from(seen.values());
}

function readJsonlDir(dir, maxFiles = 30) {
  try {
    let files = fs.readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort();
    const limit = Number(maxFiles);
    if (Number.isFinite(limit) && limit > 0) {
      files = files.slice(-Math.max(1, limit));
    }
    const rows = [];
    for (const fileName of files) {
      const filePath = path.join(dir, fileName);
      const raw = fs.readFileSync(filePath, "utf8");
      raw.split(/\n+/).forEach((line) => {
        const text = line.trim();
        if (!text) {
          return;
        }
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            rows.push(parsed);
          }
        } catch {
          // Ignore one damaged JSONL row; the append-only ledger should keep later rows usable.
        }
      });
    }
    return rows;
  } catch {
    return [];
  }
}

function writeJsonFileAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function hashStableJson(value) {
  return crypto.createHash("sha256")
    .update(stableStringify(value))
    .digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function compactMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const output = {};
  Object.entries(value).slice(0, 24).forEach(([key, item]) => {
    if (item === null || ["string", "number", "boolean"].includes(typeof item)) {
      output[key] = item;
      return;
    }
    if (Array.isArray(item)) {
      output[key] = item.map((entry) => (
        entry === null || ["string", "number", "boolean"].includes(typeof entry)
          ? entry
          : normalizeText(entry?.id || entry?.name || entry?.title)
      )).slice(0, 12);
    }
  });
  return output;
}

function summarizeAttempt(attempt = null) {
  if (!attempt) {
    return null;
  }
  return {
    attempt_id: normalizeText(attempt.attempt_id),
    status: normalizeText(attempt.status),
    source_record_count: normalizeStringList(attempt.source_record_ids).length,
    created_at: normalizeText(attempt.created_at),
    queued_at: normalizeText(attempt.queued_at),
    dispatched_at: normalizeText(attempt.dispatched_at),
    completed_at: normalizeText(attempt.completed_at),
    retry_after: normalizeText(attempt.retry_after),
    retry_count: Number(attempt.retry_count) || 0,
    last_error: normalizeText(attempt.last_error),
  };
}

function resolvePositiveMsFromMinutes(value, fallbackMs) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return fallbackMs;
  }
  return Math.max(1, minutes) * 60_000;
}

function normalizeNowMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : Date.now();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean);
  }
  const normalized = normalizeText(value);
  return normalized ? [normalized] : [];
}

function truncateText(value, maxLength) {
  const normalized = normalizeText(value).replace(/\s+/g, " ");
  const limit = Math.max(1, Number(maxLength) || 200);
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}...` : normalized;
}

function formatDateForId(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("");
}

module.exports = {
  MemoryMetabolismService,
  isDreamingSystemTurn,
  resolveDreamingAttemptId,
};
