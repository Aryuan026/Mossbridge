const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  exportMemoryBundle,
  importMemoryBundle,
} = require("../src/importers/memory-portability");
const { AsherieMemoryService } = require("../src/services/asherie-memory-service");
const { DiaryService } = require("../src/services/diary-service");

test("memory bundle export/import remaps same-format identity and remains recallable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-portability-"));
  const sourceDataRoot = path.join(root, "source-data");
  const targetDataRoot = path.join(root, "target-data");
  const bundleDir = path.join(root, "bundle");
  const sourceConfig = buildConfig({
    root,
    stateName: "source-state",
    dataRoot: sourceDataRoot,
    userId: "home-user",
    realmId: "home-realm",
    agentId: "asherie",
  });
  const targetConfig = buildConfig({
    root,
    stateName: "target-state",
    dataRoot: targetDataRoot,
    userId: "owner",
    realmId: "default",
    agentId: "moss",
  });
  const sourceMemory = new AsherieMemoryService({ config: sourceConfig });
  const sourceDiary = new DiaryService({ config: sourceConfig });

  await sourceMemory.writeWarmMaterial({
    material_id: "portable-warm",
    title: "Portable warm anchor",
    summary: "A warm memory that should survive a Home-shaped export.",
    body_markdown: "portable warm anchor recall token",
    tags: ["portable", "migration"],
    userId: sourceConfig.identityUserId,
  });
  await sourceMemory.upsertOngoingTrack({
    track_id: "portable-track",
    title: "Portable ongoing track",
    summary: "ongoing migration thread recall token",
    status: "active",
    userId: sourceConfig.identityUserId,
  });
  await sourceMemory.appendObservation({
    observation: "portable observation recall token",
    kind: "work_style",
    userId: sourceConfig.identityUserId,
  });
  await sourceMemory.upsertEpisode({
    episode_id: "portable-episode",
    title: "Portable episode",
    summary: "portable episode recall token",
    status: "active",
    userId: sourceConfig.identityUserId,
  });
  await sourceMemory.upsertCase({
    case_id: "portable-case",
    title: "Portable case",
    summary: "portable case recall token",
    status: "active",
    userId: sourceConfig.identityUserId,
  });
  await sourceMemory.upsertColdVersion({
    userId: sourceConfig.identityUserId,
    assistantId: sourceConfig.identityAgentId,
    payload: {
      hard_facts: [{
        id: "portable-cold",
        fact_key: "portable_cold_fact",
        fact_value: "portable cold root recall token",
      }],
    },
    versionLabel: "portable-cold-v1",
  });
  const sourceColdPacket = await sourceMemory.captureContextPacket({
    userId: sourceConfig.identityUserId,
    query: "portable cold root recall token",
    coldLimit: 4,
  });
  assert.equal(sourceColdPacket.cold_root_packet.hit_count > 0, true);
  await sourceMemory.appendSolitudeEntry({
    summary: "portable solitude note",
    userId: sourceConfig.identityUserId,
  });
  await sourceDiary.append({
    date: "2026-05-15",
    title: "Portable notebook",
    text: "portable notebook recall token",
  });
  await sourceMemory.writebackTurn({
    userId: sourceConfig.identityUserId,
    query: "portable conversation cache user token",
    assistantTextFinal: "portable conversation cache assistant token",
    sourceClient: "mossbridge_portability_test",
    runtimeId: "codex",
  });
  fs.mkdirSync(path.join(sourceDataRoot, "storage", "stickers"), { recursive: true });
  fs.writeFileSync(
    path.join(sourceDataRoot, "storage", "stickers", "index.json"),
    `${JSON.stringify({ "001": { desc: "portable sticker", tags: ["portable"] } }, null, 2)}\n`,
    "utf8",
  );

  const exported = exportMemoryBundle({
    sourceDataRoot,
    outputDir: bundleDir,
    sourceIdentity: {
      userId: "home-user",
      realmId: "home-realm",
      agentId: "asherie",
    },
  });
  assert.equal(exported.ok, true);
  assert.equal(exported.source_identity.userId, "home-user");

  const dryRun = importMemoryBundle({
    bundleDir,
    targetDataRoot,
    targetIdentity: {
      userId: "owner",
      realmId: "default",
      agentId: "moss",
    },
  });
  assert.equal(dryRun.applied, false);
  assert.equal(dryRun.stats.planned_files > 0, true);

  const imported = importMemoryBundle({
    bundleDir,
    targetDataRoot,
    targetIdentity: {
      userId: "owner",
      realmId: "default",
      agentId: "moss",
    },
    apply: true,
    replace: true,
  });
  assert.equal(imported.ok, true);
  assert.equal(imported.applied, true);
  assert.equal(imported.stats.skipped_existing, 0);

  const targetMemory = new AsherieMemoryService({ config: targetConfig });
  const packet = await targetMemory.captureContextPacket({
    userId: targetConfig.identityUserId,
    query: "portable warm ongoing observation episode case conversation cache token",
    recallMode: "user_triggered",
    includeSolitudeDigest: true,
    residentLimit: 4,
    limit: 8,
    preludeOngoingLimit: 4,
    preludeObservationLimit: 4,
    preludeEpisodeLimit: 4,
  });
  assert.equal(packet.ok, true);
  assert.equal(packet.cold_scope.owner_id, "owner");
  assert.equal(packet.cold_scope.realm_id, "default");
  assert.equal(packet.cold_scope.agent_id, "moss");
  assert.match(packet.runtime_prelude, /Portable warm anchor/);
  assert.match(packet.runtime_prelude, /Portable ongoing track/);
  assert.equal(packet.observation_journal_packet.hit_count > 0, true);
  assert.equal(packet.episode_journal_packet.hit_count > 0, true);
  assert.equal(packet.conversation_cache.records.length > 0, true);
  assert.equal(fs.existsSync(path.join(targetDataRoot, "storage", "warm_memory", "owner", "default", "moss", "index.json")), true);
  assert.equal(fs.existsSync(path.join(targetDataRoot, "storage", "case_index", "owner", "default", "moss", "portable-case", "case.json")), true);
  assert.equal(fs.existsSync(path.join(targetDataRoot, "storage", "episode_journal", "owner", "portable-episode", "episode.json")), true);
  assert.equal(fs.existsSync(path.join(targetDataRoot, "storage", "truth_layer", "owner", "default", "moss", "active-index.json")), true);
  assert.equal(fs.existsSync(path.join(targetDataRoot, "storage", "truth_layer", "home-user")), false);
  assert.equal(packet.cold_root_packet.hit_count > 0, true);
  assert.equal(fs.existsSync(path.join(targetDataRoot, "storage", "stickers", "index.json")), true);
});

test("memory bundle import aborts before partial writes when apply would conflict", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-portability-conflict-"));
  const sourceDataRoot = path.join(root, "source-data");
  const targetDataRoot = path.join(root, "target-data");
  const bundleDir = path.join(root, "bundle");
  const sourceConfig = buildConfig({
    root,
    stateName: "source-state",
    dataRoot: sourceDataRoot,
    userId: "home-user",
    realmId: "home-realm",
    agentId: "asherie",
  });
  const sourceMemory = new AsherieMemoryService({ config: sourceConfig });

  await sourceMemory.writeWarmMaterial({
    material_id: "conflict-warm",
    title: "Conflict warm anchor",
    summary: "This should not be partially imported over an existing target.",
    body_markdown: "conflict warm recall token",
    tags: ["portable"],
  });
  exportMemoryBundle({
    sourceDataRoot,
    outputDir: bundleDir,
    sourceIdentity: {
      userId: "home-user",
      realmId: "home-realm",
      agentId: "asherie",
    },
  });

  const existingIndexPath = path.join(targetDataRoot, "storage", "warm_memory", "owner", "default", "moss", "index.json");
  fs.mkdirSync(path.dirname(existingIndexPath), { recursive: true });
  fs.writeFileSync(existingIndexPath, "{}\n", "utf8");

  const result = importMemoryBundle({
    bundleDir,
    targetDataRoot,
    targetIdentity: {
      userId: "owner",
      realmId: "default",
      agentId: "moss",
    },
    apply: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.conflicts.length > 0, true);
  assert.equal(
    fs.existsSync(path.join(targetDataRoot, "storage", "warm_memory", "owner", "default", "moss", "materials", "conflict-warm.md")),
    false,
  );
});

function buildConfig({
  root,
  stateName,
  dataRoot,
  userId,
  realmId,
  agentId,
}) {
  return {
    stateDir: path.join(root, stateName),
    asherieDataRoot: dataRoot,
    notebookDir: path.join(dataRoot, "storage", "notebook"),
    diaryDir: path.join(dataRoot, "storage", "notebook"),
    runtime: "codex",
    identityUserId: userId,
    identityRealmId: realmId,
    identityAgentId: agentId,
    asherieContextCacheLimit: 50,
    asherieProactiveContextCacheLimit: 50,
    asherieRecallRecentRecordLimit: 8,
    asheriePreludeWarmLimit: 8,
    asheriePreludeResidentWarmLimit: 4,
    asheriePreludeOngoingLimit: 4,
    asheriePreludeObservationLimit: 4,
    asheriePreludeHotUpstreamLimit: 4,
    asheriePreludeHotTurnLimit: 6,
    asheriePreludeHotSnapshotLimit: 2,
  };
}
