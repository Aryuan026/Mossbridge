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

test("dispatchPreparedTurn applies a pending session refresh before the next normal user turn", async () => {
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
  assert.equal(completed.status, "completed");
  assert.equal(completed.oldThreadId, "old-thread");
  assert.equal(completed.newThreadId, "new-thread");
  assert.equal(completed.postRefreshGraceThreadId, "new-thread");
  assert.equal(completed.postRefreshGraceRemaining, 4);
});

test("post-refresh grace keeps fresh thread in forced recent context for a few foreground turns", () => {
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

  assert.equal(MossbridgeApp.prototype.shouldForceRecentContextForPrepared.call(appLike, prepared, "/workspace"), true);
  assert.equal(MossbridgeApp.prototype.shouldForceRecentContextForPrepared.call(appLike, prepared, "/workspace"), true);
  assert.equal(MossbridgeApp.prototype.shouldForceRecentContextForPrepared.call(appLike, prepared, "/workspace"), true);
  assert.equal(MossbridgeApp.prototype.shouldForceRecentContextForPrepared.call(appLike, prepared, "/workspace"), true);
  assert.equal(MossbridgeApp.prototype.shouldForceRecentContextForPrepared.call(appLike, prepared, "/workspace"), false);
  assert.equal(MossbridgeApp.prototype.shouldForceRecentContextForPrepared.call(appLike, {
    ...prepared,
    provider: "system",
  }, "/workspace"), false);

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

test("dispatchPreparedTurn completes a preapplied session refresh without reopening the old draft", async () => {
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
  assert.equal(completed.status, "completed");
  assert.equal(completed.oldThreadId, "old-thread");
  assert.equal(completed.newThreadId, "new-thread");
  assert.equal(completed.openingTurn, true);
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
