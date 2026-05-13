const fs = require("fs");
const path = require("path");

function buildGatewayStorageLayout(dataRoot, {
  curatedStoreOverride = "",
  storageRootOverride = "",
  cacheRootOverride = "",
  truthLayerDirOverride = "",
  memoryTreeDirOverride = "",
  caseIndexDirOverride = "",
  observationJournalDirOverride = "",
  episodeJournalDirOverride = "",
  solitudeJournalDirOverride = "",
  notebookDirOverride = "",
  notionSyncDirOverride = "",
  memoryVersionBankDirOverride = "",
  warmMemoryDirOverride = "",
  rawTranscriptArchiveDirOverride = "",
  dreamingMutationLogDirOverride = "",
  relationshipContractDirOverride = "",
  ongoingTrackStorePathOverride = "",
  ongoingTrackArchivePathOverride = "",
  calendarStorePathOverride = "",
  conversationCacheDirOverride = "",
  appDailyCaptureDirOverride = "",
  rawTranscriptActiveDirOverride = "",
  hotCacheDirOverride = "",
  runtimeId = "codex",
  startupId = "",
  runtimeStateDirOverride = "",
  startupStateDirOverride = "",
  wechatTransportStateDirOverride = "",
  wechatTransportThreadDirOverride = "",
  wakeupStorePathOverride = "",
  calendarPendingStorePathOverride = "",
  hubStateDirOverride = "",
} = {}) {
  const base = path.resolve(dataRoot);
  const storageRoot = resolveOverridePath(storageRootOverride, path.join(base, "storage"));
  const cacheRoot = resolveOverridePath(cacheRootOverride, path.join(base, "cache"));
  const hotCacheDir = resolveOverridePath(hotCacheDirOverride, path.join(cacheRoot, "hot"));
  const runtimeSegment = normalizeStorageSegment(runtimeId) || "codex";
  const startupSegment = normalizeStorageSegment(startupId) || `shared_${runtimeSegment}`;
  const curatedStorePath = curatedStoreOverride
    ? path.resolve(curatedStoreOverride)
    : path.join(storageRoot, "curated_memories.json");
  return {
    dataRoot: base,
    storageRoot,
    cacheRoot,
    curatedStorePath,
    truthLayerDir: resolveOverridePath(truthLayerDirOverride, path.join(storageRoot, "truth_layer")),
    memoryTreeDir: resolveOverridePath(memoryTreeDirOverride, path.join(storageRoot, "memory_tree")),
    caseIndexDir: resolveOverridePath(caseIndexDirOverride, path.join(storageRoot, "case_index")),
    observationJournalDir: resolveOverridePath(observationJournalDirOverride, path.join(storageRoot, "observation_journal")),
    episodeJournalDir: resolveOverridePath(episodeJournalDirOverride, path.join(storageRoot, "episode_journal")),
    solitudeJournalDir: resolveOverridePath(solitudeJournalDirOverride, path.join(storageRoot, "solitude_journal")),
    notebookDir: resolveOverridePath(notebookDirOverride, path.join(storageRoot, "notebook")),
    notionSyncDir: resolveOverridePath(notionSyncDirOverride, path.join(storageRoot, "notion_sync")),
    memoryVersionBankDir: resolveOverridePath(memoryVersionBankDirOverride, path.join(storageRoot, "memory_versions")),
    warmMemoryDir: resolveOverridePath(warmMemoryDirOverride, path.join(storageRoot, "warm_memory")),
    rawTranscriptArchiveDir: resolveOverridePath(rawTranscriptArchiveDirOverride, path.join(storageRoot, "raw_transcript_archive")),
    dreamingMutationLogDir: resolveOverridePath(dreamingMutationLogDirOverride, path.join(storageRoot, "dreaming_mutation_log")),
    relationshipContractDir: resolveOverridePath(relationshipContractDirOverride, path.join(storageRoot, "relationship_contracts")),
    ongoingTrackStorePath: resolveOverridePath(ongoingTrackStorePathOverride, path.join(storageRoot, "ongoing_tracks.json")),
    ongoingTrackArchivePath: resolveOverridePath(ongoingTrackArchivePathOverride, path.join(storageRoot, "ongoing_tracks.archive.jsonl")),
    calendarStorePath: resolveOverridePath(calendarStorePathOverride, path.join(storageRoot, "calendar_items.json")),
    conversationCacheDir: resolveOverridePath(conversationCacheDirOverride, path.join(cacheRoot, "conversation_cache")),
    appDailyCaptureDir: resolveOverridePath(appDailyCaptureDirOverride, path.join(cacheRoot, "app_daily_captures")),
    rawTranscriptActiveDir: resolveOverridePath(rawTranscriptActiveDirOverride, path.join(cacheRoot, "raw_transcript_active")),
    hotCacheDir,
    hotUpstreamContextDir: path.join(hotCacheDir, "upstream_context_merge"),
    hotContextBasinDir: path.join(hotCacheDir, "context_basin"),
    hotContextProjectionDir: path.join(hotCacheDir, "projections"),
    hotContextSnapshotDir: path.join(hotCacheDir, "snapshots"),
    runtimeStateDir: resolveOverridePath(runtimeStateDirOverride, path.join(cacheRoot, "runtimes", runtimeSegment)),
    startupStateDir: resolveOverridePath(startupStateDirOverride, path.join(cacheRoot, "startup", startupSegment)),
    wechatTransportStateDir: resolveOverridePath(wechatTransportStateDirOverride, path.join(cacheRoot, "transports", "wechat")),
    wechatTransportThreadDir: resolveOverridePath(wechatTransportThreadDirOverride, path.join(cacheRoot, "transports", "wechat", "threads")),
    wakeupStorePath: resolveOverridePath(wakeupStorePathOverride, path.join(cacheRoot, "wakeup_journal.json")),
    calendarPendingStorePath: resolveOverridePath(calendarPendingStorePathOverride, path.join(cacheRoot, "calendar_pending_actions.json")),
    hubStateDir: resolveOverridePath(hubStateDirOverride, path.join(cacheRoot, "hub")),
  };
}

function ensureGatewayStorageLayout(layout) {
  const dirKeys = [
    "storageRoot",
    "cacheRoot",
    "truthLayerDir",
    "memoryTreeDir",
    "caseIndexDir",
    "observationJournalDir",
    "episodeJournalDir",
    "solitudeJournalDir",
    "notebookDir",
    "notionSyncDir",
    "memoryVersionBankDir",
    "warmMemoryDir",
    "rawTranscriptArchiveDir",
    "dreamingMutationLogDir",
    "relationshipContractDir",
    "conversationCacheDir",
    "appDailyCaptureDir",
    "rawTranscriptActiveDir",
    "hotCacheDir",
    "hotUpstreamContextDir",
    "hotContextBasinDir",
    "hotContextProjectionDir",
    "hotContextSnapshotDir",
    "runtimeStateDir",
    "startupStateDir",
    "wechatTransportStateDir",
    "wechatTransportThreadDir",
    "hubStateDir",
  ];
  dirKeys.forEach((key) => {
    if (layout[key]) {
      fs.mkdirSync(layout[key], { recursive: true });
    }
  });
  [
    layout.curatedStorePath,
    layout.ongoingTrackStorePath,
    layout.ongoingTrackArchivePath,
    layout.calendarStorePath,
    layout.wakeupStorePath,
    layout.calendarPendingStorePath,
  ].forEach((filePath) => {
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
  });
}

function buildGatewayStorageHealth(layout) {
  const activePaths = {
    storage_root: layout.storageRoot,
    cache_root: layout.cacheRoot,
    curated_store_path: layout.curatedStorePath,
    memory_version_bank_dir: layout.memoryVersionBankDir,
    warm_memory_dir: layout.warmMemoryDir,
    truth_layer_dir: layout.truthLayerDir,
    memory_tree_dir: layout.memoryTreeDir,
    case_index_dir: layout.caseIndexDir,
    observation_journal_dir: layout.observationJournalDir,
    episode_journal_dir: layout.episodeJournalDir,
    solitude_journal_dir: layout.solitudeJournalDir,
    notebook_dir: layout.notebookDir,
    notion_sync_dir: layout.notionSyncDir,
    raw_transcript_archive_dir: layout.rawTranscriptArchiveDir,
    dreaming_mutation_log_dir: layout.dreamingMutationLogDir,
    relationship_contract_dir: layout.relationshipContractDir,
    ongoing_track_store_path: layout.ongoingTrackStorePath,
    ongoing_track_archive_path: layout.ongoingTrackArchivePath,
    conversation_cache_dir: layout.conversationCacheDir,
    app_daily_capture_dir: layout.appDailyCaptureDir,
    raw_transcript_active_dir: layout.rawTranscriptActiveDir,
    hot_cache_dir: layout.hotCacheDir,
    runtime_state_dir: layout.runtimeStateDir,
    startup_state_dir: layout.startupStateDir,
    wechat_transport_state_dir: layout.wechatTransportStateDir,
    hub_state_dir: layout.hubStateDir,
  };
  const legacyCandidates = [
    ["legacy_state_root", path.join(layout.dataRoot, "state")],
    ["legacy_mem0_lite_bank", path.join(layout.dataRoot, "mem0_lite_bank")],
    ["legacy_curated_store", path.join(layout.dataRoot, "curated_memories.json")],
    ["legacy_memory_versions", path.join(layout.dataRoot, "memory_versions")],
    ["legacy_conversation_cache", path.join(layout.dataRoot, "conversation_cache")],
    ["legacy_calendar_store", path.join(layout.dataRoot, "calendar_items.json")],
    ["legacy_wakeup_store", path.join(layout.dataRoot, "wakeup_journal.json")],
    ["legacy_calendar_pending", path.join(layout.dataRoot, "calendar_pending_actions.json")],
  ];
  const legacyShadows = legacyCandidates
    .filter(([, candidate]) => fs.existsSync(candidate))
    .map(([label, candidate]) => ({ label, path: candidate }));
  return {
    partition_ready: fs.existsSync(layout.storageRoot) && fs.existsSync(layout.cacheRoot),
    active_paths: activePaths,
    legacy_shadow_count: legacyShadows.length,
    legacy_shadows: legacyShadows,
  };
}

module.exports = {
  buildGatewayStorageHealth,
  buildGatewayStorageLayout,
  ensureGatewayStorageLayout,
};

function resolveOverridePath(overrideValue, fallback) {
  const normalized = typeof overrideValue === "string" ? overrideValue.trim() : "";
  return normalized ? path.resolve(normalized) : fallback;
}

function normalizeStorageSegment(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}
