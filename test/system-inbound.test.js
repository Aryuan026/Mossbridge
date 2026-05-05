const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { CyberbossApp } = require("../src/core/app");
const { SystemMessageDispatcher } = require("../src/core/system-message-dispatcher");

test("system messages bypass normal inbound wrapping", async () => {
  const prepared = await CyberbossApp.prototype.prepareIncomingMessageForRuntime.call({
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
  const result = await CyberbossApp.prototype.attachMemoryContextToPreparedText.call({
    projectDomains: {
      memory: {
        async captureContextPacket(args) {
          received = args;
          return {
            runtime_prelude: "AsherieBridge memory context\n- warm-card: Meteor necklace",
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
  assert.equal(received.sourceClient, "asheriebridge_system_turn");
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
    isTurnDispatchBlocked: CyberbossApp.prototype.isTurnDispatchBlocked,
    prepareSystemRuntimeBinding: CyberbossApp.prototype.prepareSystemRuntimeBinding,
    async attachMemoryContextToPreparedText(normalized, runtimeText, workspaceRoot) {
      assert.equal(normalized.provider, "system");
      assert.equal(workspaceRoot, "/workspace");
      assert.match(normalized.originalText, /reminder: 10 点问我起床没/);
      assert.match(runtimeText, /SYSTEM ACTION MODE/);
      return {
        text: `[AsherieBridge memory context]\n- ongoing: 起床提醒 | active | 近期作息\n\n===== Current Inbound Message =====\n${runtimeText}`,
        packet: {
          retrieval: { route: ["warm_memory", "resident_warm"], mode: "asheriebridge_context_packet" },
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

  const ok = await CyberbossApp.prototype.dispatchSystemMessage.call(appLike, {
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
  const ok = await CyberbossApp.prototype.dispatchSystemMessage.call({
    sendDirectVisibleSystemReply: CyberbossApp.prototype.sendDirectVisibleSystemReply,
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
  const result = await CyberbossApp.prototype.attachMemoryContextToPreparedText.call({
    projectDomains: {
      memory: {
        async captureContextPacket() {
          return {
            runtime_prelude: "[AsherieBridge memory context]\n- resident-anchor: relation line",
          };
        },
      },
    },
  }, {
    provider: "weixin",
    senderId: "user-1",
    text: "宝宝😏？",
  }, "宝宝😏？", "/workspace");

  assert.match(result.text, /\[WeChat front-stage note\]/);
  assert.match(result.text, /do not echo transport placeholder syntax/i);
  assert.match(result.text, /do not collapse the reply into only acknowledgment plus a quick follow-up question/i);
  assert.match(result.text, /stay for one more beat/i);
  assert.match(result.text, /resident-anchor: relation line/);
  assert.match(result.text, /宝宝😏？/);
});

test("image attachments inject view_image instructions for runtimes that support it", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-inbound-test-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-workspace-test-"));
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
    const prepared = await CyberbossApp.prototype.prepareIncomingMessageForRuntime.call({
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

    assert.match(prepared.text, /For images, use `view_image`/i);
    assert.match(prepared.text, /paired attachment note/i);
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
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-inbound-test-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-workspace-test-"));
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
    const prepared = await CyberbossApp.prototype.prepareIncomingMessageForRuntime.call({
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

    assert.match(prepared.text, /You must inspect the raw attachment files before replying to User/i);
    assert.match(prepared.text, /For images, use `Read` on the saved local image file/i);
    assert.match(prepared.text, /paired attachment note/i);
    assert.doesNotMatch(prepared.text, /Do not use shell commands or wrappers/i);
    assert.doesNotMatch(prepared.text, /view_image/i);
    assert.equal(prepared.attachments[0].contentType, "image/jpeg");
    assert.equal(prepared.attachments[0].isImage, true);
    assert.equal(fs.existsSync(prepared.attachments[0].noteAbsolutePath), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("location arrive_home trigger enqueues a system action message", () => {
  const queued = [];
  CyberbossApp.prototype.handleLocationAccepted.call({
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
  CyberbossApp.prototype.handleLocationAccepted.call({
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
  assert.match(prepared.text, /This is only an opportunity to reconnect, not a mandatory interruption/i);
  assert.match(prepared.text, /allowed to gently interrupt/i);
  assert.match(prepared.text, /Do not wait only for meal times/i);
  assert.match(prepared.text, /Choose silence only when you have a concrete reason/i);
});
