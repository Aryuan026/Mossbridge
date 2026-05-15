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
  assert.equal(messages[0].metadata.dreamingAttemptId, queued.attempt_id);
  assert.equal(queued.source_record_count, 2);

  const dispatched = service.markAttemptDispatched(queued.attempt_id, {
    threadId: "thread-1",
    turnId: "turn-1",
  });
  assert.equal(dispatched.ok, true);

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

  const receipt = service.recordReceipt({
    attempt_id: queued.attempt_id,
    status: "mutated",
    summary: "Promoted one grounded ongoing-thread candidate.",
    mutation_count: 1,
    source_record_ids: queued.source_record_ids,
    mutations: [{
      target: "ongoing_track",
      action: "upsert",
      id: "track-1",
      summary: "User is exploring a repeated small habit.",
    }],
  });
  assert.equal(receipt.ok, true);

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
