const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { ProjectToolHost } = require("../src/tools/tool-host");

function createHost(overrides = {}) {
  return new ProjectToolHost({
    services: {
      config: {
        ...(overrides.config || {}),
      },
      memoryMetabolism: overrides.memoryMetabolism || null,
      diary: {
        async append(args) {
          return { filePath: "/tmp/diary.md", ...args };
        },
      },
      reminder: {
        async create(args) {
          return { id: "reminder-1", ...args };
        },
        list() {
          return [{
            id: "reminder-1",
            dueAt: "2026-05-09T12:00:00.000Z",
            text: "Check whether the morning bridge is healthy.",
          }];
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
        async upsertCase(args) {
          return {
            ok: true,
            record: {
              case_id: args.case_id || "case-1",
              title: args.title || "Bridge stability pass",
              status: args.status || "active",
            },
          };
        },
        async appendSolitudeEntry(args) {
          return {
            ok: true,
            solitude_id: "solitude-1",
            record: {
              solitude_id: "solitude-1",
              summary: args.summary,
              reasoning_summary: args.reasoning_summary || "",
              entry_type: args.entry_type || "reflection",
            },
          };
        },
        async searchSolitudeEntries() {
          return {
            ok: true,
            count: 1,
            hits: [{
              solitude_id: "solitude-1",
              summary: "Checkin found a repeated context issue.",
              entry_type: "experience",
            }],
          };
        },
        async appendWakeupDecision(args) {
          return {
            ok: true,
            record: {
              record_id: "wake-1",
              decision: args.decision || "silent",
              wake_motive: args.wake_motive || "random_checkin",
              intent_summary: args.intent_summary || "Checked status and stayed quiet.",
              actions_taken: args.actions_taken || [],
              next_actions: args.next_actions || [],
            },
          };
        },
        async listWakeupDecisions() {
          return {
            ok: true,
            count: 1,
            latest: {
              record_id: "wake-1",
              decision: "maintenance",
              intent_summary: "Checked bridge status.",
            },
            pending_next_actions: [{
              from_record_id: "wake-1",
              action: "Check dreaming after the user is quiet.",
            }],
            records: [{
              record_id: "wake-1",
              decision: "maintenance",
              intent_summary: "Checked bridge status.",
            }],
          };
        },
        async appendCaseEvent(args) {
          return {
            ok: true,
            case_id: args.case_id,
            event: {
              event_id: "event-1",
              case_id: args.case_id,
              summary: args.summary || "Ran checks.",
            },
          };
        },
        async linkCaseArtifact(args) {
          return {
            ok: true,
            artifact: {
              ...args,
              title: args.title || "diagnostic",
              path: args.path || "/tmp/diag.json",
            },
          };
        },
        async searchCases() {
          return {
            ok: true,
            count: 1,
            items: [{
              case_id: "case-1",
              title: "Bridge stability pass",
              status: "active",
            }],
          };
        },
        async readCase(args) {
          return {
            ok: true,
            case_id: args.case_id,
            record: {
              case_id: args.case_id,
              title: "Bridge stability pass",
              status: "active",
              events: [],
            },
          };
        },
        async closeCase(args) {
          return {
            ok: true,
            record: {
              case_id: args.case_id,
              status: args.status || "completed",
              closure_summary: args.closure_summary || "Completed.",
            },
          };
        },
        async exportCaseMarkdown(args) {
          return {
            ok: true,
            case_id: args.case_id,
            path: `/tmp/${args.case_id}.md`,
          };
        },
        async appendObservation(args) {
          return {
            ok: true,
            record: {
              observation_id: args.observation_id || "obs-1",
              observation: args.observation,
              kind: args.kind || "life_rhythm",
              status: args.status || "tentative",
              confidence: args.confidence ?? 0.35,
            },
          };
        },
        async searchObservations(args) {
          return {
            ok: true,
            query: args.query || "",
            count: 1,
            hits: [{
              observation_id: "obs-1",
              observation: "User often needs gentler morning prompts.",
              kind: "life_rhythm",
              status: "tentative",
              confidence: 0.45,
            }],
          };
        },
        async readObservation(args) {
          return {
            ok: true,
            observation_id: args.observation_id,
            record: {
              observation_id: args.observation_id,
              observation: "User often needs gentler morning prompts.",
              kind: "life_rhythm",
              status: "tentative",
              confidence: 0.45,
            },
          };
        },
        async updateObservation(args) {
          return {
            ok: true,
            record: {
              observation_id: args.observation_id,
              observation: args.observation || "User prefers direct correction when a pattern is wrong.",
              status: args.status || "active",
              confidence: args.confidence ?? 0.5,
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
        async inspectColdRootDuplicates(args) {
          return {
            ok: true,
            query: args.query || "",
            active_version: args.version || "v2",
            duplicate_cluster_count: 1,
            clusters: [{
              cluster_id: "cold_dup_01",
              score: 100,
              reasons: ["same source type and normalized root identity"],
              root_keys: ["hard_fact:f1", "hard_fact:f2"],
              suggested_keep_root_key: "hard_fact:f1",
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
      memoryMetabolism: {
        recordReceipt(args) {
          return {
            ok: args.status === "no_op" || Number(args.mutation_count) > 0,
            receipt: {
              receipt_id: "receipt-1",
              attempt_id: args.attempt_id,
              status: args.status,
              mutation_count: args.mutation_count || 0,
              summary: args.summary,
            },
          };
        },
      },
      channelFile: {
        async sendToCurrentChat(args) {
          return { filePath: args.filePath, userId: args.userId || "user-1" };
        },
        ...(overrides.channelFile || {}),
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
        async search(args) {
          return {
            query: args.query,
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
    await host.invokeTool("mossbridge_timeline_write", {
      date: "2026-04-21",
      events: [],
      eventsJson: "{\"events\":[]}",
    }, {});
  }, /input\.eventsJson is not allowed/);
});

test("tool host exposes a read-only bridge status tool for heartbeat maintenance", async () => {
  const host = createHost();
  const tools = host.listTools();
  const statusTool = tools.find((tool) => tool.name === "mossbridge_bridge_status");

  assert.ok(statusTool);
  assert.match(statusTool.description, /read-only/i);
  assert.match(statusTool.description, /Random check-ins usually run in a lightweight no-tool profile/i);

  const result = await host.invokeTool("mossbridge_bridge_status", {}, {
    runtimeId: "claudecode",
    workspaceRoot: "/workspace",
    senderId: "user-1",
  });

  assert.match(result.text, /Mossbridge status/);
  assert.match(result.text, /policy=read_only_report/);
  assert.equal(result.data.runtime_id, "claudecode");
  assert.equal(result.data.maintenance.profile, "safe_self_check");
  assert.equal(result.data.maintenance.self_repair_allowed, false);
  assert.equal(result.data.maintenance.action_level, "read_only_report");
  assert.equal(result.data.recommendations[0].code, "no_immediate_action");
  assert.equal(result.data.queues.system_pending, 0);
  assert.equal(result.data.reminders.pending_count, 1);
  assert.equal(result.data.reminders.next_due_at, "2026-05-09T12:00:00.000Z");
});

test("bridge status uses config runtime instead of a hard-coded Codex fallback", async () => {
  const host = createHost({
    config: {
      runtime: "localruntime",
    },
  });

  const result = await host.invokeTool("mossbridge_bridge_status", {}, {
    workspaceRoot: "/workspace",
    senderId: "user-1",
  });

  assert.equal(result.data.runtime_id, "localruntime");
  assert.match(result.text, /runtime=localruntime/);
  assert.doesNotMatch(result.text, /runtime=codex/);
});

test("bridge status includes latest sticker delivery degradation", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-status-sticker-"));
  const stickerDeliveryAuditFile = path.join(tempRoot, "sticker-delivery-audit.json");
  fs.writeFileSync(stickerDeliveryAuditFile, `${JSON.stringify({
    lastDelivery: {
      kind: "sticker_delivery",
      ts: new Date().toISOString(),
      status: "sent",
      stickerId: "stk_012",
      sourceFileName: "stk_012.gif",
      sourceMimeType: "image/gif",
      deliveryFileName: "stk_012-preview.png",
      deliveryMimeType: "image/png",
      deliveryTransform: "gif_static_png_preview",
      channelDeliveryKind: "file",
      fallbackFrom: "image",
      fallbackReason: "image upload failed: CDN 500",
    },
    recentDeliveries: [],
  }, null, 2)}\n`, "utf8");
  try {
    const host = createHost({ config: { stickerDeliveryAuditFile } });
    const result = await host.invokeTool("mossbridge_bridge_status", {
      includeQueues: false,
      includeReminders: false,
      includeRuntime: false,
      includeControl: false,
    }, {});

    assert.equal(result.data.channel.last_sticker_delivery.state, "degraded");
    assert.equal(result.data.channel.last_sticker_delivery.sticker_id, "stk_012");
    assert.equal(result.data.channel.last_sticker_delivery.channel_kind, "file");
    assert.equal(result.data.channel.last_sticker_delivery.fallback_from, "image");
    assert.match(result.text, /Last sticker: degraded stk_012 image\/gif -> image\/png/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("bridge status exposes weighted daily checkin budget pressure", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-status-budget-"));
  const usageFile = path.join(tempRoot, "runtime-context-usage.json");
  fs.writeFileSync(usageFile, `${JSON.stringify({
    contextsByThreadId: {
      "system-1": {
        runtimeId: "claudecode",
        bindingKey: "default:user#mossbridge-system",
        currentTokens: 103_500,
        inputTokens: 1_000,
        cacheCreationInputTokens: 2_000,
        cacheReadInputTokens: 100_000,
        outputTokens: 500,
        updatedAt: new Date().toISOString(),
      },
      "user-1": {
        runtimeId: "claudecode",
        bindingKey: "default:user",
        currentTokens: 90_000,
        updatedAt: new Date().toISOString(),
      },
    },
  }, null, 2)}\n`, "utf8");

  const host = new ProjectToolHost({
    services: {
      config: {
        runtime: "claudecode",
        runtimeContextUsageFile: usageFile,
        checkinDailyTokenBudget: 12_000,
        checkinDailyThreadBudget: 10,
        checkinDailyCacheReadWeight: 0.1,
      },
    },
    runtimeContextStore: {
      resolveActiveContext() {
        return {};
      },
    },
  });

  const result = await host.invokeTool("mossbridge_bridge_status", {
    includeQueues: false,
    includeReminders: false,
    includeControl: false,
  }, {
    runtimeId: "claudecode",
  });

  assert.match(result.text, /checkinBudget=13500\/12000 weighted/);
  assert.equal(result.data.runtime.daily_checkin_budget.weighted_tokens, 13_500);
  assert.equal(result.data.runtime.daily_checkin_budget.current_tokens, 103_500);
  assert.equal(result.data.runtime.daily_checkin_budget.thread_count, 1);
  assert.equal(result.data.runtime.daily_checkin_budget.token_exceeded, true);
  assert.equal(result.data.runtime.daily_checkin_budget.exceeded, true);
  assert.equal(result.data.recommendations[0].code, "daily_checkin_budget_exceeded");
});

test("tool host exposes solitude journal tools for wakeup self-review", async () => {
  const host = createHost();
  const tools = host.listTools();
  const writeTool = tools.find((tool) => tool.name === "mossbridge_solitude_journal_write");
  const searchTool = tools.find((tool) => tool.name === "mossbridge_solitude_journal_search");

  assert.ok(writeTool);
  assert.ok(searchTool);
  assert.match(writeTool.description, /Persist shareable outcomes and visible evidence/i);

  const written = await host.invokeTool("mossbridge_solitude_journal_write", {
    summary: "Checkin should leave a useful internal note when silence is chosen.",
    entry_type: "experience",
    wake_context: "random_checkin",
    reasoning_summary: "The useful action is to remember the lesson, not message immediately.",
    evidence: ["recent random checkins were too binary"],
    next_actions: ["prefer solitude journal when no user-facing message is needed"],
  }, { senderId: "user-1" });
  const searched = await host.invokeTool("mossbridge_solitude_journal_search", {
    query: "context issue",
  }, { senderId: "user-1" });

  assert.equal(written.text, "Solitude journal entry stored: solitude-1");
  assert.equal(written.data.record.entry_type, "experience");
  assert.equal(searched.text, "Solitude journal entries found: 1");
});

test("tool host exposes wakeup agenda tools for heartbeat continuity", async () => {
  const host = createHost();
  const tools = host.listTools();
  const readTool = tools.find((tool) => tool.name === "mossbridge_wakeup_agenda_read");
  const writeTool = tools.find((tool) => tool.name === "mossbridge_wakeup_decision_write");

  assert.ok(readTool);
  assert.ok(writeTool);
  assert.match(writeTool.description, /final outcome/i);
  assert.match(writeTool.description, /keeping raw hidden chain-of-thought out/i);

  const read = await host.invokeTool("mossbridge_wakeup_agenda_read", {
    limit: 3,
  }, { senderId: "user-1" });
  const written = await host.invokeTool("mossbridge_wakeup_decision_write", {
    decision: "maintenance",
    wake_motive: "random_checkin",
    intent_summary: "Checked status and left a next-action handle instead of messaging.",
    actions_taken: ["read bridge status"],
    next_actions: ["recheck dreaming after quiet time"],
    contact_channel: "none",
  }, { senderId: "user-1" });

  assert.equal(read.text, "Wakeup agenda loaded: 1 records, 1 pending actions.");
  assert.equal(written.text, "Wakeup decision stored: wake-1");
  assert.equal(written.data.record.decision, "maintenance");
});

test("tool host exposes memory metabolism receipt tool for dreaming completion", async () => {
  const host = createHost();
  const tool = host.listTools().find((candidate) => candidate.name === "mossbridge_memory_metabolism_receipt_write");
  assert.ok(tool);
  assert.match(tool.description, /receipt/);

  const result = await host.invokeTool("mossbridge_memory_metabolism_receipt_write", {
    attempt_id: "dream-1",
    status: "no_op",
    summary: "No durable memory candidate in this quiet pass.",
    mutation_count: 0,
    source_record_ids: ["cap-1"],
    mutations: [{
      target: "no_op",
      action: "no_op",
      summary: "Reviewed and skipped.",
    }],
  }, {});

  assert.equal(result.data.receipt.attempt_id, "dream-1");
  assert.equal(result.data.receipt.status, "no_op");
});

test("tool host does not expose private external executors", () => {
  const host = createHost();
  const publicTools = host.listTools()
    .filter((tool) => tool.name.startsWith("mossbridge_"));
  const forbiddenNames = /home|miot|email|gmail|permission/i;
  const forbiddenDescriptions = /home|miot|email|gmail|permission-management|permission manager/i;

  assert.ok(publicTools.length > 0);
  for (const tool of publicTools) {
    assert.doesNotMatch(tool.name, forbiddenNames);
    assert.doesNotMatch(tool.description || "", forbiddenDescriptions);
  }
});

test("tool host exposes structured timeline read tools", async () => {
  const host = createHost();
  const readResult = await host.invokeTool("mossbridge_timeline_read", {
    date: "2026-04-21",
  }, {});
  const categoriesResult = await host.invokeTool("mossbridge_timeline_categories", {}, {});
  const proposalsResult = await host.invokeTool("mossbridge_timeline_proposals", {
    date: "2026-04-21",
  }, {});

  assert.equal(readResult.text, "Timeline day 2026-04-21: 1 events.");
  assert.equal(categoriesResult.text, "Timeline categories loaded: 2.");
  assert.equal(proposalsResult.text, "Timeline proposals loaded: 1.");
});

test("tool host validates structured reminder input types", async () => {
  const host = createHost();
  const reminderCreate = host.listTools().find((tool) => tool.name === "mossbridge_reminder_create");
  assert.match(reminderCreate.description, /AI-calendar wakeup/);
  assert.match(reminderCreate.description, /full tool profile/);
  await assert.rejects(async () => {
    await host.invokeTool("mossbridge_reminder_create", {
      text: "ping me",
      delayMinutes: "30",
    }, {});
  }, /input\.delayMinutes must be an integer/);
});

test("tool host accepts structured timeline screenshot input", async () => {
  const host = createHost();
  const result = await host.invokeTool("mossbridge_timeline_screenshot", {
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
  assert.ok(tools.find((tool) => tool.name === "mossbridge_sticker_tags"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_sticker_search"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_sticker_pick"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_sticker_list"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_sticker_send"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_sticker_save_from_inbox"));

  const tags = await host.invokeTool("mossbridge_sticker_tags", {}, {});
  const searched = await host.invokeTool("mossbridge_sticker_search", { query: "happy dog" }, {});
  const picked = await host.invokeTool("mossbridge_sticker_pick", { tag: "开心" }, {});
  const listed = await host.invokeTool("mossbridge_sticker_list", { tag: "开心" }, {});
  const sent = await host.invokeTool("mossbridge_sticker_send", { stickerId: "stk_001" }, {});
  const saved = await host.invokeTool("mossbridge_sticker_save_from_inbox", {
    items: [{
      filePath: "/tmp/input.gif",
      tags: ["开心"],
      desc: "开心小狗摇尾巴的表情。",
    }],
  }, {});

  assert.equal(tags.text, "Sticker tags loaded: 2");
  assert.equal(searched.text, "Sticker search for happy dog: 1");
  assert.equal(picked.text, "Sticker candidates for 开心: 1");
  assert.equal(listed.text, "Sticker inventory: 1");
  assert.equal(sent.text, "Sticker sent: stk_001");
  assert.equal(saved.text, "Stickers saved: 1, deduped: 0");
});

test("tool host descriptions include schema summary for models that only surface descriptions", () => {
  const host = createHost();
  const timelineWrite = host.listTools().find((tool) => tool.name === "mossbridge_timeline_write");
  assert.match(timelineWrite.description, /Input:/);
  assert.match(timelineWrite.description, /date: string/);
  assert.match(timelineWrite.description, /events: \{/);
});

test("tool host filters MCP tools by runtime profile", async () => {
  const host = createHost();
  const foregroundNames = host.listTools({ toolProfile: "foreground" }).map((tool) => tool.name);
  const taskNames = host.listTools({ toolProfile: "task" }).map((tool) => tool.name);
  const fullNames = host.listTools({ toolProfile: "full" }).map((tool) => tool.name);
  const liteNames = host.listTools({ toolProfile: "checkin_lite" }).map((tool) => tool.name);

  assert.ok(foregroundNames.includes("mossbridge_reminder_create"));
  assert.ok(foregroundNames.includes("mossbridge_sticker_send"));
  assert.ok(foregroundNames.includes("mossbridge_memory_warm_update"));
  assert.ok(foregroundNames.includes("mossbridge_memory_episode_append"));
  assert.ok(foregroundNames.includes("mossbridge_memory_observation_update"));
  assert.ok(foregroundNames.includes("mossbridge_memory_cold_search"));
  assert.ok(foregroundNames.includes("mossbridge_memory_cold_duplicates"));
  assert.ok(foregroundNames.includes("mossbridge_memory_cold_root_read"));
  assert.ok(foregroundNames.includes("mossbridge_memory_cold_patch"));
  assert.ok(!foregroundNames.includes("mossbridge_bridge_status"));
  assert.ok(!foregroundNames.includes("mossbridge_memory_cold_read"));
  assert.ok(!foregroundNames.includes("mossbridge_memory_cold_upsert"));
  assert.ok(!foregroundNames.includes("mossbridge_memory_case_upsert"));
  assert.ok(!foregroundNames.includes("mossbridge_timeline_write"));
  assert.ok(!foregroundNames.includes("mossbridge_solitude_journal_write"));
  assert.ok(!foregroundNames.includes("mossbridge_wakeup_decision_write"));
  assert.ok(!foregroundNames.includes("whereabouts_snapshot"));

  assert.ok(taskNames.includes("mossbridge_memory_case_upsert"));
  assert.ok(taskNames.includes("mossbridge_memory_cold_search"));
  assert.ok(taskNames.includes("mossbridge_memory_cold_duplicates"));
  assert.ok(fullNames.includes("mossbridge_memory_cold_search"));
  assert.ok(fullNames.includes("mossbridge_memory_cold_duplicates"));
  assert.ok(fullNames.includes("mossbridge_timeline_write"));
  assert.deepEqual(liteNames, []);

  const foregroundScan = await host.invokeTool("mossbridge_memory_cold_duplicates", {
    query: "Shanghai",
  }, { toolProfile: "foreground" });
  assert.equal(foregroundScan.text, "Cold memory duplicate scan returned 1 clusters.");
});

test("tool host exposes structured warm-memory lookup and exact-card mutation tools", async () => {
  const host = createHost();
  const tools = host.listTools();
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_warm_search"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_warm_read"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_warm_update"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_warm_delete"));
  const writeTool = tools.find((tool) => tool.name === "mossbridge_memory_warm_write");
  const updateTool = tools.find((tool) => tool.name === "mossbridge_memory_warm_update");
  assert.match(writeTool.description, /diary\/persona continuity/);
  assert.match(writeTool.description, /future self should use it/);
  assert.match(writeTool.description, /The user prefers/);
  assert.match(writeTool.inputSchema.properties.body_markdown.description, /future-use cue/);
  assert.equal(writeTool.inputSchema.properties.body_markdown.description.length < 220, true);
  assert.equal(updateTool.inputSchema.properties.body_markdown.description.length < 180, true);
  assert.equal(writeTool.inputSchema.properties.resident.type, "boolean");
  assert.equal(updateTool.inputSchema.properties.resident.type, "boolean");
  assert.match(writeTool.inputSchema.properties.pinned.description, /may enter resident delivery/);
  assert.match(writeTool.inputSchema.properties.resident.description, /Explicit every-turn resident/);
  assert.match(updateTool.inputSchema.properties.body_markdown.description, /evidence\/source/);
  assert.equal(updateTool.inputSchema.properties.resident_kind, undefined);

  const search = await host.invokeTool("mossbridge_memory_warm_search", {
    query: "coffee",
  }, { senderId: "user-1" });
  const read = await host.invokeTool("mossbridge_memory_warm_read", {
    material_id: "memo-1",
  }, { senderId: "user-1" });
  const update = await host.invokeTool("mossbridge_memory_warm_update", {
    material_id: "memo-1",
    body_markdown: "User switched to hand-brew at home.",
  }, { senderId: "user-1" });
  const removal = await host.invokeTool("mossbridge_memory_warm_delete", {
    material_id: "memo-1",
  }, { senderId: "user-1" });

  assert.equal(search.text, "Warm memory search returned 1 hits.");
  assert.equal(read.text, "Warm memory loaded: memo-1");
  assert.equal(read.data.record.material_id, "memo-1");
  assert.equal(update.text, "Warm memory updated: memo-1");
  assert.equal(update.data.record.body_markdown, "User switched to hand-brew at home.");
  assert.equal(removal.text, "Warm memory deleted: memo-1");
});

test("channel file tool returns safe delivery failures instead of throwing into the runtime", async () => {
  const host = createHost({
    channelFile: {
      async sendToCurrentChat() {
        const error = new Error("File is too large for safe WeChat delivery.");
        error.code = "CHANNEL_FILE_TOO_LARGE";
        error.channelFile = { code: error.code, sizeBytes: 30, maxBytes: 20 };
        throw error;
      },
    },
  });

  const result = await host.invokeTool("mossbridge_channel_send_file", {
    filePath: "/tmp/too-large.zip",
  }, { senderId: "user-1" });

  assert.equal(result.data.ok, false);
  assert.equal(result.data.code, "CHANNEL_FILE_TOO_LARGE");
  assert.match(result.text, /File not sent safely/);
});

test("tool host exposes ongoing-track tools for medium-horizon live threads", async () => {
  const host = createHost();
  const tools = host.listTools();
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_ongoing_upsert"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_ongoing_list"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_ongoing_read"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_ongoing_close"));

  const created = await host.invokeTool("mossbridge_memory_ongoing_upsert", {
    title: "减重",
    summary: "最近在减重。",
  }, { senderId: "user-1" });
  const listed = await host.invokeTool("mossbridge_memory_ongoing_list", {}, { senderId: "user-1" });
  const read = await host.invokeTool("mossbridge_memory_ongoing_read", {
    track_id: "track-1",
  }, { senderId: "user-1" });
  const closed = await host.invokeTool("mossbridge_memory_ongoing_close", {
    track_id: "track-1",
    closure_summary: "阶段完成",
  }, { senderId: "user-1" });

  assert.equal(created.text, "Ongoing track stored: track-1");
  assert.equal(listed.text, "Ongoing tracks: 1");
  assert.equal(read.text, "Ongoing track loaded: track-1");
  assert.equal(closed.text, "Ongoing track closed: track-1");
});

test("tool host exposes quiet work-provenance case tools", async () => {
  const host = createHost();
  const tools = host.listTools();
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_case_upsert"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_case_append"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_case_search"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_case_read"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_case_close"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_case_export"));
  const upsertTool = tools.find((tool) => tool.name === "mossbridge_memory_case_upsert");
  const artifactTool = tools.find((tool) => tool.name === "mossbridge_memory_case_artifact");
  const closeTool = tools.find((tool) => tool.name === "mossbridge_memory_case_close");
  assert.match(upsertTool.description, /Ordinary intimate chat and life episodes belong in notebook/i);
  assert.match(artifactTool.description, /human-approved final/i);
  assert.match(artifactTool.description, /cloud sync/i);
  assert.ok(artifactTool.inputSchema.properties.status);
  assert.ok(artifactTool.inputSchema.properties.final_artifact_id);
  assert.ok(artifactTool.inputSchema.properties.storage_id);
  assert.match(closeTool.description, /Closing keeps artifact status separate from final approval/i);
  assert.match(closeTool.description, /cleanup confirmation/i);

  const saved = await host.invokeTool("mossbridge_memory_case_upsert", {
    title: "Bridge stability pass",
    summary: "Added guardrails.",
  }, { senderId: "user-1" });
  const event = await host.invokeTool("mossbridge_memory_case_append", {
    case_id: "case-1",
    summary: "Ran npm check.",
    tests: [{ command: "npm run check", status: "passed" }],
  }, { senderId: "user-1" });
  const artifact = await host.invokeTool("mossbridge_memory_case_artifact", {
    case_id: "case-1",
    title: "diagnostic",
    path: "/tmp/diag.json",
    status: "user_approved_final",
    final_artifact_id: "final-001",
    storage_id: "CASE-20260509-001",
    checksum: "sha256:abc",
    size_bytes: 128,
  }, { senderId: "user-1" });
  const search = await host.invokeTool("mossbridge_memory_case_search", {
    query: "stability",
  }, { senderId: "user-1" });
  const read = await host.invokeTool("mossbridge_memory_case_read", {
    case_id: "case-1",
  }, { senderId: "user-1" });
  const exported = await host.invokeTool("mossbridge_memory_case_export", {
    case_id: "case-1",
  }, { senderId: "user-1" });
  const closed = await host.invokeTool("mossbridge_memory_case_close", {
    case_id: "case-1",
    closure_summary: "Ready.",
  }, { senderId: "user-1" });

  assert.equal(saved.text, "Case saved: case-1");
  assert.equal(event.text, "Case event appended: event-1");
  assert.equal(artifact.text, "Case artifact linked: diagnostic");
  assert.equal(artifact.data.artifact.status, "user_approved_final");
  assert.equal(artifact.data.artifact.final_artifact_id, "final-001");
  assert.equal(artifact.data.artifact.storage_id, "CASE-20260509-001");
  assert.equal(artifact.data.artifact.size_bytes, 128);
  assert.equal(search.text, "Cases found: 1");
  assert.equal(read.text, "Case loaded: case-1");
  assert.equal(exported.text, "Case markdown exported: /tmp/case-1.md");
  assert.equal(closed.text, "Case closed: case-1");
});

test("tool host exposes revisable observation journal tools", async () => {
  const host = createHost();
  const tools = host.listTools();
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_observation_append"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_observation_search"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_observation_read"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_observation_update"));
  const appendTool = tools.find((tool) => tool.name === "mossbridge_memory_observation_append");
  assert.match(appendTool.description, /write it proactively and silently/i);
  assert.match(appendTool.description, /observations are revisable notes/i);

  const appended = await host.invokeTool("mossbridge_memory_observation_append", {
    observation: "User often needs gentler morning prompts.",
    kind: "life_rhythm",
    confidence: 0.45,
    evidence: ["morning wakeups land better when low-pressure"],
  }, { senderId: "user-1" });
  const search = await host.invokeTool("mossbridge_memory_observation_search", {
    query: "morning prompts",
  }, { senderId: "user-1" });
  const read = await host.invokeTool("mossbridge_memory_observation_read", {
    observation_id: "obs-1",
  }, { senderId: "user-1" });
  const updated = await host.invokeTool("mossbridge_memory_observation_update", {
    observation_id: "obs-1",
    status: "rejected",
    correction_note: "User said this framing felt wrong.",
  }, { senderId: "user-1" });

  assert.equal(appended.text, "Observation stored: obs-1");
  assert.equal(search.text, "Observation search returned 1 hits.");
  assert.equal(read.text, "Observation loaded: obs-1");
  assert.equal(updated.text, "Observation updated: obs-1");
  assert.equal(updated.data.record.status, "rejected");
});

test("tool host exposes cold-memory inspection tools beside version upsert", async () => {
  const host = createHost();
  const versions = await host.invokeTool("mossbridge_memory_cold_versions", {}, { senderId: "user-1" });
  const active = await host.invokeTool("mossbridge_memory_cold_read", {}, { senderId: "user-1" });

  assert.equal(versions.text, "Cold memory versions: 2 (active=v2).");
  assert.equal(active.text, "Cold memory loaded: v2");
  assert.equal(active.data.payload.hard_facts[0].fact_key, "city");
});

test("tool host exposes cold root search, read, and exact patch tools", async () => {
  const host = createHost();
  const tools = host.listTools();
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_cold_search"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_cold_duplicates"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_cold_root_read"));
  assert.ok(tools.find((tool) => tool.name === "mossbridge_memory_cold_patch"));

  const search = await host.invokeTool("mossbridge_memory_cold_search", {
    query: "Shanghai",
  }, { senderId: "user-1" });
  const duplicates = await host.invokeTool("mossbridge_memory_cold_duplicates", {
    query: "city",
  }, { senderId: "user-1" });
  const read = await host.invokeTool("mossbridge_memory_cold_root_read", {
    root_key: "hard_fact:f1",
  }, { senderId: "user-1" });
  const patch = await host.invokeTool("mossbridge_memory_cold_patch", {
    root_key: "hard_fact:f1",
    changes: {
      fact_value: "Hangzhou",
    },
  }, { senderId: "user-1" });
  const deletion = await host.invokeTool("mossbridge_memory_cold_patch", {
    root_key: "hard_fact:f1",
    mode: "delete",
  }, { senderId: "user-1" });

  assert.equal(search.text, "Cold memory root search returned 1 hits.");
  assert.equal(duplicates.text, "Cold memory duplicate scan returned 1 clusters.");
  assert.equal(duplicates.data.clusters[0].root_keys.length, 2);
  assert.equal(read.text, "Cold memory root loaded: hard_fact:f1");
  assert.equal(read.data.root.item.fact_value, "Shanghai");
  assert.equal(patch.text, "Cold memory root patched: hard_fact:f1");
  assert.equal(patch.data.root.item.fact_value, "Hangzhou");
  assert.equal(deletion.text, "Cold memory root deleted: hard_fact:f1");
});

test("tool host rejects cold root patch without changes unless mode is delete", async () => {
  const host = createHost();
  await assert.rejects(async () => {
    await host.invokeTool("mossbridge_memory_cold_patch", {
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
    await host.invokeTool("mossbridge_timeline_write", {
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
