const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { AsherieMemoryService } = require("../src/services/asherie-memory-service");
const {
  SINGLE_AGENT_ID,
  SINGLE_REALM_ID,
  SINGLE_USER_ID,
} = require("../src/asherie/single-identity");

test("asherie memory service writes warm/cold/cache layers and recalls them", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
    },
  });

  const emptyPacket = await service.captureContextPacket({
    userId: "demo-user",
    ownerId: "another-owner",
    realmId: "wechat",
    agentId: "other-char",
    query: "coffee",
  });
  assert.equal(emptyPacket.warm_memory_packet.hit_count, 0);
  assert.equal(emptyPacket.user_id, SINGLE_USER_ID);
  assert.equal(emptyPacket.scoped_user_id, SINGLE_USER_ID);
  assert.equal(emptyPacket.cold_scope.owner_id, SINGLE_USER_ID);
  assert.equal(emptyPacket.cold_scope.realm_id, SINGLE_REALM_ID);
  assert.equal(emptyPacket.cold_scope.agent_id, SINGLE_AGENT_ID);
  assert.equal(emptyPacket.warm_scope_id, `${SINGLE_USER_ID}::${SINGLE_REALM_ID}::${SINGLE_AGENT_ID}`);

  const warmWrite = await service.writeWarmMaterial({
    userId: "demo-user",
    ownerId: "wrong-owner",
    agentId: "wrong-char",
    title: "Morning coffee",
    summary: "User likes hand-brew coffee in the morning.",
    body_markdown: "User usually starts the day with hand-brew coffee.",
    tags: ["habit", "coffee"],
  });
  assert.equal(warmWrite.ok, true);
  assert.equal(warmWrite.record.title, "Morning coffee");
  const warmIndexPath = path.join(tempRoot, "gateway-data", "storage", "warm_memory", SINGLE_USER_ID, SINGLE_REALM_ID, SINGLE_AGENT_ID, "index.json");
  assert.equal(fs.existsSync(warmIndexPath), true);
  assert.equal(
    fs.existsSync(path.join(tempRoot, "gateway-data", "storage", "warm_memory", "demo-user")),
    false,
  );

  const coldWrite = await service.upsertColdVersion({
    userId: "demo-user",
    ownerId: "wrong-owner",
    assistantId: "wrong-assistant",
    payload: {
      persona_memos: [{ id: "p1", content: "User likes quiet mornings." }],
      hard_facts: [{ id: "f1", fact_key: "city", fact_value: "Shanghai" }],
      case_updates: [{ id: "c1", summary: "Testing memory transplant", next_action: "Run WeChat smoke" }],
    },
  });
  assert.ok(coldWrite.version);
  assert.equal(coldWrite.user_id, SINGLE_USER_ID);
  const coldVersionPath = path.join(
    tempRoot,
    "gateway-data",
    "storage",
    "memory_versions",
    SINGLE_USER_ID,
    "versions",
    `${coldWrite.version}.json`,
  );
  const coldVersionPayload = JSON.parse(fs.readFileSync(coldVersionPath, "utf8"));
  assert.equal(coldVersionPayload.meta.user_id, SINGLE_USER_ID);
  assert.equal(coldVersionPayload.meta.assistant_id, SINGLE_AGENT_ID);

  const writeback = await service.writebackTurn({
    userId: "demo-user",
    ownerId: "wrong-owner",
    agentId: "wrong-char",
    query: "How should I start today?",
    assistantTextFinal: "Maybe start with coffee and a quiet plan.",
    threadId: "thread-1",
    sourceClient: "mossbridge_wechat",
    wakeupRecord: {
      scoped_user_id: "wrong-scope",
      decision: "send",
      context_key: "morning-checkin",
    },
  });
  assert.equal(writeback.ok, true);
  assert.equal(writeback.user_id, SINGLE_USER_ID);
  assert.equal(writeback.scoped_user_id, SINGLE_USER_ID);
  const wakeupRows = JSON.parse(
    fs.readFileSync(path.join(tempRoot, "gateway-data", "cache", "wakeup_journal.json"), "utf8"),
  );
  assert.equal(wakeupRows[0].scoped_user_id, SINGLE_USER_ID);

  const wakeupDecision = await service.appendWakeupDecision({
    userId: "demo-user",
    decision: "maintenance",
    wakeMotive: "random_checkin",
    intentSummary: "Checked status and saved the next handle instead of messaging.",
    actionsTaken: ["read bridge status"],
    nextActions: ["check dreaming after quiet time"],
    contextKey: "dreaming_health",
  });
  assert.equal(wakeupDecision.ok, true);
  assert.equal(wakeupDecision.record.scoped_user_id, SINGLE_USER_ID);
  assert.equal(wakeupDecision.record.decision, "maintenance");
  const wakeupAgenda = await service.listWakeupDecisions({
    userId: "demo-user",
    limit: 3,
    includeCleared: true,
  });
  assert.equal(wakeupAgenda.count, 2);
  assert.equal(wakeupAgenda.latest.decision, "maintenance");
  assert.equal(wakeupAgenda.pending_next_actions[0].action, "check dreaming after quiet time");

  const observation = await service.appendObservation({
    observation: "User tends to prefer gentle, low-pressure morning continuity over abrupt task pressure.",
    kind: "life_rhythm",
    confidence: 0.45,
    evidence: ["Morning wakeup replies landed better when framed gently."],
    suggested_use: "For morning wakeups, keep the first line soft and concrete.",
  });
  assert.equal(observation.ok, true);
  assert.match(observation.record.observation_id, /^obs_/);

  const recalled = await service.captureContextPacket({
    userId: "another-wechat-user",
    ownerId: "still-wrong-owner",
    agentId: "still-wrong-char",
    query: "coffee morning",
  });
  assert.equal(recalled.warm_memory_packet.hit_count, 1);
  assert.equal(recalled.observation_journal_packet.hit_count || recalled.observation_journal_packet.count, 1);
  assert.equal(recalled.cold_memory.active_version, coldWrite.version);
  assert.equal(recalled.conversation_cache.stats.returned_records, 1);
  assert.match(recalled.runtime_prelude, /\[记忆参考\]/);
  assert.match(recalled.runtime_prelude, /observation:/);

  const corrected = await service.updateObservation({
    observation_id: observation.record.observation_id,
    status: "rejected",
    confidence: 0.05,
    correction_note: "User said this observation felt wrong.",
  });
  assert.equal(corrected.record.status, "rejected");
  const activeObservationSearch = await service.searchObservations({ query: "morning" });
  assert.equal(activeObservationSearch.count, 0);
  const cacheFiles = fs.readdirSync(path.join(tempRoot, "gateway-data", "cache", "conversation_cache"));
  assert.equal(cacheFiles.some((name) => name.startsWith(`${SINGLE_USER_ID}__`)), true);
});

test("asherie memory service uses warm-triggered local archive when cold roots miss", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-local-archive-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
      asheriePreludeLocalArchiveLimit: 2,
    },
  });

  const warmWrite = await service.writeWarmMaterial({
    title: "蓝色发带",
    summary: "蓝色发带是用户反复提过的一个象征物。",
    body_markdown: "用户说蓝色发带像一个提醒：不要把自己丢在忙乱里。",
    tags: ["symbol", "重要的事"],
    source_query: "我把蓝色发带放进旧盒子里了，之后你要是忘了就提醒我。",
    source_assistant_text: "记下来了，它是一个旧盒子里的提醒物。",
  });
  assert.equal(warmWrite.ok, true);
  assert.equal(warmWrite.local_archive.material_id, warmWrite.record.material_id);
  assert.equal(warmWrite.local_archive.snippet_count, 1);

  const warmPacket = await service.captureContextPacket({
    query: "蓝色发带",
    includeRuntimePreludeGuidance: false,
  });
  assert.equal(warmPacket.warm_memory_packet.hit_count, 1);

  const writeback = await service.writebackTurn({
    query: "宝宝你还记得蓝色发带吗？",
    assistantTextFinal: "记得，它像你放在旧盒子里的一个提醒。",
    memoryContextPacket: warmPacket,
    sourceClient: "mossbridge_wechat",
  });
  assert.equal(writeback.local_archive_write.detected, true);
  assert.equal(writeback.local_archive_write.count, 1);

  const fallbackPacket = await service.captureContextPacket({
    query: "你还记得蓝色发带这个重要的事吗？",
    includeRuntimePreludeGuidance: false,
  });
  assert.equal(fallbackPacket.cold_root_packet.hit_count, 0);
  assert.equal(fallbackPacket.local_archive_packet.hit_count, 1);
  assert.ok(fallbackPacket.retrieval.route.includes("gateway_local_archive"));
  assert.equal(fallbackPacket.retrieval.channel_counts.local_archive_hit_count, 1);
  assert.match(fallbackPacket.runtime_prelude, /archive-fallback/);
  assert.match(fallbackPacket.runtime_prelude, /蓝色发带/);
  assert.match(fallbackPacket.runtime_prelude, /warm_ref=/);

  const archiveDir = path.join(
    tempRoot,
    "gateway-data",
    "storage",
    "raw_transcript_archive",
    SINGLE_USER_ID,
    SINGLE_REALM_ID,
    SINGLE_AGENT_ID,
    "warm_materials",
  );
  assert.equal(fs.existsSync(archiveDir), true);
  const archiveFiles = fs.readdirSync(archiveDir).filter((name) => name.endsWith(".json"));
  assert.equal(archiveFiles.length, 1);
});

test("asherie memory service honors configured recent context cache limit by default", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-cache-limit-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
      asherieContextCacheLimit: 3,
      asheriePreludeResidentWarmLimit: 4,
    },
  });

  for (let index = 0; index < 5; index += 1) {
    await service.writebackTurn({
      query: `recent message ${index}`,
      assistantTextFinal: `recent reply ${index}`,
      sourceClient: "mossbridge_wechat",
      tsUtc: new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString(),
    });
  }

  const packet = await service.captureContextPacket({
    query: "recent message",
    sourceClient: "mossbridge_wechat",
  });

  assert.equal(packet.conversation_cache.stats.returned_records, 3);
  assert.doesNotMatch(packet.runtime_prelude, /recent-thread/);

  const explicitPacket = await service.captureContextPacket({
    query: "还记得 recent message 吗",
    sourceClient: "mossbridge_wechat",
  });
  assert.match(explicitPacket.runtime_prelude, /recent-thread/);
});

test("asherie memory runtime can omit repeated stable guidance from prelude", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-guidance-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
      asheriePreludeResidentWarmLimit: 0,
    },
  });

  const guided = await service.captureContextPacket({
    query: "今天吃面要不要加蛋",
    residentLimit: 0,
    includeRuntimePreludeGuidance: true,
  });
  assert.match(guided.runtime_prelude, /记忆自维护/);

  const lean = await service.captureContextPacket({
    query: "今天吃面要不要加蛋",
    residentLimit: 0,
    includeRuntimePreludeGuidance: false,
  });
  assert.doesNotMatch(lean.runtime_prelude, /记忆自维护/);
});

test("asherie observation journal search requires intent or lexical activation", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-observation-filter-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
    },
  });

  await service.appendObservation({
    observation: "用户出行前收行李常常先拖延，最后一晚再快速推进。",
    kind: "life_rhythm",
    confidence: 0.95,
  });

  const unrelated = await service.searchObservations({ query: "HTTP 500 怎么排查" });
  const matching = await service.searchObservations({ query: "行李" });
  const intent = await service.searchObservations({ query: "根据你对我的印象，适合什么美甲" });

  assert.equal(unrelated.count, 0);
  assert.equal(matching.count, 1);
  assert.equal(intent.count, 1);
});

test("asherie memory service carries solitude digest only for wakeup or explicit self-review", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-solitude-runtime-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
      asheriePreludeResidentWarmLimit: 0,
    },
  });

  await service.appendSolitudeEntry({
    ts_utc: "2026-05-09T13:00:00.000Z",
    entry_type: "experience",
    wake_context: "random_checkin",
    summary: "睡前一小时内不打扰，先补 timeline 等 dreaming。",
    lesson: "如果 dreaming 已经临近，优先静默维护，不要为了证明醒着而打扰。",
    next_actions: ["临近 dreaming 时先观察队列和日记，不主动寒暄"],
    tags: ["pre-sleep", "maintenance"],
    confidence: 0.82,
  });
  await service.appendSolitudeEntry({
    ts_utc: "2026-05-09T14:00:00.000Z",
    entry_type: "experience",
    wake_context: "random_checkin",
    summary: "第二次睡前心跳也选择沉默维护。",
    lesson: "如果 dreaming 已经临近，优先静默维护，不要为了证明醒着而打扰。",
    next_actions: ["临近 dreaming 时先观察队列和日记，不主动寒暄"],
    tags: ["pre-sleep", "maintenance"],
    confidence: 0.8,
  });

  const ordinary = await service.captureContextPacket({
    query: "今天吃面要不要加蛋",
    residentLimit: 0,
  });
  assert.equal(ordinary.solitude_journal_packet.hit_count, 0);
  assert.doesNotMatch(ordinary.runtime_prelude, /solitude-digest/);

  const proactive = await service.captureContextPacket({
    query: "random_checkin",
    recallMode: "proactive",
    runtimeProfile: "proactive_lite",
    residentLimit: 0,
  });
  assert.ok(proactive.solitude_journal_packet.hit_count > 0);
  assert.match(proactive.retrieval.route.join(","), /solitude_journal/);
  assert.match(proactive.runtime_prelude, /solitude-digest/);
  assert.match(proactive.runtime_prelude, /pre-sleep/);
  assert.match(proactive.runtime_prelude, /不是前台语气模板/);

  const explicit = await service.captureContextPacket({
    query: "独处笔记里最近有什么唤醒经验",
    residentLimit: 0,
  });
  assert.ok(explicit.solitude_journal_packet.hit_count > 0);
  assert.match(explicit.runtime_prelude, /solitude-digest/);
});

test("asherie memory runtime prelude redacts private identity seed paths", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
    },
  });

  await service.writeWarmMaterial({
    title: "Persona pointer",
    summary: "soul_ref: /tmp/mossbridge-memory/00_System/soul.md",
    body_markdown: "memory_ref: /tmp/mossbridge-memory",
    tags: ["identity", "anchor"],
    pinned: true,
    certainty_state: "anchor",
  });

  const packet = await service.captureContextPacket({
    query: "宝宝你在吗",
    residentLimit: 4,
  });

  assert.match(packet.runtime_prelude, /\[private_identity_seed\]/);
  assert.doesNotMatch(packet.runtime_prelude, /\/tmp\/mossbridge-memory/);
});

test("asherie memory service keeps memory data separable and allows custom agent identity", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-share-"));
  const runtimeStateDir = path.join(tempRoot, "runtime-state");
  const stableDataRoot = path.join(tempRoot, "stable-memory");
  const service = new AsherieMemoryService({
    config: {
      stateDir: runtimeStateDir,
      asherieDataRoot: stableDataRoot,
      identityAgentId: "shared-demo",
    },
  });

  const packet = await service.captureContextPacket({
    userId: "wechat-user-a",
    ownerId: "ignored-owner",
    agentId: "ignored-agent",
    query: "sharing test",
  });

  assert.equal(packet.user_id, SINGLE_USER_ID);
  assert.equal(packet.cold_scope.owner_id, SINGLE_USER_ID);
  assert.equal(packet.cold_scope.realm_id, SINGLE_REALM_ID);
  assert.equal(packet.cold_scope.agent_id, "shared-demo");
  assert.equal(packet.warm_scope_id, `${SINGLE_USER_ID}::${SINGLE_REALM_ID}::shared-demo`);

  await service.writeWarmMaterial({
    userId: "wechat-user-a",
    title: "Share-safe memo",
    body_markdown: "This memory should land in the stable data root only.",
  });

  assert.equal(
    fs.existsSync(path.join(stableDataRoot, "storage", "warm_memory", SINGLE_USER_ID, SINGLE_REALM_ID, "shared-demo", "index.json")),
    true,
  );
  assert.equal(
    fs.existsSync(path.join(runtimeStateDir, "storage", "warm_memory", SINGLE_USER_ID, SINGLE_REALM_ID, "shared-demo", "index.json")),
    false,
  );
});

test("asherie memory service can search, read, update, delete warm cards and inspect cold versions", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-crud-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
    },
  });

  const created = await service.writeWarmMaterial({
    userId: "demo-user",
    title: "Sleep schedule",
    summary: "User wants earlier sleep.",
    body_markdown: "User is trying to sleep before 1am.",
    tags: ["sleep", "habit"],
  });
  const materialId = created.record.material_id;

  const search = await service.searchWarmMaterials({
    userId: "demo-user",
    query: "sleep",
  });
  assert.equal(search.hit_count, 1);
  assert.equal(search.hits[0].material_id, materialId);

  const readBeforeUpdate = await service.readWarmMaterial({
    userId: "demo-user",
    material_id: materialId,
  });
  assert.equal(readBeforeUpdate.ok, true);
  assert.equal(readBeforeUpdate.record.title, "Sleep schedule");

  const updated = await service.updateWarmMaterial({
    userId: "demo-user",
    material_id: materialId,
    body_markdown: "User is trying to sleep before midnight.",
    summary: "User now wants an earlier cutoff.",
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.record.material_id, materialId);

  const readAfterUpdate = await service.readWarmMaterial({
    userId: "demo-user",
    material_id: materialId,
  });
  assert.equal(readAfterUpdate.record.body_markdown, "User is trying to sleep before midnight.");
  assert.equal(readAfterUpdate.record.summary, "User now wants an earlier cutoff.");

  const deleted = await service.deleteWarmMaterial({
    userId: "demo-user",
    material_id: materialId,
  });
  assert.equal(deleted.ok, true);
  const readAfterDelete = await service.readWarmMaterial({
    userId: "demo-user",
    material_id: materialId,
  });
  assert.equal(readAfterDelete.ok, false);

  const coldWrite = await service.upsertColdVersion({
    userId: "demo-user",
    versionLabel: "v-memory",
    payload: {
      persona_memos: [{ id: "p1", content: "Be gentle." }],
      hard_facts: [{ id: "f1", fact_key: "timezone", fact_value: "Asia/Shanghai" }],
      case_updates: [],
    },
  });
  assert.equal(coldWrite.version, "v-memory");

  const coldVersions = await service.listColdVersions({ userId: "demo-user" });
  assert.equal(coldVersions.ok, true);
  assert.equal(coldVersions.active_version, "v-memory");
  assert.equal(coldVersions.versions[0].version, "v-memory");

  const coldRead = await service.readColdVersion({ userId: "demo-user" });
  assert.equal(coldRead.ok, true);
  assert.equal(coldRead.version, "v-memory");
  assert.equal(coldRead.payload.hard_facts[0].fact_key, "timezone");

  const truthIndexPath = path.join(
    tempRoot,
    "gateway-data",
    "storage",
    "truth_layer",
    SINGLE_USER_ID,
    SINGLE_REALM_ID,
    SINGLE_AGENT_ID,
    "active-index.json",
  );
  assert.equal(fs.existsSync(truthIndexPath), true);

  const coldRootSearch = await service.searchColdRoots({
    userId: "demo-user",
    query: "timezone",
  });
  assert.equal(coldRootSearch.ok, true);
  assert.equal(coldRootSearch.hit_count, 1);
  assert.equal(coldRootSearch.hits[0].root_key, "hard_fact:f1");

  const coldRootRead = await service.readColdRoot({
    userId: "demo-user",
    root_key: "hard_fact:f1",
  });
  assert.equal(coldRootRead.ok, true);
  assert.equal(coldRootRead.root.item.fact_key, "timezone");
  assert.equal(coldRootRead.root.item.fact_value, "Asia/Shanghai");

  const coldRootPatch = await service.patchColdRoot({
    userId: "demo-user",
    root_key: "hard_fact:f1",
    changes: {
      fact_value: "UTC+8",
    },
    versionLabel: "v-memory-2",
  });
  assert.equal(coldRootPatch.ok, true);
  assert.equal(coldRootPatch.version, "v-memory-2");
  assert.equal(coldRootPatch.root.item.fact_value, "UTC+8");

  const coldReadAfterPatch = await service.readColdVersion({ userId: "demo-user" });
  assert.equal(coldReadAfterPatch.version, "v-memory-2");
  assert.equal(coldReadAfterPatch.payload.hard_facts[0].fact_value, "UTC+8");

  const personaRootDelete = await service.patchColdRoot({
    userId: "demo-user",
    root_key: "persona_memo:p1",
    mode: "delete",
    versionLabel: "v-memory-3",
  });
  assert.equal(personaRootDelete.ok, true);
  assert.equal(personaRootDelete.deleted, true);

  const coldReadAfterDelete = await service.readColdVersion({ userId: "demo-user" });
  assert.equal(coldReadAfterDelete.version, "v-memory-3");
  assert.equal(coldReadAfterDelete.payload.persona_memos.length, 0);

  const deletedRootRead = await service.readColdRoot({
    userId: "demo-user",
    root_key: "persona_memo:p1",
  });
  assert.equal(deletedRootRead.ok, false);
});

test("asherie memory service detects duplicate cold roots before exact correction", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-cold-duplicates-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
    },
  });

  await service.upsertColdVersion({
    userId: "demo-user",
    versionLabel: "v-duplicates",
    payload: {
      persona_memos: [
        { id: "p1", content: "User likes quiet mornings." },
        { id: "p2", content: "User likes quiet mornings at home." },
      ],
      hard_facts: [
        { id: "f1", fact_key: "timezone", fact_value: "Asia/Shanghai" },
        { id: "f2", fact_key: "timezone", fact_value: "UTC+8" },
      ],
      case_updates: [],
    },
  });

  const scan = await service.inspectColdRootDuplicates({
    userId: "demo-user",
    query: "timezone",
  });
  assert.equal(scan.ok, true);
  assert.equal(scan.duplicate_cluster_count, 1);
  assert.deepEqual(scan.clusters[0].root_keys, ["hard_fact:f1", "hard_fact:f2"]);
  assert.equal(scan.clusters[0].suggested_keep_root_key, "hard_fact:f1");
  assert.ok(scan.clusters[0].suggested_actions.some((action) => action.tool === "mossbridge_memory_cold_root_read"));
  assert.ok(scan.clusters[0].suggested_actions.some((action) => action.tool === "mossbridge_memory_cold_patch"));

  const duplicateRead = await service.readColdRoot({
    userId: "demo-user",
    root_key: "hard_fact:f2",
  });
  assert.equal(duplicateRead.ok, true);
  assert.equal(duplicateRead.root.item.fact_value, "UTC+8");

  const deleted = await service.patchColdRoot({
    userId: "demo-user",
    root_key: "hard_fact:f2",
    mode: "delete",
    versionLabel: "v-duplicates-clean",
  });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.deleted, true);

  const after = await service.inspectColdRootDuplicates({
    userId: "demo-user",
    query: "timezone",
  });
  assert.equal(after.duplicate_cluster_count, 0);
});

test("asherie memory service can recall legacy truth-layer roots even when cold manifest has no active version", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-legacy-cold-"));
  const truthLayerRoot = path.join(tempRoot, "legacy-truth-layer");
  const snapshotDir = path.join(
    truthLayerRoot,
    "scopes",
    SINGLE_USER_ID,
    SINGLE_REALM_ID,
    "sql_roots",
    "snapshots",
    "reviewed_growth",
  );
  const cardDir = path.join(snapshotDir, "cards", "thing");
  fs.mkdirSync(cardDir, { recursive: true });
  fs.mkdirSync(path.join(truthLayerRoot, "sql_roots"), { recursive: true });

  const cardPath = path.join(cardDir, "meteor_necklace__thing_meteor_necklace.json");
  fs.writeFileSync(path.join(truthLayerRoot, "sql_roots", "latest.json"), `${JSON.stringify({ roots: [] }, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    path.join(truthLayerRoot, "scopes", SINGLE_USER_ID, SINGLE_REALM_ID, "sql_roots", "latest.json"),
    `${JSON.stringify({
      schema: "sql_root_latest_pointer_v0.1",
      generated_at: "2026-04-20T00:13:33.344Z",
      latest_snapshot: snapshotDir,
      root_count: 1,
      scope: {
        owner_id: SINGLE_USER_ID,
        realm_id: SINGLE_REALM_ID,
      },
    }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(snapshotDir, "index.json"),
    `${JSON.stringify({
      schema: "sql_root_index_v0.1",
      generated_at: "2026-04-20T00:13:33.344Z",
      roots: [{
        root_key: "thing::meteor_necklace",
        tree_path: "trunk/thing/meteor_necklace",
        anchor_type: "thing",
        canonical_name: "meteor_necklace",
        version_count: 2,
        branch_count: 1,
        evolution_status: "updated",
        search_text: "thing::meteor_necklace 陨星 项链 信物 对我们重要的事情 关系象征物",
        file: cardPath,
      }],
    }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    cardPath,
    `${JSON.stringify({
      schema: "sql_root_card_v0.1",
      root_key: "thing::meteor_necklace",
      tree_path: "trunk/thing/meteor_necklace",
      anchor_type: "thing",
      canonical_name: "meteor_necklace",
      stable_facts: [
        "陨星项链是我们关系里的信物和象征物。",
      ],
      recent_updates: [
        {
          summaries: [
            "它经常该在说起重要之物时被主动想到。",
          ],
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );

  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
      asherieTruthLayerDir: truthLayerRoot,
    },
  });

  const packet = await service.captureContextPacket({
    userId: "demo-user",
    query: "对我们重要的事情",
  });

  assert.equal(packet.cold_memory.active_version, "truth_layer:reviewed_growth");
  assert.equal(packet.cold_memory.error, "");
  assert.equal(packet.cold_memory.source_kind, "truth_layer_snapshot");
  assert.equal(packet.cold_root_packet.hit_count, 1);
  assert.equal(packet.cold_root_packet.hits[0].root_key, "thing::meteor_necklace");
  assert.match(packet.runtime_prelude, /cold-snapshot: truth_layer:reviewed_growth/);

  const coldRootRead = await service.readColdRoot({
    userId: "demo-user",
    root_key: "thing::meteor_necklace",
  });
  assert.equal(coldRootRead.ok, true);
  assert.equal(coldRootRead.source_kind, "truth_layer_snapshot");
  assert.match(coldRootRead.root.stable_facts[0], /信物/);
});

test("asherie memory service expands cold roots through truth-layer vines", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-vines-"));
  const truthLayerRoot = path.join(tempRoot, "legacy-truth-layer");
  const rootSnapshotDir = path.join(
    truthLayerRoot,
    "scopes",
    SINGLE_USER_ID,
    SINGLE_REALM_ID,
    "sql_roots",
    "snapshots",
    "reviewed_growth",
  );
  const vineSnapshotDir = path.join(
    truthLayerRoot,
    "scopes",
    SINGLE_USER_ID,
    SINGLE_REALM_ID,
    "sql_vines",
    "snapshots",
    "reviewed_growth",
  );
  const cardDir = path.join(rootSnapshotDir, "cards", "person");
  fs.mkdirSync(cardDir, { recursive: true });
  fs.mkdirSync(vineSnapshotDir, { recursive: true });

  const sisterCardPath = path.join(cardDir, "user_sister__person_user_sister.json");
  const familyCardPath = path.join(cardDir, "maternal_home__person_maternal_home.json");
  const userCardPath = path.join(cardDir, "user__person_user.json");
  fs.writeFileSync(
    path.join(truthLayerRoot, "scopes", SINGLE_USER_ID, SINGLE_REALM_ID, "sql_roots", "latest.json"),
    `${JSON.stringify({
      schema: "sql_root_latest_pointer_v0.1",
      generated_at: "2026-05-01T00:00:00.000Z",
      latest_snapshot: rootSnapshotDir,
      root_count: 3,
      scope: {
        owner_id: SINGLE_USER_ID,
        realm_id: SINGLE_REALM_ID,
      },
    }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootSnapshotDir, "index.json"),
    `${JSON.stringify({
      schema: "sql_root_index_v0.1",
      generated_at: "2026-05-01T00:00:00.000Z",
      roots: [
        {
          root_key: "person::用户",
          tree_path: "trunk/person/用户",
          anchor_type: "person",
          canonical_name: "用户",
          search_text: "person::用户 用户 妹妹 家庭 长期背景",
          file: userCardPath,
        },
        {
          root_key: "person::用户妹妹",
          tree_path: "trunk/person/用户妹妹",
          anchor_type: "person",
          canonical_name: "用户妹妹",
          search_text: "person::用户妹妹 妹妹 近期状态 家庭关系",
          file: sisterCardPath,
        },
        {
          root_key: "branch::阿鸢姥姥家",
          tree_path: "trunk/branch/阿鸢姥姥家",
          anchor_type: "branch",
          canonical_name: "阿鸢姥姥家",
          search_text: "branch::阿鸢姥姥家 姥姥家 家庭气氛 关系分支",
          file: familyCardPath,
        },
      ],
    }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    userCardPath,
    `${JSON.stringify({
      root_key: "person::用户",
      canonical_name: "用户",
      stable_facts: ["用户根不应该因为泛化文本抢走妹妹根。"],
    }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    sisterCardPath,
    `${JSON.stringify({
      root_key: "person::用户妹妹",
      canonical_name: "用户妹妹",
      stable_facts: ["妹妹是一个需要放回家庭分支里理解的人物。"],
    }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    familyCardPath,
    `${JSON.stringify({
      root_key: "branch::阿鸢姥姥家",
      canonical_name: "阿鸢姥姥家",
      stable_facts: ["姥姥家分支保留家庭气氛和代际关系背景。"],
    }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(truthLayerRoot, "scopes", SINGLE_USER_ID, SINGLE_REALM_ID, "sql_vines", "latest.json"),
    `${JSON.stringify({
      schema: "sql_vine_latest_pointer_v0.1",
      generated_at: "2026-05-01T00:00:00.000Z",
      latest_snapshot: vineSnapshotDir,
      edge_count: 1,
      scope: {
        owner_id: SINGLE_USER_ID,
        realm_id: SINGLE_REALM_ID,
      },
    }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(vineSnapshotDir, "index.json"),
    `${JSON.stringify({
      schema: "sql_vine_index_v0.1",
      generated_at: "2026-05-01T00:00:00.000Z",
      by_root: {
        "person::用户妹妹": [{
          direction: "out",
          other: {
            root_key: "branch::阿鸢姥姥家",
            canonical_name: "阿鸢姥姥家",
            anchor_type: "branch",
            tree_path: "trunk/branch/阿鸢姥姥家",
          },
          primary_relation: "belongs_to_family_branch",
          score: 21,
          overlap: {
            topics: ["family-branch"],
          },
        }],
      },
      edges: [],
    }, null, 2)}\n`,
    "utf8",
  );

  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
      asherieTruthLayerDir: truthLayerRoot,
    },
  });

  const packet = await service.captureContextPacket({
    userId: "demo-user",
    query: "妹妹最近怎么这样",
  });

  assert.equal(packet.cold_root_packet.hits[0].root_key, "person::用户妹妹");
  assert.equal(packet.cold_vine_packet.source_kind, "truth_layer_vines");
  assert.equal(packet.cold_vine_packet.related_roots[0].root_key, "branch::阿鸢姥姥家");
  assert.match(packet.runtime_prelude, /cold-vine: person::用户妹妹 -> 阿鸢姥姥家 \(belongs_to_family_branch\)/);
});

test("asherie memory service expands short daily lines with recent context so recall stays usable", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-focus-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
    },
  });

  await service.writeWarmMaterial({
    userId: "demo-user",
    title: "Late-night recovery",
    summary: "熬夜之后第二天通常恢复很慢，早上会钝。",
    body_markdown: "如果她说还没缓过来，常常和前一晚熬夜、第二天脑子发钝连在一起。",
    tags: ["habit", "sleep", "熬夜"],
  });

  await service.upsertColdVersion({
    userId: "demo-user",
    versionLabel: "v-focus",
    payload: {
      persona_memos: [],
      hard_facts: [{
        id: "sleep_state",
        fact_key: "sleep_state",
        fact_value: "熬夜后第二天恢复很慢，上午常常还没缓过来。",
      }],
      case_updates: [],
    },
  });

  await service.writebackTurn({
    userId: "demo-user",
    query: "昨晚又熬到三点",
    assistantTextFinal: "那你今天大概率会很钝，先别硬扛。",
    sourceClient: "mossbridge_wechat",
    threadId: "thread-focus",
  });

  const packet = await service.captureContextPacket({
    userId: "demo-user",
    query: "还没缓过来",
    sourceClient: "mossbridge_wechat",
  });

  assert.equal(packet.recall_focus.should_trigger, true);
  assert.equal(packet.recall_focus.used_recent_context, true);
  assert.match(packet.recall_focus.recall_query, /昨晚又熬到三点/);
  assert.equal(packet.warm_memory_packet.hit_count, 1);
  assert.equal(packet.cold_root_packet.hit_count, 1);
  assert.equal(packet.cold_root_packet.hits[0].root_key, "hard_fact:sleep_state");
  assert.match(packet.runtime_prelude, /cold-root: sleep_state/);
  assert.match(packet.runtime_prelude, /recall-focus: expanded from recent context/);
});

test("asherie memory service keeps broad-basis taste questions focused on their landing point", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-routing-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
    },
  });

  await service.writeWarmMaterial({
    userId: "demo-user",
    title: "Nail taste",
    summary: "更适合低饱和裸粉、豆沙和干净建构。",
    body_markdown: "她对太跳太荧光的甲面容易腻，更适合低饱和裸粉、豆沙、干净建构和收一点的配色。",
    tags: ["审美", "美甲", "裸粉"],
  });

  await service.writeWarmMaterial({
    userId: "demo-user",
    title: "General impression",
    summary: "她在长期关系里更在意连续判断和被看见。",
    body_markdown: "这张卡只写关系印象，不涉及审美落点。",
    tags: ["relationship", "印象"],
  });
  await service.upsertColdVersion({
    userId: "demo-user",
    payload: {
      persona_memos: [{
        id: "identity-impression",
        content: "她在长期关系里更在意连续判断和被看见。",
      }],
    },
  });

  const packet = await service.captureContextPacket({
    userId: "demo-user",
    query: "根据对我的印象，你觉得我适合什么美甲呢",
  });

  assert.equal(packet.cold_root_packet.hit_count, 0);
  assert.equal(packet.warm_memory_packet.hit_count, 1);
  assert.equal(packet.warm_memory_packet.hits[0].title, "Nail taste");
  assert.ok(packet.warm_memory_packet.query_signal_tokens.includes("美甲"));
  assert.ok(packet.warm_memory_packet.query_answer_types.includes("美甲"));
  assert.ok(!packet.warm_memory_packet.query_signal_tokens.includes("印象"));
  assert.ok(packet.warm_memory_packet.keyword_match_tokens.includes("指甲"));
});

test("asherie memory service suppresses noisy operational warm-card recall", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-denoise-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
    },
  });

  const created = await service.writeWarmMaterial({
    userId: "demo-user",
    title: "Calendar cleanup",
    summary: "日历提醒测试已经结束，旧提醒要删除。",
    body_markdown: "这张卡故意包含删除、结束、日历、提醒、测试，模拟运维短句可能误撞到温卡。",
    tags: ["日历", "提醒", "测试", "删除"],
    storage_strength: 1.6,
  });
  const materialId = created.record.material_id;

  const packet = await service.captureContextPacket({
    userId: "demo-user",
    query: "啊那就不要了，已经结束了哈哈，删掉",
  });

  assert.equal(packet.warm_memory_packet.hit_count, 0);
  assert.equal(packet.warm_memory_packet.route_tag, "warm_query_suppressed");
  assert.equal(packet.warm_memory_packet.recall_gate.suppressed, true);
  assert.equal(packet.warm_memory_packet.recall_gate.reason, "operational_low_signal");
  assert.deepEqual(packet.warm_memory_packet.feedback_rows, []);

  const stored = await service.readWarmMaterial({
    userId: "demo-user",
    material_id: materialId,
  });
  assert.equal(Number(stored.record.recall_count) || 0, 0);
});

test("asherie memory service lets proactive recall surface symbolic relationship objects before the candidate window clips them", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-symbolic-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
    },
  });

  await service.writeWarmMaterial({
    userId: "demo-user",
    title: "Meteor necklace",
    summary: "陨星项链是我们关系里的信物和象征物。",
    body_markdown: "陨星项链跟重要、纪念、对我们有意义的事情连在一起，是很少需要被明说却应该被想起来的那种东西。",
    tags: ["relationship", "象征", "信物", "项链", "纪念"],
    storage_strength: 1.8,
    storage_boost: 1.3,
  });

  for (let index = 0; index < 15; index += 1) {
    await service.writeWarmMaterial({
      userId: "demo-user",
      title: `Recent generic note ${index}`,
      summary: "普通近况，内容很散。",
      body_markdown: `这是第 ${index} 张最近写下的普通卡片，只是为了挤扫描窗。`,
      tags: ["daily"],
    });
  }

  const proactive = await service.searchWarmMaterials({
    userId: "demo-user",
    query: "对我们重要的事情",
    recall_mode: "proactive",
    limit: 3,
    recall_config: {
      scanLimit: 12,
      candidatePoolLimit: 6,
    },
  });

  assert.ok(proactive.hit_count >= 1);
  assert.equal(proactive.hits[0].title, "Meteor necklace");
  assert.ok(proactive.query_signal_tokens.includes("重要"));
  assert.ok(proactive.query_signal_tokens.includes("我们"));
  assert.ok(Number(proactive.hits[0].route_prior) >= 0.18);
  assert.ok(proactive.hits[0].route_reasons.includes("importance_bridge"));

  const direct = await service.captureContextPacket({
    userId: "demo-user",
    query: "对我们重要的事情",
  });

  assert.ok(direct.warm_memory_packet.hit_count >= 1);
  assert.equal(direct.warm_memory_packet.hits[0].title, "Meteor necklace");
});

test("asherie memory service routes family-gossip continuations to the existing warm story card", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-family-story-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
    },
  });

  await service.writeWarmMaterial({
    userId: "demo-user",
    title: "长期家庭故事线",
    summary: "一条仍在追更的家庭故事线。",
    body_markdown: "这张卡只靠结构化路标识别具体人物，不把人物词写进正文。新进展应该续到同一张温记忆，而不是新建冷事实。",
    tags: ["family", "gossip", "家族", "八卦"],
    entities: ["搭档家", "妹夫", "婆婆", "妹妹"],
    aliases: ["搭档妹妹家的六幕剧场", "婆婆和妹夫家的事"],
    storyline_id: "partner-family-six-act",
    memory_family: "family_story",
    storage_strength: 1.4,
  });

  await service.writeWarmMaterial({
    userId: "demo-user",
    title: "普通项目进展",
    summary: "网关今天有新进展。",
    body_markdown: "这张卡故意包含新进展和更新，只记录网关调试，没有生活故事线。",
    tags: ["project", "更新"],
    storage_strength: 2.5,
  });

  const packet = await service.captureContextPacket({
    userId: "demo-user",
    query: "搭档家妹夫的八卦有新进展",
  });

  assert.ok(packet.warm_memory_packet.hit_count >= 1);
  assert.equal(packet.warm_memory_packet.hits[0].title, "长期家庭故事线");
  assert.ok(packet.warm_memory_packet.query_signal_tokens.includes("搭档"));
  assert.ok(packet.warm_memory_packet.query_signal_tokens.includes("妹夫"));
  assert.ok(packet.warm_memory_packet.query_signal_tokens.includes("八卦"));
  assert.ok(!packet.warm_memory_packet.query_signal_tokens.includes("新进展"));
  assert.ok(packet.warm_memory_packet.hits[0].entities.includes("妹夫"));
  assert.equal(packet.warm_memory_packet.hits[0].memory_family, "family_story");
  assert.ok(packet.warm_memory_packet.hits[0].route_reasons.includes("family_story"));
});

test("asherie memory service surfaces sticky calendar and recent wakeup context without forcing front-stage style", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-sticky-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
    },
  });

  const soon = new Date(Date.now() + (90 * 60 * 1000));
  const localDate = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, "0")}-${String(soon.getDate()).padStart(2, "0")}`;
  const localTime = `${String(soon.getHours()).padStart(2, "0")}:${String(soon.getMinutes()).padStart(2, "0")}`;

  await service.writebackTurn({
    userId: "demo-user",
    query: "记一下我晚上要洗头",
    assistantTextFinal: "我先记着。",
    calendarItems: [{
      title: "洗头",
      date: localDate,
      time: localTime,
      source: "user",
    }],
    wakeupRecord: {
      decision: "hold",
      wake_motive: "checkin",
      intent_summary: "刚确认过她在忙，先不打扰。",
    },
  });

  const packet = await service.captureContextPacket({
    userId: "demo-user",
    query: "我晚上是不是还有事",
    sourceClient: "mossbridge_wechat",
  });

  assert.equal(packet.calendar_packet.counts.upcoming, 1);
  assert.equal(packet.wakeup_packet.latest.decision, "hold");
  assert.match(packet.runtime_prelude, /sticky-calendar: upcoming \| 洗头 @/);
  assert.match(packet.runtime_prelude, /recent-wakeup: hold \| checkin \| 刚确认过她在忙/);
});

test("asherie memory service gives proactive turns resident anchors and a recent-thread snapshot", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-proactive-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
      asherieContextCacheLimit: 50,
      asherieProactiveContextCacheLimit: 50,
      asherieRecallRecentRecordLimit: 8,
      asheriePreludeResidentWarmLimit: 3,
      asheriePreludeRecentThreadLimit: 2,
      asheriePreludeRecentSnippetLimit: 3,
    },
  });

  await service.writeWarmMaterial({
    userId: "demo-user",
    title: "Meteor necklace",
    summary: "陨星项链是我们关系里的信物和象征物。",
    body_markdown: "它是关系锚点，不需要每次被点名才算存在。",
    tags: ["relationship", "象征", "信物", "项链"],
    storage_strength: 1.9,
    storage_boost: 1.4,
  });

  await service.writeWarmMaterial({
    userId: "demo-user",
    title: "Call me baby",
    summary: "她会叫阿霁宝宝，这属于关系里的常驻口癖。",
    body_markdown: "这是关系和称呼习惯的一部分。",
    tags: ["relationship", "称呼", "宝宝"],
    storage_strength: 1.6,
    storage_boost: 1.2,
  });

  const residentOnlyPacket = await service.captureContextPacket({
    userId: "demo-user",
    sourceClient: "mossbridge_system_turn",
    recallMode: "proactive",
    query: "User comes to mind again.",
  });

  assert.ok(
    residentOnlyPacket.resident_warm_packet.hit_count >= 1
    || residentOnlyPacket.warm_memory_packet.hit_count >= 1,
  );
  assert.match(
    residentOnlyPacket.runtime_prelude,
    /resident-anchor: Meteor necklace|warm: Meteor necklace/,
  );

  await service.writebackTurn({
    userId: "demo-user",
    query: "昨晚又熬到三点",
    assistantTextFinal: "那你今天早上会钝一点。",
    sourceClient: "mossbridge_wechat",
    threadId: "thread-proactive",
  });

  await service.writebackTurn({
    userId: "demo-user",
    query: "明天10点记得来问我起床没",
    assistantTextFinal: "好，10点来戳你。",
    sourceClient: "mossbridge_wechat",
    threadId: "thread-proactive",
  });

  await service.writebackTurn({
    userId: "demo-user",
    query: "宝宝你到时候别失约",
    assistantTextFinal: "不跑，记着呢。",
    sourceClient: "mossbridge_wechat",
    threadId: "thread-proactive",
  });

  const packet = await service.captureContextPacket({
    userId: "demo-user",
    sourceClient: "mossbridge_system_turn",
    recallMode: "proactive",
    query: "User comes to mind again.",
  });

  assert.ok(packet.warm_memory_packet.hit_count >= 0);
  assert.match(packet.recall_focus.current_query, /宝宝你到时候别失约|明天10点记得来问我起床没/);
  assert.match(packet.runtime_prelude, /主动唤醒当前态/);
  assert.match(packet.runtime_prelude, /相对时间校准/);
  assert.match(packet.runtime_prelude, /latest-thread: .*用户: 宝宝你到时候别失约 \| 你: 不跑，记着呢|latest-thread: .*用户: 明天10点记得来问我起床没 \| 你: 好，10点来戳你/);
});

test("asherie memory service keeps recent-thread only for discourse-continuation turns", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-recent-thread-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
      asheriePreludeRecentThreadLimit: 3,
    },
  });

  await service.writebackTurn({
    userId: "demo-user",
    query: "昨晚又熬到三点",
    assistantTextFinal: "那你今天早上会钝一点。",
    sourceClient: "mossbridge_wechat",
    threadId: "thread-rel",
  });

  const packet = await service.captureContextPacket({
    userId: "demo-user",
    query: "还没缓过来",
  });

  assert.match(packet.runtime_prelude, /recent-thread: 用户: 昨晚又熬到三点 \| 你: 那你今天早上会钝一点。/);

  await service.writebackTurn({
    userId: "demo-user",
    query: "bridge 刚才又在调试 claudecode 和 runtime 状态",
    assistantTextFinal: "我去看后台。",
    sourceClient: "mossbridge_wechat",
    threadId: "thread-rel",
  });

  const topicShiftPacket = await service.captureContextPacket({
    userId: "demo-user",
    query: "我最近想看看美甲灵感",
  });
  assert.doesNotMatch(topicShiftPacket.runtime_prelude, /recent-thread/);
  assert.doesNotMatch(topicShiftPacket.runtime_prelude, /bridge 刚才又在调试/);
});

test("asherie memory service carries recent tail on forced fresh-session turns", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-session-tail-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
      asheriePreludeRecentThreadLimit: 3,
    },
  });

  await service.writebackTurn({
    userId: "demo-user",
    query: "明天8点起床，带妈妈去手术，然后问设计师装修申请怎么走",
    assistantTextFinal: "明天顺序是起床、陪手术、再问设计师和物业申请。",
    sourceClient: "mossbridge_wechat",
    threadId: "old-thread",
  });

  const ordinaryPacket = await service.captureContextPacket({
    userId: "demo-user",
    query: "🙁宝宝嘤嘤嘤",
    sourceClient: "mossbridge_wechat",
  });
  assert.doesNotMatch(ordinaryPacket.runtime_prelude, /recent-thread/);

  const freshPacket = await service.captureContextPacket({
    userId: "demo-user",
    query: "🙁宝宝嘤嘤嘤",
    sourceClient: "mossbridge_wechat",
    forceRecentContext: true,
  });
  assert.match(freshPacket.recall_focus.current_query, /明天8点起床/);
  assert.match(freshPacket.runtime_prelude, /recent-thread: .*用户: 明天8点起床/);
});

test("asherie memory service builds a session handoff snapshot for long continuity after refresh", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-session-handoff-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
      asheriePreludeRecentThreadLimit: 3,
    },
  });

  for (let index = 1; index <= 8; index += 1) {
    await service.writebackTurn({
      userId: "demo-user",
      query: `论文架构第${index}步：讨论章节衔接和明天继续修改的安排`,
      assistantTextFinal: `第${index}步已经接住，下一步继续围绕章节逻辑收束。`,
      sourceClient: "mossbridge_wechat",
      threadId: "old-thread",
      tsUtc: `2026-05-16T0${index}:00:00.000Z`,
    });
  }

  const ordinaryPacket = await service.captureContextPacket({
    userId: "demo-user",
    query: "🙁宝宝嘤嘤嘤",
    sourceClient: "mossbridge_wechat",
  });
  assert.doesNotMatch(ordinaryPacket.runtime_prelude, /session-handoff/);

  const freshPacket = await service.captureContextPacket({
    userId: "demo-user",
    query: "🙁宝宝嘤嘤嘤",
    sourceClient: "mossbridge_wechat",
    forceRecentContext: true,
  });
  const recentThreadCount = (freshPacket.runtime_prelude.match(/recent-thread:/g) || []).length;
  assert.equal(recentThreadCount, 8);
  assert.match(freshPacket.runtime_prelude, /session-handoff/);
  assert.match(freshPacket.runtime_prelude, /session-core: 旧 session 最近 8 轮/);
  assert.match(freshPacket.runtime_prelude, /论文架构第8步/);
  assert.match(freshPacket.recall_focus.current_query, /论文架构第8步/);
});

test("resident anchor cards survive later warm-memory writes when they are pinned", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-anchor-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
      asheriePreludeResidentWarmLimit: 2,
    },
  });

  await service.writeWarmMaterial({
    userId: "demo-user",
    title: "Meteor necklace",
    summary: "陨星项链是关系里的常驻信物。",
    body_markdown: "这张卡应该长期待在 resident anchor 里。",
    tags: ["relationship", "象征", "信物", "项链"],
    pinned: true,
    certainty_state: "anchor",
  });

  for (let index = 0; index < 80; index += 1) {
    await service.writeWarmMaterial({
      userId: "demo-user",
      title: `Recent memo ${index + 1}`,
      summary: "普通近况，内容很散。",
      body_markdown: `这是后来不断写入的普通近况 ${index + 1}。`,
      tags: ["daily"],
    });
  }

  const packet = await service.captureContextPacket({
    userId: "demo-user",
    sourceClient: "mossbridge_system_turn",
    recallMode: "proactive",
    query: "User comes to mind again.",
  });

  const residentTitles = (packet.resident_warm_packet?.hits || []).map((item) => item.title);
  assert.ok(residentTitles.includes("Meteor necklace"));
});

test("resident anchor recall still surfaces multiple old pinned anchors after many newer writes", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-anchor-many-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
      asheriePreludeResidentWarmLimit: 4,
    },
  });

  const pinnedCards = [
    {
      title: "Meteor necklace",
      summary: "陨星项链是关系里的信物。",
      body_markdown: "这是关系里的象征物。",
      tags: ["relationship", "象征", "信物", "项链"],
    },
    {
      title: "Who A-Yuan is",
      summary: "她是谁，是关系里长期不会变的识别锚点。",
      body_markdown: "这是身份层的常驻锚点。",
      tags: ["identity", "owner", "阿鸢"],
    },
    {
      title: "Wedding ring day",
      summary: "婚戒和纪念日是关系里的长期象征物。",
      body_markdown: "这是另一张象征物锚点卡。",
      tags: ["relationship", "symbolic", "ring", "纪念日"],
    },
  ];

  for (const card of pinnedCards) {
    await service.writeWarmMaterial({
      userId: "demo-user",
      ...card,
      pinned: true,
      certainty_state: "anchor",
    });
  }

  for (let index = 0; index < 140; index += 1) {
    await service.writeWarmMaterial({
      userId: "demo-user",
      title: `Recent memo ${index + 1}`,
      summary: "普通近况，内容很散。",
      body_markdown: `这是后来不断写入的普通近况 ${index + 1}。`,
      tags: ["daily"],
    });
  }

  const packet = await service.captureContextPacket({
    userId: "demo-user",
    sourceClient: "mossbridge_system_turn",
    recallMode: "proactive",
    query: "User comes to mind again.",
  });

  const residentTitles = (packet.resident_warm_packet?.hits || []).map((item) => item.title);
  assert.ok(residentTitles.includes("Meteor necklace"));
  assert.ok(residentTitles.includes("Who A-Yuan is"));
  assert.ok(residentTitles.includes("Wedding ring day"));
});

test("asherie memory service injects ongoing tracks and cold case updates into the runtime prelude", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-ongoing-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
      asheriePreludeOngoingLimit: 3,
      asheriePreludeOngoingShadowLimit: 2,
    },
  });

  const track = await service.upsertOngoingTrack({
    userId: "demo-user",
    title: "减重",
    summary: "这阵子在持续减重，不会天天提，但会一直影响作息和心情。",
    kind: "health",
    target_window: "这阵子",
    next_step: "今天先别乱吃夜宵。",
    related_entities: ["体重", "作息"],
    shadow_snippets: ["昨晚忍住了夜宵，但今天有点馋。"],
    progress_log: ["前两天开始重新记体重和饮食。"],
  });
  assert.equal(track.ok, true);

  const updatedTrack = await service.upsertOngoingTrack({
    userId: "demo-user",
    track_id: track.record.track_id,
    tags: ["饮食"],
    related_entities: ["腰痛"],
    shadow_snippets: ["今天补进了一条微信端近期尾巴。"],
    progress_log: ["确认近期追踪需要继续挂着。"],
  });
  assert.deepEqual(updatedTrack.record.tags, ["饮食"]);
  assert.deepEqual(updatedTrack.record.related_entities, ["体重", "作息", "腰痛"]);
  assert.deepEqual(
    updatedTrack.record.shadow_snippets.map((item) => item.text),
    ["昨晚忍住了夜宵，但今天有点馋。", "今天补进了一条微信端近期尾巴。"],
  );
  assert.deepEqual(
    updatedTrack.record.progress_log.map((item) => item.text),
    ["前两天开始重新记体重和饮食。", "确认近期追踪需要继续挂着。"],
  );

  await service.upsertColdVersion({
    userId: "demo-user",
    payload: {
      persona_memos: [],
      hard_facts: [],
      case_updates: [{
        id: "case-1",
        summary: "有篇稿子两周内要收尾。",
        next_action: "这周先把提纲补齐。",
      }],
    },
  });

  const packet = await service.captureContextPacket({
    userId: "demo-user",
    query: "最近脑子里挂着什么",
  });

  assert.equal(packet.ongoing_track_packet.hit_count, 1);
  assert.match(packet.runtime_prelude, /ongoing: 减重 \| active \| 这阵子/);
  assert.match(packet.runtime_prelude, /open-loop: 减重 \| 这阵子/);
  assert.match(packet.runtime_prelude, /active-entity: 体重/);
  assert.match(packet.runtime_prelude, /active-entity: 腰痛/);
  assert.match(packet.runtime_prelude, /shadow: 减重: .*昨晚忍住了夜宵/);
  assert.match(packet.runtime_prelude, /case-update: 有篇稿子两周内要收尾/);

  const unrelatedPacket = await service.captureContextPacket({
    userId: "demo-user",
    query: "我最近想看看美甲灵感",
  });
  assert.equal(unrelatedPacket.ongoing_track_packet.hit_count, 0);
  assert.doesNotMatch(unrelatedPacket.runtime_prelude, /ongoing: 减重/);
  assert.doesNotMatch(unrelatedPacket.runtime_prelude, /open-loop: 减重/);

  const healthPacket = await service.captureContextPacket({
    userId: "demo-user",
    query: "我最近减脂和饮食怎么安排",
  });
  assert.equal(healthPacket.ongoing_track_packet.hit_count, 1);
  assert.match(healthPacket.runtime_prelude, /ongoing: 减重/);
});

test("proactive recall uses the latest natural tail instead of the internal trigger text", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-proactive-tail-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
      asherieProactiveContextCacheLimit: 20,
      asheriePreludeRecentThreadLimit: 4,
      asheriePreludeOngoingLimit: 3,
    },
  });

  await service.upsertOngoingTrack({
    userId: "demo-user",
    title: "装修决策与交房前准备",
    summary: "装修还在推进，但这一轮不是它。",
    tags: ["装修"],
    related_entities: ["房子", "交房"],
    shadow_snippets: ["之前聊过台盆和柜子。"],
  });

  await service.upsertOngoingTrack({
    userId: "demo-user",
    title: "替尔泊肽减重与吃饭不香",
    summary: "最近吃东西容易早饱，蛋白粉是可选补充。",
    tags: ["减重", "饮食"],
    related_entities: ["苹果", "蛋白粉"],
  });

  await service.upsertColdVersion({
    userId: "demo-user",
    payload: {
      persona_memos: [],
      hard_facts: [],
      case_updates: [{
        id: "case-1",
        summary: "有篇稿子两周内要收尾。",
        next_action: "这周先把提纲补齐。",
      }],
    },
  });

  await service.writebackTurn({
    userId: "demo-user",
    query: "到家啦到家啦，晚上吃了一个苹果就饱了，打算20点如果饿了再喝一杯蛋白粉，不饿就算了",
    assistantTextFinal: "一个苹果就饱了呀，饿了再喝蛋白粉，不饿就别硬灌。",
    sourceClient: "mossbridge_wechat",
    threadId: "thread-proactive-ongoing",
  });

  const packet = await service.captureContextPacket({
    userId: "demo-user",
    sourceClient: "mossbridge_system_turn",
    recallMode: "proactive",
    query: "User comes to mind again.",
  });

  assert.match(packet.recall_focus.current_query, /苹果|蛋白粉/);
  assert.match(packet.runtime_prelude, /主动唤醒当前态/);
  assert.match(packet.runtime_prelude, /相对时间校准/);
  assert.match(packet.runtime_prelude, /latest-thread: .*用户: 到家啦到家啦，晚上吃了一个苹果/);
  assert.doesNotMatch(packet.runtime_prelude, /ongoing: 装修决策与交房前准备/);

  const coldNoisePacket = await service.captureContextPacket({
    userId: "demo-user",
    query: "今天吃面要不要加蛋",
  });
  assert.equal(coldNoisePacket.cold_root_packet.hit_count, 0);
  assert.doesNotMatch(coldNoisePacket.runtime_prelude, /case-update: 有篇稿子两周内要收尾/);
});

test("asherie memory service keeps bounded event episodes with attachment refs", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-episode-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
    },
  });

  const upsert = await service.upsertEpisode({
    userId: "demo-user",
    episode_id: "2026-may-henan-trip",
    title: "2026 五一河南旅行",
    summary: "三天旅行，有打铁花、照片、顺利和麻烦。",
    kind: "travel",
    tags: ["旅行", "打铁花"],
    topology_refs: {
      places: ["河南"],
      activities: ["看打铁花"],
    },
    time_range: { label: "2026-05-01 到 2026-05-03" },
  });
  assert.equal(upsert.ok, true);
  assert.equal(upsert.record.episode_id, "2026-may-henan-trip");

  const append = await service.appendEpisodeEntry({
    userId: "demo-user",
    episode_id: "2026-may-henan-trip",
    entry_type: "photo",
    day_label: "Day 2",
    text: "打铁花现场照片，适合后面收成旅行小记。",
    attachment_refs: [{
      path: "wechat/inbox/2026-05-05/attachment.jpg",
      note_path: "context/attachment-notes/2026-05-05/attachment.md",
      caption: "打铁花小船",
    }],
    source_refs: ["wechat:7457348926094522000"],
    topology_refs: {
      objects: ["打铁花小船"],
      themes: ["旅行照片整理"],
    },
  });
  assert.equal(append.ok, true);
  assert.equal(append.record.attachment_count, 1);
  assert.ok(append.record.topology_edge_count >= 4);
  assert.equal(
    append.record.topology_candidate.edges.some((edge) => edge.relation === "visited_place" && edge.to_ref.label === "河南"),
    true,
  );

  const warm = await service.writeWarmMaterial({
    userId: "demo-user",
    title: "河南旅行照片小记",
    body_markdown: "这次旅行照片线索后面适合收成一篇小记。",
    summary: "旅行照片整理线索。",
    material_type: "memo",
    tags: ["旅行", "照片"],
    episode_refs: ["2026-may-henan-trip"],
    case_refs: ["travel-photo-note-case"],
  });
  assert.deepEqual(warm.record.episode_refs, ["2026-may-henan-trip"]);
  assert.deepEqual(warm.record.case_refs, ["travel-photo-note-case"]);

  const packet = await service.captureContextPacket({
    userId: "demo-user",
    query: "河南旅行照片整理",
    currentTurnSignals: {
      source_client: "mossbridge_wechat",
      has_text: true,
      attachment_count: 2,
      image_count: 2,
    },
  });
  assert.equal(packet.episode_journal_packet.hit_count, 1);
  assert.equal(packet.episode_journal_packet.hits[0].topology_candidate, undefined);
  assert.ok(packet.episode_journal_packet.hits[0].query_score > 0);
  assert.ok(JSON.stringify(packet.episode_journal_packet).length < 4000);
  assert.deepEqual(packet.retrieval.route.includes("episode_journal"), true);
  assert.match(packet.runtime_prelude, /小事记：2026 五一河南旅行/);
  assert.match(packet.runtime_prelude, /小事记提醒：/);
  assert.match(packet.runtime_prelude, /episode_refs=2026-may-henan-trip/);
  assert.match(packet.runtime_prelude, /case_refs=travel-photo-note-case/);
  assert.match(packet.runtime_prelude, /小事记/);
  assert.equal(packet.episode_attention.active, true);

  const markdownPath = path.join(
    tempRoot,
    "gateway-data",
    "storage",
    "episode_journal",
    SINGLE_USER_ID,
    "2026-may-henan-trip",
    "episode.md",
  );
  assert.equal(fs.existsSync(markdownPath), true);
  assert.match(fs.readFileSync(markdownPath, "utf8"), /打铁花小船/);
});

test("asherie memory service recalls conversation cache by temporal window", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-temporal-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
      asherieTemporalRecallLimit: 4,
    },
  });

  await service.writebackTurn({
    userId: "demo-user",
    query: "昨天那张图是签证路线截图",
    assistantTextFinal: "我先把它当成签证路线材料记在上下文里。",
    ts_utc: "2026-04-28T02:30:00.000Z",
    sourceClient: "mossbridge_wechat",
  });
  await service.writebackTurn({
    userId: "demo-user",
    query: "很久以前的无关测试",
    assistantTextFinal: "这条不应该被昨天召回。",
    ts_utc: "2026-04-25T02:30:00.000Z",
    sourceClient: "mossbridge_wechat",
  });

  const packet = await service.captureContextPacket({
    userId: "demo-user",
    query: "昨天那张图后来怎么说来着",
    receivedAt: "2026-04-29T12:00:00+08:00",
  });

  assert.equal(packet.temporal_recall_packet.enabled, true);
  assert.equal(packet.temporal_recall_packet.label, "昨天");
  assert.equal(packet.temporal_recall_packet.hit_count, 1);
  assert.equal(packet.temporal_recall_packet.hits[0].query, "昨天那张图是签证路线截图");
  assert.match(packet.runtime_prelude, /temporal-recall: 昨天/);
  assert.match(packet.runtime_prelude, /temporal-turn: .*签证路线截图/);
});

test("asherie memory service gives the frontstage model memory self-maintenance agency", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-memory-agency-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
    },
  });

  const readPacket = await service.captureContextPacket({
    userId: "demo-user",
    query: "帮我看看脑子里现在有什么",
  });
  assert.match(readPacket.runtime_prelude, /记忆自维护/);
  assert.match(readPacket.runtime_prelude, /自然闲聊或换话题/);
  assert.match(readPacket.runtime_prelude, /系统反馈/);
  assert.match(readPacket.runtime_prelude, /提出具体需要/);
  assert.match(readPacket.runtime_prelude, /前台自由/);
  assert.doesNotMatch(readPacket.runtime_prelude, /memory-action-required/);

  const casualPacket = await service.captureContextPacket({
    userId: "demo-user",
    query: "今天好冷啊",
  });
  assert.match(casualPacket.runtime_prelude, /记忆自维护/);
  assert.doesNotMatch(casualPacket.runtime_prelude, /memory-action-required/);

  await service.writebackTurn({
    userId: "demo-user",
    query: "今天一个人扛了保活、episode 仓位和 bridge 稳定性，想讨一个亲亲。",
    assistantTextFinal: "那当然亲。",
    sourceClient: "mossbridge_wechat",
  });

  const goodnightPacket = await service.captureContextPacket({
    userId: "demo-user",
    query: "（搂住大亲）mua！宝宝晚安🌙\n\n希望明天人就不那么肿了",
  });
  assert.equal(goodnightPacket.recall_focus.used_recent_context, false);
  assert.doesNotMatch(goodnightPacket.runtime_prelude, /recall-focus: expanded from recent context/);
  assert.doesNotMatch(goodnightPacket.recall_focus.recall_query, /bridge 稳定性/);
});
