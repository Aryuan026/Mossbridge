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
    ...(localTime ? [`[${localTime}]`, ""] : []),
    "SYSTEM ACTION MODE: internal trigger, not user-authored chat.",
    ...buildSystemTriggerHeader({ kind, priority, title }),
    ...buildSystemTriggerGuidance({ kind, priority, toolProfile }),
    ...buildSystemTriggerDetails(metadata),
    ...(liteCheckin
      ? [
          "This random check-in runs with a lightweight tool profile: do not attempt backstage maintenance, file work, memory edits, email, stickers, device control, or searches.",
          "Use only the injected memory/status context and decide whether to stay silent or send one natural WeChat message.",
        ]
      : [
          "Use tools as affordances, not a checklist; read/write only when this trigger needs it.",
          "Safe scope: memory, reminders, diary/notebook, episode/case/observation, timeline/status reads, stickers/files, capability requests. Do not restart services, rebind accounts, change credentials, delete memory, or perform account/device/OAuth work unless the human explicitly asked.",
        ]),
    "Visible send_message is natural WeChat/front-stage continuity, not bridge status. Keep emotional continuity from memory/recent context; no tone template.",
    "Bridge status reports come from [Mossbridge]; if only status remains, return silent.",
    "Return one JSON object after tools:",
    "{\"action\":\"silent\"}",
    "{\"action\":\"send_message\",\"message\":\"<one natural WeChat message>\"}",
    "No text outside JSON.",
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
      "This is a due obligation, not a random thought. Do not re-judge whether it matters.",
      "Choose the most useful action now: a short message, a timeline/notebook update, a follow-up reminder, or another backstage action if that is genuinely better.",
    ];
  }
  if (normalizedKind === "checkin_opportunity") {
    if (normalizedToolProfile === "checkin_lite") {
      return [
        "This is a lightweight reconnection window, not a task execution window.",
        "Do not reduce the choice to 'send a greeting' versus 'do nothing': use the already-injected recent context to decide whether a small WeChat message would genuinely help.",
        "If it is not the right moment to message, return {\"action\":\"silent\"}; silence should mean intentional quiet, not forgetting.",
      ];
    }
    return [
      "This is a lightweight maintenance and reconnection window, not a mandatory interruption.",
      "Do not reduce the choice to 'send a greeting' versus 'do nothing'. You may do a small, low-risk maintenance pass first: bridge status, wakeup agenda, pending reminders, memory/ongoing/episode/observation state, today's timeline/notebook, whereabouts/context signals, or other bridge-provided status surfaces when relevant.",
      "Prefer read-only checks first. Safe writes are small continuity handles: reminder, diary/timeline note, observation, ongoing-track update, solitude journal entry, or concrete capability request if the bridge lacks the status surface you need. Do not store raw hidden chain-of-thought.",
      "Write a concise wakeup decision record if the tool exists. Keep it factual and shareable: decision, wake motive, actions taken, next actions, contact channel, and budget posture.",
      "If the user appears awake and there is no protected quiet-state signal, you are allowed to gently interrupt with a small low-stakes message. Do not wait only for meal times, reminders, or obviously important events.",
      "If not messaging, leave a usable backstage handle when one exists. Choose silence only when you have a concrete reason to protect attention, or when the actual outcome is 'maintenance done or intentionally skipped'; silence must not mean 'the system forgot to act'.",
    ];
  }
  if (normalizedKind === "dreaming_opportunity" || normalizedKind === "memory_metabolism") {
    return [
      "This is a quiet memory-metabolism/dreaming pass, not a user conversation and not a generic check-in.",
      "Review the source digest and the attached memory context. Promote only grounded, reusable material into Mossbridge's local brain: warm cards, ongoing tracks, observation journal, episode journal, case index, cold-root patches, or a solitude note.",
      "Keep the mutation small and auditable. Prefer updating an existing memory object over duplicating it when the source clearly continues the same thread.",
      "Do not store raw hidden chain-of-thought, credentials, operational quota/failure noise, or vague guesses. Do not turn memory整理 into front-stage voice rules.",
      "After successful mutations, call mossbridge_memory_metabolism_receipt_write with the attempt id, source record ids, mutation_count, mutation summaries, and a concise shareable summary. If no durable memory belongs here, call that receipt tool with status=no_op and mutation_count=0.",
      "The bridge treats a final JSON without a metabolism receipt as incomplete and will retry this same attempt later.",
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
