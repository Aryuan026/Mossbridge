const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { buildGatewayStorageLayout } = require("../src/asherie/storage-layout");

test("buildGatewayStorageLayout supports split memory roots", () => {
  const layout = buildGatewayStorageLayout("/tmp/asherie-data", {
    truthLayerDirOverride: "/tmp/knowledge_tree/data/truth_layer",
    warmMemoryDirOverride: "/tmp/shared-storage/warm_memory",
    memoryVersionBankDirOverride: "/tmp/shared-storage/memory_versions",
  });

  assert.equal(layout.dataRoot, path.resolve("/tmp/asherie-data"));
  assert.equal(layout.cacheRoot, path.resolve("/tmp/asherie-data/cache"));
  assert.equal(layout.truthLayerDir, path.resolve("/tmp/knowledge_tree/data/truth_layer"));
  assert.equal(layout.memoryTreeDir, path.resolve("/tmp/asherie-data/storage/memory_tree"));
  assert.equal(layout.caseIndexDir, path.resolve("/tmp/asherie-data/storage/case_index"));
  assert.equal(layout.warmMemoryDir, path.resolve("/tmp/shared-storage/warm_memory"));
  assert.equal(layout.memoryVersionBankDir, path.resolve("/tmp/shared-storage/memory_versions"));
  assert.equal(layout.conversationCacheDir, path.resolve("/tmp/asherie-data/cache/conversation_cache"));
});
