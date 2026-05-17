const crypto = require("crypto");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { getPersistedContextTokenAgeMs } = require("../adapters/channel/weixin/context-token-store");
const { CheckinConfigStore, resolveDefaultCheckinRange } = require("../core/checkin-config-store");
const { DeferredSystemReplyStore } = require("../core/deferred-system-reply-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { RuntimeCooldownStore } = require("../core/runtime-cooldown-store");
const { RuntimeContextUsageStore } = require("../core/runtime-context-usage-store");
const { SystemMessageQueueStore } = require("../core/system-message-queue-store");
const {
  CONTROL_LAYER,
  CONTROL_SCOPE,
  CONTROL_SEVERITY,
  createControlPlane,
} = require("../control/control-plane");
const {
  ACTIVE_WINDOW_MS,
  HOT_ACTIVITY_MIN_EVENTS,
  HOT_ACTIVITY_RECENT_MS,
  HOT_ACTIVITY_WINDOW_MS,
  getConversationHeat,
  hasRecentActivity,
} = require("../core/activity-tracker");

const DEFAULT_CHECKIN_CONTEXT_TOKEN_MAX_AGE_MS = 6 * 60 * 60_000;
const DEFAULT_CHECKIN_TOKEN_BACKOFF_PERCENT = 40;
const DEFAULT_CHECKIN_TOKEN_SEVERE_BACKOFF_PERCENT = 60;
const DEFAULT_CHECKIN_TOKEN_BACKOFF_MULTIPLIER = 3;
const DEFAULT_CHECKIN_TOKEN_SEVERE_BACKOFF_MULTIPLIER = 6;
const DEFAULT_CHECKIN_MAX_BACKOFF_MS = 2 * 60 * 60_000;
const DEFAULT_CHECKIN_DAILY_TOKEN_BUDGET = 300_000;
const DEFAULT_CHECKIN_DAILY_THREAD_BUDGET = 36;
const DEFAULT_CHECKIN_DAILY_CACHE_READ_WEIGHT = 0.1;
const DEFAULT_CHECKIN_MODEL_MIN_GAP_MINUTES = 90;
const DEFAULT_SYSTEM_BUDGET_DREAMING_DEFER_MINUTES = 20;
const DEFAULT_SYSTEM_BUDGET_COMPACT_RUNTIME_TEXT_CHARS = 6_000;

const INTERNAL_CHECKIN_TRIGGER_TEMPLATES = [
  "%USER% comes to mind again; from the tiny injected wake note only, decide whether a small hello belongs here.",
  "A small ordinary check-in window opens for %USER%; no tools are available in this random heartbeat, so use only injected context and either stay silent or send one light touch.",
  "You have not surfaced for a little while. Use the short wake packet only; do not infer old tasks or try to inspect files.",
  "%USER% may be between tasks or quietly pushing through something. If the injected context is too thin, stay silent instead of inventing a reason to appear.",
  "This is a non-meal, non-reminder random check-in. AI-calendar and task wakeups handle real work; this heartbeat is only for light reconnection.",
];

async function runSystemCheckinPoller(config) {
  const account = resolveSelectedAccount(config);
  const controlPlane = createControlPlane(config, {
    source: "mossbridge.checkin_poller",
    runtimeId: config.runtime || "codex",
  });
  const queue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
  const deferredQueue = new DeferredSystemReplyStore({ filePath: config.deferredSystemReplyQueueFile });
  const runtimeCooldownStore = new RuntimeCooldownStore({ filePath: config.runtimeCooldownFile });
  const runtimeContextUsageStore = new RuntimeContextUsageStore({ filePath: config.runtimeContextUsageFile });
  const checkinConfigStore = new CheckinConfigStore({ filePath: config.checkinConfigFile });
  const sessionStore = new SessionStore({
    filePath: config.sessionsFile,
    runtimeId: config.runtime || "codex",
  });
  const target = resolvePollerTarget({ config, account, sessionStore });
  const defaultRange = resolveDefaultCheckinRange();
  let currentRange = checkinConfigStore.getRange(defaultRange);

  console.log(`[mossbridge] checkin poller ready user=${target.senderId} workspace=${target.workspaceRoot}`);
  console.log(`[mossbridge] checkin interval range ${formatRangeMinutes(currentRange)}`);

  while (true) {
    currentRange = checkinConfigStore.getRange(defaultRange);
    const tokenBackoff = resolveCheckinTokenPressureBackoff({
      config,
      runtimeContextUsageStore,
    });
    const effectiveRange = applyCheckinTokenPressureBackoff(currentRange, tokenBackoff, config);
    if (tokenBackoff.active) {
      recordControl(controlPlane, {
        type: "system.checkin.interval_backoff",
        layer: CONTROL_LAYER.TACTICAL,
        scope: CONTROL_SCOPE.SYSTEM_TURN,
        source: "checkin_poller.schedule",
        subject: target.senderId,
        reason: tokenBackoff.reason,
        outcome: "interval_stretched",
        payload: {
          runtimeId: tokenBackoff.runtimeId,
          ratio: tokenBackoff.ratio,
          currentTokens: tokenBackoff.currentTokens,
          contextWindow: tokenBackoff.contextWindow,
          multiplier: tokenBackoff.multiplier,
          range: effectiveRange,
        },
      });
      console.log(
        `[mossbridge] checkin token backoff active ratio=${round(tokenBackoff.ratio, 3)} current=${tokenBackoff.currentTokens} range=${formatRangeMinutes(effectiveRange)}`,
      );
    }
    const delayMs = pickRandomDelayMs(effectiveRange.minIntervalMs, effectiveRange.maxIntervalMs);
    const wakeAt = formatLocalTime(Date.now() + delayMs);
    console.log(`[mossbridge] next checkin in ${Math.round(delayMs / 60000)}m at ${wakeAt}`);
    await sleep(delayMs);

    const readiness = resolveCheckinReadiness({
      config,
      accountId: account.accountId,
      senderId: target.senderId,
      queue,
      deferredQueue,
      runtimeCooldownStore,
      runtimeContextUsageStore,
    });
    if (!readiness.ready) {
      recordControl(controlPlane, {
        type: "system.checkin.skipped",
        layer: CONTROL_LAYER.TACTICAL,
        scope: CONTROL_SCOPE.SYSTEM_TURN,
        source: "checkin_poller.readiness",
        subject: target.senderId,
        severity: CONTROL_SEVERITY.WARN,
        reason: readiness.reason,
        outcome: "skipped",
        payload: readiness,
      });
      console.log(`[mossbridge] checkin skipped: ${formatCheckinSkipReason(readiness)}`);
      if (readiness.reason === "daily_checkin_budget") {
        const pauseMs = resolveDailyBudgetPauseMs(Date.now());
        recordControl(controlPlane, {
          type: "system.checkin.pause",
          layer: CONTROL_LAYER.TACTICAL,
          scope: CONTROL_SCOPE.SYSTEM_TURN,
          source: "checkin_poller.daily_budget",
          subject: target.senderId,
          reason: "daily_checkin_budget",
          outcome: "paused_until_next_local_day",
          payload: {
            pauseMs,
            dailyBudget: readiness.dailyBudget,
          },
        });
        console.log(`[mossbridge] checkin daily budget pause until ${formatLocalTime(Date.now() + pauseMs)}`);
        await sleep(pauseMs);
      }
      continue;
    }

    if (hasRecentActivity()) {
      const windowMin = Math.round(ACTIVE_WINDOW_MS / 60_000);
      recordControl(controlPlane, {
        type: "system.checkin.skipped",
        layer: CONTROL_LAYER.TACTICAL,
        scope: CONTROL_SCOPE.SYSTEM_TURN,
        source: "checkin_poller.activity",
        subject: target.senderId,
        reason: "active_conversation",
        outcome: "skipped",
        payload: {
          windowMinutes: windowMin,
        },
      });
      console.log(`[mossbridge] checkin skipped: conversation active in last ${windowMin}m`);
      continue;
    }

    const heat = resolveCheckinConversationHeat(config);
    if (heat.hot) {
      recordControl(controlPlane, {
        type: "system.checkin.skipped",
        layer: CONTROL_LAYER.TACTICAL,
        scope: CONTROL_SCOPE.SYSTEM_TURN,
        source: "checkin_poller.heat",
        subject: target.senderId,
        reason: "hot_conversation",
        outcome: "skipped",
        payload: heat,
      });
      console.log(
        `[mossbridge] checkin skipped: hot conversation ${heat.eventCount} events in ${Math.round(heat.windowMs / 60000)}m, last activity ${formatDuration(heat.ageMs)} ago`,
      );
      continue;
    }

    const modelPreflight = resolveCheckinModelWakePreflight({
      config,
      runtimeContextUsageStore,
    });
    if (!modelPreflight.ready) {
      recordControl(controlPlane, {
        type: "system.checkin.skipped",
        layer: CONTROL_LAYER.TACTICAL,
        scope: CONTROL_SCOPE.SYSTEM_TURN,
        source: "checkin_poller.model_preflight",
        subject: target.senderId,
        reason: modelPreflight.reason,
        outcome: "zero_token_patrol",
        payload: modelPreflight,
      });
      console.log(`[mossbridge] checkin patrol skipped model wake: ${formatCheckinSkipReason(modelPreflight)}`);
      continue;
    }

    const queued = queue.enqueue({
      id: crypto.randomUUID(),
      accountId: account.accountId,
      senderId: target.senderId,
      workspaceRoot: target.workspaceRoot,
      text: buildCheckinTrigger(config),
      kind: "checkin_opportunity",
      priority: "normal",
      title: "random_checkin",
      metadata: {
        checkinKind: "random_checkin",
      },
      createdAt: new Date().toISOString(),
    });
    recordControl(controlPlane, {
      type: "system.checkin.queued",
      layer: CONTROL_LAYER.TACTICAL,
      scope: CONTROL_SCOPE.SYSTEM_TURN,
      source: "checkin_poller.queue",
      subject: target.senderId,
      reason: "random_checkin_window",
      outcome: "queued",
      payload: {
        id: queued.id,
        workspaceRoot: target.workspaceRoot,
        accountId: account.accountId,
      },
    });
    console.log(`[mossbridge] checkin queued id=${queued.id}`);
  }
}

function recordControl(controlPlane, event = {}) {
  if (!controlPlane || typeof controlPlane.record !== "function") {
    return null;
  }
  return controlPlane.record(event);
}

function resolveCheckinReadiness({
  config,
  accountId,
  senderId,
  queue,
  deferredQueue,
  runtimeCooldownStore,
  runtimeContextUsageStore,
  nowMs = Date.now(),
} = {}) {
  if (queue && typeof queue.hasPendingForAccount === "function" && queue.hasPendingForAccount(accountId)) {
    return { ready: false, reason: "pending_system_queue" };
  }

  const deferredCount = deferredQueue && typeof deferredQueue.countForSender === "function"
    ? deferredQueue.countForSender(accountId, senderId)
    : 0;
  if (deferredCount > 0) {
    return { ready: false, reason: "deferred_replies_pending", deferredCount };
  }

  const runtimeCooldown = runtimeCooldownStore && typeof runtimeCooldownStore.getActiveCooldown === "function"
    ? runtimeCooldownStore.getActiveCooldown(config?.runtime || "codex", nowMs)
    : null;
  if (runtimeCooldown) {
    return { ready: false, reason: "runtime_cooldown", runtimeCooldown };
  }

  const budgetPolicy = resolveSystemTurnBudgetPolicy({
    kind: "checkin_opportunity",
    config,
    runtimeContextUsageStore,
    nowMs,
  });
  if (budgetPolicy.action === "drop") {
    return {
      ready: false,
      reason: "daily_checkin_budget",
      dailyBudget: budgetPolicy.dailyBudget,
      budgetPolicy,
    };
  }

  const maxAgeMs = resolveCheckinContextTokenMaxAgeMs(config);
  if (maxAgeMs > 0) {
    const tokenAgeMs = getPersistedContextTokenAgeMs(config, accountId, senderId, nowMs);
    if (!Number.isFinite(tokenAgeMs)) {
      return { ready: false, reason: "missing_context_token" };
    }
    if (tokenAgeMs > maxAgeMs) {
      return { ready: false, reason: "stale_context_token", tokenAgeMs, maxAgeMs };
    }
  }

  return { ready: true };
}

function resolveCheckinModelWakePreflight({
  config = {},
  runtimeContextUsageStore = null,
  nowMs = Date.now(),
} = {}) {
  const minGapMinutes = resolveOptionalPositiveNumber(
    config.checkinModelMinGapMinutes,
    DEFAULT_CHECKIN_MODEL_MIN_GAP_MINUTES,
  );
  const minGapMs = Math.round(minGapMinutes * 60_000);
  if (minGapMs <= 0) {
    return { ready: true, reason: "model_gap_disabled", minGapMs: 0 };
  }

  try {
    runtimeContextUsageStore?.load?.();
  } catch {
    // Stale diagnostics should not block the code-level patrol gate.
  }

  const latest = findLatestSystemCheckinContext({
    snapshot: runtimeContextUsageStore?.snapshot?.() || {},
    runtimeId: normalizeText(config.runtime) || "codex",
  });
  if (!latest.updatedAtMs) {
    return {
      ready: true,
      reason: "first_model_wake_for_runtime",
      minGapMs,
    };
  }

  const elapsedMs = Math.max(0, nowMs - latest.updatedAtMs);
  if (elapsedMs < minGapMs) {
    return {
      ready: false,
      reason: "model_wake_min_gap",
      minGapMs,
      elapsedMs,
      remainingMs: minGapMs - elapsedMs,
      lastModelWakeAt: latest.updatedAt,
      nextModelWakeAtMs: latest.updatedAtMs + minGapMs,
    };
  }

  return {
    ready: true,
    reason: "model_wake_due",
    minGapMs,
    elapsedMs,
    lastModelWakeAt: latest.updatedAt,
  };
}

function resolveCheckinContextTokenMaxAgeMs(config = {}) {
  const parsedMinutes = Number.parseInt(String(config.checkinContextTokenMaxAgeMinutes ?? ""), 10);
  if (Number.isFinite(parsedMinutes)) {
    if (parsedMinutes <= 0) {
      return 0;
    }
    return parsedMinutes * 60_000;
  }
  return DEFAULT_CHECKIN_CONTEXT_TOKEN_MAX_AGE_MS;
}

function resolveCheckinDailyBudget({
  config = {},
  runtimeContextUsageStore = null,
  nowMs = Date.now(),
} = {}) {
  const tokenBudget = resolveOptionalPositiveNumber(
    config.checkinDailyTokenBudget,
    DEFAULT_CHECKIN_DAILY_TOKEN_BUDGET,
  );
  const threadBudget = resolveOptionalPositiveNumber(
    config.checkinDailyThreadBudget,
    DEFAULT_CHECKIN_DAILY_THREAD_BUDGET,
  );
  if (tokenBudget <= 0 && threadBudget <= 0) {
    return { exceeded: false, disabled: true, tokenBudget, threadBudget };
  }

  try {
    runtimeContextUsageStore?.load?.();
  } catch {
    // Stale or missing diagnostics should never stop the check-in poller.
  }

  const usage = summarizeSystemCheckinUsageForLocalDay({
    snapshot: runtimeContextUsageStore?.snapshot?.() || {},
    runtimeId: normalizeText(config.runtime) || "codex",
    cacheReadWeight: resolveCacheReadWeight(config.checkinDailyCacheReadWeight),
    nowMs,
  });
  const tokenExceeded = tokenBudget > 0 && usage.budgetTokens >= tokenBudget;
  const threadExceeded = threadBudget > 0 && usage.threadCount >= threadBudget;

  return {
    ...usage,
    tokenBudget,
    threadBudget,
    tokenExceeded,
    threadExceeded,
    exceeded: tokenExceeded || threadExceeded,
  };
}

function resolveSystemTurnBudgetPolicy({
  kind = "",
  config = {},
  runtimeContextUsageStore = null,
  nowMs = Date.now(),
  dailyBudget = null,
} = {}) {
  const normalizedKind = normalizeText(kind).toLowerCase();
  const budget = dailyBudget || resolveCheckinDailyBudget({
    config,
    runtimeContextUsageStore,
    nowMs,
  });
  const base = {
    kind: normalizedKind || "generic",
    dailyBudget: budget,
    budgetPosture: budget?.exceeded ? "daily_budget_exceeded" : "normal",
    reason: budget?.exceeded ? "daily_system_budget" : "within_daily_budget",
  };

  if (!budget?.exceeded || budget?.disabled) {
    return {
      ...base,
      action: "allow",
    };
  }

  if (isRandomCheckinKind(normalizedKind)) {
    return {
      ...base,
      action: "drop",
      reason: "daily_checkin_budget",
      pauseMs: resolveDailyBudgetPauseMs(nowMs),
    };
  }

  if (isDreamingKind(normalizedKind)) {
    const deferMs = resolvePositiveNumber(
      config.systemBudgetDreamingDeferMinutes,
      DEFAULT_SYSTEM_BUDGET_DREAMING_DEFER_MINUTES,
    ) * 60_000;
    return {
      ...base,
      action: "defer",
      deferMs,
      retryAfterMs: nowMs + deferMs,
    };
  }

  if (isReminderKind(normalizedKind)) {
    return {
      ...base,
      action: "allow_compact",
      compactRuntimeTextMaxChars: resolvePositiveNumber(
        config.systemBudgetCompactRuntimeTextMaxChars,
        DEFAULT_SYSTEM_BUDGET_COMPACT_RUNTIME_TEXT_CHARS,
      ),
    };
  }

  return {
    ...base,
    action: "allow_compact",
    compactRuntimeTextMaxChars: resolvePositiveNumber(
      config.systemBudgetCompactRuntimeTextMaxChars,
      DEFAULT_SYSTEM_BUDGET_COMPACT_RUNTIME_TEXT_CHARS,
    ),
  };
}

function summarizeSystemCheckinUsageForLocalDay({
  snapshot = {},
  runtimeId = "codex",
  cacheReadWeight = DEFAULT_CHECKIN_DAILY_CACHE_READ_WEIGHT,
  nowMs = Date.now(),
} = {}) {
  const targetDay = getShanghaiDayKey(nowMs);
  const normalizedCacheReadWeight = resolveCacheReadWeight(cacheReadWeight);
  const contexts = Object.values(snapshot.contextsByThreadId || {});
  return contexts.reduce((acc, context) => {
    if (normalizeText(context.runtimeId) !== runtimeId) {
      return acc;
    }
    if (!isSystemCheckinContext(context)) {
      return acc;
    }
    if (getShanghaiDayKey(Date.parse(context.updatedAt || "")) !== targetDay) {
      return acc;
    }
    acc.currentTokens += Math.max(0, Number(context.currentTokens) || 0);
    acc.budgetTokens += estimateCheckinBudgetTokens(context, normalizedCacheReadWeight);
    acc.threadCount += 1;
    return acc;
  }, {
    day: targetDay,
    runtimeId,
    currentTokens: 0,
    budgetTokens: 0,
    threadCount: 0,
  });
}

function findLatestSystemCheckinContext({
  snapshot = {},
  runtimeId = "codex",
} = {}) {
  const normalizedRuntimeId = normalizeText(runtimeId) || "codex";
  let latest = {
    updatedAt: "",
    updatedAtMs: 0,
    threadId: "",
  };
  for (const context of Object.values(snapshot.contextsByThreadId || {})) {
    if (normalizeText(context?.runtimeId) !== normalizedRuntimeId) {
      continue;
    }
    if (!isSystemCheckinContext(context)) {
      continue;
    }
    const updatedAtMs = Date.parse(context?.updatedAt || "");
    if (!Number.isFinite(updatedAtMs) || updatedAtMs <= latest.updatedAtMs) {
      continue;
    }
    latest = {
      updatedAt: new Date(updatedAtMs).toISOString(),
      updatedAtMs,
      threadId: normalizeText(context?.threadId),
    };
  }
  return latest;
}

function estimateCheckinBudgetTokens(context = {}, cacheReadWeight = DEFAULT_CHECKIN_DAILY_CACHE_READ_WEIGHT) {
  const inputTokens = positiveNumber(context.inputTokens);
  const cacheCreationInputTokens = positiveNumber(context.cacheCreationInputTokens);
  const cacheReadInputTokens = positiveNumber(context.cacheReadInputTokens) + positiveNumber(context.cachedInputTokens);
  const outputTokens = positiveNumber(context.outputTokens);
  const freshTokens = inputTokens + cacheCreationInputTokens + outputTokens;
  if (freshTokens > 0 || cacheReadInputTokens > 0) {
    return Math.round(freshTokens + cacheReadInputTokens * resolveCacheReadWeight(cacheReadWeight));
  }
  return positiveNumber(context.currentTokens);
}

function resolveCacheReadWeight(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CHECKIN_DAILY_CACHE_READ_WEIGHT;
  }
  return Math.max(0, Math.min(1, parsed));
}

function resolveCheckinTokenPressureBackoff({
  config = {},
  runtimeContextUsageStore = null,
} = {}) {
  const runtimeId = normalizeText(config.runtime) || "codex";
  try {
    runtimeContextUsageStore?.load?.();
  } catch {
    // Stale or missing diagnostics should never stop the check-in poller.
  }
  const usage = runtimeContextUsageStore?.getContext?.({ runtimeId }) || null;
  const currentTokens = Number(usage?.currentTokens) || 0;
  const contextWindow = Number(usage?.contextWindow) || Number(config.claudeContextWindow) || 0;
  if (!currentTokens || !contextWindow) {
    return { active: false, reason: "no_token_pressure", runtimeId, currentTokens, contextWindow, ratio: 0, multiplier: 1 };
  }
  const ratio = currentTokens / contextWindow;
  const severeRatio = resolvePercentRatio(
    config.checkinTokenSevereBackoffPercent,
    DEFAULT_CHECKIN_TOKEN_SEVERE_BACKOFF_PERCENT,
  );
  const backoffRatio = resolvePercentRatio(
    config.checkinTokenBackoffPercent,
    DEFAULT_CHECKIN_TOKEN_BACKOFF_PERCENT,
  );
  if (ratio >= severeRatio) {
    return {
      active: true,
      reason: "severe_token_pressure",
      runtimeId,
      currentTokens,
      contextWindow,
      ratio,
      multiplier: resolvePositiveNumber(
        config.checkinTokenSevereBackoffMultiplier,
        DEFAULT_CHECKIN_TOKEN_SEVERE_BACKOFF_MULTIPLIER,
      ),
    };
  }
  if (ratio >= backoffRatio) {
    return {
      active: true,
      reason: "token_pressure",
      runtimeId,
      currentTokens,
      contextWindow,
      ratio,
      multiplier: resolvePositiveNumber(
        config.checkinTokenBackoffMultiplier,
        DEFAULT_CHECKIN_TOKEN_BACKOFF_MULTIPLIER,
      ),
    };
  }
  return {
    active: false,
    reason: "below_token_pressure",
    runtimeId,
    currentTokens,
    contextWindow,
    ratio,
    multiplier: 1,
  };
}

function applyCheckinTokenPressureBackoff(range = {}, tokenBackoff = {}, config = {}) {
  if (!tokenBackoff?.active) {
    return range;
  }
  const multiplier = resolvePositiveNumber(tokenBackoff.multiplier, DEFAULT_CHECKIN_TOKEN_BACKOFF_MULTIPLIER);
  const maxBackoffMs = Math.max(
    range.maxIntervalMs || 0,
    resolvePositiveNumber(config.checkinMaxBackoffMinutes, DEFAULT_CHECKIN_MAX_BACKOFF_MS / 60_000) * 60_000,
  );
  const minIntervalMs = Math.min(maxBackoffMs, Math.round((Number(range.minIntervalMs) || 0) * multiplier));
  const maxIntervalMs = Math.min(maxBackoffMs, Math.round((Number(range.maxIntervalMs) || minIntervalMs) * multiplier));
  return {
    minIntervalMs,
    maxIntervalMs: Math.max(minIntervalMs, maxIntervalMs),
  };
}

function resolveCheckinConversationHeat(config = {}, nowMs = Date.now()) {
  return getConversationHeat({
    nowMs,
    windowMs: resolvePositiveNumber(config.checkinHotWindowMinutes, HOT_ACTIVITY_WINDOW_MS / 60_000) * 60_000,
    recentWindowMs: resolvePositiveNumber(config.checkinHotRecentMinutes, HOT_ACTIVITY_RECENT_MS / 60_000) * 60_000,
    minEvents: resolvePositiveNumber(config.checkinHotMinEvents, HOT_ACTIVITY_MIN_EVENTS),
  });
}

function resolvePercentRatio(value, fallbackPercent) {
  const parsed = Number(value);
  const percent = Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackPercent;
  return Math.min(1, percent / 100);
}

function resolvePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveOptionalPositiveNumber(value, fallback) {
  if (value === 0 || value === "0") {
    return 0;
  }
  return resolvePositiveNumber(value, fallback);
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function isRandomCheckinKind(kind = "") {
  return normalizeText(kind).toLowerCase() === "checkin_opportunity";
}

function isDreamingKind(kind = "") {
  const normalized = normalizeText(kind).toLowerCase();
  return normalized === "dreaming_opportunity" || normalized === "memory_metabolism";
}

function isReminderKind(kind = "") {
  const normalized = normalizeText(kind).toLowerCase();
  return normalized === "reminder_due" || normalized === "calendar_due";
}

function isSystemCheckinContext(context = {}) {
  const bindingKey = normalizeText(context.bindingKey);
  return bindingKey.includes("#mossbridge-system")
    || normalizeText(context.source) === "system";
}

function getShanghaiDayKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function round(value, digits = 2) {
  const scale = 10 ** Math.max(0, Number(digits) || 0);
  return Math.round((Number(value) || 0) * scale) / scale;
}

function formatCheckinSkipReason(readiness = {}) {
  switch (readiness.reason) {
    case "pending_system_queue":
      return "pending system message still in queue";
    case "deferred_replies_pending":
      return `deferred system replies waiting for next inbound (${readiness.deferredCount || 0})`;
    case "runtime_cooldown":
      return `runtime cooldown until ${formatLocalTime(readiness.runtimeCooldown?.resetAtMs || readiness.runtimeCooldown?.resetAt)} (${formatDuration(readiness.runtimeCooldown?.remainingMs)} remaining)`;
    case "daily_checkin_budget":
      return `daily check-in budget reached (${readiness.dailyBudget?.budgetTokens || 0}/${readiness.dailyBudget?.tokenBudget || 0} weighted tokens, ${readiness.dailyBudget?.currentTokens || 0} context tokens, ${readiness.dailyBudget?.threadCount || 0}/${readiness.dailyBudget?.threadBudget || 0} system threads)`;
    case "model_wake_min_gap":
      return `model wake not due yet (${formatDuration(readiness.elapsedMs)} since last system wake, next in ${formatDuration(readiness.remainingMs)})`;
    case "missing_context_token":
      return "no usable WeChat context token for proactive delivery yet";
    case "stale_context_token":
      return `WeChat context token is stale (${formatDuration(readiness.tokenAgeMs)} > ${formatDuration(readiness.maxAgeMs)})`;
    default:
      return normalizeText(readiness.reason) || "not ready";
  }
}

function formatDuration(ms) {
  const minutes = Math.max(0, Math.round((Number(ms) || 0) / 60_000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.round(hours / 24)}d`;
}

function resolveDailyBudgetPauseMs(nowMs = Date.now()) {
  const currentDay = getShanghaiDayKey(nowMs);
  const stepMs = 15 * 60_000;
  const maxMs = 36 * 60 * 60_000;
  for (let offsetMs = stepMs; offsetMs <= maxMs; offsetMs += stepMs) {
    if (getShanghaiDayKey(nowMs + offsetMs) !== currentDay) {
      return offsetMs + 2 * 60_000;
    }
  }
  return 6 * 60 * 60_000;
}

function resolvePollerTarget({ config, account, sessionStore }) {
  const senderId = resolvePreferredSenderId({
    config,
    accountId: account.accountId,
    explicitUser: process.env.MOSSBRIDGE_CHECKIN_USER_ID || "",
    sessionStore,
  });
  const workspaceRoot = resolvePreferredWorkspaceRoot({
    config,
    accountId: account.accountId,
    senderId,
    explicitWorkspace: process.env.MOSSBRIDGE_CHECKIN_WORKSPACE || "",
    sessionStore,
  });

  if (!senderId) {
    throw new Error("Cannot determine the WeChat user for the checkin poller. Set MOSSBRIDGE_CHECKIN_USER_ID or let the only active user talk to the bot once first.");
  }
  if (!workspaceRoot) {
    throw new Error("Cannot determine the workspace for the checkin poller. Set MOSSBRIDGE_WORKSPACE_ROOT first.");
  }

  return { senderId, workspaceRoot };
}

function pickRandomDelayMs(minIntervalMs, maxIntervalMs) {
  if (maxIntervalMs <= minIntervalMs) {
    return minIntervalMs;
  }
  return minIntervalMs + Math.floor(Math.random() * (maxIntervalMs - minIntervalMs + 1));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatLocalTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value || "");
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).replace(/\//g, "-");
}

function formatRangeMinutes(range) {
  return `${Math.round(range.minIntervalMs / 60000)}m-${Math.round(range.maxIntervalMs / 60000)}m`;
}

function buildCheckinTrigger(config) {
  const userName = normalizeText(config?.userName) || "the user";
  const template = INTERNAL_CHECKIN_TRIGGER_TEMPLATES[
    Math.floor(Math.random() * INTERNAL_CHECKIN_TRIGGER_TEMPLATES.length)
  ] || INTERNAL_CHECKIN_TRIGGER_TEMPLATES[0];
  return template.replace(/%USER%/g, userName);
}

module.exports = {
  applyCheckinTokenPressureBackoff,
  findLatestSystemCheckinContext,
  runSystemCheckinPoller,
  resolveCheckinDailyBudget,
  resolveCheckinConversationHeat,
  resolveCheckinContextTokenMaxAgeMs,
  resolveCheckinModelWakePreflight,
  resolveCheckinReadiness,
  resolveCheckinTokenPressureBackoff,
  resolveDailyBudgetPauseMs,
  resolveSystemTurnBudgetPolicy,
  summarizeSystemCheckinUsageForLocalDay,
};
