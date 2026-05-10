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
            return String(bindingKey).includes("#asherie-system") ? "" : "user-thread";
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
  assert.equal(dispatched[0].bindingKey, "binding:user-1#asherie-system");
  assert.deepEqual(clearedThreads, [["binding:user-1#asherie-system", "/workspace"]]);
  assert.equal(updatedBindings[0][1].replySenderId, "user-1");
  assert.match(dispatched[0].prepared.text, /ongoing: 起床提醒/);
  assert.match(dispatched[0].prepared.text, /Trigger kind: reminder_due/);
  assert.deepEqual(dispatched[0].prepared.memoryContextPacket?.retrieval?.route, ["warm_memory", "resident_warm"]);
  assert.equal(dispatched[0].prepared.systemTurn.trigger_kind, "reminder_due");
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

test("ordinary wechat turns prepend a front-stage note that resists terse defaults", async () => {
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

  assert.match(result.text, /\[微信前台对话提醒\]/);
  assert.match(result.text, /传输占位符/);
  assert.match(result.text, /后台 short\/concise 不支配前台表达/);
  assert.match(result.text, /先接住这一拍的情绪和关系节奏/);
  assert.match(result.text, /resident-anchor: relation line/);
  assert.match(result.text, /宝宝😏？/);
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
    pendingImageInboundByScope: new Map(),
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
    schedulePendingImageInboundFlush: MossbridgeApp.prototype.schedulePendingImageInboundFlush,
    clearPendingImageInboundTimer: MossbridgeApp.prototype.clearPendingImageInboundTimer,
    flushPendingImageInboundBatch: MossbridgeApp.prototype.flushPendingImageInboundBatch,
  };
  const bindingKey = "binding:user-1";
  const workspaceRoot = "/workspace";

  MossbridgeApp.prototype.enqueuePendingImageInbound.call(appLike, {
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
  MossbridgeApp.prototype.enqueuePendingImageInbound.call(appLike, {
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

  const flushed = await MossbridgeApp.prototype.flushPendingImageInboundBatch.call(appLike, {
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
    pendingImageInboundByScope: new Map(),
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
    schedulePendingImageInboundFlush: MossbridgeApp.prototype.schedulePendingImageInboundFlush,
    clearPendingImageInboundTimer: MossbridgeApp.prototype.clearPendingImageInboundTimer,
    flushPendingImageInboundBatch: MossbridgeApp.prototype.flushPendingImageInboundBatch,
  };
  const bindingKey = "binding:user-1";
  const workspaceRoot = "/workspace";

  MossbridgeApp.prototype.enqueuePendingImageInbound.call(appLike, {
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
  MossbridgeApp.prototype.enqueuePendingImageInbound.call(appLike, {
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

  const flushed = await MossbridgeApp.prototype.flushPendingImageInboundBatch.call(appLike, {
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
    pendingImageInboundByScope: new Map(),
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
    schedulePendingImageInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs = 1500) {
      scheduledDelays.push(delayMs);
      const draft = this.pendingImageInboundByScope.get(scopeKey);
      if (draft?.timer) {
        clearTimeout(draft.timer);
      }
      draft.timer = setTimeout(() => {}, 60_000);
      this.pendingImageInboundByScope.set(scopeKey, draft);
    },
    clearPendingImageInboundTimer: MossbridgeApp.prototype.clearPendingImageInboundTimer,
    flushPendingImageInboundBatch: MossbridgeApp.prototype.flushPendingImageInboundBatch,
    hasPendingImageInbound: MossbridgeApp.prototype.hasPendingImageInbound,
    enqueuePendingImageInbound: MossbridgeApp.prototype.enqueuePendingImageInbound,
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
  const pending = [...appLike.pendingImageInboundByScope.values()][0];
  assert.equal(pending.messages.length, 2);

  MossbridgeApp.prototype.enqueuePendingImageInbound.call(appLike, {
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

  const flushed = await MossbridgeApp.prototype.flushPendingImageInboundBatch.call(appLike, {
    bindingKey: "binding:user-1",
    workspaceRoot: "/workspace",
  });

  assert.equal(flushed, true);
  assert.equal(routed.length, 1);
  assert.match(routed[0].prepared.originalText, /先看这个图/);
  assert.match(routed[0].prepared.originalText, /第二句补充说明/);
  assert.equal(routed[0].prepared.attachments.length, 1);
});

test("failed image intake can wait and merge with later saved images", async () => {
  const routed = [];
  const appLike = {
    config: {
      userName: "User",
      workspaceRoot: "/workspace",
    },
    pendingImageInboundByScope: new Map(),
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
    schedulePendingImageInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs = 8000) {
      const draft = this.pendingImageInboundByScope.get(scopeKey);
      if (draft?.timer) {
        clearTimeout(draft.timer);
      }
      draft.timer = setTimeout(() => {}, 60_000);
      this.pendingImageInboundByScope.set(scopeKey, draft);
    },
    clearPendingImageInboundTimer: MossbridgeApp.prototype.clearPendingImageInboundTimer,
    flushPendingImageInboundBatch: MossbridgeApp.prototype.flushPendingImageInboundBatch,
    hasPendingImageInbound: MossbridgeApp.prototype.hasPendingImageInbound,
    enqueuePendingImageInbound: MossbridgeApp.prototype.enqueuePendingImageInbound,
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
  const pending = [...appLike.pendingImageInboundByScope.values()][0];
  assert.equal(pending.messages.length, 2);

  const flushed = await MossbridgeApp.prototype.flushPendingImageInboundBatch.call(appLike, {
    bindingKey: "binding:user-1",
    workspaceRoot: "/workspace",
  });

  assert.equal(flushed, true);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].prepared.attachments.length, 1);
  assert.equal(routed[0].prepared.attachmentFailures.length, 1);
  assert.match(routed[0].prepared.text, /photo-ok\.jpg/);
  assert.match(routed[0].prepared.text, /lost-photo\.jpg/);
  assert.match(routed[0].prepared.text, /do not ignore the saved attachments/i);
});

test("image flush waits until a multi-message WeChat poll batch has been processed", () => {
  const scheduled = [];
  const typings = [];
  const appLike = {
    pendingImageInboundByScope: new Map(),
    deferredImageInboundFlushScopeKeys: new Set(),
    inboundUpdateBatchDepth: 0,
    channelAdapter: {
      async sendTyping(payload) {
        typings.push(payload);
      },
    },
    schedulePendingImageInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs = 1500) {
      scheduled.push({ scopeKey, bindingKey, workspaceRoot, delayMs });
    },
    clearPendingImageInboundTimer: MossbridgeApp.prototype.clearPendingImageInboundTimer,
    beginInboundUpdateBatch: MossbridgeApp.prototype.beginInboundUpdateBatch,
    endInboundUpdateBatch: MossbridgeApp.prototype.endInboundUpdateBatch,
    shouldDeferImageInboundFlushUntilPollBatchEnds: MossbridgeApp.prototype.shouldDeferImageInboundFlushUntilPollBatchEnds,
    rememberDeferredImageInboundFlush: MossbridgeApp.prototype.rememberDeferredImageInboundFlush,
    scheduleDeferredImageInboundFlushes: MossbridgeApp.prototype.scheduleDeferredImageInboundFlushes,
    enqueuePendingImageInbound: MossbridgeApp.prototype.enqueuePendingImageInbound,
  };
  const bindingKey = "binding:user-1";
  const workspaceRoot = "/workspace";

  MossbridgeApp.prototype.beginInboundUpdateBatch.call(appLike, 5);
  MossbridgeApp.prototype.enqueuePendingImageInbound.call(appLike, {
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
  MossbridgeApp.prototype.enqueuePendingImageInbound.call(appLike, {
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
  assert.equal([...appLike.pendingImageInboundByScope.values()][0].messages.length, 2);

  MossbridgeApp.prototype.endInboundUpdateBatch.call(appLike);

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].scopeKey, "binding:user-1::/workspace");
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
  assert.match(prepared.text, /This is a due obligation, not a random thought/i);
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
  assert.match(prepared.text, /solitude journal entry/i);
  assert.match(prepared.text, /Do not store raw hidden chain-of-thought/i);
  assert.match(prepared.text, /wakeup decision record/i);
  assert.match(prepared.text, /continuity handle/i);
  assert.match(prepared.text, /allowed to gently interrupt/i);
  assert.match(prepared.text, /Do not wait only for meal times/i);
  assert.match(prepared.text, /maintenance done or intentionally skipped/i);
  assert.match(prepared.text, /Choose silence only when you have a concrete reason/i);
});
