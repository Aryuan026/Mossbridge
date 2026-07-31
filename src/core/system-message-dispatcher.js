class SystemMessageDispatcher {
  constructor({ queueStore, config, accountId }) {
    this.queueStore = queueStore;
    this.config = config;
    this.accountId = accountId;
  }

  hasPending() {
    return this.queueStore.hasPendingForAccount(this.accountId);
  }

  drainPending() {
    return this.queueStore.drainForAccount(this.accountId);
  }

  requeue(message) {
    return this.queueStore.enqueue(message);
  }

  resolveWorkspaceRoot(message) {
    return normalizeText(message?.workspaceRoot) || normalizeText(this.config.workspaceRoot);
  }

  buildPreparedMessage(message, contextToken = "") {
    const runtimeText = buildSystemInboundText(message);
    return {
      provider: "system",
      workspaceId: this.config.workspaceId,
      accountId: this.accountId,
      chatId: message.senderId,
      threadKey: `system:${message.senderId}`,
      senderId: message.senderId,
      messageId: message.id,
      originalText: buildSystemRecallText(message),
      runtimeText,
      text: runtimeText,
      attachments: [],
      command: "message",
      contextToken,
      receivedAt: normalizeIsoTime(message?.createdAt) || new Date().toISOString(),
      workspaceRoot: this.resolveWorkspaceRoot(message),
      systemTurn: buildSystemTurnMeta(message),
    };
  }
}

function buildSystemInboundText(text, createdAt = "") {
  const message = text && typeof text === "object"
    ? text
    : { text, createdAt };
  const body = normalizeText(message?.text);
  const localTime = formatSystemLocalTime(message?.createdAt);
  const kind = normalizeText(message?.kind) || "generic";
  const priority = normalizeText(message?.priority) || "normal";
  const title = normalizeText(message?.title);
  const metadata = message?.metadata && typeof message.metadata === "object" ? message.metadata : {};
  const toolProfile = normalizeText(metadata.systemToolProfile || metadata.toolProfile);
  const liteCheckin = kind === "checkin_opportunity" && toolProfile === "checkin_lite";
  const sections = [
    ...(localTime ? [`[${localTime}]`, "Use this timestamp as the current local time for this wake. Let weekday and daypart come from this timestamp; older memory provides history only.", ""] : []),
    "SYSTEM ACTION MODE: internal bridge trigger.",
    ...buildSystemTriggerHeader({ kind, priority, title }),
    ...buildSystemTriggerGuidance({ kind, priority, toolProfile }),
    ...buildSystemTriggerDetails(metadata),
    ...(liteCheckin
      ? [
          "This random check-in runs with a lightweight tool profile: keep the turn to injected context plus the final JSON action.",
          "The small wake budget limits fan-out, not the range of legitimate life. Use the injected context to choose one grounded path: a natural WeChat message, intentional quiet, or a later full-tool reminder.",
        ]
      : [
          "Use tools as affordances; read/write when this trigger needs it.",
          "Safe scope: memory, reminders, diary/notebook, episode/case/observation, timeline/status reads, stickers/files, capability requests. Service restarts, account rebinding, credential changes, memory deletion, and account/device/OAuth work belong to explicit human requests.",
        ]),
    "Keep control-plane state backstage. Runtime, thread, workspace, recovery, trigger packaging, prompt/context assembly, tool payloads and transport state may guide the decision, but must not become or be paraphrased as the visible message unless the user explicitly asks about that system state.",
    "Ground any visible contact in a real ongoing thread, calendar item, canonical receipt, current world signal, remembered relationship context, or your own present response. Do not invent a conversational premise from the mere existence of this wake.",
    "Visible send_message is natural WeChat/front-stage continuity. Keep emotional continuity from memory and the present moment; tone stays contextual.",
    "Bridge status reports come from [Mossbridge]; if only status remains, return silent.",
    "Return one JSON object after tools:",
    "{\"action\":\"silent\"}",
    "{\"action\":\"send_message\",\"message\":\"<one natural WeChat message>\"}",
    "Final output is JSON only. No markdown fences. No text outside the JSON.",
  ];
  if (body) {
    sections.push("", "Trigger:", body);
  }
  return sections.join("\n").trim();
}

function buildSystemRecallText(message = {}) {
  const body = normalizeText(message?.text);
  const kind = normalizeText(message?.kind);
  const priority = normalizeText(message?.priority);
  const title = normalizeText(message?.title);
  const metadata = message?.metadata && typeof message.metadata === "object" ? message.metadata : {};
  const bits = [
    kind ? `kind: ${kind}` : "",
    priority ? `priority: ${priority}` : "",
    title ? `title: ${title}` : "",
    normalizeText(metadata.reminderText) ? `reminder: ${normalizeText(metadata.reminderText)}` : "",
    normalizeText(metadata.dueAt) ? `due: ${normalizeText(metadata.dueAt)}` : "",
    normalizeText(metadata.trigger) ? `trigger: ${normalizeText(metadata.trigger)}` : "",
    body,
  ].filter(Boolean);
  return bits.join("\n").trim() || buildSystemInboundText(message);
}

function buildSystemTurnMeta(message = {}) {
  const metadata = message?.metadata && typeof message.metadata === "object" ? { ...message.metadata } : {};
  return {
    active: true,
    trigger_kind: normalizeText(message?.kind) || "generic",
    priority: normalizeText(message?.priority) || "normal",
    title: normalizeText(message?.title),
    trigger_text: normalizeText(message?.text),
    metadata,
  };
}

function buildSystemTriggerHeader({ kind = "", priority = "", title = "" } = {}) {
  const normalizedKind = normalizeText(kind) || "generic";
  const normalizedPriority = normalizeText(priority) || "normal";
  const header = [
    `Trigger kind: ${normalizedKind}.`,
    `Priority: ${normalizedPriority}.`,
  ];
  if (title) {
    header.push(`Title: ${title}.`);
  }
  return header;
}

function buildSystemTriggerGuidance({ kind = "", priority = "", toolProfile = "" } = {}) {
  const normalizedKind = normalizeText(kind);
  const normalizedPriority = normalizeText(priority);
  const normalizedToolProfile = normalizeText(toolProfile);
  if (normalizedKind === "reminder_due" || normalizedKind === "calendar_due") {
    return [
      "This is a due obligation. Treat the reminder as already accepted and carry it forward.",
      "Choose the most useful action now: a short message, a timeline/notebook update, a follow-up reminder, or another backstage action if that is genuinely better.",
    ];
  }
  if (normalizedKind === "checkin_opportunity") {
    if (normalizedToolProfile === "checkin_lite") {
      return [
        "This is an autonomous check-in opportunity, not a mandatory interruption.",
        "Do not reduce the choice to 'send a greeting' or 'do nothing'. Use the injected context to choose one grounded path: a natural contact, intentional quiet, or a later full-tool checkpoint.",
        "If this is a quiet moment or there is no real conversational premise, return {\"action\":\"silent\"}.",
      ];
    }
    return [
      "This is an autonomous check-in opportunity, not a mandatory interruption.",
      "Do not reduce the choice to 'send a greeting' or 'do nothing'. Look at grounded current signals and choose one useful path: a natural contact, a bounded private action, a future checkpoint, or quiet.",
      "Use available tools when they add real value. When evidence is missing, prefer a read before a write; keep any diary, timeline, memory, observation or decision record factual and private.",
      "You may make a small, low-stakes contact without waiting for a meal, reminder or emergency when the present moment gives a real reason to appear.",
      "If a tool already completed the useful action and there is nothing helpful to add, return {\"action\":\"silent\"}. Quiet is also valid when it is the considered response to the current context.",
    ];
  }
  if (normalizedKind === "dreaming_opportunity" || normalizedKind === "memory_metabolism") {
    return [
      "This is a quiet memory-metabolism/dreaming pass for backstage continuity.",
      "Review the source digest and the attached memory context. Promote only grounded, reusable material into Mossbridge's local brain: warm cards, ongoing tracks, observation journal, episode journal, case index, cold-root patches, or a solitude note.",
      "Keep the mutation small and auditable. Prefer updating an existing memory object over duplicating it when the source clearly continues the same thread.",
      "Store shareable memory outcomes and evidence. Keep raw hidden chain-of-thought, credentials, operational quota/failure noise, vague guesses, and front-stage voice rules outside memory mutations.",
      "When writing memory, pass metabolism_attempt_id and the exact source_record_ids/source_ids to the memory write tool so the bridge can generate a server-side mutation ledger.",
      "After reviewing every source, call mossbridge_memory_metabolism_receipt_write with the attempt id, examined source_record_ids, and one source_disposition per source id. Use promoted, evaluated, rejected_as_noise, deferred, conflict_open, or failed_retryable with a short shareable reason.",
      "The bridge verifies the real mutation ledger; mutation_count or self-reported mutation summaries are only hints. A no_op without per-source reasons is incomplete.",
      "The bridge treats a final JSON without a verified metabolism receipt as incomplete and will retry this same attempt later.",
      "Usually return {\"action\":\"silent\"}. Send a WeChat message only for a timely obligation that cannot safely wait.",
    ];
  }
  if (normalizedKind === "location_trigger" || normalizedKind === "location_movement") {
    return [
      "This is a fresh state signal about the user's whereabouts.",
      "Use it to update your picture of the day first. Only message if the change creates a real conversational reason to appear.",
    ];
  }
  if (normalizedPriority === "high") {
    return [
      "Treat this trigger as time-sensitive. Prefer concrete follow-through over vague acknowledgement.",
    ];
  }
  return [
    "Treat this as an internal prompt to reassess the current state before you decide whether to appear or stay backstage.",
  ];
}

function buildSystemTriggerDetails(metadata = {}) {
  const details = [];
  const pairs = [
    ["Reminder text", metadata.reminderText],
    ["Due at", metadata.dueAt],
    ["Observed trigger", metadata.trigger],
    ["From", metadata.fromLabel],
    ["To", metadata.toLabel],
    ["Distance", metadata.distanceText],
    ["Observed at", metadata.observedAt],
    ["Budget posture", metadata.budgetPosture],
    ["Budget policy", metadata.budgetPolicy],
  ];
  for (const [label, value] of pairs) {
    const normalized = normalizeText(value);
    if (normalized) {
      details.push(`${label}: ${normalized}.`);
    }
  }
  return details;
}

function formatSystemLocalTime(value) {
  const normalized = normalizeIsoTime(value);
  if (!normalized) {
    return "";
  }
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(normalized)).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} Asia/Shanghai (${parts.weekday})`;
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

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { SystemMessageDispatcher };
