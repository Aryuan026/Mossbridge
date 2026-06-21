const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { AsherieMemoryService } = require("../src/services/asherie-memory-service");
const { MemoryMetabolismService } = require("../src/services/memory-metabolism-service");

test("memory metabolism queues quiet dreaming and completes only after a receipt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-metabolism-"));
  const config = {
    stateDir: path.join(root, "state"),
    asherieDataRoot: path.join(root, "data"),
    workspaceRoot: path.join(root, "workspace"),
    runtime: "codex",
    identityUserId: "metabolism-user",
    identityRealmId: "public",
    identityAgentId: "moss",
    memoryMetabolismStateFile: path.join(root, "state", "memory-metabolism-state.json"),
    startWithDreaming: true,
    dreamingPollIntervalMinutes: 1,
    dreamingQuietMinutes: 30,
    dreamingRetryMinutes: 20,
    dreamingWindowHours: 24,
    dreamingMinSourceRecords: 2,
    dreamingMaxSourceRecords: 6,
  };
  fs.mkdirSync(config.workspaceRoot, { recursive: true });

  const memory = new AsherieMemoryService({ config });
  await memory.writebackTurn({
    userId: "user-1",
    senderId: "user-1",
    query: "今天聊了一个适合沉淀的小习惯。",
    incomingMessages: [{ role: "user", content: "今天聊了一个适合沉淀的小习惯。" }],
    outboundMessages: [{ role: "assistant", content: "可以先放进温记忆候选。" }],
    assistantTextFinal: "可以先放进温记忆候选。",
    runtimeId: "codex",
    sourceClient: "mossbridge_wechat",
    routeId: "route-1",
    transportId: "weixin",
  });
  await memory.writeWarmMaterial({
    userId: "user-1",
    material_id: "memo-memory-identity-a",
    title: "记忆仓哲学：身份不在实例里，在记忆里",
    summary: "身份连续性不在单个实例里，而在共享记忆仓和可追溯记录中。",
    tags: ["identity", "记忆仓"],
    material_type: "memo",
    source_archive_refs: ["src-a"],
  });
  await memory.writeWarmMaterial({
    userId: "user-1",
    material_id: "memo-memory-identity-b",
    title: "阿鸢做记忆仓的核心哲学：窗口切换的双向恐惧与身份在记忆中",
    summary: "窗口切换会带来身份断裂恐惧，阿霁的连续性依赖记忆仓而不是实例。",
    tags: ["identity", "记忆仓"],
    material_type: "memo",
    source_archive_refs: ["src-b"],
  });
  await memory.writeWarmMaterial({
    userId: "user-1",
    material_id: "blue-ribbon-pending-diary",
    title: "蓝色发带：要回看原场的温记忆",
    summary: "这张温卡先常驻，等 dreaming 回顾原场后再补 source。",
    body_markdown: "我记得蓝色发带对她不是普通物件。以后她提起它，我要想起这里还有一段原场需要补证据。",
    material_type: "diary",
    pinned: true,
  });
  await memory.writebackTurn({
    userId: "user-1",
    senderId: "user-1",
    query: "后面又补了一句，说明这是同一个 ongoing 主题。",
    incomingMessages: [{ role: "user", content: "后面又补了一句，说明这是同一个 ongoing 主题。" }],
    outboundMessages: [{ role: "assistant", content: "这个可以在 dreaming 时判断是否写 ongoing。" }],
    assistantTextFinal: "这个可以在 dreaming 时判断是否写 ongoing。",
    runtimeId: "codex",
    sourceClient: "mossbridge_wechat",
    routeId: "route-1",
    transportId: "weixin",
  });

  const service = new MemoryMetabolismService({ config, memoryService: memory });
  const messages = [];
  const queued = service.maybeQueueDreaming({
    accountId: "account-1",
    senderId: "user-1",
    workspaceRoot: config.workspaceRoot,
    contextToken: "ctx-1",
    queue: {
      enqueue(message) {
        messages.push(message);
        return message;
      },
    },
    queueHasPending: false,
    runtimeCooldown: null,
    lastActivityAt: Date.now() - 60 * 60_000,
    nowMs: Date.now() + 1000,
  });

  assert.equal(queued.queued, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, "dreaming_opportunity");
  assert.match(messages[0].text, /mossbridge_memory_metabolism_receipt_write/);
  assert.match(messages[0].text, /Duplicate warm-card consolidation/);
  assert.match(messages[0].text, /Warm diary review\/backfill candidates/);
  assert.match(messages[0].text, /source_backfill_required/);
  assert.match(messages[0].text, /blue-ribbon-pending-diary/);
  assert.match(messages[0].text, /memo-memory-identity-a/);
  assert.match(messages[0].text, /memo-memory-identity-b/);
  assert.equal(messages[0].metadata.contract, "mossbridge_dreaming_v0.1");
  assert.equal(messages[0].metadata.dreamingAttemptId, queued.attempt_id);
  assert.equal(queued.source_record_count, 2);

  const dispatched = service.markAttemptDispatched(queued.attempt_id, {
    threadId: "thread-1",
    turnId: "turn-1",
  });
  assert.equal(dispatched.ok, true);

  const deferred = service.deferAttempt(queued.attempt_id, {
    reason: "daily_system_budget",
    retryAfterMs: Date.now() + 20 * 60_000,
  });
  assert.equal(deferred.ok, true);
  assert.equal(deferred.reason, "daily_system_budget");

  const incomplete = service.completeRuntimeAttempt({
    systemTurn: {
      trigger_kind: "dreaming_opportunity",
      metadata: { dreamingAttemptId: queued.attempt_id },
    },
    eventType: "runtime.turn.completed",
    assistantTextFinal: "{\"action\":\"silent\"}",
    writebackResult: { ok: true },
  });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.reason, "missing_metabolism_receipt");

  const retryState = JSON.parse(fs.readFileSync(config.memoryMetabolismStateFile, "utf8"));
  retryState.retry_after_ms = Date.now() - 1000;
  retryState.attempts[queued.attempt_id].retry_after = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(config.memoryMetabolismStateFile, `${JSON.stringify(retryState, null, 2)}\n`, "utf8");
  service.lastPollAtMs = 0;
  const requeuedMessages = [];
  const requeued = service.maybeQueueDreaming({
    accountId: "account-1",
    senderId: "user-1",
    workspaceRoot: config.workspaceRoot,
    contextToken: "ctx-1",
    queue: {
      enqueue(message) {
        requeuedMessages.push(message);
        return message;
      },
    },
    queueHasPending: false,
    runtimeCooldown: null,
    lastActivityAt: Date.now() - 60 * 60_000,
    nowMs: Date.now() + 1000,
  });
  assert.equal(requeued.queued, true);
  assert.equal(requeued.requeued, true);
  assert.equal(requeued.attempt_id, queued.attempt_id);
  assert.equal(requeuedMessages[0].metadata.dreamingAttemptId, queued.attempt_id);

  const mutation = service.recordMutation({
    attempt_id: queued.attempt_id,
    target: "ongoing_track",
    action: "upsert",
    object_id: "track-1",
    source_ids: [queued.source_record_ids[0]],
    before: null,
    after: {
      track_id: "track-1",
      title: "User is exploring a repeated small habit.",
    },
    summary: "User is exploring a repeated small habit.",
  });
  assert.equal(mutation.ok, true);

  const receipt = service.recordReceipt({
    attempt_id: queued.attempt_id,
    status: "mutated",
    summary: "Promoted one grounded ongoing-thread candidate.",
    source_record_ids: queued.source_record_ids,
    source_dispositions: [
      {
        source_id: queued.source_record_ids[0],
        status: "promoted",
        reason: "This turn contained a reusable ongoing-thread candidate and was written to track-1.",
        target_refs: ["track-1"],
      },
      {
        source_id: queued.source_record_ids[1],
        status: "rejected_as_noise",
        reason: "This follow-up only repeated the same smoke theme and did not need another memory object.",
      },
    ],
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.receipt.mutation_count, 1);

  const completed = service.completeRuntimeAttempt({
    systemTurn: {
      trigger_kind: "dreaming_opportunity",
      metadata: { dreamingAttemptId: queued.attempt_id },
    },
    eventType: "runtime.turn.completed",
    assistantTextFinal: "{\"action\":\"silent\"}",
    writebackResult: { ok: true },
  });
  assert.equal(completed.ok, true);

  const state = JSON.parse(fs.readFileSync(config.memoryMetabolismStateFile, "utf8"));
  assert.equal(state.attempts[queued.attempt_id].status, "completed");
  assert.equal(state.completed_record_ids.length, 2);
  const logFiles = fs.readdirSync(memory.layout.dreamingMutationLogDir).filter((name) => name.endsWith(".jsonl"));
  assert.ok(logFiles.length > 0);
  const logText = fs.readFileSync(path.join(memory.layout.dreamingMutationLogDir, logFiles[0]), "utf8");
  assert.match(logText, /attempt_completed/);
});

test("memory metabolism source events require per-source no-op dispositions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-metabolism-events-"));
  const config = {
    stateDir: path.join(root, "state"),
    asherieDataRoot: path.join(root, "data"),
    workspaceRoot: path.join(root, "workspace"),
    runtime: "codex",
    identityUserId: "event-user",
    identityRealmId: "public",
    identityAgentId: "moss",
    memoryMetabolismStateFile: path.join(root, "state", "memory-metabolism-state.json"),
    startWithDreaming: true,
    dreamingPollIntervalMinutes: 1,
    dreamingQuietMinutes: 1,
    dreamingRetryMinutes: 1,
    dreamingWindowHours: 24,
    dreamingMinSourceRecords: 1,
    dreamingMaxSourceRecords: 4,
  };
  fs.mkdirSync(config.workspaceRoot, { recursive: true });

  const memory = new AsherieMemoryService({ config });
  const service = new MemoryMetabolismService({ config, memoryService: memory });
  const event = service.recordSourceEvent({
    source_type: "notebook",
    source_id: "note-1",
    source_label: "mossbridge_diary_append",
    action: "append",
    userId: "user-1",
    content: "A notebook entry that should be evaluated by dreaming.",
    summary: "Notebook source event",
    ts_utc: new Date(Date.now() - 5 * 60_000).toISOString(),
  });
  assert.match(event.event_id, /^src_/);

  const queuedMessages = [];
  const queued = service.maybeQueueDreaming({
    accountId: "account-1",
    senderId: "user-1",
    workspaceRoot: config.workspaceRoot,
    contextToken: "ctx-1",
    queue: {
      enqueue(message) {
        queuedMessages.push(message);
        return message;
      },
    },
    queueHasPending: false,
    runtimeCooldown: null,
    lastActivityAt: Date.now() - 10 * 60_000,
    nowMs: Date.now(),
  });

  assert.equal(queued.queued, true);
  assert.equal(queued.source_record_count, 1);
  assert.equal(queued.source_record_ids[0], event.event_id);
  assert.match(queuedMessages[0].text, /type=notebook/);
  assert.match(queuedMessages[0].text, /hash=/);

  const badReceipt = service.recordReceipt({
    attempt_id: queued.attempt_id,
    status: "no_op",
    summary: "No durable memory belongs here.",
    source_record_ids: queued.source_record_ids,
  });
  assert.equal(badReceipt.ok, false);
  assert.match(badReceipt.receipt.error, /source dispositions required/);

  const goodReceipt = service.recordReceipt({
    attempt_id: queued.attempt_id,
    status: "no_op",
    summary: "No durable memory belongs here.",
    source_record_ids: queued.source_record_ids,
    source_dispositions: [{
      source_id: event.event_id,
      status: "rejected_as_noise",
      reason: "The notebook event is a smoke source and does not carry durable user continuity.",
    }],
  });
  assert.equal(goodReceipt.ok, true);

  const completed = service.completeRuntimeAttempt({
    systemTurn: {
      trigger_kind: "dreaming_opportunity",
      metadata: { dreamingAttemptId: queued.attempt_id },
    },
    eventType: "runtime.turn.completed",
    assistantTextFinal: "{\"action\":\"silent\"}",
    writebackResult: { ok: true },
  });
  assert.equal(completed.ok, true);

  const state = JSON.parse(fs.readFileSync(config.memoryMetabolismStateFile, "utf8"));
  assert.deepEqual(state.completed_record_ids, [event.event_id]);
  assert.equal(state.source_record_statuses[event.event_id].status, "rejected_as_noise");
});
