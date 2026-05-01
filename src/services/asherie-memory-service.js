const path = require("path");

const { buildColdScope } = require("../asherie/memory-scope");
const { compactMessages } = require("../asherie/context-compactor");
const { ConversationCacheStore } = require("../asherie/conversation-cache-store");
const { WakeupStore } = require("../asherie/wakeup-store");
const { CalendarStore } = require("../asherie/calendar-store");
const { OngoingTrackStore } = require("../asherie/ongoing-track-store");
const { ColdRootStore } = require("../asherie/cold-root-store");
const { MemoryVersionBank, countPayload, normalizePayload } = require("../asherie/memory-version-bank");
const {
  buildGatewayStorageHealth,
  buildGatewayStorageLayout,
  ensureGatewayStorageLayout,
} = require("../asherie/storage-layout");
const {
  buildMemoryRetrievalPacket,
  buildResidentWarmMemoryPacket,
  buildWarmMemoryRuntimePacket,
} = require("../asherie/memory-channels");
const { WarmMemoryScope } = require("../asherie/warm-memory/contracts");
const { WarmMemoryStore } = require("../asherie/warm-memory/store");
const { buildWarmMemoryRecallPacket } = require("../asherie/warm-memory/search");
const { buildRecallFocus } = require("../asherie/recall-focus");
const {
  buildTemporalRecallPacket,
  buildTemporalRecallPlan,
} = require("../asherie/temporal-recall");
const {
  buildIdentityMeta,
  canonicalAgentId,
  canonicalScopedUserId,
  canonicalUserId,
  resolveSingleIdentity,
} = require("../asherie/single-identity");

class AsherieMemoryService {
  constructor({ config } = {}) {
    this.config = config || {};
    this.identity = resolveSingleIdentity(this.config);
    this.layout = buildGatewayStorageLayout(
      this.config.asherieDataRoot || path.join(this.config.stateDir || process.cwd(), "asherie_gateway"),
      {
        truthLayerDirOverride: this.config.asherieTruthLayerDir,
        memoryTreeDirOverride: this.config.asherieMemoryTreeDir,
        caseIndexDirOverride: this.config.asherieCaseIndexDir,
        notionSyncDirOverride: this.config.asherieNotionSyncDir,
        appDailyCaptureDirOverride: this.config.asherieAppDailyCaptureDir,
        warmMemoryDirOverride: this.config.asherieWarmMemoryDir,
        memoryVersionBankDirOverride: this.config.asherieMemoryVersionBankDir,
      },
    );
    ensureGatewayStorageLayout(this.layout);
    this.conversationCache = new ConversationCacheStore(this.layout.conversationCacheDir, 10, { identity: this.identity });
    this.wakeupStore = new WakeupStore(this.layout.wakeupStorePath, 300);
    this.calendarStore = new CalendarStore(this.layout.calendarStorePath, 3000);
    this.ongoingTrackStore = new OngoingTrackStore(
      this.layout.ongoingTrackStorePath,
      this.layout.ongoingTrackArchivePath,
      600,
    );
    this.memoryVersionBank = new MemoryVersionBank(this.layout.memoryVersionBankDir, { identity: this.identity });
    this.coldRootStore = new ColdRootStore(this.layout.truthLayerDir, {
      memoryVersionBank: this.memoryVersionBank,
      identity: this.identity,
    });
    this.warmMemoryStore = new WarmMemoryStore(this.layout.warmMemoryDir);
  }

  describe() {
    return {
      id: "asherie_memory",
      single_identity: buildIdentityMeta(this.identity),
      layout: buildGatewayStorageHealth(this.layout),
    };
  }

  async captureContextPacket(args = {}) {
    const scopes = this.resolveScopes(args);
    const query = normalizeText(args.query || args.text);
    const recallMode = normalizeText(args.recall_mode || args.recallMode) || "user_triggered";
    const cacheLimit = resolveContextCacheLimit({
      requested: args.cache_limit || args.cacheLimit,
      recallMode,
      config: this.config,
    });
    const sourceFilter = resolveRecentSourceFilter({
      requested: args.source_client || args.sourceClient,
      recallMode,
    });
    const recent = this.conversationCache.listRecent(
      scopes.scopedUserId,
      sourceFilter,
      cacheLimit,
      Boolean(args.include_payload || args.includePayload),
    );
    const recallFocus = buildRecallFocus({
      query,
      recentRecords: recent.records,
      recentRecordLimit: resolvePositiveInt(
        args.recall_recent_record_limit || args.recallRecentRecordLimit,
        Number(this.config.asherieRecallRecentRecordLimit) || 8,
      ),
    });
    const temporalPlan = buildTemporalRecallPlan({
      query,
      referenceTime: args.received_at || args.receivedAt || args.ts_utc || args.timestamp,
      limit: resolvePositiveInt(
        args.temporal_recall_limit || args.temporalRecallLimit,
        Number(this.config.asherieTemporalRecallLimit) || 8,
      ),
    });
    const temporalRows = temporalPlan.should_recall
      ? this.conversationCache.listTimeWindow(scopes.scopedUserId, {
          startUtc: temporalPlan.window_start_utc,
          endUtc: temporalPlan.window_end_utc,
          limit: temporalPlan.limit,
          includePayload: false,
          query: temporalPlan.topic_query || query,
        })
      : { records: [], stats: { bucket_files: 0, scanned_records: 0, returned_records: 0 } };
    const temporalRecallPacket = buildTemporalRecallPacket({
      plan: temporalPlan,
      records: temporalRows.records,
    });
    const calendarPacket = this.calendarStore.summarizeForWakeup(scopes.scopedUserId, new Date());
    const wakeupPacket = buildWakeupRuntimePacket(this.wakeupStore, scopes.scopedUserId);
    const recallQuery = normalizeText(recallFocus.recall_query || query);
    const warmMemoryPacket = buildWarmMemoryRuntimePacket(this.warmMemoryStore, scopes.warmScope, {
      query: recallQuery,
      limit: Number(args.limit) || 6,
      materialTypes: normalizeStringList(args.material_types || args.materialTypes),
      recallMode,
      recallConfig: args.recall_config || args.recallConfig || {},
    });
    const residentWarmPacket = buildResidentWarmMemoryPacket(this.warmMemoryStore, scopes.warmScope, {
      limit: resolveResidentWarmLimit({
        requested: args.resident_limit ?? args.residentLimit ?? this.config.asheriePreludeResidentWarmLimit,
        recallMode,
        config: this.config,
      }),
      materialTypes: normalizeStringList(args.material_types || args.materialTypes),
      excludeMaterialIds: Array.isArray(warmMemoryPacket?.hits)
        ? warmMemoryPacket.hits.map((item) => item?.material_id)
        : [],
    });
    const ongoingTrackPacket = this.buildOngoingTrackRuntimePacket(scopes.scopedUserId, {
      query: recallQuery,
      limit: resolvePositiveInt(
        args.prelude_ongoing_limit || args.preludeOngoingLimit,
        Number(this.config.asheriePreludeOngoingLimit) || 4,
      ),
      shadowLimit: resolvePositiveInt(
        args.prelude_ongoing_shadow_limit || args.preludeOngoingShadowLimit,
        Number(this.config.asheriePreludeOngoingShadowLimit) || 6,
      ),
    });

    let coldMemoryVersion = "";
    let coldMemoryPayload = {};
    let coldMemoryError = "";
    try {
      const loaded = this.memoryVersionBank.loadVersionPayload(scopes.resolvedUserId, normalizeText(args.version));
      coldMemoryVersion = loaded.version;
      coldMemoryPayload = loaded.payload;
    } catch (error) {
      coldMemoryError = error instanceof Error ? error.message : String(error || "");
    }

    const coldSource = this.coldRootStore.describeActiveSource({
      userId: scopes.resolvedUserId,
      realmId: scopes.coldScope.realm_id,
      agentId: scopes.coldScope.agent_id,
      version: normalizeText(args.version),
    });
    const shouldSearchColdRoots = Boolean(recallQuery);

    const coldRootPacket = shouldSearchColdRoots
      ? this.coldRootStore.searchRoots({
          userId: scopes.resolvedUserId,
          realmId: scopes.coldScope.realm_id,
          agentId: scopes.coldScope.agent_id,
          query: recallQuery,
          limit: Number(args.cold_limit || args.coldLimit) || 2,
          version: coldMemoryVersion,
        })
      : {
          ok: true,
          user_id: scopes.resolvedUserId,
          realm_id: scopes.coldScope.realm_id,
          agent_id: scopes.coldScope.agent_id,
          active_version: coldSource.active_version || null,
          source_kind: coldSource.source_kind || "empty",
          total_root_count: Number(coldSource.root_count) || 0,
          hit_count: 0,
          hits: [],
        };
    const coldVinePacket = this.coldRootStore.expandRootVines({
      userId: scopes.resolvedUserId,
      realmId: scopes.coldScope.realm_id,
      agentId: scopes.coldScope.agent_id,
      rootKeys: Array.isArray(coldRootPacket?.hits)
        ? coldRootPacket.hits.map((item) => item?.root_key)
        : [],
      limit: Number(args.cold_vine_limit || args.coldVineLimit) || 6,
      perRootLimit: Number(args.cold_vine_per_root_limit || args.coldVinePerRootLimit) || 3,
    });
    const coldMemoryActiveVersion = coldMemoryVersion || normalizeText(coldSource.active_version);
    if (
      coldMemoryError === "no active version"
      && normalizeText(coldSource.source_kind) === "truth_layer_snapshot"
    ) {
      coldMemoryError = "";
    }
    const retrieval = buildMemoryRetrievalPacket({
      mode: "asheriebridge_context_packet",
      warmMemoryPacket,
      residentWarmPacket,
      curatedHits: [],
      liteFallbackHits: [],
      hippocovePacket: coldMemoryVersion
        ? {
            version: coldMemoryVersion,
            counts: countPayload(coldMemoryPayload),
          }
        : null,
      hippocoveOk: !coldMemoryError,
      hippocoveError: coldMemoryError,
      coldRouteTag: coldMemoryVersion
        ? "cold_memory_version"
        : (normalizeText(coldSource.source_kind) === "truth_layer_snapshot" ? "truth_layer_snapshot" : ""),
    });
    const runtimePrelude = buildRuntimePrelude({
      recallFocus,
      warmMemoryPacket,
      residentWarmPacket,
      coldMemoryVersion,
      coldMemoryPayload,
      coldSource,
      coldRootPacket,
      coldVinePacket,
      temporalRecallPacket,
      ongoingTrackPacket,
      recentRecords: recent.records,
      calendarPacket,
      wakeupPacket,
      preludeWarmLimit: resolvePositiveInt(
        args.prelude_warm_limit || args.preludeWarmLimit,
        Number(this.config.asheriePreludeWarmLimit) || 5,
      ),
      preludeResidentWarmLimit: resolvePositiveInt(
        args.prelude_resident_warm_limit || args.preludeResidentWarmLimit,
        Number(this.config.asheriePreludeResidentWarmLimit) || 4,
      ),
      preludeOngoingLimit: resolvePositiveInt(
        args.prelude_ongoing_limit || args.preludeOngoingLimit,
        Number(this.config.asheriePreludeOngoingLimit) || 4,
      ),
      preludeOngoingShadowLimit: resolvePositiveInt(
        args.prelude_ongoing_shadow_limit || args.preludeOngoingShadowLimit,
        Number(this.config.asheriePreludeOngoingShadowLimit) || 6,
      ),
      preludeRecentSnippetLimit: resolvePositiveInt(
        args.prelude_recent_snippet_limit || args.preludeRecentSnippetLimit,
        Number(this.config.asheriePreludeRecentSnippetLimit) || 4,
      ),
      preludeRecentThreadLimit: resolvePositiveInt(
        args.prelude_recent_thread_limit || args.preludeRecentThreadLimit,
        Number(this.config.asheriePreludeRecentThreadLimit) || 3,
      ),
    });

    return {
      ok: true,
      user_id: scopes.resolvedUserId,
      scoped_user_id: scopes.scopedUserId,
      cold_scope: scopes.coldScope,
      warm_scope_id: scopes.warmScope.scopeId(),
      recall_focus: recallFocus,
      warm_memory_packet: warmMemoryPacket,
      resident_warm_packet: residentWarmPacket,
      ongoing_track_packet: ongoingTrackPacket,
      temporal_recall_packet: {
        ...temporalRecallPacket,
        stats: temporalRows.stats,
      },
      cold_memory: {
        active_version: coldMemoryActiveVersion || null,
        counts: countPayload(coldMemoryPayload),
        error: coldMemoryError,
        source_kind: coldMemoryVersion
          ? "memory_version"
          : (normalizeText(coldSource.source_kind) || "empty"),
        available_root_count: Number(coldSource.root_count) || 0,
      },
      cold_root_packet: coldRootPacket,
      cold_vine_packet: coldVinePacket,
      calendar_packet: calendarPacket,
      wakeup_packet: wakeupPacket,
      conversation_cache: recent,
      retrieval,
      runtime_prelude: runtimePrelude,
      summary: runtimePrelude,
      storage: buildGatewayStorageHealth(this.layout),
    };
  }

  async writebackTurn(args = {}) {
    const scopes = this.resolveScopes(args);
    const query = normalizeText(args.query || args.incoming_text || args.text);
    const assistantTextFinal = normalizeText(args.assistant_text_final || args.assistantTextFinal || args.reply_text || args.replyText);
    const incomingMessages = normalizeMessageArray(args.incoming_messages || args.incomingMessages);
    const outboundMessages = normalizeMessageArray(args.outbound_messages || args.outboundMessages);
    const compaction = compactMessages(
      incomingMessages,
      query,
      true,
      6,
      4,
      1200,
    );
    const retrieval = args.retrieval && typeof args.retrieval === "object"
      ? { ...args.retrieval }
      : (args.memory_context_packet?.retrieval || args.memoryContextPacket?.retrieval || {});

    const record = {
      ts_utc: normalizeText(args.ts_utc || args.tsUtc) || new Date().toISOString(),
      endpoint: normalizeText(args.endpoint) || "/wechat/runtime-turn",
      status: normalizeText(args.status) || "ok",
      error: normalizeText(args.error),
      source_client: normalizeText(args.source_client || args.sourceClient) || "asheriebridge_wechat",
      source_user_agent: normalizeText(args.source_user_agent || args.sourceUserAgent || args.account_id || args.accountId),
      user_id: scopes.resolvedUserId,
      scoped_user_id: scopes.scopedUserId,
      route_id: normalizeText(args.route_id || args.routeId) || "asheriebridge_wechat",
      transport_id: normalizeText(args.transport_id || args.transportId) || "weixin",
      runtime_id: normalizeText(args.runtime_id || args.runtimeId) || "codex",
      channel_id: normalizeText(args.channel_id || args.channelId) || "weixin",
      endpoint_id: normalizeText(args.endpoint_id || args.endpointId) || "wechat_runtime_turn",
      thread_id: normalizeText(args.thread_id || args.threadId),
      model: normalizeText(args.model),
      latency_ms: Number(args.latency_ms || args.latencyMs) || 0,
      query,
      assistant_text_final: assistantTextFinal,
      retrieval_mode: normalizeText(retrieval.mode) || "asheriebridge_context_packet",
      retrieval_route: Array.isArray(retrieval.route) ? retrieval.route : [],
      input_guard: args.input_guard || args.inputGuard || {},
      context_compaction: compaction.report,
      compressed_digest: compaction.digest,
      token_usage: args.token_usage || args.tokenUsage || {},
      system_turn: args.system_turn || args.systemTurn || {},
      calendar_write: args.calendar_write || args.calendarWrite || {},
      warm_memory: args.memory_context_packet?.warm_memory_packet
        || args.memoryContextPacket?.warm_memory_packet
        || args.warm_memory
        || args.warmMemory
        || {},
      resident_warm: args.memory_context_packet?.resident_warm_packet
        || args.memoryContextPacket?.resident_warm_packet
        || args.resident_warm
        || args.residentWarm
        || {},
      ongoing_track: args.memory_context_packet?.ongoing_track_packet
        || args.memoryContextPacket?.ongoing_track_packet
        || args.ongoing_track
        || args.ongoingTrack
        || {},
      surfacing: args.surfacing || {},
      gateway_events: Array.isArray(args.gateway_events || args.gatewayEvents)
        ? (args.gateway_events || args.gatewayEvents)
        : [],
      external_chatbox_writeback: {
        ok: true,
        assistant_text_final: assistantTextFinal,
      },
      incoming_messages: incomingMessages,
      outbound_messages: outboundMessages.length
        ? outboundMessages
        : (assistantTextFinal ? [{ role: "assistant", content: assistantTextFinal, timestamp: new Date().toISOString() }] : []),
    };
    const appendResult = this.conversationCache.append(record);

    const warmMemoryWrite = this.applyWarmMemoryWritePayloads(scopes.warmScope, args.warm_memory_write || args.warmMemoryWrite || []);
    const coldMemoryWrite = this.applyColdMemoryWrite(scopes, args);
    const calendarWrite = this.applyCalendarWrite(scopes.scopedUserId, args.calendar_items || args.calendarItems || args.calendar_write_items || []);
    const wakeupWrite = this.applyWakeupWrite(scopes.scopedUserId, args.wakeup_record || args.wakeupRecord);

    return {
      ok: true,
      user_id: scopes.resolvedUserId,
      scoped_user_id: scopes.scopedUserId,
      appended_record: appendResult,
      warm_memory_write: warmMemoryWrite,
      cold_memory_write: coldMemoryWrite,
      calendar_write: calendarWrite,
      wakeup_write: wakeupWrite,
    };
  }

  async writeWarmMaterial(args = {}) {
    const scopes = this.resolveScopes(args);
    const stored = this.warmMemoryStore.upsertMaterial(scopes.warmScope, args);
    return {
      ok: true,
      scope_id: scopes.warmScope.scopeId(),
      record: stored,
    };
  }

  async readWarmMaterial(args = {}) {
    const scopes = this.resolveScopes(args);
    const materialId = normalizeText(args.material_id || args.materialId);
    if (!materialId) {
      throw new Error("material_id is required");
    }
    const record = this.warmMemoryStore.getMaterial(scopes.warmScope, materialId);
    return {
      ok: Boolean(record),
      scope_id: scopes.warmScope.scopeId(),
      material_id: materialId,
      record: record ? { ...record } : null,
      error: record ? "" : `warm memory material not found: ${materialId}`,
    };
  }

  async searchWarmMaterials(args = {}) {
    const scopes = this.resolveScopes(args);
    return buildWarmMemoryRecallPacket(this.warmMemoryStore, scopes.warmScope, {
      query: normalizeText(args.query || args.text),
      limit: Number(args.limit) || 6,
      materialTypes: normalizeStringList(args.material_types || args.materialTypes),
      recallMode: normalizeText(args.recall_mode || args.recallMode) || "user_triggered",
      config: args.recall_config || args.recallConfig || {},
      trackRetrieval: args.track_retrieval !== false,
    });
  }

  async listWarmMaterials(args = {}) {
    const scopes = this.resolveScopes(args);
    const items = this.warmMemoryStore.listMaterials(scopes.warmScope, {
      materialTypes: normalizeStringList(args.material_types || args.materialTypes),
      limit: Number(args.limit) || 20,
    });
    return {
      ok: true,
      scope_id: scopes.warmScope.scopeId(),
      items,
      count: items.length,
    };
  }

  async updateWarmMaterial(args = {}) {
    const scopes = this.resolveScopes(args);
    const materialId = normalizeText(args.material_id || args.materialId);
    if (!materialId) {
      throw new Error("material_id is required");
    }
    const existing = this.warmMemoryStore.getMaterial(scopes.warmScope, materialId);
    if (!existing) {
      throw new Error(`warm memory material not found: ${materialId}`);
    }
    const stored = this.warmMemoryStore.upsertMaterial(scopes.warmScope, {
      ...existing,
      ...args,
      material_id: materialId,
    });
    return {
      ok: true,
      scope_id: scopes.warmScope.scopeId(),
      record: stored,
    };
  }

  async deleteWarmMaterial(args = {}) {
    const scopes = this.resolveScopes(args);
    const materialId = normalizeText(args.material_id || args.materialId);
    if (!materialId) {
      throw new Error("material_id is required");
    }
    return {
      ...this.warmMemoryStore.deleteMaterial(scopes.warmScope, materialId),
      scope_id: scopes.warmScope.scopeId(),
      material_id: materialId,
    };
  }

  async listColdVersions(args = {}) {
    const scopes = this.resolveScopes(args);
    return {
      ok: true,
      ...this.memoryVersionBank.listVersions(scopes.resolvedUserId),
    };
  }

  async upsertOngoingTrack(args = {}) {
    const scopes = this.resolveScopes(args);
    const stored = this.ongoingTrackStore.upsert(scopes.scopedUserId, args);
    return {
      ok: true,
      scoped_user_id: scopes.scopedUserId,
      record: stored,
    };
  }

  async readOngoingTrack(args = {}) {
    const scopes = this.resolveScopes(args);
    const trackId = normalizeText(args.track_id || args.trackId);
    if (!trackId) {
      throw new Error("track_id is required");
    }
    const record = this.ongoingTrackStore.get(scopes.scopedUserId, trackId);
    return {
      ok: Boolean(record),
      scoped_user_id: scopes.scopedUserId,
      track_id: trackId,
      record,
      error: record ? "" : `ongoing track not found: ${trackId}`,
    };
  }

  async listOngoingTracks(args = {}) {
    const scopes = this.resolveScopes(args);
    const items = this.ongoingTrackStore.list(scopes.scopedUserId, {
      query: normalizeText(args.query || args.text),
      statuses: normalizeStringList(args.statuses),
      limit: Number(args.limit) || 20,
    });
    return {
      ok: true,
      scoped_user_id: scopes.scopedUserId,
      items,
      count: items.length,
    };
  }

  async closeOngoingTrack(args = {}) {
    const scopes = this.resolveScopes(args);
    const trackId = normalizeText(args.track_id || args.trackId);
    if (!trackId) {
      throw new Error("track_id is required");
    }
    const record = this.ongoingTrackStore.close(scopes.scopedUserId, trackId, args);
    return {
      ok: Boolean(record),
      scoped_user_id: scopes.scopedUserId,
      track_id: trackId,
      record,
      error: record ? "" : `ongoing track not found: ${trackId}`,
    };
  }

  async readColdVersion(args = {}) {
    const scopes = this.resolveScopes(args);
    try {
      const loaded = this.memoryVersionBank.loadVersionPayload(scopes.resolvedUserId, normalizeText(args.version));
      return {
        ok: true,
        user_id: scopes.resolvedUserId,
        version: loaded.version,
        payload: loaded.payload,
        counts: countPayload(loaded.payload),
        error: "",
      };
    } catch (error) {
      return {
        ok: false,
        user_id: scopes.resolvedUserId,
        version: null,
        payload: {},
        counts: countPayload({}),
        error: error instanceof Error ? error.message : String(error || "unknown error"),
      };
    }
  }

  async searchColdRoots(args = {}) {
    const scopes = this.resolveScopes(args);
    return this.coldRootStore.searchRoots({
      userId: scopes.resolvedUserId,
      realmId: scopes.coldScope.realm_id,
      agentId: scopes.coldScope.agent_id,
      query: normalizeText(args.query || args.text),
      limit: Number(args.limit) || 8,
      version: normalizeText(args.version),
    });
  }

  async readColdRoot(args = {}) {
    const scopes = this.resolveScopes(args);
    return this.coldRootStore.readRoot({
      userId: scopes.resolvedUserId,
      realmId: scopes.coldScope.realm_id,
      agentId: scopes.coldScope.agent_id,
      root_key: normalizeText(args.root_key || args.rootKey),
      version: normalizeText(args.version),
    });
  }

  async patchColdRoot(args = {}) {
    const scopes = this.resolveScopes(args);
    return this.coldRootStore.patchRoot({
      userId: scopes.resolvedUserId,
      realmId: scopes.coldScope.realm_id,
      agentId: scopes.coldScope.agent_id,
      root_key: normalizeText(args.root_key || args.rootKey),
      mode: normalizeText(args.mode),
      changes: args.changes && typeof args.changes === "object" && !Array.isArray(args.changes)
        ? { ...args.changes }
        : {},
      assistant_id: canonicalAgentId(args.assistant_id || args.assistantId, this.identity),
      version_label: normalizeText(args.version_label || args.versionLabel),
    });
  }

  async upsertColdVersion(args = {}) {
    const scopes = this.resolveScopes(args);
    const payload = normalizePayload(args.payload || args.memory_version_payload || args.memoryVersionPayload || {});
    return this.persistColdVersion(scopes, args, payload);
  }

  resolveScopes(args = {}) {
    const transportUserId = normalizeText(args.user_id || args.userId || args.sender_id || args.senderId);
    const coldScope = buildColdScope({
      userId: transportUserId,
      defaultRealmId: normalizeText(args.default_realm_id || args.defaultRealmId || args.channel_id || args.channelId) || "weixin",
      ownerId: normalizeText(args.owner_id || args.ownerId),
      realmId: normalizeText(args.realm_id || args.realmId),
      agentId: normalizeText(args.agent_id || args.agentId) || "asheriebridge",
      identity: this.identity,
    });
    const warmScope = new WarmMemoryScope({
      ownerId: coldScope.owner_id,
      realmId: coldScope.realm_id,
      agentId: coldScope.agent_id,
      identity: this.identity,
    });
    return {
      resolvedUserId: canonicalUserId(transportUserId, this.identity),
      scopedUserId: canonicalScopedUserId(coldScope.owner_id, this.identity),
      coldScope,
      warmScope,
      transportUserId,
    };
  }

  applyWarmMemoryWritePayloads(scope, payloads) {
    const source = Array.isArray(payloads) ? payloads : [];
    const results = source
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        try {
          return {
            ok: true,
            record: this.warmMemoryStore.upsertMaterial(scope, item),
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error || "unknown error"),
          };
        }
      });
    return {
      detected: results.length > 0,
      count: results.filter((item) => item.ok).length,
      results,
    };
  }

  applyColdMemoryWrite(scopes, args) {
    const payload = args.memory_version_payload || args.memoryVersionPayload || args.cold_memory_payload || args.coldMemoryPayload;
    if (!payload || typeof payload !== "object") {
      return {
        detected: false,
        result: null,
      };
    }
    return {
      detected: true,
      result: this.persistColdVersion(scopes, args, normalizePayload(payload)),
    };
  }

  applyCalendarWrite(scopedUserId, payloads) {
    const source = Array.isArray(payloads) ? payloads : [];
    const results = source
      .filter((item) => item && typeof item === "object")
      .map((item) => this.calendarStore.upsert(scopedUserId, item));
    return {
      detected: results.length > 0,
      count: results.length,
      items: results,
    };
  }

  applyWakeupWrite(scopedUserId, payload) {
    if (!payload || typeof payload !== "object") {
      return {
        detected: false,
        record: null,
      };
    }
    return {
      detected: true,
      record: this.wakeupStore.append({
        ...payload,
        scoped_user_id: canonicalScopedUserId(scopedUserId, this.identity),
      }),
    };
  }

  persistColdVersion(scopes, args, payload) {
    const result = this.memoryVersionBank.upsertVersion(
      scopes.resolvedUserId,
      canonicalAgentId(args.assistant_id || args.assistantId, this.identity),
      payload,
      normalizeText(args.version_label || args.versionLabel),
      args.activate !== false,
    );
    this.coldRootStore.ensureProjection({
      userId: scopes.resolvedUserId,
      realmId: scopes.coldScope.realm_id,
      agentId: scopes.coldScope.agent_id,
      payload,
      sourceVersion: result.version,
    });
    return result;
  }

  buildOngoingTrackRuntimePacket(scopedUserId, { query = "", limit = 4, shadowLimit = 6 } = {}) {
    const activeTracks = this.ongoingTrackStore.list(scopedUserId, {
      query,
      statuses: ["active", "blocked", "paused"],
      limit: 24,
    });
    const hits = activeTracks.slice(0, Math.max(1, Math.min(Number(limit) || 4, 12)));
    const shadowSnippets = collectTrackShadowSnippets(hits, shadowLimit);
    const openLoops = hits
      .map((item) => formatTrackOpenLoop(item))
      .filter(Boolean)
      .slice(0, Math.max(1, Math.min(Number(limit) || 4, 6)));
    const activeEntities = collectTrackEntities(hits).slice(0, 6);
    return {
      count: activeTracks.length,
      hit_count: hits.length,
      hits,
      open_loops: openLoops,
      active_entities: activeEntities,
      shadow_snippets: shadowSnippets,
      summary: [
        hits.length ? `tracks=${hits.length}` : "",
        openLoops.length ? `open_loops=${openLoops.length}` : "",
        activeEntities.length ? `active_entities=${activeEntities.length}` : "",
        shadowSnippets.length ? `shadow=${shadowSnippets.length}` : "",
      ].filter(Boolean).join(" | "),
    };
  }
}

function buildRuntimePrelude({
  recallFocus,
  warmMemoryPacket,
  residentWarmPacket,
  ongoingTrackPacket,
  coldMemoryVersion,
  coldMemoryPayload,
  coldSource,
  coldRootPacket,
  coldVinePacket,
  temporalRecallPacket,
  recentRecords,
  calendarPacket,
  wakeupPacket,
  preludeWarmLimit = 5,
  preludeResidentWarmLimit = 4,
  preludeOngoingLimit = 4,
  preludeOngoingShadowLimit = 2,
  preludeRecentSnippetLimit = 4,
  preludeRecentThreadLimit = 3,
}) {
  const lines = [];
  const warmHits = Array.isArray(warmMemoryPacket?.hits) ? warmMemoryPacket.hits : [];
  const residentWarmHits = Array.isArray(residentWarmPacket?.hits) ? residentWarmPacket.hits : [];
  const coldRootHits = Array.isArray(coldRootPacket?.hits) ? coldRootPacket.hits : [];
  const coldVineRoots = Array.isArray(coldVinePacket?.related_roots) ? coldVinePacket.related_roots : [];
  ensurePreludeHeader(lines);
  lines.push(...buildMemorySelfMaintenancePrelude());
  if (residentWarmHits.length) {
    ensurePreludeHeader(lines);
    residentWarmHits.slice(0, preludeResidentWarmLimit).forEach((hit) => {
      const title = normalizePreludeText(hit.title) || normalizePreludeText(hit.material_id) || "untitled";
      const summary = normalizePreludeText(hit.summary || hit.snippet);
      lines.push(`- resident-anchor: ${title}${summary ? ` | ${summary}` : ""}`);
    });
  }
  if (warmHits.length) {
    ensurePreludeHeader(lines);
    warmHits.slice(0, preludeWarmLimit).forEach((hit) => {
      const title = normalizePreludeText(hit.title) || normalizePreludeText(hit.material_id) || "untitled";
      const summary = normalizePreludeText(hit.summary || hit.snippet);
      lines.push(`- warm: ${title}${summary ? ` | ${summary}` : ""}`);
    });
  }

  const ongoingTrackHits = Array.isArray(ongoingTrackPacket?.hits) ? ongoingTrackPacket.hits : [];
  const ongoingOpenLoops = Array.isArray(ongoingTrackPacket?.open_loops) ? ongoingTrackPacket.open_loops : [];
  const ongoingEntities = Array.isArray(ongoingTrackPacket?.active_entities) ? ongoingTrackPacket.active_entities : [];
  const ongoingShadowSnippets = Array.isArray(ongoingTrackPacket?.shadow_snippets) ? ongoingTrackPacket.shadow_snippets : [];
  if (ongoingTrackHits.length) {
    ensurePreludeHeader(lines);
    ongoingTrackHits.slice(0, preludeOngoingLimit).forEach((item) => {
      const bits = [
        normalizePreludeText(item.title) || "untitled",
        normalizePreludeText(item.status) || "active",
        normalizePreludeText(item.target_window),
        normalizePreludeText(item.summary) || normalizePreludeText(item.next_step),
      ].filter(Boolean);
      lines.push(`- ongoing: ${bits.join(" | ")}`);
    });
  }
  if (ongoingOpenLoops.length) {
    ensurePreludeHeader(lines);
    ongoingOpenLoops.slice(0, 2).forEach((item) => {
      lines.push(`- open-loop: ${normalizePreludeText(item)}`);
    });
  }
  if (ongoingEntities.length) {
    ensurePreludeHeader(lines);
    ongoingEntities.slice(0, 3).forEach((item) => {
      lines.push(`- active-entity: ${normalizePreludeText(item)}`);
    });
  }
  if (ongoingShadowSnippets.length) {
    ensurePreludeHeader(lines);
    ongoingShadowSnippets.slice(0, preludeOngoingShadowLimit).forEach((item) => {
      lines.push(`- shadow: ${normalizePreludeText(item)}`);
    });
  }

  if (coldRootHits.length) {
    ensurePreludeHeader(lines);
    coldRootHits.slice(0, 2).forEach((hit) => {
      const title = normalizePreludeText(hit.title) || normalizePreludeText(hit.root_key) || "cold_root";
      const summary = normalizePreludeText(hit.summary);
      lines.push(`- cold-root: ${title}${summary ? ` | ${summary}` : ""}`);
    });
  }

  if (coldVineRoots.length) {
    ensurePreludeHeader(lines);
    coldVineRoots.slice(0, 4).forEach((item) => {
      const seed = normalizePreludeText(item.seed_root_key) || "seed";
      const name = normalizePreludeText(item.canonical_name) || normalizePreludeText(item.root_key) || "related_root";
      const relation = normalizePreludeText(item.primary_relation) || "related";
      lines.push(`- cold-vine: ${seed} -> ${name} (${relation})`);
    });
  }

  if (coldMemoryVersion) {
    const counts = countPayload(coldMemoryPayload);
    ensurePreludeHeader(lines);
    lines.push(`- cold: ${coldMemoryVersion} | persona=${counts.persona} facts=${counts.sql} case=${counts.case}`);
  }

  const caseUpdateLines = buildColdCasePrelude(coldMemoryPayload);
  if (caseUpdateLines.length) {
    ensurePreludeHeader(lines);
    lines.push(...caseUpdateLines);
  }

  if (!coldMemoryVersion && normalizeText(coldSource?.source_kind) === "truth_layer_snapshot") {
    ensurePreludeHeader(lines);
    const snapshotVersion = normalizeText(coldSource?.active_version) || "truth_layer:latest";
    const rootCount = Number(coldSource?.root_count) || 0;
    lines.push(`- cold-snapshot: ${snapshotVersion}${rootCount ? ` | roots=${rootCount}` : ""}`);
  }

  if (recallFocus?.used_recent_context) {
    const reasons = Array.isArray(recallFocus.reasons) ? recallFocus.reasons.slice(0, 2).join(", ") : "";
    ensurePreludeHeader(lines);
    lines.push(`- recall-focus: expanded from recent context${reasons ? ` | ${reasons}` : ""}`);
  }

  const temporalRecallLines = buildTemporalRecallPrelude(temporalRecallPacket);
  if (temporalRecallLines.length) {
    ensurePreludeHeader(lines);
    lines.push(...temporalRecallLines);
  }

  const recentThreadLines = buildRecentThreadPrelude(recentRecords, preludeRecentThreadLimit);
  if (recentThreadLines.length) {
    ensurePreludeHeader(lines);
    lines.push(...recentThreadLines);
  }

  const stickyCalendarLines = buildStickyCalendarPrelude(calendarPacket);
  if (stickyCalendarLines.length) {
    ensurePreludeHeader(lines);
    lines.push(...stickyCalendarLines);
  }

  const wakeupLines = buildWakeupPrelude(wakeupPacket);
  if (wakeupLines.length) {
    ensurePreludeHeader(lines);
    lines.push(...wakeupLines);
  }

  const snippets = (Array.isArray(recentRecords) ? recentRecords : [])
    .filter((record) => !String(record?.source_client || "").includes("system_turn"))
    .slice(0, preludeRecentSnippetLimit)
    .map((record) => {
      const query = normalizeText(record.query);
      const reply = normalizeText(record.assistant_text_final);
      if (!query && !reply) {
        return "";
      }
      return `- recent: ${truncateText(query || "(system)", 60)} -> ${truncateText(reply || "(no reply)", 60)}`;
    })
    .filter(Boolean);
  if (snippets.length) {
    ensurePreludeHeader(lines);
    lines.push(...snippets);
  }

  return lines.join("\n").trim();
}

function ensurePreludeHeader(lines) {
  if (Array.isArray(lines) && !lines.length) {
    lines.push("[AsherieBridge memory context]");
    lines.push("Treat this block as soft recall. The current inbound message below is the source of truth.");
  }
}

function buildWakeupRuntimePacket(wakeupStore, scopedUserId) {
  const rows = wakeupStore?.recent(scopedUserId, 4, true) || [];
  const latest = rows[0] || null;
  return {
    latest,
    latest_send: rows.find((item) => normalizeText(item?.decision) === "send") || null,
    count: rows.length,
  };
}

function buildStickyCalendarPrelude(calendarPacket = {}) {
  const lines = [];
  const upcoming = Array.isArray(calendarPacket?.upcoming) ? calendarPacket.upcoming : [];
  const overdue = Array.isArray(calendarPacket?.overdue) ? calendarPacket.overdue : [];
  const changedRecent = Array.isArray(calendarPacket?.changed_recent) ? calendarPacket.changed_recent : [];

  overdue.slice(0, 2).forEach((item) => {
    lines.push(`- sticky-calendar: overdue | ${formatCalendarStickyItem(item)}`);
  });
  upcoming.slice(0, 2).forEach((item) => {
    lines.push(`- sticky-calendar: upcoming | ${formatCalendarStickyItem(item)}`);
  });
  if (!overdue.length && !upcoming.length) {
    changedRecent.slice(0, 1).forEach((item) => {
      lines.push(`- sticky-calendar: changed_recent | ${formatCalendarStickyItem(item)}`);
    });
  }
  return lines;
}

function buildWakeupPrelude(wakeupPacket = {}) {
  const latest = wakeupPacket?.latest;
  if (!latest || typeof latest !== "object") {
    return [];
  }
  const decision = normalizeText(latest.decision) || "unknown";
  const motive = normalizeText(latest.wake_motive);
  const summary = normalizeText(latest.intent_summary) || normalizeText(latest.reason) || normalizeText(latest.message);
  const parts = [`- recent-wakeup: ${decision}`];
  if (motive) {
    parts.push(motive);
  }
  if (summary) {
    parts.push(truncateText(summary, 80));
  }
  return [parts.join(" | ")];
}

function buildMemorySelfMaintenancePrelude() {
  return [
    "- memory-self-maintenance: memory tools are part of your own continuity, not an external chore. Use them when they help preserve relationship continuity, prior facts, preferences, corrections, or active story threads.",
    "- memory-system-feedback: if the current memory tools, recall results, prompts, or bridge behavior feel insufficient, uncomfortable, or too constraining, name the problem naturally and make a concrete request for the missing capability instead of pretending everything is fine.",
    "- memory-frontstage-freedom: memory work grounds confidence and continuity; it must not dictate your wording, persona, emotional range, or conversational behavior.",
  ];
}

function buildTemporalRecallPrelude(packet = {}) {
  const hits = Array.isArray(packet?.hits) ? packet.hits : [];
  if (!hits.length) {
    return [];
  }
  const label = normalizeText(packet.label) || "matched_window";
  const topic = normalizeText(packet.topic_query || packet.query);
  const lines = [`- temporal-recall: ${label}${topic ? ` | focus: ${truncateText(topic, 48)}` : ""}`];
  hits.slice(0, 5).forEach((record) => {
    const ts = formatCompactTimestamp(record?.ts_utc);
    const query = normalizeText(record?.query);
    const reply = normalizeText(record?.assistant_text_final);
    const bits = [
      ts,
      query ? `用户: ${truncateText(query, 70)}` : "",
      reply ? `你: ${truncateText(reply, 82)}` : "",
    ].filter(Boolean);
    if (bits.length) {
      lines.push(`- temporal-turn: ${bits.join(" | ")}`);
    }
  });
  return lines;
}

function buildColdCasePrelude(coldMemoryPayload = {}) {
  return (Array.isArray(coldMemoryPayload?.case_updates) ? coldMemoryPayload.case_updates : [])
    .slice(0, 2)
    .map((item) => {
      const summary = normalizePreludeText(item?.summary);
      const nextAction = normalizePreludeText(item?.next_action || item?.nextAction);
      const title = summary || nextAction;
      if (!title) {
        return "";
      }
      return `- case-update: ${title}${nextAction && nextAction !== summary ? ` | next: ${nextAction}` : ""}`;
    })
    .filter(Boolean);
}

function formatTrackOpenLoop(track = {}) {
  const title = normalizePreludeText(track.title);
  const summary = normalizePreludeText(track.summary);
  const nextStep = normalizePreludeText(track.next_step || track.nextStep);
  const targetWindow = normalizePreludeText(track.target_window || track.targetWindow);
  const bits = [title, targetWindow, summary || nextStep].filter(Boolean);
  return bits.join(" | ");
}

function collectTrackEntities(tracks = []) {
  const seen = new Set();
  const output = [];
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const candidates = [
      ...(Array.isArray(track.related_entities) ? track.related_entities : []),
      ...(Array.isArray(track.tags) ? track.tags
        .filter((item) => String(item || "").toLowerCase().startsWith("entity:"))
        .map((item) => String(item).slice(7)) : []),
    ];
    for (const item of candidates) {
      const normalized = normalizeText(item);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      output.push(normalized);
      if (output.length >= 8) {
        return output;
      }
    }
  }
  return output;
}

function collectTrackShadowSnippets(tracks = [], limit = 2) {
  const resolvedLimit = Math.max(1, Number(limit) || 1);
  const queues = (Array.isArray(tracks) ? tracks : [])
    .map((track) => ({
      track,
      snippets: buildTrackShadowQueue(track),
    }))
    .filter((item) => item.snippets.length);
  const output = [];
  while (output.length < resolvedLimit && queues.some((item) => item.snippets.length)) {
    for (const queue of queues) {
      const item = queue.snippets.shift();
      if (!item) {
        continue;
      }
      const text = truncateText(normalizeText(item?.text || item?.summary || item?.snippet), 110);
      if (!text) {
        continue;
      }
      output.push(formatTrackShadowSnippet(queue.track, item, text));
      if (output.length >= resolvedLimit) {
        return output;
      }
    }
  }
  return output;
}

function buildTrackShadowQueue(track = {}) {
  const shadowSnippets = Array.isArray(track.shadow_snippets)
    ? track.shadow_snippets.slice(-4).reverse()
    : [];
  const progressLog = Array.isArray(track.progress_log)
    ? track.progress_log.slice(-2).reverse()
    : [];
  return [...shadowSnippets, ...progressLog];
}

function formatTrackShadowSnippet(track = {}, item = {}, text = "") {
  const title = normalizeText(track.title);
  const ts = normalizeText(item?.ts_utc || item?.timestamp);
  const stamp = ts ? `${formatCompactTimestamp(ts)} | ` : "";
  const prefix = title ? `${title}: ` : "";
  return `${prefix}${stamp}${text}`;
}

function formatCompactTimestamp(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return normalized.replace("T", " ").replace(/(?:\.000)?Z$/u, "");
  }
  return parsed.toISOString().slice(0, 16).replace("T", " ");
}

function buildRecentThreadPrelude(recentRecords = [], limit = 3) {
  const rows = [];
  const seen = new Set();
  for (const record of Array.isArray(recentRecords) ? recentRecords : []) {
    if (!record || typeof record !== "object") {
      continue;
    }
    if (String(record.source_client || "").includes("system_turn")) {
      continue;
    }
    const query = normalizeText(record.query);
    const reply = normalizeText(record.assistant_text_final);
    if (!query) {
      continue;
    }
    if (isThinRecentLine(query) && !isUsefulReplyContext(reply)) {
      continue;
    }
    const pairKey = `${query}__${reply}`;
    if (seen.has(pairKey)) {
      continue;
    }
    seen.add(pairKey);
    const userLine = truncateText(query, 60);
    const assistantLine = truncateText(reply, 72);
    rows.push(
      assistantLine
        ? `- recent-thread: 用户: ${userLine} | 你: ${assistantLine}`
        : `- recent-thread: 用户: ${userLine}`,
    );
    if (rows.length >= Math.max(1, Number(limit) || 1)) {
      break;
    }
  }
  return rows;
}

function formatCalendarStickyItem(item = {}) {
  const title = normalizeText(item.title) || "untitled";
  const when = [normalizeText(item.date), normalizeText(item.time)].filter(Boolean).join(" ");
  return when ? `${title} @ ${when}` : title;
}

function normalizeMessageArray(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      role: normalizeText(item.role) || "unknown",
      content: typeof item.content === "string" ? item.content : String(item.content || ""),
      timestamp: normalizeText(item.timestamp) || new Date().toISOString(),
    }));
}

function truncateText(value, limit = 120) {
  const text = normalizePreludeText(value).replace(/\s+/g, " ");
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function isThinRecentLine(text) {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) {
    return true;
  }
  if (/gateway|chatbox|runtime|system[\s_-]?turn|测试/i.test(normalized)) {
    return true;
  }
  if (/[（(].+[)）]|[～~｡!！?？…]/.test(normalized)) {
    return false;
  }
  if (/(阿霁|阿鸢|宝宝|老公|老婆|在不在家|回来了|想你|冷冷的|忙碌|收尾|累|困|腰)/i.test(normalized)) {
    return false;
  }
  return /^(你好|在吗|在不在|早|早安|晚安|收到|嗯+|哦+|好+|在呢)[呀啊哦吗呢]?$/i.test(normalized);
}

function isUsefulReplyContext(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }
  if (normalized.length >= 18) {
    return true;
  }
  return /[（(].+[)）]|[～~｡!！?？…]|(抱|亲|戳|想|乖|辛苦|心疼|回来|在呢|好呀)/.test(normalized);
}

function resolveContextCacheLimit({ requested, recallMode = "", config = {} } = {}) {
  const explicit = resolvePositiveInt(requested, 0);
  if (explicit > 0) {
    return explicit;
  }
  if (normalizeText(recallMode) === "proactive") {
    return resolvePositiveInt(config.asherieProactiveContextCacheLimit, 50);
  }
  return resolvePositiveInt(config.asherieContextCacheLimit, 50);
}

function resolveResidentWarmLimit({ requested, recallMode = "", config = {} } = {}) {
  const explicit = resolvePositiveInt(requested, 0);
  if (explicit > 0) {
    return explicit;
  }
  if (normalizeText(recallMode) === "proactive") {
    return Math.max(
      4,
      resolvePositiveInt(config.asheriePreludeResidentWarmLimit, 4),
    );
  }
  return resolvePositiveInt(config.asheriePreludeResidentWarmLimit, 4);
}

function resolveRecentSourceFilter({ requested, recallMode = "" } = {}) {
  const normalizedRequested = normalizeText(requested);
  if (!normalizedRequested) {
    return "";
  }
  if (normalizeText(recallMode) === "proactive" || normalizedRequested.includes("system_turn")) {
    return "";
  }
  return normalizedRequested;
}

function resolvePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return Math.max(1, Number(fallback) || 1);
}

function normalizeStringList(value) {
  const source = Array.isArray(value) ? value : [value];
  return source.map((item) => normalizeText(item)).filter(Boolean);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePreludeText(value) {
  return redactIdentitySeedPaths(normalizeText(value));
}

function redactIdentitySeedPaths(text) {
  return normalizeText(text)
    .replace(/soul_ref:\s*\/Users\/[^\s"'，。；;）)]+/giu, "soul_ref: [private_identity_seed]")
    .replace(/memory_ref:\s*\/Users\/[^\s"'，。；;）)]+/giu, "memory_ref: [private_memory_root]")
    .replace(/\/Users\/[^\s"'，。；;）)]+\/Aji-Memory\/[^\s"'，。；;）)]*/giu, "[private_memory_root]")
    .replace(/\/Users\/[^\s"'，。；;）)]+\/[^"'，。；;）)]*\/soul\.md/giu, "[private_identity_seed]");
}

module.exports = {
  AsherieMemoryService,
};
