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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-memory-"));
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
    sourceClient: "asheriebridge_wechat",
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

  const recalled = await service.captureContextPacket({
    userId: "another-wechat-user",
    ownerId: "still-wrong-owner",
    agentId: "still-wrong-char",
    query: "coffee morning",
  });
  assert.equal(recalled.warm_memory_packet.hit_count, 1);
  assert.equal(recalled.cold_memory.active_version, coldWrite.version);
  assert.equal(recalled.conversation_cache.stats.returned_records, 1);
  assert.match(recalled.runtime_prelude, /AsherieBridge memory context/);
  const cacheFiles = fs.readdirSync(path.join(tempRoot, "gateway-data", "cache", "conversation_cache"));
  assert.equal(cacheFiles.some((name) => name.startsWith(`${SINGLE_USER_ID}__`)), true);
});

test("asherie memory runtime prelude redacts private identity seed paths", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-memory-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
    },
  });

  await service.writeWarmMaterial({
    title: "Persona pointer",
    summary: "soul_ref: /Users/mac/Documents/AI/Aji-Memory/00_System/soul.md",
    body_markdown: "memory_ref: /Users/mac/Documents/AI/Aji-Memory",
    tags: ["identity", "anchor"],
    pinned: true,
    certainty_state: "anchor",
  });

  const packet = await service.captureContextPacket({
    query: "宝宝你在吗",
    residentLimit: 4,
  });

  assert.match(packet.runtime_prelude, /\[private_identity_seed\]/);
  assert.doesNotMatch(packet.runtime_prelude, /\/Users\/mac\/Documents\/AI\/Aji-Memory/);
});

test("asherie memory service keeps memory data separable and allows custom agent identity", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-memory-share-"));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-memory-crud-"));
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

test("asherie memory service can recall legacy truth-layer roots even when cold manifest has no active version", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-memory-legacy-cold-"));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-memory-vines-"));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-memory-focus-"));
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
    sourceClient: "asheriebridge_wechat",
    threadId: "thread-focus",
  });

  const packet = await service.captureContextPacket({
    userId: "demo-user",
    query: "还没缓过来",
    sourceClient: "asheriebridge_wechat",
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-memory-routing-"));
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

  const packet = await service.captureContextPacket({
    userId: "demo-user",
    query: "根据对我的印象，你觉得我适合什么美甲呢",
  });

  assert.equal(packet.warm_memory_packet.hit_count, 1);
  assert.equal(packet.warm_memory_packet.hits[0].title, "Nail taste");
  assert.ok(packet.warm_memory_packet.query_signal_tokens.includes("美甲"));
  assert.ok(packet.warm_memory_packet.query_answer_types.includes("美甲"));
  assert.ok(!packet.warm_memory_packet.query_signal_tokens.includes("印象"));
  assert.ok(packet.warm_memory_packet.keyword_match_tokens.includes("指甲"));
});

test("asherie memory service lets proactive recall surface symbolic relationship objects before the candidate window clips them", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-memory-symbolic-"));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-memory-family-story-"));
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-memory-sticky-"));
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
    sourceClient: "asheriebridge_wechat",
  });

  assert.equal(packet.calendar_packet.counts.upcoming, 1);
  assert.equal(packet.wakeup_packet.latest.decision, "hold");
  assert.match(packet.runtime_prelude, /sticky-calendar: upcoming \| 洗头 @/);
  assert.match(packet.runtime_prelude, /recent-wakeup: hold \| checkin \| 刚确认过她在忙/);
});

test("asherie memory service gives proactive turns resident anchors and a recent-thread snapshot", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-memory-proactive-"));
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
    sourceClient: "asheriebridge_system_turn",
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
    sourceClient: "asheriebridge_wechat",
    threadId: "thread-proactive",
  });

  await service.writebackTurn({
    userId: "demo-user",
    query: "明天10点记得来问我起床没",
    assistantTextFinal: "好，10点来戳你。",
    sourceClient: "asheriebridge_wechat",
    threadId: "thread-proactive",
  });

  await service.writebackTurn({
    userId: "demo-user",
    query: "宝宝你到时候别失约",
    assistantTextFinal: "不跑，记着呢。",
    sourceClient: "asheriebridge_wechat",
    threadId: "thread-proactive",
  });

  const packet = await service.captureContextPacket({
    userId: "demo-user",
    sourceClient: "asheriebridge_system_turn",
    recallMode: "proactive",
    query: "User comes to mind again.",
  });

  assert.ok(packet.warm_memory_packet.hit_count >= 0);
  assert.match(packet.runtime_prelude, /recent-thread: 用户: 宝宝你到时候别失约 \| 你: 不跑，记着呢|recent-thread: 用户: 明天10点记得来问我起床没 \| 你: 好，10点来戳你/);
});

test("asherie memory service keeps short relational turns in recent-thread when the reply carries continuity", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-memory-recent-thread-"));
  const service = new AsherieMemoryService({
    config: {
      stateDir: tempRoot,
      asherieDataRoot: path.join(tempRoot, "gateway-data"),
      asheriePreludeRecentThreadLimit: 3,
    },
  });

  await service.writebackTurn({
    userId: "demo-user",
    query: "宝宝～",
    assistantTextFinal: "我在。\n\n过来，让我抱一下。",
    sourceClient: "asheriebridge_wechat",
    threadId: "thread-rel",
  });

  const packet = await service.captureContextPacket({
    userId: "demo-user",
    query: "今天累瘫了",
  });

  assert.match(packet.runtime_prelude, /recent-thread: 用户: 宝宝～ \| 你: 我在。 过来，让我抱一下。/);
});

test("resident anchor cards survive later warm-memory writes when they are pinned", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-memory-anchor-"));
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
    sourceClient: "asheriebridge_system_turn",
    recallMode: "proactive",
    query: "User comes to mind again.",
  });

  const residentTitles = (packet.resident_warm_packet?.hits || []).map((item) => item.title);
  assert.ok(residentTitles.includes("Meteor necklace"));
});

test("resident anchor recall still surfaces multiple old pinned anchors after many newer writes", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-memory-anchor-many-"));
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
    sourceClient: "asheriebridge_system_turn",
    recallMode: "proactive",
    query: "User comes to mind again.",
  });

  const residentTitles = (packet.resident_warm_packet?.hits || []).map((item) => item.title);
  assert.ok(residentTitles.includes("Meteor necklace"));
  assert.ok(residentTitles.includes("Who A-Yuan is"));
  assert.ok(residentTitles.includes("Wedding ring day"));
});

test("asherie memory service injects ongoing tracks and cold case updates into the runtime prelude", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-memory-ongoing-"));
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
});

test("asherie memory service recalls conversation cache by temporal window", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-memory-temporal-"));
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
    sourceClient: "asheriebridge_wechat",
  });
  await service.writebackTurn({
    userId: "demo-user",
    query: "很久以前的无关测试",
    assistantTextFinal: "这条不应该被昨天召回。",
    ts_utc: "2026-04-25T02:30:00.000Z",
    sourceClient: "asheriebridge_wechat",
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-memory-agency-"));
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
  assert.match(readPacket.runtime_prelude, /memory-self-maintenance/);
  assert.match(readPacket.runtime_prelude, /part of your own continuity/);
  assert.match(readPacket.runtime_prelude, /memory-system-feedback/);
  assert.match(readPacket.runtime_prelude, /make a concrete request for the missing capability/);
  assert.match(readPacket.runtime_prelude, /memory-frontstage-freedom/);
  assert.doesNotMatch(readPacket.runtime_prelude, /memory-action-required/);

  const casualPacket = await service.captureContextPacket({
    userId: "demo-user",
    query: "今天好冷啊",
  });
  assert.match(casualPacket.runtime_prelude, /memory-self-maintenance/);
  assert.doesNotMatch(casualPacket.runtime_prelude, /memory-action-required/);
});
