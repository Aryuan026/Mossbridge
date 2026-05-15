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
const { runSystemCheckinPoller } = require("../app/system-checkin-poller");
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
  shieldRuntimeNoticeForDelivery,
} = require("./runtime-notices");

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MIN_LONG_POLL_TIMEOUT_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;
const RETRY_DELAY_MS = 2_000;
const BACKOFF_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const FIRST_RUNTIME_EVENT_NOTICE_TIMEOUT_MS = 8_000;
const FIRST_RUNTIME_EVENT_FAILURE_TIMEOUT_MS = 45_000;
const OPENING_CLAUDECODE_FIRST_EVENT_FAILURE_TIMEOUT_MS = 90_000;
const RUNNING_TURN_STALL_NOTICE_TIMEOUT_MS = 90_000;
const RUNNING_TURN_STALL_RECOVERY_TIMEOUT_MS = 240_000;
const CLAUDECODE_RUNNING_TURN_STALL_NOTICE_TIMEOUT_MS = 150_000;
const CLAUDECODE_RUNNING_TURN_STALL_RECOVERY_TIMEOUT_MS = 360_000;
const MAX_SYSTEM_RUNTIME_TEXT_CHARS = 24_000;
const DEFAULT_CHECKIN_RUNTIME_TEXT_CHARS = 8_000;
const SYSTEM_FAILURE_NOTICE_THROTTLE_MS = 30 * 60_000;
const MAX_INBOUND_STICKER_IMAGE_BATCH = 10;
const INBOUND_IMAGE_BATCH_IDLE_MS = 8_000;
const INBOUND_IMAGE_TEXT_BATCH_IDLE_MS = 6_000;

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
    this.weixinIngressAuditStore = new WeixinIngressAuditStore({ filePath: config.weixinIngressAuditFile });
    this.systemMessageQueue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
    this.deferredSystemReplyQueue = new DeferredSystemReplyStore({ filePath: config.deferredSystemReplyQueueFile });
    this.checkinConfigStore = new CheckinConfigStore({ filePath: config.checkinConfigFile });
    this.timelineScreenshotQueue = new TimelineScreenshotQueueStore({ filePath: config.timelineScreenshotQueueFile });
    this.reminderQueue = new ReminderQueueStore({ filePath: config.reminderQueueFile });
    this.turnGateStore = new TurnGateStore();
    this.pendingInboundByScope = new Map();
    this.pendingImageInboundByScope = new Map();
    this.inboundUpdateBatchDepth = 0;
    this.deferredImageInboundFlushScopeKeys = new Set();
    this.turnBoundaryScopeKeys = new Set();
    this.turnWritebackContextByRunKey = new Map();
    this.pendingTurnWritebackByThreadId = new Map();
    this.residentAnchorPreludeKeys = new Set();
    this.stableTurnGuidanceKeys = new Set();
    this.systemMessageDispatcher = null;
    this.streamDelivery = new StreamDelivery({
      channelAdapter: this.channelAdapter,
      sessionStore: this.runtimeAdapter.getSessionStore(),
      onDeferredSystemReply: (payload) => this.deferSystemReply(payload),
      onRuntimeNotice: (payload) => this.recordRuntimeNotice(payload),
    });
    this.pendingRuntimeEventWatchdogs = new Map();
    this.runningTurnWatchdogs = new Map();
    this.watchdogCancelledRunKeys = new Set();
    this.pendingAutoCompactByThreadId = new Map();
    this.lastAutoCompactAtByThreadId = new Map();
    this.pendingOperationByRunKey = new Map();
    this.lastSystemFailureNoticeAtByKey = new Map();
    this.runtimeEventChain = Promise.resolve();
    this.nextDreamingPollAtMs = 0;
    this.runtimeAdapter.onEvent((event) => {
      this.clearRuntimeEventWatchdog(event?.payload?.threadId);
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
    console.log(JSON.stringify({
      stateDir: this.config.stateDir,
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
        diagnosticMemoryPolicy: "Failure reports, quota notices, and maintenance chatter must stay out of memory/dreaming capture.",
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
      this.clearPendingImageInboundTimers();
      await this.closeLocationServer();
      await this.runtimeAdapter.close();
    });

    try {
      let consecutiveFailures = 0;
      while (!shutdown.stopped) {
        try {
          await Promise.all([
            this.maybeQueueDreaming(account),
            this.flushDueReminders(account),
            this.flushPendingInboundMessages(),
            this.flushPendingSystemMessages(),
            this.flushPendingTimelineScreenshots(account),
          ]);
          const syncBufferBefore = this.channelAdapter.loadSyncBuffer();
          const response = await this.channelAdapter.getUpdates({
            syncBuffer: syncBufferBefore,
            timeoutMs: this.resolveLongPollTimeoutMs(),
          });
          assertWeixinUpdateResponse(response);
          consecutiveFailures = 0;
          const messages = sortInboundUpdateMessages(Array.isArray(response?.msgs) ? response.msgs : []);
          this.recordWeixinPollAudit({ response, messages, syncBufferBefore });
          this.beginInboundUpdateBatch(messages.length);
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
          await Promise.all([
            this.maybeQueueDreaming(account),
            this.flushDueReminders(account),
            this.flushPendingInboundMessages(),
            this.flushPendingSystemMessages(),
            this.flushPendingTimelineScreenshots(account),
          ]);
        } catch (error) {
          if (shutdown.stopped) {
            break;
          }

          if (isSessionExpiredError(error)) {
            throw new Error("The WeChat session has expired. Run `npm run login` again.");
          }

          consecutiveFailures += 1;
          console.error(`[mossbridge] poll failed: ${formatErrorMessage(error)}`);
          await sleep(consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_DELAY_MS : RETRY_DELAY_MS);
        }
      }
    } finally {
      shutdown.dispose();
      this.clearPendingImageInboundTimers();
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

  recordWeixinInboundAudit({ stage = "", rawMessage = null, normalized = null, error = null } = {}) {
    const textPreview = normalized
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

  deferSystemReply({ threadId = "", userId = "", text = "", error = null, kind = "plain_reply" }) {
    const queued = this.deferredSystemReplyQueue.enqueue({
      id: `${normalizeCommandArgument(threadId) || "system"}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      accountId: this.activeAccountId || this.channelAdapter.resolveAccount().accountId,
      senderId: userId,
      threadId,
      text,
      kind,
      createdAt: new Date().toISOString(),
      failedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error || ""),
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

  recordRuntimeNotice({ text = "", threadId = "", source = "", provider = "" } = {}) {
    if (!isRuntimeCapacityNotice(text)) {
      return null;
    }
    const cooldown = this.runtimeCooldownStore.setCapacityCooldown({
      runtimeId: this.config.runtime || "codex",
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
    const pendingReplies = this.deferredSystemReplyQueue.drainForSender(normalized.accountId, normalized.senderId);
    if (!pendingReplies.length) {
      return;
    }
    const bindingKey = this.runtimeAdapter.getSessionStore().buildBindingKey({
      workspaceId: normalized.workspaceId,
      accountId: normalized.accountId,
      senderId: normalized.senderId,
    });
    this.streamDelivery.setDeferredReplyPrefix(bindingKey, formatDeferredSystemReplyBatch(pendingReplies));
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
    const prepared = await this.prepareIncomingMessageForRuntime(normalized, workspaceRoot);
    if (!prepared) {
      return;
    }

    if (shouldBatchImageContextInbound(prepared)) {
      this.enqueuePendingImageInbound({ bindingKey, workspaceRoot, prepared });
      return;
    }

    if (this.hasPendingImageInbound(bindingKey, workspaceRoot) && isPlainTextPreparedMessage(prepared)) {
      this.enqueuePendingImageInbound({
        bindingKey,
        workspaceRoot,
        prepared,
        delayMs: INBOUND_IMAGE_TEXT_BATCH_IDLE_MS,
      });
      return;
    }

    if (this.hasPendingImageInbound(bindingKey, workspaceRoot)) {
      await this.flushPendingImageInboundBatch({ bindingKey, workspaceRoot });
    }

    await this.routePreparedInbound({ bindingKey, workspaceRoot, prepared });
  }

  isTurnDispatchBlocked(bindingKey, workspaceRoot, { ignoreBoundary = false } = {}) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!ignoreBoundary && scopeKey && this.turnBoundaryScopeKeys?.has(scopeKey)) {
      return true;
    }
    if (this.turnGateStore.isPending(bindingKey, workspaceRoot)) {
      return true;
    }
    const threadId = this.runtimeAdapter.getSessionStore().getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const threadState = threadId ? this.threadStateStore.getThreadState(threadId) : null;
    return threadState?.status === "running" || hasRpcId(threadState?.pendingApproval?.requestId);
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
          "消息在进入 runtime 前失败。",
          messageText,
        ]),
        contextToken: prepared.contextToken,
      }).catch(() => {});
      return false;
    }
  }

  async routePreparedInbound({ bindingKey, workspaceRoot, prepared }) {
    const cooldown = this.runtimeCooldownStore?.getActiveCooldown?.(this.config.runtime || "codex");
    if (cooldown) {
      this.recordControlEvent?.({
        type: "runtime.cooldown.blocked_turn",
        layer: CONTROL_LAYER.TACTICAL,
        scope: CONTROL_SCOPE.RUNTIME,
        source: "app.routePreparedInbound",
        subject: this.config.runtime || "runtime",
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
          runtimeId: this.config.runtime || "codex",
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

  hasPendingImageInbound(bindingKey, workspaceRoot) {
    return this.pendingImageInboundByScope.has(buildScopeKey(bindingKey, workspaceRoot));
  }

  beginInboundUpdateBatch(messageCount = 0) {
    if (Number(messageCount) <= 1) {
      return;
    }
    this.inboundUpdateBatchDepth = Math.max(0, Number(this.inboundUpdateBatchDepth) || 0) + 1;
  }

  endInboundUpdateBatch() {
    if (!(Number(this.inboundUpdateBatchDepth) > 0)) {
      return;
    }
    this.inboundUpdateBatchDepth = Math.max(0, Number(this.inboundUpdateBatchDepth) - 1);
    if (this.inboundUpdateBatchDepth === 0) {
      this.scheduleDeferredImageInboundFlushes();
    }
  }

  shouldDeferImageInboundFlushUntilPollBatchEnds() {
    return Number(this.inboundUpdateBatchDepth) > 0;
  }

  rememberDeferredImageInboundFlush(scopeKey) {
    if (!scopeKey) {
      return;
    }
    if (!(this.deferredImageInboundFlushScopeKeys instanceof Set)) {
      this.deferredImageInboundFlushScopeKeys = new Set();
    }
    this.clearPendingImageInboundTimer(scopeKey);
    this.deferredImageInboundFlushScopeKeys.add(scopeKey);
  }

  scheduleDeferredImageInboundFlushes() {
    const scopeKeys = this.deferredImageInboundFlushScopeKeys instanceof Set
      ? Array.from(this.deferredImageInboundFlushScopeKeys)
      : [];
    if (this.deferredImageInboundFlushScopeKeys instanceof Set) {
      this.deferredImageInboundFlushScopeKeys.clear();
    }
    for (const scopeKey of scopeKeys) {
      const draft = this.pendingImageInboundByScope.get(scopeKey);
      if (!draft?.bindingKey || !draft?.workspaceRoot) {
        continue;
      }
      this.schedulePendingImageInboundFlush(scopeKey, draft.bindingKey, draft.workspaceRoot);
    }
  }

  enqueuePendingImageInbound({ bindingKey, workspaceRoot, prepared, delayMs = INBOUND_IMAGE_BATCH_IDLE_MS }) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    if (!scopeKey || !prepared) {
      return;
    }

    const current = this.pendingImageInboundByScope.get(scopeKey) || {
      bindingKey,
      workspaceRoot,
      messages: [],
      timer: null,
    };
    current.messages.push(clonePreparedInboundMessage(prepared));
    this.pendingImageInboundByScope.set(scopeKey, current);
    void this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});
    const shouldDeferFlush = typeof this.shouldDeferImageInboundFlushUntilPollBatchEnds === "function"
      ? this.shouldDeferImageInboundFlushUntilPollBatchEnds()
      : Number(this.inboundUpdateBatchDepth) > 0;
    if (shouldDeferFlush) {
      if (typeof this.rememberDeferredImageInboundFlush === "function") {
        this.rememberDeferredImageInboundFlush(scopeKey);
      } else {
        this.clearPendingImageInboundTimer(scopeKey);
      }
      return;
    }
    this.schedulePendingImageInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs);
  }

  schedulePendingImageInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs = INBOUND_IMAGE_BATCH_IDLE_MS) {
    const draft = this.pendingImageInboundByScope.get(scopeKey);
    if (!draft) {
      return;
    }
    if (draft.timer) {
      clearTimeout(draft.timer);
    }
    draft.timer = setTimeout(() => {
      void this.flushPendingImageInboundBatch({ bindingKey, workspaceRoot }).catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`[mossbridge] image inbound debounce flush failed ${message}`);
      });
    }, Math.max(0, Number(delayMs) || 0));
    this.pendingImageInboundByScope.set(scopeKey, draft);
  }

  clearPendingImageInboundTimer(scopeKey) {
    const draft = this.pendingImageInboundByScope.get(scopeKey);
    if (!draft?.timer) {
      return;
    }
    clearTimeout(draft.timer);
    draft.timer = null;
  }

  clearPendingImageInboundTimers() {
    for (const [scopeKey] of this.pendingImageInboundByScope.entries()) {
      this.clearPendingImageInboundTimer(scopeKey);
    }
  }

  async flushPendingImageInboundBatch({ bindingKey = "", workspaceRoot = "", trailingPrepared = null } = {}) {
    const scopeKey = buildScopeKey(bindingKey, workspaceRoot);
    const draft = scopeKey ? this.pendingImageInboundByScope.get(scopeKey) || null : null;
    if (!draft?.bindingKey || !draft?.workspaceRoot) {
      if (scopeKey) {
        this.pendingImageInboundByScope.delete(scopeKey);
      }
      return false;
    }

    this.clearPendingImageInboundTimer(scopeKey);
    this.pendingImageInboundByScope.delete(scopeKey);

    const queued = Array.isArray(draft.messages)
      ? draft.messages
        .filter((message) => message && typeof message === "object")
        .slice()
        .sort(comparePendingInboundMessages)
      : [];
    if (!queued.length) {
      return false;
    }

    const { batchMessages, remainingMessages } = takeImageContextBatchMessages(queued, MAX_INBOUND_STICKER_IMAGE_BATCH);
    if (!batchMessages.length) {
      return false;
    }

    if (remainingMessages.length) {
      this.pendingImageInboundByScope.set(scopeKey, {
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
      await this.flushPendingImageInboundBatch({
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
    const suppressNotice = openingTurn && isClaudeCode;
    const noticeTimeoutMs = suppressNotice ? 0 : FIRST_RUNTIME_EVENT_NOTICE_TIMEOUT_MS;
    const failureTimeoutMs = openingTurn && isClaudeCode
      ? OPENING_CLAUDECODE_FIRST_EVENT_FAILURE_TIMEOUT_MS
      : FIRST_RUNTIME_EVENT_FAILURE_TIMEOUT_MS;

    this.clearRuntimeEventWatchdog(normalizedThreadId);
    const noticeTimer = noticeTimeoutMs > 0
      ? setTimeout(async () => {
        const watchdog = this.pendingRuntimeEventWatchdogs.get(normalizedThreadId);
        if (!watchdog) {
          return;
        }
        const currentThreadState = this.threadStateStore.getThreadState(normalizedThreadId);
        if (currentThreadState?.status === "running" || currentThreadState?.turnId) {
          return;
        }
        watchdog.noticeSent = true;
        const noticeLines = [
          `消息已到达桥，但 ${formatRuntimeLabel(runtimeName)} 尚未返回首个事件。`,
          isCodex
            ? "可能仍在 shared-thread 启动或重连阶段。"
            : "可能仍在启动、重连或处理本轮输入。",
          "这是一条桥状态提示，不是助手回复。",
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
      const currentThreadState = this.threadStateStore.getThreadState(normalizedThreadId);
      if (currentThreadState?.status === "running" || currentThreadState?.turnId) {
        return;
      }
      await this.channelAdapter.sendTyping({
        userId: normalized.senderId,
        status: 0,
        contextToken: normalized.contextToken,
      }).catch(() => {});
      const failureLines = [
        `消息已到达桥，但 ${formatRuntimeLabel(runtimeName)} 超时未返回首个事件。`,
        openingTurn
          ? "新线程首轮可能启动失败。"
          : "runtime 进程可能卡住、退出，或没有接入当前 shared thread。",
        `workspace: ${workspaceRoot}`,
        `thread: ${normalizedThreadId}`,
        "建议检查：",
        isCodex ? "1. npm run shared:status" : "1. npm run shared:status:claudecode",
        isCodex ? "2. npm run shared:start" : "2. npm run shared:start:claudecode",
        isCodex ? "3. npm run shared:open" : "3. npm run shared:open:claudecode",
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
    const noticeTimeoutMs = isClaudeCode
      ? CLAUDECODE_RUNNING_TURN_STALL_NOTICE_TIMEOUT_MS
      : RUNNING_TURN_STALL_NOTICE_TIMEOUT_MS;
    const recoveryTimeoutMs = isClaudeCode
      ? CLAUDECODE_RUNNING_TURN_STALL_RECOVERY_TIMEOUT_MS
      : RUNNING_TURN_STALL_RECOVERY_TIMEOUT_MS;

    const noticeTimer = setTimeout(async () => {
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
          `${formatRuntimeLabel(runtimeName)} 已开始处理本轮输入，但尚未产生助手正文。`,
          "这是一条桥状态提示，不是助手回复。",
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
      this.recordControlEvent?.({
        type: "runtime.turn.stalled_released",
        layer: CONTROL_LAYER.EXECUTIVE,
        scope: CONTROL_SCOPE.RUNTIME,
        source: "app.scheduleRunningTurnWatchdog",
        subject: normalizedThreadId,
        severity: CONTROL_SEVERITY.ERROR,
        reason: "runtime_turn_stalled",
        outcome: "cancel_requested",
        correlationId: runKey,
        payload: {
          runtimeName,
          workspaceRoot,
          turnId: normalizedTurnId,
          recoveryTimeoutMs,
        },
      });
      await this.channelAdapter.sendTyping({
        userId: normalized.senderId,
        status: 0,
        contextToken: normalized.contextToken,
      }).catch(() => {});
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        preserveBlock: true,
        text: formatBridgeNotice("runtime_stalled_released", [
          `${formatRuntimeLabel(runtimeName)} 超过 ${Math.round(recoveryTimeoutMs / 60_000)} 分钟未完成本轮输入。`,
          "Mossbridge 已释放这次运行；如仍需要结果，请重新发送请求。",
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
              "图片或附件接收失败。",
              ...persisted.failed.map((item) => item.reason),
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
            messageText,
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

    const prepared = this.systemMessageDispatcher?.buildPreparedMessage(message, this.channelAdapter.getKnownContextTokens()[message.senderId] || "");
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

    const lines = [
      `📍 workspace: ${workspaceRoot}`,
      `🧵 thread: ${threadId || "(none)"}${pendingThreadId ? " (pending verification)" : ""}`,
      `📊 status: ${threadState?.status || "idle"}`,
      `🤖 runtime: ${runtimeName}`,
      `🤖 model: ${effectiveModel || "(default)"}`,
    ];
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
          error instanceof Error ? error.message : String(error || "unknown error"),
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
          error instanceof Error ? error.message : String(error || "unknown error"),
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
        text: "⚠️ Persistent approval for this Codex MCP tool request is not available from WeChat.",
        contextToken: normalized.contextToken,
      });
      return;
    }

    const approvalResponse = buildApprovalResponsePayload(approval, command.name);
    if (!approvalResponse) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: "⚠️ This Codex MCP request cannot be answered from WeChat yet.",
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
    this.threadStateStore.resolveApproval(threadId, "running");
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
        "⭐️ Liked this project? Throw me a star on GitHub!",
        "It really means a lot to an indie dev working on passion projects 💖",
        "",
        "https://github.com/WenXiaoWendy/cyberboss",
      ].join("\n"),
      contextToken: normalized.contextToken,
    });
    await this.channelAdapter.sendFile({
      userId: normalized.senderId,
      filePath: path.join(__dirname, "../../assets/star-guide.jpg"),
      contextToken: normalized.contextToken,
    }).catch(() => {});
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
        this.threadStateStore.resolveApproval(event.payload.threadId, "running");
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
      await this.sendApprovalPrompt({
        bindingKey: linked.bindingKey,
        approval: event.payload,
      }).catch((error) => {
        sessionStore.clearApprovalPrompt(event.payload.threadId);
        throw error;
      });
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
    this.threadStateStore.resolveApproval(event.payload.threadId, "running");
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
    if (isRuntimeCapacityNotice(rawText)) {
      this.recordRuntimeNotice({
        text: rawText,
        threadId,
        source: "runtime_turn_failed",
        provider: target.provider,
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
    const runtimeNotice = shieldRuntimeNoticeForDelivery(rawText, { provider: target.provider });
    if (runtimeNotice.shielded && runtimeNotice.action === "silent") {
      return;
    }
    await this.channelAdapter.sendText({
      userId: target.userId,
      text: runtimeNotice.shielded
        ? runtimeNotice.text
        : formatRuntimeFailureForUser(rawText, { provider: target.provider }),
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
      const includeStableTurnGuidance = shouldIncludeStableTurnGuidance(
        stableGuidanceKey,
        this.stableTurnGuidanceKeys,
      );
      const contextPressure = this.resolveMemoryContextPressureProfile?.(normalized, workspaceRoot) || null;
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
        ...buildMemoryCapturePressureOptions(normalized, {
          residentAlreadyDelivered,
          includeRuntimePreludeGuidance: includeStableTurnGuidance,
          contextPressure,
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
      const frontstageNote = includeStableTurnGuidance ? buildWechatFrontstageTurnNote(normalized) : "";
      const toolHoverNote = includeStableTurnGuidance ? buildWechatToolHoverNote(normalized) : "";
      const sections = [frontstageNote, toolHoverNote, prelude].filter(Boolean);
      const delivery = buildMemoryDeliveryReport({
        normalized,
        baseText,
        frontstageNote,
        toolHoverNote,
        prelude,
        sections,
        contextPressure,
        includeStableTurnGuidance,
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
      if (includeStableTurnGuidance && stableGuidanceKey && (frontstageNote || toolHoverNote)) {
        this.markStableTurnGuidanceDelivered(stableGuidanceKey);
      }
      if (!sections.length) {
        return {
          text: baseText,
          packet: packetWithDelivery,
        };
      }
      return {
        text: `${sections.join("\n\n")}\n\n===== Current Inbound Message =====\n${baseText}`,
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
    const runtimeCapacityNotice = isRuntimeCapacityNotice(rawAssistantTextFinal);
    const runtimeFailureNotice = event.type === "runtime.turn.failed";
    const assistantTextFinal = runtimeCapacityNotice || runtimeFailureNotice ? "" : rawAssistantTextFinal;
    const role = snapshot.prepared.provider === "system" ? "system" : "user";
    const incomingTextForCache = buildIncomingTextForConversationCache(snapshot.prepared);
    let writebackResult = null;
    let writebackError = null;
    try {
      writebackResult = await memoryDomain.writebackTurn({
        userId: snapshot.prepared.senderId,
        senderId: snapshot.prepared.senderId,
        accountId: snapshot.prepared.accountId,
        query: incomingTextForCache,
        incomingMessages: [
          {
            role,
            content: incomingTextForCache,
            timestamp: snapshot.prepared.receivedAt || new Date().toISOString(),
          },
        ],
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
    "用户发来的 emoji、表情包或括号小动作只作为情绪线索；不要把 `[微笑]` 这类传输占位符当成你的表达习惯。",
    "先接住这一拍的情绪和关系节奏，再决定要不要提问或处理事实；自然、亲近、具体，比机械简短更重要。",
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
    "- 记忆、提醒、日记、episode、观察：如果这一轮出现未来会复用的信息、跟进点、可修正印象或一个小事件，可以静默维护，不必等用户用工具名提醒。",
    "- 文件/附件：如果已经生成本地文件且当前通道支持发送，可以直接发送；不要假设未安装的外部账号、设备或私有执行器存在。",
    "不要把这些能力变成关键词条件；用完工具后继续自然聊天，不暴露内部 id、协议、队列或路径。",
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

function isBackgroundCheckinOpportunity(normalized = {}) {
  if (normalizeText(normalized?.provider) !== "system") {
    return false;
  }
  const triggerKind = normalizeText(
    normalized?.systemTurn?.trigger_kind
      || normalized?.systemTurn?.triggerKind
      || normalized?.kind
      || normalized?.metadata?.checkinKind,
  );
  return triggerKind === "checkin_opportunity";
}

function isCheckinOpportunityMessage(message = {}) {
  return normalizeText(message?.kind) === "checkin_opportunity";
}

function buildMemoryCapturePressureOptions(
  normalized = {},
  {
    residentAlreadyDelivered = false,
    includeRuntimePreludeGuidance = false,
    contextPressure = null,
  } = {},
) {
  const pressureOptions = buildTokenPressureMemoryOptions(contextPressure, {
    background: isBackgroundCheckinOpportunity(normalized),
  });
  if (!isBackgroundCheckinOpportunity(normalized)) {
    return {
      includeRuntimePreludeGuidance: Boolean(includeRuntimePreludeGuidance),
      residentLimit: residentAlreadyDelivered ? 0 : undefined,
      ...pressureOptions,
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
  };
}

function shouldIncludeStableTurnGuidance(stableGuidanceKey = "", deliveredKeys = null) {
  const key = normalizeCommandArgument(stableGuidanceKey);
  if (!key || key.endsWith("::opening")) {
    return false;
  }
  return !deliveredKeys || !deliveredKeys.has(key);
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
  return raw;
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

function formatRuntimeFailureForUser(text, { provider = "" } = {}) {
  const normalized = normalizeText(text) || "❌ Execution failed";
  const kind = classifyRuntimeFailureKind(normalized);
  if (kind === "prompt_too_long") {
    return formatBridgeNotice("runtime_prompt_too_long", [
      "ClaudeCode prompt 超过上下文限制，Mossbridge 已释放本轮运行。",
      provider === "system"
        ? "这是后台唤醒失败提示，不会作为助手正文发送。"
        : "当前轮次没有生成助手正文；请缩短请求或 compact 后重试。",
    ]);
  }
  if (kind === "bad_json") {
    return formatBridgeNotice("runtime_bad_json", [
      "ClaudeCode 拒绝了本轮请求体，Mossbridge 已隔离这次运行。",
      "常见原因是特殊字符或内部 JSON 被 runtime 判定为非法；请重新发送请求。",
    ]);
  }
  if (kind === "api_error") {
    return formatBridgeNotice("runtime_api_error", [
      "ClaudeCode 返回 API 错误，Mossbridge 已释放本轮运行。",
      "这是一条桥状态提示，不是助手回复；不会写入记忆。",
      "如仍需要结果，请在 provider 恢复后重新发送请求。",
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
    out.push("⚠️ This Codex MCP request cannot be answered from WeChat yet.");
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
    lines.push(`回复 ${userName} 之前，请先查看附件本体，不要只凭文件名或缓存说明猜。`);
    if (saved.some((item) => isImageAttachmentItem(item))) {
      if (runtimeUsesReadForImages(runtimeId)) {
        lines.push("图片请对保存后的本地图片文件使用 `Read`。");
      } else {
        lines.push("图片请使用 `view_image`。");
      }
      lines.push("如果图片明显适合作为可复用表情包，可以在看过之后用 sticker 工具保存。");
    }
    const imageContextCount = saved.filter((item) => isImageAttachmentItem(item)).length
      + failed.filter((item) => isImageAttachmentFailureItem(item)).length;
    if (imageContextCount > 1) {
      lines.push("这些图片可能属于同一组连续分享。先看完所有可用图片，再合成一段自然回应；除非用户要求逐张点评，不要每张都单独长评。");
      lines.push("考虑微信投递，尽量把多图回应收成一两条自然气泡能承载的长度。");
    }
    if (officePaths.notesRoot) {
      lines.push("如果附件之后还可能被用到，可以更新配套说明笔记，留下简短事实摘要，不要只依赖原文件。");
      lines.push(`长期附件说明笔记放在：${officePaths.notesRoot}`);
    }
    lines.push(`如果缺少必要工具，请直接告诉 ${userName} 缺了什么，以及目前还不能读取该文件。`);
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
      lines.push("If some attachments failed but others were saved, briefly mention the failed item after considering the saved attachments; do not ignore the saved attachments because one item failed.");
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

function shouldBatchImageContextInbound(message) {
  return isImageContextPreparedMessage(message);
}

function isImageContextPreparedMessage(message) {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const attachmentFailures = Array.isArray(message?.attachmentFailures) ? message.attachmentFailures : [];
  if (!attachments.length && !attachmentFailures.length) {
    return false;
  }
  return attachments.every((item) => isImageAttachmentItem(item))
    && attachmentFailures.every((item) => isImageAttachmentFailureItem(item));
}

function takeImageContextBatchMessages(messages, maxAttachments) {
  const batchMessages = [];
  const remainingMessages = [];
  let remainingCapacity = Math.max(1, Number(maxAttachments) || 1);
  let hasImageInBatch = false;

  for (const message of Array.isArray(messages) ? messages : []) {
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    const imageContext = isImageContextPreparedMessage(message);
    if (!attachments.length && isPlainTextPreparedMessage(message) && hasImageInBatch) {
      batchMessages.push(message);
      continue;
    }
    if (!attachments.length && imageContext) {
      batchMessages.push(message);
      hasImageInBatch = true;
      continue;
    }
    if (!attachments.length) {
      remainingMessages.push(message);
      continue;
    }
    if (!imageContext) {
      remainingMessages.push(message);
      continue;
    }
    if (remainingCapacity <= 0) {
      remainingMessages.push(message);
      continue;
    }
    if (attachments.length <= remainingCapacity) {
      batchMessages.push(message);
      remainingCapacity -= attachments.length;
      hasImageInBatch = true;
      continue;
    }
    batchMessages.push({
      ...message,
      attachments: attachments.slice(0, remainingCapacity),
    });
    hasImageInBatch = true;
    remainingMessages.push({
      ...message,
      attachments: attachments.slice(remainingCapacity),
    });
    remainingCapacity = 0;
  }

  return {
    batchMessages,
    remainingMessages,
  };
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

function isImageAttachmentItem(item) {
  return Boolean(item?.isImage) || normalizeText(item?.contentType).toLowerCase().startsWith("image/")
    || normalizeText(item?.kind).toLowerCase() === "image";
}

function isImageAttachmentFailureItem(item) {
  return normalizeText(item?.contentType).toLowerCase().startsWith("image/")
    || normalizeText(item?.kind).toLowerCase() === "image"
    || Boolean(normalizeText(item?.sourceFileName).toLowerCase().match(/\.(png|jpe?g|gif|webp|bmp|heic|heif)$/u));
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
  "上一轮有内容因 WeChat context_token 失效未能发送；本次 token 刷新后补发。",
  "若频繁出现，可发送 /chunk <数字> 调大最小合并字符数。",
]);
const DEFERRED_PLAIN_REPLY_HEADER = "===== [Mossbridge] 上轮未送达内容 =====";
const DEFERRED_SYSTEM_REPLY_HEADER = "===== [Mossbridge] 期间主动消息 =====";

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

function stringifyRpcId(value) {
  if (value == null) {
    return "";
  }
  return String(value).trim();
}

function hasRpcId(value) {
  return stringifyRpcId(value) !== "";
}
