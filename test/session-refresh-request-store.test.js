const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { MossbridgeApp } = require("../src/core/app");
const { SessionRefreshRequestStore } = require("../src/core/session-refresh-request-store");

test("session refresh store keeps one pending request per runtime scope", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-"));
  const store = new SessionRefreshRequestStore({
    filePath: path.join(tempRoot, "session-refresh-requests.json"),
  });

  const first = store.requestRefresh({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "claudecode",
    oldThreadId: "old-thread",
    reason: "first",
  });
  const second = store.requestRefresh({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "claudecode",
    oldThreadId: "old-thread",
    reason: "second",
  });

  assert.notEqual(first.id, second.id);
  assert.equal(store.listRequests().length, 1);
  assert.equal(store.getPendingRequest({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "claudecode",
  }).reason, "second");
});

test("session refresh store fails closed without replacing malformed state", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-invalid-"));
  const filePath = path.join(tempRoot, "session-refresh-requests.json");
  fs.writeFileSync(filePath, "{broken", "utf8");

  assert.throws(
    () => new SessionRefreshRequestStore({ filePath }),
    (error) => error?.code === "MOSSBRIDGE_SESSION_REFRESH_STATE_INVALID",
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), "{broken");
});

test("pending refresh currentness stays bound to the thread that requested it", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-"));
  const store = new SessionRefreshRequestStore({
    filePath: path.join(tempRoot, "session-refresh-requests.json"),
  });
  const request = store.requestRefresh({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "codex",
    oldThreadId: "thread-old",
  });

  assert.equal(store.getPendingRequest({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "codex",
    currentThreadId: "thread-old",
  }).id, request.id);
  assert.equal(store.getPendingRequest({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "codex",
    currentThreadId: "thread-successor",
  }), null);
  assert.equal(store.listRequests().find((entry) => entry.id === request.id).status, "pending");
});

test("pre-start failure requeues the same applied or provisional-completed refresh request", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-"));
  const store = new SessionRefreshRequestStore({
    filePath: path.join(tempRoot, "session-refresh-requests.json"),
  });
  const request = store.requestRefresh({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "codex",
    oldThreadId: "thread-old",
    reason: "context_pressure_session_refresh",
  });
  store.markApplied(request.id, {
    oldThreadId: "thread-old",
  });

  const requeued = store.requeueAfterPreStartFailure(request.id, {
    lastPreStartFailureReason: "CODEX_RPC_REQUEST_TIMEOUT",
    lastPreStartFailureThreadId: "thread-old",
  });

  assert.equal(requeued.id, request.id);
  assert.equal(requeued.status, "pending");
  assert.equal(requeued.reason, "context_pressure_session_refresh");
  assert.equal(requeued.oldThreadId, "thread-old");
  assert.equal(requeued.lastPreStartFailureReason, "CODEX_RPC_REQUEST_TIMEOUT");
  assert.equal(requeued.preStartRecoveryCount, 1);
  assert.equal(requeued.appliedAt, "");
  assert.match(requeued.lastAppliedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(requeued.lastPreStartFailureAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(store.listRequests().length, 1);
  assert.equal(store.getPendingRequest({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "codex",
  }).id, request.id);

  store.markApplied(request.id);
  store.markCompleted(request.id, { newThreadId: "thread-new" });
  const provisionalRequeue = store.requeueAfterPreStartFailure(request.id, {
    lastPreStartFailureReason: "codex_first_runtime_event_timeout",
  });
  assert.equal(provisionalRequeue.id, request.id);
  assert.equal(provisionalRequeue.status, "pending");
  assert.equal(provisionalRequeue.newThreadId, "");
  assert.equal(provisionalRequeue.postRefreshGraceRemaining, 0);
  assert.match(provisionalRequeue.lastCompletedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(provisionalRequeue.preStartRecoveryCount, 2);
});

test("dispatchPreparedTurn records successor acceptance without completing the refresh", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-"));
  const store = new SessionRefreshRequestStore({
    filePath: path.join(tempRoot, "session-refresh-requests.json"),
  });
  const request = store.requestRefresh({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "claudecode",
    oldThreadId: "old-thread",
    reason: "context_airing",
  });
  const calls = [];
  let currentThreadId = "old-thread";

  const appLike = {
    config: { runtime: "claudecode" },
    sessionRefreshRequests: store,
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          getThreadIdForWorkspace() {
            return currentThreadId;
          },
          clearPendingThreadIdForWorkspace(bindingKey, workspaceRoot) {
            calls.push(["clearPending", bindingKey, workspaceRoot]);
          },
          clearThreadIdForWorkspace(bindingKey, workspaceRoot) {
            calls.push(["clearThread", bindingKey, workspaceRoot]);
            currentThreadId = "";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "" };
          },
        };
      },
      async startFreshThreadDraft(payload) {
        calls.push(["fresh", payload.oldThreadId, payload.reason]);
      },
      async sendTextTurn(payload) {
        calls.push(["send", payload.text]);
        return { threadId: "new-thread", turnId: "turn-1", openingTurn: true };
      },
    },
    turnGateStore: {
      begin() {
        return "scope-1";
      },
      attachThread(scope, threadId) {
        calls.push(["attach", scope, threadId]);
      },
      releaseScope() {},
    },
    channelAdapter: {
      async sendTyping() {},
      async sendText() {},
    },
    streamDelivery: {
      bindReplyTargetForTurn(payload) {
        calls.push(["replyTarget", payload.threadId, payload.turnId]);
      },
    },
    runtimeContextStore: {
      setActiveContext(payload) {
        calls.push(["activeContext", payload.threadId]);
      },
    },
    rememberTurnWritebackContext() {},
    markMemoryMetabolismAttemptDispatched() {},
    scheduleRuntimeEventWatchdog() {},
    scheduleRunningTurnWatchdog() {},
    maybeApplySessionRefreshRequest: MossbridgeApp.prototype.maybeApplySessionRefreshRequest,
  };

  const dispatched = await MossbridgeApp.prototype.dispatchPreparedTurn.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    prepared: {
      workspaceId: "default",
      accountId: "account-1",
      senderId: "user-1",
      contextToken: "ctx-1",
      provider: "weixin",
      text: "hello",
    },
  });

  assert.equal(dispatched, true);
  assert.deepEqual(calls.slice(0, 4), [
    ["fresh", "old-thread", "context_airing"],
    ["clearPending", "binding-1", "/workspace"],
    ["clearThread", "binding-1", "/workspace"],
    ["send", "hello"],
  ]);
  assert.equal(store.getPendingRequest({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "claudecode",
  }), null);
  const completed = store.listRequests().find((entry) => entry.id === request.id);
  assert.equal(completed.status, "successor_started");
  assert.equal(completed.newTurnId, "turn-1");
  assert.equal(completed.completedAt, "");
  assert.equal(completed.oldThreadId, "old-thread");
  assert.equal(completed.newThreadId, "new-thread");
  assert.equal(completed.postRefreshGraceThreadId, undefined);
  assert.equal(completed.postRefreshGraceRemaining, undefined);
});

test("post-refresh grace exposes control-only continuity mode for a few foreground turns", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-"));
  const store = new SessionRefreshRequestStore({
    filePath: path.join(tempRoot, "session-refresh-requests.json"),
  });
  const request = store.requestRefresh({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "claudecode",
    oldThreadId: "old-thread",
  });
  store.markCompleted(request.id, {
    newThreadId: "new-thread",
    openingTurn: true,
  });

  const appLike = {
    config: { runtime: "claudecode", workspaceRoot: "/workspace" },
    activeAccountId: "account-1",
    sessionRefreshRequests: store,
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "new-thread";
          },
        };
      },
    },
  };
  const prepared = {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    provider: "weixin",
  };

  assert.equal(MossbridgeApp.prototype.resolveContinuityContextModeForPrepared.call(appLike, prepared, "/workspace"), "post_refresh_grace");
  assert.equal(MossbridgeApp.prototype.resolveContinuityContextModeForPrepared.call(appLike, prepared, "/workspace"), "post_refresh_grace");
  assert.equal(MossbridgeApp.prototype.resolveContinuityContextModeForPrepared.call(appLike, prepared, "/workspace"), "post_refresh_grace");
  assert.equal(MossbridgeApp.prototype.resolveContinuityContextModeForPrepared.call(appLike, prepared, "/workspace"), "post_refresh_grace");
  assert.equal(MossbridgeApp.prototype.resolveContinuityContextModeForPrepared.call(appLike, prepared, "/workspace"), "");
  assert.equal(MossbridgeApp.prototype.resolveContinuityContextModeForPrepared.call(appLike, {
    ...prepared,
    provider: "system",
  }, "/workspace"), "");

  const completed = store.listRequests().find((entry) => entry.id === request.id);
  assert.equal(completed.postRefreshGraceRemaining, 0);
});

test("session refresh requests wait through background system turns", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-"));
  const store = new SessionRefreshRequestStore({
    filePath: path.join(tempRoot, "session-refresh-requests.json"),
  });
  const request = store.requestRefresh({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "claudecode",
    oldThreadId: "old-thread",
  });

  const result = await MossbridgeApp.prototype.maybeApplySessionRefreshRequest.call({
    config: { runtime: "claudecode" },
    sessionRefreshRequests: store,
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
    },
  }, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    prepared: {
      provider: "system",
    },
  });

  assert.equal(result, null);
  assert.equal(store.listRequests().find((entry) => entry.id === request.id).status, "pending");
});

test("auto session refresh preapplies after the pressured turn completes", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-"));
  const store = new SessionRefreshRequestStore({
    filePath: path.join(tempRoot, "session-refresh-requests.json"),
  });
  const request = store.requestRefresh({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "claudecode",
    oldThreadId: "old-thread",
    reason: "context_pressure_session_refresh",
    requestedBy: "auto_context_pressure",
  });
  const calls = [];
  const controlEvents = [];
  let currentThreadId = "old-thread";

  const result = await MossbridgeApp.prototype.maybePreApplyAutoSessionRefreshAfterTurn.call({
    config: { runtime: "claudecode" },
    sessionRefreshRequests: store,
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          getThreadIdForWorkspace() {
            return currentThreadId;
          },
          clearPendingThreadIdForWorkspace(bindingKey, workspaceRoot) {
            calls.push(["clearPending", bindingKey, workspaceRoot]);
          },
          clearThreadIdForWorkspace(bindingKey, workspaceRoot) {
            calls.push(["clearThread", bindingKey, workspaceRoot]);
            currentThreadId = "";
          },
        };
      },
      async startFreshThreadDraft(payload) {
        calls.push(["fresh", payload.oldThreadId, payload.reason]);
      },
    },
    recordControlEvent(event) {
      controlEvents.push(event);
    },
  }, {
    event: {
      type: "runtime.turn.completed",
      payload: { threadId: "old-thread", turnId: "turn-1" },
    },
    linked: { bindingKey: "binding-1", workspaceRoot: "/workspace" },
  });

  assert.equal(result.id, request.id);
  assert.deepEqual(calls, [
    ["fresh", "old-thread", "context_pressure_session_refresh"],
    ["clearPending", "binding-1", "/workspace"],
    ["clearThread", "binding-1", "/workspace"],
  ]);
  assert.equal(currentThreadId, "");
  const pending = store.getPendingRequest({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "claudecode",
  });
  assert.equal(pending.id, request.id);
  assert.equal(pending.status, "pending");
  assert.equal(pending.preAppliedOldThreadId, "old-thread");
  assert.equal(pending.preAppliedBy, "runtime_turn_completed");
  assert.match(pending.preAppliedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(controlEvents[0].type, "runtime.context.session_refresh_preapplied");
});

test("auto session refresh preapply skips system runtime bindings", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-"));
  const store = new SessionRefreshRequestStore({
    filePath: path.join(tempRoot, "session-refresh-requests.json"),
  });
  const request = store.requestRefresh({
    bindingKey: "binding-system",
    workspaceRoot: "/workspace",
    runtimeId: "codex",
    oldThreadId: "system-thread",
    reason: "context_pressure_session_refresh",
    requestedBy: "auto_context_pressure",
  });

  const result = await MossbridgeApp.prototype.maybePreApplyAutoSessionRefreshAfterTurn.call({
    config: { runtime: "codex" },
    sessionRefreshRequests: store,
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
      getSessionStore() {
        return {
          getBinding() {
            return { systemRuntimeBinding: true };
          },
          getThreadIdForWorkspace() {
            return "system-thread";
          },
          clearPendingThreadIdForWorkspace() {
            throw new Error("system binding must not clear pending thread");
          },
          clearThreadIdForWorkspace() {
            throw new Error("system binding must not clear active thread");
          },
        };
      },
      async startFreshThreadDraft() {
        throw new Error("system binding must not start a fresh draft");
      },
    },
  }, {
    event: {
      type: "runtime.turn.completed",
      payload: { threadId: "system-thread", turnId: "turn-system" },
    },
    linked: { bindingKey: "binding-system", workspaceRoot: "/workspace" },
  });

  assert.equal(result, null);
  assert.equal(store.getPendingRequest({
    bindingKey: "binding-system",
    workspaceRoot: "/workspace",
    runtimeId: "codex",
  }).id, request.id);
});

test("dispatchPreparedTurn records a preapplied successor without reopening the old draft", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-"));
  const store = new SessionRefreshRequestStore({
    filePath: path.join(tempRoot, "session-refresh-requests.json"),
  });
  const request = store.requestRefresh({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "claudecode",
    oldThreadId: "old-thread",
    reason: "context_pressure_session_refresh",
    requestedBy: "auto_context_pressure",
  });
  store.updateRequest(request.id, {
    preAppliedAt: "2026-06-06T10:00:00.000Z",
    preAppliedOldThreadId: "old-thread",
    preAppliedBy: "runtime_turn_completed",
  });
  const calls = [];

  const appLike = {
    config: { runtime: "claudecode" },
    sessionRefreshRequests: store,
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          getThreadIdForWorkspace() {
            return "";
          },
          clearPendingThreadIdForWorkspace(bindingKey, workspaceRoot) {
            calls.push(["clearPending", bindingKey, workspaceRoot]);
          },
          clearThreadIdForWorkspace(bindingKey, workspaceRoot) {
            calls.push(["clearThread", bindingKey, workspaceRoot]);
          },
          getRuntimeParamsForWorkspace() {
            return { model: "" };
          },
        };
      },
      async startFreshThreadDraft(payload) {
        calls.push(["fresh", payload.oldThreadId, payload.reason]);
      },
      async sendTextTurn(payload) {
        calls.push(["send", payload.text]);
        return { threadId: "new-thread", turnId: "turn-1", openingTurn: true };
      },
    },
    turnGateStore: {
      begin() {
        return "scope-1";
      },
      attachThread(scope, threadId) {
        calls.push(["attach", scope, threadId]);
      },
      releaseScope() {},
    },
    channelAdapter: {
      async sendTyping() {},
      async sendText() {},
    },
    streamDelivery: {
      bindReplyTargetForTurn(payload) {
        calls.push(["replyTarget", payload.threadId, payload.turnId]);
      },
    },
    runtimeContextStore: {
      setActiveContext(payload) {
        calls.push(["activeContext", payload.threadId]);
      },
    },
    rememberTurnWritebackContext() {},
    markMemoryMetabolismAttemptDispatched() {},
    scheduleRuntimeEventWatchdog() {},
    scheduleRunningTurnWatchdog() {},
    maybeApplySessionRefreshRequest: MossbridgeApp.prototype.maybeApplySessionRefreshRequest,
  };

  const dispatched = await MossbridgeApp.prototype.dispatchPreparedTurn.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    prepared: {
      workspaceId: "default",
      accountId: "account-1",
      senderId: "user-1",
      contextToken: "ctx-1",
      provider: "weixin",
      text: "hello after refresh",
    },
  });

  assert.equal(dispatched, true);
  assert.equal(calls.some((entry) => entry[0] === "fresh"), false);
  assert.deepEqual(calls.slice(0, 3), [
    ["clearPending", "binding-1", "/workspace"],
    ["clearThread", "binding-1", "/workspace"],
    ["send", "hello after refresh"],
  ]);
  const completed = store.listRequests().find((entry) => entry.id === request.id);
  assert.equal(completed.status, "successor_started");
  assert.equal(completed.oldThreadId, "old-thread");
  assert.equal(completed.newThreadId, "new-thread");
  assert.equal(completed.openingTurn, true);
  assert.equal(completed.completedAt, "");
});

test("session refresh completes only after exact runtime start and settled writeback", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-"));
  const store = new SessionRefreshRequestStore({
    filePath: path.join(tempRoot, "session-refresh-requests.json"),
  });
  const request = store.requestRefresh({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "codex",
    oldThreadId: "thread-old",
  });
  store.markApplied(request.id, { causalMessageId: "message-1" });
  store.markSuccessorStarted(request.id, {
    newThreadId: "thread-new",
    newTurnId: "turn-new",
  });

  assert.equal(store.listRequests()[0].status, "successor_started");
  assert.equal(store.consumePostRefreshGrace({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "codex",
    threadId: "thread-new",
  }), null);

  store.markFirstTurnStarted({ threadId: "thread-new", turnId: "turn-new" });
  const completed = store.completeFromRuntimeOutcome({
    threadId: "thread-new",
    turnId: "turn-new",
    runtimeStatus: "completed",
    writebackSettled: true,
    assistantOutcome: "present",
  });

  assert.equal(completed.status, "completed");
  assert.equal(completed.postRefreshGraceRemaining, 4);
  assert.match(completed.completedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("session refresh fails closed without start evidence or an assistant outcome", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-terminal-"));
  const filePath = path.join(tempRoot, "session-refresh-requests.json");
  const store = new SessionRefreshRequestStore({ filePath });
  const withoutStart = store.requestRefresh({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace-a",
    runtimeId: "codex",
  });
  store.markApplied(withoutStart.id);
  store.markSuccessorStarted(withoutStart.id, { newThreadId: "thread-a", newTurnId: "turn-a" });
  const missingStart = store.completeFromRuntimeOutcome({
    threadId: "thread-a",
    turnId: "turn-a",
    runtimeStatus: "completed",
    writebackSettled: true,
    assistantOutcome: "present",
  });
  assert.equal(missingStart.status, "terminal_failed");
  assert.equal(missingStart.failureCode, "runtime_start_evidence_missing");

  const withoutOutcome = store.requestRefresh({
    bindingKey: "binding-2",
    workspaceRoot: "/workspace-b",
    runtimeId: "codex",
  });
  store.markApplied(withoutOutcome.id);
  store.markSuccessorStarted(withoutOutcome.id, { newThreadId: "thread-b", newTurnId: "turn-b" });
  store.markFirstTurnStarted({ threadId: "thread-b", turnId: "turn-b" });
  const missingOutcome = store.completeFromRuntimeOutcome({
    threadId: "thread-b",
    turnId: "turn-b",
    runtimeStatus: "completed",
    writebackSettled: true,
    assistantOutcome: "empty",
  });
  assert.equal(missingOutcome.status, "terminal_failed");
  assert.equal(missingOutcome.failureCode, "assistant_outcome_missing");
  assert.equal(missingOutcome.postRefreshGraceRemaining, undefined);
});

test("session refresh reconciles an early runtime start that arrives before the RPC response", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-early-"));
  const store = new SessionRefreshRequestStore({
    filePath: path.join(tempRoot, "session-refresh-requests.json"),
  });
  const request = store.requestRefresh({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "codex",
    oldThreadId: "thread-old",
  });
  store.markApplied(request.id, { causalMessageId: "message-1" });
  store.markFirstTurnStarted({ threadId: "thread-new", turnId: "turn-new" });

  const reconciled = store.markSuccessorStarted(request.id, {
    newThreadId: "thread-new",
    newTurnId: "turn-new",
  });

  assert.equal(reconciled.status, "first_turn_started");
  assert.match(reconciled.firstTurnStartedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("session refresh records an early terminal outcome and fails closed after RPC reconciliation", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-early-terminal-"));
  const store = new SessionRefreshRequestStore({
    filePath: path.join(tempRoot, "session-refresh-requests.json"),
  });
  const request = store.requestRefresh({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "codex",
  });
  store.markApplied(request.id);
  store.markFirstTurnStarted({ threadId: "thread-new", turnId: "turn-new" });
  store.completeFromRuntimeOutcome({
    threadId: "thread-new",
    turnId: "turn-new",
    runtimeStatus: "completed",
    writebackSettled: false,
    assistantOutcome: "present",
  });

  const reconciled = store.markSuccessorStarted(request.id, {
    newThreadId: "thread-new",
    newTurnId: "turn-new",
  });

  assert.equal(reconciled.status, "terminal_failed");
  assert.equal(reconciled.failureCode, "writeback_failed");
});

test("restart fails closed when an in-flight transition has no durable redispatch body", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-restart-"));
  const filePath = path.join(tempRoot, "session-refresh-requests.json");
  const store = new SessionRefreshRequestStore({ filePath });
  const request = store.requestRefresh({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "codex",
  });
  store.markApplied(request.id);

  const restarted = new SessionRefreshRequestStore({ filePath });
  const record = restarted.listRequests().find((entry) => entry.id === request.id);
  assert.equal(record.status, "terminal_failed");
  assert.equal(record.failureCode, "restart_pre_start_retry_body_unavailable");
});

test("first recovery request persists its superseded run in the same state write", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-superseded-"));
  const filePath = path.join(tempRoot, "session-refresh-requests.json");
  const store = new SessionRefreshRequestStore({ filePath });
  const request = store.requestRefresh({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "codex",
    causalMessageId: "message-1",
    redispatchGeneration: 1,
    supersededRun: {
      threadId: "thread-old",
      turnId: "turn-old",
      causalMessageId: "message-1",
      redispatchGeneration: 0,
      replyTarget: { contextToken: "must-not-persist" },
    },
  });

  const persisted = new SessionRefreshRequestStore({ filePath })
    .listRequests()
    .find((entry) => entry.id === request.id);
  assert.deepEqual(persisted.supersededRuns[0], {
    threadId: "thread-old",
    turnId: "turn-old",
    causalMessageId: "message-1",
    redispatchGeneration: 0,
    supersededAt: persisted.supersededRuns[0].supersededAt,
  });
  assert.equal(JSON.stringify(persisted).includes("must-not-persist"), false);
});

test("pending inbound flush preserves recovery generation and causal message identity", async () => {
  const dispatched = [];
  const appLike = {
    pendingInboundByScope: new Map(),
    channelAdapter: { async sendTyping() {} },
    recordControlEvent() {},
    isTurnDispatchBlocked() { return false; },
    async dispatchPreparedTurn(payload) {
      dispatched.push(payload.prepared);
      return true;
    },
  };
  MossbridgeApp.prototype.bufferPendingInboundMessage.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    prepared: {
      workspaceId: "default",
      accountId: "account-1",
      senderId: "user-1",
      messageId: "message-recovery",
      contextToken: "ctx-old",
      receivedAt: "2026-11-01T10:00:00.000Z",
      provider: "weixin",
      text: "recover me",
      sessionRefreshRequestId: "refresh-1",
      redispatchGeneration: 1,
    },
  });
  MossbridgeApp.prototype.bufferPendingInboundMessage.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    prepared: {
      workspaceId: "default",
      accountId: "account-1",
      senderId: "user-1",
      messageId: "message-newer",
      contextToken: "ctx-new",
      receivedAt: "2026-11-01T10:00:01.000Z",
      provider: "weixin",
      text: "newer text",
    },
  });

  await MossbridgeApp.prototype.flushPendingInboundMessages.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    ignoreBoundary: true,
  });

  assert.equal(dispatched[0].redispatchGeneration, 1);
  assert.equal(dispatched[0].messageId, "message-recovery");
  assert.equal(dispatched[0].sessionRefreshRequestId, "refresh-1");
  assert.equal(dispatched[0].contextToken, "ctx-new");
});

test("turn writeback context never borrows a different turn from the same thread", () => {
  const appLike = {
    turnWritebackContextByRunKey: new Map(),
    pendingTurnWritebackByThreadId: new Map([
      ["thread-1", { prepared: { messageId: "message-other" } }],
    ]),
  };

  const result = MossbridgeApp.prototype.consumeTurnWritebackContext.call(
    appLike,
    "thread-1",
    "turn-missing",
  );

  assert.equal(result, null);
  assert.equal(appLike.pendingTurnWritebackByThreadId.has("thread-1"), true);
});

test("codex pre-start failure requeues completed refresh and redispatches once", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-"));
  const store = new SessionRefreshRequestStore({
    filePath: path.join(tempRoot, "session-refresh-requests.json"),
  });
  const request = store.requestRefresh({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "codex",
    oldThreadId: "thread-old",
    reason: "context_pressure_session_refresh",
    requestedBy: "auto_context_pressure",
  });
  store.markApplied(request.id, { oldThreadId: "thread-old" });
  store.markCompleted(request.id, { newThreadId: "thread-new" });

  const calls = [];
  const appLike = {
    config: { runtime: "codex" },
    sessionRefreshRequests: store,
    preStartRedispatchMessageIds: new Set(),
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
      getSessionStore() {
        return {
          getThreadIdForWorkspace() {
            return "thread-new";
          },
          clearPendingThreadIdForWorkspace(bindingKey, workspaceRoot) {
            calls.push(["clearPending", bindingKey, workspaceRoot]);
          },
          clearThreadIdForWorkspace(bindingKey, workspaceRoot) {
            calls.push(["clearThread", bindingKey, workspaceRoot]);
          },
        };
      },
      async cancelTurn(payload) {
        calls.push(["cancel", payload.threadId, payload.turnId]);
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "idle" };
      },
      markRuntimeThreadUnhealthy(threadId, payload) {
        calls.push(["unhealthy", threadId, payload.reason]);
      },
    },
    turnGateStore: {
      releaseThread(threadId) {
        calls.push(["releaseThread", threadId]);
      },
      releaseScope(bindingKey, workspaceRoot) {
        calls.push(["releaseScope", bindingKey, workspaceRoot]);
      },
    },
    recordWeixinInboundAudit(payload) {
      calls.push(["audit", payload.stage, payload.includeTextPreview]);
    },
    bufferPendingInboundMessage(payload) {
      calls.push(["buffer", payload.prepared.messageId]);
    },
    async flushPendingInboundMessages(payload) {
      calls.push(["flush", payload.bindingKey, payload.workspaceRoot, payload.ignoreBoundary]);
    },
  };
  const prepared = {
    accountId: "account-1",
    senderId: "user-1",
    messageId: "msg-1",
    provider: "weixin",
    text: "hello",
    sessionRefreshRequestId: request.id,
  };

  const first = await MossbridgeApp.prototype.recoverCodexPreStartFailure.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    prepared,
    threadId: "thread-new",
    turnId: "turn-new",
    reason: "codex_first_runtime_event_timeout",
  });
  appLike.preStartRedispatchMessageIds = new Set();
  const second = await MossbridgeApp.prototype.recoverCodexPreStartFailure.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    prepared,
    threadId: "thread-new",
    turnId: "turn-new",
    reason: "codex_first_runtime_event_timeout",
  });

  assert.equal(first.redispatchQueued, true);
  assert.equal(first.refreshRequestId, request.id);
  assert.equal(second.redispatchQueued, false);
  assert.equal(second.reason, "safe_redispatch_already_used");
  assert.equal(calls.filter((entry) => entry[0] === "buffer").length, 1);
  assert.equal(calls.filter((entry) => entry[0] === "flush").length, 1);
  assert.equal(calls.find((entry) => entry[0] === "audit")[2], false);
  const pending = store.getPendingRequest({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "codex",
  });
  assert.equal(pending.id, request.id);
  assert.equal(pending.status, "pending");
  assert.equal(pending.oldThreadId, "thread-old");
  assert.equal(pending.lastPreStartFailureThreadId, "thread-new");
});

test("codex pre-start recovery does not redispatch after runtime started", async () => {
  const calls = [];
  const result = await MossbridgeApp.prototype.recoverCodexPreStartFailure.call({
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
      getSessionStore() {
        return {};
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "running", turnId: "turn-started" };
      },
    },
    preStartRedispatchMessageIds: new Set(),
    bufferPendingInboundMessage() {
      calls.push("buffer");
    },
    async flushPendingInboundMessages() {
      calls.push("flush");
    },
  }, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    prepared: {
      accountId: "account-1",
      senderId: "user-1",
      messageId: "msg-started",
      provider: "weixin",
    },
    threadId: "thread-started",
    turnId: "turn-started",
    reason: "codex_first_runtime_event_timeout",
  });

  assert.equal(result.redispatchQueued, false);
  assert.equal(result.reason, "runtime_turn_started");
  assert.deepEqual(calls, []);
});

test("codex RPC timeout before runtime start requeues the applied refresh request", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-"));
  const store = new SessionRefreshRequestStore({
    filePath: path.join(tempRoot, "session-refresh-requests.json"),
  });
  const request = store.requestRefresh({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "codex",
    oldThreadId: "thread-old",
    reason: "context_pressure_session_refresh",
    requestedBy: "auto_context_pressure",
  });
  const calls = [];
  let currentThreadId = "thread-old";
  const timeoutError = new Error("Codex RPC request timed out before response: turn/start");
  timeoutError.code = "CODEX_RPC_REQUEST_TIMEOUT";

  const appLike = {
    config: { runtime: "codex" },
    sessionRefreshRequests: store,
    preStartRedispatchMessageIds: new Set(),
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
      getSessionStore() {
        return {
          getThreadIdForWorkspace() {
            return currentThreadId;
          },
          clearPendingThreadIdForWorkspace(bindingKey, workspaceRoot) {
            calls.push(["clearPending", bindingKey, workspaceRoot]);
          },
          clearThreadIdForWorkspace(bindingKey, workspaceRoot) {
            calls.push(["clearThread", bindingKey, workspaceRoot]);
            currentThreadId = "";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "" };
          },
        };
      },
      async startFreshThreadDraft(payload) {
        calls.push(["fresh", payload.oldThreadId, payload.reason]);
      },
      async sendTextTurn() {
        throw timeoutError;
      },
    },
    turnGateStore: {
      begin() {
        return "scope-1";
      },
      releaseScope(bindingKey, workspaceRoot) {
        calls.push(["releaseScope", bindingKey, workspaceRoot]);
      },
      releaseThread(threadId) {
        calls.push(["releaseThread", threadId]);
      },
    },
    channelAdapter: {
      async sendTyping() {},
      async sendText(payload) {
        calls.push(["text", payload.text]);
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "idle" };
      },
      markRuntimeThreadUnhealthy(threadId, payload) {
        calls.push(["unhealthy", threadId, payload.reason]);
      },
    },
    recordControlEvent() {},
    recordWeixinInboundAudit(payload) {
      calls.push(["audit", payload.stage]);
    },
    bufferPendingInboundMessage(payload) {
      calls.push(["buffer", payload.prepared.messageId]);
    },
    async flushPendingInboundMessages(payload) {
      calls.push(["flush", payload.ignoreBoundary]);
    },
    maybeApplySessionRefreshRequest: MossbridgeApp.prototype.maybeApplySessionRefreshRequest,
    recoverCodexPreStartFailure: MossbridgeApp.prototype.recoverCodexPreStartFailure,
  };

  const dispatched = await MossbridgeApp.prototype.dispatchPreparedTurn.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    prepared: {
      workspaceId: "default",
      accountId: "account-1",
      senderId: "user-1",
      messageId: "msg-timeout",
      contextToken: "ctx-1",
      provider: "weixin",
      text: "hello before timeout",
    },
  });

  assert.equal(dispatched, false);
  assert.equal(calls.some((entry) => entry[0] === "text"), false);
  assert.equal(calls.some((entry) => entry[0] === "buffer"), true);
  const pending = store.getPendingRequest({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "codex",
  });
  assert.equal(pending.id, request.id);
  assert.equal(pending.status, "pending");
  assert.equal(pending.oldThreadId, "thread-old");
  assert.equal(pending.lastPreStartFailureReason, "CODEX_RPC_REQUEST_TIMEOUT");
});

test("codex first-event timeout redispatches once before visible timeout notice", async () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = [];
  global.setTimeout = (callback, delayMs) => {
    const timer = { callback, delayMs };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = () => {};

  try {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-"));
    const store = new SessionRefreshRequestStore({
      filePath: path.join(tempRoot, "session-refresh-requests.json"),
    });
    const request = store.requestRefresh({
      bindingKey: "binding-1",
      workspaceRoot: "/workspace",
      runtimeId: "codex",
      oldThreadId: "thread-old",
      reason: "context_pressure_session_refresh",
      requestedBy: "auto_context_pressure",
    });
    store.markApplied(request.id, { oldThreadId: "thread-old" });
    store.markCompleted(request.id, { newThreadId: "thread-new" });

    const calls = [];
    const appLike = {
      pendingRuntimeEventWatchdogs: new Map(),
      preStartRedispatchMessageIds: new Set(),
      sessionRefreshRequests: store,
      clearRuntimeEventWatchdog: MossbridgeApp.prototype.clearRuntimeEventWatchdog,
      recoverCodexPreStartFailure: MossbridgeApp.prototype.recoverCodexPreStartFailure,
      runtimeAdapter: {
        describe() {
          return { id: "codex" };
        },
        getSessionStore() {
          return {
            getThreadIdForWorkspace() {
              return "thread-new";
            },
            clearPendingThreadIdForWorkspace(bindingKey, workspaceRoot) {
              calls.push(["clearPending", bindingKey, workspaceRoot]);
            },
            clearThreadIdForWorkspace(bindingKey, workspaceRoot) {
              calls.push(["clearThread", bindingKey, workspaceRoot]);
            },
          };
        },
        async cancelTurn(payload) {
          calls.push(["cancel", payload.threadId, payload.turnId]);
        },
      },
      threadStateStore: {
        getThreadState() {
          return { status: "idle" };
        },
        markRuntimeThreadUnhealthy(threadId, payload) {
          calls.push(["unhealthy", threadId, payload.reason]);
        },
      },
      channelAdapter: {
        async sendTyping(payload) {
          calls.push(["typing", payload.status]);
        },
        async sendText(payload) {
          calls.push(["text", payload.text]);
        },
      },
      turnGateStore: {
        releaseThread(threadId) {
          calls.push(["releaseThread", threadId]);
        },
        releaseScope(bindingKey, workspaceRoot) {
          calls.push(["releaseScope", bindingKey, workspaceRoot]);
        },
      },
      recordWeixinInboundAudit(payload) {
        calls.push(["audit", payload.stage, payload.includeTextPreview]);
      },
      bufferPendingInboundMessage(payload) {
        calls.push(["buffer", payload.prepared.messageId]);
      },
      async flushPendingInboundMessages(payload) {
        calls.push(["flush", payload.ignoreBoundary]);
      },
    };

    MossbridgeApp.prototype.scheduleRuntimeEventWatchdog.call(appLike, {
      bindingKey: "binding-1",
      workspaceRoot: "/workspace",
      normalized: {
        provider: "weixin",
        accountId: "account-1",
        senderId: "user-1",
        messageId: "msg-first-event-timeout",
        contextToken: "ctx-1",
        sessionRefreshRequestId: request.id,
      },
      threadId: "thread-new",
      turnId: "turn-new",
      openingTurn: false,
    });

    assert.deepEqual(timers.map((timer) => timer.delayMs), [8000, 45000]);
    await timers[1].callback();

    assert.equal(calls.filter((entry) => entry[0] === "buffer").length, 1);
    assert.equal(calls.some((entry) => entry[0] === "text"), false);
    assert.equal(store.getPendingRequest({
      bindingKey: "binding-1",
      workspaceRoot: "/workspace",
      runtimeId: "codex",
    }).id, request.id);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("context pressure queues one session refresh for the next normal user turn", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-"));
  const store = new SessionRefreshRequestStore({
    filePath: path.join(tempRoot, "session-refresh-requests.json"),
  });
  const controlEvents = [];
  const appLike = {
    config: {
      runtime: "codex",
      sessionRefreshPressurePercent: 80,
      sessionRefreshMinIntervalMs: 60_000,
    },
    sessionRefreshRequests: store,
    lastAutoSessionRefreshAtByScope: new Map(),
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
      getSessionStore() {
        return {
          getBinding() {
            return { systemRuntimeBinding: false };
          },
        };
      },
    },
    recordControlEvent(event) {
      controlEvents.push(event);
    },
  };

  const request = MossbridgeApp.prototype.maybeQueueAutoSessionRefreshForPressure.call(appLike, {
    usage: {
      runtimeId: "codex",
      threadId: "thread-1",
      currentTokens: 85_000,
      contextWindow: 100_000,
    },
    linked: {
      bindingKey: "binding-1",
      workspaceRoot: "/workspace",
    },
  });
  const duplicate = MossbridgeApp.prototype.maybeQueueAutoSessionRefreshForPressure.call(appLike, {
    usage: {
      runtimeId: "codex",
      threadId: "thread-1",
      currentTokens: 90_000,
      contextWindow: 100_000,
    },
    linked: {
      bindingKey: "binding-1",
      workspaceRoot: "/workspace",
    },
  });

  assert.equal(request.reason, "context_pressure_session_refresh");
  assert.equal(duplicate.id, request.id);
  assert.equal(store.listRequests().length, 1);
  assert.equal(store.getPendingRequest({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "codex",
  }).oldThreadId, "thread-1");
  assert.equal(controlEvents.length, 1);
});

test("codex context pressure defaults to 76 percent session refresh threshold", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-"));
  const store = new SessionRefreshRequestStore({
    filePath: path.join(tempRoot, "session-refresh-requests.json"),
  });
  const controlEvents = [];
  const appLike = {
    config: {
      runtime: "codex",
      sessionRefreshMinIntervalMs: 60_000,
    },
    sessionRefreshRequests: store,
    lastAutoSessionRefreshAtByScope: new Map(),
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
      getSessionStore() {
        return {
          getBinding() {
            return { systemRuntimeBinding: false };
          },
        };
      },
    },
    recordControlEvent(event) {
      controlEvents.push(event);
    },
  };

  const request = MossbridgeApp.prototype.maybeQueueAutoSessionRefreshForPressure.call(appLike, {
    usage: {
      runtimeId: "codex",
      threadId: "thread-codex-pressure",
      currentTokens: 197_929,
      contextWindow: 258_400,
    },
    linked: {
      bindingKey: "binding-codex",
      workspaceRoot: "/workspace",
    },
  });

  assert.equal(request.reason, "context_pressure_session_refresh");
  assert.equal(controlEvents[0].payload.refreshThresholdPercent, 76);
  assert.equal(store.getPendingRequest({
    bindingKey: "binding-codex",
    workspaceRoot: "/workspace",
    runtimeId: "codex",
  }).oldThreadId, "thread-codex-pressure");
});

test("persisted Codex pressure queues only for the exact bound thread", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-"));
  const store = new SessionRefreshRequestStore({
    filePath: path.join(tempRoot, "session-refresh-requests.json"),
  });
  const appLike = {
    config: {
      runtime: "codex",
      sessionRefreshMinIntervalMs: 60_000,
    },
    sessionRefreshRequests: store,
    lastAutoSessionRefreshAtByScope: new Map(),
    runtimeContextUsageStore: {
      getContext({ threadId }) {
        if (threadId === "thread-exact") {
          return {
            runtimeId: "codex",
            threadId: "thread-exact",
            currentTokens: 197_929,
            contextWindow: 258_400,
            source: "codex_session_jsonl",
          };
        }
        return {
          runtimeId: "codex",
          threadId: "thread-other",
          currentTokens: 258_000,
          contextWindow: 258_400,
          source: "runtime_latest_fallback",
        };
      },
    },
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
      getSessionStore() {
        return {
          getBinding() {
            return { systemRuntimeBinding: false };
          },
        };
      },
    },
    recordControlEvent() {},
    maybeQueueAutoSessionRefreshForPressure: MossbridgeApp.prototype.maybeQueueAutoSessionRefreshForPressure,
  };

  const exact = MossbridgeApp.prototype.queuePersistedCodexSessionRefresh.call(appLike, {
    bindingKey: "binding-exact",
    workspaceRoot: "/workspace",
    threadId: "thread-exact",
  });
  const mismatched = MossbridgeApp.prototype.queuePersistedCodexSessionRefresh.call(appLike, {
    bindingKey: "binding-other",
    workspaceRoot: "/workspace",
    threadId: "thread-missing",
  });

  assert.equal(exact.reason, "context_pressure_session_refresh");
  assert.equal(mismatched, null);
  assert.equal(store.listRequests().length, 1);
  assert.equal(store.listRequests()[0].bindingKey, "binding-exact");
});

test("claudecode severe context pressure queues session refresh instead of auto compact", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-refresh-"));
  const store = new SessionRefreshRequestStore({
    filePath: path.join(tempRoot, "session-refresh-requests.json"),
  });
  const recorded = [];
  const controlEvents = [];
  const appLike = {
    config: {
      runtime: "claudecode",
      claudeContextWindow: 100_000,
      claudeAutoCompactEnabled: true,
      claudeAutoCompactThresholdPercent: 80,
      sessionRefreshPressurePercent: 92,
      sessionRefreshMinIntervalMs: 60_000,
    },
    sessionRefreshRequests: store,
    lastAutoSessionRefreshAtByScope: new Map(),
    pendingAutoCompactByThreadId: new Map(),
    lastAutoCompactAtByThreadId: new Map(),
    runtimeContextUsageStore: {
      recordContext(snapshot) {
        recorded.push(snapshot);
      },
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          findBindingForThreadId(threadId) {
            assert.equal(threadId, "thread-claude");
            return {
              bindingKey: "binding-claude",
              workspaceRoot: "/workspace",
            };
          },
          getBinding(bindingKey) {
            assert.equal(bindingKey, "binding-claude");
            return { systemRuntimeBinding: false };
          },
        };
      },
    },
    recordControlEvent(event) {
      controlEvents.push(event);
    },
    maybeQueueAutoSessionRefreshForPressure: MossbridgeApp.prototype.maybeQueueAutoSessionRefreshForPressure,
  };

  MossbridgeApp.prototype.recordRuntimeContextUsage.call(appLike, {
    type: "runtime.context.updated",
    payload: {
      runtimeId: "claudecode",
      threadId: "thread-claude",
      currentTokens: 93_000,
    },
  });

  const pending = store.getPendingRequest({
    bindingKey: "binding-claude",
    workspaceRoot: "/workspace",
    runtimeId: "claudecode",
  });
  assert.equal(recorded[0].contextWindow, 100_000);
  assert.equal(recorded[0].compactThresholdTokens, 80_000);
  assert.equal(pending.oldThreadId, "thread-claude");
  assert.equal(pending.reason, "context_pressure_session_refresh");
  assert.equal(appLike.pendingAutoCompactByThreadId.has("thread-claude"), false);
  assert.equal(controlEvents[0].type, "runtime.context.session_refresh_queued");
});
