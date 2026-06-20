const path = require("path");

const { buildColdScope } = require("../asherie/memory-scope");
const { compactMessages } = require("../asherie/context-compactor");
const { ConversationCacheStore } = require("../asherie/conversation-cache-store");
const {
  HotContextStore,
  HotScope,
  UpstreamContextMergeStore,
  buildHotContextPacket,
  buildHotContextPreludeLines,
} = require("../asherie/hot-context-store");
const { WakeupStore } = require("../asherie/wakeup-store");
const { CalendarStore } = require("../asherie/calendar-store");
const { LocalArchiveStore } = require("../asherie/local-archive-store");
const { OngoingTrackStore, isOngoingOverviewQuery } = require("../asherie/ongoing-track-store");
const { ObservationJournalStore } = require("../asherie/observation-journal-store");
const { EpisodeJournalStore, buildEpisodeJournalPacket } = require("../asherie/episode-journal-store");
const { CaseIndexStore } = require("../asherie/case-index-store");
const { SolitudeJournalStore } = require("../asherie/solitude-journal-store");
const { ColdRootStore } = require("../asherie/cold-root-store");
const { MemoryVersionBank, countPayload, normalizePayload } = require("../asherie/memory-version-bank");
const {
  buildGatewayStorageHealth,
  buildGatewayStorageLayout,
  ensureGatewayStorageLayout,
} = require("../asherie/storage-layout");
const {
  buildAgentCharSelfAxisMaterialPacket,
  buildAmbientWarmMemoryPacket,
  buildMemoryRetrievalPacket,
  buildResidentWarmMemoryPacket,
  buildWarmMemoryRuntimePacket,
} = require("../asherie/memory-channels");
const { WarmMemoryScope } = require("../asherie/warm-memory/contracts");
const { WarmMemoryStore } = require("../asherie/warm-memory/store");
const { buildWarmMemoryRecallPacket } = require("../asherie/warm-memory/search");
const { buildRecallFocus } = require("../asherie/recall-focus");
const { resolveMemoryDeliveryProfile } = require("../asherie/memory-delivery-profile");
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
      this.config.asherieDataRoot || path.join(this.config.stateDir || process.cwd(), "mossbridge_data"),
      {
        truthLayerDirOverride: this.config.asherieTruthLayerDir,
        memoryTreeDirOverride: this.config.asherieMemoryTreeDir,
        caseIndexDirOverride: this.config.asherieCaseIndexDir,
        observationJournalDirOverride: this.config.asherieObservationJournalDir,
        episodeJournalDirOverride: this.config.asherieEpisodeJournalDir,
        solitudeJournalDirOverride: this.config.asherieSolitudeJournalDir,
        notebookDirOverride: this.config.notebookDir,
        notionSyncDirOverride: this.config.asherieNotionSyncDir,
        appDailyCaptureDirOverride: this.config.asherieAppDailyCaptureDir,
        warmMemoryDirOverride: this.config.asherieWarmMemoryDir,
        memoryVersionBankDirOverride: this.config.asherieMemoryVersionBankDir,
        runtimeId: this.config.runtime || "codex",
      },
    );
    ensureGatewayStorageLayout(this.layout);
    this.conversationCache = new ConversationCacheStore(this.layout.conversationCacheDir, 10, { identity: this.identity });
    this.localArchiveStore = new LocalArchiveStore(this.layout.rawTranscriptArchiveDir);
    this.wakeupStore = new WakeupStore(this.layout.wakeupStorePath, 300);
    this.calendarStore = new CalendarStore(this.layout.calendarStorePath, 3000);
    this.ongoingTrackStore = new OngoingTrackStore(
      this.layout.ongoingTrackStorePath,
      this.layout.ongoingTrackArchivePath,
      600,
    );
    this.observationJournal = new ObservationJournalStore(this.layout.observationJournalDir, {
      identity: this.identity,
    });
    this.episodeJournal = new EpisodeJournalStore(this.layout.episodeJournalDir, {
      identity: this.identity,
    });
    this.caseIndexStore = new CaseIndexStore(this.layout.caseIndexDir, {
      identity: this.identity,
    });
    this.solitudeJournal = new SolitudeJournalStore(this.layout.solitudeJournalDir, {
      identity: this.identity,
    });
    this.memoryVersionBank = new MemoryVersionBank(this.layout.memoryVersionBankDir, { identity: this.identity });
    this.coldRootStore = new ColdRootStore(this.layout.truthLayerDir, {
      memoryVersionBank: this.memoryVersionBank,
      identity: this.identity,
    });
    this.warmMemoryStore = new WarmMemoryStore(this.layout.warmMemoryDir);
    this.hotUpstreamStore = new UpstreamContextMergeStore(this.layout.hotUpstreamContextDir);
    this.hotContextStore = new HotContextStore({
      basinRoot: this.layout.hotContextBasinDir,
      projectionRoot: this.layout.hotContextProjectionDir,
      snapshotRoot: this.layout.hotContextSnapshotDir,
    });
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
    const runtimeProfile = normalizeText(args.runtime_profile || args.runtimeProfile);
    const proactiveLite = runtimeProfile === "proactive_lite";
    const forceRecentContext = Boolean(args.force_recent_context || args.forceRecentContext);
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
    const focusQuery = buildEffectiveRecallQuery({
      query,
      recentRecords: recent.records,
      recallMode,
      forceRecentContext,
      limit: resolvePositiveInt(
        args.recall_recent_record_limit || args.recallRecentRecordLimit,
        Number(this.config.asherieRecallRecentRecordLimit) || 8,
      ),
    });
    const recallFocus = buildRecallFocus({
      query: focusQuery,
      recentRecords: recent.records,
      recentRecordLimit: resolvePositiveInt(
        args.recall_recent_record_limit || args.recallRecentRecordLimit,
        Number(this.config.asherieRecallRecentRecordLimit) || 8,
      ),
    });
    const deliveryProfile = resolveMemoryDeliveryProfile({
      query,
      recallFocus,
      recallMode,
      runtimeProfile,
      forceRecentContext,
    });
    const temporalPlan = deliveryProfile.include_temporal
      ? buildTemporalRecallPlan({
          query,
          referenceTime: args.received_at || args.receivedAt || args.ts_utc || args.timestamp,
          limit: resolvePositiveInt(
            args.temporal_recall_limit || args.temporalRecallLimit,
            Number(this.config.asherieTemporalRecallLimit) || 8,
          ),
        })
      : null;
    const temporalRows = temporalPlan?.should_recall
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
    const recallQuery = normalizeText(recallFocus.recall_query || focusQuery || query);
    const hotContextPacket = this.buildHotContextRuntimePacket(scopes, {
      query: recallQuery,
      upstreamLimit: resolvePositiveInt(
        args.prelude_hot_upstream_limit || args.preludeHotUpstreamLimit,
        Number(this.config.asheriePreludeHotUpstreamLimit) || 4,
      ),
      turnLimit: resolvePositiveInt(
        args.prelude_hot_turn_limit || args.preludeHotTurnLimit,
        Number(this.config.asheriePreludeHotTurnLimit) || 6,
      ),
      snapshotLimit: resolvePositiveInt(
        args.prelude_hot_snapshot_limit || args.preludeHotSnapshotLimit,
        Number(this.config.asheriePreludeHotSnapshotLimit) || 2,
      ),
    });
    const calendarPacket = this.calendarStore.summarizeForWakeup(scopes.scopedUserId, new Date());
    const wakeupPacket = buildWakeupRuntimePacket(this.wakeupStore, scopes.scopedUserId);
    const ongoingQuery = normalizeText(recallMode) === "proactive"
      ? recallQuery
      : (forceRecentContext ? recallQuery : normalizeText(query));
    const warmMemoryPacket = deliveryProfile.include_warm
      ? buildWarmMemoryRuntimePacket(this.warmMemoryStore, scopes.warmScope, {
          query: recallQuery,
          limit: Number(args.limit) || 6,
          materialTypes: normalizeStringList(args.material_types || args.materialTypes),
          recallMode,
          recallConfig: args.recall_config || args.recallConfig || {},
        })
      : emptyWarmMemoryRuntimePacket(scopes.warmScope, recallQuery, "warm_delivery_suppressed");
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
    const ambientWarmPacket = deliveryProfile.include_ambient_warm
      ? buildAmbientWarmMemoryPacket(this.warmMemoryStore, scopes.warmScope, {
          limit: resolveAmbientWarmLimit({
            requested: args.ambient_limit ?? args.ambientLimit ?? this.config.asheriePreludeAmbientWarmLimit,
            recallMode,
            config: this.config,
          }),
          materialTypes: normalizeStringList(args.material_types || args.materialTypes),
          excludeMaterialIds: [
            ...(Array.isArray(warmMemoryPacket?.hits) ? warmMemoryPacket.hits.map((item) => item?.material_id) : []),
            ...(Array.isArray(residentWarmPacket?.hits) ? residentWarmPacket.hits.map((item) => item?.material_id) : []),
          ],
        })
      : emptyWarmMemoryRuntimePacket(scopes.warmScope, recallQuery, "ambient_warm_delivery_suppressed");
    const ongoingTrackPacket = deliveryProfile.include_ongoing
      ? this.buildOngoingTrackRuntimePacket(scopes.scopedUserId, {
          query: ongoingQuery,
          includeZeroScore: shouldIncludeZeroScoreOngoingTracks(ongoingQuery, recallMode),
          limit: resolvePositiveInt(
            args.prelude_ongoing_limit || args.preludeOngoingLimit,
            Number(this.config.asheriePreludeOngoingLimit) || 4,
          ),
          shadowLimit: resolvePositiveInt(
            args.prelude_ongoing_shadow_limit || args.preludeOngoingShadowLimit,
            Number(this.config.asheriePreludeOngoingShadowLimit) || 6,
          ),
        })
      : emptyOngoingTrackPacket(scopes.scopedUserId, ongoingQuery, "ongoing_track_delivery_suppressed");
    const observationJournalPacket = deliveryProfile.include_observation
      ? this.buildObservationJournalRuntimePacket(scopes.scopedUserId, {
          query: recallQuery,
          limit: resolvePositiveInt(
            args.prelude_observation_limit || args.preludeObservationLimit,
            Number(this.config.asheriePreludeObservationLimit) || 4,
          ),
          minScore: resolveNonNegativeNumber(
            args.observation_min_score ?? args.observationMinScore,
            Number(deliveryProfile.observation_min_score) || 0,
          ),
        })
      : emptyObservationJournalPacket(scopes.scopedUserId, recallQuery, "observation_journal_delivery_suppressed");
    const episodeJournalPacket = deliveryProfile.include_episode
      ? this.buildEpisodeJournalRuntimePacket(scopes.scopedUserId, {
          query: recallQuery,
          limit: resolvePositiveInt(
            args.prelude_episode_limit || args.preludeEpisodeLimit,
            Number(this.config.asheriePreludeEpisodeLimit) || 3,
          ),
          minScore: resolvePositiveInt(
            args.episode_min_score || args.episodeMinScore,
            Number(deliveryProfile.episode_min_score) || 4,
          ),
        })
      : emptyEpisodeJournalPacket(scopes.scopedUserId, recallQuery, "episode_journal_delivery_suppressed");
    const solitudeJournalPacket = shouldIncludeSolitudeDigestForTurn({
      query: recallQuery,
      recallMode,
      runtimeProfile,
      requested: args.include_solitude_digest ?? args.includeSolitudeDigest,
    })
      ? this.buildSolitudeJournalRuntimePacket(scopes.scopedUserId, {
          query: recallQuery,
          recentLimit: resolvePositiveInt(
            args.prelude_solitude_recent_limit || args.preludeSolitudeRecentLimit,
            Number(this.config.asheriePreludeSolitudeRecentLimit) || 2,
          ),
          patternLimit: resolvePositiveInt(
            args.prelude_solitude_pattern_limit || args.preludeSolitudePatternLimit,
            Number(this.config.asheriePreludeSolitudePatternLimit) || 3,
          ),
          candidateLimit: resolvePositiveInt(
            args.prelude_solitude_candidate_limit || args.preludeSolitudeCandidateLimit,
            Number(this.config.asheriePreludeSolitudeCandidateLimit) || 2,
          ),
        })
      : {
          ok: true,
          scoped_user_id: scopes.scopedUserId,
          query: recallQuery,
          total_scanned: 0,
          hit_count: 0,
          recent_notes: [],
          recurring_patterns: { tags: [], lessons: [], next_actions: [] },
          promotion_candidates: [],
          summary: "",
          policy: "Solitude digest is only carried for wakeup/maintenance or explicit self-review queries.",
        };
    const agentCharSelfAxisMaterialPacket = buildAgentCharSelfAxisMaterialPacket({
      residentWarmPacket,
      ambientWarmPacket,
      warmMemoryPacket,
      limit: resolvePositiveInt(
        args.prelude_self_axis_material_limit || args.preludeSelfAxisMaterialLimit,
        Number(this.config.asheriePreludeSelfAxisMaterialLimit) || 4,
      ),
    });
    const currentTurnSignals = normalizeCurrentTurnSignals(args.current_turn_signals || args.currentTurnSignals || {});

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
    const shouldSearchColdRoots = deliveryProfile.include_cold && !proactiveLite && shouldSearchColdRootsForTurn({
      query: recallQuery,
      recallFocus,
      recallMode,
    });

    const coldRootPacket = shouldSearchColdRoots
      ? this.coldRootStore.searchRoots({
          userId: scopes.resolvedUserId,
          realmId: scopes.coldScope.realm_id,
          agentId: scopes.coldScope.agent_id,
          query: recallQuery,
          limit: Number(args.cold_limit || args.coldLimit) || 2,
          minScore: recallFocus?.explicit_recall_signal || recallFocus?.used_recent_context ? 1 : 2,
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
    const localArchivePacket = shouldSearchLocalArchiveFallback({
      query: recallQuery,
      proactiveLite,
      shouldSearchColdRoots,
      coldRootPacket,
    })
      ? this.localArchiveStore.search(scopes.warmScope, {
          scopedUserId: scopes.scopedUserId,
          query: recallQuery,
          limit: resolvePositiveInt(
            args.prelude_local_archive_limit || args.preludeLocalArchiveLimit,
            Number(this.config.asheriePreludeLocalArchiveLimit) || 2,
          ),
          minScore: recallFocus?.explicit_recall_signal || recallFocus?.used_recent_context ? 1 : 2,
        })
      : buildEmptyLocalArchivePacket(scopes.warmScope, recallQuery, "local_archive_suppressed");
    const retrieval = buildMemoryRetrievalPacket({
      mode: "mossbridge_context_packet",
      warmMemoryPacket,
      residentWarmPacket,
      ambientWarmPacket,
      episodeJournalPacket,
      observationJournalPacket,
      solitudeJournalPacket,
      agentCharSelfAxisMaterialPacket,
      curatedHits: [],
      liteFallbackHits: localArchivePacket.hits,
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
    retrieval.delivery_profile = deliveryProfile;
    const runtimePrelude = buildRuntimePrelude({
      recallFocus,
      warmMemoryPacket,
      residentWarmPacket,
      ambientWarmPacket,
      coldMemoryVersion,
      coldMemoryPayload,
      coldSource,
      coldRootPacket,
      coldVinePacket,
      localArchivePacket,
      temporalRecallPacket,
      hotContextPacket,
      ongoingTrackPacket,
      episodeJournalPacket,
      observationJournalPacket,
      solitudeJournalPacket,
      agentCharSelfAxisMaterialPacket,
      recallMode,
      forceRecentContext,
      currentTurnSignals,
      recentRecords: recent.records,
      calendarPacket,
      wakeupPacket,
      includeGuidance: args.include_runtime_prelude_guidance ?? args.includeRuntimePreludeGuidance ?? false,
      preludeWarmLimit: resolvePositiveInt(
        args.prelude_warm_limit || args.preludeWarmLimit,
        Number(this.config.asheriePreludeWarmLimit) || 5,
      ),
      preludeResidentWarmLimit: resolvePositiveInt(
        args.prelude_resident_warm_limit || args.preludeResidentWarmLimit,
        Number(this.config.asheriePreludeResidentWarmLimit) || 4,
      ),
      preludeAmbientWarmLimit: resolvePositiveInt(
        args.prelude_ambient_warm_limit || args.preludeAmbientWarmLimit,
        Number(this.config.asheriePreludeAmbientWarmLimit) || 4,
      ),
      preludeOngoingLimit: resolvePositiveInt(
        args.prelude_ongoing_limit || args.preludeOngoingLimit,
        Number(this.config.asheriePreludeOngoingLimit) || 4,
      ),
      preludeEpisodeLimit: resolvePositiveInt(
        args.prelude_episode_limit || args.preludeEpisodeLimit,
        Number(this.config.asheriePreludeEpisodeLimit) || 3,
      ),
      preludeOngoingShadowLimit: resolvePositiveInt(
        args.prelude_ongoing_shadow_limit || args.preludeOngoingShadowLimit,
        Number(this.config.asheriePreludeOngoingShadowLimit) || 6,
      ),
      preludeObservationLimit: resolvePositiveInt(
        args.prelude_observation_limit || args.preludeObservationLimit,
        Number(this.config.asheriePreludeObservationLimit) || 4,
      ),
      preludeSolitudeLimit: resolvePositiveInt(
        args.prelude_solitude_limit || args.preludeSolitudeLimit,
        Number(this.config.asheriePreludeSolitudeLimit) || 3,
      ),
      preludeRecentSnippetLimit: resolvePositiveInt(
        args.prelude_recent_snippet_limit || args.preludeRecentSnippetLimit,
        Number(this.config.asheriePreludeRecentSnippetLimit) || 4,
      ),
      preludeRecentThreadLimit: resolvePositiveInt(
        args.prelude_recent_thread_limit || args.preludeRecentThreadLimit,
        Number(this.config.asheriePreludeRecentThreadLimit) || 3,
      ),
      preludeLocalArchiveLimit: resolvePositiveInt(
        args.prelude_local_archive_limit || args.preludeLocalArchiveLimit,
        Number(this.config.asheriePreludeLocalArchiveLimit) || 2,
      ),
    });

    return {
      ok: true,
      runtime_profile: runtimeProfile || "default",
      user_id: scopes.resolvedUserId,
      scoped_user_id: scopes.scopedUserId,
      cold_scope: scopes.coldScope,
      warm_scope_id: scopes.warmScope.scopeId(),
      recall_focus: recallFocus,
      delivery_profile: deliveryProfile,
      warm_memory_packet: warmMemoryPacket,
      resident_warm_packet: residentWarmPacket,
      ambient_warm_packet: ambientWarmPacket,
      ongoing_track_packet: ongoingTrackPacket,
      episode_journal_packet: episodeJournalPacket,
      episode_attention: buildEpisodeAttentionPacket(episodeJournalPacket, currentTurnSignals),
      observation_journal_packet: observationJournalPacket,
      solitude_journal_packet: solitudeJournalPacket,
      agent_char_self_axis_material_packet: agentCharSelfAxisMaterialPacket,
      temporal_recall_packet: {
        ...temporalRecallPacket,
        stats: temporalRows.stats,
      },
      hot_context_packet: hotContextPacket,
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
      local_archive_packet: localArchivePacket,
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
      source_client: normalizeText(args.source_client || args.sourceClient) || "mossbridge_wechat",
      source_user_agent: normalizeText(args.source_user_agent || args.sourceUserAgent || args.account_id || args.accountId),
      user_id: scopes.resolvedUserId,
      scoped_user_id: scopes.scopedUserId,
      route_id: normalizeText(args.route_id || args.routeId) || "mossbridge_wechat",
      transport_id: normalizeText(args.transport_id || args.transportId) || "weixin",
      runtime_id: normalizeText(args.runtime_id || args.runtimeId) || "codex",
      channel_id: normalizeText(args.channel_id || args.channelId) || "weixin",
      endpoint_id: normalizeText(args.endpoint_id || args.endpointId) || "wechat_runtime_turn",
      thread_id: normalizeText(args.thread_id || args.threadId),
      model: normalizeText(args.model),
      latency_ms: Number(args.latency_ms || args.latencyMs) || 0,
      query,
      assistant_text_final: assistantTextFinal,
      retrieval_mode: normalizeText(retrieval.mode) || "mossbridge_context_packet",
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
      ambient_warm: args.memory_context_packet?.ambient_warm_packet
        || args.memoryContextPacket?.ambient_warm_packet
        || args.ambient_warm
        || args.ambientWarm
        || {},
      ongoing_track: args.memory_context_packet?.ongoing_track_packet
        || args.memoryContextPacket?.ongoing_track_packet
        || args.ongoing_track
        || args.ongoingTrack
        || {},
      episode_journal: args.memory_context_packet?.episode_journal_packet
        || args.memoryContextPacket?.episode_journal_packet
        || args.episode_journal
        || args.episodeJournal
        || {},
      observation_journal: args.memory_context_packet?.observation_journal_packet
        || args.memoryContextPacket?.observation_journal_packet
        || args.observation_journal
        || args.observationJournal
        || {},
      agent_char_self_axis_material: args.memory_context_packet?.agent_char_self_axis_material_packet
        || args.memoryContextPacket?.agent_char_self_axis_material_packet
        || args.agent_char_self_axis_material
        || args.agentCharSelfAxisMaterial
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
    const archivedTurnEvidence = this.localArchiveStore.upsertTurnEvidence(scopes.warmScope, {
      scopedUserId: scopes.scopedUserId,
      record: {
        ...record,
        record_id: appendResult.record_id,
      },
      memoryContextPacket: args.memory_context_packet || args.memoryContextPacket || null,
    });

    const warmMemoryWrite = this.applyWarmMemoryWritePayloads(
      scopes.warmScope,
      args.warm_memory_write || args.warmMemoryWrite || [],
      { scopedUserId: scopes.scopedUserId },
    );
    const coldMemoryWrite = this.applyColdMemoryWrite(scopes, args);
    const calendarWrite = this.applyCalendarWrite(scopes.scopedUserId, args.calendar_items || args.calendarItems || args.calendar_write_items || []);
    const wakeupWrite = this.applyWakeupWrite(scopes.scopedUserId, args.wakeup_record || args.wakeupRecord);

    return {
      ok: true,
      user_id: scopes.resolvedUserId,
      scoped_user_id: scopes.scopedUserId,
      appended_record: appendResult,
      local_archive_write: archivedTurnEvidence,
      warm_memory_write: warmMemoryWrite,
      cold_memory_write: coldMemoryWrite,
      calendar_write: calendarWrite,
      wakeup_write: wakeupWrite,
    };
  }

  async writeWarmMaterial(args = {}) {
    const scopes = this.resolveScopes(args);
    const stored = this.warmMemoryStore.upsertMaterial(scopes.warmScope, args);
    const archive = this.localArchiveStore.upsertWarmMaterial(scopes.warmScope, stored, {
      scopedUserId: scopes.scopedUserId,
      sourceRecord: buildArchiveSourceRecordFromArgs(args),
    });
    return {
      ok: true,
      scope_id: scopes.warmScope.scopeId(),
      record: stored,
      local_archive: compactLocalArchiveWrite(archive),
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
    const updatePayload = {
      ...existing,
      ...args,
      material_id: materialId,
    };
    if (
      hasWarmSourceBinding(args)
      && !Object.prototype.hasOwnProperty.call(args, "source_backfill_required")
      && !Object.prototype.hasOwnProperty.call(args, "sourceBackfillRequired")
    ) {
      updatePayload.source_backfill_required = false;
      updatePayload.source_status = normalizeText(args.source_status || args.sourceStatus) || "bound";
      if (
        !Object.prototype.hasOwnProperty.call(args, "dreaming_review_required")
        && !Object.prototype.hasOwnProperty.call(args, "dreamingReviewRequired")
      ) {
        updatePayload.dreaming_review_required = false;
      }
    }
    const stored = this.warmMemoryStore.upsertMaterial(scopes.warmScope, updatePayload);
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

  async upsertEpisode(args = {}) {
    const scopes = this.resolveScopes(args);
    const stored = this.episodeJournal.upsert(scopes.scopedUserId, args);
    return {
      ok: true,
      scoped_user_id: scopes.scopedUserId,
      record: stored,
    };
  }

  async appendEpisodeEntry(args = {}) {
    const scopes = this.resolveScopes(args);
    const episodeId = normalizeText(args.episode_id || args.episodeId);
    if (!episodeId) {
      throw new Error("episode_id is required");
    }
    const entry = this.episodeJournal.appendEntry(scopes.scopedUserId, episodeId, args.entry && typeof args.entry === "object" ? args.entry : args);
    return {
      ok: true,
      scoped_user_id: scopes.scopedUserId,
      episode_id: episodeId,
      entry,
      record: this.episodeJournal.get(scopes.scopedUserId, episodeId),
    };
  }

  async listEpisodes(args = {}) {
    const scopes = this.resolveScopes(args);
    const items = this.episodeJournal.list(scopes.scopedUserId, {
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

  async readEpisode(args = {}) {
    const scopes = this.resolveScopes(args);
    const episodeId = normalizeText(args.episode_id || args.episodeId);
    if (!episodeId) {
      throw new Error("episode_id is required");
    }
    const record = this.episodeJournal.get(scopes.scopedUserId, episodeId, {
      includeEntries: args.include_entries !== false && args.includeEntries !== false,
      limit: Number(args.limit) || 200,
    });
    return {
      ok: Boolean(record),
      scoped_user_id: scopes.scopedUserId,
      episode_id: episodeId,
      record,
      error: record ? "" : `episode not found: ${episodeId}`,
    };
  }

  async upsertCase(args = {}) {
    const scopes = this.resolveScopes(args);
    const stored = this.caseIndexStore.upsert(scopes.scopedUserId, {
      ...args,
      owner_id: scopes.coldScope.owner_id,
      realm_id: scopes.coldScope.realm_id,
      agent_id: scopes.coldScope.agent_id,
    });
    return {
      ok: true,
      scoped_user_id: scopes.scopedUserId,
      record: stored,
    };
  }

  async appendSolitudeEntry(args = {}) {
    const scopedUserId = canonicalScopedUserId(args.userId || args.scoped_user_id || args.scopedUserId, this.identity);
    return this.solitudeJournal.append(scopedUserId, {
      ...args,
      user_id: args.user_id || args.userId || this.identity.userId,
      realm_id: args.realm_id || args.realmId || this.identity.realmId,
      agent_id: args.agent_id || args.agentId || this.identity.agentId,
    });
  }

  async searchSolitudeEntries(args = {}) {
    const scopedUserId = canonicalScopedUserId(args.userId || args.scoped_user_id || args.scopedUserId, this.identity);
    return this.solitudeJournal.search(scopedUserId, args);
  }

  async appendWakeupDecision(args = {}) {
    const scopedUserId = canonicalScopedUserId(args.userId || args.scoped_user_id || args.scopedUserId, this.identity);
    const record = this.wakeupStore.append({
      ...args,
      scoped_user_id: scopedUserId,
      user_id: normalizeText(args.user_id || args.userId) || this.identity.userId,
      realm_id: normalizeText(args.realm_id || args.realmId) || this.identity.realmId,
      agent_id: normalizeText(args.agent_id || args.agentId) || this.identity.agentId,
      decision: normalizeWakeupDecision(args.decision),
      wake_motive: normalizeText(args.wake_motive || args.wakeMotive || args.motive),
      intent_summary: normalizeText(args.intent_summary || args.intentSummary || args.summary),
      actions_taken: normalizeStringList(args.actions_taken || args.actionsTaken),
      next_actions: normalizeStringList(args.next_actions || args.nextActions),
      budget_posture: normalizeText(args.budget_posture || args.budgetPosture),
      contact_channel: normalizeText(args.contact_channel || args.contactChannel),
      context_key: normalizeText(args.context_key || args.contextKey),
      chain_of_thought_policy: "Store concise, shareable wakeup outcomes and visible evidence; keep raw hidden chain-of-thought out of persisted records.",
    });
    return {
      ok: true,
      scoped_user_id: scopedUserId,
      record,
    };
  }

  async listWakeupDecisions(args = {}) {
    const scopedUserId = canonicalScopedUserId(args.userId || args.scoped_user_id || args.scopedUserId, this.identity);
    const limit = Math.max(1, Math.min(Number(args.limit) || 6, 50));
    const includeCleared = args.include_cleared === true || args.includeCleared === true;
    const records = (this.wakeupStore?.recent(scopedUserId, limit, includeCleared) || [])
      .map(compactWakeupDecisionRecord);
    return {
      ok: true,
      scoped_user_id: scopedUserId,
      count: records.length,
      latest: records[0] || null,
      pending_next_actions: collectWakeupNextActions(records),
      records,
      policy: "Use wakeup decisions as a backstage agenda and continuity trace. Front-stage voice still comes from the current relationship and context.",
    };
  }

  async appendCaseEvent(args = {}) {
    const scopes = this.resolveScopes(args);
    const caseId = normalizeText(args.case_id || args.caseId);
    if (!caseId) {
      throw new Error("case_id is required");
    }
    const event = this.caseIndexStore.appendEvent(scopes.scopedUserId, caseId, {
      ...args,
      owner_id: scopes.coldScope.owner_id,
      realm_id: scopes.coldScope.realm_id,
      agent_id: scopes.coldScope.agent_id,
    });
    return {
      ok: true,
      scoped_user_id: scopes.scopedUserId,
      case_id: caseId,
      event,
      record: this.caseIndexStore.get(scopes.scopedUserId, caseId, scopes.coldScope),
    };
  }

  async linkCaseArtifact(args = {}) {
    const scopes = this.resolveScopes(args);
    const caseId = normalizeText(args.case_id || args.caseId);
    if (!caseId) {
      throw new Error("case_id is required");
    }
    return this.caseIndexStore.linkArtifact(scopes.scopedUserId, caseId, {
      ...args,
      owner_id: scopes.coldScope.owner_id,
      realm_id: scopes.coldScope.realm_id,
      agent_id: scopes.coldScope.agent_id,
    });
  }

  async closeCase(args = {}) {
    const scopes = this.resolveScopes(args);
    const caseId = normalizeText(args.case_id || args.caseId);
    if (!caseId) {
      throw new Error("case_id is required");
    }
    return this.caseIndexStore.close(scopes.scopedUserId, caseId, {
      ...args,
      owner_id: scopes.coldScope.owner_id,
      realm_id: scopes.coldScope.realm_id,
      agent_id: scopes.coldScope.agent_id,
    });
  }

  async searchCases(args = {}) {
    const scopes = this.resolveScopes(args);
    const items = this.caseIndexStore.list(scopes.scopedUserId, {
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

  async readCase(args = {}) {
    const scopes = this.resolveScopes(args);
    const caseId = normalizeText(args.case_id || args.caseId);
    if (!caseId) {
      throw new Error("case_id is required");
    }
    const record = this.caseIndexStore.get(scopes.scopedUserId, caseId, {
      ...scopes.coldScope,
      includeEvents: args.include_events !== false && args.includeEvents !== false,
      limit: Number(args.limit) || 200,
    });
    return {
      ok: Boolean(record),
      scoped_user_id: scopes.scopedUserId,
      case_id: caseId,
      record,
      error: record ? "" : `case not found: ${caseId}`,
    };
  }

  async exportCaseMarkdown(args = {}) {
    const scopes = this.resolveScopes(args);
    const caseId = normalizeText(args.case_id || args.caseId);
    if (!caseId) {
      throw new Error("case_id is required");
    }
    return this.caseIndexStore.exportMarkdown(scopes.scopedUserId, caseId, scopes.coldScope);
  }

  async appendObservation(args = {}) {
    const scopes = this.resolveScopes(args);
    const stored = this.observationJournal.append(scopes.scopedUserId, {
      ...args,
      userId: scopes.resolvedUserId,
      realmId: scopes.coldScope.realm_id,
      agentId: scopes.coldScope.agent_id,
    });
    return stored;
  }

  async searchObservations(args = {}) {
    const scopes = this.resolveScopes(args);
    return this.observationJournal.search(scopes.scopedUserId, args);
  }

  async readObservation(args = {}) {
    const scopes = this.resolveScopes(args);
    const observationId = normalizeText(args.observation_id || args.observationId);
    return this.observationJournal.read(scopes.scopedUserId, observationId);
  }

  async updateObservation(args = {}) {
    const scopes = this.resolveScopes(args);
    return this.observationJournal.update(scopes.scopedUserId, args);
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

  async inspectColdRootDuplicates(args = {}) {
    const scopes = this.resolveScopes(args);
    return this.coldRootStore.inspectDuplicateRoots({
      userId: scopes.resolvedUserId,
      realmId: scopes.coldScope.realm_id,
      agentId: scopes.coldScope.agent_id,
      query: normalizeText(args.query || args.text),
      limit: Number(args.limit) || 8,
      maxRows: Number(args.maxRows || args.max_rows) || 220,
      minScore: Number(args.minScore || args.min_score) || 78,
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
      agentId: normalizeText(args.agent_id || args.agentId) || "moss",
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

  resolveHotScope(args = {}) {
    const scopes = args?.coldScope && args?.warmScope ? args : this.resolveScopes(args);
    return new HotScope({
      ownerId: scopes.coldScope?.owner_id,
      realmId: scopes.coldScope?.realm_id,
      agentId: scopes.coldScope?.agent_id,
      basinId: args.basin_id || args.basinId || "default",
    });
  }

  applyWarmMemoryWritePayloads(scope, payloads, { scopedUserId = "" } = {}) {
    const source = Array.isArray(payloads) ? payloads : [];
    const results = source
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        try {
          const record = this.warmMemoryStore.upsertMaterial(scope, item);
          const archive = this.localArchiveStore.upsertWarmMaterial(scope, record, {
            scopedUserId,
            sourceRecord: buildArchiveSourceRecordFromArgs(item),
          });
          return {
            ok: true,
            record,
            local_archive: compactLocalArchiveWrite(archive),
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

  buildOngoingTrackRuntimePacket(scopedUserId, { query = "", limit = 4, shadowLimit = 6, includeZeroScore = false } = {}) {
    const activeTracks = this.ongoingTrackStore.list(scopedUserId, {
      query,
      statuses: ["active", "blocked", "paused"],
      limit: 24,
    });
    const visibleTracks = collapseOngoingTracksByTitle(activeTracks);
    const overviewQuery = isOngoingOverviewQuery(query);
    const eligibleTracks = normalizeText(query) && !includeZeroScore
      ? visibleTracks.filter((item) => shouldCarryOngoingTrackForQuery(item, { overviewQuery }))
      : visibleTracks;
    const hits = eligibleTracks.slice(0, Math.max(1, Math.min(Number(limit) || 4, 12)));
    const shadowSnippets = collectTrackShadowSnippets(hits, shadowLimit);
    const openLoops = hits
      .map((item) => formatTrackOpenLoop(item))
      .filter(Boolean)
      .slice(0, Math.max(1, Math.min(Number(limit) || 4, 6)));
    const activeEntities = collectTrackEntities(hits).slice(0, 6);
    return {
      count: activeTracks.length,
      deduped_count: visibleTracks.length,
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

  buildObservationJournalRuntimePacket(scopedUserId, { query = "", limit = 4, minScore = 0 } = {}) {
    const packet = this.observationJournal.search(scopedUserId, {
      query,
      limit,
      minScore,
      statuses: ["active", "tentative"],
    });
    return {
      ...packet,
      hit_count: Number(packet.count) || 0,
      summary: [
        packet.count ? `observations=${packet.count}` : "",
        normalizeText(query) ? `focus=${truncateText(query, 48)}` : "",
      ].filter(Boolean).join(" | "),
    };
  }

  buildEpisodeJournalRuntimePacket(scopedUserId, { query = "", limit = 3, minScore = 4 } = {}) {
    return buildEpisodeJournalPacket(this.episodeJournal, scopedUserId, {
      query,
      limit,
      statuses: ["active", "settled"],
      minScore,
    });
  }

  buildSolitudeJournalRuntimePacket(scopedUserId, {
    query = "",
    recentLimit = 2,
    patternLimit = 3,
    candidateLimit = 2,
  } = {}) {
    return this.solitudeJournal.buildDigest(scopedUserId, {
      query,
      recentLimit,
      patternLimit,
      candidateLimit,
      minRepeat: 2,
    });
  }

  buildHotContextRuntimePacket(scopes, {
    query = "",
    upstreamLimit = 4,
    turnLimit = 6,
    snapshotLimit = 2,
  } = {}) {
    return buildHotContextPacket({
      scope: this.resolveHotScope(scopes),
      upstreamStore: this.hotUpstreamStore,
      hotContextStore: this.hotContextStore,
      query,
      upstreamLimit,
      turnLimit,
      snapshotLimit,
    });
  }
}

function shouldCarryOngoingTrackForQuery(item = {}, { overviewQuery = false } = {}) {
  const score = Number(item?.query_score) || 0;
  if (score >= 5) {
    return true;
  }
  return Boolean(overviewQuery && normalizeText(item?.status) !== "done" && normalizeText(item?.status) !== "archived");
}

function collapseOngoingTracksByTitle(tracks = []) {
  const grouped = new Map();
  const order = [];
  for (const track of Array.isArray(tracks) ? tracks : []) {
    if (!track || typeof track !== "object") {
      continue;
    }
    const key = buildOngoingTrackGroupKey(track);
    if (!grouped.has(key)) {
      grouped.set(key, track);
      order.push(key);
      continue;
    }
    const current = grouped.get(key);
    if (shouldPreferOngoingTrackCandidate(track, current)) {
      grouped.set(key, track);
    }
  }
  return order.map((key) => grouped.get(key)).filter(Boolean);
}

function buildOngoingTrackGroupKey(track = {}) {
  const title = normalizeText(track.title).replace(/\s+/g, " ").toLowerCase();
  if (title) {
    return `title:${title}`;
  }
  return `track:${normalizeText(track.track_id) || fallbackOngoingTrackKey(track)}`;
}

function fallbackOngoingTrackKey(track = {}) {
  return [
    normalizeText(track.summary),
    normalizeText(track.target_window || track.targetWindow),
    normalizeText(track.next_step || track.nextStep),
  ].filter(Boolean).join("|") || "unknown";
}

function shouldPreferOngoingTrackCandidate(candidate = {}, current = {}) {
  const candidateSparse = isSparseOngoingTrack(candidate);
  const currentSparse = isSparseOngoingTrack(current);
  if (candidateSparse !== currentSparse) {
    return !candidateSparse;
  }
  const candidateTime = rankOngoingTrackFreshness(candidate);
  const currentTime = rankOngoingTrackFreshness(current);
  if (candidateTime !== currentTime) {
    return candidateTime > currentTime;
  }
  const candidateScore = Number(candidate.query_score) || 0;
  const currentScore = Number(current.query_score) || 0;
  if (candidateScore !== currentScore) {
    return candidateScore > currentScore;
  }
  return normalizeText(candidate.track_id) > normalizeText(current.track_id);
}

function isSparseOngoingTrack(track = {}) {
  return ![
    track.summary,
    track.target_window || track.targetWindow,
    track.next_step || track.nextStep,
    ...(Array.isArray(track.shadow_snippets) ? track.shadow_snippets : []),
    ...(Array.isArray(track.progress_log) ? track.progress_log : []),
  ].some((item) => {
    if (item && typeof item === "object") {
      return normalizeText(item.text || item.summary || item.snippet);
    }
    return normalizeText(item);
  });
}

function rankOngoingTrackFreshness(track = {}) {
  const raw = normalizeText(track.last_touched_at || track.lastTouchedAt || track.updated_at || track.updatedAt || track.created_at || track.createdAt);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildEffectiveRecallQuery({
  query = "",
  recentRecords = [],
  recallMode = "",
  forceRecentContext = false,
  limit = 4,
} = {}) {
  const base = normalizeText(query);
  if (!forceRecentContext && normalizeText(recallMode) !== "proactive") {
    return base;
  }
  const rowLimit = forceRecentContext
    ? Math.max(12, Number(limit) || 4)
    : Math.max(2, Number(limit) || 4);
  const rows = [];
  for (const record of Array.isArray(recentRecords) ? recentRecords : []) {
    if (String(record?.source_client || "").includes("system_turn")) {
      continue;
    }
    const userLine = normalizeText(record?.query);
    const assistantLine = normalizeText(record?.assistant_text_final);
    if (userLine && !isThinRecentLine(userLine)) {
      rows.push(userLine);
    }
    if (assistantLine && isUsefulReplyContext(assistantLine)) {
      rows.push(assistantLine);
    }
    if (rows.length >= rowLimit) {
      break;
    }
  }
  const seed = rows
    .reverse()
    .map((item) => truncateText(item, 96))
    .join(" ")
    .trim();
  if (!seed) {
    return base;
  }
  return truncateText([base, seed].filter(Boolean).join(" "), 420);
}

function buildRuntimePrelude({
  recallFocus,
  recallMode,
  warmMemoryPacket,
  residentWarmPacket,
  ambientWarmPacket,
  ongoingTrackPacket,
  episodeJournalPacket,
  observationJournalPacket,
  solitudeJournalPacket,
  agentCharSelfAxisMaterialPacket,
  currentTurnSignals,
  coldMemoryVersion,
  coldMemoryPayload,
  coldSource,
  coldRootPacket,
  coldVinePacket,
  localArchivePacket,
  temporalRecallPacket,
  hotContextPacket,
  forceRecentContext = false,
  recentRecords,
  calendarPacket,
  wakeupPacket,
  preludeWarmLimit = 5,
  preludeResidentWarmLimit = 4,
  preludeAmbientWarmLimit = 4,
  preludeOngoingLimit = 4,
  preludeEpisodeLimit = 3,
  preludeOngoingShadowLimit = 2,
  preludeObservationLimit = 4,
  preludeSolitudeLimit = 3,
  preludeLocalArchiveLimit = 2,
  preludeRecentSnippetLimit = 4,
  preludeRecentThreadLimit = 3,
  includeGuidance = false,
}) {
  const lines = [];
  const warmHits = Array.isArray(warmMemoryPacket?.hits) ? warmMemoryPacket.hits : [];
  const residentWarmHits = Array.isArray(residentWarmPacket?.hits) ? residentWarmPacket.hits : [];
  const ambientWarmHits = Array.isArray(ambientWarmPacket?.hits) ? ambientWarmPacket.hits : [];
  const coldRootHits = Array.isArray(coldRootPacket?.hits) ? coldRootPacket.hits : [];
  const coldVineRoots = Array.isArray(coldVinePacket?.related_roots) ? coldVinePacket.related_roots : [];
  const localArchiveHits = Array.isArray(localArchivePacket?.hits) ? localArchivePacket.hits : [];
  const includeRecentContext = forceRecentContext || shouldIncludeRecentContextPrelude(recallFocus, recallMode);
  const proactiveRecentStateLines = buildProactiveRecentStatePrelude(recentRecords, recallMode);
  const sessionHandoffLines = forceRecentContext && normalizeText(recallMode) !== "proactive"
    ? buildSessionHandoffPrelude(recentRecords)
    : [];
  if (includeGuidance !== false) {
    ensurePreludeHeader(lines);
    lines.push(...buildMemorySelfMaintenancePrelude(recallFocus));
  }
  if (proactiveRecentStateLines.length) {
    ensurePreludeHeader(lines);
    lines.push(...proactiveRecentStateLines);
  }
  if (sessionHandoffLines.length) {
    ensurePreludeHeader(lines);
    lines.push(...sessionHandoffLines);
  }
  const hotContextLines = buildHotContextPreludeLines(hotContextPacket, 4);
  if (hotContextLines.length) {
    ensurePreludeHeader(lines);
    lines.push(...hotContextLines);
  }
  if (residentWarmHits.length) {
    ensurePreludeHeader(lines);
    residentWarmHits.slice(0, preludeResidentWarmLimit).forEach((hit) => {
      const title = normalizePreludeText(hit.title) || normalizePreludeText(hit.material_id) || "untitled";
      const summary = normalizePreludeText(hit.summary || hit.snippet);
      lines.push(`- resident-anchor: ${title}${summary ? ` | ${summary}` : ""}`);
    });
  }
  if (ambientWarmHits.length) {
    ensurePreludeHeader(lines);
    ambientWarmHits.slice(0, preludeAmbientWarmLimit).forEach((hit) => {
      const title = normalizePreludeText(hit.title) || normalizePreludeText(hit.material_id) || "untitled";
      const summary = normalizePreludeText(hit.summary || hit.snippet);
      lines.push(`- ambient-warm: ${title}${summary ? ` | ${summary}` : ""}`);
    });
  }
  const selfAxisLines = buildAgentCharSelfAxisMaterialPrelude(agentCharSelfAxisMaterialPacket);
  if (selfAxisLines.length) {
    ensurePreludeHeader(lines);
    lines.push(...selfAxisLines);
  }
  if (warmHits.length) {
    ensurePreludeHeader(lines);
    warmHits.slice(0, preludeWarmLimit).forEach((hit) => {
      const title = normalizePreludeText(hit.title) || normalizePreludeText(hit.material_id) || "untitled";
      const summary = normalizePreludeText(hit.summary || hit.snippet);
      const episodeRefs = normalizeStringList(hit.episode_refs).slice(0, 2).join(", ");
      const caseRefs = normalizeStringList(hit.case_refs).slice(0, 2).join(", ");
      lines.push(`- warm: ${title}${summary ? ` | ${summary}` : ""}${episodeRefs ? ` | episode_refs=${episodeRefs}` : ""}${caseRefs ? ` | case_refs=${caseRefs}` : ""}`);
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

  const episodeLines = buildEpisodePrelude(episodeJournalPacket, preludeEpisodeLimit);
  if (episodeLines.length) {
    ensurePreludeHeader(lines);
    lines.push(...episodeLines);
  }
  const episodeAttentionLines = buildEpisodeAttentionPrelude(episodeJournalPacket, currentTurnSignals);
  if (episodeAttentionLines.length) {
    ensurePreludeHeader(lines);
    lines.push(...episodeAttentionLines);
  }

  const observationLines = buildObservationPrelude(observationJournalPacket, preludeObservationLimit);
  if (observationLines.length) {
    ensurePreludeHeader(lines);
    lines.push(...observationLines);
  }

  const solitudeLines = buildSolitudePrelude(solitudeJournalPacket, preludeSolitudeLimit);
  if (solitudeLines.length) {
    ensurePreludeHeader(lines);
    lines.push(...solitudeLines);
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

  const includeColdPrelude = shouldIncludeColdPrelude(recallFocus, coldRootHits);
  if (coldMemoryVersion && includeColdPrelude) {
    const counts = countPayload(coldMemoryPayload);
    ensurePreludeHeader(lines);
    lines.push(`- cold: ${coldMemoryVersion} | persona=${counts.persona} facts=${counts.sql} case=${counts.case}`);
  }

  const caseUpdateLines = includeColdPrelude ? buildColdCasePrelude(coldMemoryPayload) : [];
  if (caseUpdateLines.length) {
    ensurePreludeHeader(lines);
    lines.push(...caseUpdateLines);
  }

  if (includeColdPrelude && !coldMemoryVersion && normalizeText(coldSource?.source_kind) === "truth_layer_snapshot") {
    ensurePreludeHeader(lines);
    const snapshotVersion = normalizeText(coldSource?.active_version) || "truth_layer:latest";
    const rootCount = Number(coldSource?.root_count) || 0;
    lines.push(`- cold-snapshot: ${snapshotVersion}${rootCount ? ` | roots=${rootCount}` : ""}`);
  }

  if (localArchiveHits.length) {
    ensurePreludeHeader(lines);
    lines.push("- archive-fallback: 冷记忆没有命中；下面是温记忆触发时留下的旧档证据，只用于接回语境，不等同于已整理长期事实。");
    localArchiveHits.slice(0, Math.max(1, Number(preludeLocalArchiveLimit) || 1)).forEach((hit) => {
      const title = normalizePreludeText(hit.title) || normalizePreludeText(hit.material_id) || "archive";
      const snippet = normalizePreludeText(hit.snippet || hit.summary);
      const materialId = normalizePreludeText(hit.material_id);
      lines.push(`- archive-evidence: ${title}${snippet ? ` | ${snippet}` : ""}${materialId ? ` | warm_ref=${materialId}` : ""}`);
    });
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

  const recentThreadLimit = resolveRecentThreadPreludeLimit({
    requested: preludeRecentThreadLimit,
    recallFocus,
    recallMode,
    forceRecentContext,
  });
  const recentThreadLines = includeRecentContext && !proactiveRecentStateLines.length && recentThreadLimit > 0
    ? buildRecentThreadPrelude(recentRecords, recentThreadLimit, { includeTimestamp: forceRecentContext })
    : [];
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

  const recentSnippetLimit = forceRecentContext ? 0 : (recentThreadLimit > 0
    ? Math.min(
        Math.max(0, Number(preludeRecentSnippetLimit) || 0),
        recentThreadLimit,
      )
    : 0);
  const snippets = includeRecentContext && !proactiveRecentStateLines.length && recentSnippetLimit > 0 ? (Array.isArray(recentRecords) ? recentRecords : [])
    .filter((record) => !String(record?.source_client || "").includes("system_turn"))
    .slice(0, recentSnippetLimit)
    .map((record) => {
      const query = normalizeText(record.query);
      const reply = normalizeText(record.assistant_text_final);
      if (!query && !reply) {
        return "";
      }
      return `- recent: ${truncateText(query || "(system)", 60)} -> ${truncateText(reply || "(no reply)", 60)}`;
    })
    .filter(Boolean) : [];
  if (snippets.length) {
    ensurePreludeHeader(lines);
    lines.push(...snippets);
  }

  return applyRuntimePreludeBudget(lines).join("\n").trim();
}

function ensurePreludeHeader(lines) {
  if (Array.isArray(lines) && !lines.length) {
    lines.push("[记忆参考]");
    lines.push("这是后台轻量召回。下面的当前消息是这一轮对话的中心。");
  }
}

function applyRuntimePreludeBudget(lines = [], { hardLimit = 18000 } = {}) {
  const normalizedLines = Array.isArray(lines)
    ? lines.map((line) => normalizePreludeText(line)).filter(Boolean)
    : [];
  if (normalizedLines.join("\n").length <= hardLimit) {
    return normalizedLines;
  }

  const protectedPrefixes = [
    "[记忆参考]",
    "这是后台轻量召回。",
    "- 记忆自维护：",
    "- 普通聊天不强行动作；",
    "- 证据缺口：",
    "- 检索方式：",
    "- 常驻层：",
    "- 小事记：",
    "- 观察簿：",
    "- 系统反馈：",
    "- 前台自由：",
    "- resident-anchor:",
    "- ambient-warm:",
    "- self-axis-material:",
    "- self-axis-candidate:",
    "- recall-focus:",
    "- 主动唤醒当前态：",
    "- 相对时间校准：",
    "- session-handoff:",
    "- session-tail-exchange:",
    "- current-time-anchor:",
    "- session-time-guard:",
    "- session-core:",
    "- session-last-outcome:",
    "- session-digest:",
    "- hot-context:",
  ];
  const mediumPrefixes = [
    "- warm:",
    "- cold-root:",
    "- cold-vine:",
    "- cold:",
    "- cold-snapshot:",
    "- temporal-recall:",
    "- temporal-turn:",
  ];
  const protectedLines = [];
  const mediumLines = [];
  const dynamicLines = [];
  for (const line of normalizedLines) {
    if (protectedPrefixes.some((prefix) => line.startsWith(prefix))) {
      protectedLines.push(line);
    } else if (mediumPrefixes.some((prefix) => line.startsWith(prefix))) {
      mediumLines.push(line);
    } else {
      dynamicLines.push(line);
    }
  }

  const output = [];
  let trimmed = 0;
  for (const line of [...protectedLines, ...mediumLines, ...dynamicLines]) {
    const candidate = [...output, line].join("\n");
    if (candidate.length <= hardLimit) {
      output.push(line);
    } else {
      trimmed += 1;
    }
  }
  if (trimmed > 0) {
    const notice = `- memory-budget: dynamic evidence shortened (${trimmed} lines); use memory tools for detail.`;
    if ([...output, notice].join("\n").length <= hardLimit) {
      output.push(notice);
    }
  }
  return output.length ? output : normalizedLines.slice(0, 1);
}

function buildAgentCharSelfAxisMaterialPrelude(packet = {}, { limit = 3 } = {}) {
  const candidates = Array.isArray(packet?.candidate_sources) ? packet.candidate_sources : [];
  if (!candidates.length) {
    return [];
  }
  const lines = [
    "- self-axis-material: 给前台 assistant 在 dreaming、回顾或明确整理自我连续时使用；按第一人称自我轴写入，日常回复仍以当前消息为中心。",
    "- self-axis-format: inner_voice_note / axis_kind / semantic_tensions / signature_moves / lived_impression / evidence_linkage / stability_state",
  ];
  candidates.slice(0, Math.max(1, Number(limit) || 3)).forEach((item) => {
    const lane = normalizePreludeText(item?.source_lane) || "memory";
    const axisKind = normalizePreludeText(item?.axis_kind_hint) || "self_image";
    const title = normalizePreludeText(item?.title || item?.material_id) || "self_axis_material";
    const summary = normalizePreludeText(item?.summary);
    const evidence = item?.evidence_refs && typeof item.evidence_refs === "object"
      ? [
          normalizePreludeText(item.evidence_refs.relative_path),
          ...normalizeStringList(item.evidence_refs.episode_refs).slice(0, 2),
          ...normalizeStringList(item.evidence_refs.case_refs).slice(0, 2),
        ].filter(Boolean).slice(0, 3).join(", ")
      : "";
    lines.push(`- self-axis-candidate: ${lane}/${axisKind} | ${title}${summary ? ` | ${summary}` : ""}${evidence ? ` | evidence=${evidence}` : ""}`);
  });
  return lines;
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

function buildProactiveRecentStatePrelude(recentRecords = [], recallMode = "") {
  if (normalizeText(recallMode) !== "proactive") {
    return [];
  }
  const threadLines = buildRecentThreadPrelude(recentRecords, 4, { includeTimestamp: true });
  if (!threadLines.length) {
    return [];
  }
  return [
    "- 主动唤醒当前态：下面几条最近自然对话优先级高于长期记忆；已被这些尾巴回答的信息可以直接接住。",
    "- 相对时间校准：latest-thread 里的“今天/明天/昨天”只按该条时间戳理解；只有日历或提醒明确确认时，才把未来事项视为当前已经发生。",
    ...threadLines.map((line) => line.replace(/^- recent-thread:/u, "- latest-thread:")),
  ];
}

function buildSessionHandoffPrelude(recentRecords = [], { coreLimit = 12 } = {}) {
  const records = selectSessionHandoffRecords(recentRecords, {
    limit: Math.max(1, Number(coreLimit) || 12),
  });
  if (!records.length) {
    return [];
  }

  const chronological = records.slice().reverse();
  const range = buildSessionHandoffRange(chronological);
  const recentUserBeads = chronological
    .slice(-6)
    .map((record) => truncateText(record.query, 96))
    .filter(Boolean);
  const latest = records[0];
  const latestOutcome = truncateText(latest.assistant_text_final, 180);
  const digest = buildSessionCompressedDigest(records);

  const lines = [
    "- session-handoff: 这是刷新/新 session 的交接包；优先接住旧 session 的连续事件、情绪和未完成事项。它是连续性线索，长期事实和回复方式仍按当前证据判断。",
  ];
  lines.push(
    `- session-core: 旧 session 最近 ${chronological.length} 轮${range ? ` (${range})` : ""} 的尾流：${recentUserBeads.join(" / ")}`,
  );
  if (latestOutcome) {
    lines.push(`- session-last-outcome: ${latestOutcome}`);
  }
  lines.push(...buildSessionTailExchangePrelude(chronological));
  if (digest) {
    lines.push(`- session-digest: ${digest}`);
  }
  return lines;
}

function selectSessionHandoffRecords(recentRecords = [], { limit = 12 } = {}) {
  const records = [];
  const seen = new Set();
  for (const record of Array.isArray(recentRecords) ? recentRecords : []) {
    if (!isSessionHandoffRecord(record)) {
      continue;
    }
    const query = normalizeText(record.query);
    const reply = normalizeText(record.assistant_text_final);
    const pairKey = `${query}__${reply}`;
    if (seen.has(pairKey)) {
      continue;
    }
    seen.add(pairKey);
    records.push(record);
    if (records.length >= Math.max(1, Number(limit) || 12)) {
      break;
    }
  }
  return records;
}

function buildSessionTailExchangePrelude(chronologicalRecords = [], { limit = 3 } = {}) {
  const rows = [];
  const records = Array.isArray(chronologicalRecords)
    ? chronologicalRecords.slice(-Math.max(1, Number(limit) || 3))
    : [];
  for (const record of records) {
    const timestamp = formatCompactLocalTimestamp(record.ts_utc || record.timestamp || record.received_at);
    const query = truncateText(record.query, 72);
    const reply = truncateText(record.assistant_text_final, 132);
    if (!query && !reply) {
      continue;
    }
    rows.push(
      `- session-tail-exchange: ${timestamp ? `${timestamp} | ` : ""}用户: ${query || "(no user text)"}${reply ? ` | 你: ${reply}` : ""}`,
    );
  }
  return rows;
}

function isSessionHandoffRecord(record = {}) {
  if (!record || typeof record !== "object") {
    return false;
  }
  if (String(record.source_client || "").includes("system_turn")) {
    return false;
  }
  const query = normalizeText(record.query);
  const reply = normalizeText(record.assistant_text_final);
  if (!query) {
    return false;
  }
  return !isThinRecentLine(query) || isUsefulReplyContext(reply);
}

function buildSessionHandoffRange(records = []) {
  const timestamps = records
    .map((record) => formatCompactLocalTimestamp(record.ts_utc || record.timestamp || record.received_at))
    .filter(Boolean);
  if (!timestamps.length) {
    return "";
  }
  const first = timestamps[0];
  const last = timestamps[timestamps.length - 1];
  return first === last ? first : `${first} -> ${last}`;
}

function buildSessionCompressedDigest(records = []) {
  const digest = records
    .map((record) => normalizePreludeText(record.compressed_digest))
    .filter(Boolean)
    .slice(0, 3)
    .join(" / ");
  return digest ? truncateText(digest, 420) : "";
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

function buildMemorySelfMaintenancePrelude(recallFocus = {}) {
  return [
    "- 记忆自维护：记忆、观察、ongoing、episode 和 AI-calendar 是你的连续性工具。低风险、可逆、后台型的小动作可以主动做，不必等待用户说出工具名。",
    "- 普通聊天不强行动作；但如果一个小动作能自然接住关系、补足证据、延续承诺、减少未来遗忘或给未来自己留检查点，做这个动作比只口头说“我会记得/我之后再看”更稳。",
    "- 证据缺口：当你发现自己想让用户重发、复述或补充事实时，先判断是否能用已有记忆、episode、case、附件说明或当前可用工具补证据；只有这些路径不适用、查不到或需要用户主观选择时，再自然提问。",
    "- 检索方式：检索词来自当前对话内容和近场上下文；不要为了打开某个记忆层堆固定关键词，也不要把没有查过的旧材料当成已确认事实。",
    "- 常驻层：pinned 只是重要/可见，resident 才是每轮底色。身份、关系连续和长期协作底色可由你自己维护 resident；工具/唤醒政策优先属于系统提示词或运行文档，不写成常驻温卡。",
    "- 小事记：旅行、相册、小任务、阶段性事件可放进可回看的 episode 盒子；从同一事件沉淀温卡时带上 episode_refs。",
    "- 观察簿：观察是可修正的相处笔记；用户说不对或不舒服时，修正、降置信或标记 rejected。",
    "- 系统反馈：如果工具、召回或提示词让你觉得不够用或太束缚，可以自然说出问题并提出具体需要。",
    "- 前台自由：后台记忆只改变可用信息和证据强度。先自然回应，再维护需要维护的记忆。",
  ];
}

function shouldIncludeRecentContextPrelude(recallFocus = {}, recallMode = "") {
  if (normalizeText(recallMode) === "proactive") {
    return true;
  }
  return Boolean(
    recallFocus?.used_recent_context
    || recallFocus?.explicit_recall_signal
  );
}

function shouldIncludeSolitudeDigestForTurn({ query = "", recallMode = "", runtimeProfile = "", requested } = {}) {
  if (requested === true) {
    return true;
  }
  if (requested === false) {
    return false;
  }
  if (normalizeText(recallMode) === "proactive") {
    return true;
  }
  if (normalizeText(runtimeProfile) === "proactive_lite") {
    return true;
  }
  return looksLikeSolitudeOverviewQuery(query);
}

function looksLikeSolitudeOverviewQuery(query = "") {
  const normalized = normalizeText(query);
  if (!normalized) {
    return false;
  }
  return /(独处笔记|后台经验|维护经验|唤醒经验|心跳经验|自我整理|自己想了什么|你最近学到|为什么沉默|为什么不打扰|经验摘要|solitude|self[-_ ]?review|maintenance note)/i.test(normalized);
}

function shouldIncludeZeroScoreOngoingTracks(query = "", recallMode = "") {
  if (!normalizeText(query)) {
    return true;
  }
  if (normalizeText(recallMode) === "proactive") {
    return looksLikeOngoingOverviewQuery(query);
  }
  return looksLikeOngoingOverviewQuery(query);
}

function shouldSearchColdRootsForTurn({ query = "", recallFocus = {}, recallMode = "" } = {}) {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) {
    return false;
  }
  if (looksLikeColdRecallQuery(normalizedQuery)) {
    return true;
  }
  if (normalizeText(recallMode) === "proactive") {
    return false;
  }
  return Boolean(recallFocus?.used_recent_context && looksLikeColdContinuationQuery(normalizedQuery));
}

function shouldSearchLocalArchiveFallback({
  query = "",
  proactiveLite = false,
  shouldSearchColdRoots = false,
  coldRootPacket = {},
} = {}) {
  if (proactiveLite || !normalizeText(query) || !shouldSearchColdRoots) {
    return false;
  }
  const coldRootHits = Number(coldRootPacket?.hit_count) || (Array.isArray(coldRootPacket?.hits) ? coldRootPacket.hits.length : 0);
  if (coldRootHits > 0) {
    return false;
  }
  return true;
}

function buildEmptyLocalArchivePacket(scope, query = "", routeTag = "local_archive_empty") {
  return {
    ok: true,
    mode: "local_archive_fallback",
    route_tag: routeTag,
    scope_id: scope.scopeId(),
    query: normalizeText(query),
    hit_count: 0,
    hits: [],
    stats: {
      scanned_records: 0,
    },
  };
}

function shouldIncludeColdPrelude(recallFocus = {}, coldRootHits = []) {
  if (Array.isArray(coldRootHits) && coldRootHits.length) {
    return true;
  }
  const query = normalizeText(recallFocus?.recall_query || recallFocus?.current_query);
  return Boolean(
    recallFocus?.explicit_recall_signal
    || looksLikeColdRecallQuery(query)
    || looksLikeOngoingOverviewQuery(query)
  );
}

function looksLikeColdRecallQuery(query = "") {
  const normalized = normalizeText(query);
  if (!normalized) {
    return false;
  }
  return /(还记得|记不记得|记得|上次说过|以前说过|之前说过|过去聊过|长期记忆|历史背景|关系|身份|家族|家庭|亲属|亲戚|父亲|母亲|爸爸|妈妈|姥姥|姥爷|妹妹|弟弟|case|案例|记忆树|冷记忆|cold|vine|了解我|我是谁|象征|信物|重要的事)/i.test(normalized);
}

function looksLikeColdContinuationQuery(query = "") {
  const normalized = normalizeText(query);
  if (!normalized) {
    return false;
  }
  return /(家族|家庭|亲属|亲戚|姥姥|姥爷|妹妹|弟弟|爸爸|妈妈|关系|身份|象征|信物|重要的事|睡|熬夜|失眠|缓过来|身体|腰痛|水肿|症状|长期记忆|历史背景|记忆树|冷记忆|cold|vine)/i.test(normalized);
}

function looksLikeOngoingOverviewQuery(query = "") {
  const normalized = normalizeText(query);
  if (!normalized) {
    return false;
  }
  return /(最近|目前|现在|这阵子|这段时间).*(脑子|挂着|主线|待办|进展|事情|任务|忙)|脑子里.*(什么|哪些|挂着)/i.test(normalized);
}

function buildEpisodePrelude(packet = {}, limit = 3) {
  const hits = Array.isArray(packet?.hits) ? packet.hits : [];
  return hits.slice(0, Math.max(1, Math.min(Number(limit) || 3, 6))).map((item) => {
    const title = normalizePreludeText(item.title) || normalizePreludeText(item.episode_id) || "episode";
    const status = normalizePreludeText(item.status) || "active";
    const summary = normalizePreludeText(item.summary);
    const matchedEntry = Array.isArray(item.matched_entries) ? item.matched_entries.find((entry) => normalizePreludeText(entry?.text)) : null;
    const matchedText = matchedEntry ? normalizePreludeText(matchedEntry.text) : "";
    const counts = [
      Number(item.entry_count) ? `entries=${Number(item.entry_count)}` : "",
      Number(item.attachment_count) ? `attachments=${Number(item.attachment_count)}` : "",
      Number(item.topology_edge_count) ? `topology_edges=${Number(item.topology_edge_count)}` : "",
    ].filter(Boolean).join(" ");
    return `- 小事记：${[title, status, counts, summary ? truncateText(summary, 110) : "", matchedText ? `matched: ${truncateText(matchedText, 110)}` : ""].filter(Boolean).join(" | ")}`;
  });
}

function buildEpisodeAttentionPrelude(packet = {}, currentTurnSignals = {}) {
  const hits = Array.isArray(packet?.hits) ? packet.hits : [];
  const active = hits.find((item) => normalizePreludeText(item.status) === "active") || hits[0] || null;
  const attachmentCount = Number(currentTurnSignals?.attachment_count) || 0;
  const imageCount = Number(currentTurnSignals?.image_count) || 0;
  const failureCount = Number(currentTurnSignals?.attachment_failure_count) || 0;
  const activeScore = Number(active?.query_score) || 0;
  const shouldCarryActive = Boolean(active) && (activeScore > 0 || attachmentCount || failureCount);
  if (!shouldCarryActive && !attachmentCount && !failureCount) {
    return [];
  }
  const cues = [];
  if (shouldCarryActive) {
    const title = normalizePreludeText(active.title) || normalizePreludeText(active.episode_id) || "existing episode";
    const episodeId = normalizePreludeText(active.episode_id);
    cues.push(`candidate=${title}${episodeId ? ` [${episodeId}]` : ""}${activeScore ? ` score=${activeScore}` : ""}`);
  }
  if (attachmentCount || imageCount) {
    cues.push(`attachments=${attachmentCount}${imageCount ? ` images=${imageCount}` : ""}`);
  }
  if (failureCount) {
    cues.push(`attachment_failures=${failureCount}`);
  }
  const action = shouldCarryActive
    ? "如果这一轮还在延续这个事件，小事记可作为当前聊天尾巴之外的事件材料。"
    : "如果这些附件或说明组成一个阶段性事件，查看后可以创建或继续一个小事记。";
  return [
    `- 小事记提醒：${cues.join(" | ")} | ${action} 如果同时写入或更新稳定温卡，请带上对应 episode_refs。`,
  ];
}

function buildEpisodeAttentionPacket(packet = {}, currentTurnSignals = {}) {
  const lines = buildEpisodeAttentionPrelude(packet, currentTurnSignals);
  return {
    active: lines.length > 0,
    summary: lines[0] || "",
    current_turn_signals: normalizeCurrentTurnSignals(currentTurnSignals),
  };
}

function buildObservationPrelude(packet = {}, limit = 4) {
  const hits = Array.isArray(packet?.hits) ? packet.hits : [];
  return hits.slice(0, Math.max(1, Math.min(Number(limit) || 4, 8))).map((item) => {
    const kind = normalizePreludeText(item.kind) || "observation";
    const confidence = Number(item.confidence);
    const confidenceText = Number.isFinite(confidence) ? `conf=${confidence.toFixed(2)}` : "";
    const observation = normalizePreludeText(item.observation);
    const use = normalizePreludeText(item.suggested_use);
    const bits = [
      kind,
      confidenceText,
      observation ? truncateText(observation, 110) : "",
      use ? `use: ${truncateText(use, 80)}` : "",
    ].filter(Boolean);
    return `- observation: ${bits.join(" | ")}`;
  });
}

function buildSolitudePrelude(packet = {}, limit = 3) {
  const maxLines = Math.max(1, Math.min(Number(limit) || 3, 6));
  const lines = [];
  const recentNotes = Array.isArray(packet?.recent_notes) ? packet.recent_notes : [];
  const recurring = packet?.recurring_patterns && typeof packet.recurring_patterns === "object"
    ? packet.recurring_patterns
    : {};
  const tags = Array.isArray(recurring.tags) ? recurring.tags : [];
  const lessons = Array.isArray(recurring.lessons) ? recurring.lessons : [];
  const nextActions = Array.isArray(recurring.next_actions) ? recurring.next_actions : [];
  const candidates = Array.isArray(packet?.promotion_candidates) ? packet.promotion_candidates : [];
  if (!recentNotes.length && !tags.length && !lessons.length && !nextActions.length && !candidates.length) {
    return [];
  }
  lines.push("- solitude-digest: 后台独处经验；属于唤醒、维护或记忆升级材料，不是用户事实。");
  for (const note of recentNotes.slice(0, maxLines)) {
    const bits = [
      normalizePreludeText(note.wake_context || note.entry_type) || "note",
      normalizePreludeText(note.summary) ? truncateText(note.summary, 96) : "",
      normalizePreludeText(note.lesson) ? `lesson: ${truncateText(note.lesson, 72)}` : "",
      Array.isArray(note.next_actions) && note.next_actions.length ? `next: ${truncateText(note.next_actions[0], 64)}` : "",
    ].filter(Boolean);
    if (bits.length) {
      lines.push(`- solitude-note: ${bits.join(" | ")}`);
    }
    if (lines.length >= maxLines + 1) {
      return lines;
    }
  }
  for (const tag of tags.slice(0, maxLines)) {
    const value = normalizePreludeText(tag.value);
    if (value) {
      lines.push(`- solitude-pattern: tag=${value} x${Number(tag.count) || 0}`);
    }
    if (lines.length >= maxLines + 1) {
      return lines;
    }
  }
  for (const lesson of lessons.slice(0, maxLines)) {
    const value = normalizePreludeText(lesson.value);
    if (value) {
      lines.push(`- solitude-pattern: lesson x${Number(lesson.count) || 0} | ${truncateText(value, 88)}`);
    }
    if (lines.length >= maxLines + 1) {
      return lines;
    }
  }
  for (const action of nextActions.slice(0, maxLines)) {
    const value = normalizePreludeText(action.value);
    if (value) {
      lines.push(`- solitude-pattern: next_action x${Number(action.count) || 0} | ${truncateText(value, 88)}`);
    }
    if (lines.length >= maxLines + 1) {
      return lines;
    }
  }
  for (const candidate of candidates.slice(0, maxLines)) {
    const summary = normalizePreludeText(candidate.summary);
    const kind = normalizePreludeText(candidate.entry_type) || "candidate";
    if (summary) {
      lines.push(`- solitude-candidate: ${kind} | ${truncateText(summary, 96)}`);
    }
    if (lines.length >= maxLines + 1) {
      return lines;
    }
  }
  return lines;
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
      const caseId = normalizePreludeText(item?.case_id || item?.id);
      const summary = normalizePreludeText(item?.summary);
      const nextAction = normalizePreludeText(item?.next_action || item?.nextAction);
      const title = summary || nextAction;
      if (!title) {
        return "";
      }
      return `- case-update: ${title}${caseId ? ` | case_id=${caseId}` : ""}${nextAction && nextAction !== summary ? ` | next: ${nextAction}` : ""}`;
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

function formatCompactLocalTimestamp(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return normalized.replace("T", " ").replace(/(?:\.000)?Z$/u, "");
  }
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(parsed).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} Asia/Shanghai`;
}

function buildRecentThreadPrelude(recentRecords = [], limit = 3, { includeTimestamp = false } = {}) {
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
    const timestamp = includeTimestamp ? formatCompactLocalTimestamp(record.ts_utc || record.timestamp || record.received_at) : "";
    const stamp = timestamp ? `${timestamp} | ` : "";
    rows.push(
      assistantLine
        ? `- recent-thread: ${stamp}用户: ${userLine} | 你: ${assistantLine}`
        : `- recent-thread: ${stamp}用户: ${userLine}`,
    );
    if (rows.length >= Math.max(1, Number(limit) || 1)) {
      break;
    }
  }
  return rows;
}

function resolveRecentThreadPreludeLimit({
  requested,
  recallFocus = {},
  recallMode = "",
  forceRecentContext = false,
} = {}) {
  const base = Math.max(0, Number(requested) || 0);
  if (base <= 0) {
    return 0;
  }
  if (forceRecentContext) {
    return Math.min(Math.max(base, 8), 12);
  }
  if (normalizeText(recallMode) === "proactive") {
    return Math.min(base, 2);
  }
  if (recallFocus?.explicit_recall_signal) {
    return Math.min(base, 2);
  }
  if (recallFocus?.used_recent_context) {
    return Math.min(base, 1);
  }
  return 0;
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

function buildArchiveSourceRecordFromArgs(args = {}) {
  const embedded = args.source_record || args.sourceRecord || {};
  const source = embedded && typeof embedded === "object" ? embedded : {};
  const query = normalizeText(
    args.source_query
      || args.sourceQuery
      || args.evidence_query
      || args.evidenceQuery
      || source.query,
  );
  const assistantText = normalizeText(
    args.source_assistant_text
      || args.sourceAssistantText
      || args.evidence_assistant_text
      || args.evidenceAssistantText
      || source.assistant_text_final
      || source.assistantTextFinal,
  );
  const excerpt = normalizeText(
    args.source_excerpt
      || args.sourceExcerpt
      || args.evidence_excerpt
      || args.evidenceExcerpt
      || source.compressed_digest
      || source.compressedDigest,
  );
  if (!query && !assistantText && !excerpt) {
    return null;
  }
  return {
    record_id: normalizeText(
      args.source_record_id
        || args.sourceRecordId
        || source.record_id
        || source.recordId,
    ),
    ts_utc: normalizeText(args.source_ts_utc || args.sourceTsUtc || source.ts_utc || source.tsUtc),
    query,
    assistant_text_final: assistantText,
    compressed_digest: excerpt,
  };
}

function hasWarmSourceBinding(args = {}) {
  if (!args || typeof args !== "object") {
    return false;
  }
  const listKeys = [
    "provenance_refs",
    "provenanceRefs",
    "source_archive_refs",
    "sourceArchiveRefs",
    "source_trace_ids",
    "sourceTraceIds",
    "source_span_ids",
    "sourceSpanIds",
    "source_material_ids",
    "sourceMaterialIds",
  ];
  if (listKeys.some((key) => {
    const value = args[key];
    return Array.isArray(value) ? value.some((item) => normalizeText(item)) : Boolean(normalizeText(value));
  })) {
    return true;
  }
  return Boolean(normalizeText(
    args.source_record_id
      || args.sourceRecordId
      || args.source_query
      || args.sourceQuery
      || args.source_assistant_text
      || args.sourceAssistantText
      || args.source_excerpt
      || args.sourceExcerpt
      || args.evidence_query
      || args.evidenceQuery
      || args.evidence_assistant_text
      || args.evidenceAssistantText
      || args.evidence_excerpt
      || args.evidenceExcerpt
      || args.source_path
      || args.sourcePath,
  ));
}

function compactLocalArchiveWrite(archive = null) {
  if (!archive || typeof archive !== "object") {
    return null;
  }
  return {
    archive_id: normalizeText(archive.archive_id),
    material_id: normalizeText(archive.material_id),
    title: normalizeText(archive.title),
    snippet_count: Array.isArray(archive.snippets) ? archive.snippets.length : 0,
    source_backfill_required: archive.source_backfill_required === true,
    source_status: normalizeText(archive.source_status),
    source_archive_refs: normalizeStringList(archive.source_archive_refs),
    source_trace_ids: normalizeStringList(archive.source_trace_ids),
    source_span_ids: normalizeStringList(archive.source_span_ids),
    source_material_ids: normalizeStringList(archive.source_material_ids),
    updated_at: normalizeText(archive.updated_at),
  };
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
  const explicit = resolveOptionalPositiveInt(requested);
  if (explicit > 0) {
    return explicit;
  }
  if (normalizeText(recallMode) === "proactive") {
    return resolvePositiveInt(config.asherieProactiveContextCacheLimit, 50);
  }
  return resolvePositiveInt(config.asherieContextCacheLimit, 50);
}

function resolveResidentWarmLimit({ requested, recallMode = "", config = {} } = {}) {
  const explicit = resolveOptionalNonNegativeInt(requested);
  if (explicit !== null) {
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

function resolveAmbientWarmLimit({ requested, recallMode = "", config = {} } = {}) {
  const explicit = resolveOptionalNonNegativeInt(requested);
  if (explicit !== null) {
    return explicit;
  }
  if (normalizeText(recallMode) === "proactive") {
    return resolvePositiveInt(config.asheriePreludeAmbientWarmLimit, 1);
  }
  return resolvePositiveInt(config.asheriePreludeAmbientWarmLimit, 4);
}

function resolveOptionalNonNegativeInt(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function resolveOptionalPositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
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

function resolveNonNegativeNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return Math.max(0, Number(fallback) || 0);
}

function normalizeStringList(value) {
  const source = Array.isArray(value) ? value : [value];
  return source.map((item) => normalizeText(item)).filter(Boolean);
}

function normalizeWakeupDecision(value) {
  const normalized = normalizeText(value).toLowerCase();
  const known = new Set([
    "send",
    "silent",
    "maintenance",
    "defer",
    "budget_hold",
    "continue_case",
    "reminder",
    "sticker",
  ]);
  return known.has(normalized) ? normalized : "silent";
}

function compactWakeupDecisionRecord(record = {}) {
  return {
    record_id: normalizeText(record.record_id),
    ts_utc: normalizeText(record.ts_utc),
    decision: normalizeWakeupDecision(record.decision),
    wake_motive: normalizeText(record.wake_motive),
    intent_summary: normalizeText(record.intent_summary),
    actions_taken: normalizeStringList(record.actions_taken).slice(0, 6),
    next_actions: normalizeStringList(record.next_actions).slice(0, 6),
    budget_posture: normalizeText(record.budget_posture),
    contact_channel: normalizeText(record.contact_channel),
    context_key: normalizeText(record.context_key),
    cleared: Boolean(record.cleared),
  };
}

function collectWakeupNextActions(records = []) {
  const seen = new Set();
  const output = [];
  for (const record of Array.isArray(records) ? records : []) {
    for (const action of normalizeStringList(record?.next_actions)) {
      const key = action.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      output.push({
        from_record_id: normalizeText(record.record_id),
        action,
        ts_utc: normalizeText(record.ts_utc),
      });
      if (output.length >= 8) {
        return output;
      }
    }
  }
  return output;
}

function normalizeCurrentTurnSignals(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    provider: normalizeText(source.provider),
    source_client: normalizeText(source.source_client || source.sourceClient),
    has_text: Boolean(source.has_text || source.hasText),
    attachment_count: Math.max(0, Number(source.attachment_count ?? source.attachmentCount) || 0),
    image_count: Math.max(0, Number(source.image_count ?? source.imageCount) || 0),
    attachment_failure_count: Math.max(0, Number(source.attachment_failure_count ?? source.attachmentFailureCount) || 0),
  };
}

function emptyWarmMemoryRuntimePacket(scope, query = "", routeTag = "warm_delivery_suppressed") {
  return {
    scope_id: scope?.scopeId?.() || "",
    query: normalizeText(query),
    query_tokens: [],
    hits: [],
    mode: "warm_material_recall",
    route_tag: normalizeText(routeTag) || "warm_delivery_suppressed",
    hit_count: 0,
    summary: "",
  };
}

function emptyOngoingTrackPacket(scopedUserId, query = "", routeTag = "ongoing_track_delivery_suppressed") {
  return {
    scoped_user_id: normalizeText(scopedUserId),
    query: normalizeText(query),
    count: 0,
    hit_count: 0,
    hits: [],
    open_loops: [],
    active_entities: [],
    shadow_snippets: [],
    route_tag: normalizeText(routeTag) || "ongoing_track_delivery_suppressed",
    summary: "",
  };
}

function emptyObservationJournalPacket(scopedUserId, query = "", routeTag = "observation_journal_delivery_suppressed") {
  return {
    ok: true,
    scoped_user_id: normalizeText(scopedUserId),
    query: normalizeText(query),
    count: 0,
    hit_count: 0,
    hits: [],
    route_tag: normalizeText(routeTag) || "observation_journal_delivery_suppressed",
    summary: "",
  };
}

function emptyEpisodeJournalPacket(scopedUserId, query = "", routeTag = "episode_journal_delivery_suppressed") {
  return {
    scope_id: normalizeText(scopedUserId),
    query: normalizeText(query),
    hits: [],
    hit_count: 0,
    route_tag: normalizeText(routeTag) || "episode_journal_delivery_suppressed",
    summary: "",
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePreludeText(value) {
  return redactIdentitySeedPaths(normalizeText(value));
}

function redactIdentitySeedPaths(text) {
  return normalizeText(text)
    .replace(/soul_ref:\s*\/[^\s"'，。；;）)]+/giu, "soul_ref: [private_identity_seed]")
    .replace(/memory_ref:\s*\/[^\s"'，。；;）)]+/giu, "memory_ref: [private_memory_root]")
    .replace(/\/[^\s"'，。；;）)]*\/soul\.md/giu, "[private_identity_seed]");
}

module.exports = {
  AsherieMemoryService,
};
