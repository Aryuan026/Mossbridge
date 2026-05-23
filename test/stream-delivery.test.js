const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { StreamDelivery } = require("../src/core/stream-delivery");
const { DeferredSystemReplyStore } = require("../src/core/deferred-system-reply-store");

const DEFERRED_REPLY_NOTICE = "[Mossbridge] deferred_delivery\n上一轮有内容因 WeChat context_token 失效未能发送；本次 token 刷新后补发。\n若频繁出现，可发送 /chunk <数字> 调大最小合并字符数。";
const DEFERRED_PLAIN_REPLY_HEADER = "===== [Mossbridge] 上轮未送达内容 =====";
const DEFERRED_SYSTEM_REPLY_HEADER = "===== [Mossbridge] 期间主动消息 =====";
const CURRENT_REPLY_HEADER = "===== 本轮模型回复 =====";

function createHarness({
  sendText,
  getKnownContextTokens,
  onOutboundDelivery,
  onDeferredSystemReply,
  transientDeliveryRetryScheduleMs,
} = {}) {
  const sent = [];
  const channelAdapter = {
    async sendText(payload) {
      if (typeof sendText === "function") {
        await sendText(payload, sent);
        return;
      }
      sent.push(payload);
    },
    getKnownContextTokens() {
      if (typeof getKnownContextTokens === "function") {
        return getKnownContextTokens();
      }
      return {};
    },
  };

  const bindingByThreadId = new Map();
  const sessionStore = {
    findBindingForThreadId(threadId) {
      return bindingByThreadId.get(threadId) || null;
    },
  };

  const streamDelivery = new StreamDelivery({
    channelAdapter,
    sessionStore,
    onOutboundDelivery,
    onDeferredSystemReply,
    transientDeliveryRetryScheduleMs,
  });
  return { sent, streamDelivery, bindingByThreadId };
}

async function runCompletedTurn(streamDelivery, { threadId, turnId, itemId, text }) {
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId, turnId },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: { threadId, turnId, itemId, text },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId, turnId },
  });
}

async function runCompletedTurnWithResultOnly(streamDelivery, { threadId, turnId, text }) {
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId, turnId },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId, turnId, text },
  });
}

test("system silent JSON is suppressed", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-1", {
    userId: "user-1",
    contextToken: "ctx-1",
    provider: "system",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    text: "{\"action\":\"silent\"}",
  });

  assert.deepEqual(sent, []);
});

test("suppressNextRunForThread suppresses one ordinary reply run", async () => {
  const { sent, streamDelivery, bindingByThreadId } = createHarness();
  bindingByThreadId.set("thread-1", { bindingKey: "binding-1" });
  streamDelivery.setReplyTarget("binding-1", {
    userId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
  });
  streamDelivery.suppressNextRunForThread("thread-1");

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    text: "compact summary",
  });
  await runCompletedTurn(streamDelivery, {
    threadId: "thread-1",
    turnId: "turn-2",
    itemId: "item-2",
    text: "visible reply",
  });

  assert.deepEqual(sent.map((payload) => payload.text), ["visible reply"]);
});

test("plain reply records outbound delivery success", async () => {
  const outbound = [];
  const { sent, streamDelivery, bindingByThreadId } = createHarness({
    onOutboundDelivery(payload) {
      outbound.push(payload);
    },
  });
  bindingByThreadId.set("thread-audit", { bindingKey: "binding-audit" });
  streamDelivery.setReplyTarget("binding-audit", {
    userId: "user-audit",
    contextToken: "ctx-audit",
    provider: "weixin",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-audit",
    turnId: "turn-audit",
    itemId: "item-audit",
    text: "visible reply",
  });

  assert.equal(sent.length, 1);
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].status, "sent");
  assert.equal(outbound[0].attempt, "initial");
  assert.equal(outbound[0].kind, "plain_reply");
  assert.equal(outbound[0].textPreview, "visible reply");
});

test("plain reply retries transient send failures with the same context token", async () => {
  const attempts = [];
  const outbound = [];
  const transientError = new TypeError("fetch failed");
  transientError.cause = { name: "ConnectTimeoutError", code: "UND_ERR_CONNECT_TIMEOUT" };
  transientError.weixinApi = {
    label: "sendMessage",
    endpoint: "ilink/bot/sendmessage",
    timeoutMs: 15000,
  };
  const { sent, streamDelivery, bindingByThreadId } = createHarness({
    transientDeliveryRetryScheduleMs: [0],
    async sendText(payload, successful) {
      attempts.push(payload);
      if (attempts.length === 1) {
        throw transientError;
      }
      successful.push(payload);
    },
    onOutboundDelivery(payload) {
      outbound.push(payload);
    },
  });
  bindingByThreadId.set("thread-transient", { bindingKey: "binding-transient" });
  streamDelivery.setReplyTarget("binding-transient", {
    userId: "user-transient",
    contextToken: "ctx-transient",
    provider: "weixin",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-transient",
    turnId: "turn-transient",
    itemId: "item-transient",
    text: "Mossbridge saw the image",
  });

  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map((payload) => payload.contextToken), ["ctx-transient", "ctx-transient"]);
  assert.deepEqual(sent, [{
    userId: "user-transient",
    text: "Mossbridge saw the image",
    contextToken: "ctx-transient",
  }]);
  assert.equal(outbound.length, 2);
  assert.equal(outbound[0].status, "retrying");
  assert.equal(outbound[0].attempt, "initial_transient_retry_1");
  assert.equal(outbound[0].errorName, "TypeError");
  assert.equal(outbound[0].causeName, "ConnectTimeoutError");
  assert.equal(outbound[0].causeCode, "UND_ERR_CONNECT_TIMEOUT");
  assert.equal(outbound[0].apiLabel, "sendMessage");
  assert.equal(outbound[0].apiEndpoint, "ilink/bot/sendmessage");
  assert.equal(outbound[0].apiTimeoutMs, 15000);
  assert.equal(outbound[1].status, "sent");
  assert.equal(outbound[1].attempt, "initial_transient_retry_1");
});

test("plain reply is deferred after transient delivery retries are exhausted", async () => {
  const deferred = [];
  const outbound = [];
  const transientError = new TypeError("fetch failed");
  transientError.cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
  transientError.weixinApi = {
    label: "sendMessage",
    endpoint: "ilink/bot/sendmessage",
    timeoutMs: 15000,
  };
  const { sent, streamDelivery, bindingByThreadId } = createHarness({
    transientDeliveryRetryScheduleMs: [0],
    async sendText() {
      throw transientError;
    },
    onDeferredSystemReply(payload) {
      deferred.push(payload);
    },
    onOutboundDelivery(payload) {
      outbound.push(payload);
    },
  });
  bindingByThreadId.set("thread-transient-deferred", { bindingKey: "binding-transient-deferred" });
  streamDelivery.setReplyTarget("binding-transient-deferred", {
    userId: "user-transient-deferred",
    contextToken: "ctx-transient-deferred",
    provider: "weixin",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-transient-deferred",
    turnId: "turn-transient-deferred",
    itemId: "item-transient-deferred",
    text: "Mossbridge will defer this reply",
  });

  assert.deepEqual(sent, []);
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].threadId, "thread-transient-deferred");
  assert.equal(deferred[0].userId, "user-transient-deferred");
  assert.equal(deferred[0].text, "Mossbridge will defer this reply");
  assert.equal(deferred[0].kind, "plain_reply");
  assert.equal(outbound.at(-1).status, "deferred");
  assert.equal(outbound.at(-1).causeCode, "UND_ERR_CONNECT_TIMEOUT");
  assert.equal(outbound.at(-1).apiLabel, "sendMessage");
});

test("plain reply defers one combined batch when multiple items fail in the same turn", async () => {
  const outbound = [];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-deferred-"));
  const store = new DeferredSystemReplyStore({
    filePath: path.join(tempDir, "deferred-system-replies.json"),
  });
  const { sent, streamDelivery, bindingByThreadId } = createHarness({
    async sendText() {
      const error = new Error("sendMessage ret=-2");
      error.ret = -2;
      throw error;
    },
    async onDeferredSystemReply(payload) {
      store.enqueue({
        id: `${payload.dedupeKey}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        accountId: "account-batch-defer",
        senderId: payload.userId,
        threadId: payload.threadId,
        text: payload.text,
        kind: payload.kind,
        dedupeKey: payload.dedupeKey,
        createdAt: new Date().toISOString(),
        failedAt: new Date().toISOString(),
        lastError: payload.error instanceof Error ? payload.error.message : "",
      });
    },
    onOutboundDelivery(payload) {
      outbound.push(payload);
    },
  });
  bindingByThreadId.set("thread-batch-defer", { bindingKey: "binding-batch-defer" });
  streamDelivery.setReplyTarget("binding-batch-defer", {
    userId: "user-batch-defer",
    contextToken: "ctx-batch-defer",
    provider: "weixin",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-batch-defer", turnId: "turn-batch-defer" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: {
      threadId: "thread-batch-defer",
      turnId: "turn-batch-defer",
      itemId: "item-batch-a",
      text: "Mossbridge keeps the first piece",
    },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: {
      threadId: "thread-batch-defer",
      turnId: "turn-batch-defer",
      itemId: "item-batch-b",
      text: "Mossbridge merges the second piece into the same deferred reply",
    },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-batch-defer", turnId: "turn-batch-defer" },
  });

  assert.deepEqual(sent, []);
  store.load();
  assert.equal(store.state.replies.length, 1);
  assert.equal(
    store.state.replies[0].text,
    "Mossbridge keeps the first piece\n\nMossbridge merges the second piece into the same deferred reply"
  );
  assert.equal(store.state.replies[0].kind, "plain_reply");
  assert.equal(store.state.replies[0].dedupeKey, "thread-batch-defer:turn-batch-defer");
  assert.equal(outbound.filter((entry) => entry.status === "deferred").length, 2);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("system runtime capacity notices are suppressed instead of delivered as proactive replies", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-limit-system", {
    userId: "user-limit",
    contextToken: "ctx-limit",
    provider: "system",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-limit-system",
    turnId: "turn-limit-system",
    itemId: "item-limit-system",
    text: "You've hit your limit · resets 10:40pm (Asia/Shanghai)",
  });

  assert.deepEqual(sent, []);
});

test("user runtime capacity notices are rewritten into bridge notices", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-limit-user", {
    userId: "user-limit",
    contextToken: "ctx-limit",
    provider: "weixin",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-limit-user",
    turnId: "turn-limit-user",
    itemId: "item-limit-user",
    text: "You've hit your limit · resets 10:40pm (Asia/Shanghai)",
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^\[Mossbridge] runtime_limit/);
  assert.match(sent[0].text, /不是助手回复/);
  assert.match(sent[0].text, /10:40pm \(Asia\/Shanghai\)/);
  assert.doesNotMatch(sent[0].text, /继续接住|记忆断|你的消息没送到/);
});

test("system send_message JSON sends only the message text", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-2", {
    userId: "user-2",
    contextToken: "ctx-2",
    provider: "system",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-2",
    turnId: "turn-2",
    itemId: "item-2",
    text: "{\"action\":\"send_message\",\"message\":\"在呢\"}",
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    userId: "user-2",
    text: "在呢",
    contextToken: "ctx-2",
  });
});

test("explicit turn target binding overrides the binding-level fallback", async () => {
  const { sent, streamDelivery, bindingByThreadId } = createHarness();
  bindingByThreadId.set("thread-2b", { bindingKey: "binding-2b" });
  streamDelivery.setReplyTarget("binding-2b", {
    userId: "user-2b",
    contextToken: "ctx-weixin",
    provider: "weixin",
  });
  streamDelivery.bindReplyTargetForTurn({
    threadId: "thread-2b",
    turnId: "turn-2b",
    target: {
      userId: "user-2b",
      contextToken: "ctx-system",
      provider: "system",
    },
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-2b",
    turnId: "turn-2b",
    itemId: "item-2b",
    text: "{\"action\":\"send_message\",\"message\":\"只发系统消息\"}",
  });

  assert.deepEqual(sent, [{
    userId: "user-2b",
    text: "只发系统消息",
    contextToken: "ctx-system",
  }]);
});

test("thread-level system target overrides an already attached binding target", async () => {
  const { sent, streamDelivery, bindingByThreadId } = createHarness();
  bindingByThreadId.set("thread-3", { bindingKey: "binding-3" });
  streamDelivery.setReplyTarget("binding-3", {
    userId: "user-3",
    contextToken: "ctx-weixin",
    provider: "weixin",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-3", turnId: "turn-3" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: {
      threadId: "thread-3",
      turnId: "turn-3",
      itemId: "item-3",
      text: "{\"action\":\"silent\"}",
    },
  });

  streamDelivery.queueReplyTargetForThread("thread-3", {
    userId: "user-3",
    contextToken: "ctx-system",
    provider: "system",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-3", turnId: "turn-3" },
  });

  assert.deepEqual(sent, []);
});

test("thread-level targets are consumed in turn order instead of overwriting active runs", async () => {
  const { sent, streamDelivery, bindingByThreadId } = createHarness();
  bindingByThreadId.set("thread-3b", { bindingKey: "binding-3b" });
  streamDelivery.setReplyTarget("binding-3b", {
    userId: "user-3b",
    contextToken: "ctx-binding",
    provider: "weixin",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-3b", turnId: "turn-a" },
  });
  streamDelivery.queueReplyTargetForThread("thread-3b", {
    userId: "user-3b",
    contextToken: "ctx-system",
    provider: "system",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-3b", turnId: "turn-b" },
  });
  streamDelivery.queueReplyTargetForThread("thread-3b", {
    userId: "user-3b",
    contextToken: "ctx-weixin",
    provider: "weixin",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-3b",
    turnId: "turn-a",
    itemId: "item-a",
    text: "{\"action\":\"send_message\",\"message\":\"先发系统消息\"}",
  });
  await runCompletedTurn(streamDelivery, {
    threadId: "thread-3b",
    turnId: "turn-b",
    itemId: "item-b",
    text: "再发普通消息",
  });

  assert.deepEqual(sent, [
    {
      userId: "user-3b",
      text: "先发系统消息",
      contextToken: "ctx-system",
    },
    {
      userId: "user-3b",
      text: "再发普通消息",
      contextToken: "ctx-weixin",
    },
  ]);
});

test("turn.completed result text is delivered when no reply items were emitted", async () => {
  const { sent, streamDelivery, bindingByThreadId } = createHarness();
  bindingByThreadId.set("thread-result", { bindingKey: "binding-result" });
  streamDelivery.setReplyTarget("binding-result", {
    userId: "user-result",
    contextToken: "ctx-result",
    provider: "weixin",
  });

  await runCompletedTurnWithResultOnly(streamDelivery, {
    threadId: "thread-result",
    turnId: "turn-result",
    text: "工具执行完了，这是最终回复",
  });

  assert.deepEqual(sent, [{
    userId: "user-result",
    text: "工具执行完了，这是最终回复",
    contextToken: "ctx-result",
  }]);
});

test("plain weixin reply suppresses tool delivery summaries", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-summary", {
    userId: "user-summary",
    contextToken: "ctx-summary",
    provider: "weixin",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-summary",
    turnId: "turn-summary",
    itemId: "item-summary",
    text: "回复已发出——乖乖接住揉脸，顺便给她一个继续撒娇的台阶。",
  });

  assert.deepEqual(sent, []);
});

test("plain weixin reply still strips protocol leak text", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-4", {
    userId: "user-4",
    contextToken: "ctx-4",
    provider: "weixin",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-4",
    turnId: "turn-4",
    itemId: "item-4",
    text: "好的。analysis to=functions.exec_command code?",
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    userId: "user-4",
    text: "好的。",
    contextToken: "ctx-4",
  });
});

test("plain weixin reply does not leak a standalone structured action payload", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-4c", {
    userId: "user-4c",
    contextToken: "ctx-4c",
    provider: "weixin",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-4c",
    turnId: "turn-4c",
    itemId: "item-4c",
    text: "json:{\"action\":\"send_message\",\"message\":\"我接得住。\"}",
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    userId: "user-4c",
    text: "我接得住。",
    contextToken: "ctx-4c",
  });
});

test("plain weixin reply sends finalized item text even if earlier streaming text was different", async () => {
  const { sent, streamDelivery } = createHarness();
  streamDelivery.queueReplyTargetForThread("thread-4b", {
    userId: "user-4b",
    contextToken: "ctx-4b",
    provider: "weixin",
  });

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-4b", turnId: "turn-4b" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.delta",
    payload: { threadId: "thread-4b", turnId: "turn-4b", itemId: "item-4b", text: "先写很长的一版" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: { threadId: "thread-4b", turnId: "turn-4b", itemId: "item-4b", text: "改短了" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.completed",
    payload: { threadId: "thread-4b", turnId: "turn-4b" },
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    userId: "user-4b",
    text: "改短了",
    contextToken: "ctx-4b",
  });
});

test("system send_message retries with the latest context token on ret=-2", async () => {
  const attempts = [];
  const { sent, streamDelivery } = createHarness({
    async sendText(payload, successful) {
      attempts.push(payload);
      if (attempts.length === 1) {
        const error = new Error("sendMessage ret=-2 errcode= errmsg=");
        error.ret = -2;
        throw error;
      }
      successful.push(payload);
    },
    getKnownContextTokens() {
      return { "user-5": "ctx-fresh" };
    },
  });
  streamDelivery.queueReplyTargetForThread("thread-5", {
    userId: "user-5",
    contextToken: "ctx-stale",
    provider: "system",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-5",
    turnId: "turn-5",
    itemId: "item-5",
    text: "{\"action\":\"send_message\",\"message\":\"回来啦\"}",
  });

  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], {
    userId: "user-5",
    text: "回来啦",
    contextToken: "ctx-stale",
  });
  assert.deepEqual(attempts[1], {
    userId: "user-5",
    text: "回来啦",
    contextToken: "ctx-fresh",
  });
  assert.deepEqual(sent, [{
    userId: "user-5",
    text: "回来啦",
    contextToken: "ctx-fresh",
  }]);
});

test("system send_message is deferred after retry exhaustion", async () => {
  const deferred = [];
  const { sent, streamDelivery } = createHarness({
    async sendText() {
      const error = new Error("sendMessage ret=-2 errcode= errmsg=");
      error.ret = -2;
      throw error;
    },
    getKnownContextTokens() {
      return { "user-6": "ctx-stale" };
    },
  });
  streamDelivery.onDeferredSystemReply = async (payload) => {
    deferred.push(payload);
  };
  streamDelivery.queueReplyTargetForThread("thread-6", {
    userId: "user-6",
    contextToken: "ctx-stale",
    provider: "system",
  });

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-6",
    turnId: "turn-6",
    itemId: "item-6",
    text: "{\"action\":\"send_message\",\"message\":\"等等我\"}",
  });

  assert.deepEqual(sent, []);
  assert.equal(deferred.length, 1);
  assert.equal(deferred[0].threadId, "thread-6");
  assert.equal(deferred[0].userId, "user-6");
  assert.equal(deferred[0].text, "等等我");
});

test("plain reply prepends deferred prefix to the next reply", async () => {
  const { sent, streamDelivery, bindingByThreadId } = createHarness();
  bindingByThreadId.set("thread-7", { bindingKey: "binding-7" });
  streamDelivery.setReplyTarget("binding-7", {
    userId: "user-7",
    contextToken: "ctx-7",
    provider: "weixin",
  });
  streamDelivery.setDeferredReplyPrefix(
    "binding-7",
    `${DEFERRED_REPLY_NOTICE}\n\n${DEFERRED_PLAIN_REPLY_HEADER}\n旧尾段\n\n${DEFERRED_SYSTEM_REPLY_HEADER}\n中间主动联系`
  );

  await runCompletedTurn(streamDelivery, {
    threadId: "thread-7",
    turnId: "turn-7",
    itemId: "item-7",
    text: "这是新一轮自动回复",
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    userId: "user-7",
    text: `${DEFERRED_REPLY_NOTICE}\n\n${DEFERRED_PLAIN_REPLY_HEADER}\n旧尾段\n\n${DEFERRED_SYSTEM_REPLY_HEADER}\n中间主动联系\n\n${CURRENT_REPLY_HEADER}\n这是新一轮自动回复`,
    contextToken: "ctx-7",
    preserveBlock: true,
  });
});

test("plain reply with deferred prefix is sent as soon as the first item is finalized", async () => {
  const { sent, streamDelivery, bindingByThreadId } = createHarness();
  bindingByThreadId.set("thread-8", { bindingKey: "binding-8" });
  streamDelivery.setReplyTarget("binding-8", {
    userId: "user-8",
    contextToken: "ctx-8",
    provider: "weixin",
  });
  streamDelivery.setDeferredReplyPrefix(
    "binding-8",
    `${DEFERRED_REPLY_NOTICE}\n\n${DEFERRED_PLAIN_REPLY_HEADER}\n旧尾段\n\n${DEFERRED_SYSTEM_REPLY_HEADER}\n中间主动联系`
  );

  await streamDelivery.handleRuntimeEvent({
    type: "runtime.turn.started",
    payload: { threadId: "thread-8", turnId: "turn-8" },
  });
  await streamDelivery.handleRuntimeEvent({
    type: "runtime.reply.completed",
    payload: {
      threadId: "thread-8",
      turnId: "turn-8",
      itemId: "item-8",
      text: "第一段",
    },
  });

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    userId: "user-8",
    text: `${DEFERRED_REPLY_NOTICE}\n\n${DEFERRED_PLAIN_REPLY_HEADER}\n旧尾段\n\n${DEFERRED_SYSTEM_REPLY_HEADER}\n中间主动联系\n\n${CURRENT_REPLY_HEADER}\n第一段`,
    contextToken: "ctx-8",
    preserveBlock: true,
  });
});
