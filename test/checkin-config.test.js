const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  CheckinConfigStore,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_MAX_INTERVAL_MS,
  parseCheckinRangeMinutes,
} = require("../src/core/checkin-config-store");
const {
  persistContextToken,
  resolveContextTokenMetadataPath,
} = require("../src/adapters/channel/weixin/context-token-store");
const { DeferredSystemReplyStore } = require("../src/core/deferred-system-reply-store");
const { RuntimeCooldownStore } = require("../src/core/runtime-cooldown-store");
const { SystemMessageQueueStore } = require("../src/core/system-message-queue-store");
const {
  applyCheckinTokenPressureBackoff,
  findLatestSystemCheckinContext,
  resolveCheckinDailyBudget,
  resolveCheckinConversationHeat,
  resolveCheckinContextTokenMaxAgeMs,
  resolveCheckinQuietState,
  resolveCheckinModelWakePreflight,
  resolveCheckinReadiness,
  resolveMorningContextTokenGrace,
  resolveCheckinTokenPressureBackoff,
  resolveDailyBudgetPauseMs,
  resolveSystemTurnBudgetPolicy,
  summarizeSystemCheckinUsageForLocalDay,
} = require("../src/app/system-checkin-poller");
const {
  recordAiReply,
  recordUserMessage,
  resetActivityForTests,
} = require("../src/core/activity-tracker");
const { MossbridgeApp } = require("../src/core/app");

function createStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-checkin-test-"));
  return new CheckinConfigStore({ filePath: path.join(dir, "checkin-config.json") });
}

function createCheckinReadinessHarness(configOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asherie-checkin-readiness-test-"));
  const config = {
    accountsDir: path.join(dir, "accounts"),
    systemMessageQueueFile: path.join(dir, "system-message-queue.json"),
    deferredSystemReplyQueueFile: path.join(dir, "deferred-system-replies.json"),
    runtimeCooldownFile: path.join(dir, "runtime-cooldowns.json"),
    ...configOverrides,
  };
  return {
    config,
    queue: new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile }),
    deferredQueue: new DeferredSystemReplyStore({ filePath: config.deferredSystemReplyQueueFile }),
    runtimeCooldownStore: new RuntimeCooldownStore({ filePath: config.runtimeCooldownFile }),
  };
}

test("parseCheckinRangeMinutes accepts min-max minute ranges", () => {
  assert.deepEqual(parseCheckinRangeMinutes("7-21"), { minMinutes: 7, maxMinutes: 21 });
  assert.deepEqual(parseCheckinRangeMinutes("5 - 10"), { minMinutes: 5, maxMinutes: 10 });
  assert.equal(parseCheckinRangeMinutes("10-3"), null);
  assert.equal(parseCheckinRangeMinutes("abc"), null);
});

test("checkin config store falls back to defaults and persists overrides", () => {
  const store = createStore();
  assert.deepEqual(store.getRange(), {
    minIntervalMs: 5 * 60_000,
    maxIntervalMs: 25 * 60_000,
  });
  assert.equal(DEFAULT_MIN_INTERVAL_MS, 5 * 60_000);
  assert.equal(DEFAULT_MAX_INTERVAL_MS, 25 * 60_000);
  store.setRange({ minIntervalMs: 4 * 60_000, maxIntervalMs: 25 * 60_000 });
  assert.deepEqual(store.getRange(), {
    minIntervalMs: 4 * 60_000,
    maxIntervalMs: 25 * 60_000,
  });
});

test("checkin readiness skips when proactive replies are already deferred", () => {
  const { config, queue, deferredQueue } = createCheckinReadinessHarness();
  persistContextToken(config, "account-1", "user-1", "ctx-1");
  deferredQueue.enqueue({
    id: "reply-1",
    accountId: "account-1",
    senderId: "user-1",
    text: "等你下一次开门我再说",
    kind: "system_reply",
    createdAt: "2026-05-05T00:00:00.000Z",
    failedAt: "2026-05-05T00:00:00.000Z",
  });

  const readiness = resolveCheckinReadiness({
    config,
    accountId: "account-1",
    senderId: "user-1",
    queue,
    deferredQueue,
  });

  assert.deepEqual(readiness, {
    ready: false,
    reason: "deferred_replies_pending",
    deferredCount: 1,
  });
});

test("checkin readiness skips stale or missing WeChat context tokens", () => {
  const nowMs = Date.now();
  const { config, queue, deferredQueue } = createCheckinReadinessHarness({
    checkinContextTokenMaxAgeMinutes: 10,
    checkinMorningContextTokenGraceHours: "off",
  });

  assert.equal(resolveCheckinContextTokenMaxAgeMs(config), 10 * 60_000);
  assert.deepEqual(resolveCheckinReadiness({
    config,
    accountId: "account-1",
    senderId: "user-1",
    queue,
    deferredQueue,
    nowMs,
  }), {
    ready: false,
    reason: "missing_context_token",
  });

  persistContextToken(config, "account-1", "user-1", "ctx-1");
  assert.deepEqual(resolveCheckinReadiness({
    config,
    accountId: "account-1",
    senderId: "user-1",
    queue,
    deferredQueue,
    nowMs: nowMs + 9 * 60_000,
  }), {
    ready: true,
  });

  const stale = resolveCheckinReadiness({
    config,
    accountId: "account-1",
    senderId: "user-1",
    queue,
    deferredQueue,
    nowMs: nowMs + 11 * 60_000,
  });
  assert.equal(stale.ready, false);
  assert.equal(stale.reason, "stale_context_token");
});

test("checkin readiness pauses random proactive wakeups during quiet sleep hours", () => {
  const { config, queue, deferredQueue } = createCheckinReadinessHarness();
  const deepNight = Date.parse("2026-05-17T18:30:00.000Z"); // 02:30 in Asia/Shanghai.

  const quiet = resolveCheckinQuietState(config, deepNight);
  assert.equal(quiet.active, true);
  assert.equal(quiet.start, "02:00");
  assert.equal(quiet.end, "07:00");

  const readiness = resolveCheckinReadiness({
    config,
    accountId: "account-1",
    senderId: "user-1",
    queue,
    deferredQueue,
    nowMs: deepNight,
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, "quiet_hours");

  assert.equal(
    resolveCheckinQuietState(config, Date.parse("2026-05-17T23:30:00.000Z")).active,
    false
  );
  assert.equal(
    resolveCheckinQuietState({ checkinQuietHours: "02:00-04:00" }, Date.parse("2026-05-17T20:30:00.000Z")).active,
    false
  );
});

test("checkin readiness allows a morning context-token grace after quiet hours", () => {
  const updatedAt = "2026-05-17T16:00:00.000Z"; // 00:00 in Asia/Shanghai.
  const morning = Date.parse("2026-05-18T00:00:00.000Z"); // 08:00 in Asia/Shanghai.
  const lateMorning = Date.parse("2026-05-18T03:00:00.000Z"); // 11:00 in Asia/Shanghai.
  const { config, queue, deferredQueue } = createCheckinReadinessHarness({
    checkinContextTokenMaxAgeMinutes: 6 * 60,
  });
  persistContextToken(config, "account-1", "user-1", "ctx-1");
  fs.writeFileSync(resolveContextTokenMetadataPath(config, "account-1"), JSON.stringify({
    "user-1": { updatedAt },
  }, null, 2), "utf8");

  const grace = resolveMorningContextTokenGrace({
    config,
    nowMs: morning,
    tokenAgeMs: morning - Date.parse(updatedAt),
    normalMaxAgeMs: 6 * 60 * 60_000,
  });
  assert.equal(grace.active, true);

  const readiness = resolveCheckinReadiness({
    config,
    accountId: "account-1",
    senderId: "user-1",
    queue,
    deferredQueue,
    nowMs: morning,
  });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.contextTokenGrace.reason, "morning_context_token_grace");

  const lateReadiness = resolveCheckinReadiness({
    config,
    accountId: "account-1",
    senderId: "user-1",
    queue,
    deferredQueue,
    nowMs: lateMorning,
  });
  assert.equal(lateReadiness.ready, false);
  assert.equal(lateReadiness.reason, "stale_context_token");
});

test("checkin readiness skips proactive wakeups while the runtime is cooling down", () => {
  const nowMs = Date.parse("2026-05-08T05:45:00.000Z");
  const {
    config,
    queue,
    deferredQueue,
    runtimeCooldownStore,
  } = createCheckinReadinessHarness({
    runtime: "claudecode",
    checkinContextTokenMaxAgeMinutes: 10,
  });
  persistContextToken(config, "account-1", "user-1", "ctx-1");
  runtimeCooldownStore.setCapacityCooldown({
    runtimeId: "claudecode",
    text: "You've hit your limit · resets 2:50pm (Asia/Shanghai)",
    source: "system",
    nowMs,
  });

  const readiness = resolveCheckinReadiness({
    config,
    accountId: "account-1",
    senderId: "user-1",
    queue,
    deferredQueue,
    runtimeCooldownStore,
    nowMs: nowMs + 60_000,
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, "runtime_cooldown");
  assert.ok(readiness.runtimeCooldown.remainingMs > 0);
});

test("checkin token pressure stretches the proactive interval", () => {
  let loadCalled = false;
  const tokenBackoff = resolveCheckinTokenPressureBackoff({
    config: {
      runtime: "claudecode",
      checkinTokenBackoffPercent: 40,
      checkinTokenBackoffMultiplier: 3,
    },
    runtimeContextUsageStore: {
      load() {
        loadCalled = true;
      },
      getContext({ runtimeId }) {
        assert.equal(runtimeId, "claudecode");
        return {
          currentTokens: 93_000,
          contextWindow: 200_000,
        };
      },
    },
  });

  assert.equal(loadCalled, true);
  assert.equal(tokenBackoff.active, true);
  assert.equal(tokenBackoff.reason, "token_pressure");
  assert.equal(tokenBackoff.multiplier, 3);
  assert.equal(Math.round(tokenBackoff.ratio * 100), 47);

  const stretched = applyCheckinTokenPressureBackoff({
    minIntervalMs: 5 * 60_000,
    maxIntervalMs: 25 * 60_000,
  }, tokenBackoff, {});
  assert.deepEqual(stretched, {
    minIntervalMs: 15 * 60_000,
    maxIntervalMs: 75 * 60_000,
  });
});

test("checkin daily budget stops background wakeups without blocking user turns", () => {
  const nowMs = Date.parse("2026-05-09T13:00:00.000Z"); // 21:00 Asia/Shanghai.
  const snapshot = {
    contextsByThreadId: {
      "system-1": {
        runtimeId: "claudecode",
        bindingKey: "default:user#mossbridge-system",
        currentTokens: 180_000,
        updatedAt: "2026-05-09T02:00:00.000Z",
      },
      "system-2": {
        runtimeId: "claudecode",
        bindingKey: "default:user#mossbridge-system",
        currentTokens: 140_000,
        updatedAt: "2026-05-09T08:00:00.000Z",
      },
      "user-1": {
        runtimeId: "claudecode",
        bindingKey: "default:user",
        currentTokens: 80_000,
        updatedAt: "2026-05-09T09:00:00.000Z",
      },
      "yesterday-system": {
        runtimeId: "claudecode",
        bindingKey: "default:user#mossbridge-system",
        currentTokens: 500_000,
        updatedAt: "2026-05-08T08:00:00.000Z",
      },
    },
  };

  assert.deepEqual(summarizeSystemCheckinUsageForLocalDay({
    snapshot,
    runtimeId: "claudecode",
    nowMs,
  }), {
    day: "2026-05-09",
    runtimeId: "claudecode",
    currentTokens: 320_000,
    budgetTokens: 320_000,
    threadCount: 2,
  });

  const budget = resolveCheckinDailyBudget({
    config: {
      runtime: "claudecode",
      checkinDailyTokenBudget: 300_000,
      checkinDailyThreadBudget: 10,
    },
    runtimeContextUsageStore: {
      load() {},
      snapshot() {
        return snapshot;
      },
    },
    nowMs,
  });

  assert.equal(budget.exceeded, true);
  assert.equal(budget.tokenExceeded, true);
  assert.equal(budget.threadExceeded, false);
});

test("checkin daily budget discounts cache-read tokens instead of treating them as fresh work", () => {
  const nowMs = Date.parse("2026-05-15T18:40:00.000Z"); // 02:40 Asia/Shanghai on 2026-05-16.
  const summary = summarizeSystemCheckinUsageForLocalDay({
    runtimeId: "claudecode",
    cacheReadWeight: 0.1,
    nowMs,
    snapshot: {
      contextsByThreadId: {
        "system-1": {
          runtimeId: "claudecode",
          bindingKey: "default:user#mossbridge-system",
          currentTokens: 37_000,
          inputTokens: 1,
          cacheCreationInputTokens: 1_200,
          cacheReadInputTokens: 35_700,
          outputTokens: 1,
          updatedAt: "2026-05-15T16:48:44.780Z",
        },
        "system-2": {
          runtimeId: "claudecode",
          bindingKey: "default:user#mossbridge-system",
          currentTokens: 38_000,
          inputTokens: 1,
          cacheCreationInputTokens: 1_500,
          cacheReadInputTokens: 36_400,
          outputTokens: 1,
          updatedAt: "2026-05-15T17:03:56.599Z",
        },
      },
    },
  });

  assert.equal(summary.currentTokens, 75_000);
  assert.equal(summary.budgetTokens, 9_914);
  assert.equal(summary.threadCount, 2);
});

test("checkin model preflight keeps random patrols zero-token until the next model slot", () => {
  const nowMs = Date.parse("2026-05-17T03:00:00.000Z");
  const snapshot = {
    contextsByThreadId: {
      "system-recent": {
        runtimeId: "claudecode",
        threadId: "thread-1",
        bindingKey: "default:user#mossbridge-system",
        currentTokens: 30_000,
        updatedAt: "2026-05-17T02:00:00.000Z",
      },
      "user-recent": {
        runtimeId: "claudecode",
        threadId: "thread-user",
        bindingKey: "default:user",
        currentTokens: 80_000,
        updatedAt: "2026-05-17T02:55:00.000Z",
      },
    },
  };

  assert.deepEqual(findLatestSystemCheckinContext({
    snapshot,
    runtimeId: "claudecode",
  }), {
    updatedAt: "2026-05-17T02:00:00.000Z",
    updatedAtMs: Date.parse("2026-05-17T02:00:00.000Z"),
    threadId: "thread-1",
  });

  const preflight = resolveCheckinModelWakePreflight({
    config: {
      runtime: "claudecode",
      checkinModelMinGapMinutes: 90,
    },
    runtimeContextUsageStore: {
      load() {},
      snapshot() {
        return snapshot;
      },
    },
    nowMs,
  });

  assert.equal(preflight.ready, false);
  assert.equal(preflight.reason, "model_wake_min_gap");
  assert.equal(preflight.remainingMs, 30 * 60_000);
});

test("checkin model preflight allows the first lightweight model wake and overdue slots", () => {
  const nowMs = Date.parse("2026-05-17T04:00:00.000Z");
  const empty = resolveCheckinModelWakePreflight({
    config: {
      runtime: "claudecode",
      checkinModelMinGapMinutes: 90,
    },
    runtimeContextUsageStore: {
      load() {},
      snapshot() {
        return { contextsByThreadId: {} };
      },
    },
    nowMs,
  });
  assert.equal(empty.ready, true);
  assert.equal(empty.reason, "first_model_wake_for_runtime");

  const due = resolveCheckinModelWakePreflight({
    config: {
      runtime: "claudecode",
      checkinModelMinGapMinutes: 90,
    },
    runtimeContextUsageStore: {
      load() {},
      snapshot() {
        return {
          contextsByThreadId: {
            "system-old": {
              runtimeId: "claudecode",
              bindingKey: "default:user#mossbridge-system",
              updatedAt: "2026-05-17T02:00:00.000Z",
            },
          },
        };
      },
    },
    nowMs,
  });

  assert.equal(due.ready, true);
  assert.equal(due.reason, "model_wake_due");
  assert.equal(due.elapsedMs, 2 * 60 * 60_000);
});

test("checkin readiness skips when the daily background budget is exhausted", () => {
  const nowMs = Date.parse("2026-05-09T13:00:00.000Z");
  const { config, queue, deferredQueue } = createCheckinReadinessHarness({
    runtime: "claudecode",
    checkinContextTokenMaxAgeMinutes: 0,
    checkinDailyTokenBudget: 300_000,
  });

  const readiness = resolveCheckinReadiness({
    config,
    accountId: "account-1",
    senderId: "user-1",
    queue,
    deferredQueue,
    runtimeContextUsageStore: {
      load() {},
      snapshot() {
        return {
          contextsByThreadId: {
            "system-1": {
              runtimeId: "claudecode",
              bindingKey: "default:user#mossbridge-system",
              currentTokens: 310_000,
              updatedAt: "2026-05-09T08:00:00.000Z",
            },
          },
        };
      },
    },
    nowMs,
  });

  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, "daily_checkin_budget");
});

test("system daily budget tiers random wakeups, dreaming, and due reminders", () => {
  const nowMs = Date.parse("2026-05-09T13:00:00.000Z");
  const runtimeContextUsageStore = {
    load() {},
    snapshot() {
      return {
        contextsByThreadId: {
          "system-1": {
            runtimeId: "claudecode",
            bindingKey: "default:user#mossbridge-system",
            currentTokens: 310_000,
            updatedAt: "2026-05-09T08:00:00.000Z",
          },
        },
      };
    },
  };
  const config = {
    runtime: "claudecode",
    checkinDailyTokenBudget: 300_000,
    systemBudgetDreamingDeferMinutes: 20,
    systemBudgetCompactRuntimeTextMaxChars: 4_000,
  };

  const randomWakeup = resolveSystemTurnBudgetPolicy({
    kind: "checkin_opportunity",
    config,
    runtimeContextUsageStore,
    nowMs,
  });
  assert.equal(randomWakeup.action, "drop");
  assert.equal(randomWakeup.reason, "daily_checkin_budget");

  const dreaming = resolveSystemTurnBudgetPolicy({
    kind: "dreaming_opportunity",
    config,
    runtimeContextUsageStore,
    nowMs,
  });
  assert.equal(dreaming.action, "defer");
  assert.equal(dreaming.deferMs, 20 * 60_000);

  const reminder = resolveSystemTurnBudgetPolicy({
    kind: "reminder_due",
    config,
    runtimeContextUsageStore,
    nowMs,
  });
  assert.equal(reminder.action, "allow_compact");
  assert.equal(reminder.compactRuntimeTextMaxChars, 4_000);
});

test("daily budget pause waits until the next Shanghai day instead of retrying every few minutes", () => {
  const pauseMs = resolveDailyBudgetPauseMs(Date.parse("2026-05-15T18:40:00.000Z")); // 02:40 Asia/Shanghai.
  assert.ok(pauseMs >= 21 * 60 * 60_000);
  assert.ok(pauseMs <= 22 * 60 * 60_000);
});

test("checkin conversation heat uses configurable hot-chat thresholds", () => {
  const originalNow = Date.now;
  try {
    let nowMs = Date.parse("2026-05-09T10:00:00.000Z");
    Date.now = () => nowMs;
    resetActivityForTests();
    recordUserMessage();
    nowMs += 30_000;
    recordAiReply();
    nowMs += 30_000;
    recordUserMessage();
    nowMs += 30_000;
    recordAiReply();

    const heat = resolveCheckinConversationHeat({
      checkinHotWindowMinutes: 10,
      checkinHotRecentMinutes: 8,
      checkinHotMinEvents: 4,
    }, nowMs);
    assert.equal(heat.hot, true);
    assert.equal(heat.eventCount, 4);
  } finally {
    Date.now = originalNow;
    resetActivityForTests();
  }
});

test("sendFailureToThread records capacity cooldown even when system replies are silent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-runtime-failure-cooldown-"));
  const runtimeCooldownStore = new RuntimeCooldownStore({
    filePath: path.join(dir, "runtime-cooldowns.json"),
  });
  const sent = [];
  const appLike = {
    config: { runtime: "claudecode" },
    runtimeCooldownStore,
    lastSystemFailureNoticeAtByKey: new Map(),
    runtimeAdapter: {
      getSessionStore() {
        return {
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot: "/workspace" };
          },
        };
      },
    },
    resolveReplyTargetForBinding() {
      return { userId: "user-1", contextToken: "ctx-1", provider: "system" };
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
    recordRuntimeNotice: MossbridgeApp.prototype.recordRuntimeNotice,
  };

  await MossbridgeApp.prototype.sendFailureToThread.call(
    appLike,
    "thread-1",
    "API Error: HTTP 429 rate limit exceeded",
  );

  assert.equal(sent.length, 0);
  const cooldown = runtimeCooldownStore.getActiveCooldown("claudecode");
  assert.equal(cooldown.reason, "runtime_capacity");
  assert.equal(cooldown.threadId, "thread-1");
});

test("user turns return a bridge notice instead of calling runtime during cooldown", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-inbound-cooldown-"));
  const runtimeCooldownStore = new RuntimeCooldownStore({
    filePath: path.join(dir, "runtime-cooldowns.json"),
  });
  runtimeCooldownStore.setCapacityCooldown({
    runtimeId: "claudecode",
    text: "You've hit your limit · resets May 14, 2099 at 12pm (Asia/Shanghai)",
    nowMs: Date.parse("2026-05-10T01:01:01.000Z"),
  });

  const sent = [];
  const appLike = {
    config: { runtime: "claudecode" },
    runtimeCooldownStore,
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
    isTurnDispatchBlocked() {
      throw new Error("runtime dispatch should not be reached");
    },
  };

  const result = await MossbridgeApp.prototype.routePreparedInbound.call(appLike, {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
    prepared: {
      senderId: "user-1",
      contextToken: "ctx-1",
    },
  });

  assert.equal(result, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].userId, "user-1");
  assert.match(sent[0].text, /^\[Mossbridge] runtime_limit/);
  assert.match(sent[0].text, /runtime: ClaudeCode/);
  assert.match(sent[0].text, /status: rate_or_quota_limited/);
  assert.match(sent[0].text, /result: no_runtime_reply/);
  assert.match(sent[0].text, /May 14, 2099 at 12pm/);
  assert.doesNotMatch(sent[0].text, /继续接住|记忆断|你的消息没送到/);
});

test("checkin context-token freshness gate can be disabled", () => {
  assert.equal(resolveCheckinContextTokenMaxAgeMs({ checkinContextTokenMaxAgeMinutes: 0 }), 0);
});

test("handleCheckinCommand stores the new range and replies in English", async () => {
  const sent = [];
  const store = createStore();
  const appLike = {
    checkinConfigStore: store,
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
  };

  await MossbridgeApp.prototype.handleCheckinCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "7-21",
  });

  assert.deepEqual(store.getRange(), {
    minIntervalMs: 7 * 60_000,
    maxIntervalMs: 21 * 60_000,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "✅ Check-in interval reset to 7-21 minutes and will apply on the next polling cycle.");
});

test("handleChunkCommand reports current value and persists updates through the channel adapter", async () => {
  const sent = [];
  let minChunk = 20;
  const appLike = {
    channelAdapter: {
      getMinChunkChars() {
        return minChunk;
      },
      setMinChunkChars(value) {
        minChunk = value;
        return minChunk;
      },
      async sendText(payload) {
        sent.push(payload);
      },
    },
  };

  await MossbridgeApp.prototype.handleChunkCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "",
  });
  await MossbridgeApp.prototype.handleChunkCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "50",
  });

  assert.equal(sent[0].text, "💡 Current minimum merge chunk is 20 characters. Usage: /chunk <number> (e.g. /chunk 50)");
  assert.equal(sent[1].text, "✅ Minimum merge chunk set to 50 characters. Shorter fragments will be merged into one message up to this size.");
  assert.equal(minChunk, 50);
});
