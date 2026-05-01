const crypto = require("crypto");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { CheckinConfigStore, resolveDefaultCheckinRange } = require("../core/checkin-config-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { SystemMessageQueueStore } = require("../core/system-message-queue-store");
const { hasRecentActivity, ACTIVE_WINDOW_MS } = require("../core/activity-tracker");

const INTERNAL_CHECKIN_TRIGGER_TEMPLATES = [
  "%USER% comes to mind again.",
  "A small ordinary check-in window opens for %USER%; decide whether a tiny hello would help.",
  "You have not surfaced for a little while. Reassess %USER%'s current day and whether a light touch belongs here.",
  "%USER% may be between tasks or quietly pushing through something. Consider whether to appear with a small, low-stakes message.",
  "This is a non-meal, non-reminder check-in window for %USER%; do not wait only for scheduled anchors.",
];

async function runSystemCheckinPoller(config) {
  const account = resolveSelectedAccount(config);
  const queue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
  const checkinConfigStore = new CheckinConfigStore({ filePath: config.checkinConfigFile });
  const sessionStore = new SessionStore({
    filePath: config.sessionsFile,
    runtimeId: config.runtime || "codex",
  });
  const target = resolvePollerTarget({ config, account, sessionStore });
  const defaultRange = resolveDefaultCheckinRange();
  let currentRange = checkinConfigStore.getRange(defaultRange);

  console.log(`[asheriebridge] checkin poller ready user=${target.senderId} workspace=${target.workspaceRoot}`);
  console.log(`[asheriebridge] checkin interval range ${formatRangeMinutes(currentRange)}`);

  while (true) {
    currentRange = checkinConfigStore.getRange(defaultRange);
    const delayMs = pickRandomDelayMs(currentRange.minIntervalMs, currentRange.maxIntervalMs);
    const wakeAt = formatLocalTime(Date.now() + delayMs);
    console.log(`[asheriebridge] next checkin in ${Math.round(delayMs / 60000)}m at ${wakeAt}`);
    await sleep(delayMs);

    if (queue.hasPendingForAccount(account.accountId)) {
      console.log("[asheriebridge] checkin skipped: pending system message still in queue");
      continue;
    }

    if (hasRecentActivity()) {
      const windowMin = Math.round(ACTIVE_WINDOW_MS / 60_000);
      console.log(`[asheriebridge] checkin skipped: conversation active in last ${windowMin}m`);
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
    console.log(`[asheriebridge] checkin queued id=${queued.id}`);
  }
}

function resolvePollerTarget({ config, account, sessionStore }) {
  const senderId = resolvePreferredSenderId({
    config,
    accountId: account.accountId,
    explicitUser: process.env.ASHERIEBRIDGE_CHECKIN_USER_ID || "",
    sessionStore,
  });
  const workspaceRoot = resolvePreferredWorkspaceRoot({
    config,
    accountId: account.accountId,
    senderId,
    explicitWorkspace: process.env.ASHERIEBRIDGE_CHECKIN_WORKSPACE || "",
    sessionStore,
  });

  if (!senderId) {
    throw new Error("Cannot determine the WeChat user for the checkin poller. Set ASHERIEBRIDGE_CHECKIN_USER_ID or let the only active user talk to the bot once first.");
  }
  if (!workspaceRoot) {
    throw new Error("Cannot determine the workspace for the checkin poller. Set ASHERIEBRIDGE_WORKSPACE_ROOT first.");
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

module.exports = { runSystemCheckinPoller };
