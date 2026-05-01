const test = require("node:test");
const assert = require("node:assert/strict");

const { ProjectToolHost } = require("../src/tools/tool-host");

function createHost() {
  return new ProjectToolHost({
    services: {
      diary: {
        async append(args) {
          return { filePath: "/tmp/diary.md", ...args };
        },
      },
      reminder: {
        async create(args) {
          return { id: "reminder-1", ...args };
        },
      },
      system: {
        queueMessage(args) {
          return { id: "system-1", ...args };
        },
      },
      asherieMemory: {
        async captureContextPacket(args) {
          return {
            warm_memory_packet: { hit_count: 1 },
            cold_memory: { active_version: "v2" },
            resolvedUserId: args.userId || "user-1",
          };
        },
        async writeWarmMaterial(args) {
          return {
            ok: true,
            record: {
              material_id: args.material_id || "memo-1",
              title: args.title || "Coffee preference",
              body_markdown: args.body_markdown || "User likes hand-brew coffee.",
            },
          };
        },
        async readWarmMaterial(args) {
          return {
            ok: true,
            material_id: args.material_id,
            record: {
              material_id: args.material_id,
              title: "Coffee preference",
              body_markdown: "User likes hand-brew coffee.",
            },
          };
        },
        async searchWarmMaterials(args) {
          return {
            query: args.query,
            hit_count: 1,
            hits: [{
              material_id: "memo-1",
              title: "Coffee preference",
              summary: "User likes hand-brew coffee.",
            }],
          };
        },
        async listWarmMaterials() {
          return {
            ok: true,
            count: 1,
            items: [{
              material_id: "memo-1",
              title: "Coffee preference",
            }],
          };
        },
        async updateWarmMaterial(args) {
          return {
            ok: true,
            record: {
              material_id: args.material_id,
              title: args.title || "Coffee preference",
              body_markdown: args.body_markdown || "Updated body.",
            },
          };
        },
        async deleteWarmMaterial(args) {
          return {
            ok: true,
            deleted_material_id: args.material_id,
          };
        },
        async upsertOngoingTrack(args) {
          return {
            ok: true,
            record: {
              track_id: args.track_id || "track-1",
              title: args.title || "减重",
              summary: args.summary || "最近在减重。",
              status: args.status || "active",
            },
          };
        },
        async readOngoingTrack(args) {
          return {
            ok: true,
            track_id: args.track_id,
            record: {
              track_id: args.track_id,
              title: "减重",
              summary: "最近在减重。",
              status: "active",
            },
          };
        },
        async listOngoingTracks() {
          return {
            ok: true,
            count: 1,
            items: [{
              track_id: "track-1",
              title: "减重",
              summary: "最近在减重。",
              status: "active",
            }],
          };
        },
        async closeOngoingTrack(args) {
          return {
            ok: true,
            record: {
              track_id: args.track_id,
              title: "减重",
              status: args.status || "done",
              closure_summary: args.closure_summary || "阶段完成",
            },
          };
        },
        async listColdVersions() {
          return {
            ok: true,
            active_version: "v2",
            versions: [{ version: "v2" }, { version: "v1" }],
          };
        },
        async readColdVersion(args) {
          return {
            ok: true,
            version: args.version || "v2",
            counts: { persona: 1, sql: 1, case: 0 },
            payload: {
              persona_memos: [{ id: "p1", content: "Warm and steady." }],
              hard_facts: [{ id: "f1", fact_key: "city", fact_value: "Shanghai" }],
              case_updates: [],
            },
          };
        },
        async searchColdRoots(args) {
          return {
            ok: true,
            query: args.query,
            active_version: args.version || "v2",
            hit_count: 1,
            hits: [{
              root_key: "hard_fact:f1",
              source_type: "hard_fact",
              title: "city",
              summary: "Shanghai",
            }],
          };
        },
        async readColdRoot(args) {
          return {
            ok: true,
            root_key: args.root_key,
            active_version: args.version || "v2",
            root: {
              root_key: args.root_key,
              source_type: "hard_fact",
              title: "city",
              summary: "Shanghai",
              item: {
                id: "f1",
                fact_key: "city",
                fact_value: "Shanghai",
              },
            },
          };
        },
        async patchColdRoot(args) {
          return {
            ok: true,
            deleted: normalizeMode(args.mode) === "delete",
            previous_root_key: args.root_key,
            root_key: args.root_key,
            version: args.versionLabel || "v3",
            root: normalizeMode(args.mode) === "delete"
              ? null
              : {
                  root_key: args.root_key,
                  source_type: "hard_fact",
                  title: "city",
                  summary: args?.changes?.fact_value || "Updated",
                  item: {
                    id: "f1",
                    fact_key: "city",
                    fact_value: args?.changes?.fact_value || "Updated",
                  },
                },
          };
        },
        async upsertColdVersion(args) {
          return { version: args.versionLabel || "v3", payload: args.payload };
        },
      },
      channelFile: {
        async sendToCurrentChat(args) {
          return { filePath: args.filePath, userId: args.userId || "user-1" };
        },
      },
      sticker: {
        async listTags() {
          return { tags: ["开心", "抱抱"], guidance: "use concise tags" };
        },
        async pick(args) {
          return {
            tag: args.tag,
            candidates: [{ stickerId: "stk_001", desc: "开心小狗摇尾巴" }],
          };
        },
        async list() {
          return {
            count: 1,
            stickers: [{ stickerId: "stk_001", tags: ["开心"], desc: "开心小狗摇尾巴" }],
          };
        },
        async sendToCurrentChat(args) {
          return {
            stickerId: args.stickerId,
            filePath: "/tmp/stk_001.gif",
            delivery: { ok: true },
          };
        },
        async saveFromInbox() {
          return { createdCount: 1, dedupedCount: 0, results: [{ stickerId: "stk_001" }] };
        },
        async update() {
          return { updatedCount: 1, results: [{ stickerId: "stk_001" }] };
        },
        async delete() {
          return { deletedCount: 1, results: [{ stickerId: "stk_001" }] };
        },
      },
      timeline: {
        async read(args) {
          return {
            data: {
              date: args.date,
              exists: true,
              eventCount: 1,
              events: [{ id: "evt-1" }],
            },
          };
        },
        async listCategories() {
          return {
            data: {
              categoryCount: 2,
              categories: [{ id: "work" }, { id: "life" }],
            },
          };
        },
        async listProposals(args) {
          return {
            data: {
              date: args.date || "",
              proposalCount: 1,
              proposals: [{ id: "proposal-1" }],
            },
          };
        },
        async write(args) {
          return args;
        },
        async build(args) {
          return args;
        },
        async serve(args) {
          return args;
        },
        async dev(args) {
          return args;
        },
        async captureScreenshot(args) {
          return { outputFile: "/tmp/shot.png", ...args };
        },
      },
      whereabouts: {
        getSnapshot(args) {
          return {
            currentStay: { address: "Office" },
            recentStays: [{ address: "Home" }],
            recentMovementEvents: [{ fromAddress: "Home", toAddress: "Office" }],
            ...args,
          };
        },
        getCurrentStayForOutput() {
          return { address: "Office", enteredAtLocal: "2026-04-22 09:00:00" };
        },
        getRecentStaysForOutput(args) {
          return {
            currentStay: { address: "Office" },
            recentStays: [{ address: "Home" }],
            limit: args.limit,
          };
        },
        getRecentMovesForOutput(args) {
          return {
            currentStay: { address: "Office" },
            recentMovementEvents: [{ fromAddress: "Home", toAddress: "Office" }],
            limit: args.limit,
          };
        },
        getSummary(args) {
          return {
            range: args.range || "day",
            stayCount: 2,
            moveCount: 1,
            mobilityState: { state: "staying" },
            knownPlaces: [{ placeTag: "home", durationText: "2h" }],
            batteryTrend: { sampleCount: 2, deltaPercent: -45 },
          };
        },
        appendPoint(args) {
          return {
            point: { id: "point-1", ...args },
            currentStay: { address: "Office" },
            movementEvent: null,
          };
        },
      },
    },
    runtimeContextStore: {
      resolveActiveContext() {
        return {};
      },
    },
  });
}

test("tool host rejects legacy timeline write CLI-shaped fields", async () => {
  const host = createHost();
  await assert.rejects(async () => {
    await host.invokeTool("asheriebridge_timeline_write", {
      date: "2026-04-21",
      events: [],
      eventsJson: "{\"events\":[]}",
    }, {});
  }, /input\.eventsJson is not allowed/);
});

test("tool host exposes structured timeline read tools", async () => {
  const host = createHost();
  const readResult = await host.invokeTool("asheriebridge_timeline_read", {
    date: "2026-04-21",
  }, {});
  const categoriesResult = await host.invokeTool("asheriebridge_timeline_categories", {}, {});
  const proposalsResult = await host.invokeTool("asheriebridge_timeline_proposals", {
    date: "2026-04-21",
  }, {});

  assert.equal(readResult.text, "Timeline day 2026-04-21: 1 events.");
  assert.equal(categoriesResult.text, "Timeline categories loaded: 2.");
  assert.equal(proposalsResult.text, "Timeline proposals loaded: 1.");
});

test("tool host validates structured reminder input types", async () => {
  const host = createHost();
  await assert.rejects(async () => {
    await host.invokeTool("asheriebridge_reminder_create", {
      text: "ping me",
      delayMinutes: "30",
    }, {});
  }, /input\.delayMinutes must be an integer/);
});

test("tool host accepts structured timeline screenshot input", async () => {
  const host = createHost();
  const result = await host.invokeTool("asheriebridge_timeline_screenshot", {
    selector: "timeline",
    range: "day",
    date: "2026-04-21",
    width: 1440,
  }, {});
  assert.equal(result.text, "Timeline screenshot sent: /tmp/shot.png");
  assert.equal(result.data.delivery.filePath, "/tmp/shot.png");
});

test("tool host exposes sticker tools", async () => {
  const host = createHost();
  const tools = host.listTools();
  assert.ok(tools.find((tool) => tool.name === "asheriebridge_sticker_tags"));
  assert.ok(tools.find((tool) => tool.name === "asheriebridge_sticker_pick"));
  assert.ok(tools.find((tool) => tool.name === "asheriebridge_sticker_list"));
  assert.ok(tools.find((tool) => tool.name === "asheriebridge_sticker_send"));
  assert.ok(tools.find((tool) => tool.name === "asheriebridge_sticker_save_from_inbox"));

  const tags = await host.invokeTool("asheriebridge_sticker_tags", {}, {});
  const picked = await host.invokeTool("asheriebridge_sticker_pick", { tag: "开心" }, {});
  const listed = await host.invokeTool("asheriebridge_sticker_list", { tag: "开心" }, {});
  const sent = await host.invokeTool("asheriebridge_sticker_send", { stickerId: "stk_001" }, {});
  const saved = await host.invokeTool("asheriebridge_sticker_save_from_inbox", {
    items: [{
      filePath: "/tmp/input.gif",
      tags: ["开心"],
      desc: "开心小狗摇尾巴的表情。",
    }],
  }, {});

  assert.equal(tags.text, "Sticker tags loaded: 2");
  assert.equal(picked.text, "Sticker candidates for 开心: 1");
  assert.equal(listed.text, "Sticker inventory: 1");
  assert.equal(sent.text, "Sticker sent: stk_001");
  assert.equal(saved.text, "Stickers saved: 1, deduped: 0");
});

test("tool host descriptions include schema summary for models that only surface descriptions", () => {
  const host = createHost();
  const timelineWrite = host.listTools().find((tool) => tool.name === "asheriebridge_timeline_write");
  assert.match(timelineWrite.description, /Input:/);
  assert.match(timelineWrite.description, /date: string/);
  assert.match(timelineWrite.description, /events: \{/);
});

test("tool host exposes structured warm-memory lookup and exact-card mutation tools", async () => {
  const host = createHost();
  const tools = host.listTools();
  assert.ok(tools.find((tool) => tool.name === "asheriebridge_memory_warm_search"));
  assert.ok(tools.find((tool) => tool.name === "asheriebridge_memory_warm_read"));
  assert.ok(tools.find((tool) => tool.name === "asheriebridge_memory_warm_update"));
  assert.ok(tools.find((tool) => tool.name === "asheriebridge_memory_warm_delete"));

  const search = await host.invokeTool("asheriebridge_memory_warm_search", {
    query: "coffee",
  }, { senderId: "user-1" });
  const read = await host.invokeTool("asheriebridge_memory_warm_read", {
    material_id: "memo-1",
  }, { senderId: "user-1" });
  const update = await host.invokeTool("asheriebridge_memory_warm_update", {
    material_id: "memo-1",
    body_markdown: "User switched to hand-brew at home.",
  }, { senderId: "user-1" });
  const removal = await host.invokeTool("asheriebridge_memory_warm_delete", {
    material_id: "memo-1",
  }, { senderId: "user-1" });

  assert.equal(search.text, "Warm memory search returned 1 hits.");
  assert.equal(read.text, "Warm memory loaded: memo-1");
  assert.equal(read.data.record.material_id, "memo-1");
  assert.equal(update.text, "Warm memory updated: memo-1");
  assert.equal(update.data.record.body_markdown, "User switched to hand-brew at home.");
  assert.equal(removal.text, "Warm memory deleted: memo-1");
});

test("tool host exposes ongoing-track tools for medium-horizon live threads", async () => {
  const host = createHost();
  const tools = host.listTools();
  assert.ok(tools.find((tool) => tool.name === "asheriebridge_memory_ongoing_upsert"));
  assert.ok(tools.find((tool) => tool.name === "asheriebridge_memory_ongoing_list"));
  assert.ok(tools.find((tool) => tool.name === "asheriebridge_memory_ongoing_read"));
  assert.ok(tools.find((tool) => tool.name === "asheriebridge_memory_ongoing_close"));

  const created = await host.invokeTool("asheriebridge_memory_ongoing_upsert", {
    title: "减重",
    summary: "最近在减重。",
  }, { senderId: "user-1" });
  const listed = await host.invokeTool("asheriebridge_memory_ongoing_list", {}, { senderId: "user-1" });
  const read = await host.invokeTool("asheriebridge_memory_ongoing_read", {
    track_id: "track-1",
  }, { senderId: "user-1" });
  const closed = await host.invokeTool("asheriebridge_memory_ongoing_close", {
    track_id: "track-1",
    closure_summary: "阶段完成",
  }, { senderId: "user-1" });

  assert.equal(created.text, "Ongoing track stored: track-1");
  assert.equal(listed.text, "Ongoing tracks: 1");
  assert.equal(read.text, "Ongoing track loaded: track-1");
  assert.equal(closed.text, "Ongoing track closed: track-1");
});

test("tool host exposes cold-memory inspection tools beside version upsert", async () => {
  const host = createHost();
  const versions = await host.invokeTool("asheriebridge_memory_cold_versions", {}, { senderId: "user-1" });
  const active = await host.invokeTool("asheriebridge_memory_cold_read", {}, { senderId: "user-1" });

  assert.equal(versions.text, "Cold memory versions: 2 (active=v2).");
  assert.equal(active.text, "Cold memory loaded: v2");
  assert.equal(active.data.payload.hard_facts[0].fact_key, "city");
});

test("tool host exposes cold root search, read, and exact patch tools", async () => {
  const host = createHost();
  const tools = host.listTools();
  assert.ok(tools.find((tool) => tool.name === "asheriebridge_memory_cold_search"));
  assert.ok(tools.find((tool) => tool.name === "asheriebridge_memory_cold_root_read"));
  assert.ok(tools.find((tool) => tool.name === "asheriebridge_memory_cold_patch"));

  const search = await host.invokeTool("asheriebridge_memory_cold_search", {
    query: "Shanghai",
  }, { senderId: "user-1" });
  const read = await host.invokeTool("asheriebridge_memory_cold_root_read", {
    root_key: "hard_fact:f1",
  }, { senderId: "user-1" });
  const patch = await host.invokeTool("asheriebridge_memory_cold_patch", {
    root_key: "hard_fact:f1",
    changes: {
      fact_value: "Hangzhou",
    },
  }, { senderId: "user-1" });
  const deletion = await host.invokeTool("asheriebridge_memory_cold_patch", {
    root_key: "hard_fact:f1",
    mode: "delete",
  }, { senderId: "user-1" });

  assert.equal(search.text, "Cold memory root search returned 1 hits.");
  assert.equal(read.text, "Cold memory root loaded: hard_fact:f1");
  assert.equal(read.data.root.item.fact_value, "Shanghai");
  assert.equal(patch.text, "Cold memory root patched: hard_fact:f1");
  assert.equal(patch.data.root.item.fact_value, "Hangzhou");
  assert.equal(deletion.text, "Cold memory root deleted: hard_fact:f1");
});

test("tool host rejects cold root patch without changes unless mode is delete", async () => {
  const host = createHost();
  await assert.rejects(async () => {
    await host.invokeTool("asheriebridge_memory_cold_patch", {
      root_key: "hard_fact:f1",
    }, { senderId: "user-1" });
  }, /input\.changes is required unless input\.mode is delete/);
});

test("tool host exposes whereabouts tools from the external dependency", async () => {
  const host = createHost();
  const tools = host.listTools();
  const snapshotTool = tools.find((tool) => tool.name === "whereabouts_snapshot");
  const summaryTool = tools.find((tool) => tool.name === "whereabouts_summary");
  const ingestTool = tools.find((tool) => tool.name === "whereabouts_ingest_point");
  const currentStayResult = await host.invokeTool("whereabouts_current_stay", {}, {});
  const snapshotResult = await host.invokeTool("whereabouts_snapshot", {
    stayLimit: 3,
    moveLimit: 2,
  }, {});
  const summaryResult = await host.invokeTool("whereabouts_summary", { range: "day" }, {});

  assert.ok(snapshotTool);
  assert.ok(summaryTool);
  assert.equal(ingestTool, undefined);
  assert.equal(currentStayResult.data.currentStay.address, "Office");
  assert.equal(snapshotResult.data.currentStay.address, "Office");
  assert.equal(snapshotResult.data.recentStays.length, 1);
  assert.equal(summaryResult.data.mobilityState.state, "staying");
});

test("tool host rejects timeline events without title or eventNodeId", async () => {
  const host = createHost();
  await assert.rejects(async () => {
    await host.invokeTool("asheriebridge_timeline_write", {
      date: "2026-04-22",
      events: [
        {
          startAt: "2026-04-22T10:00:00+08:00",
          endAt: "2026-04-22T10:30:00+08:00",
          categoryId: "work",
          subcategoryId: "coding",
        },
      ],
    }, {});
  }, /input\.events\[0\]\.title or input\.events\[0\]\.eventNodeId is required/);
});

function normalizeMode(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
