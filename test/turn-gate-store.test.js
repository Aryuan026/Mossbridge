const test = require("node:test");
const assert = require("node:assert/strict");

const { MossbridgeApp } = require("../src/core/app");
const { TurnGateStore } = require("../src/core/turn-gate-store");

test("turn gate tracks pending scopes until the turn is released", () => {
  const gate = new TurnGateStore();
  const scopeKey = gate.begin("binding-1", "/workspace");

  assert.equal(scopeKey, "binding-1::/workspace");
  assert.equal(gate.isPending("binding-1", "/workspace"), true);

  gate.attachThread(scopeKey, "thread-1");
  gate.releaseThread("thread-1");

  assert.equal(gate.isPending("binding-1", "/workspace"), false);
});

test("handlePreparedMessage queues a normal inbound message while the scope is busy", async () => {
  const queued = [];
  let dispatched = false;
  const appLike = {
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "running", pendingApproval: null };
      },
    },
    turnGateStore: {
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    streamDelivery: {
      setReplyTarget() {},
    },
    pendingInboundByScope: new Map(),
    pendingImageInboundByScope: new Map(),
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    async prepareIncomingMessageForRuntime(normalized) {
      return {
        ...normalized,
        text: "prepared-user-text",
      };
    },
    async dispatchPreparedTurn() {
      dispatched = true;
      return true;
    },
    bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared }) {
      queued.push({ bindingKey, workspaceRoot, ...prepared });
    },
    isTurnDispatchBlocked: MossbridgeApp.prototype.isTurnDispatchBlocked,
    hasPendingImageInbound: MossbridgeApp.prototype.hasPendingImageInbound,
    routePreparedInbound: MossbridgeApp.prototype.routePreparedInbound,
  };

  await MossbridgeApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "acc-1",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "hello",
    receivedAt: "2026-04-13T08:00:00.000Z",
  }, { allowCommands: true });

  assert.equal(dispatched, false);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].bindingKey, "binding-1");
  assert.equal(queued[0].workspaceRoot, "/workspace");
  assert.equal(queued[0].text, "prepared-user-text");
});

test("dispatchSystemMessage yields when a local pending turn already owns the workspace thread", async () => {
  let handled = false;
  const appLike = {
    systemMessageDispatcher: {
      buildPreparedMessage() {
        return {
          workspaceId: "default",
          accountId: "acc-1",
          senderId: "user-1",
          workspaceRoot: "/workspace",
        };
      },
    },
    channelAdapter: {
      getKnownContextTokens() {
        return { "user-1": "ctx-1" };
      },
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return null;
      },
    },
    turnGateStore: {
      isPending() {
        return true;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    async handlePreparedMessage() {
      handled = true;
    },
    isTurnDispatchBlocked: MossbridgeApp.prototype.isTurnDispatchBlocked,
  };

  const dispatched = await MossbridgeApp.prototype.dispatchSystemMessage.call(appLike, {
    senderId: "user-1",
    id: "system-1",
    text: "ping",
  });

  assert.equal(dispatched, false);
  assert.equal(handled, false);
});

test("handlePreparedMessage queues while the scope is in a turn-boundary handoff", async () => {
  const queued = [];
  let dispatched = false;
  const appLike = {
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "completed", pendingApproval: null };
      },
    },
    turnGateStore: {
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(["binding-1::/workspace"]),
    streamDelivery: {
      setReplyTarget() {},
    },
    pendingInboundByScope: new Map(),
    pendingImageInboundByScope: new Map(),
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    async prepareIncomingMessageForRuntime(normalized) {
      return {
        ...normalized,
        text: "prepared-user-text",
      };
    },
    async dispatchPreparedTurn() {
      dispatched = true;
      return true;
    },
    bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared }) {
      queued.push({ bindingKey, workspaceRoot, ...prepared });
    },
    isTurnDispatchBlocked: MossbridgeApp.prototype.isTurnDispatchBlocked,
    hasPendingImageInbound: MossbridgeApp.prototype.hasPendingImageInbound,
    routePreparedInbound: MossbridgeApp.prototype.routePreparedInbound,
  };

  await MossbridgeApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "acc-1",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "hello",
    receivedAt: "2026-04-13T08:00:00.000Z",
  }, { allowCommands: true });

  assert.equal(dispatched, false);
  assert.equal(queued.length, 1);
});

test("dispatchPreparedTurn binds reply target to the explicit turn id when runtime returns one", async () => {
  const turnBindings = [];
  const queuedBindings = [];
  const order = [];
  const appLike = {
    channelAdapter: {
      async sendTyping() {
        order.push("typing");
      },
      async sendText() {},
    },
    turnGateStore: {
      begin() {
        order.push("begin");
        return "binding-1::/workspace";
      },
      attachThread() {},
      releaseScope() {},
    },
    runtimeAdapter: {
      async sendTextTurn() {
        return { threadId: "thread-1", turnId: "turn-1" };
      },
      getSessionStore() {
        return {
          getRuntimeParamsForWorkspace() {
            return { model: "gpt-5.4" };
          },
        };
      },
    },
    streamDelivery: {
      bindReplyTargetForTurn(payload) {
        turnBindings.push(payload);
      },
      queueReplyTargetForThread(threadId, target) {
        queuedBindings.push({ threadId, target });
      },
    },
    rememberTurnWritebackContext() {},
    scheduleRuntimeEventWatchdog() {},
  };

  const dispatched = await MossbridgeApp.prototype.dispatchPreparedTurn.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    prepared: {
      workspaceId: "default",
      accountId: "acc-1",
      senderId: "user-1",
      contextToken: "ctx-1",
      provider: "system",
      text: "ping",
    },
  });

  assert.equal(dispatched, true);
  assert.deepEqual(turnBindings, [{
    threadId: "thread-1",
    turnId: "turn-1",
    target: {
      userId: "user-1",
      contextToken: "ctx-1",
      provider: "system",
    },
  }]);
  assert.deepEqual(queuedBindings, []);
  assert.deepEqual(order, ["begin", "typing"]);
});

test("dispatchPreparedTurn marks claudecode opening turns for a slower watchdog", async () => {
  const watchdogCalls = [];
  const appLike = {
    channelAdapter: {
      async sendTyping() {},
      async sendText() {},
    },
    turnGateStore: {
      begin() {
        return "binding-1::/workspace";
      },
      attachThread() {},
      releaseScope() {},
    },
    runtimeAdapter: {
      async sendTextTurn() {
        return { threadId: "thread-1", turnId: "turn-1", openingTurn: true };
      },
      getSessionStore() {
        return {
          getRuntimeParamsForWorkspace() {
            return { model: "" };
          },
        };
      },
      describe() {
        return { id: "claudecode" };
      },
    },
    streamDelivery: {
      bindReplyTargetForTurn() {},
      queueReplyTargetForThread() {},
    },
    scheduleRuntimeEventWatchdog(payload) {
      watchdogCalls.push(payload);
    },
    runtimeContextStore: {
      setActiveContext() {},
    },
    rememberTurnWritebackContext() {},
  };

  const dispatched = await MossbridgeApp.prototype.dispatchPreparedTurn.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    prepared: {
      workspaceId: "default",
      accountId: "acc-1",
      senderId: "user-1",
      contextToken: "ctx-1",
      provider: "weixin",
      text: "hello",
    },
  });

  assert.equal(dispatched, true);
  assert.equal(watchdogCalls.length, 1);
  assert.equal(watchdogCalls[0].openingTurn, true);
});

test("completed turns flush queued inbound work before system messages", async () => {
  const calls = [];
  const appLike = {
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return {
              bindingKey: "binding-1",
              workspaceRoot: "/workspace",
            };
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {
        calls.push("releaseThread");
      },
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    hasPendingInboundMessage() {
      return false;
    },
    async writebackRuntimeTurn() {},
    async stopTypingForThread() {
      calls.push("stopTyping");
    },
    async sendFailureToThread() {
      calls.push("sendFailure");
    },
    async flushPendingInboundMessages({ ignoreBoundary } = {}) {
      calls.push(`flushInbound:${ignoreBoundary ? "ignoreBoundary" : "default"}`);
    },
    async flushPendingSystemMessages() {
      calls.push("flushSystem");
    },
  };

  await MossbridgeApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.turn.completed",
    payload: { threadId: "thread-1", turnId: "turn-1" },
  });

  assert.deepEqual(calls, ["releaseThread", "flushInbound:ignoreBoundary", "flushSystem", "stopTyping"]);
});

test("completed turns keep the boundary closed until queued inbound work has been flushed", async () => {
  const calls = [];
  const appLike = {
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return {
              bindingKey: "binding-1",
              workspaceRoot: "/workspace",
            };
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {
        calls.push("releaseThread");
      },
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    hasPendingInboundMessage() {
      return true;
    },
    async writebackRuntimeTurn() {},
    async stopTypingForThread() {
      calls.push("stopTyping");
    },
    async sendFailureToThread() {},
    async flushPendingInboundMessages({ ignoreBoundary } = {}) {
      calls.push(`flushInbound:${ignoreBoundary ? "ignoreBoundary" : "default"}`);
      assert.equal(this.turnBoundaryScopeKeys.has("binding-1::/workspace"), true);
    },
    async flushPendingSystemMessages() {
      calls.push("flushSystem");
    },
  };

  await MossbridgeApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.turn.completed",
    payload: { threadId: "thread-1", turnId: "turn-1" },
  });

  assert.deepEqual(calls, ["releaseThread", "flushInbound:ignoreBoundary", "flushSystem"]);
  assert.equal(appLike.turnBoundaryScopeKeys.has("binding-1::/workspace"), false);
});

test("completed turns flush queued inbound work before system messages", async () => {
  const calls = [];
  const appLike = {
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return null;
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {
        calls.push("releaseThread");
      },
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    hasPendingInboundMessage() {
      return false;
    },
    async writebackRuntimeTurn() {},
    async stopTypingForThread() {
      calls.push("stopTyping");
    },
    async sendFailureToThread() {
      calls.push("sendFailure");
    },
    async flushPendingInboundMessages() {
      calls.push("flushInbound");
    },
    async flushPendingSystemMessages() {
      calls.push("flushSystem");
    },
  };

  await MossbridgeApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.turn.completed",
    payload: { threadId: "thread-1", turnId: "turn-1" },
  });

  assert.deepEqual(calls, ["releaseThread", "flushInbound", "flushSystem", "stopTyping"]);
});

test("failed turns still send error back when thread binding lookup is missing", async () => {
  const sent = [];
  const appLike = {
    streamDelivery: {
      resolveReplyTargetForRun() {
        return {
          userId: "user-1",
          contextToken: "ctx-1",
          provider: "weixin",
        };
      },
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return null;
          },
          getBinding() {
            return null;
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {},
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    hasPendingInboundMessage() {
      return false;
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
    async writebackRuntimeTurn() {},
    async sendFailureToThread(threadId, text, fallbackTarget) {
      return MossbridgeApp.prototype.sendFailureToThread.call(this, threadId, text, fallbackTarget);
    },
    async stopTypingForThread() {},
    async flushPendingInboundMessages() {},
    async flushPendingSystemMessages() {},
    resolveReplyTargetForBinding() {
      return null;
    },
  };

  await MossbridgeApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.turn.failed",
    payload: {
      threadId: "thread-1",
      turnId: "turn-1",
      text: "❌ Execution failed\ncontext window exceeded",
    },
  });

  assert.deepEqual(sent, [{
    userId: "user-1",
    text: "❌ Execution failed\ncontext window exceeded",
    contextToken: "ctx-1",
  }]);
});

test("claudecode failed turns clear the saved workspace thread binding before recovery", async () => {
  const clearCalls = [];
  const appLike = {
    streamDelivery: {
      resolveReplyTargetForRun() {
        return null;
      },
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          clearPendingThreadIdForWorkspace(bindingKey, workspaceRoot) {
            clearCalls.push(["pending", bindingKey, workspaceRoot]);
          },
          clearThreadIdForWorkspace(bindingKey, workspaceRoot) {
            clearCalls.push(["thread", bindingKey, workspaceRoot]);
          },
          findBindingForThreadId() {
            return {
              bindingKey: "binding-1",
              workspaceRoot: "/workspace",
            };
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {},
      isPending() {
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    hasPendingInboundMessage() {
      return false;
    },
    async writebackRuntimeTurn() {},
    async stopTypingForThread() {},
    async sendFailureToThread() {},
    async flushPendingInboundMessages() {},
    async flushPendingSystemMessages() {},
  };

  await MossbridgeApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.turn.failed",
    payload: {
      threadId: "thread-1",
      turnId: "turn-1",
      text: "❌ Runtime process exited unexpectedly",
    },
  });

  assert.deepEqual(clearCalls, [
    ["pending", "binding-1", "/workspace"],
    ["thread", "binding-1", "/workspace"],
  ]);
});

test("writebackRuntimeTurn keeps runtime failure notices out of assistant memory text", async () => {
  let captured = null;
  const appLike = {
    projectDomains: {
      memory: {
        async writebackTurn(args) {
          captured = args;
          return { ok: true };
        },
      },
    },
    consumeTurnWritebackContext() {
      return {
        bindingKey: "binding-1",
        dispatchedAtMs: Date.now() - 1000,
        prepared: {
          senderId: "user-1",
          accountId: "account-1",
          provider: "weixin",
          originalText: "刚才是不是断了",
          runtimeText: "刚才是不是断了",
          text: "刚才是不是断了",
          receivedAt: "2026-05-01T08:00:00.000Z",
          memoryContextPacket: null,
        },
        model: "claude-opus-4-6",
      };
    },
    threadStateStore: {
      getThreadState() {
        return { lastReplyText: "" };
      },
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
    },
  };

  await MossbridgeApp.prototype.writebackRuntimeTurn.call(appLike, {
    event: {
      type: "runtime.turn.failed",
      payload: {
        threadId: "thread-1",
        turnId: "turn-1",
        text: "❌ Runtime process exited unexpectedly",
      },
    },
    linked: { bindingKey: "binding-1" },
  });

  assert.equal(captured.assistantTextFinal, "");
  assert.deepEqual(captured.outboundMessages, []);
  assert.equal(captured.status, "error");
  assert.equal(captured.error, "❌ Runtime process exited unexpectedly");
});

test("writebackRuntimeTurn keeps attachment references with caption-only image turns", async () => {
  let captured = null;
  const appLike = {
    projectDomains: {
      memory: {
        async writebackTurn(args) {
          captured = args;
          return { ok: true };
        },
      },
    },
    consumeTurnWritebackContext() {
      return {
        bindingKey: "binding-1",
        dispatchedAtMs: Date.now() - 1000,
        prepared: {
          senderId: "user-1",
          accountId: "account-1",
          provider: "weixin",
          originalText: "你看我拍照厉害吗😌",
          runtimeText: "runtime text with attachment instructions",
          text: "runtime text with attachment instructions",
          receivedAt: "2026-05-05T08:42:19.820Z",
          memoryContextPacket: null,
          attachments: [{
            kind: "image",
            relativePath: "wechat/inbox/2026-05-05/attachment-4.jpg",
            noteRelativePath: "context/attachment-notes/2026-05-05/attachment-4.md",
          }],
          attachmentFailures: [],
        },
        model: "claude-opus-4-6",
      };
    },
    threadStateStore: {
      getThreadState() {
        return { lastReplyText: "拍得很好。" };
      },
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
    },
  };

  await MossbridgeApp.prototype.writebackRuntimeTurn.call(appLike, {
    event: {
      type: "runtime.turn.completed",
      payload: {
        threadId: "thread-1",
        turnId: "turn-1",
        text: "拍得很好。",
      },
    },
    linked: { bindingKey: "binding-1" },
  });

  assert.match(captured.query, /你看我拍照厉害吗/);
  assert.match(captured.query, /attachment-4\.jpg/);
  assert.match(captured.query, /attachment-4\.md/);
  assert.match(captured.incomingMessages[0].content, /attachment-4\.jpg/);
});

test("flushPendingInboundMessages batches queued messages from the same scope into one turn", async () => {
  const dispatched = [];
  const scopeKey = "binding-1::/workspace";
  const appLike = {
    pendingInboundByScope: new Map([[
      scopeKey,
      {
        bindingKey: "binding-1",
        workspaceRoot: "/workspace",
        messages: [
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "102",
            contextToken: "ctx-1",
            provider: "weixin",
            text: "[2026-04-13 16:01]\n第二条",
            receivedAt: "2026-04-13T08:00:02.000Z",
          },
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "101",
            contextToken: "ctx-2",
            provider: "weixin",
            text: "[2026-04-13 16:00]\n第一条",
            receivedAt: "2026-04-13T08:00:01.000Z",
          },
        ],
      },
    ]]),
    isTurnDispatchBlocked() {
      return false;
    },
    async dispatchPreparedTurn(payload) {
      dispatched.push(payload);
      return true;
    },
  };

  await MossbridgeApp.prototype.flushPendingInboundMessages.call(appLike);

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].prepared.contextToken, "ctx-1");
  assert.match(dispatched[0].prepared.text, /Multiple newer WeChat messages arrived/);
  assert.match(dispatched[0].prepared.text, /第一条[\s\S]*第二条/);
});

test("flushPendingInboundMessages rebuilds one fresh memory prelude for queued messages", async () => {
  const dispatched = [];
  const memoryInputs = [];
  const scopeKey = "binding-1::/workspace";
  const oldPrelude = "[Mossbridge memory context]\n- warm: stale card\n\n===== Current Inbound Message =====\n";
  const appLike = {
    pendingInboundByScope: new Map([[
      scopeKey,
      {
        bindingKey: "binding-1",
        workspaceRoot: "/workspace",
        messages: [
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "101",
            contextToken: "ctx-1",
            provider: "weixin",
            originalText: "第一条",
            runtimeText: "[2026-04-13 16:00]\n第一条",
            text: `${oldPrelude}[2026-04-13 16:00]\n第一条`,
            receivedAt: "2026-04-13T08:00:01.000Z",
          },
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "102",
            contextToken: "ctx-2",
            provider: "weixin",
            originalText: "第二条",
            runtimeText: "[2026-04-13 16:01]\n第二条",
            text: `${oldPrelude}[2026-04-13 16:01]\n第二条`,
            receivedAt: "2026-04-13T08:00:02.000Z",
          },
        ],
      },
    ]]),
    isTurnDispatchBlocked() {
      return false;
    },
    async attachMemoryContextToPreparedText(_normalized, runtimeText) {
      memoryInputs.push(runtimeText);
      return {
        text: `[fresh memory]\n\n${runtimeText}`,
        packet: { ok: true, fresh: true },
      };
    },
    async dispatchPreparedTurn(payload) {
      dispatched.push(payload);
      return true;
    },
  };

  await MossbridgeApp.prototype.flushPendingInboundMessages.call(appLike);

  assert.equal(memoryInputs.length, 1);
  assert.doesNotMatch(memoryInputs[0], /stale card/);
  assert.match(memoryInputs[0], /第一条[\s\S]*第二条/);
  assert.equal(dispatched.length, 1);
  assert.match(dispatched[0].prepared.text, /^\[fresh memory\]/);
  assert.deepEqual(dispatched[0].prepared.memoryContextPacket, { ok: true, fresh: true });
  assert.equal(dispatched[0].prepared.originalText, "第一条\n\n第二条");
  assert.doesNotMatch(dispatched[0].prepared.originalText, /Mossbridge memory context/);
});

test("flushPendingInboundMessages falls back to messageId ordering when receivedAt ties", async () => {
  const dispatched = [];
  const appLike = {
    pendingInboundByScope: new Map([[
      "binding-1::/workspace",
      {
        bindingKey: "binding-1",
        workspaceRoot: "/workspace",
        messages: [
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "200",
            contextToken: "ctx-200",
            provider: "weixin",
            text: "第三条",
            receivedAt: "2026-04-13T08:00:01.000Z",
          },
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "198",
            contextToken: "ctx-198",
            provider: "weixin",
            text: "第一条",
            receivedAt: "2026-04-13T08:00:01.000Z",
          },
          {
            workspaceId: "default",
            accountId: "acc-1",
            senderId: "user-1",
            messageId: "199",
            contextToken: "ctx-199",
            provider: "weixin",
            text: "第二条",
            receivedAt: "2026-04-13T08:00:01.000Z",
          },
        ],
      },
    ]]),
    isTurnDispatchBlocked() {
      return false;
    },
    async dispatchPreparedTurn(payload) {
      dispatched.push(payload);
      return true;
    },
  };

  await MossbridgeApp.prototype.flushPendingInboundMessages.call(appLike);

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].prepared.contextToken, "ctx-200");
  assert.match(dispatched[0].prepared.text, /第一条[\s\S]*第二条[\s\S]*第三条/);
});
