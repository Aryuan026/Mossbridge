const fs = require("fs");
const { WhereaboutsToolHost } = require("whereabouts-mcp");
const {
  STICKER_DESC_FIELD_DESCRIPTION,
  STICKER_STATUS_FIELD_DESCRIPTION,
  STICKER_TAG_GUIDANCE,
} = require("../services/sticker-service");
const { ControlLedgerStore } = require("../control/control-plane");
const { resolveCheckinDailyBudget } = require("../app/system-checkin-poller");

const TOOL_PROFILE_FULL = "full";
const TOOL_PROFILE_FOREGROUND = "foreground";
const TOOL_PROFILE_TASK = "task";
const TOOL_PROFILE_CHECKIN_LITE = "checkin_lite";
const METABOLISM_META_PROPERTIES = {
  metabolism_attempt_id: { type: "string", description: "Dreaming/metabolism attempt id. Use only during a memory-metabolism system turn so the bridge can verify real mutations." },
  dreaming_attempt_id: { type: "string", description: "Alias for metabolism_attempt_id." },
  source_record_ids: { type: "array", items: { type: "string" }, description: "Attempt source ids this mutation is grounded in." },
  source_ids: { type: "array", items: { type: "string" }, description: "Alias for source_record_ids." },
};
const METABOLISM_META_KEYS = new Set(Object.keys(METABOLISM_META_PROPERTIES));
const WARM_MEMORY_WRITE_GUIDANCE = "Warm cards are first-person diary/persona continuity for the current assistant/persona: what happened or was corrected, why it matters, what evidence/source grounds it, and how future self should use it. Do not write generic user profiles, tag lists, task/debug reports, tool policy, or cards phrased as 'The user prefers...' / 'the assistant should...'.";
const MEMORY_MUTATION_TOOL_NAMES = new Set([
  "mossbridge_diary_append",
  "mossbridge_memory_warm_write",
  "mossbridge_memory_warm_update",
  "mossbridge_memory_warm_delete",
  "mossbridge_memory_ongoing_upsert",
  "mossbridge_memory_ongoing_close",
  "mossbridge_memory_episode_upsert",
  "mossbridge_memory_episode_append",
  "mossbridge_memory_case_upsert",
  "mossbridge_memory_case_append",
  "mossbridge_memory_case_artifact",
  "mossbridge_memory_case_close",
  "mossbridge_memory_observation_append",
  "mossbridge_memory_observation_update",
  "mossbridge_memory_cold_patch",
  "mossbridge_memory_cold_upsert",
  "mossbridge_solitude_journal_write",
]);

class ProjectToolHost {
  constructor({ services, runtimeContextStore, toolInvocationAuditStore = null }) {
    this.services = services;
    this.runtimeContextStore = runtimeContextStore;
    this.toolInvocationAuditStore = toolInvocationAuditStore;
    this.extraToolHosts = createExtraToolHosts(services);
  }

  listTools({ toolProfile = "" } = {}) {
    const normalizedToolProfile = normalizeToolProfile(toolProfile);
    const builtIn = PROJECT_TOOLS.map((tool) => ({
      name: tool.name,
      description: buildToolDescription(tool),
      inputSchema: buildEffectiveInputSchema(tool),
    }));
    const extra = this.extraToolHosts.flatMap((host) => host.listTools());
    return filterToolsByProfile([...builtIn, ...extra], normalizedToolProfile);
  }

  async invokeTool(toolName, args = {}, context = {}) {
    const startedAtMs = Date.now();
    const auditContext = this.resolveContext(context);
    const toolProfile = normalizeToolProfile(context.toolProfile);
    try {
      const result = await this.invokeToolWithoutAudit(toolName, args, context);
      this.toolInvocationAuditStore?.append?.({
        toolName,
        toolProfile,
        context: auditContext,
        startedAtMs,
        completedAtMs: Date.now(),
        result,
      });
      return result;
    } catch (error) {
      this.toolInvocationAuditStore?.append?.({
        toolName,
        toolProfile,
        context: auditContext,
        startedAtMs,
        completedAtMs: Date.now(),
        error,
      });
      throw error;
    }
  }

  async invokeToolWithoutAudit(toolName, args = {}, context = {}) {
    const normalizedToolProfile = normalizeToolProfile(context.toolProfile);
    if (!isToolAllowedInProfile(toolName, normalizedToolProfile)) {
      throw new Error(`Tool ${toolName} is not available in ${normalizedToolProfile} profile.`);
    }
    const spec = PROJECT_TOOLS.find((candidate) => candidate.name === toolName);
    const normalizedArgs = args && typeof args === "object" ? args : {};
    if (spec) {
      const inputSchema = buildEffectiveInputSchema(spec);
      validateSchema(inputSchema, normalizedArgs, toolName, "input");
      const resolvedContext = this.resolveContext(context);
      const metabolismMeta = extractMetabolismMeta(normalizedArgs);
      const mutationMetaValidation = this.validateMemoryMutationMeta({
        toolName,
        metabolismMeta,
        context: resolvedContext,
      });
      if (!mutationMetaValidation.ok) {
        throw new Error(mutationMetaValidation.error || `Invalid memory metabolism metadata for ${toolName}`);
      }
      const handlerArgs = isMemoryMutationTool(toolName)
        ? stripMetabolismMeta(normalizedArgs)
        : normalizedArgs;
      const before = isMemoryMutationTool(toolName)
        ? await readMemoryMutationBefore(this.services, toolName, handlerArgs, resolvedContext)
        : null;
      const result = await spec.handler({
        services: this.services,
        args: handlerArgs,
        context: resolvedContext,
      });
      this.recordMemoryMetabolismSideEffects({
        toolName,
        args: handlerArgs,
        rawArgs: normalizedArgs,
        metabolismMeta,
        result,
        before,
        context: resolvedContext,
      });
      return result;
    }
    for (const host of this.extraToolHosts) {
      if (host.listTools().some((tool) => tool.name === toolName)) {
        return await host.invokeTool(toolName, normalizedArgs);
      }
    }
    throw new Error(`Unknown tool: ${toolName}`);
  }

  validateMemoryMutationMeta({ toolName = "", metabolismMeta = {}, context = {} } = {}) {
    if (!isMemoryMutationTool(toolName)) {
      return { ok: true };
    }
    const service = this.services?.memoryMetabolism;
    if (!service) {
      return { ok: true };
    }
    const attemptId = normalizeText(metabolismMeta.metabolism_attempt_id || metabolismMeta.dreaming_attempt_id);
    const sourceIds = normalizeStringList(metabolismMeta.source_record_ids || metabolismMeta.source_ids);
    if (attemptId) {
      if (typeof service.validateMutation !== "function") {
        return { ok: true };
      }
      return service.validateMutation({
        attempt_id: attemptId,
        source_ids: sourceIds,
        require_source_ids: true,
      });
    }
    if (sourceIds.length) {
      return {
        ok: false,
        error: "metabolism_attempt_id is required when source_record_ids are provided",
      };
    }
    if (
      typeof service.hasActiveAttemptForContext === "function"
      && service.hasActiveAttemptForContext({
        threadId: context.threadId,
        workspaceRoot: context.workspaceRoot,
        senderId: context.senderId,
      })
    ) {
      return {
        ok: false,
        error: "metabolism_attempt_id and source_record_ids are required inside the active dreaming thread",
      };
    }
    return { ok: true };
  }

  recordMemoryMetabolismSideEffects({
    toolName = "",
    args = {},
    rawArgs = {},
    metabolismMeta = {},
    result = null,
    before = null,
    context = {},
  } = {}) {
    const service = this.services.memoryMetabolism;
    if (!service) {
      return;
    }
    const attemptId = normalizeText(metabolismMeta.metabolism_attempt_id || metabolismMeta.dreaming_attempt_id);
    if (toolName === "mossbridge_diary_append" && !attemptId && typeof service.recordSourceEvent === "function") {
      const data = result?.data || {};
      service.recordSourceEvent({
        source_type: "notebook",
        source_id: normalizeText(data.filePath),
        source_label: "mossbridge_diary_append",
        object_id: normalizeText(data.filePath),
        action: "append",
        userId: resolveBoundUserId(rawArgs, context),
        ts_utc: buildNotebookEventTimestamp(data),
        content: data.body || args.text,
        summary: args.title || "Notebook entry appended",
        metadata: { filePath: data.filePath, date: data.date, time: data.time },
      });
      return;
    }
    if (isToolResultFailure(result)) {
      return;
    }
    const mutation = buildMemoryMutationDescriptor(toolName, args, result);
    if (!mutation.target || !mutation.object_id || !mutation.action) {
      return;
    }
    const sourceIds = normalizeStringList(metabolismMeta.source_record_ids || metabolismMeta.source_ids);
    if (attemptId && typeof service.recordMutation === "function") {
      const ledgerResult = service.recordMutation({
        attempt_id: attemptId,
        tool_name: toolName,
        source_ids: sourceIds,
        target: mutation.target,
        object_id: mutation.object_id,
        action: mutation.action,
        before,
        after: mutation.after,
        summary: mutation.summary,
      });
      if (ledgerResult?.ok !== true) {
        throw new Error(`Memory mutation ledger rejected ${toolName}: ${ledgerResult?.error || "unknown error"}`);
      }
      return;
    }
    if (typeof service.recordSourceEvent === "function") {
      service.recordSourceEvent({
        source_type: `memory_mutation:${mutation.target}`,
        source_id: mutation.object_id,
        source_label: toolName,
        object_id: mutation.object_id,
        action: mutation.action,
        userId: resolveBoundUserId(rawArgs, context),
        content: mutation.summary || JSON.stringify(mutation.after || {}),
        summary: mutation.summary || `${mutation.action} ${mutation.target}`,
        metadata: { toolName, sourceIds },
      });
    }
  }

  resolveContext(context = {}) {
    const explicitWorkspaceRoot = normalizeText(context.workspaceRoot);
    const explicitRuntimeId = normalizeText(context.runtimeId);
    const active = this.runtimeContextStore.resolveActiveContext({
      workspaceRoot: explicitWorkspaceRoot,
      runtimeId: explicitRuntimeId,
    }) || {};
    return {
      runtimeId: explicitRuntimeId || normalizeText(active.runtimeId),
      workspaceRoot: explicitWorkspaceRoot || normalizeText(active.workspaceRoot),
      threadId: normalizeText(context.threadId) || normalizeText(active.threadId),
      bindingKey: normalizeText(context.bindingKey) || normalizeText(active.bindingKey),
      accountId: normalizeText(context.accountId) || normalizeText(active.accountId),
      senderId: normalizeText(context.senderId) || normalizeText(active.senderId),
    };
  }
}

function listProjectToolNames({ toolProfile = "" } = {}) {
  const names = [
    ...PROJECT_TOOLS.map((tool) => tool.name),
    ...STATIC_EXTRA_TOOL_NAMES,
  ];
  const normalizedToolProfile = normalizeToolProfile(toolProfile);
  return names.filter((name) => isToolAllowedInProfile(name, normalizedToolProfile));
}

function buildEffectiveInputSchema(tool = {}) {
  const schema = tool.inputSchema && typeof tool.inputSchema === "object"
    ? tool.inputSchema
    : {};
  if (!isMemoryMutationTool(tool.name)) {
    return schema;
  }
  return {
    ...schema,
    properties: {
      ...(schema.properties || {}),
      ...METABOLISM_META_PROPERTIES,
    },
  };
}

function isMemoryMutationTool(toolName = "") {
  return MEMORY_MUTATION_TOOL_NAMES.has(normalizeText(toolName));
}

function extractMetabolismMeta(args = {}) {
  const meta = {};
  for (const key of METABOLISM_META_KEYS) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      meta[key] = args[key];
    }
  }
  return meta;
}

function stripMetabolismMeta(args = {}) {
  const output = {};
  Object.entries(args || {}).forEach(([key, value]) => {
    if (!METABOLISM_META_KEYS.has(key)) {
      output[key] = value;
    }
  });
  return output;
}

const PROJECT_TOOLS = [
  {
    name: "mossbridge_diary_append",
    description: "Append a small notebook entry into Mossbridge local notebook storage. The tool name is legacy-compatible; this is cold-layer notebook material, not a warm-memory diary/persona card.",
    shortHint: "Append a notebook entry with direct text content.",
    topics: ["notebook"],
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "Notebook body to append." },
        title: { type: "string", description: "Optional short entry title." },
        date: { type: "string", description: "Optional date in YYYY-MM-DD." },
        time: { type: "string", description: "Optional time in HH:mm." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.diary.append(args);
      return {
        text: `Notebook entry appended to ${result.filePath}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_reminder_create",
    description: "Create a Mossbridge AI-calendar wakeup for a future checkpoint or follow-up. Due reminders wake with the full tool profile; random check-ins use the lightweight profile.",
    shortHint: "Create an AI-calendar wakeup with text plus delayMinutes or dueAt.",
    topics: ["reminder"],
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "Future-self agenda for the wakeup." },
        delayMinutes: { type: "integer", description: "Minutes from now." },
        dueAt: { type: "string", description: "Absolute time, e.g. 2026-04-07T21:30+08:00." },
        userId: { type: "string", description: "Optional WeChat user id." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.reminder.create(args, context);
      return {
        text: `Reminder queued: ${result.id}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_reminder_list",
    description: "List pending reminders for the current user. Use before cancelling.",
    shortHint: "List pending reminders with their IDs and due times.",
    topics: ["reminder"],
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "Optional WeChat user id." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const reminders = services.reminder.list(args, context);
      if (!reminders.length) {
        return { text: "No pending reminders.", data: { reminders: [] } };
      }
      const lines = reminders.map((r) => `- id=${r.id} dueAt=${r.dueAt} | ${r.text}`);
      return {
        text: `Pending reminders (${reminders.length}):\n${lines.join("\n")}`,
        data: { reminders },
      };
    },
  },
  {
    name: "mossbridge_reminder_cancel",
    description: "Cancel one pending reminder by id.",
    shortHint: "Cancel one pending reminder by id.",
    topics: ["reminder"],
    inputSchema: {
      type: "object",
      required: ["reminder_id"],
      properties: {
        reminder_id: { type: "string", description: "Reminder id." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = services.reminder.cancel(args);
      return {
        text: result.cancelled
          ? `Reminder ${result.reminder_id} cancelled.`
          : `Reminder ${result.reminder_id} not found (may have already fired).`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_system_send",
    description: "Queue an internal Mossbridge system trigger. Not for replying to the current user turn.",
    shortHint: "Queue an internal system message for the current workspace.",
    topics: ["system"],
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string" },
        workspaceRoot: { type: "string" },
        userId: { type: "string" },
        kind: { type: "string" },
        priority: { type: "string" },
        title: { type: "string" },
        metadata: { type: "object" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = services.system.queueMessage(args, context);
      return {
        text: `System message queued: ${result.id}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_bridge_status",
    description: "Read-only Mossbridge status for reminder/calendar/dreaming/maintenance wakeups. Random check-ins usually run in a lightweight no-tool profile; use this in full-tool passes to inspect queues, reminders, cooldowns, context pressure, and control events.",
    shortHint: "Inspect bridge queues, reminders, runtime cooldown, context pressure, and control events.",
    topics: ["system", "wakeup"],
    inputSchema: {
      type: "object",
      properties: {
        includeRuntime: { type: "boolean", description: "Include runtime/cooldown status." },
        includeQueues: { type: "boolean", description: "Include system/deferred queues." },
        includeReminders: { type: "boolean", description: "Include reminder count/next due." },
        includeControl: { type: "boolean", description: "Include recent control events." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = buildBridgeStatusSnapshot(services, args, context, {
        label: "Mossbridge",
        defaultMaintenanceProfile: "safe_self_check",
        defaultSelfRepairAllowed: false,
      });
      return {
        text: formatBridgeStatusSnapshot(result),
        data: result,
      };
    },
  },
  {
    name: "mossbridge_channel_send_file",
    description: [
      "Send an existing local file back to the current WeChat chat.",
      "Use this for small, concrete files only. For work-case artifacts, first link the file with the case artifact tool and prefer sending a path/summary or external handoff for large or final files.",
      "The tool fails safely with diagnostics instead of blocking the conversation when WeChat/CDN upload is too large or slow.",
    ].join(" "),
    shortHint: "Send a small local file back to the current WeChat user; link large case files instead.",
    topics: ["channel"],
    inputSchema: {
      type: "object",
      required: ["filePath"],
      properties: {
        filePath: { type: "string" },
        userId: { type: "string" },
        forceLargeFile: { type: "boolean", description: "Only set true after the human explicitly asks to force a large WeChat file upload despite the safe-size guard." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      let result = null;
      try {
        result = await services.channelFile.sendToCurrentChat(args, context);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || "unknown file delivery error");
        return {
          text: `File not sent safely: ${message}`,
          data: {
            ok: false,
            status: "failed",
            error: message,
            code: normalizeText(error?.code),
            diagnostics: error?.channelFile || {},
          },
        };
      }
      return {
        text: `File sent: ${result.filePath}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_sticker_tags",
    description: "List a small slice of sticker tags, mainly for saving or curating stickers. For choosing a sticker to send, prefer mossbridge_sticker_search with a natural mood/scene query.",
    shortHint: "List sticker tags for curation; use search for sending.",
    topics: ["sticker", "channel"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional tag substring filter." },
        limit: { type: "integer", description: "Optional number of tags, default catalog behavior." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.sticker.listTags(args);
      return {
        text: `Sticker tags loaded: ${Array.isArray(result.tags) ? result.tags.length : 0}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_wakeup_agenda_read",
    description: "Read recent wakeup/self-agenda records before a full-tool reminder, calendar, dreaming, case, or maintenance pass.",
    shortHint: "Read recent wakeup outcomes and pending next actions.",
    topics: ["memory", "wakeup", "maintenance"],
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Recent record limit." },
        includeCleared: { type: "boolean", description: "Include cleared records." },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.listWakeupDecisions({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Wakeup agenda loaded: ${Number(result?.count) || 0} records, ${Array.isArray(result?.pending_next_actions) ? result.pending_next_actions.length : 0} pending actions.`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_wakeup_decision_write",
    description: "Write the final outcome of a full-tool wakeup. Store concise shareable summaries while keeping raw hidden chain-of-thought out of persisted records.",
    shortHint: "Record a wakeup decision and next action.",
    topics: ["memory", "wakeup", "maintenance"],
    inputSchema: {
      type: "object",
      required: ["decision", "intent_summary"],
      properties: {
        decision: { type: "string", description: "send, silent, maintenance, defer, budget_hold, continue_case, reminder, sticker." },
        wake_motive: { type: "string", description: "random_checkin, reminder_due, dreaming_aftercare, case_followup, budget_guard, etc." },
        intent_summary: { type: "string", description: "Concise outcome summary." },
        actions_taken: { type: "array", items: { type: "string" }, description: "Completed backstage actions." },
        next_actions: { type: "array", items: { type: "string" }, description: "Future wakeup handles." },
        budget_posture: { type: "string", description: "Budget/context note." },
        contact_channel: { type: "string", description: "wechat, sticker, none, later." },
        context_key: { type: "string", description: "Stable wake key, e.g. case:<id>." },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.appendWakeupDecision({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Wakeup decision stored: ${result?.record?.record_id || "(unknown)"}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_solitude_journal_write",
    description: "Write one backstage solitude/reflection journal entry after a wakeup, maintenance pass, or quiet self-review. Use this for concise, shareable reasoning summaries, lessons, hypotheses, evolution candidates, or capability requests. Persist shareable outcomes and visible evidence while keeping raw hidden chain-of-thought, secrets, credentials, and private diagnostic noise out of the record.",
    shortHint: "Write a quiet self-reflection journal entry.",
    topics: ["memory", "wakeup", "maintenance"],
    inputSchema: {
      type: "object",
      required: ["summary"],
      properties: {
        summary: { type: "string", description: "Short shareable summary of what was noticed or decided." },
        entry_type: { type: "string", description: "reflection, experience, hypothesis, evolution_candidate, capability_request, user_contact_candidate, or maintenance_note." },
        wake_context: { type: "string", description: "What woke this entry: random_checkin, reminder_due, dreaming_aftercare, maintenance, etc." },
        reasoning_summary: { type: "string", description: "Concise rationale in shareable form, with raw chain-of-thought kept out." },
        evidence: { type: "array", items: { type: "string" }, description: "Visible evidence, logs, memory refs, or observations used." },
        lesson: { type: "string", description: "Reusable experience distilled from this wakeup." },
        next_actions: { type: "array", items: { type: "string" } },
        proposed_changes: { type: "array", items: { type: "string" }, description: "Candidate future changes; these are proposals, not code edits." },
        contact_user: { type: "string", description: "none, wechat, later, or ask_user. Use only installed and configured contact/account/device channels." },
        contact_channel: { type: "string", description: "Optional preferred channel if contact_user is not none." },
        related_case_ids: { type: "array", items: { type: "string" } },
        related_memory_refs: { type: "array", items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } },
        confidence: { type: "number" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.appendSolitudeEntry({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Solitude journal entry stored: ${result?.solitude_id || "(unknown)"}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_solitude_journal_search",
    description: "Search recent backstage solitude/reflection journal entries. Use this when a wakeup, case, or maintenance pass needs to remember what the agent previously noticed, learned, or wanted to revisit.",
    shortHint: "Search quiet self-reflection entries.",
    topics: ["memory", "wakeup", "maintenance"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        entry_types: { type: "array", items: { type: "string" } },
        limit: { type: "integer" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.searchSolitudeEntries({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Solitude journal entries found: ${Number(result?.count) || 0}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_metabolism_receipt_write",
    description: "Write the judgment receipt for a quiet dreaming/memory-metabolism pass. The bridge verifies real memory writes from the server-side mutation ledger; this tool must give a per-source disposition for every examined source id. Without verified dispositions and, for promoted sources, real tool mutations tied to the attempt, the attempt is retried.",
    shortHint: "Record per-source dreaming dispositions for the completion gate.",
    topics: ["memory", "maintenance", "dreaming"],
    inputSchema: {
      type: "object",
      required: ["attempt_id", "status", "summary"],
      properties: {
        attempt_id: { type: "string", description: "Dreaming attempt id from the system trigger." },
        status: { type: "string", description: "mutated, no_op, or failed." },
        summary: { type: "string", description: "Short shareable summary of what changed or why no mutation was needed." },
        mutation_count: { type: "integer", description: "Legacy hint only; the bridge verifies actual mutation count from the server ledger." },
        source_record_ids: { type: "array", items: { type: "string" }, description: "Attempt source ids examined by this pass." },
        source_dispositions: {
          type: "array",
          description: "One disposition per source id. Required for every source_record_id.",
          items: {
            type: "object",
            required: ["source_id", "status", "reason"],
            properties: {
              source_id: { type: "string" },
              status: { type: "string", description: "promoted, evaluated, rejected_as_noise, deferred, conflict_open, or failed_retryable." },
              reason: { type: "string", description: "Short shareable reason. No hidden chain-of-thought." },
              target_refs: { type: "array", items: { type: "string" }, description: "Optional ids of memory objects affected." },
            },
            additionalProperties: false,
          },
        },
        mutations: {
          type: "array",
          description: "Legacy summary only. Real mutations are verified from the server ledger produced by memory tools.",
          items: {
            type: "object",
            properties: {
              target: { type: "string", description: "warm_memory, ongoing_track, episode_journal, case_index, observation_journal, cold_root, solitude_journal, or no_op." },
              action: { type: "string", description: "upsert, append, patch, close, no_op, etc." },
              id: { type: "string", description: "Best stable id for the written memory object, if available." },
              summary: { type: "string", description: "One short factual summary of the mutation." },
            },
            additionalProperties: false,
          },
        },
        error: { type: "string", description: "Optional error summary when status=failed." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      if (!services.memoryMetabolism || typeof services.memoryMetabolism.recordReceipt !== "function") {
        throw new Error("memory metabolism service is not available");
      }
      const result = services.memoryMetabolism.recordReceipt(args);
      return {
        text: result.ok
          ? `Memory metabolism receipt stored: ${result.receipt.receipt_id}`
          : `Memory metabolism receipt recorded but incomplete: ${result.receipt.receipt_id}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_sticker_search",
    description: "Search the sticker warehouse by natural mood, scene, gesture, or intended front-stage effect before sending a sticker. Prefer this over tag listing for normal conversation, because it searches meaning/useWhen/avoidWhen/desc instead of requiring exact tag guesses.",
    shortHint: "Search sticker warehouse by scene or meaning.",
    topics: ["sticker", "channel"],
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Natural search text, for example soft hug comfort, smug little dog, goodnight wave." },
        limit: { type: "integer", description: "Optional number of candidates, default 5, max 20." },
        pack: { type: "string", description: "Optional sticker pack filter." },
        status: { type: "string", description: `${STICKER_STATUS_FIELD_DESCRIPTION} Defaults to active.` },
        includeArchive: { type: "boolean", description: "When true, archived stickers can be considered too." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.sticker.search(args);
      return {
        text: `Sticker search for ${result.query}: ${Array.isArray(result.candidates) ? result.candidates.length : 0}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_sticker_pick",
    description: "Pick existing sticker candidates by one exact tag. Use only when you already know the tag; otherwise use mossbridge_sticker_search so intent matching can use meaning/useWhen/avoidWhen.",
    shortHint: "Pick sticker candidates by tag.",
    topics: ["sticker", "channel"],
    inputSchema: {
      type: "object",
      required: ["tag"],
      properties: {
        tag: { type: "string", description: `One sticker tag. ${STICKER_TAG_GUIDANCE}` },
        limit: { type: "integer", description: "Optional number of candidates, default 5, max 20." },
        pack: { type: "string", description: "Optional sticker pack filter, for example 小萝卜." },
        status: { type: "string", description: `${STICKER_STATUS_FIELD_DESCRIPTION} Defaults to active.` },
        includeArchive: { type: "boolean", description: "When true, archived stickers can be considered too." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.sticker.pick(args);
      return {
        text: `Sticker candidates for ${result.tag}: ${Array.isArray(result.candidates) ? result.candidates.length : 0}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_sticker_list",
    description: "List saved stickers, optionally filtered by tag. Use this to inspect the sticker inventory before choosing one.",
    shortHint: "List saved stickers with tags and descriptions.",
    topics: ["sticker", "channel"],
    inputSchema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "Optional sticker tag filter." },
        pack: { type: "string", description: "Optional sticker pack filter." },
        status: { type: "string", description: "Optional active/archive filter." },
        limit: { type: "integer", description: "Optional number of stickers, default 20, max 20." },
        includeMissing: { type: "boolean", description: "Include catalog entries whose gif file is missing." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.sticker.list(args);
      return {
        text: `Sticker inventory: ${Number(result.count) || 0}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_sticker_send",
    description: "Send one saved sticker to the current WeChat chat by stickerId. Use it when a sticker naturally adds warmth, play, emphasis, or a softer landing; the user does not need to explicitly ask for a sticker.",
    shortHint: "Send one saved sticker by stickerId.",
    topics: ["sticker", "channel"],
    inputSchema: {
      type: "object",
      required: ["stickerId"],
      properties: {
        stickerId: { type: "string" },
        userId: { type: "string", description: "Optional explicit WeChat user id." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.sticker.sendToCurrentChat(args, context);
      return {
        text: `Sticker sent: ${result.stickerId}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_sticker_save_from_inbox",
    description: "Save inbound WeChat image files from the managed inbox as reusable stickers with tags and descriptions.",
    shortHint: "Save one or more inbox image files as stickers.",
    topics: ["sticker", "channel"],
    inputSchema: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          description: "Sticker files to save. File paths must be under the bridge state inbox or workspace WeChat inbox.",
          items: {
            type: "object",
            required: ["filePath", "tags", "desc"],
            properties: {
              filePath: { type: "string", description: "Absolute path to an inbound image file in the managed inbox." },
              tags: {
                type: "array",
                description: `1-3 short tags. ${STICKER_TAG_GUIDANCE}`,
                items: { type: "string" },
              },
              desc: { type: "string", description: STICKER_DESC_FIELD_DESCRIPTION },
              pack: { type: "string", description: "Optional sticker pack name." },
              status: { type: "string", description: STICKER_STATUS_FIELD_DESCRIPTION },
              favorite: { type: "boolean", description: "Optional marker for core frequently used stickers." },
              source: { type: "string", description: "Optional import/source channel name." },
              sourceId: { type: "string", description: "Optional source id from the upstream catalog." },
              meaning: { type: "string", description: "Optional actual usage meaning for choosing the sticker later." },
              gesture: { type: "string", description: "Optional visible gesture or action in the sticker." },
              frontstageEffect: { type: "string", description: "Optional effect this sticker has in the front-stage chat." },
              tone: { type: "array", items: { type: "string" }, description: "Optional tone labels." },
              useWhen: { type: "array", items: { type: "string" }, description: "Optional scenes where this sticker fits." },
              avoidWhen: { type: "array", items: { type: "string" }, description: "Optional scenes where another sticker or text response fits better." },
            },
            additionalProperties: false,
          },
        },
        userId: { type: "string", description: "Optional explicit WeChat user id for the save notice." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.sticker.saveFromInbox(args, context);
      return {
        text: `Stickers saved: ${result.createdCount}, deduped: ${result.dedupedCount}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_sticker_update",
    description: "Update saved sticker tags and description. Use this when a sticker was saved with weak tags or unclear meaning.",
    shortHint: "Update sticker tags and description.",
    topics: ["sticker", "channel"],
    inputSchema: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["stickerId", "tags", "desc"],
            properties: {
              stickerId: { type: "string" },
              tags: {
                type: "array",
                description: `1-3 short tags. ${STICKER_TAG_GUIDANCE}`,
                items: { type: "string" },
              },
              desc: { type: "string", description: STICKER_DESC_FIELD_DESCRIPTION },
              pack: { type: "string", description: "Optional sticker pack name." },
              status: { type: "string", description: STICKER_STATUS_FIELD_DESCRIPTION },
              favorite: { type: "boolean", description: "Optional marker for core frequently used stickers." },
              source: { type: "string", description: "Optional import/source channel name." },
              sourceId: { type: "string", description: "Optional source id from the upstream catalog." },
              meaning: { type: "string", description: "Optional actual usage meaning for choosing the sticker later." },
              gesture: { type: "string", description: "Optional visible gesture or action in the sticker." },
              frontstageEffect: { type: "string", description: "Optional effect this sticker has in the front-stage chat." },
              tone: { type: "array", items: { type: "string" }, description: "Optional tone labels." },
              useWhen: { type: "array", items: { type: "string" }, description: "Optional scenes where this sticker fits." },
              avoidWhen: { type: "array", items: { type: "string" }, description: "Optional scenes where another sticker or text response fits better." },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.sticker.update(args);
      return {
        text: `Stickers updated: ${result.updatedCount}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_sticker_delete",
    description: "Delete saved stickers by stickerId.",
    shortHint: "Delete one or more saved stickers.",
    topics: ["sticker", "channel"],
    inputSchema: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["stickerId"],
            properties: {
              stickerId: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.sticker.delete(args, context);
      return {
        text: `Stickers deleted: ${result.deletedCount}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_context_packet",
    description: "Read the current memory context packet: warm cards, cold summary, and recent traces.",
    shortHint: "Read the current memory packet before a turn when recall feels important.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Recall query for current user scope." },
        userId: { type: "string", description: "Optional WeChat user id." },
        limit: { type: "integer", description: "Warm hit limit." },
        version: { type: "string", description: "Cold version label." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.captureContextPacket({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      const warmHitCount = Number(result?.warm_memory_packet?.hit_count) || 0;
      const coldVersion = result?.cold_memory?.active_version || "(none)";
      return {
        text: `Memory packet ready: warm=${warmHitCount} cold=${coldVersion}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_warm_write",
    description: `Write a warm-memory diary/persona card for the current user. ${WARM_MEMORY_WRITE_GUIDANCE}`,
    shortHint: "Save a grounded first-person warm diary/persona card with evidence-aware routing metadata.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["title", "body_markdown"],
      properties: {
        title: { type: "string", description: "Short stable title for the card; avoid fake category/tag titles." },
        body_markdown: { type: "string", description: "First-person diary/persona body. Include event/correction, meaning, evidence/source, and future-use cue; avoid profile, policy, tag-list, or report language." },
        summary: { type: "string", description: "Short recall key only; do not use summary as the whole memory card." },
        material_type: { type: "string", description: "Prefer diary/journal/preference/relationship_symbol/ongoing_story for warm continuity; avoid fake maintenance labels." },
        tags: { type: "array", items: { type: "string" }, description: "Broad routing categories only. Keep concrete nouns in entities/aliases instead of turning tags into a fake taxonomy." },
        entities: { type: "array", items: { type: "string" }, description: "Concrete people, objects, places, projects, or artifacts mentioned by the source evidence." },
        aliases: { type: "array", items: { type: "string" }, description: "Nicknames or alternate names for concrete entities." },
        storyline_id: { type: "string", description: "Stable continuing story/thread id when this belongs to a recurring line." },
        memory_family: { type: "string", description: "Broad family such as family_story, ongoing_story, relationship_symbol, preference, or self_axis; not a detailed fake tag." },
        provenance_refs: { type: "array", items: { type: "string" }, description: "Optional durable provenance refs, such as conversation cache record ids or imported archive ids." },
        source_archive_refs: { type: "array", items: { type: "string" }, description: "Optional raw-transcript archive ids or evidence-box ids tied to this card." },
        source_trace_ids: { type: "array", items: { type: "string" }, description: "Optional Driftstone/Hippocove-style source trace ids." },
        source_span_ids: { type: "array", items: { type: "string" }, description: "Optional complete-scene source span ids." },
        source_material_ids: { type: "array", items: { type: "string" }, description: "Optional source material ids used for later cold-tree sedimentation." },
        source_record_id: { type: "string", description: "Optional conversation cache record id when this card is distilled from a known turn." },
        source_query: { type: "string", description: "Optional exact user-side excerpt used as evidence for this warm diary card." },
        source_assistant_text: { type: "string", description: "Optional assistant-side excerpt paired with source_query." },
        source_excerpt: { type: "string", description: "Optional concise evidence excerpt when the original turn is not in conversation cache." },
        source_backfill_required: { type: "boolean", description: "Set true when the card is useful now but source binding must be completed in dreaming. Omit to auto-detect from source fields." },
        dreaming_review_required: { type: "boolean", description: "Set true when dreaming must re-read this warm card, bind source, or decide whether to sediment cold memory." },
        episode_refs: { type: "array", items: { type: "string" }, description: "Optional related episode ids, e.g. 2026-may-henan-trip, when this warm card is distilled from a bounded event journal." },
        case_refs: { type: "array", items: { type: "string" }, description: "Optional related case ids when this warm card is distilled from or supports a file/work case." },
        certainty_state: { type: "string", description: "Use source-pending/tentative/revisable/settled/anchor only when the evidence state really warrants it." },
        pinned: { type: "boolean", description: "Important/pinned for review and startup continuity. In Mossbridge, pinned may enter resident delivery unless resident is explicitly false; this is still not a tool-policy bucket." },
        resident: { type: "boolean", description: "Explicit every-turn resident warm memory. Use sparingly for identity, relationship continuity, or long-term collaboration anchors; tool/wakeup policy belongs in prompts or runbooks." },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.writeWarmMaterial({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Warm memory stored: ${result?.record?.material_id || "(unknown)"}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_warm_search",
    description: "Search warm-memory card candidates for the current user. Use this before updating or deleting when the exact card is still uncertain.",
    shortHint: "Search warm-memory candidates before changing a card.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
        material_types: { type: "array", items: { type: "string" } },
        recall_mode: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.searchWarmMaterials({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      const hitCount = Number(result?.hit_count) || 0;
      return {
        text: `Warm memory search returned ${hitCount} hits.`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_warm_read",
    description: "Read one specific warm-memory card by material_id for the current user. Use this before editing when you need to confirm the exact card contents. NOTE: material_id is the permanent immutable key — it does not change when title is updated. The title field is the true display name; material_id is only a stable reference key.",
    shortHint: "Read one warm-memory card before editing it.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["material_id"],
      properties: {
        material_id: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.readWarmMaterial({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: result?.ok
          ? `Warm memory loaded: ${result?.record?.material_id || args.material_id}`
          : `Warm memory not found: ${args.material_id}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_warm_list",
    description: "List recent warm-memory cards for the current user. Use this when you need the nearby card ids before deciding what to read, update, or delete.",
    shortHint: "List recent warm-memory cards.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer" },
        material_types: { type: "array", items: { type: "string" } },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.listWarmMaterials({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Warm memory list returned ${Number(result?.count) || 0} cards.`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_warm_update",
    description: `Update an existing warm-memory card by material_id for the current user. Use search/read first when the target card needs confirmation. ${WARM_MEMORY_WRITE_GUIDANCE} NOTE: material_id is the permanent immutable key and stays stable even when title is updated; always reference cards by material_id rather than display title.`,
    shortHint: "Update one exact warm-memory card by material_id. material_id is immutable; title is the display name.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["material_id"],
      properties: {
        material_id: { type: "string" },
        title: { type: "string" },
        body_markdown: { type: "string", description: "Replacement first-person diary/persona body with event/correction, meaning, evidence/source, and future-use cue." },
        summary: { type: "string", description: "Short recall key only; do not use summary as the whole memory card." },
        material_type: { type: "string", description: "Warm continuity type such as diary, journal, preference, relationship_symbol, or ongoing_story." },
        tags: { type: "array", items: { type: "string" }, description: "Broad routing categories only." },
        entities: { type: "array", items: { type: "string" }, description: "Concrete people, objects, places, projects, or artifacts from the evidence." },
        aliases: { type: "array", items: { type: "string" }, description: "Nicknames or alternate names for concrete entities." },
        storyline_id: { type: "string", description: "Stable continuing story/thread id." },
        memory_family: { type: "string", description: "Broad family such as family_story, ongoing_story, relationship_symbol, preference, or self_axis." },
        provenance_refs: { type: "array", items: { type: "string" }, description: "Durable provenance refs to preserve or add while correcting the card." },
        source_archive_refs: { type: "array", items: { type: "string" }, description: "Raw-transcript archive ids or evidence-box ids tied to this card." },
        source_trace_ids: { type: "array", items: { type: "string" }, description: "Driftstone/Hippocove-style source trace ids." },
        source_span_ids: { type: "array", items: { type: "string" }, description: "Complete-scene source span ids." },
        source_material_ids: { type: "array", items: { type: "string" }, description: "Source material ids used for later cold-tree sedimentation." },
        episode_refs: { type: "array", items: { type: "string" }, description: "Optional related episode ids to preserve the link back to a trip/photo/session journal." },
        case_refs: { type: "array", items: { type: "string" }, description: "Optional related case ids to preserve the link back to a file/work case." },
        certainty_state: { type: "string", description: "Use source-pending/tentative/revisable/settled/anchor only when the evidence state really warrants it." },
        pinned: { type: "boolean", description: "Important/pinned for review and startup continuity. In Mossbridge, pinned may enter resident delivery unless resident is explicitly false; this is still not a tool-policy bucket." },
        resident: { type: "boolean", description: "Explicit every-turn resident warm memory. Use sparingly for identity, relationship continuity, or long-term collaboration anchors; tool/wakeup policy belongs in prompts or runbooks." },
        storage_strength: { type: "number" },
        source_backfill_required: { type: "boolean", description: "Set false after source refs have been bound; set true if the card still needs evidence backfill." },
        dreaming_review_required: { type: "boolean", description: "Set true when dreaming must re-read this card for source binding or cold sedimentation." },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.updateWarmMaterial({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Warm memory updated: ${result?.record?.material_id || args.material_id}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_warm_delete",
    description: "Delete an existing warm-memory card by material_id for the current user. Use search/read first when the target card needs confirmation.",
    shortHint: "Delete one exact warm-memory card by material_id.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["material_id"],
      properties: {
        material_id: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.deleteWarmMaterial({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: result?.ok
          ? `Warm memory deleted: ${result.deleted_material_id || args.material_id}`
          : `Warm memory delete failed: ${result?.error || args.material_id}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_ongoing_upsert",
    description: "Create or update a medium-horizon ongoing track for the current user. Use this for live threads such as health/fitness/diet/sleep/stress efforts, in-progress writing, unresolved consultations, or maybe-buy decisions. For health-like conversation facts, prefer kind=health plus tags such as health, fitness, diet, sleep, stress, workload, recovery, medication, or allergy; keep evidence explicit and avoid medical diagnosis.",
    shortHint: "Create or update one ongoing track that should stay hanging for days or weeks.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        track_id: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        kind: { type: "string" },
        status: { type: "string" },
        target_window: { type: "string" },
        why_it_matters: { type: "string" },
        next_step: { type: "string" },
        next_check_at: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        related_entities: { type: "array", items: { type: "string" } },
        shadow_snippets: { type: "array", items: { type: "string" } },
        progress_log: { type: "array", items: { type: "string" } },
        pinned: { type: "boolean" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.upsertOngoingTrack({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Ongoing track stored: ${result?.record?.track_id || "(unknown)"}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_ongoing_list",
    description: "List current ongoing tracks for the current user. Use this to inspect active medium-horizon threads before updating or closing one.",
    shortHint: "List active ongoing tracks.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        statuses: { type: "array", items: { type: "string" } },
        limit: { type: "integer" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.listOngoingTracks({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Ongoing tracks: ${Number(result?.count) || 0}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_ongoing_read",
    description: "Read one specific ongoing track by track_id for the current user.",
    shortHint: "Read one ongoing track.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["track_id"],
      properties: {
        track_id: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.readOngoingTrack({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: result?.ok
          ? `Ongoing track loaded: ${result?.record?.track_id || args.track_id}`
          : `Ongoing track not found: ${args.track_id}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_ongoing_close",
    description: "Close one ongoing track by track_id and move its final state into archive. Use this when a medium-horizon thread has ended or no longer needs to stay hanging.",
    shortHint: "Close one ongoing track and archive its outcome.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["track_id"],
      properties: {
        track_id: { type: "string" },
        status: { type: "string" },
        closure_summary: { type: "string" },
        afterglow_notes: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.closeOngoingTrack({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: result?.ok
          ? `Ongoing track closed: ${result?.record?.track_id || args.track_id}`
          : `Ongoing track close failed: ${result?.error || args.track_id}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_episode_upsert",
    description: "Create or update a bounded episode journal: a trip, small task, photo-sharing session, or life event that should remain traceable and human-readable without becoming a permanent warm-memory fact. Use this before adding entries when the user is naturally sharing an event over time. If you later distill a warm-memory card from the same event, link it back with episode_refs.",
    shortHint: "Create or update an episode journal box.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        episode_id: { type: "string", description: "Stable id if continuing an existing episode, e.g. 2026-may-henan-trip." },
        title: { type: "string" },
        summary: { type: "string" },
        kind: { type: "string", description: "travel, life_event, project, photo_share, etc." },
        status: { type: "string", description: "active, settled, or archived." },
        time_range: {
          type: "object",
          properties: {
            start: { type: "string" },
            end: { type: "string" },
            label: { type: "string" },
          },
          additionalProperties: false,
        },
        tags: { type: "array", items: { type: "string" } },
        entities: { type: "array", items: { type: "string" } },
        topology_refs: episodeTopologyRefsSchema(),
        source_refs: { type: "array", items: { type: "string" } },
        related_track_ids: { type: "array", items: { type: "string" } },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.upsertEpisode({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Episode journal saved: ${result?.record?.episode_id || "(unknown)"}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_episode_append",
    description: "Append one timeline entry to an episode journal. Use this for travel/photo sharing, imported chat-tail summaries, day notes, milestones, reflections, or attachment evidence. When images arrive, include attachment refs to the saved file and paired note so the episode can later export to Markdown/Obsidian. If a stable warm card is updated from this episode, keep the cross-link in episode_refs.",
    shortHint: "Append an entry to an episode journal.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["episode_id", "text"],
      properties: {
        episode_id: { type: "string" },
        entry_type: { type: "string", description: "chat_tail, photo, day_note, milestone, reflection, import_summary, or artifact." },
        day_label: { type: "string", description: "Optional day/scene label such as Day 2 or 打铁花夜景." },
        happened_at_utc: { type: "string" },
        text: { type: "string" },
        mood: { type: "array", items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } },
        topology_refs: episodeTopologyRefsSchema(),
        source: { type: "string" },
        source_refs: { type: "array", items: { type: "string" } },
        attachment_refs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              note_path: { type: "string" },
              caption: { type: "string" },
              description: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.appendEpisodeEntry({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Episode entry appended: ${result?.entry?.entry_id || "(unknown)"}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_episode_list",
    description: "List or search episode journals for bounded trips, photo-sharing sessions, small tasks, or life events.",
    shortHint: "Search episode journals.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
        statuses: { type: "array", items: { type: "string" } },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.listEpisodes({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Episode journals: ${Number(result?.count) || 0}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_episode_read",
    description: "Read one episode journal with its timeline entries and attachment refs before continuing, correcting, or exporting it.",
    shortHint: "Read one episode journal.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["episode_id"],
      properties: {
        episode_id: { type: "string" },
        include_entries: { type: "boolean" },
        limit: { type: "integer" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.readEpisode({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: result?.ok
          ? `Episode journal loaded: ${result?.record?.episode_id || args.episode_id}`
          : `Episode journal not found: ${args.episode_id}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_case_upsert",
    description: "Create or update a quiet work-provenance case. Use this for real work artifacts or process memory: code fixes, imports, documents, debugging, architecture decisions, deployments, or Obsidian exports. Ordinary intimate chat and life episodes belong in notebook, ongoing, observation, or episode memory unless there is a concrete work product. Each case has a durable three-folder workspace: 01_original_request for human input, 02_working_versions for AI drafts/intermediates, and 03_user_approved_final only for files the user explicitly approves or sends back as final.",
    shortHint: "Create or update one work-provenance case.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        case_id: { type: "string" },
        title: { type: "string" },
        kind: { type: "string" },
        status: { type: "string" },
        summary: { type: "string" },
        user_goal: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        actions: { type: "array", items: caseActionSchema() },
        artifacts: { type: "array", items: caseArtifactSchema() },
        changed_files: { type: "array", items: { type: "string" } },
        tests: { type: "array", items: caseTestSchema() },
        decisions: { type: "array", items: caseDecisionSchema() },
        followups: { type: "array", items: caseFollowupSchema() },
        source_refs: { type: "array", items: { type: "string" } },
        related_episode_refs: { type: "array", items: { type: "string" } },
        related_track_ids: { type: "array", items: { type: "string" } },
        related_warm_refs: { type: "array", items: { type: "string" } },
        related_cold_refs: { type: "array", items: { type: "string" }, description: "Cold memory/tree refs that must preserve this case_id as case_refs when promoted or attached." },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.upsertCase({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Case saved: ${result?.record?.case_id || "(unknown)"}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_case_append",
    description: "Append one event to an existing work-provenance case: command run, file changed, test result, artifact linked, decision made, or follow-up discovered. This should update the case record without injecting it into casual conversation.",
    shortHint: "Append a work event to a case.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["case_id"],
      properties: {
        case_id: { type: "string" },
        event_type: { type: "string" },
        summary: { type: "string" },
        actor: { type: "string" },
        created_at: { type: "string" },
        actions: { type: "array", items: caseActionSchema() },
        artifacts: { type: "array", items: caseArtifactSchema() },
        changed_files: { type: "array", items: { type: "string" } },
        tests: { type: "array", items: caseTestSchema() },
        decisions: { type: "array", items: caseDecisionSchema() },
        followups: { type: "array", items: caseFollowupSchema() },
        source_refs: { type: "array", items: { type: "string" } },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.appendCaseEvent({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Case event appended: ${result?.event?.event_id || "(unknown)"}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_case_artifact",
    description: "Link one artifact to a work-provenance case, such as a file path, generated document, image folder, commit, diagnostic JSON, or exported Markdown note. Put drafts/intermediates under or link them as 02_working_versions when possible. Treat linked artifacts as scratch, working, or candidate unless the user explicitly names a human-approved final; cloud sync happens only through an explicit configured archive path.",
    shortHint: "Link an artifact to a case.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["case_id"],
      properties: {
        case_id: { type: "string" },
        title: { type: "string" },
        kind: { type: "string" },
        path: { type: "string" },
        note: { type: "string" },
        status: { type: "string", description: "scratch, working, candidate, user_approved_final, or discarded. Only use user_approved_final after explicit user confirmation." },
        artifact_id: { type: "string", description: "Stable local artifact id or human-readable storage number." },
        final_artifact_id: { type: "string", description: "Stable id for the human-approved final, if this artifact is the final." },
        storage_id: { type: "string", description: "Human-readable storage number returned to the user." },
        checksum: { type: "string" },
        size_bytes: { type: "integer" },
        approved_at: { type: "string" },
        manual_archive_ref: { type: "string", description: "Optional user-provided Notion, iMa, Obsidian, or drive reference after manual upload." },
        manual_archive_note: { type: "string" },
        source_refs: { type: "array", items: { type: "string" } },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.linkCaseArtifact({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Case artifact linked: ${result?.artifact?.title || result?.artifact?.path || "(unknown)"}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_case_search",
    description: "Search work-provenance cases. Use this when the user asks how something was fixed, where a project artifact is, what cases have been done, or when a current work task clearly continues an old case.",
    shortHint: "Search work-provenance cases.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        statuses: { type: "array", items: { type: "string" } },
        limit: { type: "integer" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.searchCases({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Cases found: ${Number(result?.count) || 0}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_case_read",
    description: "Read one exact work-provenance case with its events before continuing, correcting, closing, or exporting it.",
    shortHint: "Read one case.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["case_id"],
      properties: {
        case_id: { type: "string" },
        include_events: { type: "boolean" },
        limit: { type: "integer" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.readCase({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: result?.ok
          ? `Case loaded: ${result?.record?.case_id || args.case_id}`
          : `Case not found: ${args.case_id}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_case_close",
    description: "Close a work-provenance case when the goal is complete, paused, handed off, or no longer active. Closing keeps artifact status separate from final approval; when final output matters, ask the user to send or name the human-approved final, record its storage id, and clear 02_working_versions only after explicit cleanup confirmation.",
    shortHint: "Close one case.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["case_id"],
      properties: {
        case_id: { type: "string" },
        status: { type: "string" },
        closure_summary: { type: "string" },
        followups: { type: "array", items: caseFollowupSchema() },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.closeCase({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: result?.ok
          ? `Case closed: ${result?.record?.case_id || args.case_id}`
          : `Case close failed: ${result?.error || args.case_id}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_case_export",
    description: "Export or refresh the local Markdown version of one work-provenance case. This is the first Obsidian-compatible surface; runtime memory still reads the JSON store as source of truth. Export is not cloud sync and does not mark a final.",
    shortHint: "Refresh one case Markdown file.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["case_id"],
      properties: {
        case_id: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.exportCaseMarkdown({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: result?.ok
          ? `Case markdown exported: ${result.path}`
          : `Case markdown export failed: ${result?.error || args.case_id}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_observation_append",
    description: "Append a revisable user observation note. When you believe a soft pattern would help future continuity, write it proactively and silently during natural conversation. Use it for recent state, life rhythm, habits, boundaries, preferences, or interaction默契; observations are revisable notes rather than durable fact cards or front-stage wording rules.",
    shortHint: "Store a tentative observation that can be corrected later.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["observation"],
      properties: {
        observation: { type: "string", description: "The soft observation. Phrase it as revisable context instead of a fixed label." },
        kind: { type: "string", description: "life_rhythm, recent_state, habit, boundary, preference, work_style, relationship, or another broad kind." },
        status: { type: "string", description: "active or tentative; use rejected/stale/corrected only when revising." },
        confidence: { type: "number", description: "0-1 confidence. Prefer low/medium for inferred observations." },
        period: { type: "string", description: "Optional time range such as today, this week, or 2026-05." },
        observed_at_utc: { type: "string", description: "Optional observation timestamp." },
        evidence: { type: "array", items: { type: "string" }, description: "Short evidence snippets or references." },
        source_refs: { type: "array", items: { type: "string" }, description: "Optional source ids, note paths, or cache refs." },
        inference: { type: "string", description: "Optional separate inference. Keep uncertainty visible." },
        suggested_use: { type: "string", description: "Optional guidance for future replies or wakeups." },
        tags: { type: "array", items: { type: "string" } },
        entities: { type: "array", items: { type: "string" } },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.appendObservation({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Observation stored: ${result?.record?.observation_id || "(unknown)"}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_observation_search",
    description: "Search revisable user observation notes. Use this when current state, habits, boundaries, or life-rhythm默契 would help as soft, revisable context.",
    shortHint: "Search soft observation notes.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
        kinds: { type: "array", items: { type: "string" } },
        statuses: { type: "array", items: { type: "string" } },
        tags: { type: "array", items: { type: "string" } },
        includeInactive: { type: "boolean", description: "Include rejected/stale/corrected notes when auditing or correcting." },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.searchObservations({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Observation search returned ${Number(result?.count) || 0} hits.`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_observation_read",
    description: "Read one exact user observation note before correcting or rejecting it.",
    shortHint: "Read one observation note.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["observation_id"],
      properties: {
        observation_id: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.readObservation({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: result?.ok
          ? `Observation loaded: ${result?.record?.observation_id || args.observation_id}`
          : `Observation not found: ${args.observation_id}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_observation_update",
    description: "Correct, lower confidence, reject, or promote one exact user observation note. Use this immediately if the user says an observation is wrong, uncomfortable, or upsetting.",
    shortHint: "Correct or reject one observation note.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["observation_id"],
      properties: {
        observation_id: { type: "string" },
        observation: { type: "string" },
        kind: { type: "string" },
        status: { type: "string", description: "active, tentative, corrected, rejected, stale, or promoted." },
        confidence: { type: "number" },
        period: { type: "string" },
        evidence: { type: "array", items: { type: "string" } },
        source_refs: { type: "array", items: { type: "string" } },
        inference: { type: "string" },
        suggested_use: { type: "string" },
        correction_note: { type: "string", description: "Why the observation changed, especially if user corrected it." },
        tags: { type: "array", items: { type: "string" } },
        entities: { type: "array", items: { type: "string" } },
        promoted_to: { type: "array", items: { type: "string" } },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.updateObservation({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Observation updated: ${result?.record?.observation_id || args.observation_id}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_cold_versions",
    description: "List the current cold-memory versions for the bound user. Use this to inspect the active version before replacing it.",
    shortHint: "List cold-memory versions and the active label.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.listColdVersions({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Cold memory versions: ${Array.isArray(result?.versions) ? result.versions.length : 0} (active=${result?.active_version || "none"}).`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_cold_read",
    description: "Read the active or named cold-memory version payload for the current user. Use this to inspect the current cold layer before writing a replacement version.",
    shortHint: "Read the active cold-memory payload.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      properties: {
        version: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.readColdVersion({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: result?.ok
          ? `Cold memory loaded: ${result.version}`
          : `Cold memory unavailable: ${result?.error || "unknown error"}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_cold_search",
    description: "Search projected cold-memory roots for the current user. Use this before patching when the exact cold-memory root is still uncertain.",
    shortHint: "Search cold-memory roots before patching one.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
        version: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.searchColdRoots({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Cold memory root search returned ${Number(result?.hit_count) || 0} hits.`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_cold_duplicates",
    description: "Inspect likely duplicate projected cold-memory roots for the current user. This is read-only: use it to identify duplicate or conflicting cold cards, then read exact roots before patching or deleting one.",
    shortHint: "Find likely duplicate cold-memory roots.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional focus query, such as a person, symbol, fact key, or topic." },
        limit: { type: "integer", description: "Maximum duplicate clusters to return." },
        maxRows: { type: "integer", description: "Maximum projected roots to scan before clustering." },
        minScore: { type: "integer", description: "Similarity threshold from 50 to 100. Defaults to 78." },
        version: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.inspectColdRootDuplicates({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Cold memory duplicate scan returned ${Number(result?.duplicate_cluster_count) || 0} clusters.`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_cold_root_read",
    description: "Read one exact projected cold-memory root by root_key for the current user. Use this before patching when you need to confirm the current root contents.",
    shortHint: "Read one exact cold-memory root before patching it.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["root_key"],
      properties: {
        root_key: { type: "string" },
        version: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.readColdRoot({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: result?.ok
          ? `Cold memory root loaded: ${result.root_key}`
          : `Cold memory root not found: ${args.root_key}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_cold_patch",
    description: "Patch or delete one exact cold-memory root for the current user, then write the corrected payload back as a new active cold-memory version. Search or read the root first when the target is still uncertain.",
    shortHint: "Patch one exact cold-memory root and persist a new active version.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["root_key"],
      properties: {
        root_key: { type: "string" },
        mode: { type: "string", description: "merge, replace, or delete." },
        changes: { type: "object" },
        versionLabel: { type: "string" },
        assistantId: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      if (normalizeText(args.mode).toLowerCase() !== "delete" && (!args.changes || typeof args.changes !== "object" || Array.isArray(args.changes))) {
        throw new Error("mossbridge_memory_cold_patch input.changes is required unless input.mode is delete.");
      }
      const result = await services.asherieMemory.patchColdRoot({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: result?.deleted
          ? `Cold memory root deleted: ${result.previous_root_key || args.root_key}`
          : `Cold memory root patched: ${result.root_key || args.root_key}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_memory_cold_upsert",
    description: "Upsert a cold-memory version payload into the Mossbridge version bank for the current user. Inspect the active version first when you are correcting existing cold memory.",
    shortHint: "Write a versioned cold-memory payload after checking the active version when needed.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["payload"],
      properties: {
        payload: { type: "object" },
        assistantId: { type: "string" },
        versionLabel: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.asherieMemory.upsertColdVersion({
        ...args,
        userId: resolveBoundUserId(args, context),
      });
      return {
        text: `Cold memory version stored: ${result.version}`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_timeline_read",
    description: "Read the current timeline day data for a specific date. Use this before editing when the current day state is uncertain.",
    shortHint: "Read a timeline day before editing it.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      required: ["date"],
      properties: {
        date: { type: "string", description: "Target date in YYYY-MM-DD." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.read(args);
      const exists = !!result?.data?.exists;
      const eventCount = Number.isInteger(result?.data?.eventCount) ? result.data.eventCount : 0;
      return {
        text: `Timeline day ${args.date}: ${exists ? `${eventCount} events` : "missing"}.`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_timeline_categories",
    description: "List the current timeline taxonomy categories, subcategories, and event nodes. Use this before choosing category ids or event nodes.",
    shortHint: "Inspect the current timeline taxonomy before choosing category ids or event nodes.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async handler({ services }) {
      const result = await services.timeline.listCategories();
      const categoryCount = Number.isInteger(result?.data?.categoryCount) ? result.data.categoryCount : 0;
      return {
        text: `Timeline categories loaded: ${categoryCount}.`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_timeline_proposals",
    description: "List proposed timeline event nodes, optionally filtered by date. Use this when deciding whether a new event node is actually needed.",
    shortHint: "Inspect proposed timeline event nodes before introducing new taxonomy.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Optional date in YYYY-MM-DD." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.listProposals(args);
      const proposalCount = Number.isInteger(result?.data?.proposalCount) ? result.data.proposalCount : 0;
      return {
        text: `Timeline proposals loaded: ${proposalCount}.`,
        data: result,
      };
    },
  },
  {
    name: "mossbridge_timeline_write",
    description: "Write timeline events through timeline-for-agent. Inspect the current day and taxonomy first when category ids, event nodes, or existing events are uncertain.",
    shortHint: "Write timeline events after checking the current day and taxonomy when needed.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      required: ["date", "events"],
      properties: {
        date: { type: "string", description: "Target date in YYYY-MM-DD." },
        events: {
          type: "array",
          description: "Timeline events for the target date.",
          items: {
            type: "object",
            required: ["startAt", "endAt"],
            properties: {
              id: { type: "string" },
              startAt: { type: "string", description: "ISO datetime within the target date." },
              endAt: { type: "string", description: "ISO datetime within the target date." },
              title: { type: "string", description: "Event title. Required unless eventNodeId resolves a taxonomy label." },
              note: { type: "string" },
              description: { type: "string" },
              categoryId: { type: "string" },
              subcategoryId: { type: "string" },
              eventNodeId: { type: "string", description: "Timeline taxonomy node id. Use this or provide a title." },
              tags: {
                type: "array",
                items: { type: "string" },
              },
            },
            additionalProperties: true,
          },
        },
        locale: { type: "string", description: "Optional timeline locale." },
        mode: { type: "string", description: "Optional write mode, usually merge." },
        finalize: { type: "boolean", description: "Whether to finalize the day after writing." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      validateTimelineWriteArgs(args);
      const result = await services.timeline.write(args);
      return {
        text: "Timeline write completed.",
        data: result,
      };
    },
  },
  {
    name: "mossbridge_timeline_build",
    description: "Build the timeline site through timeline-for-agent.",
    shortHint: "Build the timeline site, optionally with locale.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.build(args);
      return {
        text: "Timeline build completed.",
        data: result,
      };
    },
  },
  {
    name: "mossbridge_timeline_serve",
    description: "Start the timeline static server through timeline-for-agent.",
    shortHint: "Serve the timeline site, optionally with locale.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.serve(args);
      return {
        text: result.url ? `Timeline serve started at ${result.url}` : "Timeline serve completed.",
        data: result,
      };
    },
  },
  {
    name: "mossbridge_timeline_dev",
    description: "Start the timeline dev server through timeline-for-agent.",
    shortHint: "Start the timeline dev server, optionally with locale.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        locale: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.timeline.dev(args);
      return {
        text: result.url ? `Timeline dev started at ${result.url}` : "Timeline dev completed.",
        data: result,
      };
    },
  },
  {
    name: "mossbridge_timeline_screenshot",
    description: "Capture a timeline screenshot and send it back to the current WeChat chat.",
    shortHint: "Capture a timeline screenshot with structured selection fields.",
    topics: ["timeline"],
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "Optional explicit WeChat user id." },
        outputFile: { type: "string", description: "Optional absolute output path for the PNG file." },
        selector: { type: "string", description: "main, timeline, analytics, events, or a custom CSS selector." },
        range: { type: "string", description: "Optional range: day, week, or month." },
        date: { type: "string", description: "Optional day selector YYYY-MM-DD." },
        week: { type: "string", description: "Optional week key." },
        month: { type: "string", description: "Optional month selector YYYY-MM." },
        category: { type: "string", description: "Optional category label or id." },
        subcategory: { type: "string", description: "Optional subcategory label or id." },
        width: { type: "integer", description: "Optional viewport width in pixels." },
        height: { type: "integer", description: "Optional viewport height in pixels." },
        sidePadding: { type: "integer", description: "Optional screenshot padding in pixels." },
        locale: { type: "string", description: "Optional timeline locale." },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const captured = await services.timeline.captureScreenshot(args);
      const delivery = await services.channelFile.sendToCurrentChat({
        userId: args.userId,
        filePath: captured.outputFile,
      }, context);
      return {
        text: `Timeline screenshot sent: ${captured.outputFile}`,
        data: {
          ...captured,
          delivery,
        },
      };
    },
  },
];

async function readMemoryMutationBefore(services = {}, toolName = "", args = {}, context = {}) {
  const memory = services.asherieMemory;
  if (!memory) {
    return null;
  }
  try {
    if (toolName === "mossbridge_memory_warm_update" || toolName === "mossbridge_memory_warm_delete") {
      return await memory.readWarmMaterial({
        material_id: args.material_id,
        userId: resolveBoundUserId(args, context),
      });
    }
    if (toolName === "mossbridge_memory_ongoing_upsert" || toolName === "mossbridge_memory_ongoing_close") {
      const trackId = normalizeText(args.track_id || args.trackId);
      if (!trackId) return null;
      return await memory.readOngoingTrack({
        track_id: trackId,
        userId: resolveBoundUserId(args, context),
      });
    }
    if (toolName === "mossbridge_memory_episode_upsert" || toolName === "mossbridge_memory_episode_append") {
      const episodeId = normalizeText(args.episode_id || args.episodeId);
      if (!episodeId) return null;
      return await memory.readEpisode({
        episode_id: episodeId,
        include_entries: true,
        userId: resolveBoundUserId(args, context),
      });
    }
    if (toolName.startsWith("mossbridge_memory_case_")) {
      const caseId = normalizeText(args.case_id || args.caseId);
      if (!caseId) return null;
      return await memory.readCase({
        case_id: caseId,
        include_events: true,
        userId: resolveBoundUserId(args, context),
      });
    }
    if (toolName === "mossbridge_memory_observation_update") {
      return await memory.readObservation({
        observation_id: args.observation_id,
        userId: resolveBoundUserId(args, context),
      });
    }
    if (toolName === "mossbridge_memory_cold_patch") {
      return await memory.readColdRoot({
        root_key: args.root_key,
        version: args.version,
        userId: resolveBoundUserId(args, context),
      });
    }
  } catch {
    return null;
  }
  return null;
}

function buildMemoryMutationDescriptor(toolName = "", args = {}, result = {}) {
  const data = result?.data && typeof result.data === "object" ? result.data : {};
  const record = data.record && typeof data.record === "object" ? data.record : {};
  const entry = data.entry && typeof data.entry === "object" ? data.entry : {};
  const event = data.event && typeof data.event === "object" ? data.event : {};
  const artifact = data.artifact && typeof data.artifact === "object" ? data.artifact : {};
  if (toolName === "mossbridge_diary_append") {
    return buildMutation("notebook", "append", data.filePath, data, args.title || "Notebook entry appended");
  }
  if (toolName === "mossbridge_memory_warm_write") {
    return buildMutation("warm_memory", "write", record.material_id, record, record.title);
  }
  if (toolName === "mossbridge_memory_warm_update") {
    return buildMutation("warm_memory", "update", record.material_id || args.material_id, record, record.title);
  }
  if (toolName === "mossbridge_memory_warm_delete") {
    return buildMutation("warm_memory", "delete", data.deleted_material_id || data.material_id || args.material_id, data, data.error || "Warm memory deleted");
  }
  if (toolName === "mossbridge_memory_ongoing_upsert") {
    return buildMutation("ongoing_track", "upsert", record.track_id || args.track_id, record, record.title);
  }
  if (toolName === "mossbridge_memory_ongoing_close") {
    return buildMutation("ongoing_track", "close", record.track_id || data.track_id || args.track_id, record || data, record.title || args.closure_summary);
  }
  if (toolName === "mossbridge_memory_episode_upsert") {
    return buildMutation("episode_journal", "upsert", record.episode_id || args.episode_id, record, record.title);
  }
  if (toolName === "mossbridge_memory_episode_append") {
    return buildMutation("episode_journal", "append", data.episode_id || args.episode_id, { record, entry }, entry.summary || entry.text || args.text);
  }
  if (toolName === "mossbridge_memory_case_upsert") {
    return buildMutation("case_index", "upsert", record.case_id || args.case_id, record, record.title);
  }
  if (toolName === "mossbridge_memory_case_append") {
    return buildMutation("case_index", "append", data.case_id || args.case_id, { record, event }, event.summary || args.summary);
  }
  if (toolName === "mossbridge_memory_case_artifact") {
    return buildMutation("case_index", "link_artifact", data.case_id || args.case_id, { record, artifact }, artifact.title || artifact.path || args.title);
  }
  if (toolName === "mossbridge_memory_case_close") {
    return buildMutation("case_index", "close", record.case_id || data.case_id || args.case_id, record || data, record.title || args.closure_summary);
  }
  if (toolName === "mossbridge_memory_observation_append") {
    return buildMutation("observation_journal", "append", record.observation_id || data.observation_id, record || data, record.observation || args.observation);
  }
  if (toolName === "mossbridge_memory_observation_update") {
    return buildMutation("observation_journal", "update", record.observation_id || data.observation_id || args.observation_id, record || data, record.observation || args.observation || args.correction_note);
  }
  if (toolName === "mossbridge_memory_cold_patch") {
    return buildMutation("cold_root", normalizeText(args.mode) || "patch", data.root_key || data.previous_root_key || args.root_key, data, data.root_key || args.root_key);
  }
  if (toolName === "mossbridge_memory_cold_upsert") {
    return buildMutation("cold_version", "upsert", data.version, data, `Cold version ${data.version || ""}`.trim());
  }
  if (toolName === "mossbridge_solitude_journal_write") {
    return buildMutation("solitude_journal", "append", record.solitude_id || data.solitude_id, record || data, record.summary || args.summary);
  }
  return {};
}

function buildMutation(target, action, objectId, after, summary = "") {
  return {
    target: normalizeText(target),
    action: normalizeText(action),
    object_id: normalizeText(objectId),
    after,
    summary: normalizeText(summary),
  };
}

function isToolResultFailure(result = {}) {
  const data = result?.data;
  if (data && typeof data === "object" && data.ok === false) {
    return true;
  }
  return Boolean(result?.isError);
}

function buildNotebookEventTimestamp(data = {}) {
  const date = normalizeText(data.date);
  const time = normalizeText(data.time);
  if (date && time) {
    return `${date}T${time}:00+08:00`;
  }
  return new Date().toISOString();
}

const TOOL_VOICE_BOUNDARY = "Operational only; front-stage voice, style, and length still come from the current conversation.";

const FOREGROUND_TOOL_NAMES = new Set([
  "mossbridge_diary_append",
  "mossbridge_reminder_create",
  "mossbridge_reminder_list",
  "mossbridge_reminder_cancel",
  "mossbridge_channel_send_file",
  "mossbridge_sticker_tags",
  "mossbridge_sticker_search",
  "mossbridge_sticker_pick",
  "mossbridge_sticker_list",
  "mossbridge_sticker_send",
  "mossbridge_sticker_save_from_inbox",
  "mossbridge_memory_context_packet",
  "mossbridge_memory_warm_write",
  "mossbridge_memory_warm_search",
  "mossbridge_memory_warm_read",
  "mossbridge_memory_warm_list",
  "mossbridge_memory_warm_update",
  "mossbridge_memory_warm_delete",
  "mossbridge_memory_ongoing_upsert",
  "mossbridge_memory_ongoing_list",
  "mossbridge_memory_ongoing_read",
  "mossbridge_memory_ongoing_close",
  "mossbridge_memory_episode_upsert",
  "mossbridge_memory_episode_append",
  "mossbridge_memory_episode_list",
  "mossbridge_memory_episode_read",
  "mossbridge_memory_observation_append",
  "mossbridge_memory_observation_search",
  "mossbridge_memory_observation_read",
  "mossbridge_memory_observation_update",
  "mossbridge_memory_cold_search",
  "mossbridge_memory_cold_duplicates",
  "mossbridge_memory_cold_root_read",
  "mossbridge_memory_cold_patch",
  "mossbridge_wakeup_agenda_read",
]);

const TASK_TOOL_NAMES = new Set([
  ...FOREGROUND_TOOL_NAMES,
  "mossbridge_memory_case_upsert",
  "mossbridge_memory_case_append",
  "mossbridge_memory_case_artifact",
  "mossbridge_memory_case_search",
  "mossbridge_memory_case_read",
  "mossbridge_memory_case_close",
  "mossbridge_memory_case_export",
]);

function filterToolsByProfile(tools = [], toolProfile = "") {
  const normalizedToolProfile = normalizeToolProfile(toolProfile);
  return (Array.isArray(tools) ? tools : []).filter((tool) =>
    isToolAllowedInProfile(tool?.name, normalizedToolProfile)
  );
}

function isToolAllowedInProfile(toolName = "", toolProfile = "") {
  const name = normalizeText(toolName);
  const normalizedToolProfile = normalizeToolProfile(toolProfile);
  if (!name) {
    return false;
  }
  if (normalizedToolProfile === TOOL_PROFILE_CHECKIN_LITE) {
    return false;
  }
  if (normalizedToolProfile === TOOL_PROFILE_FOREGROUND) {
    return FOREGROUND_TOOL_NAMES.has(name);
  }
  if (normalizedToolProfile === TOOL_PROFILE_TASK) {
    return TASK_TOOL_NAMES.has(name);
  }
  return true;
}

function normalizeToolProfile(value = "") {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === TOOL_PROFILE_CHECKIN_LITE) {
    return TOOL_PROFILE_CHECKIN_LITE;
  }
  if (normalized === TOOL_PROFILE_FOREGROUND || normalized === "frontstage" || normalized === "daily") {
    return TOOL_PROFILE_FOREGROUND;
  }
  if (normalized === TOOL_PROFILE_TASK || normalized === "case") {
    return TOOL_PROFILE_TASK;
  }
  if (normalized === "maintenance" || normalized === "dreaming") {
    return TOOL_PROFILE_FULL;
  }
  return TOOL_PROFILE_FULL;
}

const STATIC_EXTRA_TOOL_NAMES = new WhereaboutsToolHost({ service: null })
  .listTools()
  .map((tool) => tool.name);

function createExtraToolHosts(services = {}) {
  const hosts = [];
  if (services.whereabouts) {
    hosts.push(new WhereaboutsToolHost({ service: services.whereabouts }));
  }
  return hosts;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeText).filter(Boolean);
  }
  const normalized = normalizeText(value);
  return normalized ? [normalized] : [];
}

function buildBridgeStatusSnapshot(
  services = {},
  args = {},
  context = {},
  {
    label = "Bridge",
    defaultMaintenanceProfile = "safe_self_check",
    defaultSelfRepairAllowed = false,
  } = {}
) {
  const config = services.config || {};
  const includeQueues = args.includeQueues !== false;
  const includeReminders = args.includeReminders !== false;
  const includeRuntime = args.includeRuntime !== false;
  const includeChannel = args.includeChannel !== false;
  const includeControl = args.includeControl !== false;
  const runtimeId = normalizeText(context.runtimeId) || normalizeText(config.runtime) || "runtime";
  const nowMs = Date.now();
  const snapshot = {
    ok: true,
    label,
    checked_at: new Date(nowMs).toISOString(),
    runtime_id: runtimeId,
    workspace_root: normalizeText(context.workspaceRoot),
  };

  if (includeQueues) {
    const systemQueue = readJsonFile(config.systemMessageQueueFile);
    const deferredReplies = readJsonFile(config.deferredSystemReplyQueueFile);
    snapshot.queues = {
      system_pending: countArrayPayload(systemQueue, "messages"),
      deferred_replies: countArrayPayload(deferredReplies, "replies"),
    };
  }

  if (includeReminders) {
    snapshot.reminders = readReminderStatus(services, context);
  }

  if (includeRuntime) {
    const cooldownPayload = readJsonFile(config.runtimeCooldownFile);
    const usagePayload = readJsonFile(config.runtimeContextUsageFile);
    const activeCooldowns = listActiveCooldowns(cooldownPayload, nowMs);
    const contextSnapshot = resolveLatestRuntimeContext(usagePayload, runtimeId);
    const currentTokens = readNonNegativeNumber(contextSnapshot?.currentTokens);
    const configuredWindow = readNonNegativeNumber(config.claudeContextWindow);
    const contextWindow = readNonNegativeNumber(contextSnapshot?.contextWindow) || configuredWindow;
    const dailyCheckinBudget = buildDailyCheckinBudgetStatus({
      config,
      usagePayload,
      runtimeId,
      nowMs,
    });
    snapshot.runtime = {
      active_cooldown_count: activeCooldowns.length,
      active_cooldowns: activeCooldowns.slice(0, 3).map((record) => ({
        runtime_id: normalizeText(record.runtimeId),
        reason: normalizeText(record.reason),
        reset_at: normalizeText(record.resetAt),
        remaining_minutes: Math.max(0, Math.ceil((Number(record.resetAtMs || Date.parse(record.resetAt)) - nowMs) / 60_000)),
      })),
      context: {
        thread_id: normalizeText(contextSnapshot?.threadId),
        current_tokens: currentTokens,
        context_window: contextWindow,
        usage_ratio: contextWindow > 0 ? Number((currentTokens / contextWindow).toFixed(3)) : null,
        updated_at: normalizeText(contextSnapshot?.updatedAt),
      },
      auto_compact_events: Array.isArray(usagePayload?.autoCompactEvents)
        ? usagePayload.autoCompactEvents.length
        : 0,
      daily_checkin_budget: dailyCheckinBudget,
    };
  }

  if (includeChannel) {
    snapshot.channel = {
      last_sticker_delivery: buildStickerDeliveryStatus(config, nowMs),
    };
  }

  if (includeControl) {
    snapshot.control = readControlStatus(config.controlLedgerFile);
  }

  snapshot.maintenance = buildBridgeMaintenancePolicy(config, {
    defaultMaintenanceProfile,
    defaultSelfRepairAllowed,
  });
  snapshot.recommendations = buildBridgeStatusRecommendations(snapshot);

  return snapshot;
}

function buildBridgeMaintenancePolicy(config = {}, {
  defaultMaintenanceProfile = "safe_self_check",
  defaultSelfRepairAllowed = false,
} = {}) {
  const profile = normalizeText(config.maintenanceProfile) || defaultMaintenanceProfile;
  const selfRepairAllowed = typeof config.maintenanceAllowSelfRepair === "boolean"
    ? config.maintenanceAllowSelfRepair
    : Boolean(defaultSelfRepairAllowed);
  const sharedActions = [
    "read bridge status, queues, reminders, runtime cooldowns, and context pressure",
    "avoid proactive sends during active cooldowns or severe context pressure",
    "keep operational diagnostics out of memory, dreaming, and ordinary conversation capture",
  ];
  const selfRepairActions = [
    "retry already-deferred delivery when the saved channel token is usable",
    "use existing media fallbacks such as static PNG sticker previews before retrying original formats",
    "delay or skip heartbeat checkins when runtime token pressure is high",
    "let the configured supervisor restart crashed bridge/runtime child processes",
  ];
  const reportOnlyActions = [
    "report degraded status with a short non-memory diagnostic",
    "ask the human or supervising Codex session before restarting services, rebinding accounts, or changing files",
  ];
  return {
    profile,
    self_repair_allowed: selfRepairAllowed,
    action_level: selfRepairAllowed ? "safe_repair" : "read_only_report",
    allowed_auto_actions: selfRepairAllowed
      ? [...sharedActions, ...selfRepairActions]
      : [...sharedActions, ...reportOnlyActions],
    report_required_for: [
      "login, auth, QR binding, or context-token expiry that cannot be refreshed safely",
      "repeated runtime 400/timeout/prompt-too-long failures after backoff",
      "memory, queue, or storage paths becoming unreadable or unwritable",
      "any code change, destructive cleanup, account switch, or credential operation",
    ],
    never_auto_actions: [
      "edit production code",
      "delete or rewrite memory stores",
      "clear user data or test data",
      "rebind WeChat accounts",
      "send externally visible messages to a new channel without explicit intent",
    ],
    diagnostic_memory_policy: "Failure reports, quota notices, and maintenance chatter stay in diagnostics rather than memory, dreaming input, or durable user-observation stores.",
  };
}

function buildBridgeStatusRecommendations(snapshot = {}) {
  const recommendations = [];
  const policy = snapshot.maintenance || {};
  const queue = snapshot.queues || {};
  const runtime = snapshot.runtime || {};
  const context = runtime.context || {};
  const dailyBudget = runtime.daily_checkin_budget || {};
  const canRepair = Boolean(policy.self_repair_allowed);

  if ((queue.deferred_replies || 0) > 0) {
    recommendations.push({
      level: "yellow",
      code: "deferred_replies_pending",
      action: canRepair ? "retry_or_hold_deferred_delivery" : "report_deferred_delivery_pending",
      message: canRepair
        ? "Deferred replies are pending; retry only through the existing safe delivery path, otherwise report briefly."
        : "Deferred replies are pending; in public mode, report or ask Codex/human to inspect instead of self-repairing.",
    });
  }
  if ((runtime.active_cooldown_count || 0) > 0) {
    recommendations.push({
      level: "yellow",
      code: "runtime_cooldown_active",
      action: "skip_nonessential_proactive_send",
      message: "Runtime cooldown is active; skip nonessential heartbeat speech and avoid adding pressure.",
    });
  }
  if (dailyBudget.exceeded) {
    recommendations.push({
      level: "yellow",
      code: "daily_checkin_budget_exceeded",
      action: "hold_checkins_defer_dreaming_keep_due_reminders_compact",
      message: "Daily background budget is exhausted; random wakeups should stop until the next local day, dreaming should retry later, and due reminders may proceed with compact context.",
    });
  } else if (dailyBudget.near_limit) {
    recommendations.push({
      level: "yellow",
      code: "daily_checkin_budget_near_limit",
      action: "avoid_extra_background_turns",
      message: "Daily heartbeat budget is near its limit; prefer quiet read-only maintenance over extra proactive turns.",
    });
  }
  if (typeof context.usage_ratio === "number" && context.usage_ratio >= 0.85) {
    recommendations.push({
      level: "yellow",
      code: "context_pressure_high",
      action: "avoid_new_runtime_turn",
      message: "Context pressure is high; prefer quiet maintenance, compaction, or a short diagnostic over a long proactive turn.",
    });
  }
  if ((snapshot.control?.recent_warning_count || 0) > 0) {
    recommendations.push({
      level: "yellow",
      code: "control_warnings_recent",
      action: "inspect_control_ledger",
      message: "Recent control-plane warnings exist; inspect the bridge ledger before adding proactive pressure.",
    });
  }
  if (!recommendations.length) {
    recommendations.push({
      level: "green",
      code: "no_immediate_action",
      action: "silent_ok",
      message: "No immediate bridge maintenance action is required; silence is acceptable if there is no conversational reason to appear.",
    });
  }
  return recommendations;
}

function readReminderStatus(services = {}, context = {}) {
  try {
    const reminders = typeof services.reminder?.list === "function"
      ? services.reminder.list({}, context)
      : [];
    const normalizedReminders = Array.isArray(reminders) ? reminders : [];
    const sorted = normalizedReminders
      .slice()
      .sort((left, right) => (Date.parse(left?.dueAt || "") || 0) - (Date.parse(right?.dueAt || "") || 0));
    return {
      pending_count: normalizedReminders.length,
      next_due_at: normalizeText(sorted[0]?.dueAt),
      preview: sorted.slice(0, 3).map((reminder) => ({
        id: normalizeText(reminder.id),
        due_at: normalizeText(reminder.dueAt),
        text: normalizeText(reminder.text).slice(0, 120),
      })),
    };
  } catch (error) {
    return {
      pending_count: 0,
      error: normalizeText(error?.message) || "reminder list failed",
    };
  }
}

function buildStickerDeliveryStatus(config = {}, nowMs = Date.now()) {
  const audit = readJsonFile(config.stickerDeliveryAuditFile);
  const last = audit?.lastDelivery && typeof audit.lastDelivery === "object" ? audit.lastDelivery : null;
  if (!last) {
    return { state: "none" };
  }
  const tsMs = parseStatusTimestampMs(last.ts);
  const ageSeconds = tsMs ? Math.round(Math.max(0, nowMs - tsMs) / 1000) : null;
  const status = normalizeText(last.status);
  const channelKind = normalizeText(last.channelDeliveryKind);
  const fallbackFrom = normalizeText(last.fallbackFrom);
  const state = status === "failed"
    ? "failed"
    : (channelKind === "file" && fallbackFrom ? "degraded" : (status || "unknown"));
  return {
    state,
    ts: normalizeText(last.ts),
    age_seconds: ageSeconds,
    sticker_id: normalizeText(last.stickerId),
    source: normalizeText(last.sourceFileName),
    source_mime: normalizeText(last.sourceMimeType),
    source_actual_mime: normalizeText(last.sourceActualMimeType),
    delivery: normalizeText(last.deliveryFileName),
    delivery_mime: normalizeText(last.deliveryMimeType),
    delivery_actual_mime: normalizeText(last.deliveryActualMimeType),
    transform: normalizeText(last.deliveryTransform),
    channel_kind: channelKind,
    fallback_from: fallbackFrom,
    fallback_reason: normalizeText(last.fallbackReason).slice(0, 240),
    error: normalizeText(last.error).slice(0, 240),
  };
}

function formatBridgeStatusSnapshot(snapshot = {}) {
  const queue = snapshot.queues || {};
  const reminders = snapshot.reminders || {};
  const channel = snapshot.channel || {};
  const runtime = snapshot.runtime || {};
  const control = snapshot.control || {};
  const context = runtime.context || {};
  const dailyBudget = runtime.daily_checkin_budget || {};
  const usageText = context.context_window > 0
    ? `${context.current_tokens}/${context.context_window} (${Math.round((context.usage_ratio || 0) * 100)}%)`
    : "unknown";
  const budgetText = dailyBudget.disabled
    ? "disabled"
    : `${dailyBudget.weighted_tokens ?? 0}/${dailyBudget.token_budget ?? 0} weighted, ${dailyBudget.thread_count ?? 0}/${dailyBudget.thread_budget ?? 0} threads`;
  const lines = [
    `${snapshot.label || "Bridge"} status: systemQueue=${queue.system_pending ?? "n/a"} deferredReplies=${queue.deferred_replies ?? "n/a"} reminders=${reminders.pending_count ?? "n/a"} runtime=${snapshot.runtime_id || "runtime"} context=${usageText} checkinBudget=${budgetText} cooldowns=${runtime.active_cooldown_count ?? "n/a"} controlEvents=${control.sample_size ?? "n/a"} policy=${snapshot.maintenance?.action_level || "read_only_report"}`,
  ];
  const recommendation = Array.isArray(snapshot.recommendations) ? snapshot.recommendations[0] : null;
  if (recommendation?.message) {
    lines.push(`Recommendation: ${recommendation.level || "info"} ${recommendation.message}`);
  }
  if (reminders.next_due_at) {
    lines.push(`Next reminder: ${reminders.next_due_at}`);
  }
  if (runtime.active_cooldown_count > 0) {
    const cooldown = runtime.active_cooldowns?.[0] || {};
    lines.push(`Active cooldown: ${cooldown.reason || "unknown"} until ${cooldown.reset_at || "unknown"}`);
  }
  if ((control.recent_warning_count || 0) > 0) {
    const recent = Array.isArray(control.recent) ? control.recent.find((event) => event.severity === "error" || event.severity === "warn") : null;
    if (recent) {
      lines.push(`Recent control warning: ${recent.type || "control.event"} ${recent.reason || ""}`.trim());
    }
  }
  const sticker = channel.last_sticker_delivery || {};
  if (sticker.state && sticker.state !== "none") {
    const fallbackText = sticker.fallback_from
      ? ` fallback=${sticker.fallback_from}->${sticker.channel_kind || "unknown"}`
      : "";
    const sourceMime = sticker.source_actual_mime || sticker.source_mime || "unknown";
    const deliveryMime = sticker.delivery_actual_mime || sticker.delivery_mime || "unknown";
    lines.push(`Last sticker: ${sticker.state} ${sticker.sticker_id || "unknown"} ${sourceMime} -> ${deliveryMime} via ${sticker.transform || "none"} channel=${sticker.channel_kind || "unknown"}${fallbackText}`);
  }
  return lines.join("\n");
}

function buildDailyCheckinBudgetStatus({
  config = {},
  usagePayload = {},
  runtimeId = "",
  nowMs = Date.now(),
} = {}) {
  const resolvedRuntimeId = normalizeText(runtimeId) || normalizeText(config.runtime) || "codex";
  const budget = resolveCheckinDailyBudget({
    config: {
      ...config,
      runtime: resolvedRuntimeId,
    },
    runtimeContextUsageStore: {
      load() {},
      snapshot() {
        return usagePayload && typeof usagePayload === "object" ? usagePayload : {};
      },
    },
    nowMs,
  });
  const tokenUsageRatio = budget.tokenBudget > 0
    ? roundStatusNumber((Number(budget.budgetTokens) || 0) / budget.tokenBudget)
    : null;
  const threadUsageRatio = budget.threadBudget > 0
    ? roundStatusNumber((Number(budget.threadCount) || 0) / budget.threadBudget)
    : null;
  const nearLimit = !budget.exceeded && (
    (typeof tokenUsageRatio === "number" && tokenUsageRatio >= 0.8)
    || (typeof threadUsageRatio === "number" && threadUsageRatio >= 0.8)
  );
  return {
    disabled: Boolean(budget.disabled),
    day: normalizeText(budget.day),
    runtime_id: normalizeText(budget.runtimeId) || resolvedRuntimeId,
    current_tokens: Number(budget.currentTokens) || 0,
    weighted_tokens: Number(budget.budgetTokens) || 0,
    token_budget: Number(budget.tokenBudget) || 0,
    token_usage_ratio: tokenUsageRatio,
    token_exceeded: Boolean(budget.tokenExceeded),
    thread_count: Number(budget.threadCount) || 0,
    thread_budget: Number(budget.threadBudget) || 0,
    thread_usage_ratio: threadUsageRatio,
    thread_exceeded: Boolean(budget.threadExceeded),
    near_limit: Boolean(nearLimit),
    exceeded: Boolean(budget.exceeded),
  };
}

function readControlStatus(filePath) {
  const normalizedPath = normalizeText(filePath);
  if (!normalizedPath) {
    return {
      available: false,
      sample_size: 0,
      recent_warning_count: 0,
      recent: [],
    };
  }
  try {
    const store = new ControlLedgerStore({ filePath: normalizedPath });
    const summary = store.summarize({ limit: 50 });
    const recent = Array.isArray(summary.recent) ? summary.recent.slice(-5).map((event) => ({
      type: normalizeText(event.type),
      scope: normalizeText(event.scope),
      layer: normalizeText(event.layer),
      severity: normalizeText(event.severity),
      reason: normalizeText(event.reason),
      outcome: normalizeText(event.outcome),
      observed_at: normalizeText(event.observedAt),
    })) : [];
    return {
      available: true,
      sample_size: Number(summary.sampleSize) || 0,
      by_scope: summary.byScope || {},
      by_severity: summary.bySeverity || {},
      recent_warning_count: recent.filter((event) => event.severity === "warn" || event.severity === "error").length,
      recent,
    };
  } catch (error) {
    return {
      available: false,
      sample_size: 0,
      recent_warning_count: 0,
      recent: [],
      error: normalizeText(error?.message) || "control ledger unreadable",
    };
  }
}

function readJsonFile(filePath) {
  const normalizedPath = normalizeText(filePath);
  if (!normalizedPath) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(normalizedPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function countArrayPayload(payload, key) {
  const value = payload && typeof payload === "object" ? payload[key] : null;
  return Array.isArray(value) ? value.length : 0;
}

function listActiveCooldowns(payload, nowMs = Date.now()) {
  const cooldowns = payload?.cooldowns && typeof payload.cooldowns === "object" && !Array.isArray(payload.cooldowns)
    ? payload.cooldowns
    : {};
  return Object.values(cooldowns).filter((record) => {
    const resetAtMs = Number(record?.resetAtMs || Date.parse(record?.resetAt || ""));
    return Number.isFinite(resetAtMs) && resetAtMs > nowMs;
  });
}

function resolveLatestRuntimeContext(payload, runtimeId = "") {
  const contextsByRuntime = payload?.latestContextByRuntimeId
    && typeof payload.latestContextByRuntimeId === "object"
    && !Array.isArray(payload.latestContextByRuntimeId)
    ? payload.latestContextByRuntimeId
    : {};
  const normalizedRuntimeId = normalizeText(runtimeId);
  if (normalizedRuntimeId && contextsByRuntime[normalizedRuntimeId]) {
    return contextsByRuntime[normalizedRuntimeId];
  }
  const contexts = Object.values(contextsByRuntime);
  return contexts
    .slice()
    .sort((left, right) => (Date.parse(right?.updatedAt || "") || 0) - (Date.parse(left?.updatedAt || "") || 0))[0] || {};
}

function readNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function parseStatusTimestampMs(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundStatusNumber(value, digits = 3) {
  const scale = 10 ** Math.max(0, Number(digits) || 0);
  return Math.round((Number(value) || 0) * scale) / scale;
}

function resolveBoundUserId(args = {}, context = {}) {
  return normalizeText(args.userId) || normalizeText(context.senderId);
}

function episodeTopologyRefsSchema() {
  const stringArray = { type: "array", items: { type: "string" } };
  return {
    type: "object",
    description: "Optional typed refs for cold-topology candidates. Include facts only when the person/place/activity/object/case is explicit or highly grounded.",
    properties: {
      people: stringArray,
      places: stringArray,
      activities: stringArray,
      objects: stringArray,
      themes: stringArray,
      relationship_roots: stringArray,
      cold_roots: stringArray,
      warm_refs: stringArray,
      case_refs: stringArray,
    },
    additionalProperties: false,
  };
}

function caseActionSchema() {
  return {
    type: "object",
    properties: {
      summary: { type: "string" },
      kind: { type: "string" },
      at: { type: "string" },
    },
    additionalProperties: false,
  };
}

function caseArtifactSchema() {
  return {
    type: "object",
    properties: {
      title: { type: "string" },
      kind: { type: "string" },
      path: { type: "string" },
      note: { type: "string" },
      status: { type: "string", description: "scratch, working, candidate, user_approved_final, or discarded. Only use user_approved_final after explicit user confirmation." },
      artifact_id: { type: "string", description: "Stable local artifact id or human-readable storage number." },
      final_artifact_id: { type: "string", description: "Stable id for the human-approved final, if this artifact is the final." },
      storage_id: { type: "string", description: "Human-readable storage number returned to the user." },
      checksum: { type: "string" },
      size_bytes: { type: "integer" },
      approved_at: { type: "string" },
      manual_archive_ref: { type: "string", description: "Optional user-provided Notion, iMa, Obsidian, or drive reference after manual upload." },
      manual_archive_note: { type: "string" },
    },
    additionalProperties: false,
  };
}

function caseTestSchema() {
  return {
    type: "object",
    properties: {
      command: { type: "string" },
      status: { type: "string" },
      note: { type: "string" },
    },
    additionalProperties: false,
  };
}

function caseDecisionSchema() {
  return {
    type: "object",
    properties: {
      summary: { type: "string" },
      reason: { type: "string" },
      at: { type: "string" },
    },
    additionalProperties: false,
  };
}

function caseFollowupSchema() {
  return {
    type: "object",
    properties: {
      summary: { type: "string" },
      due_at: { type: "string" },
      status: { type: "string" },
    },
    additionalProperties: false,
  };
}

function buildToolDescription(tool) {
  const baseDescription = normalizeText(tool?.description);
  const signature = summarizeSchema(tool?.inputSchema);
  const description = [baseDescription, TOOL_VOICE_BOUNDARY].filter(Boolean).join(" ");
  if (!signature) {
    return description;
  }
  return `${description} Input: ${signature}`;
}

function summarizeSchema(schema, { depth = 0 } = {}) {
  if (!schema || typeof schema !== "object") {
    return "";
  }
  const schemaType = normalizeText(schema.type).toLowerCase();
  if (schemaType === "object") {
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const entries = Object.entries(properties);
    if (!entries.length) {
      return "{}";
    }
    const parts = entries.map(([key, value]) => {
      const suffix = required.has(key) ? "" : "?";
      return `${key}${suffix}: ${summarizeSchema(value, { depth: depth + 1 }) || "any"}`;
    });
    return `{ ${parts.join(", ")} }`;
  }
  if (schemaType === "array") {
    const itemSummary = summarizeSchema(schema.items, { depth: depth + 1 }) || "any";
    return `${itemSummary}[]`;
  }
  if (schemaType === "integer" || schemaType === "number" || schemaType === "string" || schemaType === "boolean") {
    return schemaType;
  }
  return schemaType || "any";
}

function validateTimelineWriteArgs(args) {
  const events = Array.isArray(args?.events) ? args.events : [];
  events.forEach((event, index) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return;
    }
    const hasTitle = normalizeText(event.title).length > 0;
    const hasEventNodeId = normalizeText(event.eventNodeId).length > 0;
    if (!hasTitle && !hasEventNodeId) {
      throw new Error(`mossbridge_timeline_write input.events[${index}].title or input.events[${index}].eventNodeId is required.`);
    }
  });
}

function validateSchema(schema, value, toolName, path) {
  if (!schema || typeof schema !== "object") {
    return;
  }
  const schemaType = schema.type;
  if (schemaType === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${toolName} ${path} must be an object.`);
    }
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!(key in value)) {
        throw new Error(`${toolName} ${path}.${key} is required.`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          throw new Error(`${toolName} ${path}.${key} is not allowed.`);
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in value) {
        validateSchema(propertySchema, value[key], toolName, `${path}.${key}`);
      }
    }
    return;
  }
  if (schemaType === "array") {
    if (!Array.isArray(value)) {
      throw new Error(`${toolName} ${path} must be an array.`);
    }
    if (schema.items) {
      value.forEach((item, index) => validateSchema(schema.items, item, toolName, `${path}[${index}]`));
    }
    return;
  }
  if (schemaType === "string" && typeof value !== "string") {
    throw new Error(`${toolName} ${path} must be a string.`);
  }
  if (schemaType === "boolean" && typeof value !== "boolean") {
    throw new Error(`${toolName} ${path} must be a boolean.`);
  }
  if (schemaType === "integer" && !Number.isInteger(value)) {
    throw new Error(`${toolName} ${path} must be an integer.`);
  }
  if (schemaType === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`${toolName} ${path} must be a number.`);
  }
}

module.exports = {
  ProjectToolHost,
  listProjectToolNames,
  normalizeToolProfile,
  TOOL_PROFILE_CHECKIN_LITE,
  TOOL_PROFILE_FOREGROUND,
  TOOL_PROFILE_FULL,
  TOOL_PROFILE_TASK,
};
