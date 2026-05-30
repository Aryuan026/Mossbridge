const { sanitizeProtocolLeakText } = require("../adapters/runtime/codex/protocol-leak-monitor");
const { recordAiReply } = require("./activity-tracker");
const { RUNTIME_NOTICE_KIND, shieldRuntimeNoticeForDelivery } = require("./runtime-notices");

const CURRENT_REPLY_HEADER = "===== [Mossbridge] current_runtime_reply =====";

class StreamDelivery {
  constructor({
    channelAdapter,
    sessionStore,
    onDeferredSystemReply,
    onRuntimeNotice,
    onOutboundDelivery,
    systemReplyRetryScheduleMs,
    transientDeliveryRetryScheduleMs,
    sameTokenRetryDelayMs,
  }) {
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.onDeferredSystemReply = typeof onDeferredSystemReply === "function" ? onDeferredSystemReply : null;
    this.onRuntimeNotice = typeof onRuntimeNotice === "function" ? onRuntimeNotice : null;
    this.onOutboundDelivery = typeof onOutboundDelivery === "function" ? onOutboundDelivery : null;
    const retrySchedule = Array.isArray(transientDeliveryRetryScheduleMs) && transientDeliveryRetryScheduleMs.length
      ? transientDeliveryRetryScheduleMs
      : systemReplyRetryScheduleMs;
    this.transientDeliveryRetryScheduleMs = Array.isArray(retrySchedule) && retrySchedule.length
      ? retrySchedule.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value >= 0)
      : [1_500, 2_500, 4_000, 6_000];
    this.sameTokenRetryDelayMs = Number.isFinite(sameTokenRetryDelayMs) && sameTokenRetryDelayMs >= 0
      ? sameTokenRetryDelayMs
      : 800;
    this.replyTargetByBindingKey = new Map();
    this.replyTargetByTurnKey = new Map();
    this.replyTargetQueueByThreadId = new Map();
    this.deferredReplyPrefixByBindingKey = new Map();
    this.suppressedRunCountByThreadId = new Map();
    this.stateByRunKey = new Map();
    this.runSequence = 0;
  }

  setReplyTarget(bindingKey, target) {
    if (!bindingKey || !target?.userId || !target?.contextToken) {
      return;
    }
    this.replyTargetByBindingKey.set(bindingKey, {
      userId: String(target.userId).trim(),
      contextToken: String(target.contextToken).trim(),
      provider: normalizeText(target.provider),
    });
  }

  queueReplyTargetForThread(threadId, target) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTarget = normalizeReplyTarget(target);
    if (!normalizedThreadId || !normalizedTarget) {
      return;
    }
    const queue = this.replyTargetQueueByThreadId.get(normalizedThreadId) || [];
    queue.push(normalizedTarget);
    this.replyTargetQueueByThreadId.set(normalizedThreadId, queue);
    this.bindQueuedReplyTargetsToActiveThreadRuns(normalizedThreadId);
  }

  bindReplyTargetForTurn({ threadId = "", turnId = "", target = null } = {}) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTurnId = normalizeText(turnId);
    const normalizedTarget = normalizeReplyTarget(target);
    if (!normalizedThreadId || !normalizedTurnId || !normalizedTarget) {
      this.queueReplyTargetForThread(normalizedThreadId, target);
      return;
    }

    const runKey = buildRunKey(normalizedThreadId, normalizedTurnId);
    this.replyTargetByTurnKey.set(runKey, normalizedTarget);
    const activeState = this.stateByRunKey.get(runKey);
    if (activeState) {
      this.applyThreadReplyTarget(activeState, normalizedTarget);
    }
  }

  suppressNextRunForThread(threadId) {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId) {
      return;
    }
    const count = this.suppressedRunCountByThreadId.get(normalizedThreadId) || 0;
    this.suppressedRunCountByThreadId.set(normalizedThreadId, count + 1);
  }

  cancelSuppressedRunForThread(threadId) {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId) {
      return;
    }
    const count = this.suppressedRunCountByThreadId.get(normalizedThreadId) || 0;
    if (count <= 1) {
      this.suppressedRunCountByThreadId.delete(normalizedThreadId);
      return;
    }
    this.suppressedRunCountByThreadId.set(normalizedThreadId, count - 1);
  }

  setDeferredReplyPrefix(bindingKey, text) {
    const normalizedBindingKey = normalizeText(bindingKey);
    const normalizedText = trimOuterBlankLines(normalizeLineEndings(text));
    if (!normalizedBindingKey || !normalizedText) {
      return;
    }
    this.deferredReplyPrefixByBindingKey.set(normalizedBindingKey, normalizedText);
  }

  resolveReplyTargetForRun({ threadId = "", turnId = "" } = {}) {
    const normalizedThreadId = normalizeText(threadId);
    const normalizedTurnId = normalizeText(turnId);
    if (!normalizedThreadId) {
      return null;
    }

    const runKey = buildRunKey(normalizedThreadId, normalizedTurnId);
    const state = this.stateByRunKey.get(runKey);
    if (state?.replyTarget) {
      return normalizeReplyTarget(state.replyTarget);
    }

    const exactTurnTarget = this.replyTargetByTurnKey.get(runKey);
    if (exactTurnTarget) {
      return normalizeReplyTarget(exactTurnTarget);
    }

    const queuedTargets = this.replyTargetQueueByThreadId.get(normalizedThreadId);
    if (Array.isArray(queuedTargets) && queuedTargets.length > 0) {
      return normalizeReplyTarget(queuedTargets[0]);
    }

    const linked = this.sessionStore.findBindingForThreadId(normalizedThreadId);
    if (!linked?.bindingKey) {
      return null;
    }
    return normalizeReplyTarget(this.replyTargetByBindingKey.get(linked.bindingKey));
  }

  async handleRuntimeEvent(event) {
    const threadId = normalizeText(event?.payload?.threadId);
    const turnId = normalizeText(event?.payload?.turnId);
    if (!threadId) {
      return;
    }

    switch (event.type) {
      case "runtime.turn.started": {
        const state = this.ensureRunState(threadId, turnId);
        state.turnId = turnId || state.turnId;
        this.attachReplyTarget(state);
        return;
      }
      case "runtime.reply.delta": {
        const state = this.ensureRunState(threadId, turnId);
        this.upsertItem(state, {
          itemId: normalizeText(event.payload.itemId) || `item-${state.itemOrder.length + 1}`,
          text: normalizeLineEndings(event.payload.text),
          completed: false,
        });
        return;
      }
      case "runtime.reply.completed": {
        const state = this.ensureRunState(threadId, turnId);
        this.upsertItem(state, {
          itemId: normalizeText(event.payload.itemId) || `item-${state.itemOrder.length + 1}`,
          text: normalizeLineEndings(event.payload.text),
          completed: true,
        });
        await this.flush(state, { force: false });
        return;
      }
      case "runtime.turn.completed": {
        const state = this.ensureRunState(threadId, turnId);
        state.turnId = turnId || state.turnId;
        this.captureTurnCompletionText(state, event.payload.text);
        await this.flush(state, { force: true });
        this.disposeRunState(state.runKey);
        return;
      }
      case "runtime.turn.failed":
        this.disposeRunState(buildRunKey(threadId, turnId));
        return;
      default:
        return;
    }
  }

  ensureRunState(threadId, turnId = "") {
    const runKey = buildRunKey(threadId, turnId);
    const existing = this.stateByRunKey.get(runKey);
    if (existing) {
      return existing;
    }

    const created = {
      runKey,
      threadId,
      bindingKey: "",
      replyTarget: null,
      suppressDelivery: this.consumeSuppressedRun(threadId),
      deferredReplyPrefix: "",
      turnId: normalizeText(turnId),
      itemOrder: [],
      items: new Map(),
      sentItemIds: new Set(),
      sendChain: Promise.resolve(),
      flushPromise: null,
      sequence: this.runSequence += 1,
      threadReplyTargetAttached: false,
    };
    this.stateByRunKey.set(runKey, created);
    this.attachReplyTarget(created);
    return created;
  }

  attachReplyTarget(state) {
    if (!state.threadReplyTargetAttached && state.turnId) {
      const exactTurnTarget = this.replyTargetByTurnKey.get(buildRunKey(state.threadId, state.turnId)) || null;
      if (exactTurnTarget) {
        this.applyThreadReplyTarget(state, exactTurnTarget);
      }
    }
    if (!state.threadReplyTargetAttached) {
      const threadTarget = this.consumeQueuedReplyTarget(state.threadId);
      if (threadTarget) {
        this.applyThreadReplyTarget(state, threadTarget);
      }
    }
    const linked = this.sessionStore.findBindingForThreadId(state.threadId);
    if (!linked?.bindingKey) {
      return;
    }
    state.bindingKey = linked.bindingKey;
    if (!state.replyTarget) {
      const target = this.replyTargetByBindingKey.get(linked.bindingKey);
      state.replyTarget = target;
    }
    if (!state.deferredReplyPrefix) {
      const prefix = this.deferredReplyPrefixByBindingKey.get(linked.bindingKey) || "";
      if (prefix) {
        state.deferredReplyPrefix = prefix;
        this.deferredReplyPrefixByBindingKey.delete(linked.bindingKey);
      }
    }
  }

  captureTurnCompletionText(state, text) {
    const normalized = trimOuterBlankLines(normalizeLineEndings(text));
    if (!normalized || state.itemOrder.length > 0) {
      return;
    }
    this.upsertItem(state, {
      itemId: `result-${state.turnId || state.threadId}`,
      text: normalized,
      completed: true,
    });
  }

  upsertItem(state, { itemId, text, completed }) {
    if (!text) {
      return;
    }
    if (!state.items.has(itemId)) {
      state.itemOrder.push(itemId);
      state.items.set(itemId, {
        currentText: "",
        completedText: "",
        completed: false,
      });
    }

    const current = state.items.get(itemId);
    if (completed) {
      current.currentText = text;
      current.completedText = text;
      current.completed = true;
      return;
    }

    current.currentText = appendStreamingText(current.currentText, text);
  }

  setItemText(state, itemId, text, completed) {
    if (!text) {
      return;
    }
    if (!state.items.has(itemId)) {
      state.itemOrder.push(itemId);
      state.items.set(itemId, {
        currentText: "",
        completedText: "",
        completed: false,
      });
    }

    const current = state.items.get(itemId);
    current.currentText = text;
    if (completed) {
      current.completedText = text;
    }
    current.completed = Boolean(completed);
  }

  async flush(state, { force }) {
    const previous = state.flushPromise || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(() => this.flushNow(state, { force }));
    const tracked = current.finally(() => {
      const latestState = this.stateByRunKey.get(state.runKey);
      if (latestState && latestState.flushPromise === tracked) {
        latestState.flushPromise = null;
      }
    });
    state.flushPromise = tracked;
    await tracked;
  }

  async flushNow(state, { force }) {
    if (state.suppressDelivery) {
      return;
    }

    if (!state.replyTarget) {
      return;
    }

    if (state.replyTarget.provider === "system") {
      await this.flushSystemReply(state, { force });
      return;
    }

    const pendingDeliveries = collectPendingReplyDeliveries(state, { force });
    if (!pendingDeliveries.length) {
      return;
    }

    let failedDeliveryIndex = 0;
    state.sendChain = state.sendChain.then(async () => {
      for (let index = 0; index < pendingDeliveries.length; index += 1) {
        const delivery = pendingDeliveries[index];
        failedDeliveryIndex = index;
        await this.sendReplyDelivery(state, delivery, {
          prependDeferredPrefix: index === 0 && Boolean(state.deferredReplyPrefix),
        });
        state.sentItemIds.add(delivery.itemId);
        if (index === 0 && state.deferredReplyPrefix) {
          state.deferredReplyPrefix = "";
        }
      }
    }).catch(async (error) => {
      const failedDeliveries = pendingDeliveries.slice(failedDeliveryIndex);
      const failedText = buildPendingDeliveryBatchText(failedDeliveries, state.deferredReplyPrefix);
      const deferred = await this.deferSystemReply(state, failedText, error, "plain_reply");
      if (deferred) {
        this.recordOutboundDelivery(state, {
          userId: state.replyTarget?.userId || "",
          text: failedText,
          contextToken: state.replyTarget?.contextToken || "",
        }, { kind: "plain_reply", status: "deferred", attempt: "batch", error });
        for (const delivery of failedDeliveries) {
          if (delivery?.itemId) {
            state.sentItemIds.add(delivery.itemId);
          }
        }
        state.deferredReplyPrefix = "";
        return;
      }
      console.error(`[mossbridge] failed to deliver reply thread=${state.threadId}: ${error.message}`);
    });

    await state.sendChain;
  }

  async flushSystemReply(state, { force }) {
    if (!force) {
      return;
    }

    const replyText = buildReplyText(state, { completedOnly: false });
    const resolved = resolveSystemReplyAction(replyText);
    if (resolved.kind === "silent") {
      this.notifyRuntimeNotice(state, resolved.runtimeNotice, replyText);
      this.markAllItemsSent(state);
      console.log(
        `[mossbridge] suppressed system reply thread=${state.threadId} action=silent preview=${JSON.stringify(replyText.slice(0, 120))}`
      );
      return;
    }

    if (resolved.kind !== "send_message") {
      console.error(
        `[mossbridge] invalid system reply thread=${state.threadId} reason=${resolved.reason} preview=${JSON.stringify(replyText.slice(0, 160))}`
      );
      return;
    }

    state.sendChain = state.sendChain.then(async () => {
      await this.sendSystemReply(state, resolved.message);
      this.markAllItemsSent(state);
    }).catch((error) => {
      console.error(`[mossbridge] failed to deliver system reply thread=${state.threadId}: ${error.message}`);
    });

    await state.sendChain;
  }

  async sendReplyDelivery(state, delivery, { prependDeferredPrefix = false } = {}) {
    if (!delivery || !state.replyTarget) {
      return;
    }

    if (delivery.kind === "silent") {
      return;
    }

    if (delivery.kind === "invalid_action") {
      console.error(
        `[mossbridge] invalid structured action item thread=${state.threadId} reason=${delivery.reason} preview=${JSON.stringify((delivery.sourceText || "").slice(0, 160))}`
      );
      return;
    }

    const baseText = delivery.kind === "action" ? delivery.message : delivery.text;
    if (!baseText) {
      return;
    }
    this.notifyRuntimeNotice(state, delivery.runtimeNotice, delivery.sourceText || baseText);

    const payload = {
      userId: state.replyTarget.userId,
      text: prependDeferredPrefix ? buildEffectiveReplyText(state.deferredReplyPrefix, baseText) : baseText,
      contextToken: state.replyTarget.contextToken,
    };
    if (prependDeferredPrefix) {
      payload.preserveBlock = true;
    }
    await this.sendTextWithRetry(state, payload, { kind: "plain_reply", deferOnFailure: false });
  }

  async sendSystemReply(state, text) {
    const initialTarget = state.replyTarget;
    const payload = {
      userId: initialTarget.userId,
      text,
      contextToken: initialTarget.contextToken,
    };
    await this.sendTextWithRetry(state, payload, { kind: "system_reply" });
  }

  async sendTextWithRetry(state, payload, { kind, deferOnFailure = true }) {
    const initialTarget = state.replyTarget;
    try {
      await this.sendTextWithTransientRetry(state, payload, { kind, attempt: "initial" });
      return;
    } catch (error) {
      const retryTarget = this.resolveRetriableReplyTarget(initialTarget, error);
      if (!retryTarget) {
        if (!deferOnFailure) {
          throw error;
        }
        const deferred = await this.deferSystemReply(state, payload.text, error, kind);
        if (deferred) {
          this.recordOutboundDelivery(state, payload, { kind, status: "deferred", attempt: "initial", error });
          return;
        }
        this.recordOutboundDelivery(state, payload, { kind, status: "failed", attempt: "initial", error });
        throw error;
      }
      console.warn(
        `[mossbridge] system reply retrying with refreshed context token thread=${state.threadId} user=${retryTarget.userId}`
      );
      try {
        const retryPayload = {
          userId: retryTarget.userId,
          text: payload.text,
          contextToken: retryTarget.contextToken,
        };
        if (payload.preserveBlock) {
          retryPayload.preserveBlock = true;
        }
        await this.sendTextWithTransientRetry(state, retryPayload, { kind, attempt: "retry" });
        state.replyTarget = retryTarget;
        if (state.bindingKey) {
          this.replyTargetByBindingKey.set(state.bindingKey, {
            userId: retryTarget.userId,
            contextToken: retryTarget.contextToken,
            provider: retryTarget.provider,
          });
        }
      } catch (retryError) {
        if (!deferOnFailure) {
          throw retryError;
        }
        const deferred = await this.deferSystemReply(state, payload.text, retryError, kind);
        if (deferred) {
          this.recordOutboundDelivery(state, payload, { kind, status: "deferred", attempt: "retry", error: retryError });
          return;
        }
        this.recordOutboundDelivery(state, payload, { kind, status: "failed", attempt: "retry", error: retryError });
        throw retryError;
      }
    }
  }

  async sendTextWithTransientRetry(state, payload, { kind = "", attempt = "initial" } = {}) {
    const delays = Array.isArray(this.transientDeliveryRetryScheduleMs)
      ? this.transientDeliveryRetryScheduleMs
      : [];
    for (let retryIndex = 0; ; retryIndex += 1) {
      try {
        await this.channelAdapter.sendText(payload);
        this.recordOutboundDelivery(state, payload, {
          kind,
          status: "sent",
          attempt: retryIndex === 0 ? attempt : `${attempt}_transient_retry_${retryIndex}`,
        });
        recordAiReply();
        return;
      } catch (error) {
        if (!isTransientDeliveryFailure(error) || retryIndex >= delays.length) {
          throw error;
        }
        this.recordOutboundDelivery(state, payload, {
          kind,
          status: "retrying",
          attempt: `${attempt}_transient_retry_${retryIndex + 1}`,
          error,
        });
        await sleep(delays[retryIndex]);
      }
    }
  }

  recordOutboundDelivery(state, payload, { kind = "", status = "", attempt = "", error = null } = {}) {
    if (typeof this.onOutboundDelivery !== "function") {
      return;
    }
    try {
      this.onOutboundDelivery({
        threadId: state?.threadId || "",
        turnId: state?.turnId || "",
        runKey: state?.runKey || "",
        bindingKey: state?.bindingKey || "",
        userId: payload?.userId || state?.replyTarget?.userId || "",
        provider: state?.replyTarget?.provider || "",
        kind,
        status,
        attempt,
        contextTokenPresent: Boolean(payload?.contextToken),
        textPreview: payload?.text || "",
        error: error instanceof Error ? error.message : String(error || ""),
        ...buildDeliveryErrorDiagnosticPayload(error),
      });
    } catch (hookError) {
      console.error(`[mossbridge] outbound delivery audit failed thread=${state?.threadId || ""}: ${hookError.message}`);
    }
  }

  async deferSystemReply(state, text, error, kind = "plain_reply") {
    if (typeof this.onDeferredSystemReply !== "function") {
      return false;
    }
    if (!shouldDeferReplyAfterDeliveryFailure(error)) {
      return false;
    }
    const target = state?.replyTarget || {};
    if (!target.userId || !text) {
      return false;
    }
    try {
      await this.onDeferredSystemReply({
        threadId: state.threadId,
        userId: target.userId,
        text,
        error,
        kind,
        dedupeKey: state.runKey,
      });
      console.warn(
        `[mossbridge] deferred system reply until the next inbound message thread=${state.threadId} user=${target.userId}`
      );
      return true;
    } catch (deferError) {
      console.error(`[mossbridge] failed to defer system reply thread=${state.threadId}: ${deferError.message}`);
      return false;
    }
  }

  resolveRetriableReplyTarget(currentTarget, error) {
    if (!isSystemReplyContextFailure(error)) {
      return null;
    }
    if (!currentTarget?.userId) {
      return null;
    }
    if (typeof this.channelAdapter.getKnownContextTokens !== "function") {
      return null;
    }
    const tokens = this.channelAdapter.getKnownContextTokens();
    const refreshedContextToken = normalizeText(tokens?.[currentTarget.userId]);
    if (!refreshedContextToken || refreshedContextToken === currentTarget.contextToken) {
      return null;
    }
    return {
      userId: currentTarget.userId,
      contextToken: refreshedContextToken,
      provider: currentTarget.provider,
    };
  }

  disposeRunState(runKey) {
    const normalizedRunKey = normalizeText(runKey);
    if (!normalizedRunKey) {
      return;
    }
    this.replyTargetByTurnKey.delete(normalizedRunKey);
    this.stateByRunKey.delete(normalizedRunKey);
  }

  consumeSuppressedRun(threadId) {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId) {
      return false;
    }
    const count = this.suppressedRunCountByThreadId.get(normalizedThreadId) || 0;
    if (count <= 0) {
      return false;
    }
    if (count === 1) {
      this.suppressedRunCountByThreadId.delete(normalizedThreadId);
    } else {
      this.suppressedRunCountByThreadId.set(normalizedThreadId, count - 1);
    }
    return true;
  }

  bindQueuedReplyTargetsToActiveThreadRuns(threadId) {
    const queue = this.replyTargetQueueByThreadId.get(threadId);
    if (!Array.isArray(queue) || !queue.length) {
      return;
    }
    const states = [...this.stateByRunKey.values()]
      .filter((state) => state.threadId === threadId && !state.threadReplyTargetAttached)
      .sort((left, right) => left.sequence - right.sequence);
    for (const state of states) {
      const nextTarget = queue.shift();
      if (!nextTarget) {
        break;
      }
      this.applyThreadReplyTarget(state, nextTarget);
    }
    if (queue.length) {
      this.replyTargetQueueByThreadId.set(threadId, queue);
      return;
    }
    this.replyTargetQueueByThreadId.delete(threadId);
  }

  consumeQueuedReplyTarget(threadId) {
    const queue = this.replyTargetQueueByThreadId.get(threadId);
    if (!Array.isArray(queue) || !queue.length) {
      return null;
    }
    const target = queue.shift() || null;
    if (queue.length) {
      this.replyTargetQueueByThreadId.set(threadId, queue);
    } else {
      this.replyTargetQueueByThreadId.delete(threadId);
    }
    return target;
  }

  applyThreadReplyTarget(state, target) {
    state.replyTarget = {
      userId: target.userId,
      contextToken: target.contextToken,
      provider: target.provider,
    };
    state.threadReplyTargetAttached = true;
  }

  markAllItemsSent(state) {
    for (const itemId of state.itemOrder) {
      state.sentItemIds.add(itemId);
    }
  }

  notifyRuntimeNotice(state, runtimeNotice, sourceText = "") {
    if (!runtimeNotice || runtimeNotice.kind !== RUNTIME_NOTICE_KIND.CAPACITY) {
      return;
    }
    if (typeof this.onRuntimeNotice !== "function") {
      return;
    }
    try {
      this.onRuntimeNotice({
        kind: runtimeNotice.kind,
        action: runtimeNotice.action,
        threadId: state?.threadId || "",
        provider: state?.replyTarget?.provider || "",
        text: sourceText,
      });
    } catch (error) {
      console.error(`[mossbridge] runtime notice hook failed thread=${state?.threadId || ""}: ${error.message}`);
    }
  }
}

function buildRunKey(threadId, turnId = "") {
  const normalizedThreadId = normalizeText(threadId);
  const normalizedTurnId = normalizeText(turnId);
  return normalizedTurnId
    ? `${normalizedThreadId}:${normalizedTurnId}`
    : `${normalizedThreadId}:pending`;
}

function buildReplyText(state, { completedOnly }) {
  const parts = [];
  for (const itemId of state.itemOrder) {
    const item = state.items.get(itemId);
    if (!item) {
      continue;
    }

    const sourceText = completedOnly
      ? (item.completed ? item.completedText : "")
      : (item.completed ? item.completedText : item.currentText);
    const normalized = trimOuterBlankLines(sourceText);
    if (normalized) {
      parts.push(normalized);
    }
  }
  return parts.join("\n\n");
}

function collectPendingReplyDeliveries(state, { force }) {
  const pending = [];
  for (const itemId of state.itemOrder) {
    if (state.sentItemIds.has(itemId)) {
      continue;
    }
    const item = state.items.get(itemId);
    if (!item) {
      continue;
    }
    const sourceText = resolvePlainReplySourceText(item, force);
    if (!sourceText) {
      continue;
    }
    const structuredAction = classifyReplyItemSourceText(sourceText);
    if (structuredAction) {
      pending.push(buildActionDelivery(itemId, sourceText, structuredAction));
      continue;
    }
    const plainText = markdownToPlainText(sourceText);
    const sanitizedText = sanitizeReplyText(plainText);
    if (!sanitizedText) {
      continue;
    }
    if (isLikelyToolDeliverySummary(sanitizedText)) {
      pending.push({ itemId, kind: "silent", sourceText });
      continue;
    }
    const runtimeNotice = shieldRuntimeNoticeForDelivery(sanitizedText, {
      provider: state?.replyTarget?.provider,
    });
    if (runtimeNotice.shielded) {
      pending.push(runtimeNotice.action === "replace"
        ? { itemId, kind: "plain", text: runtimeNotice.text, runtimeNotice, sourceText }
        : { itemId, kind: "silent", sourceText, runtimeNotice });
      continue;
    }
    pending.push({ itemId, kind: "plain", text: sanitizedText });
  }
  return pending;
}

function resolvePlainReplySourceText(item, force) {
  if (!item || typeof item !== "object") {
    return "";
  }
  if (item.completed) {
    return trimOuterBlankLines(item.completedText || item.currentText || "");
  }
  if (!force) {
    return "";
  }
  return trimOuterBlankLines(item.currentText || "");
}

function buildEffectiveReplyText(deferredPrefix, replyText) {
  const prefix = trimOuterBlankLines(normalizeLineEndings(deferredPrefix));
  const body = trimOuterBlankLines(normalizeLineEndings(replyText));
  if (prefix && body) {
    return `${prefix}\n\n${CURRENT_REPLY_HEADER}\n${body}`;
  }
  return prefix || body;
}

function markdownToPlainText(text) {
  let result = normalizeLineEndings(text);
  result = result.replace(/```([^\n]*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const label = String(language || "").trim();
    const body = indentBlock(String(code || ""));
    return label ? `\n${label}:\n${body}\n` : `\nCode:\n${body}\n`;
  });
  result = result.replace(/```([^\n]*)\n?([\s\S]*)$/g, (_, language, code) => {
    const label = String(language || "").trim();
    const body = indentBlock(String(code || ""));
    return label ? `\n${label}:\n${body}\n` : `\nCode:\n${body}\n`;
  });
  result = result.replace(/!\[[^\]]*]\([^)]*\)/g, "");
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  result = result.replace(/`([^`]+)`/g, "$1");
  result = result.replace(/^#{1,6}\s*(.+)$/gm, "$1");
  result = result.replace(/\*\*([^*]+)\*\*/g, "$1");
  result = result.replace(/\*([^*]+)\*/g, "$1");
  result = result.replace(/^>\s?/gm, "> ");
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner) =>
    String(inner || "").split("|").map((cell) => cell.trim()).join("  ")
  );
  result = result.replace(/\n{3,}/g, "\n\n");
  return trimOuterBlankLines(result);
}

function appendStreamingText(current, next) {
  const base = String(current || "");
  const incoming = String(next || "");
  if (!incoming) {
    return base;
  }
  if (!base) {
    return incoming;
  }
  if (base.endsWith(incoming)) {
    return base;
  }
  if (incoming.startsWith(base)) {
    return incoming;
  }

  const maxOverlap = Math.min(base.length, incoming.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (base.slice(-size) === incoming.slice(0, size)) {
      return `${base}${incoming.slice(size)}`;
    }
  }

  return `${base}${incoming}`;
}

function indentBlock(text) {
  const normalized = trimOuterBlankLines(normalizeLineEndings(text));
  if (!normalized) {
    return "";
  }
  return normalized.split("\n").map((line) => `    ${line}`).join("\n");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
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

function normalizeLineEndings(value) {
  return String(value || "").replace(/\r\n/g, "\n");
}

function trimOuterBlankLines(text) {
  return String(text || "")
    .replace(/^\s*\n+/g, "")
    .replace(/\n+\s*$/g, "");
}

function sanitizeReplyText(plainReplyText) {
  const normalized = normalizeLineEndings(String(plainReplyText || ""));
  if (!normalized) {
    return "";
  }
  const protocolSanitized = sanitizeProtocolLeakText(normalized);
  return trimOuterBlankLines(protocolSanitized.text || "");
}

function isLikelyToolDeliverySummary(text) {
  const normalized = trimOuterBlankLines(normalizeLineEndings(text));
  if (!normalized || normalized.length > 260) {
    return false;
  }
  return /^(回复已发出|消息已发出|已发出)[：:——-]/u.test(normalized);
}

function resolveSystemReplyAction(replyText) {
  const normalized = normalizeLineEndings(String(replyText || "")).trim();
  if (!normalized) {
    return { kind: "invalid", reason: "final reply is empty" };
  }
  const runtimeNotice = shieldRuntimeNoticeForDelivery(normalized, { provider: "system" });
  if (runtimeNotice.shielded) {
    return { kind: "silent", reason: "runtime capacity notice", runtimeNotice };
  }

  const candidate = extractSystemActionJsonCandidate(normalized) || normalized;
  const parsed = tryParseJson(candidate);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    return { kind: "invalid", reason: "final reply is not a JSON object" };
  }

  const action = normalizeSystemActionName(parsed.action);
  if (action === "silent") {
    return { kind: "silent" };
  }
  if (action !== "send_message") {
    return { kind: "invalid", reason: "unsupported action" };
  }

  const message = sanitizeProtocolLeakText(normalizeLineEndings(String(parsed.message || parsed.text || ""))).text.trim();
  if (!message) {
    return { kind: "invalid", reason: "send_message requires a non-empty message" };
  }

  return { kind: "send_message", message };
}

function classifyReplyItemSourceText(replyText) {
  const normalized = normalizeLineEndings(String(replyText || "")).trim();
  if (!normalized) {
    return null;
  }
  const unfenced = unwrapJsonCodeFence(normalized) || normalized;
  const stripped = unfenced.replace(/^json\s*:\s*/i, "").trim();
  const candidate = extractSystemActionJsonCandidate(stripped) || (stripped.startsWith("{") ? stripped : "");
  if (!candidate) {
    return null;
  }
  if (candidate !== stripped) {
    return null;
  }
  return resolveSystemReplyAction(candidate);
}

function unwrapJsonCodeFence(text) {
  const match = String(text || "").trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? String(match[1] || "").trim() : "";
}

function buildActionDelivery(itemId, sourceText, action) {
  if (!action || typeof action !== "object") {
    return null;
  }
  if (action.kind === "silent") {
    return { itemId, kind: "silent", sourceText };
  }
  if (action.kind === "send_message") {
    return { itemId, kind: "action", sourceText, message: action.message };
  }
  return {
    itemId,
    kind: "invalid_action",
    sourceText,
    reason: action.reason || "invalid structured action",
  };
}

function buildDeliveryPreviewText(delivery) {
  if (!delivery || typeof delivery !== "object") {
    return "";
  }
  if (delivery.kind === "action") {
    return delivery.message || "";
  }
  if (delivery.kind === "plain") {
    return delivery.text || "";
  }
  return "";
}

function buildPendingDeliveryBatchText(deliveries, deferredPrefix = "") {
  const body = (Array.isArray(deliveries) ? deliveries : [])
    .map((delivery) => trimOuterBlankLines(normalizeLineEndings(buildDeliveryPreviewText(delivery))))
    .filter(Boolean)
    .join("\n\n");
  return buildEffectiveReplyText(deferredPrefix, body);
}

function normalizeSystemActionName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractSystemActionJsonCandidate(text) {
  let normalized = normalizeLineEndings(String(text || "")).trim();
  // Strip trailing markdown code fence if present (model sometimes wraps JSON in ```...```)
  normalized = normalized.replace(/```\s*$/, "").trim();
  if (!normalized || !normalized.endsWith("}")) {
    return "";
  }
  if (normalized.startsWith("{")) {
    return normalized;
  }
  for (let index = normalized.lastIndexOf("{"); index >= 0; index = normalized.lastIndexOf("{", index - 1)) {
    const candidate = normalized.slice(index).trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
      continue;
    }
    const parsed = tryParseJson(candidate);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      continue;
    }
    if ("action" in parsed) {
      return candidate;
    }
  }
  return "";
}

function shouldDeferReplyAfterDeliveryFailure(error) {
  return isSystemReplyContextFailure(error) || isTransientDeliveryFailure(error);
}

function buildDeliveryErrorDiagnosticPayload(error) {
  if (!(error instanceof Error)) {
    return {};
  }
  return {
    errorName: normalizeText(error.name),
    causeName: normalizeText(error.cause?.name),
    causeCode: normalizeText(error.cause?.code || error.code),
    apiLabel: normalizeText(error.weixinApi?.label),
    apiEndpoint: normalizeText(error.weixinApi?.endpoint),
    apiTimeoutMs: Number.isFinite(Number(error.weixinApi?.timeoutMs)) ? Number(error.weixinApi.timeoutMs) : null,
  };
}

function isSystemReplyContextFailure(error) {
  const message = String(error?.message || "");
  const ret = normalizeNumericErrorCode(error?.ret);
  const errcode = normalizeNumericErrorCode(error?.errcode);
  return ret === -2
    || errcode === -2
    || message.includes("sendMessage ret=-2")
    || message.includes("errcode=-2");
}

function isTransientDeliveryFailure(error) {
  const message = String(error?.message || "").toLowerCase();
  const name = String(error?.name || "").toLowerCase();
  const causeCode = String(error?.cause?.code || error?.code || "").toLowerCase();
  return name === "aborterror"
    || causeCode === "und_err_connect_timeout"
    || causeCode === "econnreset"
    || causeCode === "etimedout"
    || causeCode === "eai_again"
    || message.includes("fetch failed")
    || message.includes("operation was aborted")
    || message.includes("network")
    || message.includes("socket")
    || message.includes("timeout")
    || message.includes("timed out")
    || message.includes("econnreset")
    || message.includes("etimedout")
    || message.includes("eai_again");
}

function normalizeNumericErrorCode(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function sleep(ms) {
  const delayMs = Math.max(0, Number(ms) || 0);
  if (delayMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

module.exports = { StreamDelivery };
