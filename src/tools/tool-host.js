const { WhereaboutsToolHost } = require("whereabouts-mcp");
const {
  STICKER_DESC_FIELD_DESCRIPTION,
  STICKER_STATUS_FIELD_DESCRIPTION,
  STICKER_TAG_GUIDANCE,
} = require("../services/sticker-service");

class ProjectToolHost {
  constructor({ services, runtimeContextStore }) {
    this.services = services;
    this.runtimeContextStore = runtimeContextStore;
    this.extraToolHosts = createExtraToolHosts(services);
  }

  listTools() {
    const builtIn = PROJECT_TOOLS.map((tool) => ({
      name: tool.name,
      description: buildToolDescription(tool),
      inputSchema: tool.inputSchema,
    }));
    const extra = this.extraToolHosts.flatMap((host) => host.listTools());
    return [...builtIn, ...extra];
  }

  async invokeTool(toolName, args = {}, context = {}) {
    const spec = PROJECT_TOOLS.find((candidate) => candidate.name === toolName);
    const normalizedArgs = args && typeof args === "object" ? args : {};
    if (spec) {
      validateSchema(spec.inputSchema, normalizedArgs, toolName, "input");
      const resolvedContext = this.resolveContext(context);
      return await spec.handler({
        services: this.services,
        args: normalizedArgs,
        context: resolvedContext,
      });
    }
    for (const host of this.extraToolHosts) {
      if (host.listTools().some((tool) => tool.name === toolName)) {
        return await host.invokeTool(toolName, normalizedArgs);
      }
    }
    throw new Error(`Unknown tool: ${toolName}`);
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

function listProjectToolNames() {
  return [
    ...PROJECT_TOOLS.map((tool) => tool.name),
    ...STATIC_EXTRA_TOOL_NAMES,
  ];
}

const PROJECT_TOOLS = [
  {
    name: "asheriebridge_diary_append",
    description: "Append a diary entry into AsherieBridge local diary storage.",
    shortHint: "Append a diary entry with direct text content.",
    topics: ["diary"],
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "Diary body to append." },
        title: { type: "string", description: "Optional short entry title." },
        date: { type: "string", description: "Optional date in YYYY-MM-DD." },
        time: { type: "string", description: "Optional time in HH:mm." },
      },
      additionalProperties: false,
    },
    async handler({ services, args }) {
      const result = await services.diary.append(args);
      return {
        text: `Diary appended to ${result.filePath}`,
        data: result,
      };
    },
  },
  {
    name: "asheriebridge_reminder_create",
    description: "Create a reminder in AsherieBridge.",
    shortHint: "Create a reminder with direct text plus delayMinutes or dueAt.",
    topics: ["reminder"],
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", description: "Reminder text to send back later." },
        delayMinutes: { type: "integer", description: "Minutes from now before the reminder fires." },
        dueAt: { type: "string", description: "Absolute time such as 2026-04-07T21:30+08:00." },
        userId: { type: "string", description: "Optional explicit WeChat user id." },
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
    name: "asheriebridge_reminder_list",
    description: "List all pending (not yet fired) reminders for the current user. Use this to get reminder IDs before cancelling.",
    shortHint: "List pending reminders with their IDs and due times.",
    topics: ["reminder"],
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "Optional explicit WeChat user id." },
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
    name: "asheriebridge_reminder_cancel",
    description: "Cancel a pending reminder by its id before it fires. Use reminder_list first to get the id.",
    shortHint: "Cancel one pending reminder by id.",
    topics: ["reminder"],
    inputSchema: {
      type: "object",
      required: ["reminder_id"],
      properties: {
        reminder_id: { type: "string", description: "The reminder id to cancel." },
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
    name: "asheriebridge_system_send",
    description: "Queue an internal AsherieBridge system trigger for the current bound workspace and chat. Do not use this to reply to the user's current message; write ordinary front-stage replies directly as assistant text.",
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
    name: "asheriebridge_channel_send_file",
    description: "Send an existing local file back to the current WeChat chat.",
    shortHint: "Send a local file back to the current WeChat user.",
    topics: ["channel"],
    inputSchema: {
      type: "object",
      required: ["filePath"],
      properties: {
        filePath: { type: "string" },
        userId: { type: "string" },
      },
      additionalProperties: false,
    },
    async handler({ services, args, context }) {
      const result = await services.channelFile.sendToCurrentChat(args, context);
      return {
        text: `File sent: ${result.filePath}`,
        data: result,
      };
    },
  },
  {
    name: "asheriebridge_sticker_tags",
    description: "List sticker tags available for choosing or saving WeChat stickers.",
    shortHint: "List available sticker tags before picking or saving a sticker.",
    topics: ["sticker", "channel"],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async handler({ services }) {
      const result = await services.sticker.listTags();
      return {
        text: `Sticker tags loaded: ${Array.isArray(result.tags) ? result.tags.length : 0}`,
        data: result,
      };
    },
  },
  {
    name: "asheriebridge_sticker_pick",
    description: "Pick existing sticker candidates by one tag before sending a sticker. Use this only after deciding a sticker would fit the current WeChat moment.",
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
    name: "asheriebridge_sticker_list",
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
    name: "asheriebridge_sticker_send",
    description: "Send one saved sticker to the current WeChat chat by stickerId.",
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
    name: "asheriebridge_sticker_save_from_inbox",
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
    name: "asheriebridge_sticker_update",
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
    name: "asheriebridge_sticker_delete",
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
    name: "asheriebridge_memory_context_packet",
    description: "Read the current Asherie-style context packet for the bound user, including warm cards, cold version summary, and recent cache traces.",
    shortHint: "Read the current memory packet before a turn when recall feels important.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "What to recall against the current user scope." },
        userId: { type: "string", description: "Optional explicit WeChat user id." },
        limit: { type: "integer", description: "Warm-memory hit limit." },
        version: { type: "string", description: "Optional cold memory version label." },
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
    name: "asheriebridge_memory_warm_write",
    description: "Write a warm-memory card into the Asherie-style material layer for the current user.",
    shortHint: "Save a durable warm-memory card with title, body, and optional routing metadata.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["title", "body_markdown"],
      properties: {
        title: { type: "string" },
        body_markdown: { type: "string" },
        summary: { type: "string" },
        material_type: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        entities: { type: "array", items: { type: "string" } },
        aliases: { type: "array", items: { type: "string" } },
        storyline_id: { type: "string" },
        memory_family: { type: "string" },
        certainty_state: { type: "string" },
        pinned: { type: "boolean" },
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
    name: "asheriebridge_memory_warm_search",
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
    name: "asheriebridge_memory_warm_read",
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
    name: "asheriebridge_memory_warm_list",
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
    name: "asheriebridge_memory_warm_update",
    description: "Update an existing warm-memory card by material_id for the current user. Use search/read first when the target card is not fully confirmed. NOTE: material_id is the permanent immutable key and is never changed even when title is updated — always reference cards by material_id, not by their display title.",
    shortHint: "Update one exact warm-memory card by material_id. material_id is immutable; title is the display name.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["material_id"],
      properties: {
        material_id: { type: "string" },
        title: { type: "string" },
        body_markdown: { type: "string" },
        summary: { type: "string" },
        material_type: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        entities: { type: "array", items: { type: "string" } },
        aliases: { type: "array", items: { type: "string" } },
        storyline_id: { type: "string" },
        memory_family: { type: "string" },
        certainty_state: { type: "string" },
        pinned: { type: "boolean" },
        storage_strength: { type: "number" },
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
    name: "asheriebridge_memory_warm_delete",
    description: "Delete an existing warm-memory card by material_id for the current user. Use search/read first when the target card is not fully confirmed.",
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
    name: "asheriebridge_memory_ongoing_upsert",
    description: "Create or update a medium-horizon ongoing track for the current user. Use this for live threads such as current health efforts, in-progress writing, unresolved consultations, or maybe-buy decisions.",
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
    name: "asheriebridge_memory_ongoing_list",
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
    name: "asheriebridge_memory_ongoing_read",
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
    name: "asheriebridge_memory_ongoing_close",
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
    name: "asheriebridge_memory_observation_append",
    description: "Append a revisable user observation note. When you believe a soft pattern would help future continuity, write it proactively and silently during natural conversation; do not wait for an explicit user request and do not ask for permission every time. Use it for recent state, life rhythm, habits, boundaries, preferences, or interaction默契; it is not a durable fact card or a rule that controls front-stage wording.",
    shortHint: "Store a tentative observation that can be corrected later.",
    topics: ["memory"],
    inputSchema: {
      type: "object",
      required: ["observation"],
      properties: {
        observation: { type: "string", description: "The soft observation. Phrase as revisable, not a fixed label." },
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
    name: "asheriebridge_memory_observation_search",
    description: "Search revisable user observation notes. Use this when current state, habits, boundaries, or life-rhythm默契 would help but should not be treated as fixed memory.",
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
    name: "asheriebridge_memory_observation_read",
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
    name: "asheriebridge_memory_observation_update",
    description: "Correct, lower confidence, reject, or promote one exact user observation note. Use this immediately if the user says an observation is wrong, uncomfortable, or makes her angry.",
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
    name: "asheriebridge_memory_cold_versions",
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
    name: "asheriebridge_memory_cold_read",
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
    name: "asheriebridge_memory_cold_search",
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
    name: "asheriebridge_memory_cold_root_read",
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
    name: "asheriebridge_memory_cold_patch",
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
        throw new Error("asheriebridge_memory_cold_patch input.changes is required unless input.mode is delete.");
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
    name: "asheriebridge_memory_cold_upsert",
    description: "Upsert a cold-memory version payload into the Asherie-style version bank for the current user. Inspect the active version first when you are correcting existing cold memory.",
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
    name: "asheriebridge_timeline_read",
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
    name: "asheriebridge_timeline_categories",
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
    name: "asheriebridge_timeline_proposals",
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
    name: "asheriebridge_timeline_write",
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
    name: "asheriebridge_timeline_build",
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
    name: "asheriebridge_timeline_serve",
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
    name: "asheriebridge_timeline_dev",
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
    name: "asheriebridge_timeline_screenshot",
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

function resolveBoundUserId(args = {}, context = {}) {
  return normalizeText(args.userId) || normalizeText(context.senderId);
}

function buildToolDescription(tool) {
  const baseDescription = normalizeText(tool?.description);
  const signature = summarizeSchema(tool?.inputSchema);
  if (!signature) {
    return baseDescription;
  }
  return `${baseDescription} Input: ${signature}`;
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
      throw new Error(`asheriebridge_timeline_write input.events[${index}].title or input.events[${index}].eventNodeId is required.`);
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
};
