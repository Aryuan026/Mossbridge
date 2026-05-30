const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { MossbridgeApp } = require("../src/core/app");
const { SystemMessageDispatcher } = require("../src/core/system-message-dispatcher");

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
  assert.match(prepared.text, /keep the turn to injected context plus the final JSON action/);
  assert.match(prepared.text, /natural WeChat/);
  assert.match(prepared.text, /emotional continuity/);
  assert.match(prepared.text, /Bridge status reports come from \[Mossbridge\]/);
  assert.doesNotMatch(prepared.text, /Use tools as affordances/);
  assert.doesNotMatch(prepared.text, /Safe scope:/);
  assert.doesNotMatch(prepared.text, /WECHAT SESSION INSTRUCTIONS/);
  assert.doesNotMatch(prepared.text, /front-stage style/);
  assert.ok(prepared.text.length < 2400);
});

test("stable WeChat guidance is delivered once per runtime thread and pressure trims memory prelude", async () => {
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

  assert.match(first.text, /微信前台对话提醒/);
  assert.match(first.text, /关系、情绪和事实不用排队/);
  assert.doesNotMatch(first.text, /先接住这一拍/);
  assert.doesNotMatch(second.text, /微信前台对话提醒/);
  assert.equal(captureArgs[0].includeRuntimePreludeGuidance, true);
  assert.equal(captureArgs[1].includeRuntimePreludeGuidance, false);
  assert.equal(captureArgs[0].preludeRecentThreadLimit, 2);
  assert.equal(captureArgs[0].preludeHotUpstreamLimit, 2);
  assert.equal(captureArgs[0].preludeHotTurnLimit, 3);
  assert.equal(captureArgs[0].coldVineLimit, 1);
  assert.equal(first.packet.delivery.mode, "inbound");
  assert.equal(first.packet.delivery.include_stable_guidance, true);
  assert.ok(first.packet.delivery.estimated_tokens > 0);
  assert.equal(second.packet.delivery.include_stable_guidance, false);
  assert.equal(second.packet.delivery.policy.includes("not injected"), true);
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
    text: "宝宝😏？",
  }, "宝宝😏？", "/workspace");

  assert.doesNotMatch(result.text, /\[微信前台对话提醒\]/);
  assert.doesNotMatch(result.text, /\[当前可用动作提醒\]/);
  assert.match(result.text, /resident-anchor: relation line/);
  assert.match(result.text, /宝宝😏？/);
});

test("tool hover mentions AI-calendar wakeups on the first keyed guidance turn", async () => {
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

  assert.match(result.text, /AI 日历\/提醒/);
  assert.match(result.text, /到期唤醒会携带完整工具能力/);
  assert.match(result.text, /随机心跳只负责轻量续联/);
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
  assert.match(prepared.text, /lightweight maintenance and reconnection window/i);
  assert.match(prepared.text, /small, low-risk maintenance pass/i);
  assert.match(prepared.text, /Prefer read-only checks first/i);
  assert.match(prepared.text, /Safe writes are small continuity handles/i);
  assert.match(prepared.text, /capability request/i);
  assert.match(prepared.text, /Service restarts, account rebinding, credential changes, memory deletion/i);
  assert.match(prepared.text, /solitude journal entry/i);
  assert.match(prepared.text, /Store shareable outcomes instead of raw hidden chain-of-thought/i);
  assert.match(prepared.text, /wakeup decision record/i);
  assert.match(prepared.text, /continuity handle/i);
  assert.match(prepared.text, /may gently interrupt/i);
  assert.match(prepared.text, /Meal times, reminders, and obviously important events are examples/i);
  assert.match(prepared.text, /maintenance done or intentionally skipped/i);
  assert.match(prepared.text, /Silence is useful when it protects attention/i);
});
