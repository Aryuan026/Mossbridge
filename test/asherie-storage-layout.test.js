const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { buildGatewayStorageLayout } = require("../src/asherie/storage-layout");

test("buildGatewayStorageLayout supports split memory roots", () => {
  const layout = buildGatewayStorageLayout("/tmp/asherie-data", {
    truthLayerDirOverride: "/tmp/knowledge_tree/data/truth_layer",
    warmMemoryDirOverride: "/tmp/shared-storage/warm_memory",
    episodeJournalDirOverride: "/tmp/shared-storage/episode_journal",
    solitudeJournalDirOverride: "/tmp/shared-storage/solitude_journal",
    memoryVersionBankDirOverride: "/tmp/shared-storage/memory_versions",
  });

  assert.equal(layout.dataRoot, path.resolve("/tmp/asherie-data"));
  assert.equal(layout.cacheRoot, path.resolve("/tmp/asherie-data/cache"));
  assert.equal(layout.truthLayerDir, path.resolve("/tmp/knowledge_tree/data/truth_layer"));
  assert.equal(layout.memoryTreeDir, path.resolve("/tmp/asherie-data/storage/memory_tree"));
  assert.equal(layout.caseIndexDir, path.resolve("/tmp/asherie-data/storage/case_index"));
  assert.equal(layout.observationJournalDir, path.resolve("/tmp/asherie-data/storage/observation_journal"));
  assert.equal(layout.episodeJournalDir, path.resolve("/tmp/shared-storage/episode_journal"));
  assert.equal(layout.solitudeJournalDir, path.resolve("/tmp/shared-storage/solitude_journal"));
  assert.equal(layout.notebookDir, path.resolve("/tmp/asherie-data/storage/notebook"));
  assert.equal(layout.notionSyncDir, path.resolve("/tmp/asherie-data/storage/notion_sync"));
  assert.equal(layout.appDailyCaptureDir, path.resolve("/tmp/asherie-data/cache/app_daily_captures"));
  assert.equal(layout.warmMemoryDir, path.resolve("/tmp/shared-storage/warm_memory"));
  assert.equal(layout.memoryVersionBankDir, path.resolve("/tmp/shared-storage/memory_versions"));
  assert.equal(layout.conversationCacheDir, path.resolve("/tmp/asherie-data/cache/conversation_cache"));
});

test("buildGatewayStorageLayout scopes runtime cache by runtime id", () => {
  const layout = buildGatewayStorageLayout("/tmp/mossbridge-data", {
    runtimeId: "claudecode",
  });

  assert.equal(layout.runtimeStateDir, path.resolve("/tmp/mossbridge-data/cache/runtimes/claudecode"));
  assert.equal(layout.startupStateDir, path.resolve("/tmp/mossbridge-data/cache/startup/shared_claudecode"));
});
