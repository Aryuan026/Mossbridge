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
  const sections = [
    ...(localTime ? [`[${localTime}]`, ""] : []),
    "SYSTEM ACTION MODE: internal trigger, not user chat.",
    ...buildSystemTriggerHeader({ kind, priority, title }),
    ...buildSystemTriggerGuidance({ kind, priority }),
    ...buildSystemTriggerDetails(metadata),
    "Use memory tools when the trigger clearly needs grounded history, preference, or continuity. If a surfaced hint is not enough, search memory instead of bluffing.",
    "Do any timeline/diary/reminder/whereabouts work that genuinely helps for this trigger.",
    "If you act visibly, end with send_message that naturally reflects what you did or what changed. Keep it WeChat-natural. Let it be as short or as full as the moment actually needs; do not flatten it just to sound efficient when relationship context or continuity genuinely matters.",
    "Return exactly one JSON object after any tool calls:",
    "{\"action\":\"silent\"}",
    "{\"action\":\"send_message\",\"message\":\"<one natural WeChat message>\"}",
    "No reasoning. No text outside the JSON.",
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

function buildSystemTriggerGuidance({ kind = "", priority = "" } = {}) {
  const normalizedKind = normalizeText(kind);
  const normalizedPriority = normalizeText(priority);
  if (normalizedKind === "reminder_due" || normalizedKind === "calendar_due") {
    return [
      "This is a due obligation, not a random thought. Do not re-judge whether it matters.",
      "Choose the most useful action now: a short message, a timeline/diary update, a follow-up reminder, or another backstage action if that is genuinely better.",
    ];
  }
  if (normalizedKind === "checkin_opportunity") {
    return [
      "This is only an opportunity to reconnect, not a mandatory interruption.",
      "If the user appears awake and there is no protected quiet-state signal, you are allowed to gently interrupt with a small, low-stakes message. Do not wait only for meal times, reminders, or obviously important events.",
      "If it is not the right moment to message, you can still leave a usable handle through diary, timeline, or a follow-up reminder instead of disappearing.",
      "Choose silence only when you have a concrete reason to protect her attention, not merely because the check-in reason is small.",
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
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(normalized)).replace(/\//g, "-");
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
