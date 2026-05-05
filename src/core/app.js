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
const { findModelByQuery } = require("../adapters/runtime/codex/model-catalog");
const { createTimelineIntegration } = require("../integrations/timeline");
const { buildWeixinHelpText } = require("./command-registry");
const { CheckinConfigStore, parseCheckinRangeMinutes, resolveDefaultCheckinRange } = require("./checkin-config-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("./default-targets");
const { resolveWorkspaceOfficePaths } = require("./workspace-office-layout");
const { StreamDelivery } = require("./stream-delivery");
const { ThreadStateStore } = require("./thread-state-store");
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
const { recordUserMessage, recordAiReply } = require("./activity-tracker");
const { isRuntimeCapacityNotice, shieldRuntimeNoticeForDelivery } = require("./runtime-notices");

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
const SYSTEM_FAILURE_NOTICE_THROTTLE_MS = 30 * 60_000;
const MAX_INBOUND_STICKER_IMAGE_BATCH = 10;
const INBOUND_IMAGE_BATCH_IDLE_MS = 1_500;
const INBOUND_IMAGE_TEXT_BATCH_IDLE_MS = 3_000;

function createRuntimeAdapter(config) {
  if (config.runtime === "claudecode") {
    return createClaudeCodeRuntimeAdapter(config);
  }
  return createCodexRuntimeAdapter(config);
}

class CyberbossApp {
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
    this.threadStateStore = new ThreadStateStore();
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
    this.turnBoundaryScopeKeys = new Set();
    this.turnWritebackContextByRunKey = new Map();
    this.pendingTurnWritebackByThreadId = new Map();
    this.systemMessageDispatcher = null;
    this.streamDelivery = new StreamDelivery({
      channelAdapter: this.channelAdapter,
      sessionStore: this.runtimeAdapter.getSessionStore(),
      onDeferredSystemReply: (payload) => this.deferSystemReply(payload),
    });
    this.pendingRuntimeEventWatchdogs = new Map();
    this.runningTurnWatchdogs = new Map();
    this.watchdogCancelledRunKeys = new Set();
    this.pendingAutoCompactByThreadId = new Map();
    this.lastAutoCompactAtByThreadId = new Map();
    this.pendingOperationByRunKey = new Map();
    this.lastSystemFailureNoticeAtByKey = new Map();
    this.runtimeEventChain = Promise.resolve();
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
          console.error(`[asheriebridge] runtime event handling failed type=${event?.type || "(unknown)"} ${message}`);
        });
    });
  }

  printDoctor() {
    console.log(JSON.stringify({
      stateDir: this.config.stateDir,
      channel: this.channelAdapter.describe(),
      runtime: this.runtimeAdapter.describe(),
      timeline: this.timelineIntegration.describe(),
      memory: this.projectDomains?.memory?.describe ? this.projectDomains.memory.describe() : null,
      threads: this.threadStateStore.snapshot(),
    }, null, 2));
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

    console.log("[asheriebridge] bootstrap ok");
    console.log(`[asheriebridge] channel=${this.channelAdapter.describe().id}`);
    console.log(`[asheriebridge] runtime=${this.runtimeAdapter.describe().id}`);
    console.log(`[asheriebridge] timeline=${this.timelineIntegration.describe().id}`);
    console.log(`[asheriebridge] account=${account.accountId}`);
    console.log(`[asheriebridge] baseUrl=${account.baseUrl}`);
    console.log(`[asheriebridge] workspaceRoot=${this.config.workspaceRoot}`);
    console.log(`[asheriebridge] knownContextTokens=${knownContextTokens}`);
    console.log(`[asheriebridge] syncBuffer=${syncBuffer ? "ready" : "empty"}`);
    console.log(`[asheriebridge] runtimeEndpoint=${runtimeState.endpoint || runtimeState.command || "(spawn)"}`);
    console.log(`[asheriebridge] runtimeModels=${runtimeState.models?.length || 0}`);
    if (this.config.startWithLocationServer) {
      await this.ensureLocationServerStarted();
    }
    console.log("[asheriebridge] bridge loop started; waiting for WeChat messages.");
    if (this.config.startWithCheckin) {
      console.log("[asheriebridge] checkin: enabled");
      void runSystemCheckinPoller(this.config).catch((error) => {
        console.error(`[asheriebridge] checkin poller stopped: ${error.message}`);
      });
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
          for (const message of messages) {
            if (shutdown.stopped) {
              break;
            }
            await this.handleIncomingMessage(message);
          }
          await Promise.all([
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
          console.error(`[asheriebridge] poll failed: ${formatErrorMessage(error)}`);
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
      `[asheriebridge] locationServer=http://${this.config.locationHost}:${this.config.locationPort} store=${this.config.locationStoreFile}`
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
      console.log(`[asheriebridge] weixin poll messages=${messageCount}`);
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
      console.log(`[asheriebridge] weixin inbound ${event.stage} message=${event.messageId || "(unknown)"}${suffix}`);
    }
  }

  deferSystemReply({ threadId = "", userId = "", text = "", error = null, kind = "plain_reply" }) {
    return this.deferredSystemReplyQueue.enqueue({
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
      `[asheriebridge] queued deferred reply prefix sender=${normalized.senderId} count=${pendingReplies.length}`
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

    try {
      const dispatchedAtMs = Date.now();
      const turn = await this.runtimeAdapter.sendTextTurn({
        bindingKey,
        workspaceRoot,
        text: prepared.text,
        model: this.runtimeAdapter.getSessionStore().getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model,
        metadata: {
          workspaceId: prepared.workspaceId,
          accountId: prepared.accountId,
          senderId: prepared.runtimeBindingSenderId || prepared.senderId,
          replySenderId: prepared.senderId,
          systemRuntimeBinding: Boolean(prepared.systemRuntimeBinding),
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
      await this.channelAdapter.sendText({
        userId: prepared.senderId,
        text: `❌ Request failed\n${messageText}`,
        contextToken: prepared.contextToken,
      }).catch(() => {});
      return false;
    }
  }

  async routePreparedInbound({ bindingKey, workspaceRoot, prepared }) {
    if (this.isTurnDispatchBlocked(bindingKey, workspaceRoot)) {
      this.bufferPendingInboundMessage({ bindingKey, workspaceRoot, prepared });
      return false;
    }
    return this.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared });
  }

  hasPendingImageInbound(bindingKey, workspaceRoot) {
    return this.pendingImageInboundByScope.has(buildScopeKey(bindingKey, workspaceRoot));
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
    this.schedulePendingImageInboundFlush(scopeKey, bindingKey, workspaceRoot, delayMs);
    void this.channelAdapter.sendTyping({
      userId: prepared.senderId,
      status: 1,
      contextToken: prepared.contextToken,
    }).catch(() => {});
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
        console.error(`[asheriebridge] image inbound debounce flush failed ${message}`);
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
        const noticeLines = isCodex
          ? [
              `⏳ This message has already reached the bridge, but ${runtimeName} has not returned the first event yet.`,
              "If your terminal is still reconnecting, this round is probably still stuck in shared-thread startup.",
              "You do not need to keep waiting in chat. If it reconnects later, the message will continue.",
              `workspace: ${workspaceRoot}`,
              `thread: ${normalizedThreadId}`,
            ]
          : isClaudeCode
            ? [
                "⏳ 我已经收到这句了，只是 ClaudeCode 这边第一口气还没吐出来。",
                "它这会儿大概率还在处理这轮输入，不一定是坏住了。",
                "你不用继续在聊天框里等着；如果它马上接上，正文会自己回来。",
                `workspace: ${workspaceRoot}`,
                `thread: ${normalizedThreadId}`,
              ]
            : [
                `⏳ This message has already reached the bridge, but ${runtimeName} has not returned the first event yet.`,
                "The runtime process may still be starting up.",
                "You do not need to keep waiting in chat. If it reconnects later, the message will continue.",
                `workspace: ${workspaceRoot}`,
                `thread: ${normalizedThreadId}`,
              ];
        await this.channelAdapter.sendText({
          userId: normalized.senderId,
          contextToken: normalized.contextToken,
          preserveBlock: true,
          text: noticeLines.join("\n"),
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
      const failureLines = isCodex
        ? [
            `❌ This message has already reached the bridge, but ${runtimeName} still has not returned the first event.`,
            "If the reconnecting cycle in the terminal already finished 5 attempts, this shared thread most likely never started successfully.",
            `workspace: ${workspaceRoot}`,
            `thread: ${normalizedThreadId}`,
            "Check these first: whether the shared app-server is healthy, whether the terminal is attached to the same thread, and whether runtime actually started processing this message.",
            "Recommended order:",
            "1. Run `npm run shared:status` in the project directory",
            "2. If the bridge is down, run `npm run shared:start`",
            "3. Open another terminal and run `npm run shared:open`",
            "4. Confirm the terminal is attached to the same thread shown above, not a private thread",
          ]
        : isClaudeCode
          ? [
              "❌ 这句已经进桥了，但 ClaudeCode 这边到现在还没吐出第一条事件。",
              openingTurn
                ? "如果这是新线程的第一轮，现在更像是启动真的卡住了，不只是慢。"
                : "这时就更像是 ClaudeCode 进程本身卡住或退出了。",
              `workspace: ${workspaceRoot}`,
              `thread: ${normalizedThreadId}`,
              "建议顺手看这几步：",
              "1. 在项目目录跑 `npm run shared:status:claudecode`",
              "2. 如果桥没起来，跑 `npm run shared:start:claudecode`",
              "3. 再看一下这条微信绑定是不是还在同一个 workspace 里",
            ]
        : [
            `❌ This message has already reached the bridge, but ${runtimeName} still has not returned the first event.`,
            "The runtime process may have failed to start or exited unexpectedly.",
            `workspace: ${workspaceRoot}`,
            `thread: ${normalizedThreadId}`,
            "Recommended order:",
            "1. Run `npm run shared:status:claudecode` in the project directory",
            "2. If the bridge is down, run `npm run shared:start:claudecode`",
            "3. Open another terminal and run `npm run shared:open:claudecode`",
            "4. Confirm ClaudeCode is still attached to the same workspace shown above",
          ];
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        preserveBlock: true,
        text: failureLines.join("\n"),
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
    console.log(
      `[asheriebridge] auto compact requested thread=${normalizedThreadId} current=${formatCompactNumber(reason?.currentTokens)} threshold=${formatCompactNumber(reason?.compactThresholdTokens)}`
    );
    try {
      const result = await this.runtimeAdapter.compactThread({
        threadId: normalizedThreadId,
        workspaceRoot: linked.workspaceRoot,
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
      console.warn(
        `[asheriebridge] auto compact failed thread=${normalizedThreadId}: ${error instanceof Error ? error.message : String(error || "unknown error")}`
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
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        preserveBlock: true,
        text: [
          "⏳ 这轮我已经收到，ClaudeCode 也已经开始处理，只是正文出来得比较慢。",
          "这是一条慢回提示，不是失败通知；如果后面正文自己回来，可以直接忽略这一条。",
          `workspace: ${workspaceRoot}`,
          `thread: ${normalizedThreadId}`,
        ].join("\n"),
      }).catch(() => {});
    }, noticeTimeoutMs);

    const recoveryTimer = setTimeout(async () => {
      const watchdog = this.runningTurnWatchdogs.get(runKey);
      if (!watchdog || !this.isSameRunningTurn(normalizedThreadId, normalizedTurnId)) {
        return;
      }
      this.runningTurnWatchdogs.delete(runKey);
      this.watchdogCancelledRunKeys.add(runKey);
      await this.channelAdapter.sendTyping({
        userId: normalized.senderId,
        status: 0,
        contextToken: normalized.contextToken,
      }).catch(() => {});
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        preserveBlock: true,
        text: [
          `⚠️ 这轮 ClaudeCode 超过 ${Math.round(recoveryTimeoutMs / 60_000)} 分钟没有完成，我先把卡住的运行释放掉。`,
          "刚才那句话可能需要你重新发一次；后续消息不会继续堵在这轮后面。",
          `workspace: ${workspaceRoot}`,
          `thread: ${normalizedThreadId}`,
        ].join("\n"),
      }).catch(() => {});
      await this.runtimeAdapter.cancelTurn({
        threadId: normalizedThreadId,
        turnId: normalizedTurnId,
        workspaceRoot,
      }).catch((error) => {
        console.error(`[asheriebridge] stalled turn recovery failed thread=${normalizedThreadId}: ${error.message}`);
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

        if (!persisted.saved.length && persisted.failed.length && !String(normalized.text || "").trim()) {
          await this.channelAdapter.sendText({
            userId: normalized.senderId,
            text: `⚠️ Failed to receive image or attachment\n${persisted.failed.map((item) => item.reason).join("\n")}`,
            contextToken: normalized.contextToken,
            preserveBlock: true,
          }).catch(() => {});
          return null;
        }

        runtimeText = buildInboundText(normalized, persisted, this.config, {
          runtimeId: this.runtimeAdapter?.describe?.().id || "",
          workspaceRoot,
        });
        if (!runtimeText) {
          await this.channelAdapter.sendText({
            userId: normalized.senderId,
            text: `⚠️ Failed to receive image or attachment\n${persisted.failed.map((item) => item.reason).join("\n")}`,
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
        console.error(`[asheriebridge] timeline screenshot failed job=${job.id} ${messageText}`);
        await this.channelAdapter.sendTyping({
          userId: job.senderId,
          status: 0,
        }).catch(() => {});
        await this.channelAdapter.sendText({
          userId: job.senderId,
          text: `❌ Timeline screenshot failed\n${messageText}`,
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
    preparedForDispatch.text = clampSystemRuntimeText(memoryContext.text);
    preparedForDispatch.memoryContextPacket = memoryContext.packet;
    return this.dispatchPreparedTurn({ bindingKey, workspaceRoot, prepared: preparedForDispatch });
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
      await this.runtimeAdapter.refreshThreadInstructions({
        threadId,
        workspaceRoot,
        model: sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model,
      });
    } catch (error) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Reread failed\n${error instanceof Error ? error.message : String(error || "unknown error")}`,
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
        text: `❌ Compact failed\n${error instanceof Error ? error.message : String(error || "unknown error")}`,
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
      `[asheriebridge] approval response requested thread=${threadId} requestId=${approval.requestId} mode=${approvalResponse.result ? "result" : "decision"} workspace=${workspaceRoot}`
    );
    await this.runtimeAdapter.respondApproval(approvalResponse);
    this.runtimeAdapter.getSessionStore().clearApprovalPrompt(threadId);
    console.log(
      `[asheriebridge] approval response delivered thread=${threadId} requestId=${approval.requestId}`
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
    const query = normalizeCommandArgument(command.args);
    const sessionStore = this.runtimeAdapter.getSessionStore();
    const catalog = sessionStore.getAvailableModelCatalog();
    const currentModel = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot).model;

    if (!query) {
      const lines = [
        `Current model: ${currentModel || "(default)"}`,
      ];
      if (catalog?.models?.length) {
        lines.push(`Available models: ${catalog.models.map((item) => item.model).join(", ")}`);
      } else {
        lines.push("Available models: (not available)");
      }
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: lines.join("\n"),
        contextToken: normalized.contextToken,
      });
      return;
    }

    const runtimeId = this.runtimeAdapter.describe().id || "runtime";
    let matched = findModelByQuery(catalog?.models || [], query);
    if (!matched && runtimeId !== "codex" && !catalog?.models?.length) {
      matched = { model: query };
    }
    if (!matched) {
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        text: `❌ Model not found\n${query}`,
        contextToken: normalized.contextToken,
      });
      return;
    }

    sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
      model: matched.model,
    });
    await this.channelAdapter.sendText({
      userId: normalized.senderId,
      text: `✅ Model switched\nworkspace: ${workspaceRoot}\nmodel: ${matched.model}`,
      contextToken: normalized.contextToken,
    });
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
          `[asheriebridge] approval auto-denied forbidden identity seed read thread=${event.payload.threadId} requestId=${event.payload.requestId}`
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
          `[asheriebridge] approval prompt deduped thread=${event.payload.threadId} requestId=${event.payload.requestId}`
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
        `[asheriebridge] approval prompt skipped binding=${bindingKey} requestId=${approval?.requestId || ""} reason=no_reply_target`
      );
      return;
    }
    console.log(
      `[asheriebridge] approval prompt sending binding=${bindingKey} user=${target.userId} requestId=${approval?.requestId || ""}`
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
      `[asheriebridge] approval prompt delivered binding=${bindingKey} user=${target.userId} requestId=${approval?.requestId || ""}`
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
      const packet = await memoryDomain.captureContextPacket({
        userId: normalized.senderId,
        senderId: normalized.senderId,
        query: normalizeText(normalized.originalText) || normalizeText(normalized.text) || baseText,
        receivedAt: normalized.receivedAt,
        sourceClient: normalized.provider === "system" ? "asheriebridge_system_turn" : "asheriebridge_wechat",
        recallMode: normalized.provider === "system" ? "proactive" : "user_triggered",
        channelId: "weixin",
        workspaceRoot,
      });
      const prelude = normalizeText(packet?.runtime_prelude || packet?.summary);
      const frontstageNote = buildWechatFrontstageTurnNote(normalized);
      const sections = [frontstageNote, prelude].filter(Boolean);
      if (!sections.length) {
        return {
          text: baseText,
          packet,
        };
      }
      return {
        text: `${sections.join("\n\n")}\n\n===== Current Inbound Message =====\n${baseText}`,
        packet,
      };
    } catch (error) {
      console.warn(`[asheriebridge] memory context skipped: ${formatErrorMessage(error)}`);
      return {
        text: baseText,
        packet: null,
      };
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
    const incomingTextForCache = snapshot.prepared.originalText
      || snapshot.prepared.runtimeText
      || snapshot.prepared.text;
    try {
      const writebackResult = await memoryDomain.writebackTurn({
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
        sourceClient: snapshot.prepared.provider === "system" ? "asheriebridge_system_turn" : "asheriebridge_wechat",
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
    } catch (error) {
      console.warn(`[asheriebridge] writeback skipped thread=${event?.payload?.threadId || ""} ${formatErrorMessage(error)}`);
    }
  }
}

function buildWechatFrontstageTurnNote(normalized = {}) {
  if (normalizeText(normalized?.provider) === "system") {
    return "";
  }
  return [
    "[WeChat front-stage note]",
    "This is ordinary one-on-one WeChat conversation, not a terse tool reply.",
    "Generic runtime defaults such as \"responses should be short and concise\" do not control this front-stage answer.",
    "If user-side emoji or stickers appear as ordinary emoji or a short parenthetical cue, read them as emotional context only; do not echo transport placeholder syntax as your house style.",
    "Unless the user clearly wants speed or brevity, do not collapse the reply into only acknowledgment plus a quick follow-up question.",
    "If the moment is relational, tired, playful, vulnerable, or carrying afterglow from the previous line, stay for one more beat so the reply feels complete before you decide whether a question is even needed.",
  ].join("\n");
}

function buildRunKey(threadId, turnId) {
  return `${normalizeCommandArgument(threadId)}:${normalizeCommandArgument(turnId)}`;
}

function isDirectVisibleReplySystemMessage(message = {}) {
  const kind = normalizeText(message?.kind).toLowerCase();
  return kind === "reply" || kind === "direct_reply";
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
      return "📦 context: set ASHERIEBRIDGE_CLAUDE_CONTEXT_WINDOW";
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

module.exports = { CyberbossApp };

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
  return `${normalized}#asherie-system`;
}

function clampSystemRuntimeText(value) {
  const text = String(value || "").trim();
  if (!text || text.length <= MAX_SYSTEM_RUNTIME_TEXT_CHARS) {
    return text;
  }
  const keep = Math.max(0, MAX_SYSTEM_RUNTIME_TEXT_CHARS - 160);
  return [
    text.slice(0, keep).trimEnd(),
    "",
    "[AsherieBridge note: system-turn context was trimmed before ClaudeCode dispatch to avoid prompt overflow. Search memory explicitly if this trigger needs more detail.]",
  ].join("\n");
}

function formatRuntimeFailureForUser(text, { provider = "" } = {}) {
  const normalized = normalizeText(text) || "❌ Execution failed";
  const kind = classifyRuntimeFailureKind(normalized);
  if (kind === "prompt_too_long") {
    return [
      "⚠️ ClaudeCode 这轮上下文太长，桥已经把这条运行线程标记为失败并释放。",
      provider === "system"
        ? "这是后台唤醒失败提示，不是你说错了什么；我会避免继续把同一条坏线程反复塞满。"
        : "刚才那句话可能需要你重新发一次；下一轮会尝试从干净线程继续。",
    ].join("\n");
  }
  if (kind === "bad_json") {
    return [
      "⚠️ ClaudeCode 拒绝了这轮请求体，桥已经把坏请求隔离掉。",
      "常见原因是表情/特殊字符或内部 JSON 被运行时判成非法。下一轮会重新开干净路径，不会继续卡在这条坏消息后面。",
    ].join("\n");
  }
  if (kind === "api_error") {
    return [
      "⚠️ ClaudeCode 这轮返回了 API 错误，桥已经释放当前运行线程。",
      "这条不会进入记忆；如果你刚才是在等正文，可以把那句话重新发一次。",
      `detail: ${truncateForStatus(normalized, 260)}`,
    ].join("\n");
  }
  return normalized;
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
      && normalized[1] === "asheriebridge_tools"
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
    lines.push(`${userName} sent image/file attachments. They were saved into the bound workspace office inbox:`);
    for (const item of saved) {
      const suffix = item.sourceFileName ? ` (original name: ${item.sourceFileName})` : "";
      lines.push(`- [${item.kind}] file: ${item.absolutePath}${suffix}`);
      if (item.noteAbsolutePath) {
        lines.push(`  note: ${item.noteAbsolutePath}`);
      }
    }
    lines.push(`You must inspect the raw attachment files before replying to ${userName}.`);
    if (saved.some((item) => isImageAttachmentItem(item))) {
      if (runtimeUsesReadForImages(runtimeId)) {
        lines.push("For images, use `Read` on the saved local image file.");
      } else {
        lines.push("For images, use `view_image`.");
      }
      lines.push("If an image is clearly meant as a reusable sticker or reaction image, you may save it with the sticker tool after inspecting it.");
    }
    if (officePaths.notesRoot) {
      lines.push("If an attachment may matter beyond this turn, update its paired attachment note with a short factual summary instead of relying on the raw file alone.");
      lines.push(`Keep durable attachment notes under: ${officePaths.notesRoot}`);
    }
    lines.push(`If a required tool is missing, tell ${userName} exactly what is missing and that you cannot read the file yet.`);
  }

  if (failed.length) {
    if (lines.length) {
      lines.push("");
    }
    lines.push("Attachment intake errors:");
    for (const item of failed) {
      const label = item.sourceFileName || item.kind || "attachment";
      lines.push(`- ${label}: ${item.reason}`);
    }
  }

  return lines.join("\n").trim();
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
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  const attachmentFailures = Array.isArray(message?.attachmentFailures) ? message.attachmentFailures : [];
  return attachments.length > 0
    && attachments.every((item) => isImageAttachmentItem(item))
    && attachmentFailures.length === 0;
}

function takeImageContextBatchMessages(messages, maxAttachments) {
  const batchMessages = [];
  const remainingMessages = [];
  let remainingCapacity = Math.max(1, Number(maxAttachments) || 1);
  let hasImageInBatch = false;

  for (const message of Array.isArray(messages) ? messages : []) {
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    if (!attachments.length && isPlainTextPreparedMessage(message) && hasImageInBatch) {
      batchMessages.push(message);
      continue;
    }
    if (!attachments.length) {
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
      || lower.includes("/aji-memory/00_system/")
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

const DEFERRED_REPLY_NOTICE = "由于微信 context_token 的限制，上轮对话里有一部分内容当时没能送达；这次用户再次发来消息、context_token 刷新后，先把遗留内容补上。如果这种情况反复出现，可发送 /chunk <数字>（例如 /chunk 50）调大最小合并字符数，减少消息分片。";
const DEFERRED_PLAIN_REPLY_HEADER = "===== 上轮对话遗留内容 =====";
const DEFERRED_SYSTEM_REPLY_HEADER = "===== 期间模型主动联系 =====";

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
