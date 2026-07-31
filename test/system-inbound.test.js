const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { MossbridgeApp } = require("../src/core/app");
const { SessionRefreshRequestStore } = require("../src/core/session-refresh-request-store");
const { SystemMessageDispatcher } = require("../src/core/system-message-dispatcher");

function callInboundAuthorization(config, senderId) {
  return MossbridgeApp.prototype.resolveInboundAuthorization.call({ config }, senderId);
}

function callIsAuthorizedInboundSender(config, senderId) {
  return MossbridgeApp.prototype.isAuthorizedInboundSender.call({
    config,
    resolveInboundAuthorization: MossbridgeApp.prototype.resolveInboundAuthorization,
  }, senderId);
}

test("system messages bypass normal inbound wrapping", async () => {
  const prepared = await MossbridgeApp.prototype.prepareIncomingMessageForRuntime.call({
    async attachMemoryContextToPreparedText(normalized, runtimeText) {
      return {
        text: runtimeText,
        packet: null,
      };
    },
  }, {
    provider: "system",
    text: "SYSTEM ACTION MODE\n\nTrigger:\n测试 system send 命令",
    attachments: [],
  }, "/tmp");

  assert.deepEqual(prepared, {
    provider: "system",
    text: "SYSTEM ACTION MODE\n\nTrigger:\n测试 system send 命令",
    originalText: "SYSTEM ACTION MODE\n\nTrigger:\n测试 system send 命令",
    runtimeText: "SYSTEM ACTION MODE\n\nTrigger:\n测试 system send 命令",
    attachments: [],
    attachmentFailures: [],
    memoryContextPacket: null,
  });
});

test("wechat allowlist rejects unauthorized senders before commands attachments or runtime", async () => {
  const audits = [];
  const rememberedTokens = [];
  let primedDeferredReplies = 0;
  let handledPreparedMessages = 0;
  const normalized = {
    provider: "weixin",
    accountId: "wx-account",
    workspaceId: "default",
    senderId: "stranger-user",
    chatId: "stranger-user",
    messageId: "msg-unauthorized",
    text: "/bind /tmp/not-allowed",
    attachments: [{ kind: "image", directUrls: ["https://example.invalid/private.jpg"] }],
    contextToken: "ctx-unauthorized",
    receivedAt: "2026-06-21T08:00:00.000Z",
  };
  const appLike = {
    config: { allowedUserIds: ["allowed-user"], allowOpenInbound: false },
    channelAdapter: {
      normalizeIncomingMessage() {
        return normalized;
      },
      rememberContextToken(userId, contextToken) {
        rememberedTokens.push({ userId, contextToken });
      },
    },
    weixinIngressAuditStore: {
      recordInbound(payload) {
        audits.push(payload);
        return payload;
      },
    },
    recordWeixinInboundAudit: MossbridgeApp.prototype.recordWeixinInboundAudit,
    isAuthorizedInboundSender: MossbridgeApp.prototype.isAuthorizedInboundSender,
    resolveInboundAuthorization: MossbridgeApp.prototype.resolveInboundAuthorization,
    primeDeferredRepliesForSender() {
      primedDeferredReplies += 1;
    },
    async handlePreparedMessage() {
      handledPreparedMessages += 1;
    },
  };

  await MossbridgeApp.prototype.handleIncomingMessage.call(appLike, { message_id: "msg-unauthorized" });

  assert.equal(rememberedTokens.length, 0);
  assert.equal(primedDeferredReplies, 0);
  assert.equal(handledPreparedMessages, 0);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].stage, "rejected_unauthorized");
  assert.equal(audits[0].senderId, "stranger-user");
  assert.equal(audits[0].contextTokenPresent, true);
  assert.equal(audits[0].textPreview, "");
});

test("wechat allowlist stays closed when empty unless enrollment is explicit", () => {
  const config = { allowedUserIds: [], allowOpenInbound: false };
  assert.equal(callIsAuthorizedInboundSender(config, "first-login-user"), false);
  assert.deepEqual(callInboundAuthorization(config, "first-login-user"), {
    authorized: false,
    mode: "closed_empty_allowlist",
    allowedUserCount: 0,
  });
});

test("wechat allowlist permits explicit open enrollment with empty allowlist", async () => {
  assert.equal(callIsAuthorizedInboundSender({
    allowedUserIds: [],
    allowOpenInbound: true,
  }, "first-login-user"), true);

  const audits = [];
  const rememberedTokens = [];
  let primedDeferredReplies = 0;
  let handledPreparedMessages = 0;
  const normalized = {
    provider: "weixin",
    accountId: "wx-account",
    workspaceId: "default",
    senderId: "first-login-user",
    chatId: "first-login-user",
    messageId: "msg-open-enrollment",
    text: "hello bridge",
    attachments: [],
    contextToken: "ctx-open",
    receivedAt: "2026-06-21T08:01:00.000Z",
  };
  const appLike = {
    config: { allowedUserIds: [], allowOpenInbound: true },
    channelAdapter: {
      normalizeIncomingMessage() {
        return normalized;
      },
      rememberContextToken(userId, contextToken) {
        rememberedTokens.push({ userId, contextToken });
      },
    },
    weixinIngressAuditStore: {
      recordInbound(payload) {
        audits.push(payload);
        return payload;
      },
    },
    recordWeixinInboundAudit: MossbridgeApp.prototype.recordWeixinInboundAudit,
    isAuthorizedInboundSender: MossbridgeApp.prototype.isAuthorizedInboundSender,
    resolveInboundAuthorization: MossbridgeApp.prototype.resolveInboundAuthorization,
    primeDeferredRepliesForSender(message) {
      assert.equal(message.senderId, "first-login-user");
      primedDeferredReplies += 1;
    },
    async handlePreparedMessage(message, options) {
      assert.equal(message.senderId, "first-login-user");
      assert.equal(options.allowCommands, true);
      handledPreparedMessages += 1;
    },
  };

  await MossbridgeApp.prototype.handleIncomingMessage.call(appLike, { message_id: "msg-open-enrollment" });

  assert.deepEqual(rememberedTokens, [{ userId: "first-login-user", contextToken: "ctx-open" }]);
  assert.equal(primedDeferredReplies, 1);
  assert.equal(handledPreparedMessages, 1);
  assert.deepEqual(audits.map((item) => item.stage), ["accepted", "dispatched"]);
});

test("wechat allowlist permits authorized senders only after enrollment", async () => {
  assert.equal(callIsAuthorizedInboundSender({
    allowedUserIds: ["allowed-user"],
    allowOpenInbound: false,
  }, "allowed-user"), true);
  assert.equal(callIsAuthorizedInboundSender({
    allowedUserIds: ["allowed-user"],
    allowOpenInbound: true,
  }, "stranger-user"), false);
  assert.deepEqual(callInboundAuthorization({
    allowedUserIds: ["allowed-user"],
    allowOpenInbound: false,
  }, "allowed-user"), {
    authorized: true,
    mode: "authorized",
    allowedUserCount: 1,
  });
  assert.deepEqual(callInboundAuthorization({
    allowedUserIds: ["allowed-user"],
    allowOpenInbound: true,
  }, "stranger-user"), {
    authorized: false,
    mode: "unauthorized",
    allowedUserCount: 1,
  });
});

test("system turns ask memory for proactive recall instead of user-triggered recall", async () => {
  let received = null;
  const result = await MossbridgeApp.prototype.attachMemoryContextToPreparedText.call({
    projectDomains: {
      memory: {
        async captureContextPacket(args) {
          received = args;
          return {
            runtime_prelude: "Mossbridge memory context\n- warm-card: Meteor necklace",
          };
        },
      },
    },
  }, {
    provider: "system",
    senderId: "user-1",
    text: "SYSTEM ACTION MODE\n\nTrigger:\n对我们重要的事情",
  }, "SYSTEM ACTION MODE\n\nTrigger:\n对我们重要的事情", "/workspace");

  assert.equal(received.recallMode, "proactive");
  assert.equal(received.sourceClient, "mossbridge_system_turn");
  assert.match(result.text, /warm-card: Meteor necklace/);
});

test("automatic session continuity is passed to memory without forcing raw recent context", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-system-continuity-"));
  const store = new SessionRefreshRequestStore({
    filePath: path.join(tempRoot, "session-refresh-requests.json"),
  });
  store.requestRefresh({
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    runtimeId: "codex",
    oldThreadId: "old-thread",
    reason: "context_pressure_session_refresh",
  });

  let received = null;
  const result = await MossbridgeApp.prototype.attachMemoryContextToPreparedText.call({
    config: {
      runtime: "codex",
      workspaceId: "default",
      accountId: "account-1",
      workspaceRoot: "/workspace",
    },
    activeAccountId: "account-1",
    sessionRefreshRequests: store,
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "old-thread";
          },
        };
      },
    },
    projectDomains: {
      memory: {
        async captureContextPacket(args) {
          received = args;
          return {
            runtime_prelude: "Mossbridge memory context",
            continuity_context: {
              mode: args.continuityContextMode,
              active: Boolean(args.continuityContextMode),
              control_only: true,
              model_visible_chars: 0,
              raw_recent_turns_injected: false,
            },
          };
        },
      },
    },
    resolveResidentAnchorPreludeKey: MossbridgeApp.prototype.resolveResidentAnchorPreludeKey,
    resolveStableTurnGuidanceKey: MossbridgeApp.prototype.resolveStableTurnGuidanceKey,
    resolveMemoryContextPressureProfile: MossbridgeApp.prototype.resolveMemoryContextPressureProfile,
    resolvePreparedRuntimeThreadId: MossbridgeApp.prototype.resolvePreparedRuntimeThreadId,
    resolveContinuityContextModeForPrepared: MossbridgeApp.prototype.resolveContinuityContextModeForPrepared,
    markStableTurnGuidanceDelivered: MossbridgeApp.prototype.markStableTurnGuidanceDelivered,
    recordControlEvent() {},
  }, {
    provider: "weixin",
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    originalText: "接着刚才那段，引用上一句",
    text: "接着刚才那段，引用上一句",
  }, "接着刚才那段，引用上一句", "/workspace");

  assert.equal(received.forceRecentContext, false);
  assert.equal(received.continuityContextMode, "session_refresh");
  assert.equal(received.preludeRecentSnippetLimit, 0);
  assert.equal(Object.hasOwn(received, "preludeRecentThreadLimit"), false);
  assert.match(result.text, /Mossbridge memory context/);
});

test("deferred proactive replies record prefix delivery audit when next inbound arrives", () => {
  let prefixText = "";
  let outboundAudit = null;
  const appLike = {
    config: {
      deferredSystemReplyMaxAgeMinutes: 30,
    },
    deferredSystemReplyQueue: {
      drainForSenderWithExpiry(accountId, senderId, options) {
        assert.equal(accountId, "wx-account");
        assert.equal(senderId, "user-1");
        assert.equal(options.systemReplyMaxAgeMs, 30 * 60_000);
        return {
          drained: [{
            id: "deferred-1",
            accountId: "wx-account",
            senderId: "user-1",
            threadId: "thread-checkin",
            text: "queued proactive note",
            kind: "system_reply",
            deferReason: "context_token_rejected",
          }],
          expired: [],
        };
      },
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey({ senderId }) {
            return `binding:${senderId}`;
          },
        };
      },
    },
    streamDelivery: {
      setDeferredReplyPrefix(bindingKey, text) {
        assert.equal(bindingKey, "binding:user-1");
        prefixText = text;
      },
    },
    channelAdapter: {
      getContextTokenAgeMs() {
        return 12_345;
      },
    },
    weixinIngressAuditStore: {
      recordOutbound(payload) {
        outboundAudit = payload;
        return payload;
      },
    },
    recordWeixinOutboundAudit: MossbridgeApp.prototype.recordWeixinOutboundAudit,
  };

  MossbridgeApp.prototype.primeDeferredRepliesForSender.call(appLike, {
    workspaceId: "default",
    accountId: "wx-account",
    senderId: "user-1",
    provider: "weixin",
    contextToken: "ctx-fresh",
  });

  assert.match(prefixText, /queued proactive note/);
  assert.equal(outboundAudit.kind, "deferred_reply_prefix");
  assert.equal(outboundAudit.status, "queued_for_next_runtime_reply");
  assert.equal(outboundAudit.immediateSent, false);
  assert.equal(outboundAudit.deferred, true);
  assert.equal(outboundAudit.prefixDelivered, true);
  assert.equal(outboundAudit.deferredReplyCount, 1);
  assert.equal(outboundAudit.deferReason, "context_token_rejected");
  assert.equal(outboundAudit.contextTokenAgeMs, 12_345);
});

test("stale deferred proactive replies are dropped instead of delivered as next inbound prefix", () => {
  let prefixCalled = false;
  let outboundAudit = null;
  const appLike = {
    config: {
      deferredSystemReplyMaxAgeMinutes: 30,
    },
    deferredSystemReplyQueue: {
      drainForSenderWithExpiry(accountId, senderId, options) {
        assert.equal(accountId, "wx-account");
        assert.equal(senderId, "user-1");
        assert.equal(options.systemReplyMaxAgeMs, 30 * 60_000);
        return {
          drained: [],
          expired: [{
            id: "old-deferred-1",
            accountId: "wx-account",
            senderId: "user-1",
            threadId: "thread-checkin",
            text: "stale proactive note",
            kind: "system_reply",
            deferReason: "context_token_rejected",
            deferred: true,
            prefixDelivered: false,
          }],
        };
      },
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey({ senderId }) {
            return `binding:${senderId}`;
          },
        };
      },
    },
    streamDelivery: {
      setDeferredReplyPrefix() {
        prefixCalled = true;
      },
    },
    channelAdapter: {
      getContextTokenAgeMs() {
        return 99_000;
      },
    },
    weixinIngressAuditStore: {
      recordOutbound(payload) {
        outboundAudit = payload;
        return payload;
      },
    },
    recordWeixinOutboundAudit: MossbridgeApp.prototype.recordWeixinOutboundAudit,
  };

  MossbridgeApp.prototype.primeDeferredRepliesForSender.call(appLike, {
    workspaceId: "default",
    accountId: "wx-account",
    senderId: "user-1",
    provider: "weixin",
    contextToken: "ctx-fresh",
  });

  assert.equal(prefixCalled, false);
  assert.equal(outboundAudit.kind, "deferred_reply_prefix");
  assert.equal(outboundAudit.status, "expired_dropped");
  assert.equal(outboundAudit.prefixDelivered, false);
  assert.equal(outboundAudit.deferredReplyCount, 1);
  assert.equal(outboundAudit.deferReason, "context_token_rejected");
  assert.equal(outboundAudit.contextTokenAgeMs, 99_000);
});

test("random checkin system prompt stays in lightweight no-tool mode", () => {
  const dispatcher = new SystemMessageDispatcher({
    queueStore: { hasPendingForAccount() { return false; }, drainForAccount() { return []; }, enqueue() {} },
    config: {
      workspaceId: "default",
      workspaceRoot: "/workspace",
    },
    accountId: "wx-account",
  });

  const prepared = dispatcher.buildPreparedMessage({
    id: "checkin-1",
    senderId: "user-1",
    text: "User comes to mind again.",
    kind: "checkin_opportunity",
    priority: "normal",
    title: "random_checkin",
    createdAt: "2026-05-15T12:00:00.000Z",
    metadata: {
      systemToolProfile: "checkin_lite",
    },
  }, "ctx-1");

  assert.match(prepared.text, /SYSTEM ACTION MODE/);
  assert.match(prepared.text, /lightweight tool profile/);
  assert.match(prepared.text, /keep the turn to injected context plus the final JSON action/i);
  assert.match(prepared.text, /small wake budget limits fan-out/i);
  assert.match(prepared.text, /not the range of legitimate life/i);
  assert.match(prepared.text, /Keep control-plane state backstage/i);
  assert.match(prepared.text, /Do not invent a conversational premise/i);
  assert.match(prepared.text, /natural WeChat/i);
  assert.match(prepared.text, /Bridge status reports come from \[Mossbridge\]/);
  assert.doesNotMatch(prepared.text, /Use tools as affordances/);
  assert.doesNotMatch(prepared.text, /Safe scope:/);
  assert.doesNotMatch(prepared.text, /maintenance and reconnection|background package|continuity handle/i);
  assert.doesNotMatch(prepared.text, /WECHAT SESSION INSTRUCTIONS/);
  assert.doesNotMatch(prepared.text, /front-stage style/);
  assert.ok(prepared.text.length < 2400);
});

test("foreground turns keep maintenance guidance out while pressure still trims memory prelude", async () => {
  const captureArgs = [];
  const appLike = {
    config: {
      workspaceId: "default",
      claudeContextWindow: 200000,
    },
    activeAccountId: "account-1",
    stableTurnGuidanceKeys: new Set(),
    residentAnchorPreludeKeys: new Set(),
    projectDomains: {
      memory: {
        async captureContextPacket(args) {
          captureArgs.push(args);
          return {
            runtime_prelude: "- warm: useful card",
          };
        },
      },
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          buildBindingKey({ senderId }) {
            return `binding:${senderId}`;
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
        };
      },
    },
    runtimeContextUsageStore: {
      getContext() {
        return {
          currentTokens: 160000,
          contextWindow: 200000,
        };
      },
    },
    resolveResidentAnchorPreludeKey: MossbridgeApp.prototype.resolveResidentAnchorPreludeKey,
    resolveStableTurnGuidanceKey: MossbridgeApp.prototype.resolveStableTurnGuidanceKey,
    markStableTurnGuidanceDelivered: MossbridgeApp.prototype.markStableTurnGuidanceDelivered,
    resolveMemoryContextPressureProfile: MossbridgeApp.prototype.resolveMemoryContextPressureProfile,
    resolvePreparedRuntimeThreadId: MossbridgeApp.prototype.resolvePreparedRuntimeThreadId,
  };
  const normalized = {
    provider: "weixin",
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    originalText: "今天聊点轻松的",
    text: "今天聊点轻松的",
  };

  const first = await MossbridgeApp.prototype.attachMemoryContextToPreparedText.call(
    appLike,
    normalized,
    normalized.text,
    "/workspace",
  );
  const second = await MossbridgeApp.prototype.attachMemoryContextToPreparedText.call(
    appLike,
    normalized,
    normalized.text,
    "/workspace",
  );

  assert.doesNotMatch(first.text, /微信前台对话提醒/);
  assert.doesNotMatch(first.text, /当前可用动作提醒/);
  assert.doesNotMatch(first.text, /记忆自维护|证据缺口|风险分层|常驻层|观察簿|前台自由/);
  assert.match(first.text, /warm: useful card/);
  assert.doesNotMatch(first.text, /先接住这一拍/);
  assert.doesNotMatch(second.text, /微信前台对话提醒/);
  assert.equal(captureArgs[0].includeRuntimePreludeGuidance, false);
  assert.equal(captureArgs[1].includeRuntimePreludeGuidance, false);
  assert.equal(captureArgs[0].preludeRecentThreadLimit, 2);
  assert.equal(captureArgs[0].preludeHotUpstreamLimit, 2);
  assert.equal(captureArgs[0].preludeHotTurnLimit, 3);
  assert.equal(captureArgs[0].coldVineLimit, 1);
  assert.equal(first.packet.delivery.mode, "inbound");
  assert.equal(first.packet.delivery.include_stable_guidance, false);
  assert.ok(first.packet.delivery.estimated_tokens > 0);
  assert.equal(first.packet.delivery.runtime_prompt_chars, first.text.length);
  assert.ok(first.packet.delivery.runtime_prompt_estimated_tokens >= first.packet.delivery.estimated_tokens);
  assert.equal(second.packet.delivery.include_stable_guidance, false);
  assert.equal(second.packet.delivery.policy.includes("not injected"), true);
});

test("system maintenance turns may carry runtime maintenance guidance", async () => {
  const captureArgs = [];
  const appLike = {
    config: {
      workspaceId: "default",
    },
    activeAccountId: "account-1",
    stableTurnGuidanceKeys: new Set(),
    residentAnchorPreludeKeys: new Set(),
    projectDomains: {
      memory: {
        async captureContextPacket(args) {
          captureArgs.push(args);
          return {
            runtime_prelude: args.includeRuntimePreludeGuidance
              ? "- 记忆自维护：后台维护轮次可以携带操作手册。"
              : "- warm: useful card",
          };
        },
      },
    },
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
      getSessionStore() {
        return {
          buildBindingKey({ senderId }) {
            return `binding:${senderId}`;
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
        };
      },
    },
    resolveResidentAnchorPreludeKey: MossbridgeApp.prototype.resolveResidentAnchorPreludeKey,
    resolveStableTurnGuidanceKey: MossbridgeApp.prototype.resolveStableTurnGuidanceKey,
    markStableTurnGuidanceDelivered: MossbridgeApp.prototype.markStableTurnGuidanceDelivered,
    resolveMemoryContextPressureProfile: MossbridgeApp.prototype.resolveMemoryContextPressureProfile,
    resolvePreparedRuntimeThreadId: MossbridgeApp.prototype.resolvePreparedRuntimeThreadId,
  };
  const normalized = {
    provider: "system",
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    kind: "memory_metabolism",
    originalText: "run memory maintenance",
    text: "run memory maintenance",
  };

  const result = await MossbridgeApp.prototype.attachMemoryContextToPreparedText.call(
    appLike,
    normalized,
    normalized.text,
    "/workspace",
  );

  assert.equal(captureArgs[0].includeRuntimePreludeGuidance, true);
  assert.equal(captureArgs[0].recallMode, "proactive");
  assert.match(result.text, /记忆自维护/);
  assert.equal(result.packet.delivery.mode, "inbound");
  assert.equal(result.packet.delivery.include_stable_guidance, true);
});

test("random checkin first-event failures recover backstage without bridge text", async () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalWarn = console.warn;
  const timers = [];
  global.setTimeout = (callback, delayMs) => {
    const timer = { callback, delayMs };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = () => {};
  console.warn = () => {};

  try {
    const calls = [];
    const appLike = {
      pendingRuntimeEventWatchdogs: new Map(),
      pendingTurnWritebackByThreadId: new Map([["thread-checkin", { pending: true }]]),
      clearRuntimeEventWatchdog: MossbridgeApp.prototype.clearRuntimeEventWatchdog,
      runtimeAdapter: {
        describe() {
          return { id: "claudecode" };
        },
        getSessionStore() {
          return {
            getThreadIdForWorkspace() {
              return "thread-checkin";
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
          calls.push(["cancel", payload.threadId, payload.workspaceRoot]);
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
          calls.push(["release", threadId]);
        },
      },
      async flushPendingInboundMessages(payload) {
        calls.push(["flush", payload.bindingKey, payload.workspaceRoot, payload.ignoreBoundary]);
      },
    };

    MossbridgeApp.prototype.scheduleRuntimeEventWatchdog.call(appLike, {
      bindingKey: "binding-system",
      workspaceRoot: "/workspace",
      normalized: {
        provider: "system",
        senderId: "user-1",
        contextToken: "ctx-1",
        systemTurn: {
          trigger_kind: "checkin_opportunity",
        },
      },
      threadId: "thread-checkin",
      openingTurn: true,
    });

    assert.deepEqual(timers.map((timer) => timer.delayMs), [180_000]);
    await timers[0].callback();

    assert.equal(calls.some((call) => call[0] === "text"), false);
    assert.equal(appLike.pendingTurnWritebackByThreadId.has("thread-checkin"), false);
    assert.deepEqual(calls, [
      ["typing", 0],
      ["clearPending", "binding-system", "/workspace"],
      ["clearThread", "binding-system", "/workspace"],
      ["cancel", "thread-checkin", "/workspace"],
      ["release", "thread-checkin"],
      ["flush", "binding-system", "/workspace", true],
    ]);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    console.warn = originalWarn;
  }
});

test("user first-event failures still send a visible diagnostic after local turn.started", async () => {
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
    const calls = [];
    const appLike = {
      pendingRuntimeEventWatchdogs: new Map(),
      clearRuntimeEventWatchdog: MossbridgeApp.prototype.clearRuntimeEventWatchdog,
      runtimeAdapter: {
        describe() {
          return { id: "claudecode" };
        },
        getSessionStore() {
          return {
            getThreadIdForWorkspace() {
              return "thread-user";
            },
          };
        },
      },
      threadStateStore: {
        getThreadState() {
          return {
            status: "running",
            turnId: "turn-local",
          };
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
    };

    MossbridgeApp.prototype.scheduleRuntimeEventWatchdog.call(appLike, {
      bindingKey: "binding-user",
      workspaceRoot: "/workspace",
      normalized: {
        provider: "weixin",
        senderId: "user-1",
        contextToken: "ctx-1",
      },
      threadId: "thread-user",
      openingTurn: true,
    });

    assert.deepEqual(timers.map((timer) => timer.delayMs), [180_000]);
    await timers[0].callback();

    const visible = calls.find((call) => call[0] === "text");
    assert.ok(visible);
    assert.match(visible[1], /status: first_event_timeout/);
    assert.match(visible[1], /check_1: npm run shared:status:claudecode/);
    assert.match(visible[1], /check_2: npm run shared:start:claudecode/);
    assert.match(visible[1], /check_3: npm run shared:open:claudecode/);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("first-event diagnostics build command hints from the current runtime id", async () => {
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
    const sent = [];
    const appLike = {
      pendingRuntimeEventWatchdogs: new Map(),
      clearRuntimeEventWatchdog: MossbridgeApp.prototype.clearRuntimeEventWatchdog,
      runtimeAdapter: {
        describe() {
          return { id: "localruntime" };
        },
        getSessionStore() {
          return {
            getThreadIdForWorkspace() {
              return "thread-localruntime";
            },
          };
        },
      },
      channelAdapter: {
        async sendTyping() {},
        async sendText(payload) {
          sent.push(payload.text);
        },
      },
    };

    MossbridgeApp.prototype.scheduleRuntimeEventWatchdog.call(appLike, {
      bindingKey: "binding-user",
      workspaceRoot: "/workspace",
      normalized: {
        provider: "weixin",
        senderId: "user-1",
        contextToken: "ctx-1",
      },
      threadId: "thread-localruntime",
      openingTurn: false,
    });

    assert.deepEqual(timers.map((timer) => timer.delayMs), [8_000, 45_000]);
    await timers[1].callback();

    const visible = sent.find((text) => /status: first_event_timeout/.test(text));
    assert.ok(visible);
    assert.match(visible, /runtime: localruntime/);
    assert.match(visible, /check_1: MOSSBRIDGE_RUNTIME=localruntime npm run shared:status/);
    assert.match(visible, /check_2: MOSSBRIDGE_RUNTIME=localruntime npm run shared:start/);
    assert.match(visible, /check_3: MOSSBRIDGE_RUNTIME=localruntime npm run shared:open/);
    assert.doesNotMatch(visible, /shared:status:claudecode/);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("claudecode warm turns get a slower first-event watchdog", () => {
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
    const appLike = {
      pendingRuntimeEventWatchdogs: new Map(),
      clearRuntimeEventWatchdog: MossbridgeApp.prototype.clearRuntimeEventWatchdog,
      runtimeAdapter: {
        describe() {
          return { id: "claudecode" };
        },
        getSessionStore() {
          return {
            getThreadIdForWorkspace() {
              return "thread-user";
            },
          };
        },
      },
      channelAdapter: {
        async sendTyping() {},
        async sendText() {},
      },
    };

    MossbridgeApp.prototype.scheduleRuntimeEventWatchdog.call(appLike, {
      bindingKey: "binding-user",
      workspaceRoot: "/workspace",
      normalized: {
        provider: "weixin",
        senderId: "user-1",
        contextToken: "ctx-1",
      },
      threadId: "thread-user",
      openingTurn: false,
    });

    assert.deepEqual(timers.map((timer) => timer.delayMs), [75_000, 120_000]);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("random checkin running-turn watchdog recovers backstage without slow text", async () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalWarn = console.warn;
  const timers = [];
  global.setTimeout = (callback, delayMs) => {
    const timer = { callback, delayMs };
    timers.push(timer);
    return timer;
  };
  global.clearTimeout = () => {};
  console.warn = () => {};

  try {
    const calls = [];
    const appLike = {
      runningTurnWatchdogs: new Map(),
      watchdogCancelledRunKeys: new Set(),
      runtimeAdapter: {
        describe() {
          return { id: "claudecode" };
        },
        async cancelTurn(payload) {
          calls.push(["cancel", payload.threadId, payload.turnId, payload.workspaceRoot]);
        },
      },
      threadStateStore: {
        getThreadState() {
          return {
            status: "running",
            turnId: "turn-checkin",
          };
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
          calls.push(["release", threadId]);
        },
      },
      async flushPendingInboundMessages(payload) {
        calls.push(["flush", payload.bindingKey, payload.workspaceRoot, payload.ignoreBoundary]);
      },
      isSameRunningTurn: MossbridgeApp.prototype.isSameRunningTurn,
    };

    MossbridgeApp.prototype.scheduleRunningTurnWatchdog.call(appLike, {
      bindingKey: "binding-system",
      workspaceRoot: "/workspace",
      normalized: {
        provider: "system",
        senderId: "user-1",
        contextToken: "ctx-1",
        systemTurn: {
          trigger_kind: "checkin_opportunity",
        },
      },
      threadId: "thread-checkin",
      turnId: "turn-checkin",
    });

    assert.deepEqual(timers.map((timer) => timer.delayMs), [360_000]);
    await timers[0].callback();

    assert.equal(calls.some((call) => call[0] === "text"), false);
    assert.equal(appLike.watchdogCancelledRunKeys.has("thread-checkin:turn-checkin"), true);
    assert.deepEqual(calls, [
      ["typing", 0],
      ["cancel", "thread-checkin", "turn-checkin", "/workspace"],
      ["release", "thread-checkin"],
      ["flush", "binding-system", "/workspace", true],
    ]);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    console.warn = originalWarn;
  }
});

test("queued system messages attach fresh memory before runtime dispatch", async () => {
  const dispatched = [];
  const clearedThreads = [];
  const updatedBindings = [];
  const dispatcher = new SystemMessageDispatcher({
    queueStore: { hasPendingForAccount() { return false; }, drainForAccount() { return []; }, enqueue() {} },
    config: {
      workspaceId: "default",
      workspaceRoot: "/workspace",
    },
    accountId: "wx-account",
  });
  const appLike = {
    systemMessageDispatcher: dispatcher,
    channelAdapter: {
      getKnownContextTokens() {
        return { "user-1": "ctx-1" };
      },
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey({ senderId }) {
            return `binding:${senderId}`;
          },
          getThreadIdForWorkspace(bindingKey) {
            return String(bindingKey).includes("#mossbridge-system") ? "" : "user-thread";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "claude-opus-4-6" };
          },
          setRuntimeParamsForWorkspace() {},
          updateBinding(bindingKey, value) {
            updatedBindings.push([bindingKey, value]);
          },
          clearThreadIdForWorkspace(bindingKey, workspaceRoot) {
            clearedThreads.push([bindingKey, workspaceRoot]);
          },
          clearPendingThreadIdForWorkspace() {
            return "";
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
        return false;
      },
    },
    turnBoundaryScopeKeys: new Set(),
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    isTurnDispatchBlocked: MossbridgeApp.prototype.isTurnDispatchBlocked,
    prepareSystemRuntimeBinding: MossbridgeApp.prototype.prepareSystemRuntimeBinding,
    async attachMemoryContextToPreparedText(normalized, runtimeText, workspaceRoot) {
      assert.equal(normalized.provider, "system");
      assert.equal(workspaceRoot, "/workspace");
      assert.match(normalized.originalText, /reminder: 10 点问我起床没/);
      assert.match(runtimeText, /SYSTEM ACTION MODE/);
      return {
        text: `[Mossbridge memory context]\n- ongoing: 起床提醒 | active | 近期作息\n\n===== Current Inbound Message =====\n${runtimeText}`,
        packet: {
          retrieval: { route: ["warm_memory", "resident_warm"], mode: "mossbridge_context_packet" },
          warm_memory_packet: { hit_count: 1 },
          ongoing_track_packet: { hit_count: 1 },
        },
      };
    },
    async dispatchPreparedTurn(payload) {
      dispatched.push(payload);
      return true;
    },
  };

  const ok = await MossbridgeApp.prototype.dispatchSystemMessage.call(appLike, {
    id: "sys-1",
    senderId: "user-1",
    text: "Due reminder for User: 10 点问我起床没",
    kind: "reminder_due",
    priority: "high",
    title: "due_reminder",
    metadata: {
      reminderText: "10 点问我起床没",
      dueAt: "2026-04-29 10:00",
    },
    createdAt: "2026-04-29T02:00:00.000Z",
  });

  assert.equal(ok, true);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].bindingKey, "binding:user-1#mossbridge-system");
  assert.deepEqual(clearedThreads, [["binding:user-1#mossbridge-system", "/workspace"]]);
  assert.equal(updatedBindings[0][1].replySenderId, "user-1");
  assert.match(dispatched[0].prepared.text, /ongoing: 起床提醒/);
  assert.match(dispatched[0].prepared.text, /\[2026-04-29\s+10:00:00\s+Asia\/Shanghai\s+\(星期三\)\]/);
  assert.match(dispatched[0].prepared.text, /Use this timestamp as the current local time/);
  assert.match(dispatched[0].prepared.text, /Trigger kind: reminder_due/);
  assert.deepEqual(dispatched[0].prepared.memoryContextPacket?.retrieval?.route, ["warm_memory", "resident_warm"]);
  assert.equal(dispatched[0].prepared.systemTurn.trigger_kind, "reminder_due");
});

test("random checkins drop instead of blocking behind a busy foreground turn", async () => {
  const dispatched = [];
  const reblocked = [];
  const dispatcher = new SystemMessageDispatcher({
    queueStore: { hasPendingForAccount() { return false; }, drainForAccount() { return []; }, enqueue() {} },
    config: {
      workspaceId: "default",
      workspaceRoot: "/workspace",
    },
    accountId: "wx-account",
  });
  const appLike = {
    config: {
      workspaceId: "default",
      workspaceRoot: "/workspace",
      runtime: "claudecode",
    },
    systemMessageDispatcher: dispatcher,
    channelAdapter: {
      getKnownContextTokens() {
        return { "user-1": "ctx-1" };
      },
    },
    runtimeCooldownStore: {
      getActiveCooldown() {
        return null;
      },
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey({ senderId }) {
            return `binding:${senderId}`;
          },
        };
      },
    },
    isTurnDispatchBlocked(bindingKey, workspaceRoot) {
      reblocked.push([bindingKey, workspaceRoot]);
      return true;
    },
    async dispatchPreparedTurn(payload) {
      dispatched.push(payload);
      return true;
    },
  };

  const ok = await MossbridgeApp.prototype.dispatchSystemMessage.call(appLike, {
    id: "checkin-1",
    accountId: "wx-account",
    senderId: "user-1",
    workspaceRoot: "/workspace",
    text: "A small ordinary check-in window opens.",
    kind: "checkin_opportunity",
    priority: "normal",
    title: "random_checkin",
    createdAt: "2026-05-18T09:00:00.000Z",
  });

  assert.equal(ok, true);
  assert.deepEqual(dispatched, []);
  assert.deepEqual(reblocked, [["binding:user-1", "/workspace"]]);
});

test("background runtime circuit opens after repeated first-event failures", () => {
  const originalWarn = console.warn;
  const originalLog = console.log;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-circuit-"));
  const filePath = path.join(dir, "background-runtime-circuit.json");
  const nowMs = Date.parse("2026-06-02T10:00:00.000Z");
  const appLike = {
    config: {
      runtime: "claudecode",
      backgroundRuntimeCircuitEnabled: true,
      backgroundRuntimeCircuitFile: filePath,
      backgroundRuntimeCircuitFailureThreshold: 2,
      backgroundRuntimeCircuitCooldownMinutes: 30,
    },
    backgroundRuntimeCircuit: {},
    writeBackgroundRuntimeCircuitState: MossbridgeApp.prototype.writeBackgroundRuntimeCircuitState,
    getBackgroundRuntimeCircuitStatus: MossbridgeApp.prototype.getBackgroundRuntimeCircuitStatus,
  };

  console.warn = () => {};
  console.log = () => {};
  try {
    MossbridgeApp.prototype.recordBackgroundRuntimeFirstEventFailure.call(appLike, {
      trigger: "checkin_opportunity",
      threadId: "thread-1",
      bindingKey: "binding:user-1#mossbridge-system",
      workspaceRoot: "/workspace",
      nowMs,
    });
    assert.equal(
      MossbridgeApp.prototype.getBackgroundRuntimeCircuitStatus.call(appLike, {
        kind: "checkin_opportunity",
        nowMs,
      }).open,
      false,
    );

    const status = MossbridgeApp.prototype.recordBackgroundRuntimeFirstEventFailure.call(appLike, {
      trigger: "dreaming_opportunity",
      threadId: "thread-2",
      bindingKey: "binding:user-1#mossbridge-system",
      workspaceRoot: "/workspace",
      nowMs: nowMs + 60_000,
    });

    assert.equal(status.open, true);
    assert.equal(status.openUntilMs, nowMs + 60_000 + 30 * 60_000);
    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(persisted.consecutiveFirstEventFailures, 2);
    assert.equal(persisted.reason, "background_first_event_failure");

    MossbridgeApp.prototype.recordBackgroundRuntimeSuccess.call(appLike, {
      event: {
        type: "runtime.turn.completed",
        payload: { threadId: "foreground-thread" },
      },
      nowMs: nowMs + 120_000,
    });

    const cleared = MossbridgeApp.prototype.getBackgroundRuntimeCircuitStatus.call(appLike, {
      kind: "checkin_opportunity",
      nowMs: nowMs + 120_000,
    });
    assert.equal(cleared.open, false);
    assert.equal(cleared.consecutiveFirstEventFailures, 0);
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
});

test("background runtime circuit drops checkins and defers dreaming attempts", async () => {
  const originalLog = console.log;
  const dispatched = [];
  const deferred = [];
  const openUntilMs = Date.now() + 30 * 60_000;
  const appLike = {
    config: {
      runtime: "claudecode",
      backgroundRuntimeCircuitEnabled: true,
      backgroundRuntimeCircuitFailureThreshold: 1,
      backgroundRuntimeCircuitCooldownMinutes: 30,
    },
    backgroundRuntimeCircuit: {
      consecutiveFirstEventFailures: 1,
      openUntilMs,
      reason: "background_first_event_failure",
    },
    memoryMetabolismService: {
      deferAttempt(attemptId, payload) {
        deferred.push({ attemptId, payload });
      },
    },
    getBackgroundRuntimeCircuitStatus: MossbridgeApp.prototype.getBackgroundRuntimeCircuitStatus,
    deferMemoryMetabolismAttemptForRuntimeCircuit: MossbridgeApp.prototype.deferMemoryMetabolismAttemptForRuntimeCircuit,
    async dispatchPreparedTurn(payload) {
      dispatched.push(payload);
      return true;
    },
  };

  console.log = () => {};
  try {
    const checkinOk = await MossbridgeApp.prototype.dispatchSystemMessage.call(appLike, {
      id: "checkin-1",
      accountId: "wx-account",
      senderId: "user-1",
      workspaceRoot: "/workspace",
      text: "A small ordinary check-in window opens.",
      kind: "checkin_opportunity",
      priority: "normal",
      title: "random_checkin",
      createdAt: "2026-06-02T10:00:00.000Z",
    });
    const dreamingOk = await MossbridgeApp.prototype.dispatchSystemMessage.call(appLike, {
      id: "dreaming-1",
      accountId: "wx-account",
      senderId: "user-1",
      workspaceRoot: "/workspace",
      text: "Memory metabolism opportunity.",
      kind: "dreaming_opportunity",
      metadata: {
        dreamingAttemptId: "attempt-1",
      },
      createdAt: "2026-06-02T10:01:00.000Z",
    });

    assert.equal(checkinOk, true);
    assert.equal(dreamingOk, true);
    assert.deepEqual(dispatched, []);
    assert.deepEqual(deferred, [{
      attemptId: "attempt-1",
      payload: {
        reason: "background_runtime_circuit",
        retryAfterMs: openUntilMs,
      },
    }]);
  } finally {
    console.log = originalLog;
  }
});

test("reply system messages are delivered directly instead of re-entering the runtime", async () => {
  const sent = [];
  const dispatched = [];
  const ok = await MossbridgeApp.prototype.dispatchSystemMessage.call({
    sendDirectVisibleSystemReply: MossbridgeApp.prototype.sendDirectVisibleSystemReply,
    channelAdapter: {
      getKnownContextTokens() {
        return { "user-1": "ctx-1" };
      },
      async sendText(payload) {
        sent.push(payload);
      },
    },
    async dispatchPreparedTurn(payload) {
      dispatched.push(payload);
      return true;
    },
  }, {
    id: "sys-reply-1",
    senderId: "user-1",
    text: "呜呜呜被揉脸了……！",
    kind: "reply",
    createdAt: "2026-04-30T12:30:00.000Z",
  });

  assert.equal(ok, true);
  assert.deepEqual(dispatched, []);
  assert.deepEqual(sent, [{
    userId: "user-1",
    text: "呜呜呜被揉脸了……！",
    contextToken: "ctx-1",
  }]);
});

test("ordinary wechat turns keep dynamic memory context lean when no runtime thread key is available", async () => {
  const result = await MossbridgeApp.prototype.attachMemoryContextToPreparedText.call({
    projectDomains: {
      memory: {
        async captureContextPacket() {
          return {
            runtime_prelude: "[Mossbridge memory context]\n- resident-anchor: relation line",
          };
        },
      },
    },
  }, {
    provider: "weixin",
    senderId: "user-1",
    text: "朋友😏？",
  }, "朋友😏？", "/workspace");

  assert.doesNotMatch(result.text, /\[微信前台对话提醒\]/);
  assert.doesNotMatch(result.text, /\[当前可用动作提醒\]/);
  assert.match(result.text, /resident-anchor: relation line/);
  assert.match(result.text, /朋友😏？/);
});

test("foreground reminder turns do not receive tool-hover maintenance guidance", async () => {
  const appLike = {
    config: {
      workspaceId: "default",
      workspaceRoot: "/workspace",
    },
    activeAccountId: "account-1",
    stableTurnGuidanceKeys: new Set(),
    residentAnchorPreludeKeys: new Set(),
    projectDomains: {
      memory: {
        async captureContextPacket() {
          return {
            runtime_prelude: "[Mossbridge memory context]",
          };
        },
      },
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          buildBindingKey({ senderId }) {
            return `binding:${senderId}`;
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
        };
      },
    },
    resolveResidentAnchorPreludeKey: MossbridgeApp.prototype.resolveResidentAnchorPreludeKey,
    resolveStableTurnGuidanceKey: MossbridgeApp.prototype.resolveStableTurnGuidanceKey,
    markStableTurnGuidanceDelivered: MossbridgeApp.prototype.markStableTurnGuidanceDelivered,
    resolveMemoryContextPressureProfile: MossbridgeApp.prototype.resolveMemoryContextPressureProfile,
    resolvePreparedRuntimeThreadId: MossbridgeApp.prototype.resolvePreparedRuntimeThreadId,
  };
  const result = await MossbridgeApp.prototype.attachMemoryContextToPreparedText.call(appLike, {
    provider: "weixin",
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    text: "明天提醒我继续看这个",
  }, "明天提醒我继续看这个", "/workspace");

  assert.doesNotMatch(result.text, /AI 日历\/提醒/);
  assert.doesNotMatch(result.text, /到期唤醒会携带完整工具能力/);
  assert.doesNotMatch(result.text, /随机心跳只负责轻量续联/);
  assert.match(result.text, /\[Mossbridge memory context\]/);
  assert.match(result.text, /明天提醒我继续看这个/);
});

test("image attachments inject view_image instructions for runtimes that support it", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-inbound-test-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-workspace-test-"));
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    headers: {
      get(name) {
        return String(name || "").toLowerCase() === "content-type" ? "image/jpeg" : "";
      },
    },
    async arrayBuffer() {
      return Buffer.from("fake-jpeg-bytes");
    },
  });

  try {
    const prepared = await MossbridgeApp.prototype.prepareIncomingMessageForRuntime.call({
      config: {
        stateDir,
        weixinCdnBaseUrl: "https://cdn.example.com",
        userName: "User",
        workspaceRoot,
      },
      runtimeAdapter: {
        describe() {
          return { id: "codex" };
        },
      },
      async attachMemoryContextToPreparedText(normalized, runtimeText) {
        return {
          text: runtimeText,
          packet: null,
        };
      },
      channelAdapter: {
        async sendText() {},
      },
    }, {
      provider: "weixin",
      text: "",
      senderId: "user-1",
      contextToken: "ctx-1",
      attachments: [{
        kind: "image",
        fileName: "photo.jpg",
        directUrls: ["https://example.com/photo.jpg"],
        mediaRef: { encryptType: 0 },
      }],
      receivedAt: "2026-04-17T10:00:00.000Z",
    }, workspaceRoot);

    assert.match(prepared.text, /图片请使用 `view_image`/);
    assert.match(prepared.text, /配套说明笔记|说明笔记/);
    assert.doesNotMatch(prepared.text, /Do not use `Read` or shell commands on image files/i);
    assert.equal(prepared.attachments[0].contentType, "image/jpeg");
    assert.equal(prepared.attachments[0].isImage, true);
    assert.match(prepared.attachments[0].absolutePath, new RegExp(workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(prepared.attachments[0].noteAbsolutePath, new RegExp(workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(fs.existsSync(prepared.attachments[0].noteAbsolutePath), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("runtime writeback preserves saved attachment refs for cache and downstream APIs", async () => {
  let writebackArgs = null;
  const appLike = {
    projectDomains: {
      memory: {
        async writebackTurn(args) {
          writebackArgs = args;
          return { ok: true, appended_record: { record_id: "cap-test" } };
        },
      },
    },
    turnWritebackContextByRunKey: new Map(),
    pendingTurnWritebackByThreadId: new Map(),
    threadStateStore: {
      getThreadState() {
        return { lastReplyText: "assistant saw the image" };
      },
    },
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
      getSessionStore() {
        return {
          getRuntimeParamsForWorkspace() {
            return { model: "gpt-test" };
          },
        };
      },
    },
    recordControlEvent() {},
    completeMemoryMetabolismAttempt() {},
    rememberTurnWritebackContext: MossbridgeApp.prototype.rememberTurnWritebackContext,
    consumeTurnWritebackContext: MossbridgeApp.prototype.consumeTurnWritebackContext,
  };

  MossbridgeApp.prototype.rememberTurnWritebackContext.call(appLike, {
    turn: { threadId: "thread-1", turnId: "turn-1" },
    bindingKey: "binding:user-1",
    workspaceRoot: "/workspace",
    dispatchedAtMs: Date.now(),
    prepared: {
      workspaceId: "default",
      accountId: "wx-account",
      senderId: "user-1",
      provider: "weixin",
      originalText: "看这张图",
      runtimeText: "看这张图",
      text: "看这张图",
      receivedAt: "2026-05-05T10:00:01.000Z",
      attachments: [{
        kind: "image",
        relativePath: "inbox/2026-05-05/photo.jpg",
        absolutePath: "/workspace/inbox/2026-05-05/photo.jpg",
        noteRelativePath: "context/attachment-notes/photo.md",
        noteAbsolutePath: "/workspace/context/attachment-notes/photo.md",
        sourceFileName: "photo.jpg",
        contentType: "image/jpeg",
        isImage: true,
      }],
      attachmentFailures: [],
    },
  });

  await MossbridgeApp.prototype.writebackRuntimeTurn.call(appLike, {
    event: {
      type: "runtime.turn.completed",
      payload: {
        threadId: "thread-1",
        turnId: "turn-1",
        text: "assistant saw the image",
      },
    },
    linked: { bindingKey: "binding:user-1" },
  });

  assert.ok(writebackArgs);
  const incoming = writebackArgs.incomingMessages[0];
  assert.equal(incoming.attachments[0].path, "inbox/2026-05-05/photo.jpg");
  assert.equal(incoming.attachment_refs[0].note_path, "context/attachment-notes/photo.md");
  assert.equal(incoming.attachment_refs[0].absolute_path, "/workspace/inbox/2026-05-05/photo.jpg");
  assert.equal(incoming.attachment_refs[0].is_image, true);
});

test("image attachments tell claudecode to use Read on the saved local image file", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-inbound-test-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-workspace-test-"));
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    headers: {
      get(name) {
        return String(name || "").toLowerCase() === "content-type" ? "image/jpeg" : "";
      },
    },
    async arrayBuffer() {
      return Buffer.from("fake-jpeg-bytes");
    },
  });

  try {
    const prepared = await MossbridgeApp.prototype.prepareIncomingMessageForRuntime.call({
      config: {
        stateDir,
        weixinCdnBaseUrl: "https://cdn.example.com",
        userName: "User",
        workspaceRoot,
      },
      runtimeAdapter: {
        describe() {
          return { id: "claudecode" };
        },
      },
      async attachMemoryContextToPreparedText(normalized, runtimeText) {
        return {
          text: runtimeText,
          packet: null,
        };
      },
      channelAdapter: {
        async sendText() {},
      },
    }, {
      provider: "weixin",
      text: "",
      senderId: "user-1",
      contextToken: "ctx-1",
      attachments: [{
        kind: "image",
        fileName: "photo.jpg",
        directUrls: ["https://example.com/photo.jpg"],
        mediaRef: { encryptType: 0 },
      }],
      receivedAt: "2026-04-17T10:00:00.000Z",
    }, workspaceRoot);

    assert.match(prepared.text, /回复 User 之前，请先查看附件本体/);
    assert.match(prepared.text, /图片请对保存后的本地图片文件使用 `Read`/);
    assert.match(prepared.text, /配套说明笔记|说明笔记/);
    assert.doesNotMatch(prepared.text, /Do not use shell commands or wrappers/i);
    assert.doesNotMatch(prepared.text, /view_image/i);
    assert.equal(prepared.attachments[0].contentType, "image/jpeg");
    assert.equal(prepared.attachments[0].isImage, true);
    assert.equal(fs.existsSync(prepared.attachments[0].noteAbsolutePath), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("image-only inbound messages are batched before runtime dispatch", async () => {
  const routed = [];
  const typings = [];
  const appLike = {
    config: {
      userName: "User",
      workspaceRoot: "/workspace",
    },
    pendingAttachmentInboundByScope: new Map(),
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
    },
    channelAdapter: {
      async sendTyping(payload) {
        typings.push(payload);
      },
    },
    async routePreparedInbound(payload) {
      routed.push(payload);
      return true;
    },
    async attachMemoryContextToPreparedText(normalized, runtimeText) {
      return {
        text: `[memory]\n${runtimeText}`,
        packet: { hit_count: 1 },
      };
    },
    schedulePendingAttachmentInboundFlush: MossbridgeApp.prototype.schedulePendingAttachmentInboundFlush,
    clearPendingAttachmentInboundTimer: MossbridgeApp.prototype.clearPendingAttachmentInboundTimer,
    flushPendingAttachmentInboundBatch: MossbridgeApp.prototype.flushPendingAttachmentInboundBatch,
  };
  const bindingKey = "binding:user-1";
  const workspaceRoot = "/workspace";

  MossbridgeApp.prototype.enqueuePendingAttachmentInbound.call(appLike, {
    bindingKey,
    workspaceRoot,
    prepared: {
      workspaceId: "default",
      accountId: "wx-account",
      senderId: "user-1",
      messageId: "msg-1",
      contextToken: "ctx-1",
      provider: "weixin",
      originalText: "",
      runtimeText: "image one",
      text: "image one",
      attachments: [{
        kind: "image",
        absolutePath: "/workspace/inbox/photo-1.jpg",
        sourceFileName: "photo-1.jpg",
        contentType: "image/jpeg",
        isImage: true,
      }],
      attachmentFailures: [],
      receivedAt: "2026-05-05T10:00:01.000Z",
    },
  });
  MossbridgeApp.prototype.enqueuePendingAttachmentInbound.call(appLike, {
    bindingKey,
    workspaceRoot,
    prepared: {
      workspaceId: "default",
      accountId: "wx-account",
      senderId: "user-1",
      messageId: "msg-2",
      contextToken: "ctx-1",
      provider: "weixin",
      originalText: "",
      runtimeText: "image two",
      text: "image two",
      attachments: [{
        kind: "image",
        absolutePath: "/workspace/inbox/photo-2.jpg",
        sourceFileName: "photo-2.jpg",
        contentType: "image/jpeg",
        isImage: true,
      }],
      attachmentFailures: [],
      receivedAt: "2026-05-05T10:00:02.000Z",
    },
  });

  assert.equal(routed.length, 0);
  assert.equal(typings.length, 2);

  const flushed = await MossbridgeApp.prototype.flushPendingAttachmentInboundBatch.call(appLike, {
    bindingKey,
    workspaceRoot,
  });

  assert.equal(flushed, true);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].prepared.attachments.length, 2);
  assert.match(routed[0].prepared.text, /photo-1\.jpg/);
  assert.match(routed[0].prepared.text, /photo-2\.jpg/);
  assert.match(routed[0].prepared.text, /图片请对保存后的本地图片文件使用 `Read`/);
  assert.match(routed[0].prepared.text, /合成一段自然回应/);
  assert.match(routed[0].prepared.text, /^\[memory\]/);
  assert.deepEqual(routed[0].prepared.memoryContextPacket, { hit_count: 1 });
});

test("image batch can merge with a trailing plain-text caption", async () => {
  const routed = [];
  const appLike = {
    config: {
      userName: "User",
      workspaceRoot: "/workspace",
    },
    pendingAttachmentInboundByScope: new Map(),
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
    },
    channelAdapter: {
      async sendTyping() {},
    },
    async routePreparedInbound(payload) {
      routed.push(payload);
      return true;
    },
    schedulePendingAttachmentInboundFlush: MossbridgeApp.prototype.schedulePendingAttachmentInboundFlush,
    clearPendingAttachmentInboundTimer: MossbridgeApp.prototype.clearPendingAttachmentInboundTimer,
    flushPendingAttachmentInboundBatch: MossbridgeApp.prototype.flushPendingAttachmentInboundBatch,
  };
  const bindingKey = "binding:user-1";
  const workspaceRoot = "/workspace";

  MossbridgeApp.prototype.enqueuePendingAttachmentInbound.call(appLike, {
    bindingKey,
    workspaceRoot,
    prepared: {
      workspaceId: "default",
      accountId: "wx-account",
      senderId: "user-1",
      messageId: "msg-1",
      contextToken: "ctx-1",
      provider: "weixin",
      originalText: "",
      runtimeText: "image one",
      text: "image one",
      attachments: [{
        kind: "image",
        absolutePath: "/workspace/inbox/sticker-candidate.jpg",
        sourceFileName: "sticker-candidate.jpg",
        contentType: "image/jpeg",
        isImage: true,
      }],
      attachmentFailures: [],
      receivedAt: "2026-05-05T10:00:01.000Z",
    },
  });
  MossbridgeApp.prototype.enqueuePendingAttachmentInbound.call(appLike, {
    bindingKey,
    workspaceRoot,
    prepared: {
      workspaceId: "default",
      accountId: "wx-account",
      senderId: "user-1",
      messageId: "msg-2",
      contextToken: "ctx-1",
      provider: "weixin",
      originalText: "这个能不能当表情包",
      runtimeText: "这个能不能当表情包",
      text: "这个能不能当表情包",
      attachments: [],
      attachmentFailures: [],
      receivedAt: "2026-05-05T10:00:03.000Z",
    },
    delayMs: 3000,
  });

  const flushed = await MossbridgeApp.prototype.flushPendingAttachmentInboundBatch.call(appLike, {
    bindingKey,
    workspaceRoot,
  });

  assert.equal(flushed, true);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].prepared.originalText, "这个能不能当表情包");
  assert.equal(routed[0].prepared.attachments.length, 1);
  assert.match(routed[0].prepared.text, /这个能不能当表情包/);
  assert.match(routed[0].prepared.text, /sticker-candidate\.jpg/);
});

test("caption after a pending image waits so the next short text can join", async () => {
  const routed = [];
  const scheduledDelays = [];
  const appLike = {
    config: {
      userName: "User",
      workspaceRoot: "/workspace",
    },
    pendingAttachmentInboundByScope: new Map(),
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding:user-1";
          },
        };
      },
      describe() {
        return { id: "claudecode" };
      },
    },
    streamDelivery: {
      setReplyTarget() {},
    },
    channelAdapter: {
      async sendTyping() {},
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    async prepareIncomingMessageForRuntime(normalized) {
      return {
        ...normalized,
        originalText: normalized.text,
        runtimeText: normalized.text || "image payload",
        text: normalized.text || "image payload",
        attachments: Array.isArray(normalized.attachments) ? normalized.attachments : [],
        attachmentFailures: [],
      };
    },
    async routePreparedInbound(payload) {
      routed.push(payload);
      return true;
    },
    schedulePendingAttachmentInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs = 1500) {
      scheduledDelays.push(delayMs);
      const draft = this.pendingAttachmentInboundByScope.get(scopeKey);
      if (draft?.timer) {
        clearTimeout(draft.timer);
      }
      draft.timer = setTimeout(() => {}, 60_000);
      this.pendingAttachmentInboundByScope.set(scopeKey, draft);
    },
    clearPendingAttachmentInboundTimer: MossbridgeApp.prototype.clearPendingAttachmentInboundTimer,
    flushPendingAttachmentInboundBatch: MossbridgeApp.prototype.flushPendingAttachmentInboundBatch,
    hasPendingAttachmentInbound: MossbridgeApp.prototype.hasPendingAttachmentInbound,
    enqueuePendingAttachmentInbound: MossbridgeApp.prototype.enqueuePendingAttachmentInbound,
  };

  await MossbridgeApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "wx-account",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "",
    attachments: [{
      kind: "image",
      absolutePath: "/workspace/inbox/photo.jpg",
      sourceFileName: "photo.jpg",
      contentType: "image/jpeg",
      isImage: true,
    }],
    receivedAt: "2026-05-05T10:00:01.000Z",
  }, { allowCommands: true });

  await MossbridgeApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "wx-account",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "先看这个图",
    attachments: [],
    receivedAt: "2026-05-05T10:00:03.000Z",
  }, { allowCommands: true });

  assert.equal(routed.length, 0);
  assert.deepEqual(scheduledDelays, [8000, 6000]);
  const pending = [...appLike.pendingAttachmentInboundByScope.values()][0];
  assert.equal(pending.messages.length, 2);

  MossbridgeApp.prototype.enqueuePendingAttachmentInbound.call(appLike, {
    bindingKey: "binding:user-1",
    workspaceRoot: "/workspace",
    prepared: {
      workspaceId: "default",
      accountId: "wx-account",
      senderId: "user-1",
      contextToken: "ctx-1",
      provider: "weixin",
      originalText: "第二句补充说明",
      runtimeText: "第二句补充说明",
      text: "第二句补充说明",
      attachments: [],
      attachmentFailures: [],
      receivedAt: "2026-05-05T10:00:05.000Z",
    },
    delayMs: 3000,
  });

  const flushed = await MossbridgeApp.prototype.flushPendingAttachmentInboundBatch.call(appLike, {
    bindingKey: "binding:user-1",
    workspaceRoot: "/workspace",
  });

  assert.equal(flushed, true);
  assert.equal(routed.length, 1);
  assert.match(routed[0].prepared.originalText, /先看这个图/);
  assert.match(routed[0].prepared.originalText, /第二句补充说明/);
  assert.equal(routed[0].prepared.attachments.length, 1);
});

test("short image prelude waits for a later poll image and merges", async () => {
  const routed = [];
  const scheduledDelays = [];
  const appLike = {
    config: {
      userName: "User",
      workspaceRoot: "/workspace",
    },
    pendingAttachmentInboundByScope: new Map(),
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding:user-1";
          },
        };
      },
      describe() {
        return { id: "claudecode" };
      },
    },
    streamDelivery: {
      setReplyTarget() {},
    },
    channelAdapter: {
      async sendTyping() {},
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    async prepareIncomingMessageForRuntime(normalized) {
      return {
        ...normalized,
        originalText: normalized.text,
        runtimeText: normalized.text || "image payload",
        text: normalized.text || "image payload",
        attachments: Array.isArray(normalized.attachments) ? normalized.attachments : [],
        attachmentFailures: [],
      };
    },
    async routePreparedInbound(payload) {
      routed.push(payload);
      return true;
    },
    async attachMemoryContextToPreparedText(_normalized, runtimeText) {
      return { text: runtimeText, packet: null };
    },
    schedulePendingAttachmentInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs = 8000) {
      scheduledDelays.push(delayMs);
      const draft = this.pendingAttachmentInboundByScope.get(scopeKey);
      if (draft?.timer) {
        clearTimeout(draft.timer);
      }
      draft.timer = setTimeout(() => {}, 60_000);
      this.pendingAttachmentInboundByScope.set(scopeKey, draft);
    },
    clearPendingAttachmentInboundTimer: MossbridgeApp.prototype.clearPendingAttachmentInboundTimer,
    flushPendingAttachmentInboundBatch: MossbridgeApp.prototype.flushPendingAttachmentInboundBatch,
    hasPendingAttachmentInbound: MossbridgeApp.prototype.hasPendingAttachmentInbound,
    enqueuePendingAttachmentInbound: MossbridgeApp.prototype.enqueuePendingAttachmentInbound,
    currentInboundBatchMayContainAttachmentForSender() {
      return false;
    },
  };

  await MossbridgeApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "wx-account",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "你看这个",
    attachments: [],
    receivedAt: "2026-05-05T10:00:01.000Z",
  }, { allowCommands: true });

  assert.equal(routed.length, 0);
  assert.equal(scheduledDelays[0], 12_000);
  assert.equal([...appLike.pendingAttachmentInboundByScope.values()][0].messages.length, 1);

  await MossbridgeApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "wx-account",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "",
    attachments: [{
      kind: "image",
      absolutePath: "/workspace/inbox/courtyard.jpg",
      sourceFileName: "courtyard.jpg",
      contentType: "image/jpeg",
      isImage: true,
    }],
    receivedAt: "2026-05-05T10:00:08.000Z",
  }, { allowCommands: true });

  assert.equal(routed.length, 0);
  assert.equal(scheduledDelays[1], 8000);

  const flushed = await MossbridgeApp.prototype.flushPendingAttachmentInboundBatch.call(appLike, {
    bindingKey: "binding:user-1",
    workspaceRoot: "/workspace",
  });

  assert.equal(flushed, true);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].prepared.originalText, "你看这个");
  assert.equal(routed[0].prepared.attachments.length, 1);
  assert.match(routed[0].prepared.text, /你看这个/);
  assert.match(routed[0].prepared.text, /courtyard\.jpg/);
});

test("short image prelude falls back to normal text if no image arrives", async () => {
  const routed = [];
  const scheduledDelays = [];
  const appLike = {
    config: {
      userName: "User",
      workspaceRoot: "/workspace",
    },
    pendingInboundByScope: new Map(),
    pendingAttachmentInboundByScope: new Map(),
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding:user-1";
          },
        };
      },
    },
    streamDelivery: {
      setReplyTarget() {},
    },
    channelAdapter: {
      async sendTyping() {},
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    async prepareIncomingMessageForRuntime(normalized) {
      return {
        ...normalized,
        originalText: normalized.text,
        runtimeText: normalized.text,
        text: normalized.text,
        attachments: [],
        attachmentFailures: [],
      };
    },
    async attachMemoryContextToPreparedText(_normalized, runtimeText) {
      return { text: runtimeText, packet: null };
    },
    schedulePendingAttachmentInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs = 8000) {
      scheduledDelays.push(delayMs);
      const draft = this.pendingAttachmentInboundByScope.get(scopeKey);
      if (draft?.timer) {
        clearTimeout(draft.timer);
      }
      draft.timer = setTimeout(() => {}, 60_000);
      this.pendingAttachmentInboundByScope.set(scopeKey, draft);
    },
    clearPendingAttachmentInboundTimer: MossbridgeApp.prototype.clearPendingAttachmentInboundTimer,
    flushPendingAttachmentInboundBatch: MossbridgeApp.prototype.flushPendingAttachmentInboundBatch,
    flushPendingInboundMessages: MossbridgeApp.prototype.flushPendingInboundMessages,
    hasPendingAttachmentInbound: MossbridgeApp.prototype.hasPendingAttachmentInbound,
    enqueuePendingAttachmentInbound: MossbridgeApp.prototype.enqueuePendingAttachmentInbound,
    currentInboundBatchMayContainAttachmentForSender() {
      return false;
    },
    isTurnDispatchBlocked() {
      return false;
    },
    async dispatchPreparedTurn(payload) {
      routed.push(payload);
      return true;
    },
  };

  await MossbridgeApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "wx-account",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "这个呢？",
    attachments: [],
    receivedAt: "2026-05-05T10:00:01.000Z",
  }, { allowCommands: true });

  assert.equal(routed.length, 0);
  assert.equal(scheduledDelays[0], 12_000);

  const flushed = await MossbridgeApp.prototype.flushPendingAttachmentInboundBatch.call(appLike, {
    bindingKey: "binding:user-1",
    workspaceRoot: "/workspace",
  });

  assert.equal(flushed, false);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].prepared.originalText, "这个呢？");
});

test("caption before an image in the same WeChat poll batch waits and merges", async () => {
  const routed = [];
  const scheduledDelays = [];
  const appLike = {
    config: {
      userName: "User",
      workspaceRoot: "/workspace",
    },
    pendingInboundByScope: new Map(),
    pendingAttachmentInboundByScope: new Map(),
    deferredAttachmentInboundFlushScopeKeys: new Set(),
    inboundUpdateBatchDepth: 0,
    inboundUpdateBatchAttachmentSenders: new Set(),
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding:user-1";
          },
        };
      },
      describe() {
        return { id: "claudecode" };
      },
    },
    streamDelivery: {
      setReplyTarget() {},
    },
    channelAdapter: {
      async sendTyping() {},
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    async prepareIncomingMessageForRuntime(normalized) {
      return {
        ...normalized,
        originalText: normalized.text,
        runtimeText: normalized.text || "image payload",
        text: normalized.text || "image payload",
        attachments: Array.isArray(normalized.attachments) ? normalized.attachments : [],
        attachmentFailures: [],
      };
    },
    async routePreparedInbound(payload) {
      routed.push(payload);
      return true;
    },
    async attachMemoryContextToPreparedText(_normalized, runtimeText) {
      return { text: runtimeText, packet: null };
    },
    schedulePendingAttachmentInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs = 8000) {
      scheduledDelays.push({ scopeKey, bindingKey, workspaceRoot, delayMs });
      const draft = this.pendingAttachmentInboundByScope.get(scopeKey);
      if (draft?.timer) {
        clearTimeout(draft.timer);
      }
      draft.timer = setTimeout(() => {}, 60_000);
      this.pendingAttachmentInboundByScope.set(scopeKey, draft);
    },
    clearPendingAttachmentInboundTimer: MossbridgeApp.prototype.clearPendingAttachmentInboundTimer,
    flushPendingAttachmentInboundBatch: MossbridgeApp.prototype.flushPendingAttachmentInboundBatch,
    flushPendingInboundMessages: MossbridgeApp.prototype.flushPendingInboundMessages,
    hasPendingAttachmentInbound: MossbridgeApp.prototype.hasPendingAttachmentInbound,
    enqueuePendingAttachmentInbound: MossbridgeApp.prototype.enqueuePendingAttachmentInbound,
    beginInboundUpdateBatch: MossbridgeApp.prototype.beginInboundUpdateBatch,
    endInboundUpdateBatch: MossbridgeApp.prototype.endInboundUpdateBatch,
    shouldDeferAttachmentInboundFlushUntilPollBatchEnds: MossbridgeApp.prototype.shouldDeferAttachmentInboundFlushUntilPollBatchEnds,
    currentInboundBatchMayContainAttachmentForSender: MossbridgeApp.prototype.currentInboundBatchMayContainAttachmentForSender,
    rememberDeferredAttachmentInboundFlush: MossbridgeApp.prototype.rememberDeferredAttachmentInboundFlush,
    scheduleDeferredAttachmentInboundFlushes: MossbridgeApp.prototype.scheduleDeferredAttachmentInboundFlushes,
    isTurnDispatchBlocked() {
      return false;
    },
    async dispatchPreparedTurn(payload) {
      routed.push(payload);
      return true;
    },
  };

  MossbridgeApp.prototype.beginInboundUpdateBatch.call(appLike, 2, [
    {
      from_user_id: "user-1",
      item_list: [{ type: 1, text_item: { text: "这个灯要不要装" } }],
    },
    {
      from_user_id: "user-1",
      item_list: [{ type: 2, image_item: { media: {} } }],
    },
  ]);

  await MossbridgeApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "wx-account",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "这个灯要不要装",
    attachments: [],
    receivedAt: "2026-05-05T10:00:01.000Z",
  }, { allowCommands: true });

  await MossbridgeApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "wx-account",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "",
    attachments: [{
      kind: "image",
      absolutePath: "/workspace/inbox/lamp.jpg",
      sourceFileName: "lamp.jpg",
      contentType: "image/jpeg",
      isImage: true,
    }],
    receivedAt: "2026-05-05T10:00:02.000Z",
  }, { allowCommands: true });

  assert.equal(routed.length, 0);
  assert.equal([...appLike.pendingAttachmentInboundByScope.values()][0].messages.length, 2);

  MossbridgeApp.prototype.endInboundUpdateBatch.call(appLike);
  assert.equal(scheduledDelays.length, 1);

  const flushed = await MossbridgeApp.prototype.flushPendingAttachmentInboundBatch.call(appLike, {
    bindingKey: "binding:user-1",
    workspaceRoot: "/workspace",
  });

  assert.equal(flushed, true);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].prepared.originalText, "这个灯要不要装");
  assert.equal(routed[0].prepared.attachments.length, 1);
  assert.match(routed[0].prepared.text, /这个灯要不要装/);
  assert.match(routed[0].prepared.text, /lamp\.jpg/);
});

test("caption before a file in the same WeChat poll batch waits and merges", async () => {
  const routed = [];
  const scheduledDelays = [];
  const appLike = {
    config: {
      userName: "User",
      workspaceRoot: "/workspace",
    },
    pendingInboundByScope: new Map(),
    pendingAttachmentInboundByScope: new Map(),
    deferredAttachmentInboundFlushScopeKeys: new Set(),
    inboundUpdateBatchDepth: 0,
    inboundUpdateBatchAttachmentSenders: new Set(),
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding:user-1";
          },
        };
      },
      describe() {
        return { id: "claudecode" };
      },
    },
    streamDelivery: {
      setReplyTarget() {},
    },
    channelAdapter: {
      async sendTyping() {},
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    async prepareIncomingMessageForRuntime(normalized) {
      return {
        ...normalized,
        originalText: normalized.text,
        runtimeText: normalized.text || "file payload",
        text: normalized.text || "file payload",
        attachments: Array.isArray(normalized.attachments) ? normalized.attachments : [],
        attachmentFailures: [],
      };
    },
    async routePreparedInbound(payload) {
      routed.push(payload);
      return true;
    },
    async attachMemoryContextToPreparedText(_normalized, runtimeText) {
      return { text: runtimeText, packet: null };
    },
    schedulePendingAttachmentInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs = 8000) {
      scheduledDelays.push({ scopeKey, bindingKey, workspaceRoot, delayMs });
      const draft = this.pendingAttachmentInboundByScope.get(scopeKey);
      if (draft?.timer) {
        clearTimeout(draft.timer);
      }
      draft.timer = setTimeout(() => {}, 60_000);
      this.pendingAttachmentInboundByScope.set(scopeKey, draft);
    },
    clearPendingAttachmentInboundTimer: MossbridgeApp.prototype.clearPendingAttachmentInboundTimer,
    flushPendingAttachmentInboundBatch: MossbridgeApp.prototype.flushPendingAttachmentInboundBatch,
    flushPendingInboundMessages: MossbridgeApp.prototype.flushPendingInboundMessages,
    hasPendingAttachmentInbound: MossbridgeApp.prototype.hasPendingAttachmentInbound,
    enqueuePendingAttachmentInbound: MossbridgeApp.prototype.enqueuePendingAttachmentInbound,
    beginInboundUpdateBatch: MossbridgeApp.prototype.beginInboundUpdateBatch,
    endInboundUpdateBatch: MossbridgeApp.prototype.endInboundUpdateBatch,
    shouldDeferAttachmentInboundFlushUntilPollBatchEnds: MossbridgeApp.prototype.shouldDeferAttachmentInboundFlushUntilPollBatchEnds,
    currentInboundBatchMayContainAttachmentForSender: MossbridgeApp.prototype.currentInboundBatchMayContainAttachmentForSender,
    rememberDeferredAttachmentInboundFlush: MossbridgeApp.prototype.rememberDeferredAttachmentInboundFlush,
    scheduleDeferredAttachmentInboundFlushes: MossbridgeApp.prototype.scheduleDeferredAttachmentInboundFlushes,
    isTurnDispatchBlocked() {
      return false;
    },
    async dispatchPreparedTurn(payload) {
      routed.push(payload);
      return true;
    },
  };

  MossbridgeApp.prototype.beginInboundUpdateBatch.call(appLike, 2, [
    {
      from_user_id: "user-1",
      item_list: [{ type: 1, text_item: { text: "这是那份稿子" } }],
    },
    {
      from_user_id: "user-1",
      item_list: [{ type: 4, file_item: { media: {} } }],
    },
  ]);

  await MossbridgeApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "wx-account",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "这是那份稿子",
    attachments: [],
    receivedAt: "2026-05-05T10:00:01.000Z",
  }, { allowCommands: true });

  await MossbridgeApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "wx-account",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "",
    attachments: [{
      kind: "file",
      absolutePath: "/workspace/inbox/draft.md",
      sourceFileName: "draft.md",
      contentType: "text/markdown",
      isImage: false,
    }],
    receivedAt: "2026-05-05T10:00:02.000Z",
  }, { allowCommands: true });

  assert.equal(routed.length, 0);
  assert.equal([...appLike.pendingAttachmentInboundByScope.values()][0].messages.length, 2);

  MossbridgeApp.prototype.endInboundUpdateBatch.call(appLike);
  assert.equal(scheduledDelays.length, 1);

  const flushed = await MossbridgeApp.prototype.flushPendingAttachmentInboundBatch.call(appLike, {
    bindingKey: "binding:user-1",
    workspaceRoot: "/workspace",
  });

  assert.equal(flushed, true);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].prepared.originalText, "这是那份稿子");
  assert.equal(routed[0].prepared.attachments.length, 1);
  assert.match(routed[0].prepared.text, /这是那份稿子/);
  assert.match(routed[0].prepared.text, /draft\.md/);
  assert.match(routed[0].prepared.text, /文档、视频或其他文件/);
});

test("failed image intake can wait and merge with later saved images", async () => {
  const routed = [];
  const appLike = {
    config: {
      userName: "User",
      workspaceRoot: "/workspace",
    },
    pendingAttachmentInboundByScope: new Map(),
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding:user-1";
          },
        };
      },
      describe() {
        return { id: "claudecode" };
      },
    },
    streamDelivery: {
      setReplyTarget() {},
    },
    channelAdapter: {
      async sendTyping() {},
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    async prepareIncomingMessageForRuntime(normalized) {
      return {
        ...normalized,
        originalText: normalized.text,
        runtimeText: normalized.text || "attachment payload",
        text: normalized.text || "attachment payload",
        attachments: Array.isArray(normalized.attachments) ? normalized.attachments : [],
        attachmentFailures: Array.isArray(normalized.attachmentFailures) ? normalized.attachmentFailures : [],
      };
    },
    async routePreparedInbound(payload) {
      routed.push(payload);
      return true;
    },
    schedulePendingAttachmentInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs = 8000) {
      const draft = this.pendingAttachmentInboundByScope.get(scopeKey);
      if (draft?.timer) {
        clearTimeout(draft.timer);
      }
      draft.timer = setTimeout(() => {}, 60_000);
      this.pendingAttachmentInboundByScope.set(scopeKey, draft);
    },
    clearPendingAttachmentInboundTimer: MossbridgeApp.prototype.clearPendingAttachmentInboundTimer,
    flushPendingAttachmentInboundBatch: MossbridgeApp.prototype.flushPendingAttachmentInboundBatch,
    hasPendingAttachmentInbound: MossbridgeApp.prototype.hasPendingAttachmentInbound,
    enqueuePendingAttachmentInbound: MossbridgeApp.prototype.enqueuePendingAttachmentInbound,
  };

  await MossbridgeApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "wx-account",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "",
    attachments: [],
    attachmentFailures: [{
      kind: "image",
      sourceFileName: "lost-photo.jpg",
      reason: "attachment download failed",
    }],
    receivedAt: "2026-05-05T10:00:01.000Z",
  }, { allowCommands: true });

  await MossbridgeApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default",
    accountId: "wx-account",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
    text: "",
    attachments: [{
      kind: "image",
      absolutePath: "/workspace/inbox/photo-ok.jpg",
      sourceFileName: "photo-ok.jpg",
      contentType: "image/jpeg",
      isImage: true,
    }],
    attachmentFailures: [],
    receivedAt: "2026-05-05T10:00:02.000Z",
  }, { allowCommands: true });

  assert.equal(routed.length, 0);
  const pending = [...appLike.pendingAttachmentInboundByScope.values()][0];
  assert.equal(pending.messages.length, 2);

  const flushed = await MossbridgeApp.prototype.flushPendingAttachmentInboundBatch.call(appLike, {
    bindingKey: "binding:user-1",
    workspaceRoot: "/workspace",
  });

  assert.equal(flushed, true);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].prepared.attachments.length, 1);
  assert.equal(routed[0].prepared.attachmentFailures.length, 1);
  assert.match(routed[0].prepared.text, /photo-ok\.jpg/);
  assert.match(routed[0].prepared.text, /lost-photo\.jpg/);
  assert.match(routed[0].prepared.text, /consider the saved attachments first/i);
});

test("attachment flush waits until a multi-message WeChat poll batch has been processed", () => {
  const scheduled = [];
  const typings = [];
  const appLike = {
    pendingAttachmentInboundByScope: new Map(),
    deferredAttachmentInboundFlushScopeKeys: new Set(),
    inboundUpdateBatchDepth: 0,
    channelAdapter: {
      async sendTyping(payload) {
        typings.push(payload);
      },
    },
    schedulePendingAttachmentInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs = 1500) {
      scheduled.push({ scopeKey, bindingKey, workspaceRoot, delayMs });
    },
    clearPendingAttachmentInboundTimer: MossbridgeApp.prototype.clearPendingAttachmentInboundTimer,
    beginInboundUpdateBatch: MossbridgeApp.prototype.beginInboundUpdateBatch,
    endInboundUpdateBatch: MossbridgeApp.prototype.endInboundUpdateBatch,
    shouldDeferAttachmentInboundFlushUntilPollBatchEnds: MossbridgeApp.prototype.shouldDeferAttachmentInboundFlushUntilPollBatchEnds,
    rememberDeferredAttachmentInboundFlush: MossbridgeApp.prototype.rememberDeferredAttachmentInboundFlush,
    scheduleDeferredAttachmentInboundFlushes: MossbridgeApp.prototype.scheduleDeferredAttachmentInboundFlushes,
    enqueuePendingAttachmentInbound: MossbridgeApp.prototype.enqueuePendingAttachmentInbound,
  };
  const bindingKey = "binding:user-1";
  const workspaceRoot = "/workspace";

  MossbridgeApp.prototype.beginInboundUpdateBatch.call(appLike, 5);
  MossbridgeApp.prototype.enqueuePendingAttachmentInbound.call(appLike, {
    bindingKey,
    workspaceRoot,
    prepared: {
      workspaceId: "default",
      accountId: "wx-account",
      senderId: "user-1",
      messageId: "msg-1",
      contextToken: "ctx-1",
      provider: "weixin",
      originalText: "",
      runtimeText: "image one",
      text: "image one",
      attachments: [{
        kind: "image",
        absolutePath: "/workspace/inbox/photo-1.jpg",
        sourceFileName: "photo-1.jpg",
        contentType: "image/jpeg",
        isImage: true,
      }],
      attachmentFailures: [],
      receivedAt: "2026-05-05T10:00:01.000Z",
    },
  });
  MossbridgeApp.prototype.enqueuePendingAttachmentInbound.call(appLike, {
    bindingKey,
    workspaceRoot,
    prepared: {
      workspaceId: "default",
      accountId: "wx-account",
      senderId: "user-1",
      messageId: "msg-2",
      contextToken: "ctx-1",
      provider: "weixin",
      originalText: "",
      runtimeText: "image two",
      text: "image two",
      attachments: [{
        kind: "image",
        absolutePath: "/workspace/inbox/photo-2.jpg",
        sourceFileName: "photo-2.jpg",
        contentType: "image/jpeg",
        isImage: true,
      }],
      attachmentFailures: [],
      receivedAt: "2026-05-05T10:00:02.000Z",
    },
  });

  assert.equal(scheduled.length, 0);
  assert.equal(typings.length, 2);
  assert.equal([...appLike.pendingAttachmentInboundByScope.values()][0].messages.length, 2);

  MossbridgeApp.prototype.endInboundUpdateBatch.call(appLike);

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].scopeKey, "binding:user-1::/workspace");
});

test("attachment flush waits until slow attachment intake finishes", async () => {
  const typings = [];
  const appLike = {
    pendingAttachmentInboundByScope: new Map(),
    pendingAttachmentIntakeByScope: new Map(),
    deferredAttachmentInboundFlushScopeKeys: new Set(),
    channelAdapter: {
      async sendTyping(payload) {
        typings.push(payload);
      },
    },
    schedulePendingAttachmentInboundFlush: MossbridgeApp.prototype.schedulePendingAttachmentInboundFlush,
    clearPendingAttachmentInboundTimer: MossbridgeApp.prototype.clearPendingAttachmentInboundTimer,
    beginPendingAttachmentIntake: MossbridgeApp.prototype.beginPendingAttachmentIntake,
    endPendingAttachmentIntake: MossbridgeApp.prototype.endPendingAttachmentIntake,
    enqueuePendingAttachmentInbound: MossbridgeApp.prototype.enqueuePendingAttachmentInbound,
  };
  const bindingKey = "binding:user-1";
  const workspaceRoot = "/workspace";
  const scopeKey = "binding:user-1::/workspace";

  MossbridgeApp.prototype.beginPendingAttachmentIntake.call(appLike, bindingKey, workspaceRoot);
  MossbridgeApp.prototype.enqueuePendingAttachmentInbound.call(appLike, {
    bindingKey,
    workspaceRoot,
    prepared: {
      workspaceId: "default",
      accountId: "wx-account",
      senderId: "user-1",
      messageId: "msg-1",
      contextToken: "ctx-1",
      provider: "weixin",
      originalText: "",
      runtimeText: "image one",
      text: "image one",
      attachments: [{
        kind: "image",
        absolutePath: "/workspace/inbox/photo-1.jpg",
        sourceFileName: "photo-1.jpg",
        contentType: "image/jpeg",
        isImage: true,
      }],
      attachmentFailures: [],
      receivedAt: "2026-05-05T10:00:01.000Z",
    },
  });

  let draft = appLike.pendingAttachmentInboundByScope.get(scopeKey);
  assert.equal(typings.length, 1);
  assert.equal(draft.messages.length, 1);
  assert.equal(draft.timer, null);
  assert.equal(appLike.deferredAttachmentInboundFlushScopeKeys.has(scopeKey), true);

  MossbridgeApp.prototype.endPendingAttachmentIntake.call(appLike, { bindingKey, workspaceRoot });
  draft = appLike.pendingAttachmentInboundByScope.get(scopeKey);
  assert.ok(draft.timer);
  assert.equal(appLike.deferredAttachmentInboundFlushScopeKeys.has(scopeKey), false);
  clearTimeout(draft.timer);
});

test("attachment intake completion stays deferred while the WeChat poll batch is still open", () => {
  const scheduled = [];
  const appLike = {
    pendingAttachmentInboundByScope: new Map(),
    pendingAttachmentIntakeByScope: new Map(),
    deferredAttachmentInboundFlushScopeKeys: new Set(),
    inboundUpdateBatchDepth: 1,
    schedulePendingAttachmentInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs) {
      scheduled.push({ scopeKey, bindingKey, workspaceRoot, delayMs });
    },
    clearPendingAttachmentInboundTimer: MossbridgeApp.prototype.clearPendingAttachmentInboundTimer,
    endPendingAttachmentIntake: MossbridgeApp.prototype.endPendingAttachmentIntake,
  };
  const bindingKey = "binding:user-1";
  const workspaceRoot = "/workspace";
  const scopeKey = "binding:user-1::/workspace";
  appLike.pendingAttachmentIntakeByScope.set(scopeKey, 1);
  appLike.pendingAttachmentInboundByScope.set(scopeKey, {
    bindingKey,
    workspaceRoot,
    messages: [{ messageId: "image-1", attachments: [{ kind: "image" }] }],
    timer: null,
  });

  MossbridgeApp.prototype.endPendingAttachmentIntake.call(appLike, { bindingKey, workspaceRoot });

  assert.equal(scheduled.length, 0);
  assert.equal(appLike.pendingAttachmentIntakeByScope.has(scopeKey), false);
  assert.equal(appLike.deferredAttachmentInboundFlushScopeKeys.has(scopeKey), true);
  assert.equal(appLike.pendingAttachmentInboundByScope.get(scopeKey).timer, null);
});

test("location arrive_home trigger enqueues a system action message", () => {
  const queued = [];
  MossbridgeApp.prototype.handleLocationAccepted.call({
    activeAccountId: "wx-account",
    config: {
      allowedUserIds: ["user-1"],
      workspaceRoot: "/workspace",
      workspaceId: "default",
    },
    runtimeAdapter: {
      getSessionStore() {
        return {};
      },
    },
    systemMessageQueue: {
      enqueue(message) {
        queued.push(message);
        return message;
      },
    },
  }, {
    appended: {
      point: {
        id: "point-1",
        trigger: "arrive_home",
        timestamp: "2026-04-18T16:00:00.000Z",
        receivedAt: "2026-04-18T16:00:01.000Z",
      },
      movementEvent: null,
    },
  });

  assert.equal(queued.length, 1);
  assert.equal(queued[0].id, "location-trigger:point-1");
  assert.equal(queued[0].senderId, "user-1");
  assert.equal(queued[0].workspaceRoot, "/workspace");
  assert.equal(queued[0].text, "User arrives home.");
  assert.equal(queued[0].kind, "location_trigger");
  assert.equal(queued[0].metadata.trigger, "arrive_home");
});

test("location leave_home trigger and major move both enqueue system action messages", () => {
  const queued = [];
  MossbridgeApp.prototype.handleLocationAccepted.call({
    activeAccountId: "wx-account",
    config: {
      allowedUserIds: ["user-1"],
      workspaceRoot: "/workspace",
      workspaceId: "default",
    },
    runtimeAdapter: {
      getSessionStore() {
        return {};
      },
    },
    systemMessageQueue: {
      enqueue(message) {
        queued.push(message);
        return message;
      },
    },
  }, {
    appended: {
      point: {
        id: "point-2",
        trigger: "leave_home",
        timestamp: "2026-04-18T17:00:00.000Z",
        receivedAt: "2026-04-18T17:00:02.000Z",
      },
      movementEvent: {
        id: "move-1",
        distanceMeters: 2400,
        fromAddress: "Home",
        toAddress: "Office",
        movedAt: "2026-04-18T17:20:00.000Z",
      },
    },
  });

  assert.equal(queued.length, 2);
  assert.equal(queued[0].id, "location-trigger:point-2");
  assert.equal(queued[0].text, "User leaves home.");
  assert.equal(queued[0].kind, "location_trigger");
  assert.equal(queued[1].id, "location-move:move-1");
  assert.match(queued[1].text, /location appears to have changed significantly/i);
  assert.equal(queued[1].kind, "location_movement");
  assert.equal(queued[1].metadata.distanceText, "2.4km");
});

test("system dispatcher gives due reminders obligation framing instead of generic trigger text", () => {
  const dispatcher = new SystemMessageDispatcher({
    queueStore: { hasPendingForAccount() { return false; }, drainForAccount() { return []; }, enqueue() {} },
    config: {
      workspaceId: "default",
      workspaceRoot: "/workspace",
    },
    accountId: "wx-account",
  });

  const prepared = dispatcher.buildPreparedMessage({
    id: "sys-1",
    senderId: "user-1",
    text: "Due reminder for User: 记得晚上洗头",
    kind: "reminder_due",
    priority: "high",
    title: "due_reminder",
    metadata: {
      reminderText: "记得晚上洗头",
      dueAt: "2026-04-25 21:30",
    },
    createdAt: "2026-04-25T13:30:00.000Z",
  }, "ctx");

  assert.match(prepared.text, /Trigger kind: reminder_due/i);
  assert.match(prepared.text, /Treat the reminder as already accepted/i);
  assert.match(prepared.text, /Reminder text: 记得晚上洗头\./i);
  assert.match(prepared.text, /Due at: 2026-04-25 21:30\./i);
});

test("system dispatcher keeps random checkin as an opportunity instead of a mandatory interruption", () => {
  const dispatcher = new SystemMessageDispatcher({
    queueStore: { hasPendingForAccount() { return false; }, drainForAccount() { return []; }, enqueue() {} },
    config: {
      workspaceId: "default",
      workspaceRoot: "/workspace",
    },
    accountId: "wx-account",
  });

  const prepared = dispatcher.buildPreparedMessage({
    id: "sys-2",
    senderId: "user-1",
    text: "User comes to mind again.",
    kind: "checkin_opportunity",
    priority: "normal",
    title: "random_checkin",
    metadata: {
      checkinKind: "random_checkin",
    },
    createdAt: "2026-04-25T13:30:00.000Z",
  }, "ctx");

  assert.match(prepared.text, /Trigger kind: checkin_opportunity/i);
  assert.match(prepared.text, /autonomous check-in opportunity/i);
  assert.match(prepared.text, /natural contact, a bounded private action, a future checkpoint, or quiet/i);
  assert.match(prepared.text, /prefer a read before a write/i);
  assert.match(prepared.text, /without waiting for a meal, reminder or emergency/i);
  assert.match(prepared.text, /Keep control-plane state backstage/i);
  assert.match(prepared.text, /Do not invent a conversational premise/i);
  assert.match(prepared.text, /Service restarts, account rebinding, credential changes, memory deletion/i);
  assert.doesNotMatch(prepared.text, /background package|maintenance and reconnection|continuity handle/i);
});
