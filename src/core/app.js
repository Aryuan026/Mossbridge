const os = require("os");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { createWeixinChannelAdapter } = require("../adapters/channel/weixin");
const { DEFAULT_MIN_WEIXIN_CHUNK, MAX_MIN_WEIXIN_CHUNK } = require("../adapters/channel/weixin/config-store");
const {
  finalizeAttachmentNotes,
  persistIncomingWeixinAttachments,
} = require("../adapters/channel/weixin/media-receive");
const { createCodexRuntimeAdapter } = require("../adapters/runtime/codex");
const { createClaudeCodeRuntimeAdapter } = require("../adapters/runtime/claudecode");
const { findModelByQuery, normalizeModelCatalog } = require("../adapters/runtime/codex/model-catalog");
const { createTimelineIntegration } = require("../integrations/timeline");
const {
  CONTROL_LAYER,
  CONTROL_SCOPE,
  CONTROL_SEVERITY,
  createControlPlane,
} = require("../control/control-plane");
const { buildWeixinHelpText } = require("./command-registry");
const { CheckinConfigStore, parseCheckinRangeMinutes, resolveDefaultCheckinRange } = require("./checkin-config-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("./default-targets");
const { resolveWorkspaceOfficePaths } = require("./workspace-office-layout");
const { StreamDelivery } = require("./stream-delivery");
const { ThreadStateStore } = require("./thread-state-store");
const { RuntimeCooldownStore } = require("./runtime-cooldown-store");
const { RuntimeContextUsageStore } = require("./runtime-context-usage-store");
const { SessionRefreshRequestStore } = require("./session-refresh-request-store");
const { WeixinIngressAuditStore } = require("./weixin-ingress-audit-store");
const { DeferredSystemReplyStore } = require("./deferred-system-reply-store");
const { SystemMessageQueueStore } = require("./system-message-queue-store");
const { SystemMessageDispatcher } = require("./system-message-dispatcher");
const { TimelineScreenshotQueueStore } = require("./timeline-screenshot-queue-store");
const { TurnGateStore } = require("./turn-gate-store");
const { ReminderQueueStore } = require("../adapters/channel/weixin/reminder-queue-store");
const {
  matchesCommandPrefix,
  canonicalizeCommandTokens,
  extractApprovalFilePaths,
  isPathWithinRoot,
  normalizeCommandTokens,
  splitCommandLine,
} = require("../adapters/runtime/shared/approval-command");
const {
  resolveSystemTurnBudgetPolicy,
  runSystemCheckinPoller,
} = require("../app/system-checkin-poller");
const { createProjectTooling } = require("../tools/create-project-tooling");
const { getLastActivityAt, recordUserMessage, recordAiReply } = require("./activity-tracker");
const {
  isDreamingSystemTurn,
  resolveDreamingAttemptId,
} = require("../services/memory-metabolism-service");
const {
  buildRuntimeCapacityNotice,
  formatBridgeNotice,
  isRuntimeCapacityNotice,
  isRuntimeCapacitySignal,
  shieldRuntimeNoticeForDelivery,
} = require("./runtime-notices");

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MIN_LONG_POLL_TIMEOUT_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const WEIXIN_TRANSPORT_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
const FIRST_RUNTIME_EVENT_NOTICE_TIMEOUT_MS = 8_000;
const FIRST_RUNTIME_EVENT_FAILURE_TIMEOUT_MS = 45_000;
const CLAUDECODE_FIRST_RUNTIME_EVENT_NOTICE_TIMEOUT_MS = 75_000;
const CLAUDECODE_FIRST_RUNTIME_EVENT_FAILURE_TIMEOUT_MS = 120_000;
const OPENING_CLAUDECODE_FIRST_EVENT_FAILURE_TIMEOUT_MS = 180_000;
const RUNNING_TURN_STALL_NOTICE_TIMEOUT_MS = 90_000;
const RUNNING_TURN_STALL_RECOVERY_TIMEOUT_MS = 240_000;
const CLAUDECODE_RUNNING_TURN_STALL_NOTICE_TIMEOUT_MS = 150_000;
const CLAUDECODE_RUNNING_TURN_STALL_RECOVERY_TIMEOUT_MS = 360_000;
const MAX_SYSTEM_RUNTIME_TEXT_CHARS = 24_000;
const DEFAULT_CHECKIN_RUNTIME_TEXT_CHARS = 8_000;
const SYSTEM_FAILURE_NOTICE_THROTTLE_MS = 30 * 60_000;
const DEFAULT_BACKGROUND_RUNTIME_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_BACKGROUND_RUNTIME_CIRCUIT_COOLDOWN_MS = 45 * 60_000;
const BACKGROUND_RUNTIME_CIRCUIT_STORE_VERSION = 1;
const MAX_INBOUND_ATTACHMENT_BATCH = 10;
const INBOUND_ATTACHMENT_BATCH_IDLE_MS = 8_000;
const INBOUND_ATTACHMENT_TEXT_BATCH_IDLE_MS = 6_000;
const INBOUND_ATTACHMENT_PRELUDE_IDLE_MS = 12_000;
const DEFAULT_SESSION_REFRESH_PRESSURE_PERCENT = 92;
const DEFAULT_SESSION_REFRESH_MIN_INTERVAL_MS = 30 * 60_000;

function resolveFirstRuntimeEventFailureTimeoutMs({ isClaudeCode = false, openingTurn = false } = {}) {
  if (!isClaudeCode) {
    return FIRST_RUNTIME_EVENT_FAILURE_TIMEOUT_MS;
  }
  return openingTurn
    ? OPENING_CLAUDECODE_FIRST_EVENT_FAILURE_TIMEOUT_MS
    : CLAUDECODE_FIRST_RUNTIME_EVENT_FAILURE_TIMEOUT_MS;
}

function createRuntimeAdapter(config) {
  if (config.runtime === "claudecode") {
    return createClaudeCodeRuntimeAdapter(config);
  }
  return createCodexRuntimeAdapter(config);
}

class MossbridgeApp {
  constructor(config) {
    this.config = config;
    this.channelAdapter = createWeixinChannelAdapter(config);
    this.timelineIntegration = createTimelineIntegration(config);
    const projectTooling = createProjectTooling(config, {
      channelAdapter: this.channelAdapter,
      timelineIntegration: this.timelineIntegration,
    });
    this.projectServices = projectTooling.services;
    this.projectDomains = projectTooling.domains;
    this.projectToolHost = projectTooling.toolHost;
    this.runtimeContextStore = projectTooling.runtimeContextStore;
    this.runtimeAdapter = createRuntimeAdapter(config);
    this.controlPlane = createControlPlane(config, {
      runtimeId: this.runtimeAdapter.describe().id,
    });
    this.memoryMetabolismService = this.projectServices.memoryMetabolism || null;
    this.threadStateStore = new ThreadStateStore();
    this.runtimeCooldownStore = new RuntimeCooldownStore({ filePath: config.runtimeCooldownFile });
    this.runtimeContextUsageStore = new RuntimeContextUsageStore({ filePath: config.runtimeContextUsageFile });
    this.backgroundRuntimeCircuit = loadBackgroundRuntimeCircuitState(config.backgroundRuntimeCircuitFile);
    this.sessionRefreshRequests = new SessionRefreshRequestStore({ filePath: config.sessionRefreshRequestsFile });
    this.weixinIngressAuditStore = new WeixinIngressAuditStore({ filePath: config.weixinIngressAuditFile });
    this.systemMessageQueue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
    this.deferredSystemReplyQueue = new DeferredSystemReplyStore({ filePath: config.deferredSystemReplyQueueFile });
    this.checkinConfigStore = new CheckinConfigStore({ filePath: config.checkinConfigFile });
    this.timelineScreenshotQueue = new TimelineScreenshotQueueStore({ filePath: config.timelineScreenshotQueueFile });
    this.reminderQueue = new ReminderQueueStore({ filePath: config.reminderQueueFile });
    this.turnGateStore = new TurnGateStore();
    this.pendingInboundByScope = new Map();
    this.pendingAttachmentInboundByScope = new Map();
    this.pendingAttachmentIntakeByScope = new Map();
    this.inboundUpdateBatchDepth = 0;
    this.inboundUpdateBatchAttachmentSenders = new Set();
    this.deferredAttachmentInboundFlushScopeKeys = new Set();
    this.turnBoundaryScopeKeys = new Set();
    this.turnWritebackContextByRunKey = new Map();
    this.pendingTurnWritebackByThreadId = new Map();
    this.residentAnchorPreludeKeys = new Set();
    this.stableTurnGuidanceKeys = new Set();
    this.systemMessageDispatcher = null;
    this.streamDelivery = new StreamDelivery({
      channelAdapter: this.channelAdapter,
      sessionStore: this.runtimeAdapter.getSessionStore(),
      runtimeId: this.runtimeAdapter.describe?.().id || this.config.runtime || "runtime",
      onDeferredSystemReply: (payload) => this.deferSystemReply(payload),
      onRuntimeNotice: (payload) => this.recordRuntimeNotice(payload),
      onOutboundDelivery: (payload) => this.recordWeixinOutboundAudit(payload),
    });
    this.pendingRuntimeEventWatchdogs = new Map();
    this.runningTurnWatchdogs = new Map();
    this.watchdogCancelledRunKeys = new Set();
    this.pendingAutoCompactByThreadId = new Map();
    this.lastAutoCompactAtByThreadId = new Map();
    this.lastAutoSessionRefreshAtByScope = new Map();
    this.pendingOperationByRunKey = new Map();
    this.lastSystemFailureNoticeAtByKey = new Map();
    this.runtimeEventChain = Promise.resolve();
    this.nextDreamingPollAtMs = 0;
    this.runtimeAdapter.onEvent((event) => {
      if (shouldClearFirstRuntimeEventWatchdog(event)) {
        this.clearRuntimeEventWatchdog(event?.payload?.threadId);
      }
      this.threadStateStore.applyRuntimeEvent(event);
      this.recordRuntimeContextUsage(event);
      this.observeRunningTurnEvent(event);
      this.runtimeEventChain = this.runtimeEventChain
        .catch(() => {})
        .then(() => this.handleRuntimeEvent(event))
        .catch((error) => {
          const message = error instanceof Error ? error.stack || error.message : String(error);
          console.error(`[mossbridge] runtime event handling failed type=${event?.type || "(unknown)"} ${message}`);
        });
    });
  }

  printDoctor() {
    const inboundAccess = this.describeInboundAccess();
    console.log(JSON.stringify({
      stateDir: this.config.stateDir,
      inboundAccess,
      channel: this.channelAdapter.describe(),
      runtime: this.runtimeAdapter.describe(),
      timeline: this.timelineIntegration.describe(),
      control: this.controlPlane?.status ? this.controlPlane.status({ limit: 50 }) : null,
      memory: this.projectDomains?.memory?.describe ? this.projectDomains.memory.describe() : null,
      metabolism: this.memoryMetabolismService?.describe ? this.memoryMetabolismService.describe() : null,
      maintenance: {
        profile: this.config.maintenanceProfile,
        selfRepairAllowed: this.config.maintenanceAllowSelfRepair,
        actionLevel: this.config.maintenanceAllowSelfRepair ? "safe_repair" : "read_only_report",
        diagnosticMemoryPolicy: "Memory/dreaming capture is for user continuity; failure reports, quota notices, and maintenance chatter stay in diagnostics.",
      },
      threads: this.threadStateStore.snapshot(),
    }, null, 2));
  }

  recordControlEvent(event = {}) {
    if (!this.controlPlane || typeof this.controlPlane.record !== "function") {
      return null;
    }
    const runtimeId = normalizeText(event.runtimeId)
      || normalizeText(this.runtimeAdapter?.describe?.().id)
      || normalizeText(this.config?.runtime);
    return this.controlPlane.record({
      runtimeId,
      ...event,
    });
  }

  async login() {
    await this.channelAdapter.login();
  }

  printAccounts() {
    this.channelAdapter.printAccounts();
  }

  async start() {
    const account = this.channelAdapter.resolveAccount();
    this.activeAccountId = account.accountId;
    this.systemMessageDispatcher = new SystemMessageDispatcher({
      queueStore: this.systemMessageQueue,
      config: this.config,
      accountId: account.accountId,
    });
    const runtimeState = await this.runtimeAdapter.initialize();
    const knownContextTokens = Object.keys(this.channelAdapter.getKnownContextTokens()).length;
    const syncBuffer = this.channelAdapter.loadSyncBuffer();
    await this.restoreBoundThreadSubscriptions();

    console.log("[mossbridge] bootstrap ok");
    console.log(`[mossbridge] channel=${this.channelAdapter.describe().id}`);
    console.log(`[mossbridge] runtime=${this.runtimeAdapter.describe().id}`);
    console.log(`[mossbridge] timeline=${this.timelineIntegration.describe().id}`);
    console.log(`[mossbridge] account=${account.accountId}`);
    console.log(`[mossbridge] baseUrl=${account.baseUrl}`);
    console.log(`[mossbridge] workspaceRoot=${this.config.workspaceRoot}`);
    this.logInboundAccess();
    console.log(`[mossbridge] knownContextTokens=${knownContextTokens}`);
    console.log(`[mossbridge] syncBuffer=${syncBuffer ? "ready" : "empty"}`);
    console.log(`[mossbridge] runtimeEndpoint=${runtimeState.endpoint || runtimeState.command || "(spawn)"}`);
    console.log(`[mossbridge] runtimeModels=${runtimeState.models?.length || 0}`);
    if (this.config.startWithLocationServer) {
      await this.ensureLocationServerStarted();
    }
    console.log("[mossbridge] bridge loop started; waiting for WeChat messages.");
    if (this.config.startWithCheckin) {
      console.log("[mossbridge] checkin: enabled");
      void runSystemCheckinPoller(this.config).catch((error) => {
        console.error(`[mossbridge] checkin poller stopped: ${error.message}`);
      });
    }
    if (this.config.startWithDreaming) {
      console.log("[mossbridge] dreaming: enabled");
    }

    const shutdown = createShutdownController(async () => {
      this.clearPendingAttachmentInboundTimers();
      await this.closeLocationServer();
      await this.runtimeAdapter.close();
    });

    try {
      let consecutiveFailures = 0;
      let pollOutageStartedAtMs = 0;
      while (!shutdown.stopped) {
        try {
          if (consecutiveFailures <= 0) {
            await this.flushOutboundQueues(account);
          }
          const syncBufferBefore = this.channelAdapter.loadSyncBuffer();
          const response = await this.channelAdapter.getUpdates({
            syncBuffer: syncBufferBefore,
            timeoutMs: this.resolveLongPollTimeoutMs(),
          });
          assertWeixinUpdateResponse(response);
          if (consecutiveFailures > 0) {
            this.recordWeixinPollRecoveryAudit({
              consecutiveFailures,
              outageStartedAtMs: pollOutageStartedAtMs,
            });
          }
          consecutiveFailures = 0;
          pollOutageStartedAtMs = 0;
          const messages = sortInboundUpdateMessages(Array.isArray(response?.msgs) ? response.msgs : []);
          this.recordWeixinPollAudit({ response, messages, syncBufferBefore });
          this.beginInboundUpdateBatch(messages.length, messages);
          try {
            for (const message of messages) {
              if (shutdown.stopped) {
                break;
              }
              await this.handleIncomingMessage(message);
            }
          } finally {
            this.endInboundUpdateBatch();
          }
          await this.flushOutboundQueues(account);
        } catch (error) {
          if (shutdown.stopped) {
            break;
          }

          if (isSessionExpiredError(error)) {
            throw new Error("The WeChat session has expired. Run `npm run login` again.");
          }

          if (consecutiveFailures <= 0) {
            pollOutageStartedAtMs = Date.now();
          }
          consecutiveFailures += 1;
          const retryDelayMs = resolveWeixinPollRetryDelayMs(consecutiveFailures, error);
          const formattedError = formatErrorMessage(error);
          this.recordWeixinPollFailureAudit(error, consecutiveFailures, formattedError, {
            retryDelayMs,
            outageStartedAtMs: pollOutageStartedAtMs,
          });
          console.error(`[mossbridge] poll failed: ${formattedError}; retry in ${Math.round(retryDelayMs / 1000)}s`);
          await sleep(retryDelayMs);
        }
      }
    } finally {
      shutdown.dispose();
      this.clearPendingAttachmentInboundTimers();
      await this.closeLocationServer();
      await this.runtimeAdapter.close();
    }
  }

  async ensureLocationServerStarted() {
    if (!this.projectDomains?.presence) {
      return null;
    }
    await this.projectDomains.presence.startWhereaboutsServer({
      onAccepted: (result) => this.handleLocationAccepted(result),
    });
    console.log(
      `[mossbridge] locationServer=http://${this.config.locationHost}:${this.config.locationPort} store=${this.config.locationStoreFile}`
    );
    return this.projectDomains.presence.getWhereaboutsServer();
  }

  async closeLocationServer() {
    if (!this.projectDomains?.presence) {
      return;
    }
    await this.projectDomains.presence.closeWhereaboutsServer();
  }

  async flushOutboundQueues(account) {
    await Promise.all([
      this.maybeQueueDreaming(account),
      this.flushDueReminders(account),
      this.flushPendingInboundMessages(),
      this.flushPendingSystemMessages(),
      this.flushPendingTimelineScreenshots(account),
    ]);
  }

  handleLocationAccepted(result) {
    if (!this.activeAccountId) {
      return;
    }

    const point = result?.appended?.point || null;
    const movementEvent = result?.appended?.movementEvent || null;
    const triggerText = buildLocationTriggerSystemText(point?.trigger);
    if (!triggerText && !movementEvent) {
      return;
    }

    const sessionStore = this.runtimeAdapter.getSessionStore();
    const senderId = resolvePreferredSenderId({
      config: this.config,
      accountId: this.activeAccountId,
      sessionStore,
    });
    const workspaceRoot = resolvePreferredWorkspaceRoot({
      config: this.config,
      accountId: this.activeAccountId,
      senderId,
      sessionStore,
    });
    if (!senderId || !workspaceRoot) {
      return;
    }

    if (triggerText && point?.id) {
      this.systemMessageQueue.enqueue({
        id: `location-trigger:${point.id}`,
        accountId: this.activeAccountId,
        senderId,
        workspaceRoot,
        text: triggerText,
        kind: "location_trigger",
        priority: "normal",
        title: normalizeText(point?.trigger) || "location_trigger",
        metadata: {
          trigger: normalizeText(point?.trigger),
          observedAt: normalizeIsoTime(point?.receivedAt) || normalizeIsoTime(point?.timestamp) || "",
        },
        createdAt: normalizeIsoTime(point?.receivedAt) || normalizeIsoTime(point?.timestamp) || new Date().toISOString(),
      });
    }

    if (movementEvent) {
      this.systemMessageQueue.enqueue({
        id: `location-move:${movementEvent.id}`,
        accountId: this.activeAccountId,
        senderId,
        workspaceRoot,
        text: buildLocationMovementSystemText(movementEvent),
        kind: "location_movement",
        priority: "normal",
        title: "major_move",
        metadata: {
          fromLabel: normalizeText(movementEvent?.fromAddress) || formatLatLng(movementEvent?.fromCenterLat, movementEvent?.fromCenterLng),
          toLabel: normalizeText(movementEvent?.toAddress) || formatLatLng(movementEvent?.toCenterLat, movementEvent?.toCenterLng),
          distanceText: `${formatCompactNumber(movementEvent?.distanceMeters || 0)}m`,
          observedAt: normalizeIsoTime(movementEvent?.movedAt) || "",
        },
        createdAt: normalizeIsoTime(movementEvent?.movedAt) || new Date().toISOString(),
      });
    }
  }

  async sendTimelineScreenshot({
    senderId = "",
    outputFile = "",
    selector = "",
    range = "",
    date = "",
    week = "",
    month = "",
    category = "",
    subcategory = "",
    width = 0,
    height = 0,
    sidePadding = undefined,
    locale = "",
  } = {}) {
    return this.projectDomains.calendar.queueScreenshot({
      userId: senderId,
      outputFile,
      selector,
      range,
      date,
      week,
      month,
      category,
      subcategory,
      width,
      height,
      sidePadding,
      locale,
    }, {});
  }

  async sendLocalFileToCurrentChat({ senderId = "", filePath = "" } = {}) {
    return this.projectDomains.transport.sendFileToCurrentChat({
      userId: senderId,
      filePath,
    }, {});
  }

  async handleIncomingMessage(message) {
    const normalized = this.channelAdapter.normalizeIncomingMessage(message);
    if (!normalized) {
      this.recordWeixinInboundAudit({
        stage: "filtered",
        rawMessage: message,
      });
      return;
    }

    if (!this.isAuthorizedInboundSender(normalized.senderId)) {
      this.recordWeixinInboundAudit({
        stage: "rejected_unauthorized",
        rawMessage: message,
        normalized,
        includeTextPreview: false,
      });
      return;
    }

    if (typeof this.channelAdapter.rememberContextToken === "function") {
      this.channelAdapter.rememberContextToken(normalized.senderId, normalized.contextToken);
    }

    this.recordWeixinInboundAudit({
      stage: "accepted",
      rawMessage: message,
      normalized,
    });
    recordUserMessage();
    this.primeDeferredRepliesForSender(normalized);
    try {
      await this.handlePreparedMessage(normalized, { allowCommands: true });
      this.recordWeixinInboundAudit({
        stage: "dispatched",
        rawMessage: message,
        normalized,
      });
    } catch (error) {
      this.recordWeixinInboundAudit({
        stage: "error",
        rawMessage: message,
        normalized,
        error,
      });
      throw error;
    }
  }

  isAuthorizedInboundSender(senderId = "") {
    return this.resolveInboundAuthorization(senderId).authorized;
  }

  resolveInboundAuthorization(senderId = "") {
    const normalizedSenderId = normalizeText(senderId);
    const allowed = normalizeAllowedUserIds(this.config?.allowedUserIds);
    if (!normalizedSenderId) {
      return { authorized: false, mode: "missing_sender", allowedUserCount: allowed.length };
    }
    if (allowed.length) {
      const authorized = allowed.includes(normalizedSenderId.toLowerCase());
      return {
        authorized,
        mode: authorized ? "authorized" : "unauthorized",
        allowedUserCount: allowed.length,
      };
    }
    if (this.config?.allowOpenInbound) {
      return { authorized: true, mode: "open_enrollment", allowedUserCount: 0 };
    }
    return { authorized: false, mode: "closed_empty_allowlist", allowedUserCount: 0 };
  }

  describeInboundAccess() {
    const allowed = normalizeAllowedUserIds(this.config?.allowedUserIds);
    const open = Boolean(this.config?.allowOpenInbound);
    const warning = !allowed.length && !open
      ? "MOSSBRIDGE_ALLOWED_USER_IDS is empty and MOSSBRIDGE_ALLOW_OPEN_INBOUND is false; normal WeChat inbound messages are rejected until you fill the allowlist or explicitly enable temporary enrollment."
      : (!allowed.length && open
        ? "Temporary open inbound enrollment is enabled. Use it only long enough to identify the sender id, then set MOSSBRIDGE_ALLOWED_USER_IDS and disable MOSSBRIDGE_ALLOW_OPEN_INBOUND."
        : "");
    return {
      status: allowed.length ? "allowlist_configured" : (open ? "open_enrollment" : "closed_empty_allowlist"),
      allowedUserCount: allowed.length,
      openEnrollment: open,
      warning,
    };
  }

  logInboundAccess() {
    const inboundAccess = this.describeInboundAccess();
    console.log(`[mossbridge] inboundAccess=${inboundAccess.status}`);
    console.log(`[mossbridge] allowedUserIds=${inboundAccess.allowedUserCount}`);
    if (inboundAccess.warning) {
      console.warn(`[mossbridge] inbound warning: ${inboundAccess.warning}`);
    }
  }

  recordWeixinPollAudit({ response, messages, syncBufferBefore }) {
    const newBuf = typeof response?.get_updates_buf === "string" ? response.get_updates_buf.trim() : "";
    const messageCount = Array.isArray(messages) ? messages.length : 0;
    this.weixinIngressAuditStore?.recordPoll?.({
      ret: response?.ret ?? null,
      errcode: response?.errcode ?? null,
      messageCount,
      syncBufferChanged: Boolean(newBuf && newBuf !== syncBufferBefore),
      messageIds: (Array.isArray(messages) ? messages : [])
        .slice(0, 12)
        .map((message) => normalizeCommandArgument(String(message?.message_id ?? message?.client_id ?? ""))),
    });
    if (messageCount > 0) {
      console.log(`[mossbridge] weixin poll messages=${messageCount}`);
    }
  }

  recordWeixinPollFailureAudit(error, consecutiveFailures = 0, formattedError = "", extra = {}) {
    this.weixinIngressAuditStore?.recordPollFailure?.({
      error: formattedError || formatErrorMessage(error),
      name: normalizeText(error?.name),
      ...buildErrorDiagnosticPayload(error),
      retryDelayMs: Number.isFinite(Number(extra.retryDelayMs)) ? Number(extra.retryDelayMs) : null,
      outageStartedAt: extra.outageStartedAtMs ? new Date(extra.outageStartedAtMs).toISOString() : "",
      consecutiveFailures: Math.max(1, Number(consecutiveFailures) || 1),
    });
  }

  recordWeixinPollRecoveryAudit({ consecutiveFailures = 0, outageStartedAtMs = 0 } = {}) {
    const outageDurationMs = outageStartedAtMs ? Math.max(0, Date.now() - outageStartedAtMs) : 0;
    this.weixinIngressAuditStore?.recordPollRecovery?.({
      consecutiveFailures: Math.max(1, Number(consecutiveFailures) || 1),
      outageStartedAt: outageStartedAtMs ? new Date(outageStartedAtMs).toISOString() : "",
      outageDurationMs,
    });
    console.log(
      `[mossbridge] weixin poll recovered after ${Math.max(1, Number(consecutiveFailures) || 1)} failures (${Math.round(outageDurationMs / 1000)}s)`
    );
  }

  recordWeixinInboundAudit({ stage = "", rawMessage = null, normalized = null, error = null, includeTextPreview = true } = {}) {
    const textPreview = includeTextPreview && normalized
      ? (normalizeText(normalized.originalText) || normalizeText(normalized.text))
      : "";
    const event = this.weixinIngressAuditStore?.recordInbound?.({
      stage: normalizeText(stage) || "unknown",
      messageId: normalizeCommandArgument(String(rawMessage?.message_id ?? normalized?.messageId ?? "")),
      messageType: Number.isFinite(Number(rawMessage?.message_type)) ? Number(rawMessage.message_type) : null,
      senderId: normalizeText(normalized?.senderId) || normalizeText(rawMessage?.from_user_id),
      contextTokenPresent: Boolean(normalizeText(normalized?.contextToken) || normalizeText(rawMessage?.context_token)),
      textPreview,
      error: error instanceof Error ? error.message : normalizeText(error),
    });
    if (event && stage !== "dispatched") {
      const suffix = event.error ? ` error=${event.error}` : "";
      console.log(`[mossbridge] weixin inbound ${event.stage} message=${event.messageId || "(unknown)"}${suffix}`);
    }
  }

  recordWeixinOutboundAudit(payload = {}) {
    this.weixinIngressAuditStore?.recordOutbound?.({
      threadId: normalizeText(payload.threadId),
      turnId: normalizeText(payload.turnId),
      runKey: normalizeText(payload.runKey),
      bindingKey: normalizeText(payload.bindingKey),
      userId: normalizeText(payload.userId),
      provider: normalizeText(payload.provider),
      kind: normalizeText(payload.kind),
      status: normalizeText(payload.status),
      attempt: normalizeText(payload.attempt),
      contextTokenPresent: Boolean(payload.contextTokenPresent),
      textPreview: normalizeText(payload.textPreview),
      error: normalizeText(payload.error),
      errorName: normalizeText(payload.errorName),
      causeName: normalizeText(payload.causeName),
      causeCode: normalizeText(payload.causeCode),
      apiLabel: normalizeText(payload.apiLabel),
      apiEndpoint: normalizeText(payload.apiEndpoint),
      apiTimeoutMs: Number.isFinite(Number(payload.apiTimeoutMs)) ? Number(payload.apiTimeoutMs) : null,
      deferReason: normalizeText(payload.deferReason),
      immediateSent: Boolean(payload.immediateSent),
      deferred: Boolean(payload.deferred),
      prefixDelivered: Boolean(payload.prefixDelivered),
      prefixDeliveredAt: normalizeIsoTime(payload.prefixDeliveredAt),
      deferredReplyCount: Number.isFinite(Number(payload.deferredReplyCount)) ? Number(payload.deferredReplyCount) : null,
      contextTokenAgeMs: Number.isFinite(Number(payload.contextTokenAgeMs)) ? Number(payload.contextTokenAgeMs) : null,
    });
  }

  deferSystemReply({
    threadId = "",
    userId = "",
    text = "",
    error = null,
    kind = "plain_reply",
    dedupeKey = "",
    deferReason = "",
    immediateSent = false,
    deferred = true,
    prefixDelivered = false,
    contextTokenAgeMs = null,
  }) {
    const queued = this.deferredSystemReplyQueue.enqueue({
      id: `${normalizeCommandArgument(threadId) || "system"}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      accountId: this.activeAccountId || this.channelAdapter.resolveAccount().accountId,
      senderId: userId,
      threadId,
      text,
      kind,
      dedupeKey,
      createdAt: new Date().toISOString(),
      failedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error || ""),
      deferReason,
      immediateSent,
      deferred,
      prefixDelivered,
      contextTokenAgeMs,
    });
    this.recordControlEvent?.({
      type: "channel.reply.deferred",
      layer: CONTROL_LAYER.EXECUTIVE,
      scope: CONTROL_SCOPE.CHANNEL,
      source: "app.deferSystemReply",
      subject: threadId,
      severity: CONTROL_SEVERITY.WARN,
      reason: "send_failed_or_context_token_expired",
      outcome: "queued",
      payload: {
        senderId: userId,
        threadId,
        kind,
        lastError: queued.lastError,
      },
    });
    return queued;
  }

  recordRuntimeNotice({ text = "", threadId = "", source = "", provider = "", runtimeId = "" } = {}) {
    if (!isRuntimeCapacitySignal(text)) {
      return null;
    }
    if (!isRuntimeCapacityNotice(text)) {
      return null;
    }
    const cooldown = this.runtimeCooldownStore.setCapacityCooldown({
      runtimeId: normalizeText(runtimeId) || this.runtimeAdapter?.describe?.().id || this.config?.runtime || "runtime",
      text,
      source: normalizeText(source) || normalizeText(provider) || "runtime_notice",
      threadId,
    });
    if (cooldown) {
      this.recordControlEvent?.({
        type: "runtime.cooldown.entered",
        layer: CONTROL_LAYER.TACTICAL,
        scope: CONTROL_SCOPE.RUNTIME,
        source: "app.recordRuntimeNotice",
        subject: cooldown.runtimeId,
        severity: CONTROL_SEVERITY.WARN,
        reason: cooldown.reason,
        outcome: "cooldown_active",
        correlationId: threadId,
        payload: {
          resetAt: cooldown.resetAt,
          remainingMs: cooldown.remainingMs,
          source: cooldown.source,
          threadId: cooldown.threadId,
        },
      });
      console.warn(
        `[mossbridge] runtime cooldown active runtime=${cooldown.runtimeId} until=${cooldown.resetAt} source=${cooldown.source || "runtime_notice"}`
      );
    }
    return cooldown;
  }

  primeDeferredRepliesForSender(normalized) {
    if (!normalized?.accountId || !normalized?.senderId || !normalized?.contextToken) {
      return;
    }
    const drainResult = typeof this.deferredSystemReplyQueue.drainForSenderWithExpiry === "function"
      ? this.deferredSystemReplyQueue.drainForSenderWithExpiry(normalized.accountId, normalized.senderId, {
        systemReplyMaxAgeMs: resolveDeferredSystemReplyMaxAgeMs(this.config),
      })
      : { drained: this.deferredSystemReplyQueue.drainForSender(normalized.accountId, normalized.senderId), expired: [] };
    const pendingReplies = Array.isArray(drainResult?.drained) ? drainResult.drained : [];
    const expiredReplies = Array.isArray(drainResult?.expired) ? drainResult.expired : [];
    if (expiredReplies.length) {
      this.recordWeixinOutboundAudit({
        userId: normalized.senderId,
        provider: normalized.provider,
        kind: "deferred_reply_prefix",
        status: "expired_dropped",
        attempt: "next_inbound_prefix",
        contextTokenPresent: Boolean(normalized.contextToken),
        contextTokenAgeMs: resolveContextTokenAgeMsForAudit(this.channelAdapter, normalized.senderId),
        textPreview: "expired deferred system replies dropped",
        immediateSent: false,
        deferred: true,
        prefixDelivered: false,
        deferredReplyCount: expiredReplies.length,
        deferReason: summarizeDeferredReplyReasons(expiredReplies),
      });
      console.warn(
        `[mossbridge] dropped stale deferred system reply prefix sender=${normalized.senderId} count=${expiredReplies.length}`
      );
    }
    if (!pendingReplies.length) {
      return;
    }
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    this.streamDelivery.setDeferredReplyPrefix(bindingKey, formatDeferredSystemReplyBatch(pendingReplies));
    this.recordWeixinOutboundAudit({
      userId: normalized.senderId,
      provider: normalized.provider,
      kind: "deferred_reply_prefix",
      status: "queued_for_next_runtime_reply",
      attempt: "next_inbound_prefix",
      contextTokenPresent: Boolean(normalized.contextToken),
      contextTokenAgeMs: resolveContextTokenAgeMsForAudit(this.channelAdapter, normalized.senderId),
      textPreview: pendingReplies.map((reply) => normalizeText(reply.text)).filter(Boolean).join("\n\n"),
      immediateSent: false,
      deferred: true,
      prefixDelivered: true,
      prefixDeliveredAt: new Date().toISOString(),
      deferredReplyCount: pendingReplies.length,
      deferReason: summarizeDeferredReplyReasons(pendingReplies),
    });
    console.warn(
      `[mossbridge] queued deferred reply prefix sender=${normalized.senderId} count=${pendingReplies.length}`
    );
  }

  async handlePreparedMessage(normalized, { allowCommands }) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    this.streamDelivery.setReplyTarget(bindingKey, {
      userId: normalized.senderId,
      contextToken: normalized.contextToken,
      provider: normalized.provider,
    });

    const command = parseChannelCommand(normalized.text);
    if (allowCommands && command) {
      await this.dispatchChannelCommand(normalized, command);
      return;
    }

    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const shouldHoldAttachmentFlush = normalizedHasBatchableAttachment(normalized);
    if (shouldHoldAttachmentFlush && typeof this.beginPendingAttachmentIntake === "function") {
      this.beginPendingAttachmentIntake(bindingKey, workspaceRoot);
    }
    let prepared = null;
    try {
      prepared = await this.prepareIncomingMessageForRuntime(normalized, workspaceRoot);
    } catch (error) {
      if (shouldHoldAttachmentFlush && typeof this.endPendingAttachmentIntake === "function") {
        this.endPendingAttachmentIntake({ bindingKey, workspaceRoot });
      }
      throw error;
    }
    if (!prepared) {
      if (shouldHoldAttachmentFlush && typeof this.endPendingAttachmentIntake === "function") {
        this.endPendingAttachmentIntake({ bindingKey, workspaceRoot });
      }
      return;
    }

    if (shouldBatchAttachmentContextInbound(prepared)) {
      this.enqueuePendingAttachmentInbound({ bindingKey, workspaceRoot, prepared });
      if (shouldHoldAttachmentFlush && typeof this.endPendingAttachmentIntake === "function") {
        this.endPendingAttachmentIntake({ bindingKey, workspaceRoot });
      }
      return;
    }

    if (shouldHoldAttachmentFlush && typeof this.endPendingAttachmentIntake === "function") {
      this.endPendingAttachmentIntake({ bindingKey, workspaceRoot });
    }

    if (
      isPlainTextPreparedMessage(prepared)
      && (
        this.hasPendingAttachmentInbound(bindingKey, workspaceRoot)
        || (
          typeof this.hasPendingAttachmentIntake === "function"
          && this.hasPendingAttachmentIntake(bindingKey, workspaceRoot)
        )
        || this.currentInboundBatchMayContainAttachmentForSender(normalized.senderId)
      )
    ) {
      this.enqueuePendingAttachmentInbound({
        bindingKey,
        workspaceRoot,
        prepared,
        delayMs: INBOUND_ATTACHMENT_TEXT_BATCH_IDLE_MS,
      });
      return;
    }

    if (isLikelyAttachmentPreludePreparedMessage(prepared)) {
      this.enqueuePendingAttachmentInbound({
        bindingKey,
        workspaceRoot,
        prepared,
        delayMs: INBOUND_ATTACHMENT_PRELUDE_IDLE_MS,
      });
      return;
    }

    if (this.hasPendingAttachmentInbound(bindingKey, workspaceRoot)) {
      await this.flushPendingAttachmentInboundBatch({ bindingKey, workspaceRoot });
    }

    await this.routePreparedInbound({ bindingKey, workspaceRoot, prepared });
  }

  isTurnDispatchBlocked(bindingKey, workspaceRoot, { ignoreBoundary = false } = {}) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!ignoreBoundary && scopeKey && this.turnBoundaryScopeKeys?.has(scopeKey)) {
      return true;
    }
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    if (this.turnGateStore.isPending(bindingKey, workspaceRoot)) {
      if (isRuntimeTurnActuallyActiveForApp(this, { bindingKey, workspaceRoot, threadId })) {
        return true;
      }
      this.turnGateStore.releaseScope(bindingKey, workspaceRoot);
      console.warn(
        `[mossbridge] released stale turn gate binding=${bindingKey} workspace=${workspaceRoot} thread=${threadId || "(none)"}`
      );
    }
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    if (
      threadState?.status === "running"
      && normalizeText(this.runtimeAdapter?.describe?.().id) === "claudecode"
      && !isRuntimeTurnActuallyActiveForApp(this, { bindingKey, workspaceRoot, threadId })
    ) {
      this.recoverStaleClaudeCodeRunningState({
        bindingKey,
        workspaceRoot,
        threadId,
        threadState,
        reason: "stale_claudecode_running_state",
      });
      return false;
    }
    return threadState?.status === "running" || hasRpcId(threadState?.pendingApproval?.requestId);
  }

  recoverStaleClaudeCodeRunningState({
    bindingKey = "",
    workspaceRoot = "",
    threadId = "",
    threadState = null,
    reason = "stale_claudecode_running_state",
  } = {}) {
    const normalizedThreadId = normalizeCommandArgument(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    const activeTurnId = normalizeCommandArgument(threadState?.turnId);
    const runKey = activeTurnId ? buildRunKey(normalizedThreadId, activeTurnId) : "";
    if (runKey) {
      this.watchdogCancelledRunKeys?.add?.(runKey);
      this.streamDelivery?.disposeRunState?.(runKey);
      this.turnWritebackContextByRunKey?.delete?.(runKey);
      this.pendingOperationByRunKey?.delete?.(runKey);
    }
    this.clearRuntimeEventWatchdog(normalizedThreadId);
    this.clearRunningTurnWatchdog(normalizedThreadId, activeTurnId);
    this.pendingTurnWritebackByThreadId?.delete?.(normalizedThreadId);
    this.turnGateStore?.releaseThread?.(normalizedThreadId);
    this.turnGateStore?.releaseScope?.(bindingKey, workspaceRoot);
    const nextState = this.threadStateStore?.markStaleTurnRecovered?.(normalizedThreadId, {
      turnId: activeTurnId,
      reason,
    }) || null;
    console.warn(
      `[mossbridge] recovered stale claudecode running state binding=${bindingKey} workspace=${workspaceRoot} thread=${normalizedThreadId} turn=${activeTurnId || "(none)"} reason=${reason}`
    );
    return nextState;
  }

  isRuntimeTurnActuallyActive({ bindingKey = "", workspaceRoot = "", threadId = "" } = {}) {
    return isRuntimeTurnActuallyActiveForApp(this, { bindingKey, workspaceRoot, threadId });
  }

  async dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared }) {
    const pendingScopeKey = this.turnGateStore.begin(bindingKey, workspaceRoot);
    await this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});
    this.recordControlEvent?.({
      type: "runtime.turn.dispatch_requested",
      layer: CONTROL_LAYER.EXECUTIVE,
      scope: CONTROL_SCOPE.RUNTIME,
      source: "app.dispatchPreparedTurn",
      subject: prepared.systemRuntimeBinding ? "system_turn" : "user_turn",
      reason: prepared.systemRuntimeBinding ? "system_runtime_binding" : "wechat_inbound",
      correlationId: pendingScopeKey,
      payload: {
        bindingKey,
        workspaceRoot,
        provider: prepared.provider,
        systemRuntimeBinding: Boolean(prepared.systemRuntimeBinding),
        attachmentCount: Array.isArray(prepared.attachments) ? prepared.attachments.length : 0,
        memoryDelivery: prepared.memoryContextPacket?.delivery || null,
      },
    });

    try {
      const sessionRefresh = typeof this.maybeApplySessionRefreshRequest === "function"
        ? await this.maybeApplySessionRefreshRequest({ bindingKey, workspaceRoot, prepared })
        : null;
      const dispatchedAtMs = Date.now();
      const runtimeParams = this.runtimeAdapter.getSessionStore().getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
      const turn = await this.runtimeAdapter.sendTextTurn({
        bindingKey,
        workspaceRoot,
        text: prepared.text,
        attachments: prepared.attachments,
        model: runtimeParams.model,
        metadata: {
          workspaceId: prepared.workspaceId,
          accountId: prepared.accountId,
          senderId: prepared.runtimeBindingSenderId || prepared.senderId,
          replySenderId: prepared.senderId,
          systemRuntimeBinding: Boolean(prepared.systemRuntimeBinding),
          systemToolProfile: prepared.systemToolProfile || prepared.systemTurn?.metadata?.systemToolProfile || "",
          skipOpeningInstructions: Boolean(prepared.systemRuntimeBinding),
        },
      });
      this.runtimeContextStore?.setActiveContext?.({
        workspaceRoot,
        runtimeId: this.runtimeAdapter.describe().id,
        threadId: turn.threadId,
        bindingKey,
        accountId: prepared.accountId,
        senderId: prepared.senderId,
      });
      this.turnGateStore.attachThread(pendingScopeKey, turn.threadId);
      const replyTarget = {
        userId: prepared.senderId,
        contextToken: prepared.contextToken,
        provider: prepared.provider,
      };
      if (turn.turnId) {
        this.streamDelivery.bindReplyTargetForTurn({
          threadId: turn.threadId,
          turnId: turn.turnId,
          target: replyTarget,
        });
      } else {
        this.streamDelivery.queueReplyTargetForThread(turn.threadId, replyTarget);
      }
      this.rememberTurnWritebackContext({ turn, prepared, bindingKey, workspaceRoot, dispatchedAtMs });
      this.markMemoryMetabolismAttemptDispatched?.(prepared.systemTurn, {
        threadId: turn.threadId,
        turnId: turn.turnId,
      });
      this.recordControlEvent?.({
        type: "runtime.turn.dispatch_accepted",
        layer: CONTROL_LAYER.EXECUTIVE,
        scope: CONTROL_SCOPE.RUNTIME,
        source: "app.dispatchPreparedTurn",
        subject: turn.threadId,
        reason: prepared.systemRuntimeBinding ? "system_turn_sent_to_runtime" : "user_turn_sent_to_runtime",
        outcome: "accepted",
        correlationId: buildRunKey(turn.threadId, turn.turnId),
        payload: {
          bindingKey,
          workspaceRoot,
          threadId: turn.threadId,
          turnId: turn.turnId,
          openingTurn: Boolean(turn?.openingTurn),
          provider: prepared.provider,
          systemRuntimeBinding: Boolean(prepared.systemRuntimeBinding),
        },
      });
      if (sessionRefresh?.id) {
        this.sessionRefreshRequests?.markCompleted?.(sessionRefresh.id, {
          newThreadId: turn.threadId,
          openingTurn: Boolean(turn?.openingTurn),
        });
      }
      this.scheduleRuntimeEventWatchdog({
        bindingKey,
        workspaceRoot,
        normalized: prepared,
        threadId: turn.threadId,
        openingTurn: Boolean(turn?.openingTurn),
      });
      this.scheduleRunningTurnWatchdog?.({
        bindingKey,
        workspaceRoot,
        normalized: prepared,
        threadId: turn.threadId,
        turnId: turn.turnId,
      });
      return true;
    } catch (error) {
      this.turnGateStore.releaseScope(bindingKey, workspaceRoot);
      const messageText = error instanceof Error ? error.message : String(error || "unknown error");
      this.recordControlEvent?.({
        type: "runtime.turn.dispatch_failed",
        layer: CONTROL_LAYER.EXECUTIVE,
        scope: CONTROL_SCOPE.RUNTIME,
        source: "app.dispatchPreparedTurn",
        subject: prepared.systemRuntimeBinding ? "system_turn" : "user_turn",
        severity: CONTROL_SEVERITY.ERROR,
        reason: "runtime_pre_dispatch_failure",
        outcome: "failed",
        correlationId: pendingScopeKey,
        payload: {
          bindingKey,
          workspaceRoot,
          provider: prepared.provider,
          systemRuntimeBinding: Boolean(prepared.systemRuntimeBinding),
          error: messageText,
        },
      });
      await this.channelAdapter.sendText({
        userId: prepared.senderId,
        text: formatBridgeNotice("request_failed", [
          "source: bridge",
          "status: request_failed_before_runtime",
          `error: ${messageText}`,
        ]),
        contextToken: prepared.contextToken,
      }).catch(() => {});
      return false;
    }
  }

  async maybeApplySessionRefreshRequest({ bindingKey = "", workspaceRoot = "", prepared = null } = {}) {
    if (!this.sessionRefreshRequests || normalizeText(prepared?.provider) === "system") {
      return null;
    }
    const runtimeId = normalizeText(this.runtimeAdapter?.describe?.().id) || normalizeText(this.config.runtime) || "codex";
    const request = this.sessionRefreshRequests.getPendingRequest({
      bindingKey,
      workspaceRoot,
      runtimeId,
    });
    if (!request) {
      return null;
    }

    const sessionStore = this.runtimeAdapter.getSessionStore();
    const currentThreadId = normalizeCommandArgument(
      sessionStore.getThreadIdForWorkspace?.(bindingKey, workspaceRoot) || "",
    );
    const requestedOldThreadId = normalizeCommandArgument(request.oldThreadId);
    if (requestedOldThreadId && currentThreadId && requestedOldThreadId !== currentThreadId) {
      this.sessionRefreshRequests.markSkipped(request.id, "current_thread_changed", {
        currentThreadId,
      });
      console.warn(
        `[mossbridge] session refresh skipped id=${request.id} reason=current_thread_changed requested=${requestedOldThreadId} current=${currentThreadId}`
      );
      return null;
    }

    const preAppliedAt = normalizeText(request.preAppliedAt);
    const shouldStartFreshDraft = !preAppliedAt || Boolean(currentThreadId);
    if (shouldStartFreshDraft && typeof this.runtimeAdapter.startFreshThreadDraft === "function") {
      await this.runtimeAdapter.startFreshThreadDraft({
        bindingKey,
        workspaceRoot,
        oldThreadId: currentThreadId || requestedOldThreadId,
        reason: request.reason || "manual_maintenance",
      });
    }
    sessionStore.clearPendingThreadIdForWorkspace?.(bindingKey, workspaceRoot);
    sessionStore.clearThreadIdForWorkspace?.(bindingKey, workspaceRoot);
    const appliedOldThreadId = currentThreadId
      || normalizeCommandArgument(request.preAppliedOldThreadId)
      || requestedOldThreadId;
    const applied = this.sessionRefreshRequests.markApplied(request.id, {
      oldThreadId: appliedOldThreadId,
    }) || request;
    console.log(
      `[mossbridge] session refresh applied id=${request.id} runtime=${runtimeId} workspace=${workspaceRoot} oldThread=${appliedOldThreadId || "(none)"} reason=${request.reason || "manual_maintenance"}`
    );
    return applied;
  }

  async routePreparedInbound({ bindingKey, workspaceRoot, prepared }) {
    const runtimeId = this.runtimeAdapter?.describe?.().id || this.config?.runtime || "runtime";
    const cooldown = this.runtimeCooldownStore?.getActiveCooldown?.(runtimeId);
    if (cooldown) {
      this.recordControlEvent?.({
        type: "runtime.cooldown.blocked_turn",
        layer: CONTROL_LAYER.TACTICAL,
        scope: CONTROL_SCOPE.RUNTIME,
        source: "app.routePreparedInbound",
        subject: runtimeId,
        severity: CONTROL_SEVERITY.WARN,
        reason: cooldown.reason || "runtime_cooldown",
        outcome: "blocked",
        payload: {
          resetAt: cooldown.resetAt,
          remainingMs: cooldown.remainingMs,
          provider: prepared.provider,
          systemRuntimeBinding: Boolean(prepared.systemRuntimeBinding),
        },
      });
      await this.channelAdapter.sendText({
        userId: prepared.senderId,
        text: buildRuntimeCapacityNotice(cooldown.messagePreview || "", {
          runtimeId,
        }),
        contextToken: prepared.contextToken,
      }).catch(() => {});
      return false;
    }

    if (this.isTurnDispatchBlocked(bindingKey, workspaceRoot)) {
      this.bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared });
      return false;
    }
    return this.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
  }

  hasPendingAttachmentInbound(bindingKey, workspaceRoot) {
    return this.pendingAttachmentInboundByScope.has(buildScopeKey(bindingKey, workspaceRoot));
  }

  hasPendingAttachmentIntake(bindingKey, workspaceRoot) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey) {
      return false;
    }
    if (!(this.pendingAttachmentIntakeByScope instanceof Map)) {
      this.pendingAttachmentIntakeByScope = new Map();
    }
    return Number(this.pendingAttachmentIntakeByScope?.get(scopeKey) || 0) > 0;
  }

  beginPendingAttachmentIntake(bindingKey, workspaceRoot) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey) {
      return;
    }
    if (!(this.pendingAttachmentIntakeByScope instanceof Map)) {
      this.pendingAttachmentIntakeByScope = new Map();
    }
    const nextCount = Number(this.pendingAttachmentIntakeByScope?.get(scopeKey) || 0) + 1;
    this.pendingAttachmentIntakeByScope.set(scopeKey, nextCount);
    if (this.pendingAttachmentInboundByScope.has(scopeKey)) {
      this.clearPendingAttachmentInboundTimer(scopeKey);
      this.deferredAttachmentInboundFlushScopeKeys.add(scopeKey);
    }
  }

  endPendingAttachmentIntake({ bindingKey = "", workspaceRoot = "" } = {}) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey) {
      return;
    }
    if (!(this.pendingAttachmentIntakeByScope instanceof Map)) {
      this.pendingAttachmentIntakeByScope = new Map();
    }
    const nextCount = Math.max(0, Number(this.pendingAttachmentIntakeByScope?.get(scopeKey) || 0) - 1);
    if (nextCount > 0) {
      this.pendingAttachmentIntakeByScope.set(scopeKey, nextCount);
      return;
    }
    this.pendingAttachmentIntakeByScope.delete(scopeKey);
    if (!this.pendingAttachmentInboundByScope.has(scopeKey)) {
      return;
    }
    const shouldDeferFlush = typeof this.shouldDeferAttachmentInboundFlushUntilPollBatchEnds === "function"
      ? this.shouldDeferAttachmentInboundFlushUntilPollBatchEnds()
      : Number(this.inboundUpdateBatchDepth) > 0;
    if (shouldDeferFlush) {
      this.clearPendingAttachmentInboundTimer(scopeKey);
      if (!(this.deferredAttachmentInboundFlushScopeKeys instanceof Set)) {
        this.deferredAttachmentInboundFlushScopeKeys = new Set();
      }
      this.deferredAttachmentInboundFlushScopeKeys.add(scopeKey);
      return;
    }
    if (this.deferredAttachmentInboundFlushScopeKeys instanceof Set) {
      this.deferredAttachmentInboundFlushScopeKeys.delete(scopeKey);
    }
    this.schedulePendingAttachmentInboundFlush(scopeKey, bindingKey, workspaceRoot, INBOUND_ATTACHMENT_BATCH_IDLE_MS);
  }

  beginInboundUpdateBatch(messageCount = 0, messages = []) {
    if (Number(messageCount) <= 1) {
      return;
    }
    this.inboundUpdateBatchDepth = Math.max(0, Number(this.inboundUpdateBatchDepth) || 0) + 1;
    this.inboundUpdateBatchAttachmentSenders = collectBatchAttachmentSenders(messages);
  }

  endInboundUpdateBatch() {
    if (!(Number(this.inboundUpdateBatchDepth) > 0)) {
      return;
    }
    this.inboundUpdateBatchDepth = Math.max(0, Number(this.inboundUpdateBatchDepth) - 1);
    if (this.inboundUpdateBatchDepth === 0) {
      this.scheduleDeferredAttachmentInboundFlushes();
      this.inboundUpdateBatchAttachmentSenders = new Set();
    }
  }

  shouldDeferAttachmentInboundFlushUntilPollBatchEnds() {
    return Number(this.inboundUpdateBatchDepth) > 0;
  }

  currentInboundBatchMayContainAttachmentForSender(senderId = "") {
    if (!(Number(this.inboundUpdateBatchDepth) > 0)) {
      return false;
    }
    const normalizedSenderId = normalizeText(senderId);
    return Boolean(
      normalizedSenderId
      && this.inboundUpdateBatchAttachmentSenders instanceof Set
      && this.inboundUpdateBatchAttachmentSenders.has(normalizedSenderId)
    );
  }

  rememberDeferredAttachmentInboundFlush(scopeKey) {
    if (!scopeKey) {
      return;
    }
    if (!(this.deferredAttachmentInboundFlushScopeKeys instanceof Set)) {
      this.deferredAttachmentInboundFlushScopeKeys = new Set();
    }
    this.clearPendingAttachmentInboundTimer(scopeKey);
    this.deferredAttachmentInboundFlushScopeKeys.add(scopeKey);
  }

  scheduleDeferredAttachmentInboundFlushes() {
    const scopeKeys = this.deferredAttachmentInboundFlushScopeKeys instanceof Set
      ? Array.from(this.deferredAttachmentInboundFlushScopeKeys)
      : [];
    if (this.deferredAttachmentInboundFlushScopeKeys instanceof Set) {
      this.deferredAttachmentInboundFlushScopeKeys.clear();
    }
    for (const scopeKey of scopeKeys) {
      const draft = this.pendingAttachmentInboundByScope.get(scopeKey);
      if (!draft?.bindingKey || !draft?.workspaceRoot) {
        continue;
      }
      this.schedulePendingAttachmentInboundFlush(scopeKey, draft.bindingKey, draft.workspaceRoot);
    }
  }

  enqueuePendingAttachmentInbound({ bindingKey, workspaceRoot, prepared, delayMs = INBOUND_ATTACHMENT_BATCH_IDLE_MS }) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey || !prepared) {
      return;
    }

    const current = this.pendingAttachmentInboundByScope.get(scopeKey) || {
      bindingKey,
      workspaceRoot,
      messages: [],
      timer: null,
    };
    current.messages.push(clonePreparedInboundMessage(prepared));
    this.pendingAttachmentInboundByScope.set(scopeKey, current);
    void this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});
    const shouldDeferFlush = typeof this.shouldDeferAttachmentInboundFlushUntilPollBatchEnds === "function"
      ? this.shouldDeferAttachmentInboundFlushUntilPollBatchEnds()
      : Number(this.inboundUpdateBatchDepth) > 0;
    if (shouldDeferFlush) {
      if (typeof this.rememberDeferredAttachmentInboundFlush === "function") {
        this.rememberDeferredAttachmentInboundFlush(scopeKey);
      } else {
        this.clearPendingAttachmentInboundTimer(scopeKey);
      }
      return;
    }
    this.schedulePendingAttachmentInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs);
  }

  schedulePendingAttachmentInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs = INBOUND_ATTACHMENT_BATCH_IDLE_MS) {
    const draft = this.pendingAttachmentInboundByScope.get(scopeKey);
    if (!draft) {
      return;
    }
    if (Number(this.pendingAttachmentIntakeByScope?.get(scopeKey) || 0) > 0) {
      this.clearPendingAttachmentInboundTimer(scopeKey);
      if (this.deferredAttachmentInboundFlushScopeKeys instanceof Set) {
        this.deferredAttachmentInboundFlushScopeKeys.add(scopeKey);
      }
      return;
    }
    if (draft.timer) {
      clearTimeout(draft.timer);
    }
    draft.timer = setTimeout(() => {
      void this.flushPendingAttachmentInboundBatch({ bindingKey, workspaceRoot }).catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`[mossbridge] attachment inbound debounce flush failed ${message}`);
      });
    }, Math.max(0, Number(delayMs) || 0));
    this.pendingAttachmentInboundByScope.set(scopeKey, draft);
  }

  clearPendingAttachmentInboundTimer(scopeKey) {
    const draft = this.pendingAttachmentInboundByScope.get(scopeKey);
    if (!draft?.timer) {
      return;
    }
    clearTimeout(draft.timer);
    draft.timer = null;
  }

  clearPendingAttachmentInboundTimers() {
    for (const [scopeKey] of this.pendingAttachmentInboundByScope.entries()) {
      this.clearPendingAttachmentInboundTimer(scopeKey);
    }
  }

  async flushPendingAttachmentInboundBatch({ bindingKey = "", workspaceRoot = "", trailingPrepared = null } = {}) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    const draft = scopeKey ? this.pendingAttachmentInboundByScope.get(scopeKey) || null : null;
    if (!draft?.bindingKey || !draft?.workspaceRoot) {
      if (scopeKey) {
        this.pendingAttachmentInboundByScope.delete(scopeKey);
      }
      return false;
    }

    this.clearPendingAttachmentInboundTimer(scopeKey);
    this.pendingAttachmentInboundByScope.delete(scopeKey);

    const queued = Array.isArray(draft.messages)
      ? draft.messages
        .filter((message) => message && typeof message === "object")
        .slice()
        .sort(comparePendingInboundMessages)
      : [];
    if (!queued.length) {
      return false;
    }

    const { batchMessages, remainingMessages } = takeAttachmentContextBatchMessages(queued, MAX_INBOUND_ATTACHMENT_BATCH);
    if (!batchMessages.length) {
      if (remainingMessages.length && this.pendingInboundByScope instanceof Map && typeof this.flushPendingInboundMessages === "function") {
        const current = this.pendingInboundByScope.get(scopeKey) || {
          bindingKey: draft.bindingKey,
          workspaceRoot: draft.workspaceRoot,
          messages: [],
        };
        current.messages.push(...remainingMessages.map((message) => clonePreparedInboundMessage(message)));
        this.pendingInboundByScope.set(scopeKey, current);
        await this.flushPendingInboundMessages({
          bindingKey: draft.bindingKey,
          workspaceRoot: draft.workspaceRoot,
        });
      }
      return false;
    }

    if (remainingMessages.length) {
      this.pendingAttachmentInboundByScope.set(scopeKey, {
        bindingKey: draft.bindingKey,
        workspaceRoot: draft.workspaceRoot,
        messages: remainingMessages,
        timer: null,
      });
    }

    const prepared = buildMergedInboundPrepared({
      bindingKey: draft.bindingKey,
      workspaceRoot: draft.workspaceRoot,
      messages: batchMessages,
      trailingPrepared,
      config: this.config,
      runtimeId: this.runtimeAdapter?.describe?.().id || "",
    });
    if (typeof this.attachMemoryContextToPreparedText === "function") {
      const memoryContext = await this.attachMemoryContextToPreparedText(
        prepared,
        prepared.runtimeText || prepared.text,
        prepared.workspaceRoot || draft.workspaceRoot,
      );
      prepared.text = memoryContext.text;
      prepared.memoryContextPacket = memoryContext.packet;
    }
    await this.routePreparedInbound({
      bindingKey: draft.bindingKey,
      workspaceRoot: draft.workspaceRoot,
      prepared,
    });

    if (remainingMessages.length) {
      await this.flushPendingAttachmentInboundBatch({
        bindingKey: draft.bindingKey,
        workspaceRoot: draft.workspaceRoot,
      });
    }

    return true;
  }

  bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared }) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey || !prepared) {
      return;
    }

    const current = this.pendingInboundByScope.get(scopeKey) || {
      bindingKey,
      workspaceRoot,
      messages: [],
    };
    current.messages.push({
      workspaceId: prepared.workspaceId,
      accountId: prepared.accountId,
      senderId: prepared.senderId,
      messageId: prepared.messageId,
      contextToken: prepared.contextToken,
      provider: prepared.provider,
      originalText: prepared.originalText,
      runtimeText: prepared.runtimeText || prepared.text,
      text: prepared.runtimeText || prepared.text,
      receivedAt: prepared.receivedAt,
      attachments: prepared.attachments || [],
      attachmentFailures: prepared.attachmentFailures || [],
    });
    this.pendingInboundByScope.set(scopeKey, current);
    this.recordControlEvent?.({
      type: "channel.inbound.buffered",
      layer: CONTROL_LAYER.TACTICAL,
      scope: CONTROL_SCOPE.CHANNEL,
      source: "app.bufferPendingInboundMessage",
      subject: prepared.senderId,
      reason: "turn_dispatch_blocked",
      outcome: "buffered",
      correlationId: scopeKey,
      payload: {
        bindingKey,
        workspaceRoot,
        provider: prepared.provider,
        messageCount: current.messages.length,
        attachmentCount: Array.isArray(prepared.attachments) ? prepared.attachments.length : 0,
      },
    });
    void this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});
  }

  hasPendingInboundMessage(bindingKey, workspaceRoot) {
    return this.pendingInboundByScope.has(buildScopeKey(bindingKey, workspaceRoot));
  }

  async flushPendingInboundMessages({ bindingKey = "", workspaceRoot = "", ignoreBoundary = false } = {}) {
    const targetScopeKey = buildScopeKey(bindingKey, workspaceRoot);
    const scopeEntries = targetScopeKey
      ? [[targetScopeKey, this.pendingInboundByScope.get(targetScopeKey) || null]]
      : [...this.pendingInboundByScope.entries()];

    for (const [scopeKey, draft] of scopeEntries) {
      if (!draft?.bindingKey || !draft?.workspaceRoot) {
        this.pendingInboundByScope.delete(scopeKey);
        continue;
      }
      if (this.isTurnDispatchBlocked(draft.bindingKey, draft.workspaceRoot, { ignoreBoundary })) {
        continue;
      }
      const merged = mergePendingInboundDraft(draft);
      this.pendingInboundByScope.delete(scopeKey);
      const preparedForDispatch = {
        workspaceId: merged.workspaceId,
        accountId: merged.accountId,
        senderId: merged.senderId,
        contextToken: merged.contextToken,
        provider: merged.provider,
        originalText: merged.originalText,
        runtimeText: merged.runtimeText || merged.text,
        text: merged.text,
        receivedAt: merged.receivedAt,
        attachments: merged.attachments || [],
        attachmentFailures: merged.attachmentFailures || [],
        memoryContextPacket: merged.memoryContextPacket || null,
      };
      if (typeof this.attachMemoryContextToPreparedText === "function") {
        const memoryContext = await this.attachMemoryContextToPreparedText(
          preparedForDispatch,
          preparedForDispatch.runtimeText || preparedForDispatch.text,
          merged.workspaceRoot,
        );
        preparedForDispatch.text = memoryContext.text;
        preparedForDispatch.memoryContextPacket = memoryContext.packet;
      }
      const dispatched = await this.dispatchPreparedTurn({
        bindingKey: merged.bindingKey,
        workspaceRoot: merged.workspaceRoot,
        prepared: preparedForDispatch,
      });
      if (!dispatched) {
        this.pendingInboundByScope.set(scopeKey, draft);
      }
    }
  }

  scheduleRuntimeEventWatchdog({ bindingKey, workspaceRoot, normalized, threadId = "", openingTurn = false }) {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const candidateThreadId = normalizeCommandArgument(threadId)
      || sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const normalizedThreadId = normalizeCommandArgument(candidateThreadId);
    if (!normalizedThreadId) {
      return;
    }

    const runtimeName = this.runtimeAdapter.describe().id || "runtime";
    const isCodex = runtimeName === "codex";
    const isClaudeCode = runtimeName === "claudecode";
    const sharedCommands = buildSharedRuntimeCommands(runtimeName);
    const suppressVisibleStatus = shouldSuppressVisibleRuntimeStatus(normalized);
    const suppressNotice = suppressVisibleStatus || (openingTurn && isClaudeCode);
    const noticeTimeoutMs = suppressNotice
      ? 0
      : isClaudeCode
        ? CLAUDECODE_FIRST_RUNTIME_EVENT_NOTICE_TIMEOUT_MS
        : FIRST_RUNTIME_EVENT_NOTICE_TIMEOUT_MS;
    const failureTimeoutMs = resolveFirstRuntimeEventFailureTimeoutMs({
      isClaudeCode,
      openingTurn,
    });

    this.clearRuntimeEventWatchdog(normalizedThreadId);
    const noticeTimer = noticeTimeoutMs > 0
      ? setTimeout(async () => {
        const watchdog = this.pendingRuntimeEventWatchdogs.get(normalizedThreadId);
        if (!watchdog) {
          return;
        }
        watchdog.noticeSent = true;
        const noticeLines = [
          "source: bridge",
          `runtime: ${formatRuntimeLabel(runtimeName)}`,
          "status: waiting_first_event",
          isCodex
            ? "detail: shared thread has not emitted a runtime event"
            : "detail: runtime has not emitted a runtime event",
          "action: wait",
          `workspace: ${workspaceRoot}`,
          `thread: ${normalizedThreadId}`,
        ];
        this.recordControlEvent?.({
          type: "runtime.first_event.waiting_notice",
          layer: CONTROL_LAYER.OBSERVATION,
          scope: CONTROL_SCOPE.RUNTIME,
          source: "app.scheduleRuntimeEventWatchdog",
          subject: normalizedThreadId,
          severity: CONTROL_SEVERITY.WARN,
          reason: "first_runtime_event_delayed",
          outcome: "bridge_notice_sent",
          correlationId: normalizedThreadId,
          payload: {
            runtimeName,
            workspaceRoot,
            openingTurn,
            noticeTimeoutMs,
          },
        });
        await this.channelAdapter.sendText({
          userId: normalized.senderId,
          contextToken: normalized.contextToken,
          preserveBlock: true,
          text: formatBridgeNotice("runtime_waiting_first_event", noticeLines),
        }).catch(() => {});
      }, noticeTimeoutMs)
      : null;
    const failureTimer = setTimeout(async () => {
      this.pendingRuntimeEventWatchdogs.delete(normalizedThreadId);
      await this.channelAdapter.sendTyping({
        userId: normalized.senderId,
        status: 0,
        contextToken: normalized.contextToken,
      }).catch(() => {});
      if (suppressVisibleStatus) {
        const triggerKind = describeSystemTriggerKind(normalized) || "system";
        console.warn(
          `[mossbridge] suppressed background runtime first-event failure trigger=${triggerKind} thread=${normalizedThreadId}`
        );
        if (typeof this.recordBackgroundRuntimeFirstEventFailure === "function") {
          this.recordBackgroundRuntimeFirstEventFailure({
            trigger: triggerKind,
            threadId: normalizedThreadId,
            bindingKey,
            workspaceRoot,
          });
        }
        sessionStore.clearPendingThreadIdForWorkspace?.(bindingKey, workspaceRoot);
        sessionStore.clearThreadIdForWorkspace?.(bindingKey, workspaceRoot);
        this.pendingTurnWritebackByThreadId?.delete?.(normalizedThreadId);
        this.recordControlEvent?.({
          type: "runtime.first_event.timeout",
          layer: CONTROL_LAYER.EXECUTIVE,
          scope: CONTROL_SCOPE.RUNTIME,
          source: "app.scheduleRuntimeEventWatchdog",
          subject: normalizedThreadId,
          severity: CONTROL_SEVERITY.WARN,
          reason: "background_first_runtime_event_timeout",
          outcome: "silent_recovery_requested",
          correlationId: normalizedThreadId,
          payload: {
            runtimeName,
            workspaceRoot,
            openingTurn,
            failureTimeoutMs,
            triggerKind,
          },
        });
        if (typeof this.runtimeAdapter.cancelTurn === "function") {
          await this.runtimeAdapter.cancelTurn({
            threadId: normalizedThreadId,
            workspaceRoot,
            bindingKey,
          }).catch((error) => {
            console.error(`[mossbridge] background first-event recovery failed thread=${normalizedThreadId}: ${error.message}`);
          });
        }
        this.turnGateStore.releaseThread?.(normalizedThreadId);
        if (typeof this.flushPendingInboundMessages === "function") {
          await this.flushPendingInboundMessages({ bindingKey, workspaceRoot, ignoreBoundary: true }).catch(() => {});
        }
        return;
      }
      const failureLines = [
        "source: bridge",
        `runtime: ${formatRuntimeLabel(runtimeName)}`,
        "status: first_event_timeout",
        openingTurn
          ? "detail: opening turn did not start"
          : "detail: runtime process did not emit a first event",
        `workspace: ${workspaceRoot}`,
        `thread: ${normalizedThreadId}`,
        `check_1: ${sharedCommands.status}`,
        `check_2: ${sharedCommands.start}`,
        `check_3: ${sharedCommands.open}`,
      ];
      this.recordControlEvent?.({
        type: "runtime.first_event.timeout",
        layer: CONTROL_LAYER.EXECUTIVE,
        scope: CONTROL_SCOPE.RUNTIME,
        source: "app.scheduleRuntimeEventWatchdog",
        subject: normalizedThreadId,
        severity: CONTROL_SEVERITY.ERROR,
        reason: "first_runtime_event_timeout",
        outcome: "bridge_notice_sent",
        correlationId: normalizedThreadId,
        payload: {
          runtimeName,
          workspaceRoot,
          openingTurn,
          failureTimeoutMs,
        },
      });
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        preserveBlock: true,
        text: formatBridgeNotice("runtime_first_event_timeout", failureLines),
      }).catch(() => {});
    }, failureTimeoutMs);
    this.pendingRuntimeEventWatchdogs.set(normalizedThreadId, {
      noticeTimer,
      failureTimer,
      noticeSent: false,
    });
  }

  clearRuntimeEventWatchdog(threadId) {
    const normalizedThreadId = normalizeCommandArgument(threadId);
    if (!normalizedThreadId) {
      return;
    }
    const watchdog = this.pendingRuntimeEventWatchdogs.get(normalizedThreadId);
    if (!watchdog) {
      return;
    }
    clearTimeout(watchdog.noticeTimer);
    clearTimeout(watchdog.failureTimer);
    this.pendingRuntimeEventWatchdogs.delete(normalizedThreadId);
  }

  recordRuntimeContextUsage(event) {
    if (event?.type !== "runtime.context.updated") {
      return;
    }
    const payload = event.payload || {};
    const runtimeId = normalizeText(payload.runtimeId) || this.runtimeAdapter.describe().id || "";
    const threadId = normalizeCommandArgument(payload.threadId);
    const linked = threadId
      ? this.runtimeAdapter.getSessionStore().findBindingForThreadId(threadId)
      : null;
    const usage = buildRuntimeContextUsageSnapshot({
      payload,
      runtimeId,
      linked,
      config: this.config,
    });
    this.runtimeContextUsageStore?.recordContext?.(usage);
    const sessionRefresh = this.maybeQueueAutoSessionRefreshForPressure?.({ usage, linked });
    if (sessionRefresh?.id) {
      return;
    }
    const decision = evaluateClaudeAutoCompact(usage, this.config);
    if (!decision.shouldCompact || !threadId) {
      return;
    }
    const lastRequestedAt = Number(this.lastAutoCompactAtByThreadId.get(threadId)) || 0;
    const minIntervalMs = Math.max(60_000, Number(this.config.claudeAutoCompactMinIntervalMs) || 0);
    if (lastRequestedAt && Date.now() - lastRequestedAt < minIntervalMs) {
      return;
    }
    this.pendingAutoCompactByThreadId.set(threadId, {
      ...decision,
      threadId,
      runtimeId,
      workspaceRoot: linked?.workspaceRoot || "",
      bindingKey: linked?.bindingKey || "",
    });
  }

  maybeQueueAutoSessionRefreshForPressure({ usage = {}, linked = null } = {}) {
    const decision = evaluateSessionAutoRefresh(usage, this.config);
    const threadId = normalizeCommandArgument(usage.threadId);
    if (!decision.shouldRefresh || !threadId || !linked?.bindingKey || !linked?.workspaceRoot || !this.sessionRefreshRequests) {
      return null;
    }
    const runtimeId = normalizeText(usage.runtimeId) || normalizeText(this.runtimeAdapter?.describe?.().id) || "codex";
    const sessionStore = this.runtimeAdapter?.getSessionStore?.();
    const binding = sessionStore?.getBinding?.(linked.bindingKey) || {};
    if (binding?.systemRuntimeBinding) {
      return null;
    }
    const existing = this.sessionRefreshRequests.getPendingRequest({
      bindingKey: linked.bindingKey,
      workspaceRoot: linked.workspaceRoot,
      runtimeId,
    });
    if (existing) {
      return existing;
    }
    const scopeKey = [runtimeId, linked.bindingKey, linked.workspaceRoot].join("::");
    const lastRequestedAt = Number(this.lastAutoSessionRefreshAtByScope?.get(scopeKey)) || 0;
    const minIntervalMs = Math.max(
      60_000,
      Number(this.config.sessionRefreshMinIntervalMs) || DEFAULT_SESSION_REFRESH_MIN_INTERVAL_MS,
    );
    if (lastRequestedAt && Date.now() - lastRequestedAt < minIntervalMs) {
      return null;
    }
    const request = this.sessionRefreshRequests.requestRefresh({
      bindingKey: linked.bindingKey,
      workspaceRoot: linked.workspaceRoot,
      runtimeId,
      oldThreadId: threadId,
      reason: decision.reason,
      requestedBy: "auto_context_pressure",
    });
    this.lastAutoSessionRefreshAtByScope?.set(scopeKey, Date.now());
    this.recordControlEvent?.({
      type: "runtime.context.session_refresh_queued",
      layer: CONTROL_LAYER.TACTICAL,
      scope: CONTROL_SCOPE.RUNTIME,
      source: "app.maybeQueueAutoSessionRefreshForPressure",
      subject: threadId,
      reason: decision.reason,
      outcome: "queued",
      correlationId: request.id,
      payload: {
        bindingKey: linked.bindingKey,
        workspaceRoot: linked.workspaceRoot,
        runtimeId,
        currentTokens: decision.currentTokens,
        contextWindow: decision.contextWindow,
        refreshThresholdTokens: decision.refreshThresholdTokens,
        refreshThresholdPercent: decision.refreshThresholdPercent,
      },
    });
    console.log(
      `[mossbridge] session refresh queued thread=${threadId} current=${formatCompactNumber(decision.currentTokens)} threshold=${formatCompactNumber(decision.refreshThresholdTokens)}`
    );
    return request;
  }

  async maybePreApplyAutoSessionRefreshAfterTurn({ event, linked, pendingOperation } = {}) {
    if (event?.type !== "runtime.turn.completed") {
      return null;
    }
    if (pendingOperation?.kind === "compact") {
      return null;
    }
    if (!linked?.bindingKey || !linked?.workspaceRoot || !this.sessionRefreshRequests) {
      return null;
    }
    const runtimeId = normalizeText(this.runtimeAdapter?.describe?.().id) || normalizeText(this.config?.runtime) || "codex";
    const request = this.sessionRefreshRequests.getPendingRequest({
      bindingKey: linked.bindingKey,
      workspaceRoot: linked.workspaceRoot,
      runtimeId,
    });
    if (!request || !isAutoSessionRefreshRequest(request) || normalizeText(request.preAppliedAt)) {
      return null;
    }
    const eventThreadId = normalizeCommandArgument(event?.payload?.threadId);
    const requestedOldThreadId = normalizeCommandArgument(request.oldThreadId);
    if (requestedOldThreadId && eventThreadId && requestedOldThreadId !== eventThreadId) {
      return null;
    }

    const sessionStore = this.runtimeAdapter.getSessionStore();
    const currentThreadId = normalizeCommandArgument(
      sessionStore.getThreadIdForWorkspace?.(linked.bindingKey, linked.workspaceRoot) || "",
    );
    if (requestedOldThreadId && currentThreadId && requestedOldThreadId !== currentThreadId) {
      this.sessionRefreshRequests.markSkipped(request.id, "current_thread_changed_before_preapply", {
        currentThreadId,
      });
      console.warn(
        `[mossbridge] auto session refresh preapply skipped id=${request.id} reason=current_thread_changed requested=${requestedOldThreadId} current=${currentThreadId}`
      );
      return null;
    }

    const oldThreadId = currentThreadId || requestedOldThreadId || eventThreadId;
    if (typeof this.runtimeAdapter.startFreshThreadDraft === "function") {
      await this.runtimeAdapter.startFreshThreadDraft({
        bindingKey: linked.bindingKey,
        workspaceRoot: linked.workspaceRoot,
        oldThreadId,
        reason: request.reason || "context_pressure_session_refresh",
      });
    }
    sessionStore.clearPendingThreadIdForWorkspace?.(linked.bindingKey, linked.workspaceRoot);
    sessionStore.clearThreadIdForWorkspace?.(linked.bindingKey, linked.workspaceRoot);
    const updated = this.sessionRefreshRequests.updateRequest?.(request.id, {
      preAppliedAt: new Date().toISOString(),
      preAppliedOldThreadId: oldThreadId,
      preAppliedBy: "runtime_turn_completed",
    }) || request;
    this.recordControlEvent?.({
      type: "runtime.context.session_refresh_preapplied",
      layer: CONTROL_LAYER.EXECUTIVE,
      scope: CONTROL_SCOPE.RUNTIME,
      source: "app.maybePreApplyAutoSessionRefreshAfterTurn",
      subject: oldThreadId,
      reason: request.reason || "context_pressure_session_refresh",
      outcome: "preapplied",
      correlationId: request.id,
      payload: {
        bindingKey: linked.bindingKey,
        workspaceRoot: linked.workspaceRoot,
        runtimeId,
        oldThreadId,
      },
    });
    console.log(
      `[mossbridge] auto session refresh preapplied id=${request.id} runtime=${runtimeId} workspace=${linked.workspaceRoot} oldThread=${oldThreadId || "(none)"} reason=${request.reason || "context_pressure_session_refresh"}`
    );
    return updated;
  }

  async maybeAutoCompactAfterTurn({ event, linked, pendingOperation }) {
    if (this.runtimeAdapter.describe().id !== "claudecode") {
      return;
    }
    if (event?.type !== "runtime.turn.completed") {
      return;
    }
    if (pendingOperation?.kind === "compact") {
      return;
    }
    const threadId = normalizeCommandArgument(event?.payload?.threadId);
    if (!threadId) {
      return;
    }
    const pending = this.pendingAutoCompactByThreadId.get(threadId);
    if (!pending?.shouldCompact) {
      return;
    }
    if (!linked?.bindingKey || !linked?.workspaceRoot) {
      return;
    }
    if (
      this.turnGateStore.isPending(linked.bindingKey, linked.workspaceRoot)
      || this.hasPendingInboundMessage(linked.bindingKey, linked.workspaceRoot)
    ) {
      return;
    }
    await this.requestAutoCompact({ threadId, linked, reason: pending });
  }

  async requestAutoCompact({ threadId, linked, reason }) {
    const normalizedThreadId = normalizeCommandArgument(threadId);
    if (!normalizedThreadId || !linked?.bindingKey || !linked?.workspaceRoot) {
      return;
    }
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(linked.bindingKey, linked.workspaceRoot);
    const requestedAtMs = Date.now();
    this.lastAutoCompactAtByThreadId.set(normalizedThreadId, requestedAtMs);
    this.runtimeContextUsageStore?.recordAutoCompact?.({
      threadId: normalizedThreadId,
      workspaceRoot: linked.workspaceRoot,
      bindingKey: linked.bindingKey,
      reason: normalizeText(reason?.reason) || "context_threshold",
      currentTokens: reason?.currentTokens,
      compactThresholdTokens: reason?.compactThresholdTokens,
      contextWindow: reason?.contextWindow,
      availableMessageWindow: reason?.availableMessageWindow,
      compactThresholdPercent: reason?.compactThresholdPercent,
    });
    this.streamDelivery.suppressNextRunForThread?.(normalizedThreadId);
    this.recordControlEvent?.({
      type: "runtime.context.auto_compact_requested",
      layer: CONTROL_LAYER.TACTICAL,
      scope: CONTROL_SCOPE.RUNTIME,
      source: "app.requestAutoCompact",
      subject: normalizedThreadId,
      reason: normalizeText(reason?.reason) || "context_threshold",
      outcome: "requested",
      correlationId: normalizedThreadId,
      payload: {
        workspaceRoot: linked.workspaceRoot,
        currentTokens: reason?.currentTokens,
        compactThresholdTokens: reason?.compactThresholdTokens,
        contextWindow: reason?.contextWindow,
        compactThresholdPercent: reason?.compactThresholdPercent,
      },
    });
    console.log(
      `[mossbridge] auto compact requested thread=${normalizedThreadId} current=${formatCompactNumber(reason?.currentTokens)} threshold=${formatCompactNumber(reason?.compactThresholdTokens)}`
    );
    try {
      const result = await this.runtimeAdapter.compactThread({
        threadId: normalizedThreadId,
        workspaceRoot: linked.workspaceRoot,
        bindingKey: linked.bindingKey,
        model: runtimeParams.model,
      });
      const compactTurnId = normalizeCommandArgument(result?.turnId);
      if (compactTurnId) {
        this.pendingOperationByRunKey.set(buildRunKey(normalizedThreadId, compactTurnId), {
          kind: "compact",
          auto: true,
          notify: false,
          reason: normalizeText(reason?.reason) || "context_threshold",
        });
      }
      this.pendingAutoCompactByThreadId.delete(normalizedThreadId);
    } catch (error) {
      this.pendingAutoCompactByThreadId.delete(normalizedThreadId);
      this.streamDelivery.cancelSuppressedRunForThread?.(normalizedThreadId);
      this.recordControlEvent?.({
        type: "runtime.context.auto_compact_failed",
        layer: CONTROL_LAYER.TACTICAL,
        scope: CONTROL_SCOPE.RUNTIME,
        source: "app.requestAutoCompact",
        subject: normalizedThreadId,
        severity: CONTROL_SEVERITY.WARN,
        reason: "runtime_compact_failed",
        outcome: "suppression_cancelled",
        correlationId: normalizedThreadId,
        payload: {
          workspaceRoot: linked.workspaceRoot,
          error: error instanceof Error ? error.message : String(error || "unknown error"),
        },
      });
      console.warn(
        `[mossbridge] auto compact failed thread=${normalizedThreadId}: ${error instanceof Error ? error.message : String(error || "unknown error")}`
      );
    }
  }

  scheduleRunningTurnWatchdog({ bindingKey, workspaceRoot, normalized, threadId = "", turnId = "" }) {
    const normalizedThreadId = normalizeCommandArgument(threadId);
    const normalizedTurnId = normalizeCommandArgument(turnId);
    if (!normalizedThreadId || !normalizedTurnId) {
      return;
    }
    const runKey = buildRunKey(normalizedThreadId, normalizedTurnId);
    const existing = this.runningTurnWatchdogs.get(runKey);
    if (existing) {
      clearTimeout(existing.noticeTimer);
      clearTimeout(existing.recoveryTimer);
    }
    const runtimeName = this.runtimeAdapter.describe().id || "runtime";
    const isClaudeCode = runtimeName === "claudecode";
    const suppressVisibleStatus = shouldSuppressVisibleRuntimeStatus(normalized);
    const noticeTimeoutMs = isClaudeCode
      ? CLAUDECODE_RUNNING_TURN_STALL_NOTICE_TIMEOUT_MS
      : RUNNING_TURN_STALL_NOTICE_TIMEOUT_MS;
    const recoveryTimeoutMs = isClaudeCode
      ? CLAUDECODE_RUNNING_TURN_STALL_RECOVERY_TIMEOUT_MS
      : RUNNING_TURN_STALL_RECOVERY_TIMEOUT_MS;

    const noticeTimer = suppressVisibleStatus ? null : setTimeout(async () => {
      const watchdog = this.runningTurnWatchdogs.get(runKey);
      if (!watchdog || !this.isSameRunningTurn(normalizedThreadId, normalizedTurnId)) {
        return;
      }
      const threadState = this.threadStateStore.getThreadState(normalizedThreadId);
      if (normalizeText(threadState?.lastReplyText)) {
        return;
      }
      watchdog.noticeSent = true;
      this.recordControlEvent?.({
        type: "runtime.turn.slow_notice",
        layer: CONTROL_LAYER.OBSERVATION,
        scope: CONTROL_SCOPE.RUNTIME,
        source: "app.scheduleRunningTurnWatchdog",
        subject: normalizedThreadId,
        severity: CONTROL_SEVERITY.WARN,
        reason: "runtime_turn_running_without_reply",
        outcome: "bridge_notice_sent",
        correlationId: runKey,
        payload: {
          runtimeName,
          workspaceRoot,
          turnId: normalizedTurnId,
          noticeTimeoutMs,
        },
      });
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        preserveBlock: true,
        text: formatBridgeNotice("runtime_slow_reply", [
          "source: bridge",
          `runtime: ${formatRuntimeLabel(runtimeName)}`,
          "status: running_without_reply",
          "action: wait",
          `workspace: ${workspaceRoot}`,
          `thread: ${normalizedThreadId}`,
        ]),
      }).catch(() => {});
    }, noticeTimeoutMs);

    const recoveryTimer = setTimeout(async () => {
      const watchdog = this.runningTurnWatchdogs.get(runKey);
      if (!watchdog || !this.isSameRunningTurn(normalizedThreadId, normalizedTurnId)) {
        return;
      }
      this.runningTurnWatchdogs.delete(runKey);
      this.watchdogCancelledRunKeys.add(runKey);
      const triggerKind = describeSystemTriggerKind(normalized) || "system";
      this.recordControlEvent?.({
        type: "runtime.turn.stalled_released",
        layer: CONTROL_LAYER.EXECUTIVE,
        scope: CONTROL_SCOPE.RUNTIME,
        source: "app.scheduleRunningTurnWatchdog",
        subject: normalizedThreadId,
        severity: suppressVisibleStatus ? CONTROL_SEVERITY.WARN : CONTROL_SEVERITY.ERROR,
        reason: suppressVisibleStatus ? "background_runtime_turn_stalled" : "runtime_turn_stalled",
        outcome: suppressVisibleStatus ? "silent_recovery_requested" : "cancel_requested",
        correlationId: runKey,
        payload: {
          runtimeName,
          workspaceRoot,
          turnId: normalizedTurnId,
          recoveryTimeoutMs,
          triggerKind,
        },
      });
      await this.channelAdapter.sendTyping({
        userId: normalized.senderId,
        status: 0,
        contextToken: normalized.contextToken,
      }).catch(() => {});
      if (suppressVisibleStatus) {
        console.warn(
          `[mossbridge] suppressed background stalled-turn recovery trigger=${triggerKind} thread=${normalizedThreadId}`
        );
        await this.runtimeAdapter.cancelTurn({
          threadId: normalizedThreadId,
          turnId: normalizedTurnId,
          workspaceRoot,
          bindingKey,
        }).catch((error) => {
          console.error(`[mossbridge] background stalled-turn recovery failed thread=${normalizedThreadId}: ${error.message}`);
        });
        this.turnGateStore.releaseThread(normalizedThreadId);
        await this.flushPendingInboundMessages({ bindingKey, workspaceRoot, ignoreBoundary: true }).catch(() => {});
        return;
      }
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        preserveBlock: true,
        text: formatBridgeNotice("runtime_stalled_released", [
          "source: bridge",
          `runtime: ${formatRuntimeLabel(runtimeName)}`,
          "status: stalled_released",
          `timeout_minutes: ${Math.round(recoveryTimeoutMs / 60_000)}`,
          "result: run_released",
          "action: resend_if_needed",
          `workspace: ${workspaceRoot}`,
          `thread: ${normalizedThreadId}`,
        ]),
      }).catch(() => {});
      await this.runtimeAdapter.cancelTurn({
        threadId: normalizedThreadId,
        turnId: normalizedTurnId,
        workspaceRoot,
        bindingKey,
      }).catch((error) => {
        console.error(`[mossbridge] stalled turn recovery failed thread=${normalizedThreadId}: ${error.message}`);
      });
      this.turnGateStore.releaseThread(normalizedThreadId);
      await this.flushPendingInboundMessages({ bindingKey, workspaceRoot, ignoreBoundary: true }).catch(() => {});
    }, recoveryTimeoutMs);

    this.runningTurnWatchdogs.set(runKey, {
      bindingKey,
      workspaceRoot,
      normalized,
      threadId: normalizedThreadId,
      turnId: normalizedTurnId,
      noticeTimer,
      recoveryTimer,
      noticeSent: false,
    });
  }

  observeRunningTurnEvent(event) {
    const threadId = normalizeCommandArgument(event?.payload?.threadId);
    if (!threadId) {
      return;
    }
    const turnId = normalizeCommandArgument(event?.payload?.turnId);
    if (event.type === "runtime.turn.completed" || event.type === "runtime.turn.failed") {
      this.clearRunningTurnWatchdog(threadId, turnId);
      return;
    }
    if (event.type === "runtime.process.closed") {
      this.clearRunningTurnWatchdog(threadId);
      return;
    }
    if (![
      "runtime.turn.started",
      "runtime.reply.delta",
      "runtime.reply.completed",
      "runtime.approval.requested",
      "runtime.context.updated",
    ].includes(event.type)) {
      return;
    }
    const activeTurnId = turnId || normalizeCommandArgument(this.threadStateStore.getThreadState(threadId)?.turnId);
    if (!activeTurnId) {
      return;
    }
    const runKey = buildRunKey(threadId, activeTurnId);
    const watchdog = this.runningTurnWatchdogs.get(runKey);
    if (!watchdog) {
      return;
    }
    this.scheduleRunningTurnWatchdog(watchdog);
  }

  clearRunningTurnWatchdog(threadId, turnId = "") {
    const normalizedThreadId = normalizeCommandArgument(threadId);
    const normalizedTurnId = normalizeCommandArgument(turnId);
    if (!normalizedThreadId) {
      return;
    }
    for (const [runKey, watchdog] of this.runningTurnWatchdogs.entries()) {
      if (
        watchdog.threadId === normalizedThreadId
        && (!normalizedTurnId || watchdog.turnId === normalizedTurnId)
      ) {
        clearTimeout(watchdog.noticeTimer);
        clearTimeout(watchdog.recoveryTimer);
        this.runningTurnWatchdogs.delete(runKey);
      }
    }
  }

  isSameRunningTurn(threadId, turnId) {
    const threadState = this.threadStateStore.getThreadState(threadId);
    if (!threadState || !["running", "waiting_approval"].includes(threadState.status)) {
      return false;
    }
    return !turnId || normalizeCommandArgument(threadState.turnId) === normalizeCommandArgument(turnId);
  }

  async prepareIncomingMessageForRuntime(normalized, workspaceRoot) {
    let runtimeText = "";
    let attachments = [];
    let attachmentFailures = [];

    if (normalized?.provider === "system") {
      runtimeText = String(normalized.text || "").trim();
    } else {
      const incomingAttachments = Array.isArray(normalized.attachments) ? normalized.attachments : [];
      if (!incomingAttachments.length) {
        runtimeText = buildInboundText(normalized, { saved: [], failed: [] }, this.config, {
          runtimeId: this.runtimeAdapter?.describe?.().id || "",
          workspaceRoot,
        });
      } else {
        const persisted = await persistIncomingWeixinAttachments({
          attachments: incomingAttachments,
          config: this.config,
          workspaceRoot,
          stateDir: this.config.stateDir,
          cdnBaseUrl: this.config.weixinCdnBaseUrl,
          messageId: normalized.messageId,
          receivedAt: normalized.receivedAt,
          messageText: normalized.text,
        });
        attachments = persisted.saved;
        attachmentFailures = persisted.failed;
        this.recordWeixinAttachmentIntakeAudit?.({
          normalized,
          saved: attachments,
          failed: attachmentFailures,
        });
        if (attachmentFailures.length) {
          console.warn(
            `[mossbridge] attachment intake failed message=${normalized.messageId || ""} saved=${attachments.length} failed=${attachmentFailures.length} reasons=${attachmentFailures.map((item) => item.reason).join(" | ")}`
          );
        }

        runtimeText = buildInboundText(normalized, persisted, this.config, {
          runtimeId: this.runtimeAdapter?.describe?.().id || "",
          workspaceRoot,
        });
        if (!runtimeText) {
          await this.channelAdapter.sendText({
            userId: normalized.senderId,
            text: formatBridgeNotice("attachment_intake_failed", [
              "source: bridge",
              "status: attachment_intake_failed",
              ...persisted.failed.map((item) => `error: ${item.reason}`),
            ]),
            contextToken: normalized.contextToken,
            preserveBlock: true,
          }).catch(() => {});
          return null;
        }
      }
    }

    const memoryContext = await this.attachMemoryContextToPreparedText(normalized, runtimeText, workspaceRoot);
    return {
      ...normalized,
      originalText: normalized.text,
      runtimeText,
      text: memoryContext.text,
      attachments,
      attachmentFailures,
      memoryContextPacket: memoryContext.packet,
    };
  }

  recordWeixinAttachmentIntakeAudit({ normalized = null, saved = [], failed = [] } = {}) {
    const savedItems = Array.isArray(saved) ? saved : [];
    const failedItems = Array.isArray(failed) ? failed : [];
    this.weixinIngressAuditStore?.recordAttachmentIntake?.({
      messageId: normalizeCommandArgument(String(normalized?.messageId || "")),
      senderId: normalizeText(normalized?.senderId),
      contextTokenPresent: Boolean(normalizeText(normalized?.contextToken)),
      savedCount: savedItems.length,
      failedCount: failedItems.length,
      imageCount: savedItems.filter((item) => isImageAttachmentItem(item)).length,
      fileCount: savedItems.filter((item) => !isImageAttachmentItem(item)).length,
      savedFiles: savedItems.map((item) => normalizeText(item?.relativePath) || normalizeText(item?.fileName) || normalizeText(item?.absolutePath)).filter(Boolean),
      savedDiagnostics: savedItems.map((item) => item?.diagnostics).filter((item) => item && typeof item === "object"),
      failedReasons: failedItems.map((item) => {
        const label = normalizeText(item?.sourceFileName) || normalizeText(item?.kind) || "attachment";
        const reason = normalizeText(item?.reason) || "unknown";
        return `${label}: ${reason}`;
      }),
      failedDiagnostics: failedItems.map((item) => item?.diagnostics).filter((item) => item && typeof item === "object"),
    });
  }

  async flushPendingSystemMessages() {
    const pendingMessages = this.systemMessageDispatcher?.drainPending() || [];
    for (const message of pendingMessages) {
      try {
        const dispatched = await this.dispatchSystemMessage(message);
        if (!dispatched) {
          this.systemMessageDispatcher.requeue(message);
        }
      } catch {
        this.systemMessageDispatcher?.requeue(message);
      }
    }
  }

  async flushPendingTimelineScreenshots(account) {
    const pendingJobs = this.timelineScreenshotQueue.drainForAccount(account.accountId);
    for (const job of pendingJobs) {
      try {
        const captured = await this.projectDomains.calendar.captureScreenshot({
          outputFile: job.outputFile,
          selector: job.selector,
          range: job.range,
          date: job.date,
          week: job.week,
          month: job.month,
          category: job.category,
          subcategory: job.subcategory,
          width: job.width,
          height: job.height,
          sidePadding: job.sidePadding,
          locale: job.locale,
        });
        await this.sendLocalFileToCurrentChat({
          senderId: job.senderId,
          filePath: captured.outputFile,
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error || "unknown error");
        console.error(`[mossbridge] timeline screenshot failed job=${job.id} ${messageText}`);
        await this.channelAdapter.sendTyping({
          userId: job.senderId,
          status: 0,
        }).catch(() => {});
        await this.channelAdapter.sendText({
          userId: job.senderId,
          text: formatBridgeNotice("timeline_screenshot_failed", [
            "source: bridge",
            "status: timeline_screenshot_failed",
            `error: ${messageText}`,
          ]),
          preserveBlock: true,
        }).catch(() => {});
      }
    }
  }

  resolveLongPollTimeoutMs() {
    if (this.systemMessageDispatcher?.hasPending()) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }
    if (this.activeAccountId && this.timelineScreenshotQueue.hasPendingForAccount(this.activeAccountId)) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }

    const nextDueAtMs = this.reminderQueue.peekNextDueAtMs();
    if (!nextDueAtMs) {
      return DEFAULT_LONG_POLL_TIMEOUT_MS;
    }

    const remainingMs = nextDueAtMs - Date.now();
    if (remainingMs <= MIN_LONG_POLL_TIMEOUT_MS) {
      return MIN_LONG_POLL_TIMEOUT_MS;
    }
    return Math.max(MIN_LONG_POLL_TIMEOUT_MS, Math.min(DEFAULT_LONG_POLL_TIMEOUT_MS, remainingMs));
  }

  async flushDueReminders(account) {
    const dueReminders = this.reminderQueue
      .listDue(Date.now())
      .filter((reminder) => reminder.accountId === account.accountId);

    for (const reminder of dueReminders) {
      try {
        this.systemMessageQueue.enqueue({
          id: `reminder:${reminder.id}`,
          accountId: reminder.accountId,
          senderId: reminder.senderId,
          workspaceRoot: this.resolveReminderWorkspaceRoot(reminder),
          text: buildReminderSystemTrigger(reminder, this.config),
          kind: "reminder_due",
          priority: "high",
          title: "due_reminder",
          metadata: {
            reminderText: normalizeText(reminder?.text),
            dueAt: formatReminderDueAt(reminder?.dueAtMs),
          },
          createdAt: new Date().toISOString(),
        });
      } catch {
        this.reminderQueue.enqueue({
          ...reminder,
          dueAtMs: Date.now() + 5_000,
        });
      }
    }
  }

  async maybeQueueDreaming(account) {
    if (!this.config.startWithDreaming || !this.memoryMetabolismService) {
      return null;
    }
    const nowMs = Date.now();
    if (this.nextDreamingPollAtMs && nowMs < this.nextDreamingPollAtMs) {
      return null;
    }
    const pollIntervalMs = typeof this.memoryMetabolismService.getPollIntervalMs === "function"
      ? this.memoryMetabolismService.getPollIntervalMs()
      : 15 * 60_000;
    this.nextDreamingPollAtMs = nowMs + Math.max(60_000, pollIntervalMs);

    const circuitStatus = typeof this.getBackgroundRuntimeCircuitStatus === "function"
      ? this.getBackgroundRuntimeCircuitStatus({ kind: "dreaming_opportunity", nowMs })
      : { open: false };
    if (circuitStatus.open) {
      const retryAtMs = Number(circuitStatus.openUntilMs) || nowMs + pollIntervalMs;
      this.nextDreamingPollAtMs = Math.max(nowMs + 60_000, retryAtMs);
      this.recordControlEvent?.({
        type: "memory.dreaming.skipped",
        layer: CONTROL_LAYER.TACTICAL,
        scope: CONTROL_SCOPE.MEMORY,
        source: "app.maybeQueueDreaming",
        subject: "background_runtime_circuit",
        severity: CONTROL_SEVERITY.WARN,
        reason: "background_runtime_circuit",
        outcome: "skipped",
        payload: {
          retryAtMs: this.nextDreamingPollAtMs,
          openUntilMs: circuitStatus.openUntilMs,
          remainingMs: circuitStatus.remainingMs,
        },
      });
      console.log(
        `[mossbridge] dreaming skipped: background runtime circuit open until ${formatWechatLocalTime(new Date(this.nextDreamingPollAtMs).toISOString())}`,
      );
      return {
        queued: false,
        reason: "background_runtime_circuit",
        retryAtMs: this.nextDreamingPollAtMs,
        circuitStatus,
      };
    }

    const sessionStore = this.runtimeAdapter.getSessionStore();
    const senderId = resolvePreferredSenderId({
      config: this.config,
      accountId: account.accountId,
      explicitUser: process.env.MOSSBRIDGE_DREAMING_USER_ID || process.env.MOSSBRIDGE_CHECKIN_USER_ID || "",
      sessionStore,
    });
    const workspaceRoot = resolvePreferredWorkspaceRoot({
      config: this.config,
      accountId: account.accountId,
      senderId,
      explicitWorkspace: process.env.MOSSBRIDGE_DREAMING_WORKSPACE || process.env.MOSSBRIDGE_CHECKIN_WORKSPACE || "",
      sessionStore,
    });
    const contextToken = senderId ? (this.channelAdapter.getKnownContextTokens()[senderId] || "") : "";
    const budgetPolicy = this.resolveSystemTurnBudgetPolicy({ kind: "dreaming_opportunity", nowMs });
    if (budgetPolicy.action === "defer") {
      const deferMs = Math.max(60_000, Number(budgetPolicy.deferMs) || pollIntervalMs);
      this.nextDreamingPollAtMs = nowMs + deferMs;
      this.recordControlEvent?.({
        type: "memory.dreaming.deferred",
        layer: CONTROL_LAYER.TACTICAL,
        scope: CONTROL_SCOPE.MEMORY,
        source: "app.maybeQueueDreaming",
        subject: senderId || account.accountId,
        severity: CONTROL_SEVERITY.WARN,
        reason: budgetPolicy.reason,
        outcome: "deferred",
        payload: {
          retryAfterMs: nowMs + deferMs,
          dailyBudget: budgetPolicy.dailyBudget,
        },
      });
      console.log(`[mossbridge] dreaming deferred: daily system budget retry at ${formatWechatLocalTime(new Date(nowMs + deferMs).toISOString())}`);
      return { queued: false, reason: "daily_system_budget", budgetPolicy };
    }
    const result = this.memoryMetabolismService.maybeQueueDreaming({
      accountId: account.accountId,
      senderId,
      workspaceRoot,
      contextToken,
      queue: this.systemMessageQueue,
      queueHasPending: this.systemMessageQueue.hasPendingForAccount(account.accountId),
      runtimeCooldown: this.runtimeCooldownStore?.getActiveCooldown?.(this.config.runtime || "codex"),
      lastActivityAt: getLastActivityAt(),
      nowMs,
    });
    if (result?.queued) {
      this.recordControlEvent?.({
        type: "memory.dreaming.queued",
        layer: CONTROL_LAYER.TACTICAL,
        scope: CONTROL_SCOPE.MEMORY,
        source: "app.maybeQueueDreaming",
        subject: result.attempt_id,
        reason: "quiet_window_source_records_ready",
        outcome: "queued",
        payload: {
          attemptId: result.attempt_id,
          sourceRecordCount: result.source_record_count,
          senderId,
          workspaceRoot,
        },
      });
      console.log(
        `[mossbridge] dreaming queued attempt=${result.attempt_id} records=${result.source_record_count}`,
      );
    } else if (result?.reason && !["disabled", "poll_interval", "insufficient_source_records"].includes(result.reason)) {
      this.recordControlEvent?.({
        type: "memory.dreaming.skipped",
        layer: CONTROL_LAYER.TACTICAL,
        scope: CONTROL_SCOPE.MEMORY,
        source: "app.maybeQueueDreaming",
        subject: result.reason,
        severity: CONTROL_SEVERITY.WARN,
        reason: result.reason,
        outcome: "skipped",
        payload: {
          senderId,
          workspaceRoot,
        },
      });
      console.log(`[mossbridge] dreaming skipped: ${result.reason}`);
    }
    return result;
  }

  resolveReminderWorkspaceRoot(reminder) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: this.config.workspaceId,
      accountId: reminder.accountId,
      senderId: reminder.senderId,
    });
    return this.runtimeAdapter.getSessionStore().getActiveWorkspaceRoot(bindingKey) || this.config.workspaceRoot;
  }

  async dispatchSystemMessage(message) {
    if (isDirectVisibleReplySystemMessage(message)) {
      await this.sendDirectVisibleSystemReply(message);
      return true;
    }

    const budgetPolicy = resolveSystemTurnBudgetPolicyForDispatch(this, { kind: message?.kind });
    if (budgetPolicy.action === "drop") {
      this.recordControlEvent?.({
        type: "system.checkin.dropped",
        layer: CONTROL_LAYER.TACTICAL,
        scope: CONTROL_SCOPE.SYSTEM_TURN,
        source: "app.dispatchSystemMessage",
        subject: message.id,
        severity: CONTROL_SEVERITY.WARN,
        reason: budgetPolicy.reason,
        outcome: "dropped",
        payload: {
          dailyBudget: budgetPolicy.dailyBudget,
        },
      });
      console.log(
        `[mossbridge] ${normalizeText(message?.kind) || "system"} dropped: daily system budget reached`,
      );
      return true;
    }

    const circuitStatus = typeof this.getBackgroundRuntimeCircuitStatus === "function"
      ? this.getBackgroundRuntimeCircuitStatus({ kind: message?.kind })
      : { open: false };
    if (circuitStatus.open && isBackgroundRuntimeCircuitSystemMessage(message)) {
      if (isDreamingSystemMessage(message)) {
        this.deferMemoryMetabolismAttemptForRuntimeCircuit(message, circuitStatus);
        return true;
      }
      this.recordControlEvent?.({
        type: "system.checkin.dropped",
        layer: CONTROL_LAYER.TACTICAL,
        scope: CONTROL_SCOPE.SYSTEM_TURN,
        source: "app.dispatchSystemMessage",
        subject: message.id,
        severity: CONTROL_SEVERITY.WARN,
        reason: "background_runtime_circuit",
        outcome: "dropped",
        payload: {
          openUntilMs: circuitStatus.openUntilMs,
          remainingMs: circuitStatus.remainingMs,
        },
      });
      console.log(
        `[mossbridge] checkin dropped: background runtime circuit open until ${formatWechatLocalTime(new Date(circuitStatus.openUntilMs).toISOString())}`,
      );
      return true;
    }

    if (budgetPolicy.action === "defer" && isDreamingSystemMessage(message)) {
      this.deferMemoryMetabolismAttemptForBudget(message, budgetPolicy);
      return true;
    }

    if (isCheckinOpportunityMessage(message)) {
      const cooldown = this.runtimeCooldownStore?.getActiveCooldown?.(this.config.runtime || "codex");
      if (cooldown) {
        this.recordControlEvent?.({
          type: "system.checkin.dropped",
          layer: CONTROL_LAYER.TACTICAL,
          scope: CONTROL_SCOPE.SYSTEM_TURN,
          source: "app.dispatchSystemMessage",
          subject: message.id,
          severity: CONTROL_SEVERITY.WARN,
          reason: "runtime_cooldown",
          outcome: "dropped",
          payload: {
            runtime: this.config.runtime || "codex",
            resetAt: cooldown.resetAt,
            remainingMs: cooldown.remainingMs,
          },
        });
        console.log(
          `[mossbridge] checkin dropped: runtime cooldown until ${cooldown.resetAt || cooldown.resetAtMs || ""}`,
        );
        return true;
      }
    }

    const budgetAdjustedMessage = applySystemBudgetPolicyToMessage(message, budgetPolicy);
    const profiledMessage = applySystemToolProfileToMessage(budgetAdjustedMessage);
    const prepared = this.systemMessageDispatcher?.buildPreparedMessage(profiledMessage, this.channelAdapter.getKnownContextTokens()[message.senderId] || "");
    if (!prepared) {
      throw new Error("system message could not be prepared");
    }
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const userBindingKey = sessionStore.buildBindingKey({
      workspaceId: prepared.workspaceId,
      accountId: prepared.accountId,
      senderId: prepared.senderId,
    });
    const workspaceRoot = prepared.workspaceRoot || this.resolveWorkspaceRoot(userBindingKey);
    if (this.isTurnDispatchBlocked(userBindingKey, workspaceRoot)) {
      if (isCheckinOpportunityMessage(profiledMessage)) {
        console.log("[mossbridge] checkin dropped: foreground turn is busy");
        return true;
      }
      return false;
    }
    const bindingKey = this.prepareSystemRuntimeBinding({
      userBindingKey,
      workspaceRoot,
      prepared,
    });
    if (this.isTurnDispatchBlocked(bindingKey, workspaceRoot)) {
      return false;
    }
    const preparedForDispatch = {
      ...prepared,
      runtimeBindingSenderId: buildSystemRuntimeSenderId(prepared.senderId),
      systemRuntimeBinding: true,
      systemToolProfile: resolveSystemToolProfileForMessage(profiledMessage),
    };
    const runtimeText = preparedForDispatch.runtimeText || preparedForDispatch.text;
    const memoryContext = await this.attachMemoryContextToPreparedText(
      preparedForDispatch,
      runtimeText,
      workspaceRoot,
    );
    preparedForDispatch.runtimeText = runtimeText;
    preparedForDispatch.text = clampSystemRuntimeText(
      memoryContext.text,
      resolveSystemRuntimeTextMaxChars(preparedForDispatch, this.config),
    );
    preparedForDispatch.memoryContextPacket = memoryContext.packet;
    return this.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared: preparedForDispatch });
  }

  markMemoryMetabolismAttemptDispatched(systemTurn = {}, { threadId = "", turnId = "" } = {}) {
    if (!this.memoryMetabolismService || !isDreamingSystemTurn(systemTurn)) {
      return;
    }
    const attemptId = resolveDreamingAttemptId(systemTurn);
    if (!attemptId) {
      return;
    }
    if (typeof this.memoryMetabolismService.markAttemptDispatched === "function") {
      try {
        this.memoryMetabolismService.markAttemptDispatched(attemptId, { threadId, turnId });
        this.recordControlEvent?.({
          type: "memory.dreaming.dispatched",
          layer: CONTROL_LAYER.EXECUTIVE,
          scope: CONTROL_SCOPE.MEMORY,
          source: "app.markMemoryMetabolismAttemptDispatched",
          subject: attemptId,
          reason: "runtime_turn_started",
          outcome: "receipt_pending",
          correlationId: buildRunKey(threadId, turnId),
          payload: {
            attemptId,
            threadId,
            turnId,
          },
        });
      } catch (error) {
        this.recordControlEvent?.({
          type: "memory.dreaming.dispatch_receipt_failed",
          layer: CONTROL_LAYER.EXECUTIVE,
          scope: CONTROL_SCOPE.MEMORY,
          source: "app.markMemoryMetabolismAttemptDispatched",
          subject: attemptId,
          severity: CONTROL_SEVERITY.WARN,
          reason: "mark_attempt_dispatched_failed",
          outcome: "skipped",
          payload: {
            attemptId,
            error: formatErrorMessage(error),
          },
        });
        console.warn(`[mossbridge] dreaming dispatch receipt skipped attempt=${attemptId} ${formatErrorMessage(error)}`);
      }
    }
  }

  deferMemoryMetabolismAttemptForBudget(message = {}, budgetPolicy = {}) {
    const attemptId = normalizeText(message?.metadata?.dreamingAttemptId || message?.metadata?.dreaming_attempt_id);
    let deferred = null;
    if (attemptId && typeof this.memoryMetabolismService?.deferAttempt === "function") {
      deferred = this.memoryMetabolismService.deferAttempt(attemptId, {
        reason: budgetPolicy.reason || "daily_system_budget",
        retryAfterMs: budgetPolicy.retryAfterMs,
      });
    }
    this.recordControlEvent?.({
      type: "memory.dreaming.deferred",
      layer: CONTROL_LAYER.TACTICAL,
      scope: CONTROL_SCOPE.MEMORY,
      source: "app.dispatchSystemMessage",
      subject: attemptId || message.id,
      severity: CONTROL_SEVERITY.WARN,
      reason: budgetPolicy.reason || "daily_system_budget",
      outcome: deferred?.ok === false ? "defer_record_failed" : "deferred",
      payload: {
        retryAfterMs: budgetPolicy.retryAfterMs,
        dailyBudget: budgetPolicy.dailyBudget,
        deferResult: deferred,
      },
    });
    console.log(
      `[mossbridge] dreaming deferred: daily system budget retry at ${formatWechatLocalTime(new Date(budgetPolicy.retryAfterMs || Date.now()).toISOString())}`,
    );
  }

  deferMemoryMetabolismAttemptForRuntimeCircuit(message = {}, circuitStatus = {}) {
    const attemptId = normalizeText(message?.metadata?.dreamingAttemptId || message?.metadata?.dreaming_attempt_id);
    const retryAfterMs = Number(circuitStatus.openUntilMs) || Date.now() + resolveBackgroundRuntimeCircuitCooldownMs(this.config);
    let deferred = null;
    if (attemptId && typeof this.memoryMetabolismService?.deferAttempt === "function") {
      deferred = this.memoryMetabolismService.deferAttempt(attemptId, {
        reason: "background_runtime_circuit",
        retryAfterMs,
      });
    }
    this.recordControlEvent?.({
      type: "memory.dreaming.deferred",
      layer: CONTROL_LAYER.TACTICAL,
      scope: CONTROL_SCOPE.MEMORY,
      source: "app.dispatchSystemMessage",
      subject: attemptId || message.id,
      severity: CONTROL_SEVERITY.WARN,
      reason: "background_runtime_circuit",
      outcome: deferred?.ok === false ? "defer_record_failed" : "deferred",
      payload: {
        retryAfterMs,
        openUntilMs: circuitStatus.openUntilMs,
        remainingMs: circuitStatus.remainingMs,
        deferResult: deferred,
      },
    });
    console.log(
      `[mossbridge] dreaming deferred: background runtime circuit retry at ${formatWechatLocalTime(new Date(retryAfterMs).toISOString())}`,
    );
  }

  getBackgroundRuntimeCircuitStatus({ kind = "", nowMs = Date.now() } = {}) {
    if (this.config?.backgroundRuntimeCircuitEnabled === false || !isBackgroundRuntimeCircuitKind(kind)) {
      return { open: false, remainingMs: 0, openUntilMs: 0 };
    }
    const state = normalizeBackgroundRuntimeCircuitState(this.backgroundRuntimeCircuit);
    if (state.openUntilMs && state.openUntilMs <= nowMs) {
      const next = {
        ...state,
        openUntilMs: 0,
        openUntil: "",
        reason: "",
      };
      this.writeBackgroundRuntimeCircuitState(next);
      return { ...next, open: false, remainingMs: 0 };
    }
    const remainingMs = state.openUntilMs > nowMs ? state.openUntilMs - nowMs : 0;
    return {
      ...state,
      open: remainingMs > 0,
      remainingMs,
    };
  }

  recordBackgroundRuntimeFirstEventFailure({
    trigger = "",
    threadId = "",
    bindingKey = "",
    workspaceRoot = "",
    nowMs = Date.now(),
  } = {}) {
    if (this.config?.backgroundRuntimeCircuitEnabled === false || !isBackgroundRuntimeCircuitKind(trigger)) {
      return null;
    }
    const threshold = resolveBackgroundRuntimeCircuitFailureThreshold(this.config);
    const cooldownMs = resolveBackgroundRuntimeCircuitCooldownMs(this.config);
    const state = normalizeBackgroundRuntimeCircuitState(this.backgroundRuntimeCircuit);
    const withinWindow = state.lastFailureAtMs && nowMs - state.lastFailureAtMs <= cooldownMs;
    const consecutiveFirstEventFailures = (withinWindow ? state.consecutiveFirstEventFailures : 0) + 1;
    const shouldOpen = consecutiveFirstEventFailures >= threshold;
    const openUntilMs = shouldOpen
      ? Math.max(Number(state.openUntilMs) || 0, nowMs + cooldownMs)
      : Number(state.openUntilMs) || 0;
    const next = {
      ...state,
      consecutiveFirstEventFailures,
      lastFailureAt: new Date(nowMs).toISOString(),
      lastFailureAtMs: nowMs,
      lastTrigger: normalizeText(trigger),
      lastThreadId: normalizeCommandArgument(threadId),
      lastBindingKey: normalizeText(bindingKey),
      lastWorkspaceRoot: normalizeText(workspaceRoot),
      reason: shouldOpen ? "background_first_event_failure" : state.reason,
      openUntilMs,
      openUntil: openUntilMs ? new Date(openUntilMs).toISOString() : "",
      updatedAt: new Date(nowMs).toISOString(),
      updatedAtMs: nowMs,
    };
    this.writeBackgroundRuntimeCircuitState(next);
    this.recordControlEvent?.({
      type: shouldOpen ? "runtime.background_circuit.opened" : "runtime.background_circuit.failure_recorded",
      layer: CONTROL_LAYER.EXECUTIVE,
      scope: CONTROL_SCOPE.RUNTIME,
      source: "app.recordBackgroundRuntimeFirstEventFailure",
      subject: normalizeCommandArgument(threadId),
      severity: CONTROL_SEVERITY.WARN,
      reason: "background_first_event_failure",
      outcome: shouldOpen ? "circuit_opened" : "failure_recorded",
      correlationId: normalizeCommandArgument(threadId),
      payload: {
        trigger: next.lastTrigger,
        bindingKey: next.lastBindingKey,
        workspaceRoot: next.lastWorkspaceRoot,
        consecutiveFirstEventFailures,
        threshold,
        openUntilMs,
      },
    });
    if (shouldOpen) {
      console.warn(
        `[mossbridge] background runtime circuit opened runtime=${this.config?.runtime || "runtime"} failures=${consecutiveFirstEventFailures}/${threshold} until=${next.openUntil} trigger=${next.lastTrigger} thread=${next.lastThreadId}`,
      );
    } else {
      console.warn(
        `[mossbridge] background runtime first-event failure recorded runtime=${this.config?.runtime || "runtime"} failures=${consecutiveFirstEventFailures}/${threshold} trigger=${next.lastTrigger} thread=${next.lastThreadId}`,
      );
    }
    return this.getBackgroundRuntimeCircuitStatus({ kind: trigger, nowMs });
  }

  recordBackgroundRuntimeSuccess({ event = null, nowMs = Date.now() } = {}) {
    if (this.config?.backgroundRuntimeCircuitEnabled === false || event?.type !== "runtime.turn.completed") {
      return null;
    }
    const state = normalizeBackgroundRuntimeCircuitState(this.backgroundRuntimeCircuit);
    if (!state.consecutiveFirstEventFailures && !state.openUntilMs) {
      return state;
    }
    const next = {
      ...state,
      consecutiveFirstEventFailures: 0,
      openUntilMs: 0,
      openUntil: "",
      reason: "",
      lastSuccessAt: new Date(nowMs).toISOString(),
      lastSuccessAtMs: nowMs,
      lastSuccessThreadId: normalizeCommandArgument(event?.payload?.threadId),
      updatedAt: new Date(nowMs).toISOString(),
      updatedAtMs: nowMs,
    };
    this.writeBackgroundRuntimeCircuitState(next);
    this.recordControlEvent?.({
      type: "runtime.background_circuit.cleared",
      layer: CONTROL_LAYER.EXECUTIVE,
      scope: CONTROL_SCOPE.RUNTIME,
      source: "app.recordBackgroundRuntimeSuccess",
      subject: next.lastSuccessThreadId,
      reason: "runtime_turn_completed",
      outcome: "circuit_cleared",
      correlationId: next.lastSuccessThreadId,
      payload: {
        lastSuccessThreadId: next.lastSuccessThreadId,
      },
    });
    console.log(
      `[mossbridge] background runtime circuit cleared after runtime completion thread=${next.lastSuccessThreadId || "(unknown)"}`,
    );
    return next;
  }

  writeBackgroundRuntimeCircuitState(state = {}) {
    const normalized = normalizeBackgroundRuntimeCircuitState(state);
    this.backgroundRuntimeCircuit = normalized;
    persistBackgroundRuntimeCircuitState(this.config?.backgroundRuntimeCircuitFile, normalized);
    return normalized;
  }

  resolveSystemTurnBudgetPolicy({ kind = "", nowMs = Date.now() } = {}) {
    return resolveSystemTurnBudgetPolicy({
      kind,
      config: this.config,
      runtimeContextUsageStore: this.runtimeContextUsageStore,
      nowMs,
    });
  }

  prepareSystemRuntimeBinding({ userBindingKey, workspaceRoot, prepared }) {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const syntheticSenderId = buildSystemRuntimeSenderId(prepared?.senderId);
    const bindingKey = sessionStore.buildBindingKey({
      workspaceId: prepared?.workspaceId,
      accountId: prepared?.accountId,
      senderId: syntheticSenderId,
    });
    const userModel = typeof sessionStore.getRuntimeParamsForWorkspace === "function"
      ? sessionStore.getRuntimeParamsForWorkspace(userBindingKey, workspaceRoot).model
      : "";
    if (typeof sessionStore.updateBinding === "function") {
      sessionStore.updateBinding(bindingKey, {
        workspaceId: prepared?.workspaceId,
        accountId: prepared?.accountId,
        senderId: syntheticSenderId,
        replySenderId: prepared?.senderId,
        systemRuntimeBinding: true,
        activeWorkspaceRoot: workspaceRoot,
      });
    }
    if (userModel && typeof sessionStore.setRuntimeParamsForWorkspace === "function") {
      sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, { model: userModel });
    }
    if (typeof sessionStore.clearThreadIdForWorkspace === "function") {
      sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    }
    if (typeof sessionStore.clearPendingThreadIdForWorkspace === "function") {
      sessionStore.clearPendingThreadIdForWorkspace(bindingKey, workspaceRoot);
    }
    return bindingKey;
  }

  async sendDirectVisibleSystemReply(message) {
    const senderId = normalizeText(message?.senderId);
    const text = normalizeText(message?.text);
    if (!senderId || !text) {
      throw new Error("direct visible reply requires sender and text");
    }
    const contextToken = this.channelAdapter.getKnownContextTokens()[senderId] || "";
    if (!contextToken) {
      throw new Error(`Cannot find context token for direct visible reply user=${senderId}`);
    }
    await this.channelAdapter.sendText({
      userId: senderId,
      text,
      contextToken,
    });
    recordAiReply();
  }

  async dispatchChannelCommand(normalized, command) {
    switch (command.name) {
      case "bind":
        await this.handleBindCommand(normalized, command);
        return;
      case "status":
        await this.handleStatusCommand(normalized);
        return;
      case "new":
        await this.handleNewCommand(normalized);
        return;
      case "reread":
        await this.handleRereadCommand(normalized);
        return;
      case "compact":
        await this.handleCompactCommand(normalized);
        return;
      case "switch":
        await this.handleSwitchCommand(normalized, command);
        return;
      case "stop":
        await this.handleStopCommand(normalized);
        return;
      case "checkin":
        await this.handleCheckinCommand(normalized, command);
        return;
      case "chunk":
        await this.handleChunkCommand(normalized, command);
        return;
      case "yes":
      case "always":
      case "no":
        await this.handleApprovalCommand(normalized, command);
        return;
      case "model":
        await this.handleModelCommand(normalized, command);
        return;
      case "star":
        await this.handleStarCommand(normalized);
        return;
      case "help":
        await this.handleHelpCommand(normalized);
        return;
      default:
        await this.channelAdapter.sendText({
          userId: normalized.senderId,
          text: buildWeixinHelpText(),
          contextToken: normalized.contextToken,
        });
    }
  }

  async handleBindCommand(normalized, command) {
    const workspaceRoot = normalizeWorkspacePath(command.args);
    if (!workspaceRoot) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /bind /absolute/path",
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (!isAbsoluteWorkspacePath(workspaceRoot)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ Only absolute paths are supported for /bind.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (!isPathWithinAllowedDirectories(workspaceRoot)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ The path must be within your home directory or the current working directory.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const stats = await fs.promises.stat(workspaceRoot).catch(() => null);
    if (!stats?.isDirectory()) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Workspace does not exist\n${workspaceRoot}`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    this.runtimeAdapter.getSessionStore().setActiveWorkspaceRoot(bindingKey, workspaceRoot);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Workspace bound\nworkspace: ${workspaceRoot}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStatusCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const pendingThreadId = sessionStore.getPendingThreadIdForWorkspace?.(bindingKey, workspaceRoot) || "";
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    const runtimeName = this.runtimeAdapter.describe().id || "runtime";
    const context = threadState?.context?.runtimeId === runtimeName
      ? threadState.context
      : (
        this.threadStateStore.getLatestContext(runtimeName)
        || this.runtimeContextUsageStore?.getContext?.({ threadId, runtimeId: runtimeName })
      );
    const storedModel = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model || "";
    const isLikelyCodexModel = /gpt|o1|o3|codex/i.test(storedModel);
    const effectiveModel = (runtimeName === "claudecode" && isLikelyCodexModel)
      ? (this.config.claudeModel || "")
      : storedModel;
    const inboundAccess = typeof this.describeInboundAccess === "function"
      ? this.describeInboundAccess()
      : { status: "unknown", warning: "" };

    const lines = [
      `📍 workspace: ${workspaceRoot}`,
      `🧵 thread: ${threadId || "(none)"}${pendingThreadId ? " (pending verification)" : ""}`,
      `📊 status: ${threadState?.status || "idle"}`,
      `🤖 runtime: ${runtimeName}`,
      `🤖 model: ${effectiveModel || "(default)"}`,
      `🔐 inbound: ${inboundAccess.status}`,
    ];
    if (inboundAccess.warning) {
      lines.push(`⚠️ inbound warning: ${inboundAccess.warning}`);
    }
    if (pendingThreadId) {
      lines.splice(2, 0, `🔁 target: ${pendingThreadId}`);
    }
    lines.push(formatContextStatusLine({
      runtimeName,
      context,
      claudeContextWindow: this.config.claudeContextWindow,
      claudeMaxOutputTokens: this.config.claudeMaxOutputTokens,
    }));
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: lines.join("\n"),
      contextToken: normalized.contextToken,
    });
  }

  async handleNewCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    if (typeof this.runtimeAdapter.startFreshThreadDraft === "function") {
      await this.runtimeAdapter.startFreshThreadDraft({ bindingKey, workspaceRoot });
    }
    this.runtimeAdapter.getSessionStore().clearPendingThreadIdForWorkspace?.(bindingKey, workspaceRoot);
    this.runtimeAdapter.getSessionStore().clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Switched to a fresh thread draft\nworkspace: ${workspaceRoot}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleRereadCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    if (!threadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no active thread yet. Send a normal message first.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    try {
      this.streamDelivery.queueReplyTargetForThread(threadId, {
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        provider: normalized.provider,
      });
      this.scheduleRuntimeEventWatchdog({
        bindingKey,
        workspaceRoot,
        normalized,
        threadId,
      });
      const runtimeParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
      await this.runtimeAdapter.refreshThreadInstructions({
        threadId,
        workspaceRoot,
        bindingKey,
        model: runtimeParams.model,
        modelProvider: runtimeParams.modelProvider,
      });
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: formatBridgeNotice("reread_failed", [
          "source: bridge",
          "status: reread_failed",
          `error: ${error instanceof Error ? error.message : String(error || "unknown error")}`,
        ]),
        contextToken: normalized.contextToken,
      }).catch(() => {});
    }
  }

  async handleCompactCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    if (!threadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no active thread yet. Send a normal message first.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    try {
      this.streamDelivery.queueReplyTargetForThread(threadId, {
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        provider: normalized.provider,
      });
      this.scheduleRuntimeEventWatchdog({
        bindingKey,
        workspaceRoot,
        normalized,
        threadId,
      });
      await this.runtimeAdapter.compactThread({
        threadId,
        workspaceRoot,
        bindingKey,
        model: sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model,
      }).then((result) => {
        const compactTurnId = normalizeCommandArgument(result?.turnId);
        if (compactTurnId) {
          this.pendingOperationByRunKey.set(buildRunKey(threadId, compactTurnId), {
            kind: "compact",
            userId: normalized.senderId,
            contextToken: normalized.contextToken,
          });
        }
      });
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `🗜️ Compact request sent\nthread: ${threadId}`,
        contextToken: normalized.contextToken,
      });
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: formatBridgeNotice("compact_failed", [
          "source: bridge",
          "status: compact_failed",
          `error: ${error instanceof Error ? error.message : String(error || "unknown error")}`,
        ]),
        contextToken: normalized.contextToken,
      }).catch(() => {});
    }
  }

  async handleSwitchCommand(normalized, command) {
    const targetThreadId = normalizeThreadId(command.args);
    if (!targetThreadId) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /switch <threadId>",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const runtimeId = this.runtimeAdapter.describe().id || "";
    const resumed = await this.runtimeAdapter.resumeThread({
      threadId: targetThreadId,
      workspaceRoot,
      bindingKey,
    });
    if (runtimeId === "claudecode") {
      sessionStore.setThreadIdForWorkspace(
        bindingKey,
        workspaceRoot,
        resumed?.threadId || targetThreadId,
      );
      sessionStore.setPendingThreadIdForWorkspace?.(
        bindingKey,
        workspaceRoot,
        resumed?.threadId || targetThreadId,
      );
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `🔁 Thread switch requested\nworkspace: ${workspaceRoot}\ntarget: ${resumed?.threadId || targetThreadId}\nIt will be verified on the next normal message.`,
        contextToken: normalized.contextToken,
      });
      return;
    }
    sessionStore.setThreadIdForWorkspace(
      bindingKey,
      workspaceRoot,
      resumed?.threadId || targetThreadId,
    );
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Thread switched\nworkspace: ${workspaceRoot}\nthread: ${resumed?.threadId || targetThreadId}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleStopCommand(normalized) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    if (!threadId || !threadState?.turnId || !["running", "waiting_approval"].includes(threadState.status)) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no running thread right now.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    await this.runtimeAdapter.cancelTurn({
      threadId,
      turnId: threadState.turnId,
      workspaceRoot,
      bindingKey,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `⏹️ Stop request sent\nthread: ${threadId}`,
      contextToken: normalized.contextToken,
    });
  }

  async handleCheckinCommand(normalized, command) {
    const rangeInput = normalizeCommandArgument(command.args);
    if (!rangeInput) {
      const currentRange = this.checkinConfigStore.getRange(resolveDefaultCheckinRange());
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⏰ Current check-in interval is ${Math.round(currentRange.minIntervalMs / 60000)}-${Math.round(currentRange.maxIntervalMs / 60000)} minutes.`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    const parsedRange = parseCheckinRangeMinutes(rangeInput);
    if (!parsedRange) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 Usage: /checkin <min>-<max>",
        contextToken: normalized.contextToken,
      });
      return;
    }

    this.checkinConfigStore.setRange({
      minIntervalMs: parsedRange.minMinutes * 60_000,
      maxIntervalMs: parsedRange.maxMinutes * 60_000,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Check-in interval reset to ${parsedRange.minMinutes}-${parsedRange.maxMinutes} minutes and will apply on the next polling cycle.`,
      contextToken: normalized.contextToken,
    });
  }

  async handleChunkCommand(normalized, command) {
    const arg = normalizeCommandArgument(command.args);
    if (!arg) {
      const current = this.channelAdapter.getMinChunkChars?.() ?? DEFAULT_MIN_WEIXIN_CHUNK;
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `💡 Current minimum merge chunk is ${current} characters. Usage: /chunk <number> (e.g. /chunk 50)`,
        contextToken: normalized.contextToken,
      });
      return;
    }
    const parsed = Number.parseInt(arg, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_MIN_WEIXIN_CHUNK) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `⚠️  Invalid value. Please provide a number between 1 and ${MAX_MIN_WEIXIN_CHUNK}.`,
        contextToken: normalized.contextToken,
      });
      return;
    }
    const updated = this.channelAdapter.setMinChunkChars?.(parsed) ?? parsed;
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Minimum merge chunk set to ${updated} characters. Shorter fragments will be merged into one message up to this size.`,
      contextToken: normalized.contextToken,
    });
  }

  async handleApprovalCommand(normalized, command) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    const approval = threadState?.pendingApproval || null;
    if (!threadId || approval?.requestId == null || String(approval.requestId).trim() === "") {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "💡 There is no pending approval request right now.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (approval?.kind === "mcp_tool_call" && command.name === "always") {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ Persistent approval for this runtime MCP tool request is not available from WeChat.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const approvalResponse = buildApprovalResponsePayload(approval, command.name);
    if (!approvalResponse) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ This runtime MCP request cannot be answered from WeChat yet.",
        contextToken: normalized.contextToken,
      });
      return;
    }
    console.log(
      `[mossbridge] approval response requested thread=${threadId} requestId=${approval.requestId} mode=${approvalResponse.result ? "result" : "decision"} workspace=${workspaceRoot}`
    );
    await this.runtimeAdapter.respondApproval(approvalResponse);
    this.runtimeAdapter.getSessionStore().clearApprovalPrompt(threadId);
    console.log(
      `[mossbridge] approval response delivered thread=${threadId} requestId=${approval.requestId}`
    );
    if (command.name === "always" && approvalResponse.decision === "accept") {
      this.runtimeAdapter.getSessionStore().rememberApprovalPrefixForWorkspace(workspaceRoot, approval.commandTokens);
    }
    this.threadStateStore.resolveApproval(threadId, "running", approval.requestId);
    const text = buildApprovalResponseText(approval, command.name, approvalResponse);
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text,
      contextToken: normalized.contextToken,
    });
  }

  async handleModelCommand(normalized, command) {
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    const workspaceRoot = this.resolveWorkspaceRoot(bindingKey);
    const selection = parseModelSelectionArgs(command.args);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    let catalog = sessionStore.getAvailableModelCatalog();
    const runtimeInfo = this.runtimeAdapter.describe();
    const runtimeId = runtimeInfo.id || "runtime";
    let modelCatalog = buildRuntimeModelCatalog({
      runtimeId,
      catalog,
      config: this.config,
    });
    const currentParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
    const currentModel = currentParams.model || "";
    const currentProvider = currentParams.modelProvider || "";
    const configuredModel = normalizeCommandArgument(runtimeInfo.model);
    const configuredProvider = normalizeCommandArgument(runtimeInfo.modelProvider);

    if (!selection.model && !selection.clear && !selection.providerSpecified) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: formatModelStatusNotice({
          runtimeId,
          workspaceRoot,
          selectedModel: currentModel,
          selectedProvider: currentProvider,
          runtimeDefaultModel: this.resolveRuntimeDefaultModel(runtimeId, catalog),
          configuredModel,
          configuredProvider,
          modelCatalog,
        }),
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (selection.error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: formatBridgeNotice("model_command_error", [
          `runtime: ${runtimeId}`,
          selection.error,
        ]),
        contextToken: normalized.contextToken,
      });
      return;
    }

    if (selection.model.toLowerCase() === "refresh" && !selection.clear && !selection.providerSpecified) {
      await this.handleModelRefreshCommand({ normalized, runtimeId, workspaceRoot });
      return;
    }

    if (!catalog?.models?.length && typeof this.runtimeAdapter.refreshModelCatalog === "function") {
      const refreshed = await this.runtimeAdapter.refreshModelCatalog().catch(() => null);
      if (refreshed?.models?.length) {
        sessionStore.setAvailableModelCatalog(refreshed.models);
        catalog = sessionStore.getAvailableModelCatalog();
        modelCatalog = buildRuntimeModelCatalog({
          runtimeId,
          catalog,
          config: this.config,
        });
      }
    }

    let nextModel = "";
    if (!selection.clear) {
      let matched = findRuntimeModelChoice(modelCatalog, selection.model);
      const hasKnownChoices = modelCatalog.length > 0;
      const allowRawModel = !hasKnownChoices;
      if (!matched && allowRawModel && selection.model) {
        matched = { model: selection.model };
      }
      if (!matched) {
        await this.channelAdapter.sendText({
          userId: normalized.senderId,
          text: buildModelNotFoundText(selection.model, modelCatalog, runtimeId),
          contextToken: normalized.contextToken,
        });
        return;
      }
      nextModel = matched.model;
      if (runtimeId === "codex" && !selection.providerSpecified && normalizeModelProviderArg(matched.modelProvider)) {
        selection.provider = matched.modelProvider;
        selection.providerSpecified = true;
      }
    }

    const nextProvider = runtimeId === "codex"
      ? (selection.clear ? "" : (selection.providerSpecified ? selection.provider : currentProvider))
      : currentProvider;

    if (!selection.clear && !nextModel && !selection.providerSpecified) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: formatBridgeNotice("model_not_found", [
          `runtime: ${runtimeId}`,
          "query: (empty)",
          modelCatalog.length ? `available_models: ${formatRuntimeModelCatalog(modelCatalog)}` : modelChoiceConfigHint(runtimeId),
        ]),
        contextToken: normalized.contextToken,
      });
      return;
    }

    sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
      model: nextModel,
      ...(runtimeId === "codex" ? { modelProvider: nextProvider } : {}),
    });
    const noticeLines = [
      `runtime: ${runtimeId}`,
      `workspace: ${workspaceRoot}`,
      `selected_model: ${nextModel || "(default)"}`,
      `effective_model: ${this.resolveEffectiveModelLabel(runtimeId, nextModel, catalog)}`,
      modelCatalog.length ? "source: model_choices_or_catalog" : "source: raw_model_id",
      "applies_to: next_turn",
    ];
    if (runtimeId === "codex") {
      noticeLines.splice(3, 0, `selected_provider: ${nextProvider || "(default)"}`);
      if (configuredModel || configuredProvider) {
        noticeLines.push("note: MOSSBRIDGE_CODEX_MODEL / MOSSBRIDGE_CODEX_MODEL_PROVIDER is active and may override this session selection until the bridge is restarted with those env values cleared or changed.");
      } else if (selection.providerSpecified) {
        noticeLines.push("note: if this provider needs a different Codex launcher, restart shared mode after updating MOSSBRIDGE_CODEX_COMMAND.");
      }
    }
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: formatBridgeNotice("model_selected", noticeLines),
      contextToken: normalized.contextToken,
    });
  }

  async handleModelRefreshCommand({ normalized, runtimeId, workspaceRoot }) {
    if (typeof this.runtimeAdapter.refreshModelCatalog !== "function") {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: formatBridgeNotice("model_catalog_unavailable", [
          `runtime: ${runtimeId}`,
          "reason: this runtime adapter does not expose model catalog refresh",
        ]),
        contextToken: normalized.contextToken,
      });
      return;
    }
    try {
      const refreshed = await this.runtimeAdapter.refreshModelCatalog();
      const models = normalizeModelCatalog(refreshed?.models || []);
      const catalog = models.length
        ? this.runtimeAdapter.getSessionStore().setAvailableModelCatalog(models)
        : null;
      const modelCatalog = buildRuntimeModelCatalog({
        runtimeId,
        catalog,
        config: this.config,
      });
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: formatBridgeNotice(modelCatalog.length ? "model_catalog_refreshed" : "model_catalog_unavailable", [
          `runtime: ${runtimeId}`,
          `workspace: ${workspaceRoot}`,
          `catalog: ${modelCatalog.length} models`,
          refreshed?.source ? `source: ${refreshed.source}` : "",
          refreshed?.unavailableReason ? `reason: ${refreshed.unavailableReason}` : "",
          refreshed?.acceptsRawModel ? "raw_model_id: accepted" : "",
          catalog?.updatedAt ? `updated_at: ${catalog.updatedAt}` : "",
          modelCatalog.length ? `available_models: ${formatRuntimeModelCatalog(modelCatalog)}` : modelChoiceConfigHint(runtimeId),
        ]),
        contextToken: normalized.contextToken,
      });
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: formatBridgeNotice("model_catalog_refresh_failed", [
          `runtime: ${runtimeId}`,
          error instanceof Error ? error.message : String(error || "unknown error"),
        ]),
        contextToken: normalized.contextToken,
      });
    }
  }

  resolveRuntimeDefaultModel(runtimeId, catalog = null) {
    const normalizedRuntimeId = normalizeText(runtimeId).toLowerCase();
    if (normalizedRuntimeId === "claudecode") {
      return normalizeText(this.config.claudeModel);
    }
    const defaultModel = Array.isArray(catalog?.models)
      ? catalog.models.find((item) => item?.isDefault)
      : null;
    return normalizeText(defaultModel?.model);
  }

  resolveEffectiveModelLabel(runtimeId, selectedModel, catalog = null) {
    const selected = normalizeText(selectedModel);
    if (selected) {
      return selected;
    }
    return this.resolveRuntimeDefaultModel(runtimeId, catalog) || "(runtime default)";
  }

  async handleStarCommand(normalized) {
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: [
        "Liked Mossbridge? Star the public repo on GitHub:",
        "",
        "https://github.com/Aryuan026/Mossbridge",
      ].join("\n"),
      contextToken: normalized.contextToken,
    });
  }

  async handleHelpCommand(normalized) {
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: buildWeixinHelpText(),
      contextToken: normalized.contextToken,
    });
  }

  resolveWorkspaceRoot(bindingKey) {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    return sessionStore.getActiveWorkspaceRoot(bindingKey) || this.config.workspaceRoot;
  }

  async handleRuntimeEvent(event) {
    const failureReplyTarget = event?.type === "runtime.turn.failed"
      ? this.streamDelivery.resolveReplyTargetForRun({
          threadId: event?.payload?.threadId,
          turnId: event?.payload?.turnId,
        })
      : null;
    await this.streamDelivery.handleRuntimeEvent(event);
    if (!event) {
      return;
    }
    if (event.type === "runtime.turn.completed" || event.type === "runtime.turn.failed") {
      const completedRunKey = buildRunKey(event.payload.threadId, event.payload.turnId);
      const pendingOperations = this.pendingOperationByRunKey;
      const pendingOperation = pendingOperations?.get?.(completedRunKey) || null;
      if (pendingOperation && pendingOperations?.delete) {
        pendingOperations.delete(completedRunKey);
      }
      if (pendingOperation?.kind === "compact") {
        this.pendingAutoCompactByThreadId?.delete?.(event.payload.threadId);
      }
      const sessionStore = this.runtimeAdapter.getSessionStore();
      sessionStore.clearApprovalPrompt(event.payload.threadId);
      const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(event.payload.threadId);
      const wasWatchdogCancelled = Boolean(this.watchdogCancelledRunKeys?.delete?.(completedRunKey));
      if (
        event.type === "runtime.turn.failed"
        && !wasWatchdogCancelled
        && this.runtimeAdapter.describe().id === "claudecode"
        && linked?.bindingKey
        && linked?.workspaceRoot
      ) {
        sessionStore.clearPendingThreadIdForWorkspace?.(linked.bindingKey, linked.workspaceRoot);
        sessionStore.clearThreadIdForWorkspace?.(linked.bindingKey, linked.workspaceRoot);
      }
      await this.writebackRuntimeTurn({ event, linked });
      const scopeKey = linked?.bindingKey && linked?.workspaceRoot
        ? buildScopeKey(linked.bindingKey, linked.workspaceRoot)
        : "";
      if (scopeKey) {
        this.turnBoundaryScopeKeys.add(scopeKey);
      }
      try {
        this.turnGateStore.releaseThread(event.payload.threadId);
        if (
          event.type === "runtime.turn.failed"
          && !wasWatchdogCancelled
          && pendingOperation?.notify !== false
        ) {
          await this.sendFailureToThread(
            event.payload.threadId,
            event.payload.text || "❌ Execution failed",
            failureReplyTarget,
          );
        }
        if (typeof this.maybePreApplyAutoSessionRefreshAfterTurn === "function") {
          await this.maybePreApplyAutoSessionRefreshAfterTurn({ event, linked, pendingOperation });
        }
        if (linked?.bindingKey && linked?.workspaceRoot) {
          await this.flushPendingInboundMessages({
            bindingKey: linked.bindingKey,
            workspaceRoot: linked.workspaceRoot,
            ignoreBoundary: true,
          });
        } else {
          await this.flushPendingInboundMessages();
        }
        await this.flushPendingSystemMessages();
        if (
          pendingOperation?.kind === "compact"
          && event.type === "runtime.turn.completed"
          && pendingOperation.notify !== false
        ) {
          await this.channelAdapter.sendText({
            userId: pendingOperation.userId,
            text: `✅ Compact finished\nthread: ${event.payload.threadId}`,
            contextToken: pendingOperation.contextToken,
          }).catch(() => {});
        }
        const shouldKeepTyping = linked?.bindingKey && linked?.workspaceRoot
          ? (
            this.turnGateStore.isPending(linked.bindingKey, linked.workspaceRoot)
            || this.hasPendingInboundMessage(linked.bindingKey, linked.workspaceRoot)
          )
          : false;
        if (!shouldKeepTyping) {
          await this.stopTypingForThread(event.payload.threadId);
        }
        if (typeof this.maybeAutoCompactAfterTurn === "function") {
          await this.maybeAutoCompactAfterTurn({ event, linked, pendingOperation });
        }
        if (typeof this.recordBackgroundRuntimeSuccess === "function") {
          this.recordBackgroundRuntimeSuccess({ event });
        }
        if (typeof this.maybeCloseIdleSystemRuntimeClient === "function") {
          await this.maybeCloseIdleSystemRuntimeClient({ event, linked });
        }
      } finally {
        if (scopeKey) {
          this.turnBoundaryScopeKeys.delete(scopeKey);
        }
      }
      return;
    }
    if (event.type !== "runtime.approval.requested") {
      return;
    }
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const linked = sessionStore.findBindingForThreadId(event.payload.threadId);
    if (!linked?.workspaceRoot) {
      return;
    }
    const allowlist = sessionStore.getApprovalCommandAllowlistForWorkspace(linked.workspaceRoot);
    if (isForbiddenIdentitySeedFileRead(event.payload, { workspaceRoot: linked.workspaceRoot })) {
      const approvalResponse = buildApprovalResponsePayload(event.payload, "no");
      if (approvalResponse) {
        console.log(
          `[mossbridge] approval auto-denied forbidden identity seed read thread=${event.payload.threadId} requestId=${event.payload.requestId}`
        );
        sessionStore.clearApprovalPrompt(event.payload.threadId);
        await this.runtimeAdapter.respondApproval(approvalResponse).catch(() => {});
        this.threadStateStore.resolveApproval(event.payload.threadId, "running", event.payload.requestId);
      }
      return;
    }
    const shouldAutoApprove = isAutoApprovedStateDirOperation(event.payload, {
      ...this.config,
      workspaceRoot: linked.workspaceRoot,
    })
      || matchesBuiltInCommandPrefix(event.payload.commandTokens)
      || matchesCommandPrefix(event.payload.commandTokens, allowlist);
    if (!shouldAutoApprove) {
      const promptState = sessionStore.getApprovalPromptState(event.payload.threadId);
      const promptSignature = buildApprovalPromptSignature(event.payload);
      if (promptState?.signature && promptState.signature === promptSignature) {
        sessionStore.rememberApprovalPrompt(event.payload.threadId, event.payload.requestId, promptSignature);
        console.log(
          `[mossbridge] approval prompt deduped thread=${event.payload.threadId} requestId=${event.payload.requestId}`
        );
        return;
      }
      sessionStore.rememberApprovalPrompt(event.payload.threadId, event.payload.requestId, promptSignature);
      try {
        await this.sendApprovalPrompt({
          bindingKey: linked.bindingKey,
          approval: event.payload,
        });
      } catch (error) {
        sessionStore.clearApprovalPrompt(event.payload.threadId);
        const approvalResponse = buildApprovalResponsePayload(event.payload, "no");
        if (approvalResponse) {
          await this.runtimeAdapter.respondApproval(approvalResponse).catch(() => {});
          this.threadStateStore.resolveApproval(event.payload.threadId, "running", event.payload.requestId);
          console.warn(
            `[mossbridge] approval prompt delivery failed; auto-denied request thread=${event.payload.threadId} requestId=${event.payload.requestId} error=${formatErrorMessage(error)}`
          );
          return;
        }
        throw error;
      }
      return;
    }
    const approvalResponse = buildApprovalResponsePayload(event.payload, "yes");
    if (!approvalResponse) {
      sessionStore.clearApprovalPrompt(event.payload.threadId);
      await this.sendApprovalPrompt({
        bindingKey: linked.bindingKey,
        approval: event.payload,
      }).catch(() => {});
      return;
    }
    await this.runtimeAdapter.respondApproval(approvalResponse).catch(() => {});
    this.threadStateStore.resolveApproval(event.payload.threadId, "running", event.payload.requestId);
  }

  async maybeCloseIdleSystemRuntimeClient({ event, linked } = {}) {
    if (event?.type !== "runtime.turn.completed" && event?.type !== "runtime.turn.failed") {
      return;
    }
    const runtimeId = normalizeCommandArgument(this.runtimeAdapter?.describe?.().id);
    if (runtimeId !== "claudecode" || typeof this.runtimeAdapter?.closeIdleSystemClient !== "function") {
      return;
    }

    const sessionStore = this.runtimeAdapter.getSessionStore?.();
    const bindingKey = normalizeCommandArgument(linked?.bindingKey);
    const binding = bindingKey && typeof sessionStore?.getBinding === "function"
      ? sessionStore.getBinding(bindingKey)
      : null;
    const isSystemRuntimeBinding = Boolean(
      linked?.systemRuntimeBinding
      || binding?.systemRuntimeBinding
      || bindingKey.includes("#mossbridge-system")
    );
    if (!isSystemRuntimeBinding) {
      return;
    }

    const threadId = normalizeCommandArgument(event?.payload?.threadId);
    const workspaceRoot = normalizeCommandArgument(linked?.workspaceRoot || binding?.activeWorkspaceRoot);
    if (!threadId && !workspaceRoot) {
      return;
    }

    const result = await this.runtimeAdapter.closeIdleSystemClient({
      threadId,
      workspaceRoot,
      bindingKey,
      systemRuntimeBinding: true,
      systemToolProfile: normalizeCommandArgument(binding?.systemToolProfile || linked?.systemToolProfile || linked?.toolProfile),
    }).catch((error) => {
      console.warn(
        `[mossbridge] idle system claudecode cleanup skipped thread=${threadId || "(none)"} binding=${bindingKey || "(none)"} ${formatErrorMessage(error)}`
      );
      return null;
    });
    if (result?.closed) {
      console.log(
        `[mossbridge] closed idle system claudecode client thread=${threadId || "(none)"} binding=${bindingKey || "(none)"}`
      );
    }
  }

  async stopTypingForThread(threadId) {
    const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(threadId);
    const target = linked?.bindingKey ? this.resolveReplyTargetForBinding(linked.bindingKey) : null;
    if (!target) {
      return;
    }
    await this.channelAdapter.sendTyping({
      userId: target.userId,
      status: 0,
      contextToken: target.contextToken,
    }).catch(() => {});
  }

  async sendFailureToThread(threadId, text, fallbackTarget = null) {
    const linked = this.runtimeAdapter.getSessionStore().findBindingForThreadId(threadId);
    const target = normalizeReplyTarget(
      linked?.bindingKey ? this.resolveReplyTargetForBinding(linked.bindingKey) : null
    ) || normalizeReplyTarget(fallbackTarget);
    if (!target) {
      return;
    }
    const rawText = normalizeText(text) || "❌ Execution failed";
    if (isRuntimeCapacitySignal(rawText)) {
      this.recordRuntimeNotice({
        text: rawText,
        threadId,
        source: "runtime_turn_failed",
        provider: target.provider,
        runtimeId: this.runtimeAdapter?.describe?.().id || this.config?.runtime || "runtime",
      });
    }
    if (target.provider === "system" && isClaudeRuntimeFailureText(rawText)) {
      const key = `${target.userId}:${classifyRuntimeFailureKind(rawText)}`;
      const lastAt = Number(this.lastSystemFailureNoticeAtByKey.get(key)) || 0;
      if (lastAt && Date.now() - lastAt < SYSTEM_FAILURE_NOTICE_THROTTLE_MS) {
        return;
      }
      this.lastSystemFailureNoticeAtByKey.set(key, Date.now());
    }
    const runtimeId = this.runtimeAdapter?.describe?.().id || this.config?.runtime || "runtime";
    const runtimeNotice = shieldRuntimeNoticeForDelivery(rawText, {
      provider: target.provider,
      runtimeId,
    });
    if (runtimeNotice.shielded && runtimeNotice.action === "silent") {
      return;
    }
    await this.channelAdapter.sendText({
      userId: target.userId,
      text: runtimeNotice.shielded
        ? runtimeNotice.text
        : formatRuntimeFailureForUser(rawText, { provider: target.provider, runtimeId }),
      contextToken: target.contextToken,
    }).catch(() => {});
  }

  async sendApprovalPrompt({ bindingKey, approval }) {
    const target = this.resolveReplyTargetForBinding(bindingKey);
    if (!target) {
      console.warn(
        `[mossbridge] approval prompt skipped binding=${bindingKey} requestId=${approval?.requestId || ""} reason=no_reply_target`
      );
      return;
    }
    console.log(
      `[mossbridge] approval prompt sending binding=${bindingKey} user=${target.userId} requestId=${approval?.requestId || ""}`
    );
    await this.channelAdapter.sendTyping({
      userId: target.userId,
      status: 0,
      contextToken: target.contextToken,
    }).catch(() => {});
    await this.channelAdapter.sendText({
      userId: target.userId,
      text: buildApprovalPromptText(approval),
      contextToken: target.contextToken,
      preserveBlock: true,
    });
    console.log(
      `[mossbridge] approval prompt delivered binding=${bindingKey} user=${target.userId} requestId=${approval?.requestId || ""}`
    );
  }

  async restoreBoundThreadSubscriptions() {
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const bindings = sessionStore.listBindings();
    const seenThreadIds = new Set();

    for (const binding of bindings) {
      const bindingKey = normalizeText(binding?.bindingKey);
      if (!bindingKey) {
        continue;
      }
      if (binding?.systemRuntimeBinding) {
        continue;
      }

      const target = this.resolveReplyTargetForBinding(bindingKey);
      if (target) {
        this.streamDelivery.setReplyTarget(bindingKey, target);
      }

      for (const workspaceRoot of sessionStore.listWorkspaceRoots(bindingKey)) {
        const normalizedWorkspaceRoot = normalizeCommandArgument(workspaceRoot);
        const normalizedThreadId = normalizeCommandArgument(
          sessionStore.getThreadIdForWorkspace(bindingKey, normalizedWorkspaceRoot)
        );
        if (!normalizedThreadId || seenThreadIds.has(normalizedThreadId)) {
          continue;
        }
        seenThreadIds.add(normalizedThreadId);
        await this.runtimeAdapter.resumeThread({
          threadId: normalizedThreadId,
          workspaceRoot: normalizedWorkspaceRoot,
          bindingKey,
          model: sessionStore.getRuntimeParamsForWorkspace(bindingKey, normalizedWorkspaceRoot).model,
        }).catch(() => {});
      }
    }
  }

  resolveReplyTargetForBinding(bindingKey) {
    const binding = this.runtimeAdapter.getSessionStore().getBinding(bindingKey) || null;
    const userId = normalizeCommandArgument(binding?.senderId);
    if (!userId) {
      return null;
    }
    const contextToken = this.channelAdapter.getKnownContextTokens()[userId] || "";
    if (!contextToken) {
      return null;
    }
    return {
      userId,
      contextToken,
      provider: "weixin",
    };
  }

  async attachMemoryContextToPreparedText(normalized, runtimeText, workspaceRoot) {
    const baseText = String(runtimeText || "").trim();
    const memoryDomain = this.projectDomains?.memory;
    if (!baseText || !memoryDomain || typeof memoryDomain.captureContextPacket !== "function") {
      return {
        text: baseText,
        packet: null,
      };
    }

    try {
      if (!this.residentAnchorPreludeKeys) {
        this.residentAnchorPreludeKeys = new Set();
      }
      const residentPreludeKey = this.resolveResidentAnchorPreludeKey?.(normalized, workspaceRoot) || "";
      const residentAlreadyDelivered = Boolean(
        residentPreludeKey && this.residentAnchorPreludeKeys.has(residentPreludeKey),
      );
      const stableGuidanceKey = this.resolveStableTurnGuidanceKey?.(normalized, workspaceRoot) || "";
      const includeRuntimeMaintenanceGuidance = shouldIncludeRuntimeMaintenanceGuidance(
        normalized,
        stableGuidanceKey,
        this.stableTurnGuidanceKeys,
      );
      const contextPressure = this.resolveMemoryContextPressureProfile?.(normalized, workspaceRoot) || null;
      const forceRecentContext = this.shouldForceRecentContextForPrepared?.(normalized, workspaceRoot) || false;
      const packet = await memoryDomain.captureContextPacket({
        userId: normalized.senderId,
        senderId: normalized.senderId,
        query: normalizeText(normalized.originalText) || normalizeText(normalized.text) || baseText,
        receivedAt: normalized.receivedAt,
        sourceClient: normalized.provider === "system" ? "mossbridge_system_turn" : "mossbridge_wechat",
        recallMode: normalized.provider === "system" ? "proactive" : "user_triggered",
        channelId: "weixin",
        workspaceRoot,
        currentTurnSignals: buildCurrentTurnSignalsForMemory(normalized),
        forceRecentContext,
        ...buildMemoryCapturePressureOptions(normalized, {
          residentAlreadyDelivered,
          includeRuntimePreludeGuidance: includeRuntimeMaintenanceGuidance,
          contextPressure,
          forceRecentContext,
        }),
      });
      if (
        !residentAlreadyDelivered
        && residentPreludeKey
        && (Number(packet?.resident_warm_packet?.hit_count) || 0) > 0
      ) {
        this.residentAnchorPreludeKeys.add(residentPreludeKey);
      }
      const prelude = normalizeText(packet?.runtime_prelude || packet?.summary);
      const frontstageNote = "";
      const toolHoverNote = "";
      const sections = [frontstageNote, toolHoverNote, prelude].filter(Boolean);
      const augmentedText = sections.length
        ? `${sections.join("\n\n")}\n\n===== Current Inbound Message =====\n${baseText}`
        : baseText;
      const delivery = buildMemoryDeliveryReport({
        normalized,
        baseText,
        frontstageNote,
        toolHoverNote,
        prelude,
        sections,
        runtimeText: augmentedText,
        contextPressure,
        includeStableTurnGuidance: includeRuntimeMaintenanceGuidance,
        residentAlreadyDelivered,
      });
      const packetWithDelivery = packet && typeof packet === "object"
        ? { ...packet, delivery }
        : packet;
      this.recordControlEvent?.({
        type: "memory.context.delivered",
        layer: CONTROL_LAYER.TACTICAL,
        scope: CONTROL_SCOPE.MEMORY,
        source: "app.attachMemoryContextToPreparedText",
        subject: normalized.provider === "system" ? "system_turn" : "wechat_turn",
        reason: "context_packet_capture",
        outcome: sections.length ? "prompt_augmented" : "packet_only",
        payload: {
          workspaceRoot,
          sourceClient: normalized.provider === "system" ? "mossbridge_system_turn" : "mossbridge_wechat",
          retrieval: packet?.retrieval || null,
          warmHitCount: Number(packet?.warm_memory_packet?.hit_count) || 0,
          residentHitCount: Number(packet?.resident_warm_packet?.hit_count) || 0,
          ongoingHitCount: Number(packet?.ongoing_track_packet?.hit_count) || 0,
          episodeHitCount: Number(packet?.episode_journal_packet?.hit_count) || 0,
          observationHitCount: Number(packet?.observation_journal_packet?.hit_count) || 0,
          delivery,
        },
      });
      if (includeRuntimeMaintenanceGuidance && stableGuidanceKey) {
        this.markStableTurnGuidanceDelivered(stableGuidanceKey);
      }
      if (!sections.length) {
        return {
          text: augmentedText,
          packet: packetWithDelivery,
        };
      }
      return {
        text: augmentedText,
        packet: packetWithDelivery,
      };
    } catch (error) {
      this.recordControlEvent?.({
        type: "memory.context.skipped",
        layer: CONTROL_LAYER.TACTICAL,
        scope: CONTROL_SCOPE.MEMORY,
        source: "app.attachMemoryContextToPreparedText",
        subject: normalized.provider === "system" ? "system_turn" : "wechat_turn",
        severity: CONTROL_SEVERITY.WARN,
        reason: "context_packet_failed",
        outcome: "base_text_only",
        payload: {
          workspaceRoot,
          error: formatErrorMessage(error),
        },
      });
      console.warn(`[mossbridge] memory context skipped: ${formatErrorMessage(error)}`);
      return {
        text: baseText,
        packet: null,
      };
    }
  }

  resolveResidentAnchorPreludeKey(normalized = {}, workspaceRoot = "") {
    const senderId = normalizeCommandArgument(normalized.senderId || normalized.chatId);
    if (!senderId) {
      return "";
    }
    const runtimeId = normalizeCommandArgument(this.runtimeAdapter?.describe?.().id) || "runtime";
    const root = normalizeCommandArgument(workspaceRoot) || normalizeCommandArgument(this.config?.workspaceRoot) || "workspace";
    const sessionStore = this.runtimeAdapter?.getSessionStore?.();
    let bindingKey = "";
    try {
      bindingKey = sessionStore?.buildBindingKey?.({
        workspaceId: normalized.workspaceId || this.config?.workspaceId,
        accountId: normalized.accountId || this.activeAccountId || this.config?.accountId,
        senderId,
      }) || "";
    } catch {
      bindingKey = "";
    }
    const identityKey = normalizeCommandArgument(bindingKey) || senderId;
    let threadId = "";
    try {
      threadId = sessionStore?.getThreadIdForWorkspace?.(identityKey, root) || "";
    } catch {
      threadId = "";
    }
    return [runtimeId, identityKey, root, normalizeCommandArgument(threadId) || "opening"].join("::");
  }

  resolveStableTurnGuidanceKey(normalized = {}, workspaceRoot = "") {
    return this.resolveResidentAnchorPreludeKey(normalized, workspaceRoot);
  }

  markStableTurnGuidanceDelivered(key) {
    const normalized = normalizeCommandArgument(key);
    if (!normalized) {
      return;
    }
    if (!this.stableTurnGuidanceKeys) {
      this.stableTurnGuidanceKeys = new Set();
    }
    this.stableTurnGuidanceKeys.add(normalized);
    if (this.stableTurnGuidanceKeys.size > 500) {
      const firstKey = this.stableTurnGuidanceKeys.values().next().value;
      this.stableTurnGuidanceKeys.delete(firstKey);
    }
  }

  resolveMemoryContextPressureProfile(normalized = {}, workspaceRoot = "") {
    const runtimeId = normalizeCommandArgument(this.runtimeAdapter?.describe?.().id) || this.config?.runtime || "";
    const threadId = this.resolvePreparedRuntimeThreadId?.(normalized, workspaceRoot) || "";
    let context = null;
    try {
      context = this.runtimeContextUsageStore?.getContext?.({ threadId, runtimeId }) || null;
    } catch {
      context = null;
    }
    const currentTokens = Number(context?.currentTokens) || 0;
    const contextWindow = Number(context?.contextWindow)
      || (normalizeText(runtimeId).toLowerCase() === "claudecode" ? Number(this.config?.claudeContextWindow) || 0 : 0);
    if (!currentTokens || !contextWindow) {
      return { level: "normal", ratio: 0, currentTokens, contextWindow };
    }
    const ratio = currentTokens / contextWindow;
    const level = ratio >= 0.75 ? "high" : (ratio >= 0.6 ? "warm" : "normal");
    return { level, ratio, currentTokens, contextWindow, threadId };
  }

  resolvePreparedRuntimeThreadId(normalized = {}, workspaceRoot = "") {
    const senderId = normalizeCommandArgument(normalized.runtimeBindingSenderId || normalized.senderId || normalized.chatId);
    if (!senderId) {
      return "";
    }
    const sessionStore = this.runtimeAdapter?.getSessionStore?.();
    if (!sessionStore || typeof sessionStore.buildBindingKey !== "function") {
      return "";
    }
    let bindingKey = "";
    try {
      bindingKey = sessionStore.buildBindingKey({
        workspaceId: normalized.workspaceId || this.config?.workspaceId,
        accountId: normalized.accountId || this.activeAccountId || this.config?.accountId,
        senderId,
      });
    } catch {
      bindingKey = "";
    }
    if (!bindingKey || typeof sessionStore.getThreadIdForWorkspace !== "function") {
      return "";
    }
    try {
      return normalizeCommandArgument(sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot));
    } catch {
      return "";
    }
  }

  shouldForceRecentContextForPrepared(normalized = {}, workspaceRoot = "") {
    if (normalizeText(normalized?.provider) === "system") {
      return false;
    }
    const senderId = normalizeCommandArgument(normalized.runtimeBindingSenderId || normalized.senderId || normalized.chatId);
    if (!senderId) {
      return false;
    }
    const sessionStore = this.runtimeAdapter?.getSessionStore?.();
    if (!sessionStore || typeof sessionStore.buildBindingKey !== "function") {
      return false;
    }
    let bindingKey = "";
    try {
      bindingKey = sessionStore.buildBindingKey({
        workspaceId: normalized.workspaceId || this.config?.workspaceId,
        accountId: normalized.accountId || this.activeAccountId || this.config?.accountId,
        senderId,
      });
    } catch {
      bindingKey = "";
    }
    if (!bindingKey) {
      return false;
    }
    const runtimeId = normalizeCommandArgument(this.runtimeAdapter?.describe?.().id)
      || normalizeCommandArgument(this.config?.runtime)
      || "codex";
    const root = normalizeCommandArgument(workspaceRoot) || normalizeCommandArgument(this.config?.workspaceRoot);
    let threadId = "";
    try {
      threadId = sessionStore.getThreadIdForWorkspace?.(bindingKey, root) || "";
    } catch {
      threadId = "";
    }
    if (!threadId) {
      return true;
    }
    try {
      if (this.sessionRefreshRequests?.getPendingRequest?.({
        bindingKey,
        workspaceRoot: root,
        runtimeId,
      })) {
        return true;
      }
      return Boolean(this.sessionRefreshRequests?.consumePostRefreshGrace?.({
        bindingKey,
        workspaceRoot: root,
        runtimeId,
        threadId,
      })?.active);
    } catch {
      return false;
    }
  }

  rememberTurnWritebackContext({ turn, prepared, bindingKey, workspaceRoot, dispatchedAtMs = 0 }) {
    const snapshot = {
      bindingKey,
      workspaceRoot,
      dispatchedAtMs: Number(dispatchedAtMs) || 0,
      prepared: {
        workspaceId: prepared.workspaceId,
        accountId: prepared.accountId,
        senderId: prepared.senderId,
        provider: prepared.provider,
        originalText: prepared.originalText,
        runtimeText: prepared.runtimeText,
        text: prepared.text,
        attachments: prepared.attachments || [],
        attachmentFailures: prepared.attachmentFailures || [],
        receivedAt: prepared.receivedAt,
        memoryContextPacket: prepared.memoryContextPacket || null,
        systemTurn: prepared.systemTurn || null,
      },
      model: this.runtimeAdapter.getSessionStore().getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model || "",
    };
    const turnId = normalizeCommandArgument(turn?.turnId);
    const threadId = normalizeCommandArgument(turn?.threadId);
    if (threadId && turnId) {
      this.turnWritebackContextByRunKey.set(buildRunKey(threadId, turnId), snapshot);
      return;
    }
    if (threadId) {
      this.pendingTurnWritebackByThreadId.set(threadId, snapshot);
    }
  }

  consumeTurnWritebackContext(threadId, turnId) {
    const normalizedThreadId = normalizeCommandArgument(threadId);
    const normalizedTurnId = normalizeCommandArgument(turnId);
    const runKey = buildRunKey(normalizedThreadId, normalizedTurnId);
    const exact = this.turnWritebackContextByRunKey.get(runKey) || null;
    if (exact) {
      this.turnWritebackContextByRunKey.delete(runKey);
      return exact;
    }
    if (!normalizedThreadId) {
      return null;
    }
    const pending = this.pendingTurnWritebackByThreadId.get(normalizedThreadId) || null;
    if (pending) {
      this.pendingTurnWritebackByThreadId.delete(normalizedThreadId);
    }
    return pending;
  }

  async writebackRuntimeTurn({ event, linked }) {
    const memoryDomain = this.projectDomains?.memory;
    if (!memoryDomain || typeof memoryDomain.writebackTurn !== "function") {
      return;
    }
    const snapshot = this.consumeTurnWritebackContext(event?.payload?.threadId, event?.payload?.turnId);
    if (!snapshot?.prepared?.senderId) {
      return;
    }
    const threadState = this.threadStateStore.getThreadState(event.payload.threadId);
    const rawAssistantTextFinal = normalizeText(event?.payload?.text) || normalizeText(threadState?.lastReplyText);
    const runtimeCapacityNotice = isRuntimeCapacitySignal(rawAssistantTextFinal);
    const runtimeFailureNotice = event.type === "runtime.turn.failed";
    const assistantTextFinal = runtimeCapacityNotice || runtimeFailureNotice ? "" : rawAssistantTextFinal;
    const role = snapshot.prepared.provider === "system" ? "system" : "user";
    const incomingTextForCache = buildIncomingTextForConversationCache(snapshot.prepared);
    const incomingAttachmentRefs = buildAttachmentRefsForWriteback(snapshot.prepared.attachments || []);
    const incomingMessageForCache = {
      role,
      content: incomingTextForCache,
      timestamp: snapshot.prepared.receivedAt || new Date().toISOString(),
    };
    if (incomingAttachmentRefs.length) {
      incomingMessageForCache.attachments = incomingAttachmentRefs;
      incomingMessageForCache.attachment_refs = incomingAttachmentRefs;
    }
    let writebackResult = null;
    let writebackError = null;
    try {
      writebackResult = await memoryDomain.writebackTurn({
        userId: snapshot.prepared.senderId,
        senderId: snapshot.prepared.senderId,
        accountId: snapshot.prepared.accountId,
        query: incomingTextForCache,
        incomingMessages: [incomingMessageForCache],
        outboundMessages: assistantTextFinal
          ? [
              {
                role: "assistant",
                content: assistantTextFinal,
                timestamp: new Date().toISOString(),
              },
            ]
          : [],
        assistantTextFinal,
        status: event.type === "runtime.turn.completed" && !runtimeCapacityNotice ? "ok" : "error",
        error: runtimeCapacityNotice
          ? rawAssistantTextFinal
          : (runtimeFailureNotice ? normalizeText(event?.payload?.text) : ""),
        routeId: linked?.bindingKey || snapshot.bindingKey,
        transportId: snapshot.prepared.provider === "system" ? "system" : "weixin",
        runtimeId: this.runtimeAdapter.describe().id,
        channelId: "weixin",
        endpointId: event.type,
        threadId: event.payload.threadId,
        model: snapshot.model,
        latencyMs: snapshot.dispatchedAtMs ? Math.max(0, Date.now() - snapshot.dispatchedAtMs) : 0,
        sourceClient: snapshot.prepared.provider === "system" ? "mossbridge_system_turn" : "mossbridge_wechat",
        memoryContextPacket: snapshot.prepared.memoryContextPacket || null,
        systemTurn: snapshot.prepared.provider === "system"
          ? {
              active: true,
              trigger_text: incomingTextForCache,
              ...(snapshot.prepared.systemTurn || {}),
            }
          : {},
      });
      if (event.type === "runtime.turn.completed") {
        await finalizeAttachmentNotes({
          attachments: snapshot.prepared.attachments || [],
          assistantTextFinal,
          writebackResult,
          completedAt: new Date().toISOString(),
        });
      }
      this.recordControlEvent?.({
        type: "memory.turn.writeback",
        layer: CONTROL_LAYER.EXECUTIVE,
        scope: CONTROL_SCOPE.MEMORY,
        source: "app.writebackRuntimeTurn",
        subject: event.payload.threadId,
        reason: "runtime_turn_finished",
        outcome: event.type === "runtime.turn.completed" && !runtimeCapacityNotice ? "ok" : "error",
        correlationId: buildRunKey(event.payload.threadId, event.payload.turnId),
        payload: {
          provider: snapshot.prepared.provider,
          transportId: snapshot.prepared.provider === "system" ? "system" : "weixin",
          runtimeId: this.runtimeAdapter.describe().id,
          endpointId: event.type,
          model: snapshot.model,
          latencyMs: snapshot.dispatchedAtMs ? Math.max(0, Date.now() - snapshot.dispatchedAtMs) : 0,
          hasAssistantText: Boolean(assistantTextFinal),
          runtimeCapacityNotice,
          runtimeFailureNotice,
        },
      });
    } catch (error) {
      writebackError = error;
      this.recordControlEvent?.({
        type: "memory.turn.writeback_failed",
        layer: CONTROL_LAYER.EXECUTIVE,
        scope: CONTROL_SCOPE.MEMORY,
        source: "app.writebackRuntimeTurn",
        subject: event?.payload?.threadId,
        severity: CONTROL_SEVERITY.WARN,
        reason: "memory_writeback_failed",
        outcome: "skipped",
        correlationId: buildRunKey(event?.payload?.threadId, event?.payload?.turnId),
        payload: {
          provider: snapshot.prepared.provider,
          error: formatErrorMessage(error),
        },
      });
      console.warn(`[mossbridge] writeback skipped thread=${event?.payload?.threadId || ""} ${formatErrorMessage(error)}`);
    } finally {
      this.completeMemoryMetabolismAttempt?.({
        snapshot,
        event,
        assistantTextFinal: rawAssistantTextFinal,
        writebackResult,
        writebackError,
      });
    }
  }

  completeMemoryMetabolismAttempt({
    snapshot = null,
    event = null,
    assistantTextFinal = "",
    writebackResult = null,
    writebackError = null,
  } = {}) {
    const systemTurn = snapshot?.prepared?.systemTurn || null;
    if (!this.memoryMetabolismService || !isDreamingSystemTurn(systemTurn)) {
      return;
    }
    try {
      const result = this.memoryMetabolismService.completeRuntimeAttempt({
        systemTurn,
        eventType: event?.type || "",
        assistantTextFinal,
        writebackResult,
        writebackError,
      });
      this.recordControlEvent?.({
        type: result?.ok ? "memory.dreaming.completed" : "memory.dreaming.incomplete",
        layer: CONTROL_LAYER.EXECUTIVE,
        scope: CONTROL_SCOPE.MEMORY,
        source: "app.completeMemoryMetabolismAttempt",
        subject: resolveDreamingAttemptId(systemTurn) || "",
        severity: result?.ok ? CONTROL_SEVERITY.INFO : CONTROL_SEVERITY.WARN,
        reason: result?.reason || (result?.ok ? "receipt_complete" : "receipt_incomplete"),
        outcome: result?.ok ? "complete" : "retry_later",
        correlationId: buildRunKey(event?.payload?.threadId, event?.payload?.turnId),
        payload: {
          attemptId: resolveDreamingAttemptId(systemTurn) || "",
          eventType: event?.type || "",
          handled: Boolean(result?.handled),
          ok: Boolean(result?.ok),
          mutationCount: Number(result?.mutation_count) || Number(result?.mutationCount) || 0,
          writebackError: writebackError ? formatErrorMessage(writebackError) : "",
        },
      });
      if (result?.handled && !result.ok) {
        console.warn(
          `[mossbridge] dreaming incomplete attempt=${resolveDreamingAttemptId(systemTurn) || ""} reason=${result.reason || "unknown"}`,
        );
      }
    } catch (error) {
      console.warn(`[mossbridge] dreaming completion gate failed ${formatErrorMessage(error)}`);
    }
  }
}

function buildWechatFrontstageTurnNote(normalized = {}) {
  if (normalizeText(normalized?.provider) === "system") {
    return "";
  }
  return [
    "[微信前台对话提醒]",
    "这是和用户的一对一自然微信对话，不是工具回执、调试报告或工程答复；后台 short/concise 不支配前台表达。",
    "用户发来的 emoji、表情包或括号小动作只作为情绪线索；回应时用自然语言、普通 emoji 或当下合适的动作感来承接。",
    "关系、情绪和事实不用排队。按当下最合适的节奏回应：该直接推进就推进，该共情就共情，该调侃就调侃，该短短接话就短短接话；让开场从这一轮真实语境里长出来。",
  ].join("\n");
}

function buildWechatToolHoverNote(normalized = {}) {
  const provider = normalizeText(normalized?.provider);
  if (provider && !["weixin", "system"].includes(provider)) {
    return "";
  }
  const attachmentCount = Array.isArray(normalized?.attachments) ? normalized.attachments.length : 0;
  const lines = [
    "[当前可用动作提醒]",
    "这些能力可以按需主动拿起，不必等用户点名；但它们不是本轮任务清单，也不是前台说话风格。不适合就完全忽略。",
    "- 表情包：当一张贴图能自然补一层温度、玩笑、庆祝、撒娇或软着陆时，可以先用自然意图搜索表情仓再发送；先说清楚该说的话，贴图只做附加表达。",
    "- 记忆、日记、episode、观察：如果这一轮出现未来会复用的信息、可修正印象或一个小事件，可以静默维护，不必等用户用工具名提醒。",
    "- AI 日历/提醒：如果你已经看见一个未来检查点、后续动作、持续任务，或“到那个时间再带着工具醒来处理”的机会，请直接创建提醒/AI 日历唤醒；到期唤醒会携带完整工具能力，适合执行、检查、写记录或决定是否联系用户，随机心跳只负责轻量续联。",
    "- 文件/附件：如果已经生成本地文件且当前通道支持发送，可以直接发送；外部账号、设备或私有执行器只在已安装、已配置时才进入行动范围。",
    "这些能力是可用动作，不是关键词条件；用完工具后继续自然聊天，内部 id、协议、队列和路径留在后台。",
  ];
  if (attachmentCount > 0) {
    lines.splice(
      5,
      0,
      "- 附件/图片：先把可见内容和意义接进当前回复；如果图片明显适合沉淀为表情包、episode 素材或附件说明，可以顺手维护对应仓位。",
    );
  }
  return lines.join("\n");
}

function buildIncomingTextForConversationCache(prepared = {}) {
  const originalText = normalizeText(prepared.originalText);
  const fallbackText = normalizeText(prepared.runtimeText) || normalizeText(prepared.text);
  const attachmentContext = buildAttachmentContextForConversationCache(prepared);
  if (attachmentContext) {
    return [originalText, attachmentContext].filter(Boolean).join("\n\n");
  }
  return originalText || fallbackText;
}

function buildAttachmentRefsForWriteback(attachments = []) {
  const rows = [];
  for (const item of Array.isArray(attachments) ? attachments : []) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const pathRef = normalizeText(item.relativePath) || normalizeText(item.path) || normalizeText(item.absolutePath);
    const notePath = normalizeText(item.noteRelativePath)
      || normalizeText(item.notePath)
      || normalizeText(item.noteAbsolutePath);
    const ref = {};
    assignNormalizedField(ref, "kind", item.kind);
    assignNormalizedField(ref, "path", pathRef);
    assignNormalizedField(ref, "absolute_path", item.absolutePath);
    assignNormalizedField(ref, "note_path", notePath);
    assignNormalizedField(ref, "note_absolute_path", item.noteAbsolutePath);
    assignNormalizedField(ref, "file_name", item.fileName);
    assignNormalizedField(ref, "source_file_name", item.sourceFileName);
    assignNormalizedField(ref, "content_type", item.contentType);
    if (item.isImage !== undefined) {
      ref.is_image = Boolean(item.isImage);
    }
    if (Object.keys(ref).length && (ref.path || ref.note_path || ref.absolute_path || ref.note_absolute_path)) {
      rows.push(ref);
    }
  }
  return rows;
}

function assignNormalizedField(target, key, value) {
  const normalized = normalizeText(value);
  if (normalized) {
    target[key] = normalized;
  }
}

function buildAttachmentContextForConversationCache(prepared = {}) {
  const attachments = Array.isArray(prepared.attachments) ? prepared.attachments : [];
  const failures = Array.isArray(prepared.attachmentFailures) ? prepared.attachmentFailures : [];
  const lines = [];
  if (attachments.length) {
    lines.push("Attachment context:");
    for (const item of attachments) {
      const kind = normalizeText(item?.kind) || "file";
      const file = normalizeText(item?.relativePath) || normalizeText(item?.absolutePath) || normalizeText(item?.fileName);
      const note = normalizeText(item?.noteRelativePath) || normalizeText(item?.noteAbsolutePath);
      if (file) {
        lines.push(`- [${kind}] file: ${file}`);
      }
      if (note) {
        lines.push(`  note: ${note}`);
      }
    }
  }
  if (failures.length) {
    if (!lines.length) {
      lines.push("Attachment context:");
    }
    lines.push("Attachment intake errors:");
    for (const item of failures) {
      const label = normalizeText(item?.sourceFileName) || normalizeText(item?.kind) || "attachment";
      const reason = normalizeText(item?.reason) || "unknown error";
      lines.push(`- ${label}: ${reason}`);
    }
  }
  return lines.join("\n").trim();
}

function buildRunKey(threadId, turnId) {
  return `${normalizeCommandArgument(threadId)}:${normalizeCommandArgument(turnId)}`;
}

function isDirectVisibleReplySystemMessage(message = {}) {
  const kind = normalizeText(message?.kind).toLowerCase();
  return kind === "reply" || kind === "direct_reply";
}

function shouldSuppressVisibleRuntimeStatus(normalized = {}) {
  return isBackgroundRuntimeCircuitOpportunity(normalized);
}

function isBackgroundRuntimeCircuitOpportunity(normalized = {}) {
  if (normalizeText(normalized?.provider) !== "system") {
    return false;
  }
  return isBackgroundRuntimeCircuitKind(describeSystemTriggerKind(normalized));
}

function isBackgroundCheckinOpportunity(normalized = {}) {
  if (normalizeText(normalized?.provider) !== "system") {
    return false;
  }
  return describeSystemTriggerKind(normalized) === "checkin_opportunity";
}

function describeSystemTriggerKind(normalized = {}) {
  return normalizeText(
    normalized?.systemTurn?.trigger_kind
      || normalized?.systemTurn?.triggerKind
      || normalized?.system_turn?.trigger_kind
      || normalized?.system_turn?.triggerKind
      || normalized?.kind
      || normalized?.metadata?.checkinKind,
  );
}

function isCheckinOpportunityMessage(message = {}) {
  return normalizeText(message?.kind) === "checkin_opportunity";
}

function isDreamingSystemMessage(message = {}) {
  const kind = normalizeText(message?.kind).toLowerCase();
  return kind === "dreaming_opportunity" || kind === "memory_metabolism";
}

function isBackgroundRuntimeCircuitSystemMessage(message = {}) {
  return isCheckinOpportunityMessage(message) || isDreamingSystemMessage(message);
}

function isBackgroundRuntimeCircuitKind(kind = "") {
  const normalized = normalizeText(kind).toLowerCase();
  return normalized === "checkin_opportunity"
    || normalized === "dreaming_opportunity"
    || normalized === "memory_metabolism";
}

function applySystemBudgetPolicyToMessage(message = {}, budgetPolicy = {}) {
  if (budgetPolicy?.action !== "allow_compact") {
    return message;
  }
  return {
    ...message,
    metadata: {
      ...(message?.metadata && typeof message.metadata === "object" ? message.metadata : {}),
      budgetPosture: budgetPolicy.budgetPosture || "daily_budget_exceeded",
      budgetPolicy: "compact",
      budgetReason: budgetPolicy.reason || "daily_system_budget",
      compactRuntimeTextMaxChars: Number(budgetPolicy.compactRuntimeTextMaxChars) || 0,
    },
  };
}

function applySystemToolProfileToMessage(message = {}) {
  const systemToolProfile = resolveSystemToolProfileForMessage(message);
  if (!systemToolProfile || systemToolProfile === "full") {
    return message;
  }
  return {
    ...message,
    metadata: {
      ...(message?.metadata && typeof message.metadata === "object" ? message.metadata : {}),
      systemToolProfile,
    },
  };
}

function resolveSystemToolProfileForMessage(message = {}) {
  return isCheckinOpportunityMessage(message) ? "checkin_lite" : "full";
}

function resolveSystemTurnBudgetPolicyForDispatch(appLike, { kind = "", nowMs = Date.now() } = {}) {
  if (typeof appLike?.resolveSystemTurnBudgetPolicy === "function") {
    return appLike.resolveSystemTurnBudgetPolicy({ kind, nowMs });
  }
  return resolveSystemTurnBudgetPolicy({
    kind,
    config: appLike?.config || {},
    runtimeContextUsageStore: appLike?.runtimeContextUsageStore || null,
    nowMs,
  });
}

function buildMemoryCapturePressureOptions(
  normalized = {},
  {
    residentAlreadyDelivered = false,
    includeRuntimePreludeGuidance = false,
    contextPressure = null,
    forceRecentContext = false,
  } = {},
) {
  const pressureOptions = buildTokenPressureMemoryOptions(contextPressure, {
    background: isBackgroundCheckinOpportunity(normalized),
  });
  const forceRecentOptions = forceRecentContext
    ? {
        cacheLimit: 64,
        recallRecentRecordLimit: 24,
        ambientLimit: 3,
        preludeAmbientWarmLimit: 3,
        preludeRecentSnippetLimit: 0,
        preludeRecentThreadLimit: 12,
      }
    : {};
  if (!isBackgroundCheckinOpportunity(normalized)) {
    return {
      includeRuntimePreludeGuidance: Boolean(includeRuntimePreludeGuidance),
      residentLimit: residentAlreadyDelivered ? 0 : undefined,
      ...pressureOptions,
      ...forceRecentOptions,
    };
  }
  return {
    runtimeProfile: "proactive_lite",
    includeRuntimePreludeGuidance: Boolean(includeRuntimePreludeGuidance),
    cacheLimit: 16,
    recallRecentRecordLimit: 4,
    temporalRecallLimit: 4,
    limit: 3,
    residentLimit: residentAlreadyDelivered ? 0 : 2,
    preludeWarmLimit: 3,
    preludeResidentWarmLimit: residentAlreadyDelivered ? 0 : 2,
    preludeOngoingLimit: 3,
    preludeOngoingShadowLimit: 3,
    preludeObservationLimit: 1,
    preludeEpisodeLimit: 1,
    preludeHotUpstreamLimit: 2,
    preludeHotTurnLimit: 3,
    preludeHotSnapshotLimit: 1,
    preludeRecentSnippetLimit: 3,
    preludeRecentThreadLimit: 2,
    coldLimit: 1,
    coldVineLimit: 2,
    coldVinePerRootLimit: 1,
    ...pressureOptions,
    ...forceRecentOptions,
  };
}

function shouldIncludeStableTurnGuidance(stableGuidanceKey = "", deliveredKeys = null) {
  const key = normalizeCommandArgument(stableGuidanceKey);
  if (!key || key.endsWith("::opening")) {
    return false;
  }
  return !deliveredKeys || !deliveredKeys.has(key);
}

function shouldIncludeRuntimeMaintenanceGuidance(normalized = {}, stableGuidanceKey = "", deliveredKeys = null) {
  if (normalizeText(normalized?.provider) !== "system") {
    return false;
  }
  if (isBackgroundCheckinOpportunity(normalized)) {
    return false;
  }
  return shouldIncludeStableTurnGuidance(stableGuidanceKey, deliveredKeys);
}

function buildTokenPressureMemoryOptions(contextPressure = null, { background = false } = {}) {
  const level = normalizeText(contextPressure?.level);
  if (level === "high") {
    return background
      ? {
          cacheLimit: 10,
          recallRecentRecordLimit: 3,
          temporalRecallLimit: 3,
          limit: 2,
          preludeWarmLimit: 2,
          preludeOngoingLimit: 2,
          preludeOngoingShadowLimit: 2,
          preludeObservationLimit: 1,
          preludeEpisodeLimit: 1,
          preludeHotUpstreamLimit: 1,
          preludeHotTurnLimit: 2,
          preludeHotSnapshotLimit: 1,
          preludeRecentSnippetLimit: 2,
          preludeRecentThreadLimit: 1,
          coldLimit: 1,
          coldVineLimit: 1,
          coldVinePerRootLimit: 1,
        }
      : {
          limit: 4,
          preludeWarmLimit: 4,
          preludeOngoingLimit: 3,
          preludeOngoingShadowLimit: 3,
          preludeObservationLimit: 2,
          preludeEpisodeLimit: 2,
          preludeHotUpstreamLimit: 2,
          preludeHotTurnLimit: 3,
          preludeHotSnapshotLimit: 1,
          preludeRecentSnippetLimit: 2,
          preludeRecentThreadLimit: 2,
          coldLimit: 1,
          coldVineLimit: 1,
          coldVinePerRootLimit: 1,
        };
  }
  if (level === "warm") {
    return background
      ? {
          cacheLimit: 12,
          limit: 3,
          preludeHotUpstreamLimit: 2,
          preludeHotTurnLimit: 3,
          preludeHotSnapshotLimit: 1,
          preludeRecentSnippetLimit: 2,
          preludeRecentThreadLimit: 2,
          coldVineLimit: 1,
          coldVinePerRootLimit: 1,
        }
      : {
          preludeRecentSnippetLimit: 4,
          preludeRecentThreadLimit: 4,
          preludeHotUpstreamLimit: 3,
          preludeHotTurnLimit: 4,
          preludeHotSnapshotLimit: 1,
          coldVineLimit: 2,
          coldVinePerRootLimit: 1,
        };
  }
  return {};
}

function buildMemoryDeliveryReport({
  normalized = {},
  baseText = "",
  frontstageNote = "",
  toolHoverNote = "",
  prelude = "",
  sections = [],
  runtimeText = "",
  contextPressure = null,
  includeStableTurnGuidance = false,
  residentAlreadyDelivered = false,
} = {}) {
  const sectionRows = [
    ["frontstage_note", frontstageNote],
    ["tool_hover_note", toolHoverNote],
    ["memory_prelude", prelude],
    ["current_inbound", baseText],
  ].map(([name, text]) => {
    const normalizedText = String(text || "");
    return {
      name,
      delivered: Boolean(normalizedText.trim()),
      chars: normalizedText.length,
      estimated_tokens: estimatePromptTokens(normalizedText),
    };
  });
  return {
    mode: isBackgroundCheckinOpportunity(normalized) ? "heartbeat" : "inbound",
    provider: normalizeText(normalized?.provider) || "weixin",
    include_stable_guidance: Boolean(includeStableTurnGuidance),
    resident_anchor_repeated: Boolean(residentAlreadyDelivered),
    pressure_level: normalizeText(contextPressure?.level) || "normal",
    pressure_ratio: Number(contextPressure?.ratio) || 0,
    section_count: Array.isArray(sections) ? sections.length : 0,
    sections: sectionRows,
    total_chars: sectionRows.reduce((sum, row) => sum + row.chars, 0),
    estimated_tokens: sectionRows.reduce((sum, row) => sum + row.estimated_tokens, 0),
    runtime_prompt_chars: String(runtimeText || "").length,
    runtime_prompt_estimated_tokens: estimatePromptTokens(runtimeText),
    policy: "Delivery report is stored for diagnostics only; it is not injected into the runtime prompt.",
  };
}

function estimatePromptTokens(text = "") {
  const normalized = String(text || "");
  if (!normalized) {
    return 0;
  }
  const cjk = (normalized.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const nonCjk = Math.max(0, normalized.length - cjk);
  return Math.ceil(cjk + (nonCjk / 4));
}

function normalizeReplyTarget(target) {
  if (!target?.userId || !target?.contextToken) {
    return null;
  }
  return {
    userId: String(target.userId).trim(),
    contextToken: String(target.contextToken).trim(),
    provider: normalizeText(target.provider),
  };
}

function formatCompactNumber(value) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return "0";
  }
  if (normalized >= 1_000_000) {
    return `${Math.round(normalized / 100_000) / 10}m`;
  }
  if (normalized >= 1_000) {
    return `${Math.round(normalized / 100) / 10}k`;
  }
  return String(Math.round(normalized));
}

function buildRuntimeContextUsageSnapshot({ payload = {}, runtimeId = "", linked = null, config = {} } = {}) {
  const normalizedRuntimeId = normalizeText(runtimeId || payload.runtimeId).toLowerCase();
  const inputTokens = readNonNegativeNumber(payload.inputTokens) ?? 0;
  const cacheCreationInputTokens = readNonNegativeNumber(payload.cacheCreationInputTokens) ?? 0;
  const cacheReadInputTokens = readNonNegativeNumber(payload.cacheReadInputTokens) ?? 0;
  const outputTokens = readNonNegativeNumber(payload.outputTokens) ?? 0;
  const summedTokens = inputTokens + cacheCreationInputTokens + cacheReadInputTokens + outputTokens;
  const currentTokens = readNonNegativeNumber(payload.currentTokens) ?? summedTokens;
  const configuredWindow = readNonNegativeNumber(payload.contextWindow)
    ?? (normalizedRuntimeId === "claudecode" ? readNonNegativeNumber(config.claudeContextWindow) : 0)
    ?? 0;
  const reservedOutputTokens = normalizedRuntimeId === "claudecode"
    ? Math.max(0, readNonNegativeNumber(config.claudeMaxOutputTokens) ?? 0)
    : 0;
  const availableMessageWindow = configuredWindow > 0
    ? Math.max(0, configuredWindow - reservedOutputTokens)
    : 0;
  const compactThresholdPercent = clampPercent(config.claudeAutoCompactThresholdPercent, 85);
  const compactThresholdTokens = availableMessageWindow > 0
    ? Math.floor((availableMessageWindow * compactThresholdPercent) / 100)
    : 0;
  return {
    ...payload,
    runtimeId: normalizedRuntimeId,
    threadId: normalizeCommandArgument(payload.threadId),
    workspaceRoot: normalizeText(linked?.workspaceRoot),
    bindingKey: normalizeText(linked?.bindingKey),
    inputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    outputTokens,
    currentTokens,
    contextWindow: configuredWindow,
    reservedOutputTokens,
    availableMessageWindow,
    compactThresholdPercent,
    compactThresholdTokens,
  };
}

function evaluateClaudeAutoCompact(usage = {}, config = {}) {
  if (config.claudeAutoCompactEnabled === false) {
    return { shouldCompact: false, reason: "disabled" };
  }
  if (normalizeText(usage.runtimeId).toLowerCase() !== "claudecode") {
    return { shouldCompact: false, reason: "runtime_not_claudecode" };
  }
  const currentTokens = readNonNegativeNumber(usage.currentTokens) ?? 0;
  const compactThresholdTokens = readNonNegativeNumber(usage.compactThresholdTokens) ?? 0;
  if (compactThresholdTokens <= 0) {
    return { shouldCompact: false, reason: "context_window_unconfigured" };
  }
  if (currentTokens < compactThresholdTokens) {
    return { shouldCompact: false, reason: "below_threshold" };
  }
  return {
    shouldCompact: true,
    reason: "context_threshold",
    currentTokens,
    compactThresholdTokens,
    contextWindow: usage.contextWindow,
    availableMessageWindow: usage.availableMessageWindow,
    compactThresholdPercent: usage.compactThresholdPercent,
  };
}

function evaluateSessionAutoRefresh(usage = {}, config = {}) {
  if (Number(config.sessionRefreshPressurePercent) === 0) {
    return { shouldRefresh: false, reason: "disabled" };
  }
  const refreshThresholdPercent = clampPercent(
    config.sessionRefreshPressurePercent,
    DEFAULT_SESSION_REFRESH_PRESSURE_PERCENT,
  );
  const contextWindow = readNonNegativeNumber(usage.contextWindow) ?? 0;
  const currentTokens = readNonNegativeNumber(usage.currentTokens) ?? 0;
  const refreshThresholdTokens = contextWindow > 0
    ? Math.floor((contextWindow * refreshThresholdPercent) / 100)
    : 0;
  if (refreshThresholdTokens <= 0) {
    return { shouldRefresh: false, reason: "context_window_unavailable" };
  }
  if (currentTokens < refreshThresholdTokens) {
    return { shouldRefresh: false, reason: "below_threshold" };
  }
  return {
    shouldRefresh: true,
    reason: "context_pressure_session_refresh",
    currentTokens,
    contextWindow,
    refreshThresholdPercent,
    refreshThresholdTokens,
  };
}

function isAutoSessionRefreshRequest(request = {}) {
  const requestedBy = normalizeText(request.requestedBy).toLowerCase();
  const reason = normalizeText(request.reason).toLowerCase();
  return requestedBy.startsWith("auto_session")
    || requestedBy === "auto_context_pressure"
    || reason === "severe_context_pressure"
    || reason === "context_pressure_refresh"
    || reason === "context_pressure_session_refresh";
}

function readNonNegativeNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, parsed);
}

function clampPercent(value, fallback) {
  const parsed = Number(value);
  const safeValue = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(1, Math.min(99, Math.round(safeValue)));
}

function formatContextStatusLine({ runtimeName, context, claudeContextWindow, claudeMaxOutputTokens }) {
  if (runtimeName === "claudecode") {
    const configuredWindow = Number(claudeContextWindow);
    if (!Number.isFinite(configuredWindow) || configuredWindow <= 0) {
      return "📦 context: set MOSSBRIDGE_CLAUDE_CONTEXT_WINDOW";
    }
    const reservedOutputTokens = Math.max(0, Number(claudeMaxOutputTokens) || 0);
    const availableMessageWindow = configuredWindow - reservedOutputTokens;
    if (availableMessageWindow <= 0) {
      return "📦 context: reduce CLAUDE_CODE_MAX_OUTPUT_TOKENS";
    }
    if (!context || !Number.isFinite(Number(context.currentTokens))) {
      return "📦 context: unavailable";
    }
    const summary = formatContextUsage(Number(context.currentTokens), availableMessageWindow);
    if (reservedOutputTokens > 0) {
      return `📦 context: approx ${summary} | reserve ${formatCompactNumber(reservedOutputTokens)}`;
    }
    return `📦 context: approx ${summary}`;
  }
  if (!context) {
    return "📦 context: unavailable";
  }
  const currentTokens = Number(context.currentTokens);
  const contextWindow = Number(context.contextWindow);
  if (!Number.isFinite(currentTokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return "📦 context: unavailable";
  }
  return `📦 context: ${formatContextUsage(currentTokens, contextWindow)}`;
}

function formatContextUsage(currentTokens, contextWindow) {
  const safeCurrent = Math.max(0, Number(currentTokens) || 0);
  const safeWindow = Math.max(1, Number(contextWindow) || 1);
  const clampedCurrent = Math.min(safeCurrent, safeWindow);
  const leftPercent = Math.max(0, Math.min(100, Math.round(((safeWindow - clampedCurrent) / safeWindow) * 100)));
  return `${formatCompactNumber(clampedCurrent)}/${formatCompactNumber(safeWindow)} | ${leftPercent}% left`;
}

function buildLocationMovementSystemText(event) {
  const distanceText = `${formatCompactNumber(event?.distanceMeters || 0)}m`;
  const fromLabel = normalizeText(event?.fromAddress) || formatLatLng(event?.fromCenterLat, event?.fromCenterLng);
  const toLabel = normalizeText(event?.toAddress) || formatLatLng(event?.toCenterLat, event?.toCenterLng);
  const movedAt = normalizeText(event?.movedAt) || new Date().toISOString();
  return [
    "System context: the user's location appears to have changed significantly.",
    `Distance: about ${distanceText}.`,
    fromLabel ? `From: ${fromLabel}` : "",
    toLabel ? `To: ${toLabel}` : "",
    `Observed at: ${movedAt}.`,
  ].filter(Boolean).join("\n");
}

function buildLocationTriggerSystemText(trigger) {
  switch (normalizeText(trigger)) {
    case "arrive_home":
      return "User arrives home.";
    case "leave_home":
      return "User leaves home.";
    default:
      return "";
  }
}

function formatLatLng(latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return "";
  }
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}
function createShutdownController(onStop) {
  let stopped = false;
  let stoppingPromise = null;

  const stop = async () => {
    if (stopped) {
      return stoppingPromise;
    }
    stopped = true;
    stoppingPromise = Promise.resolve().then(onStop);
    return stoppingPromise;
  };

  const handleSignal = () => {
    stop().finally(() => {
      process.exit(0);
    });
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  return {
    get stopped() {
      return stopped;
    },
    dispose() {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
    },
  };
}

function assertWeixinUpdateResponse(response) {
  const ret = normalizeErrorCode(response?.ret);
  const errcode = normalizeErrorCode(response?.errcode);
  if ((ret !== 0 && ret !== null) || (errcode !== 0 && errcode !== null)) {
    const error = new Error(
      `weixin getUpdates ret=${ret ?? ""} errcode=${errcode ?? ""} errmsg=${normalizeText(response?.errmsg) || ""}`
    );
    error.ret = ret;
    error.errcode = errcode;
    throw error;
  }
}

function isSessionExpiredError(error) {
  const ret = normalizeErrorCode(error?.ret);
  const errcode = normalizeErrorCode(error?.errcode);
  return ret === SESSION_EXPIRED_ERRCODE
    || errcode === SESSION_EXPIRED_ERRCODE
    || String(error?.message || "").includes("session expired")
    || String(error?.message || "").includes("session invalidated");
}

function normalizeErrorCode(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error || "unknown error");
  if (isSessionExpiredError(error)) {
    return "The WeChat session has expired. Run `npm run login` again.";
  }
  const details = formatErrorDiagnosticSuffix(buildErrorDiagnosticPayload(error));
  return details ? `${raw} (${details})` : raw;
}

function buildErrorDiagnosticPayload(error) {
  if (!error || typeof error !== "object") {
    return {};
  }
  const cause = error.cause && typeof error.cause === "object" ? error.cause : null;
  const api = error.weixinApi && typeof error.weixinApi === "object" ? error.weixinApi : null;
  return pruneEmptyObject({
    code: normalizeText(error.code),
    causeName: normalizeText(cause?.name),
    causeCode: normalizeText(cause?.code),
    causeMessage: normalizeText(cause?.message).slice(0, 240),
    apiLabel: normalizeText(api?.label),
    apiEndpoint: normalizeText(api?.endpoint),
    apiTimeoutMs: Number.isFinite(Number(api?.timeoutMs)) ? Number(api.timeoutMs) : null,
  });
}

function formatErrorDiagnosticSuffix(details = {}) {
  const parts = [];
  if (details.causeCode) {
    parts.push(`cause=${details.causeCode}`);
  } else if (details.causeName) {
    parts.push(`cause=${details.causeName}`);
  }
  if (details.apiLabel) {
    parts.push(`api=${details.apiLabel}`);
  }
  if (details.apiEndpoint) {
    parts.push(`endpoint=${details.apiEndpoint}`);
  }
  if (details.apiTimeoutMs) {
    parts.push(`timeout=${details.apiTimeoutMs}ms`);
  }
  return parts.join(" ");
}

function resolveWeixinPollRetryDelayMs(consecutiveFailures = 0, error = null) {
  const failureCount = Math.max(1, Number(consecutiveFailures) || 1);
  if (!isLikelyWeixinTransportFailure(error)) {
    return failureCount >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS;
  }
  const index = Math.min(failureCount - 1, WEIXIN_TRANSPORT_RETRY_DELAYS_MS.length - 1);
  return WEIXIN_TRANSPORT_RETRY_DELAYS_MS[index];
}

function isRuntimeTurnActuallyActiveForApp(appLike, { bindingKey = "", workspaceRoot = "", threadId = "" } = {}) {
  if (typeof appLike?.runtimeAdapter?.hasActiveTurn !== "function") {
    return true;
  }
  try {
    return Boolean(appLike.runtimeAdapter.hasActiveTurn({ bindingKey, workspaceRoot, threadId }));
  } catch {
    return true;
  }
}

function isLikelyWeixinTransportFailure(error = null) {
  const message = normalizeText(error?.message).toLowerCase();
  const name = normalizeText(error?.name).toLowerCase();
  const causeCode = normalizeText(error?.cause?.code).toLowerCase();
  const causeName = normalizeText(error?.cause?.name).toLowerCase();
  return message.includes("fetch failed")
    || message.includes("network")
    || message.includes("socket")
    || message.includes("timeout")
    || name === "typeerror"
    || Boolean(causeCode)
    || causeName.includes("timeout");
}

function pruneEmptyObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (entry === null || entry === undefined) {
        return false;
      }
      if (typeof entry === "string") {
        return Boolean(entry.trim());
      }
      return true;
    })
  );
}

function loadBackgroundRuntimeCircuitState(filePath = "") {
  if (!filePath) {
    return createEmptyBackgroundRuntimeCircuitState();
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return normalizeBackgroundRuntimeCircuitState(JSON.parse(raw));
  } catch {
    return createEmptyBackgroundRuntimeCircuitState();
  }
}

function persistBackgroundRuntimeCircuitState(filePath = "", state = {}) {
  if (!filePath) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpFile = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpFile, `${JSON.stringify(normalizeBackgroundRuntimeCircuitState(state), null, 2)}\n`);
    fs.renameSync(tmpFile, filePath);
  } catch (error) {
    console.warn(`[mossbridge] background runtime circuit state write skipped: ${formatErrorMessage(error)}`);
  }
}

function createEmptyBackgroundRuntimeCircuitState() {
  return {
    version: BACKGROUND_RUNTIME_CIRCUIT_STORE_VERSION,
    consecutiveFirstEventFailures: 0,
    openUntil: "",
    openUntilMs: 0,
    reason: "",
    lastTrigger: "",
    lastThreadId: "",
    lastBindingKey: "",
    lastWorkspaceRoot: "",
    lastFailureAt: "",
    lastFailureAtMs: 0,
    lastSuccessAt: "",
    lastSuccessAtMs: 0,
    lastSuccessThreadId: "",
    updatedAt: "",
    updatedAtMs: 0,
  };
}

function normalizeBackgroundRuntimeCircuitState(value = {}) {
  const base = createEmptyBackgroundRuntimeCircuitState();
  const input = value && typeof value === "object" ? value : {};
  const openUntilMs = Number(input.openUntilMs || Date.parse(input.openUntil || ""));
  const lastFailureAtMs = Number(input.lastFailureAtMs || Date.parse(input.lastFailureAt || ""));
  const lastSuccessAtMs = Number(input.lastSuccessAtMs || Date.parse(input.lastSuccessAt || ""));
  const updatedAtMs = Number(input.updatedAtMs || Date.parse(input.updatedAt || ""));
  return {
    ...base,
    version: BACKGROUND_RUNTIME_CIRCUIT_STORE_VERSION,
    consecutiveFirstEventFailures: Math.max(0, Number(input.consecutiveFirstEventFailures) || 0),
    openUntil: normalizeText(input.openUntil),
    openUntilMs: Number.isFinite(openUntilMs) && openUntilMs > 0 ? openUntilMs : 0,
    reason: normalizeText(input.reason),
    lastTrigger: normalizeText(input.lastTrigger),
    lastThreadId: normalizeCommandArgument(input.lastThreadId),
    lastBindingKey: normalizeText(input.lastBindingKey),
    lastWorkspaceRoot: normalizeText(input.lastWorkspaceRoot),
    lastFailureAt: normalizeText(input.lastFailureAt),
    lastFailureAtMs: Number.isFinite(lastFailureAtMs) && lastFailureAtMs > 0 ? lastFailureAtMs : 0,
    lastSuccessAt: normalizeText(input.lastSuccessAt),
    lastSuccessAtMs: Number.isFinite(lastSuccessAtMs) && lastSuccessAtMs > 0 ? lastSuccessAtMs : 0,
    lastSuccessThreadId: normalizeCommandArgument(input.lastSuccessThreadId),
    updatedAt: normalizeText(input.updatedAt),
    updatedAtMs: Number.isFinite(updatedAtMs) && updatedAtMs > 0 ? updatedAtMs : 0,
  };
}

function resolveBackgroundRuntimeCircuitFailureThreshold(config = {}) {
  const parsed = Number(config?.backgroundRuntimeCircuitFailureThreshold);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1, Math.floor(parsed))
    : DEFAULT_BACKGROUND_RUNTIME_CIRCUIT_FAILURE_THRESHOLD;
}

function resolveBackgroundRuntimeCircuitCooldownMs(config = {}) {
  const minutes = Number(config?.backgroundRuntimeCircuitCooldownMinutes);
  return Number.isFinite(minutes) && minutes > 0
    ? Math.max(60_000, Math.floor(minutes * 60_000))
    : DEFAULT_BACKGROUND_RUNTIME_CIRCUIT_COOLDOWN_MS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { MossbridgeApp };

function parseChannelCommand(text) {
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized.startsWith("/")) {
    return null;
  }
  const [rawName, ...rest] = normalized.slice(1).split(/\s+/);
  const name = normalizeCommandName(rawName);
  if (!name) {
    return null;
  }
  return {
    name,
    args: rest.join(" ").trim(),
  };
}

function parseModelSelectionArgs(value) {
  const tokens = splitCommandArgs(value);
  const modelParts = [];
  let provider = "";
  let providerSpecified = false;
  let clear = false;
  let error = "";

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const normalizedToken = normalizeCommandArgument(token).toLowerCase();
    if (token === "--clear" || ["default", "clear", "reset"].includes(normalizedToken)) {
      clear = true;
      continue;
    }
    if (token === "--provider" || token === "-p") {
      providerSpecified = true;
      index += 1;
      provider = normalizeModelProviderArg(tokens[index]);
      if (!tokens[index]) {
        error = "--provider requires a provider value";
        break;
      }
      continue;
    }
    if (token.startsWith("--provider=")) {
      providerSpecified = true;
      provider = normalizeModelProviderArg(token.slice("--provider=".length));
      continue;
    }
    modelParts.push(token);
  }

  const model = modelParts.join(" ").trim();
  if (clear && model) {
    error = "Use either --clear/default or a model name, not both.";
  }
  return {
    model,
    provider,
    providerSpecified,
    clear,
    error,
  };
}

function normalizeCommandName(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:\//;
const WINDOWS_DRIVE_ROOT_RE = /^[A-Za-z]:\/$/;
const WINDOWS_UNC_PREFIX_RE = /^\/\/\?\//;

function normalizeWorkspacePath(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  const fromFileUri = extractPathFromFileUri(normalized);
  const rawPath = fromFileUri || normalized;
  const withForwardSlashes = rawPath.replace(/\\/g, "/").replace(WINDOWS_UNC_PREFIX_RE, "");
  const normalizedDrivePrefix = /^\/[A-Za-z]:\//.test(withForwardSlashes)
    ? withForwardSlashes.slice(1)
    : withForwardSlashes;

  if (WINDOWS_DRIVE_ROOT_RE.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix;
  }
  if (WINDOWS_DRIVE_PATH_RE.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix.replace(/\/+$/g, "");
  }
  return normalizedDrivePrefix.replace(/\/+$/g, "");
}

function isAbsoluteWorkspacePath(value) {
  const normalized = normalizeWorkspacePath(value);
  if (!normalized) {
    return false;
  }
  if (WINDOWS_DRIVE_PATH_RE.test(normalized)) {
    return true;
  }
  return path.posix.isAbsolute(normalized);
}

function extractPathFromFileUri(value) {
  const input = String(value || "").trim();
  if (!/^file:\/\//i.test(input)) {
    return "";
  }

  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "file:") {
      return "";
    }
    const pathname = decodeURIComponent(parsed.pathname || "");
    const withHost = parsed.host && parsed.host !== "localhost"
      ? `//${parsed.host}${pathname}`
      : pathname;
    return withHost;
  } catch {
    return "";
  }
}

function isPathWithinAllowedDirectories(rawPath) {
  const resolved = path.resolve(rawPath);
  const normalized = resolved.replace(/\\/g, "/") + "/";
  const allowedDirs = [
    os.homedir(),
    process.cwd(),
    this?.config?.workspaceRoot,
  ]
    .filter(Boolean)
    .map((dir) => path.resolve(dir).replace(/\\/g, "/") + "/");
  return allowedDirs.some((prefix) => normalized.startsWith(prefix));
}

function normalizeCommandArgument(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeModelProviderArg(value) {
  const normalized = normalizeCommandArgument(value).toLowerCase();
  if (["", "default", "cloud", "none", "clear"].includes(normalized)) {
    return "";
  }
  return normalizeCommandArgument(value);
}

function normalizeTextList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const normalized = normalizeCommandArgument(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function normalizeAllowedUserIds(values) {
  return normalizeTextList(values).map((item) => item.toLowerCase());
}

function mergeTextLists(left, right) {
  return normalizeTextList([...normalizeTextList(left), ...normalizeTextList(right)]);
}

function splitCommandArgs(value) {
  const text = normalizeCommandArgument(value);
  if (!text) {
    return [];
  }
  const tokens = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match = null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = match[1] ?? match[2] ?? match[3] ?? "";
    const unescaped = raw.replace(/\\(["'\\])/g, "$1").trim();
    if (unescaped) {
      tokens.push(unescaped);
    }
  }
  return tokens;
}

function normalizeThreadId(value) {
  const normalized = normalizeCommandArgument(value);
  if (!normalized) {
    return "";
  }
  return normalized.replace(/\s+/g, "");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function buildSystemRuntimeSenderId(senderId) {
  const normalized = normalizeText(senderId) || "unknown";
  return `${normalized}#mossbridge-system`;
}

function clampSystemRuntimeText(value, maxChars = MAX_SYSTEM_RUNTIME_TEXT_CHARS) {
  const text = String(value || "").trim();
  const limit = resolvePositiveInt(maxChars, MAX_SYSTEM_RUNTIME_TEXT_CHARS);
  if (!text || text.length <= limit) {
    return text;
  }
  const keep = Math.max(0, limit - 160);
  return [
    text.slice(0, keep).trimEnd(),
    "",
    "[Mossbridge note: system-turn context was trimmed before runtime dispatch to avoid prompt overflow. Search memory explicitly if this trigger needs more detail.]",
  ].join("\n");
}

function resolveSystemRuntimeTextMaxChars(prepared, config = {}) {
  const metadata = prepared?.systemTurn?.metadata && typeof prepared.systemTurn.metadata === "object"
    ? prepared.systemTurn.metadata
    : {};
  if (normalizeText(metadata.budgetPolicy) === "compact") {
    return resolvePositiveInt(
      metadata.compactRuntimeTextMaxChars || config.systemBudgetCompactRuntimeTextMaxChars,
      6_000,
    );
  }
  const triggerKind = normalizeText(prepared?.systemTurn?.trigger_kind);
  if (triggerKind !== "checkin_opportunity") {
    return MAX_SYSTEM_RUNTIME_TEXT_CHARS;
  }
  return resolvePositiveInt(config.checkinRuntimeTextMaxChars, DEFAULT_CHECKIN_RUNTIME_TEXT_CHARS);
}

function resolvePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatRuntimeFailureForUser(text, { provider = "", runtimeId = "" } = {}) {
  const normalized = normalizeText(text) || "❌ Execution failed";
  const kind = classifyRuntimeFailureKind(normalized);
  const runtimeLabel = formatRuntimeLabel(runtimeId);
  if (kind === "prompt_too_long") {
    return formatBridgeNotice("runtime_prompt_too_long", [
      "source: bridge",
      `runtime: ${runtimeLabel}`,
      "status: prompt_too_long",
      "result: run_released",
      provider === "system"
        ? "action: suppress_system_reply"
        : "action: shorten_or_compact_then_retry",
    ]);
  }
  if (kind === "bad_json") {
    return formatBridgeNotice("runtime_bad_json", [
      "source: bridge",
      `runtime: ${runtimeLabel}`,
      "status: request_body_rejected",
      "result: run_isolated",
      "action: resend_request",
    ]);
  }
  if (kind === "api_error") {
    return formatBridgeNotice("runtime_api_error", [
      "source: bridge",
      `runtime: ${runtimeLabel}`,
      "status: api_error",
      "result: run_released",
      "memory: not_recorded",
      "action: retry_after_provider_recovers",
      `detail: ${truncateForStatus(normalized, 260)}`,
    ]);
  }
  return normalized;
}

function formatRuntimeLabel(runtimeName) {
  const normalized = normalizeText(runtimeName).toLowerCase();
  if (normalized === "claudecode") {
    return "ClaudeCode";
  }
  if (normalized === "codex") {
    return "Codex";
  }
  return normalizeText(runtimeName) || "runtime";
}

function buildSharedRuntimeCommands(runtimeName) {
  return {
    status: buildSharedRuntimeCommand("status", runtimeName),
    start: buildSharedRuntimeCommand("start", runtimeName),
    open: buildSharedRuntimeCommand("open", runtimeName),
  };
}

function buildSharedRuntimeCommand(commandName, runtimeName) {
  const command = normalizeText(commandName);
  const runtime = normalizeText(runtimeName).toLowerCase();
  if (!command) {
    return "npm run shared:status";
  }
  if (runtime === "claudecode") {
    return `npm run shared:${command}:claudecode`;
  }
  if (!runtime || runtime === "codex") {
    return `npm run shared:${command}`;
  }
  return `MOSSBRIDGE_RUNTIME=${runtime} npm run shared:${command}`;
}

function formatModelStatusNotice({
  runtimeId = "",
  workspaceRoot = "",
  selectedModel = "",
  selectedProvider = "",
  runtimeDefaultModel = "",
  configuredModel = "",
  configuredProvider = "",
  modelCatalog = [],
} = {}) {
  const selected = normalizeText(selectedModel);
  const provider = normalizeModelProviderArg(selectedProvider);
  const runtimeDefault = normalizeText(runtimeDefaultModel);
  const runtime = normalizeText(runtimeId) || "runtime";
  const lines = [
    `runtime: ${runtime}`,
    workspaceRoot ? `workspace: ${workspaceRoot}` : "",
    `selected_model: ${selected || "(default)"}`,
  ];
  if (runtime === "codex") {
    lines.push(`selected_provider: ${provider || "(default)"}`);
  }
  if (configuredModel || configuredProvider) {
    lines.push(`env_override: model=${configuredModel || "(default)"} provider=${configuredProvider || "(default)"}`);
  } else {
    lines.push(runtimeDefault ? `runtime_default: ${runtimeDefault}` : "runtime_default: (runtime default)");
  }
  lines.push(`effective_model: ${configuredModel || selected || runtimeDefault || "(runtime default)"}`);
  if (runtime === "codex") {
    lines.push(`effective_provider: ${configuredProvider || provider || "(default)"}`);
  }
  lines.push(`catalog: ${modelCatalog.length ? `${modelCatalog.length} models` : "(not available)"}`);
  lines.push(modelCatalog.length
    ? `available_models: ${formatRuntimeModelCatalog(modelCatalog)}`
    : modelChoiceConfigHint(runtime));
  lines.push(runtime === "codex"
    ? "commands: /model <alias-or-id>, /model --provider <id> <model>, /model default, /model refresh"
    : "commands: /model <alias-or-id>, /model default, /model refresh");
  return formatBridgeNotice("model_status", [
    ...lines,
  ]);
}

function formatModelList(models, limit = 12) {
  const normalized = normalizeModelCatalog(models);
  if (!normalized.length) {
    return "(not available)";
  }
  const shown = normalized.slice(0, Math.max(1, Number(limit) || 12)).map((item) => item.model);
  const suffix = normalized.length > shown.length ? `, +${normalized.length - shown.length} more` : "";
  return `${shown.join(", ")}${suffix}`;
}

function buildRuntimeModelCatalog({ runtimeId = "", catalog = {}, config = {} } = {}) {
  const runtimeModels = Array.isArray(catalog?.models) ? catalog.models : [];
  const configuredChoices = [
    ...parseConfiguredModelChoices(config.modelChoices, runtimeId),
    ...parseConfiguredModelChoices(
      normalizeText(runtimeId).toLowerCase() === "codex"
        ? config.codexModelChoices
        : config.claudeModelChoices,
      runtimeId,
    ),
  ];
  const result = [];
  const seen = new Set();
  for (const item of [...runtimeModels, ...configuredChoices]) {
    const model = normalizeCommandArgument(item?.model || item?.id);
    if (!model) {
      continue;
    }
    const provider = normalizeModelProviderArg(item?.modelProvider || item?.model_provider || "");
    const key = `${model.toLowerCase()}@${provider.toLowerCase()}`;
    if (seen.has(key)) {
      const existing = result.find((candidate) =>
        normalizeCommandArgument(candidate.model).toLowerCase() === model.toLowerCase()
        && normalizeModelProviderArg(candidate.modelProvider).toLowerCase() === provider.toLowerCase()
      );
      if (existing) {
        existing.aliases = mergeTextLists(existing.aliases, item.aliases);
      }
      continue;
    }
    seen.add(key);
    result.push({
      ...item,
      id: normalizeCommandArgument(item?.id) || model,
      model,
      modelProvider: provider,
      displayName: normalizeCommandArgument(item?.displayName || item?.display_name),
      aliases: normalizeTextList(item?.aliases),
    });
  }
  return result;
}

function parseConfiguredModelChoices(values, runtimeId = "") {
  const result = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const text = normalizeCommandArgument(raw);
    if (!text) {
      continue;
    }
    const eqIndex = text.indexOf("=");
    const alias = eqIndex > 0 ? normalizeCommandArgument(text.slice(0, eqIndex)) : "";
    const target = eqIndex > 0 ? normalizeCommandArgument(text.slice(eqIndex + 1)) : text;
    if (!target) {
      continue;
    }
    const split = splitModelProviderTarget(target, runtimeId);
    if (!split.model) {
      continue;
    }
    result.push({
      id: split.model,
      model: split.model,
      modelProvider: split.provider,
      aliases: alias ? [alias] : [],
      displayName: alias,
      configured: true,
    });
  }
  return result;
}

function splitModelProviderTarget(target, runtimeId = "") {
  const text = normalizeCommandArgument(target);
  if (!text) {
    return { model: "", provider: "" };
  }
  if (normalizeText(runtimeId).toLowerCase() !== "codex") {
    return { model: text, provider: "" };
  }
  const atIndex = text.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === text.length - 1) {
    return { model: text, provider: "" };
  }
  return {
    model: normalizeCommandArgument(text.slice(0, atIndex)),
    provider: normalizeModelProviderArg(text.slice(atIndex + 1)),
  };
}

function findRuntimeModelChoice(models, query) {
  const exact = findModelByQuery(models, query);
  if (exact) {
    return exact;
  }
  const normalizedQuery = normalizeCommandArgument(query).toLowerCase();
  if (!normalizedQuery || !Array.isArray(models)) {
    return null;
  }
  const aliasMatched = models.find((item) =>
    normalizeTextList(item?.aliases).some((alias) => alias.toLowerCase() === normalizedQuery)
    || normalizeCommandArgument(item?.displayName).toLowerCase() === normalizedQuery
  );
  if (aliasMatched) {
    return aliasMatched;
  }
  const looseMatches = models.filter((item) => {
    const candidates = [
      normalizeCommandArgument(item?.model),
      normalizeCommandArgument(item?.id),
      normalizeCommandArgument(item?.displayName),
      ...normalizeTextList(item?.aliases),
    ].map((value) => value.toLowerCase()).filter(Boolean);
    return candidates.some((candidate) => candidate.includes(normalizedQuery));
  });
  return looseMatches.length === 1 ? looseMatches[0] : null;
}

function formatRuntimeModelCatalog(models) {
  return (Array.isArray(models) ? models : []).map((item) => {
    const alias = normalizeTextList(item?.aliases)[0] || normalizeCommandArgument(item?.displayName);
    const model = normalizeCommandArgument(item?.model);
    const provider = normalizeModelProviderArg(item?.modelProvider);
    const modelWithProvider = provider ? `${model}@${provider}` : model;
    return alias ? `${alias}=${modelWithProvider}` : modelWithProvider;
  }).filter(Boolean).join(", ");
}

function buildModelNotFoundText(query, models, runtimeId = "") {
  const lines = [
    "model_not_found",
    `query: ${normalizeCommandArgument(query) || "(empty)"}`,
  ];
  const suggestions = suggestRuntimeModels(query, models);
  if (suggestions.length) {
    lines.push(`did_you_mean: ${suggestions.join(", ")}`);
  }
  if (Array.isArray(models) && models.length) {
    lines.push(`available_models: ${formatRuntimeModelCatalog(models)}`);
    lines.push("hint: /model refresh");
  } else {
    lines.push(modelChoiceConfigHint(runtimeId));
  }
  return formatBridgeNotice("model_not_found", lines);
}

function suggestRuntimeModels(query, models) {
  const normalizedQuery = normalizeCommandArgument(query).toLowerCase();
  if (!normalizedQuery || !Array.isArray(models)) {
    return [];
  }
  return models
    .map((item) => {
      const candidates = [
        normalizeCommandArgument(item?.model),
        normalizeCommandArgument(item?.id),
        normalizeCommandArgument(item?.displayName),
        ...normalizeTextList(item?.aliases),
      ].filter(Boolean);
      const best = candidates
        .map((candidate) => ({
          value: candidate,
          score: scoreModelCandidate(normalizedQuery, candidate.toLowerCase()),
        }))
        .sort((left, right) => right.score - left.score)[0];
      return {
        item,
        score: best?.score || 0,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((entry) => {
      const alias = normalizeTextList(entry.item?.aliases)[0] || normalizeCommandArgument(entry.item?.displayName);
      const model = normalizeCommandArgument(entry.item?.model);
      return alias ? `${alias} (${model})` : model;
    });
}

function scoreModelCandidate(query, candidate) {
  if (!query || !candidate) {
    return 0;
  }
  if (candidate === query) {
    return 100;
  }
  if (candidate.includes(query)) {
    return 70 + Math.min(20, query.length);
  }
  if (query.includes(candidate)) {
    return 50 + Math.min(20, candidate.length);
  }
  const queryParts = query.split(/[^a-z0-9]+/u).filter(Boolean);
  const candidateParts = candidate.split(/[^a-z0-9]+/u).filter(Boolean);
  const overlap = queryParts.filter((part) => candidateParts.some((candidatePart) =>
    candidatePart.includes(part) || part.includes(candidatePart)
  )).length;
  return overlap ? 20 + overlap * 10 : 0;
}

function modelChoiceConfigHint(runtimeId = "") {
  const runtime = normalizeText(runtimeId).toLowerCase();
  if (runtime === "claudecode") {
    return "hint: set MOSSBRIDGE_CLAUDE_MODEL_CHOICES, for example opus=claude-opus-4-6,sonnet=claude-sonnet-4-6";
  }
  if (runtime === "codex") {
    return "hint: set MOSSBRIDGE_CODEX_MODEL_CHOICES, for example oss=gpt-oss:20b,local=gemma4:26b-32k@ollama";
  }
  return "hint: set MOSSBRIDGE_MODEL_CHOICES or a runtime-specific model choices env";
}

function isClaudeRuntimeFailureText(text) {
  return classifyRuntimeFailureKind(text) !== "";
}

function classifyRuntimeFailureKind(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return "";
  }
  if (/^prompt is too long\b/i.test(normalized) || /\bprompt is too long\b/i.test(normalized)) {
    return "prompt_too_long";
  }
  if (
    /\brequest body is not valid json\b/i.test(normalized)
    || /\bno low surrogate\b/i.test(normalized)
    || /\blone surrogate\b/i.test(normalized)
  ) {
    return "bad_json";
  }
  if (/^api error:\s*(?:4\d\d|5\d\d)\b/i.test(normalized) || /\binvalid_request_error\b/i.test(normalized)) {
    return "api_error";
  }
  return "";
}

function truncateForStatus(text, limit = 260) {
  const normalized = normalizeText(text);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  return new Date(parsed).toISOString();
}

function matchesBuiltInCommandPrefix(commandTokens) {
  const normalized = normalizeCommandTokensForMatching(commandTokens);
  if (!normalized.length) {
    return false;
  }

  if (normalized[0] === "view_image") {
    return true;
  }

   if (
    normalized[0] === "mcp_tool"
      && normalized[1] === "mossbridge_tools"
   ) {
    return true;
  }

  return false;
}

function normalizeCommandTokensForMatching(commandTokens) {
  return canonicalizeCommandTokens(commandTokens);
}

function buildApprovalPromptText(approval) {
  if (approval?.kind === "mcp_elicitation") {
    return buildElicitationApprovalPromptText(approval);
  }
  const reasonText = normalizeText(approval?.reason);
  const commandText = normalizeText(approval?.command);
  const toolName = extractToolNameFromReason(reasonText) || "";
  const commandLines = commandText ? commandText.split("\n") : [];
  const firstCommandLine = normalizeText(commandLines[0]);
  const restCommandLines = commandLines.slice(1);
  const shouldShowReason = reasonText && normalizeText(reasonText) !== normalizeText(`Tool: ${firstCommandLine}`);

  const out = [];
  out.push(`🔐 【Approval】${toolName || "Tool request"}`);

  if (shouldShowReason) {
    out.push(`📋 ${reasonText}`);
  }

  if (commandText) {
    if (firstCommandLine) {
      out.push(`⌨️ ${firstCommandLine}`);
    }
    if (restCommandLines.length) {
      out.push(restCommandLines.map((line) => `  ${line}`).join("\n"));
    }
  }

  if (!reasonText && !commandText) {
    out.push("❓ (unknown)");
  }

  out.push("━━━━━━━━━━━━━");
  out.push("💬 Reply with:");
  out.push("👉 /yes    allow once");
  out.push("👉 /always auto-allow");
  out.push("👉 /no     deny");

  return out.join("\n");
}

function extractToolNameFromReason(reason) {
  const normalized = normalizeText(reason);
  if (!normalized) return "";
  if (normalized.toLowerCase().startsWith("tool:")) {
    return normalized.slice(5).trim();
  }
  return normalized;
}

function buildApprovalPromptSignature(approval) {
  const reasonText = normalizeText(approval?.reason);
  const commandText = normalizeText(approval?.command);
  const commandTokens = Array.isArray(approval?.commandTokens)
    ? approval.commandTokens.map((token) => normalizeCommandArgument(token)).filter(Boolean)
    : [];
  return JSON.stringify({
    kind: normalizeText(approval?.kind),
    reason: reasonText,
    command: commandText,
    commandTokens,
    responseTemplate: approval?.responseTemplate || null,
  });
}

function buildApprovalResponsePayload(approval, commandName) {
  const requestId = approval?.requestId;
  if (requestId == null || String(requestId).trim() === "") {
    return null;
  }
  if (approval?.kind === "mcp_tool_call" || approval?.kind === "mcp_elicitation") {
    const responseByCommand = approval?.responseTemplate?.responseByCommand;
    const result = responseByCommand && typeof responseByCommand === "object"
      ? responseByCommand[commandName]
      : null;
    if (!result || typeof result !== "object") {
      return null;
    }
    return { requestId, result };
  }
  const decision = commandName === "no" ? "decline" : "accept";
  return { requestId, decision };
}

function buildApprovalResponseText(approval, commandName, approvalResponse) {
  if (approval?.kind === "mcp_tool_call" || approval?.kind === "mcp_elicitation") {
    if (commandName === "yes") {
      return "✅ This request has been approved.";
    }
    return "❌ This request has been cancelled.";
  }
  return commandName === "always"
    ? "💡 Auto-approve enabled for this command prefix in the current workspace."
    : (commandName === "yes" ? "✅ This request has been approved." : "❌ This request has been denied.");
}

function buildElicitationApprovalPromptText(approval) {
  const elicitation = approval?.elicitation || {};
  const messageText = normalizeText(elicitation?.message);
  const commandText = normalizeText(approval?.command);
  const approvalKind = normalizeText(elicitation?.approvalKind);
  const out = [];
  out.push(`🔐 【Approval】${normalizeText(approval?.reason) || "MCP request"}`);
  if (messageText) {
    out.push(`📋 ${messageText.split("\n")[0]}`);
  }
  if (commandText) {
    const commandLines = commandText.split("\n").map((line) => normalizeText(line)).filter(Boolean);
    if (commandLines.length) {
      out.push(`⌨️ ${commandLines[0]}`);
      if (commandLines.length > 1) {
        out.push(commandLines.slice(1).map((line) => `  ${line}`).join("\n"));
      }
    }
  }

  const toolDescription = normalizeText(elicitation?.toolDescription);
  if (toolDescription && approvalKind === "mcp_tool_call") {
    out.push("━━━━━━━━━━━━━");
    out.push(`🧾 ${toolDescription}`);
  }

  const supportedCommands = new Set(
    Array.isArray(approval?.responseTemplate?.supportedCommands)
      ? approval.responseTemplate.supportedCommands
      : []
  );
  out.push("━━━━━━━━━━━━━");
  out.push("💬 Reply with:");
  if (supportedCommands.has("yes")) {
    out.push("👉 /yes    allow once");
  }
  if (supportedCommands.has("no")) {
    out.push("👉 /no     cancel this request");
  }
  if (!supportedCommands.size) {
    out.push("⚠️ This runtime MCP request cannot be answered from WeChat yet.");
  }

  return out.join("\n");
}

function buildReminderSystemTrigger(reminder, config = {}) {
  const reminderText = String(reminder?.text || "").trim();
  const userName = String(config?.userName || "").trim() || "the user";
  return `Due reminder for ${userName}: ${reminderText}`;
}

function formatReminderDueAt(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "";
  }
  const date = new Date(numeric);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replace(/\//g, "-");
}

function buildScopeKey(bindingKey, workspaceRoot) {
  const normalizedBindingKey = normalizeText(bindingKey);
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedBindingKey || !normalizedWorkspaceRoot) {
    return "";
  }
  return `${normalizedBindingKey}::${normalizedWorkspaceRoot}`;
}

function mergePendingInboundDraft(draft) {
  const queued = Array.isArray(draft?.messages)
    ? draft.messages
      .filter((message) => message && typeof message === "object")
      .slice()
      .sort(comparePendingInboundMessages)
    : [];
  if (!queued.length) {
    return null;
  }
  if (queued.length === 1) {
    const only = queued[0];
    const runtimeText = normalizeText(only.runtimeText) || normalizeText(only.text);
    const originalText = normalizeText(only.originalText) || runtimeText;
    return {
      bindingKey: draft.bindingKey,
      workspaceRoot: draft.workspaceRoot,
      ...only,
      originalText,
      runtimeText,
      text: runtimeText,
    };
  }

  const latest = queued[queued.length - 1];
  const runtimeBlocks = queued
    .map((message) => normalizeText(message.runtimeText) || normalizeText(message.text))
    .filter(Boolean);
  const originalBlocks = queued
    .map((message) => normalizeText(message.originalText) || normalizeText(message.runtimeText) || normalizeText(message.text))
    .filter(Boolean);
  const runtimeText = [
    "Multiple newer WeChat messages arrived while you were still handling the previous turn.",
    "Treat the following blocks as one ordered batch of fresh user input and respond once after considering all of them.",
    "",
    runtimeBlocks.join("\n\n"),
  ].join("\n").trim();
  const attachments = queued.flatMap((message) => Array.isArray(message.attachments) ? message.attachments : []);
  const attachmentFailures = queued.flatMap((message) => Array.isArray(message.attachmentFailures) ? message.attachmentFailures : []);

  return {
    bindingKey: draft.bindingKey,
    workspaceRoot: draft.workspaceRoot,
    ...latest,
    originalText: originalBlocks.join("\n\n"),
    runtimeText,
    text: runtimeText,
    attachments,
    attachmentFailures,
  };
}

function buildInboundText(normalized, persisted = {}, config = {}, options = {}) {
  const text = String(normalized?.text || "").trim();
  const saved = Array.isArray(persisted?.saved) ? persisted.saved : [];
  const failed = Array.isArray(persisted?.failed) ? persisted.failed : [];
  const userName = String(config?.userName || "").trim() || "the user";
  const runtimeId = normalizeText(options?.runtimeId).toLowerCase();
  const officePaths = resolveWorkspaceOfficePaths({
    workspaceRoot: options?.workspaceRoot,
    config,
  });
  const localTime = formatWechatLocalTime(normalized?.receivedAt);
  const lines = [];
  if (localTime) {
    lines.push(`[${localTime}]`);
  }
  if (text) {
    if (lines.length) {
      lines.push("");
    }
    lines.push(text);
  }

  if (saved.length) {
    if (lines.length) {
      lines.push("");
    }
    lines.push(`${userName} 发来了图片/文件，已经保存到绑定工作仓的 inbox：`);
    for (const item of saved) {
      const suffix = item.sourceFileName ? `（原文件名：${item.sourceFileName}）` : "";
      lines.push(`- [${item.kind}] 文件：${item.absolutePath}${suffix}`);
      if (item.noteAbsolutePath) {
        lines.push(`  说明笔记：${item.noteAbsolutePath}`);
      }
    }
    lines.push(`回复 ${userName} 之前，请先查看附件本体，让可见内容和缓存说明一起进入判断。`);
    if (saved.some((item) => isImageAttachmentItem(item))) {
      if (runtimeUsesReadForImages(runtimeId)) {
        lines.push("图片请对保存后的本地图片文件使用 `Read`。");
      } else {
        lines.push("图片请使用 `view_image`。");
      }
      lines.push("如果图片明显适合作为可复用表情包，可以在看过之后用 sticker 工具保存。");
    }
    const attachmentContextCount = saved.length + failed.length;
    if (attachmentContextCount > 1) {
      lines.push("这些附件可能属于同一组连续分享。先看完所有可用附件，再合成一段自然回应；用户要求逐个点评时再分开长评。");
      lines.push("考虑微信投递，尽量把多附件回应收成一两条自然气泡能承载的长度。");
    }
    if (saved.some((item) => !isImageAttachmentItem(item))) {
      lines.push("如果是文档、视频或其他文件，请优先读取可用文本/元信息；如果当前运行时只能读取部分信息，就说明缺口并基于已知信息回应。");
    }
    if (officePaths.notesRoot) {
      lines.push("如果附件之后还可能被用到，可以更新配套说明笔记，留下简短事实摘要，让原文件之外也有可检索线索。");
      lines.push(`长期附件说明笔记放在：${officePaths.notesRoot}`);
    }
    lines.push(`如果缺少必要工具，请直接告诉 ${userName} 缺了什么，以及目前能读取到哪些信息。`);
  }

  if (failed.length) {
    if (lines.length) {
      lines.push("");
    }
    lines.push("附件接收异常：");
    for (const item of failed) {
      const label = item.sourceFileName || item.kind || "attachment";
      lines.push(`- ${label}: ${item.reason}`);
    }
    if (saved.length) {
      lines.push("If some attachments failed but others were saved, consider the saved attachments first, then briefly mention the failed item.");
    }
  }

  return lines.join("\n").trim();
}

function buildCurrentTurnSignalsForMemory(normalized = {}) {
  const attachments = Array.isArray(normalized.attachments) ? normalized.attachments : [];
  const failures = Array.isArray(normalized.attachmentFailures) ? normalized.attachmentFailures : [];
  return {
    provider: normalizeText(normalized.provider),
    source_client: normalizeText(normalized.provider) === "system" ? "mossbridge_system_turn" : "mossbridge_wechat",
    has_text: Boolean(normalizeText(normalized.originalText) || normalizeText(normalized.text)),
    attachment_count: attachments.length,
    image_count: attachments.filter((item) => isImageAttachmentItem(item)).length,
    attachment_failure_count: failures.length,
  };
}

function runtimeUsesReadForImages(runtimeId) {
  return runtimeId === "claudecode";
}

function buildMergedInboundPrepared({
  bindingKey,
  workspaceRoot,
  messages = [],
  trailingPrepared = null,
  config = {},
  runtimeId = "",
}) {
  const queued = Array.isArray(messages) ? messages.filter((message) => message && typeof message === "object") : [];
  const latest = trailingPrepared || queued[queued.length - 1] || {};
  const originalTexts = queued
    .map((message) => normalizeText(message.originalText))
    .filter(Boolean);
  const trailingText = normalizeText(trailingPrepared?.originalText);
  if (trailingText) {
    originalTexts.push(trailingText);
  }
  const attachments = queued.flatMap((message) => Array.isArray(message.attachments) ? message.attachments : []);
  const attachmentFailures = queued.flatMap((message) => Array.isArray(message.attachmentFailures) ? message.attachmentFailures : []);
  const originalText = originalTexts.join("\n\n");
  const runtimeText = buildInboundText({
    ...latest,
    text: originalText,
    receivedAt: latest.receivedAt,
  }, {
    saved: attachments,
    failed: attachmentFailures,
  }, config, {
    runtimeId,
    workspaceRoot,
  });

  return {
    bindingKey,
    workspaceRoot,
    ...latest,
    originalText,
    runtimeText,
    text: runtimeText,
    attachments,
    attachmentFailures,
  };
}

function shouldBatchAttachmentContextInbound(message) {
  return isBatchableAttachmentContextPreparedMessage(message);
}

function isBatchableAttachmentContextPreparedMessage(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const attachmentFailures = Array.isArray(message?.attachmentFailures) ? message.attachmentFailures : [];
  if (!attachments.length && !attachmentFailures.length) {
    return false;
  }
  return attachments.every((item) => isBatchableAttachmentItem(item))
    && attachmentFailures.every((item) => isBatchableAttachmentFailureItem(item));
}

function takeAttachmentContextBatchMessages(messages, maxAttachments) {
  const batchMessages = [];
  const remainingMessages = [];
  const leadingPlainTextMessages = [];
  let remainingCapacity = Math.max(1, Number(maxAttachments) || 1);
  let hasAttachmentInBatch = false;

  for (const message of Array.isArray(messages) ? messages : []) {
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    const attachmentContext = isBatchableAttachmentContextPreparedMessage(message);
    if (!attachments.length && isPlainTextPreparedMessage(message) && hasAttachmentInBatch) {
      batchMessages.push(message);
      continue;
    }
    if (!attachments.length && isPlainTextPreparedMessage(message)) {
      leadingPlainTextMessages.push(message);
      continue;
    }
    if (!attachments.length && attachmentContext) {
      if (!hasAttachmentInBatch && leadingPlainTextMessages.length) {
        batchMessages.push(...leadingPlainTextMessages.splice(0));
      }
      batchMessages.push(message);
      hasAttachmentInBatch = true;
      continue;
    }
    if (!attachments.length) {
      if (!hasAttachmentInBatch && leadingPlainTextMessages.length) {
        remainingMessages.push(...leadingPlainTextMessages.splice(0));
      }
      remainingMessages.push(message);
      continue;
    }
    if (!attachmentContext) {
      if (!hasAttachmentInBatch && leadingPlainTextMessages.length) {
        remainingMessages.push(...leadingPlainTextMessages.splice(0));
      }
      remainingMessages.push(message);
      continue;
    }
    if (remainingCapacity <= 0) {
      if (!hasAttachmentInBatch && leadingPlainTextMessages.length) {
        remainingMessages.push(...leadingPlainTextMessages.splice(0));
      }
      remainingMessages.push(message);
      continue;
    }
    if (!hasAttachmentInBatch && leadingPlainTextMessages.length) {
      batchMessages.push(...leadingPlainTextMessages.splice(0));
    }
    if (attachments.length <= remainingCapacity) {
      batchMessages.push(message);
      remainingCapacity -= attachments.length;
      hasAttachmentInBatch = true;
      continue;
    }
    batchMessages.push({
      ...message,
      attachments: attachments.slice(0, remainingCapacity),
    });
    hasAttachmentInBatch = true;
    remainingMessages.push({
      ...message,
      attachments: attachments.slice(remainingCapacity),
    });
    remainingCapacity = 0;
  }

  if (leadingPlainTextMessages.length) {
    if (hasAttachmentInBatch) {
      batchMessages.push(...leadingPlainTextMessages);
    } else {
      remainingMessages.push(...leadingPlainTextMessages);
    }
  }

  return {
    batchMessages,
    remainingMessages,
  };
}

function collectBatchAttachmentSenders(messages = []) {
  const senders = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!rawInboundMessageHasBatchableAttachment(message)) {
      continue;
    }
    const senderId = normalizeText(message?.from_user_id);
    if (senderId) {
      senders.add(senderId);
    }
  }
  return senders;
}

function rawInboundMessageHasBatchableAttachment(message = {}) {
  const itemList = Array.isArray(message?.item_list) ? message.item_list : [];
  return itemList.some((item) => {
    const type = Number(item?.type);
    return type === 2 || type === 4 || type === 5;
  });
}

function normalizedHasBatchableAttachment(normalized = {}) {
  const attachments = Array.isArray(normalized?.attachments) ? normalized.attachments : [];
  return attachments.some((item) => isBatchableAttachmentItem(item));
}

function clonePreparedInboundMessage(prepared) {
  return {
    workspaceId: prepared.workspaceId,
    accountId: prepared.accountId,
    senderId: prepared.senderId,
    messageId: prepared.messageId,
    contextToken: prepared.contextToken,
    provider: prepared.provider,
    originalText: prepared.originalText,
    runtimeText: prepared.runtimeText,
    text: prepared.text,
    attachments: Array.isArray(prepared.attachments) ? prepared.attachments : [],
    attachmentFailures: Array.isArray(prepared.attachmentFailures) ? prepared.attachmentFailures : [],
    receivedAt: prepared.receivedAt,
    memoryContextPacket: prepared.memoryContextPacket || null,
  };
}

function isPlainTextPreparedMessage(prepared) {
  const originalText = normalizeText(prepared?.originalText);
  const attachments = Array.isArray(prepared?.attachments) ? prepared.attachments : [];
  const attachmentFailures = Array.isArray(prepared?.attachmentFailures) ? prepared.attachmentFailures : [];
  return Boolean(originalText) && attachments.length === 0 && attachmentFailures.length === 0;
}

function isLikelyAttachmentPreludePreparedMessage(prepared) {
  if (!isPlainTextPreparedMessage(prepared)) {
    return false;
  }
  const text = normalizeText(prepared?.originalText);
  if (!text || text.length > 80) {
    return false;
  }
  const compact = text.replace(/\s+/gu, "");
  if (!compact || compact.length > 50) {
    return false;
  }

  const hasMediaWord = /(图|图片|照片|截图|文件|附件|视频|表情包|稿子|文档)/u.test(compact);
  const hasDeictic = /(这个|这张|这份|这里|这样|这些|这几个|那张|那个|那份)/u.test(compact);
  const asksToLook = /(你)?(先)?(帮我|帮忙)?(看|看看|看下|看一下|瞅瞅|瞧瞧)/u.test(compact);
  if (hasMediaWord && (asksToLook || hasDeictic || compact.length <= 24)) {
    return true;
  }
  if (hasDeictic && asksToLook) {
    return true;
  }
  if (/^(这个|这张|这份|这样|这里|这些|这几个|那个|那张)(呢|吗|咋样|怎么样|可以吗|行吗|对吗|是不是)?[?？!！。]*$/u.test(compact)) {
    return true;
  }
  if (/(发|传|补|贴|放|给你|发你|发给你).{0,10}(图|图片|照片|截图|文件|附件|视频|稿子|文档|表情包)/u.test(compact)) {
    return true;
  }
  return false;
}

function isImageAttachmentItem(item) {
  return Boolean(item?.isImage) || normalizeText(item?.contentType).toLowerCase().startsWith("image/")
    || normalizeText(item?.kind).toLowerCase() === "image";
}

function isImageAttachmentFailureItem(item) {
  return normalizeText(item?.contentType).toLowerCase().startsWith("image/")
    || normalizeText(item?.kind).toLowerCase() === "image"
    || Boolean(normalizeText(item?.sourceFileName).toLowerCase().match(/\.(png|jpe?g|gif|webp|bmp|heic|heif)$/u));
}

function isBatchableAttachmentItem(item) {
  const kind = normalizeText(item?.kind).toLowerCase();
  return Boolean(kind) || Boolean(normalizeText(item?.absolutePath) || normalizeText(item?.relativePath));
}

function isBatchableAttachmentFailureItem(item) {
  return Boolean(
    normalizeText(item?.kind)
    || normalizeText(item?.sourceFileName)
    || normalizeText(item?.reason)
  );
}

function isAutoApprovedStateDirOperation(approval, config = {}) {
  const allowedRoots = resolveManagedApprovalRoots(config);
  if (!allowedRoots.length) {
    return false;
  }

  const filePaths = extractApprovalFilePaths(approval);
  if (!filePaths.length) {
    return false;
  }

  return filePaths.every((filePath) => allowedRoots.some((root) => isPathWithinRoot(filePath, root)));
}

function isForbiddenIdentitySeedFileRead(approval, config = {}) {
  const command = normalizeText(approval?.command).toLowerCase();
  const reason = normalizeText(approval?.reason).toLowerCase();
  const isReadRequest = reason === "tool: read" || command === "read" || command.startsWith("read\n");
  if (!isReadRequest) {
    return false;
  }
  const workspaceRoot = normalizeText(config?.workspaceRoot);
  const filePaths = extractApprovalFilePaths(approval);
  return filePaths.some((filePath) => {
    const normalized = normalizeText(filePath);
    if (!normalized) {
      return false;
    }
    const lower = normalized.toLowerCase();
    const base = path.basename(lower);
    const looksLikeSeed = (
      base === "soul.md"
      || base === "persona.md"
      || base === "人格提示词.md"
      || lower.includes("/00_system/soul.md")
      || /\/[^/]*memory\/00_system\//u.test(lower)
    );
    if (!looksLikeSeed) {
      return false;
    }
    if (workspaceRoot && isPathWithinRoot(normalized, workspaceRoot)) {
      return false;
    }
    return true;
  });
}

function resolveManagedApprovalRoots(config = {}) {
  const roots = [];
  const stateDir = normalizeText(config?.stateDir);
  if (stateDir) {
    roots.push(stateDir);
  }

  const officePaths = resolveWorkspaceOfficePaths({
    workspaceRoot: config?.workspaceRoot,
    config,
  });
  const journalDir = normalizeText(officePaths?.journalFile) ? path.dirname(officePaths.journalFile) : "";
  for (const candidate of [officePaths.inboxRoot, officePaths.notesRoot, journalDir]) {
    const normalized = normalizeText(candidate);
    if (normalized && !roots.includes(normalized)) {
      roots.push(normalized);
    }
  }

  return roots;
}

function sortInboundUpdateMessages(messages) {
  return Array.isArray(messages)
    ? messages.slice().sort(compareRawInboundUpdateMessages)
    : [];
}

function compareRawInboundUpdateMessages(left, right) {
  const leftTime = resolveRawInboundMessageTimeMs(left);
  const rightTime = resolveRawInboundMessageTimeMs(right);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const leftMessageId = parseMessageIdForOrdering(left?.message_id);
  const rightMessageId = parseMessageIdForOrdering(right?.message_id);
  if (leftMessageId !== rightMessageId) {
    return leftMessageId - rightMessageId;
  }

  const leftSeq = parseNumericOrderValue(left?.seq);
  const rightSeq = parseNumericOrderValue(right?.seq);
  if (leftSeq !== rightSeq) {
    return leftSeq - rightSeq;
  }

  return String(left?.client_id || "").localeCompare(String(right?.client_id || ""));
}

function resolveRawInboundMessageTimeMs(message) {
  const createdAtMs = parseNumericOrderValue(message?.create_time_ms);
  if (createdAtMs > 0) {
    return createdAtMs;
  }
  const createdAtSeconds = parseNumericOrderValue(message?.create_time);
  return createdAtSeconds > 0 ? createdAtSeconds * 1000 : 0;
}

function comparePendingInboundMessages(left, right) {
  const leftTime = Date.parse(String(left?.receivedAt || "")) || 0;
  const rightTime = Date.parse(String(right?.receivedAt || "")) || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  const leftMessageId = parseMessageIdForOrdering(left?.messageId);
  const rightMessageId = parseMessageIdForOrdering(right?.messageId);
  if (leftMessageId !== rightMessageId) {
    return leftMessageId - rightMessageId;
  }

  return String(left?.text || "").localeCompare(String(right?.text || ""));
}

function parseMessageIdForOrdering(value) {
  const numeric = parseNumericOrderValue(value);
  return numeric > 0 ? numeric : Number.MAX_SAFE_INTEGER;
}

function parseNumericOrderValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const DEFERRED_REPLY_NOTICE = formatBridgeNotice("deferred_delivery", [
  "source: bridge",
  "status: previous_delivery_failed",
  "reason: wechat_context_token_expired_or_send_failed",
  "result: replaying_with_current_context_token",
  "tuning: /chunk <number>",
]);
const DEFERRED_PLAIN_REPLY_HEADER = "===== [Mossbridge] pending_plain_reply =====";
const DEFERRED_SYSTEM_REPLY_HEADER = "===== [Mossbridge] pending_system_message =====";

function formatDeferredSystemReplyText(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return DEFERRED_REPLY_NOTICE;
  }
  if (normalized.startsWith(DEFERRED_REPLY_NOTICE)) {
    return normalized;
  }
  return `${DEFERRED_REPLY_NOTICE}\n\n${normalized}`;
}

function formatDeferredSystemReplyBatch(replies) {
  const grouped = groupDeferredReplies(replies);
  if (!grouped.plain.length && !grouped.system.length) {
    return DEFERRED_REPLY_NOTICE;
  }
  const parts = [
    DEFERRED_REPLY_NOTICE,
  ];
  if (grouped.plain.length) {
    parts.push("", DEFERRED_PLAIN_REPLY_HEADER, grouped.plain.join("\n\n"));
  }
  if (grouped.system.length) {
    parts.push("", DEFERRED_SYSTEM_REPLY_HEADER, grouped.system.join("\n\n"));
  }
  return parts.join("\n");
}

function groupDeferredReplies(replies) {
  const grouped = { plain: [], system: [] };
  for (const reply of Array.isArray(replies) ? replies : []) {
    const normalizedText = String(reply?.text || "").trim();
    if (!normalizedText) {
      continue;
    }
    if (reply?.kind === "system_reply") {
      grouped.system.push(normalizedText);
      continue;
    }
    grouped.plain.push(normalizedText);
  }
  return grouped;
}

function summarizeDeferredReplyReasons(replies) {
  const reasons = [];
  for (const reply of Array.isArray(replies) ? replies : []) {
    const reason = normalizeText(reply?.deferReason);
    if (reason && !reasons.includes(reason)) {
      reasons.push(reason);
    }
  }
  return reasons.join(",") || "delivery_failed";
}

function resolveContextTokenAgeMsForAudit(channelAdapter, senderId) {
  if (typeof channelAdapter?.getContextTokenAgeMs !== "function") {
    return null;
  }
  const ageMs = Number(channelAdapter.getContextTokenAgeMs(senderId));
  return Number.isFinite(ageMs) && ageMs >= 0 ? ageMs : null;
}

function resolveDeferredSystemReplyMaxAgeMs(config = {}) {
  const minutes = Number(config.deferredSystemReplyMaxAgeMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }
  return minutes * 60_000;
}

function formatWechatLocalTime(receivedAt) {
  const value = typeof receivedAt === "string" ? receivedAt.trim() : "";
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed).replace(/\//g, "-");
}

function shouldClearFirstRuntimeEventWatchdog(event) {
  const threadId = normalizeCommandArgument(event?.payload?.threadId);
  if (!threadId) {
    return false;
  }
  // process-client emits this immediately after writing to stdin; it is local
  // dispatch progress, not proof that the runtime has returned its first event.
  return normalizeText(event?.type) !== "runtime.turn.started";
}

function stringifyRpcId(value) {
  if (value == null) {
    return "";
  }
  return String(value).trim();
}

function hasRpcId(value) {
  return stringifyRpcId(value) !== "";
}
