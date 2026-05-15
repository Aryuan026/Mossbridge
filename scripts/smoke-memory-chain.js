#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");

const { readConfig } = require("../src/core/config");
const { importDailyCaptureTarget } = require("../src/importers/app-daily-capture");
const { AsherieMemoryService } = require("../src/services/asherie-memory-service");
const { DiaryService } = require("../src/services/diary-service");
const { MemoryMetabolismService } = require("../src/services/memory-metabolism-service");
const {
  ensureStickerCatalogFilesSync,
  loadStickerIndexSync,
  loadStickerTagsSync,
} = require("../src/services/sticker-service");

async function main() {
  loadEnv();
  const config = readConfig();
  const errors = [];

  requireExplicitEnv("MOSSBRIDGE_STATE_DIR", errors);
  requireExplicitEnv("MOSSBRIDGE_DATA_ROOT", errors);
  requireExplicitEnv("MOSSBRIDGE_WORKSPACE_ROOT", errors);
  requireSeparatePath("MOSSBRIDGE_STATE_DIR", config.stateDir, "MOSSBRIDGE_DATA_ROOT", config.asherieDataRoot, errors);
  requireSeparatePath("MOSSBRIDGE_STATE_DIR", config.stateDir, "MOSSBRIDGE_WORKSPACE_ROOT", config.workspaceRoot, errors);
  requireSeparatePath("MOSSBRIDGE_DATA_ROOT", config.asherieDataRoot, "MOSSBRIDGE_WORKSPACE_ROOT", config.workspaceRoot, errors);

  if (errors.length) {
    printResult({ ok: false, errors });
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(config.workspaceRoot, { recursive: true });

  const memory = new AsherieMemoryService({ config });
  const diary = new DiaryService({ config });
  const runId = `chain-smoke-${Date.now()}`;

  const warm = await memory.writeWarmMaterial({
    material_id: `${runId}-warm`,
    title: "Memory chain smoke anchor",
    summary: "Used to verify warm-memory write and recall.",
    body_markdown: "Mossbridge memory-chain smoke should recall this warm card.",
    tags: ["smoke", "memory-chain"],
    pinned: true,
    userId: config.identityUserId,
  });
  const ongoing = await memory.upsertOngoingTrack({
    track_id: `${runId}-track`,
    title: "Memory chain smoke active thread",
    summary: "Used to verify ongoing-track write and recall.",
    status: "active",
    kind: "system",
    userId: config.identityUserId,
  });
  const observation = await memory.appendObservation({
    observation: "Memory chain smoke observation should stay revisable.",
    kind: "work_style",
    confidence: 0.4,
    evidence: ["isolated smoke"],
    userId: config.identityUserId,
  });
  const episode = await memory.upsertEpisode({
    episode_id: `${runId}-episode`,
    title: "Memory chain smoke episode",
    kind: "system_check",
    status: "active",
    summary: "Used to verify episode journal write/read/export.",
    tags: ["smoke"],
    topology_refs: { themes: ["memory-chain"] },
    userId: config.identityUserId,
  });
  const episodeEntry = await memory.appendEpisodeEntry({
    episode_id: `${runId}-episode`,
    entry_type: "milestone",
    summary: "Episode entry created by memory-chain smoke.",
    userId: config.identityUserId,
  });
  const caseRecord = await memory.upsertCase({
    case_id: `${runId}-case`,
    title: "Memory chain smoke case",
    kind: "system_check",
    status: "active",
    summary: "Used to verify case-index write/read/export.",
    userId: config.identityUserId,
  });
  const caseEvent = await memory.appendCaseEvent({
    case_id: `${runId}-case`,
    event_type: "test",
    summary: "Memory-chain smoke wrote a case event.",
    tests: [{ command: "npm run smoke:memory-chain", status: "running" }],
    userId: config.identityUserId,
  });
  const solitude = await memory.appendSolitudeEntry({
    summary: "Memory-chain smoke solitude note.",
    reasoning_summary: "This is a shareable smoke note, not hidden chain-of-thought.",
    entry_type: "experience",
    tags: ["smoke"],
    userId: config.identityUserId,
  });
  const notebook = await diary.append({
    date: "2026-05-15",
    time: "00:00",
    title: "Memory chain smoke",
    text: "Notebook smoke entry stored under the Mossbridge data root.",
  });
  const writeback = await memory.writebackTurn({
    userId: config.identityUserId,
    query: "memory chain smoke user turn",
    incomingMessages: [{ role: "user", content: "memory chain smoke user turn" }],
    outboundMessages: [{ role: "assistant", content: "memory chain smoke assistant reply" }],
    assistantTextFinal: "memory chain smoke assistant reply",
    runtimeId: config.runtime,
    channelId: "smoke",
    sourceClient: "mossbridge_memory_chain_smoke",
    routeId: "memory-chain-smoke",
    transportId: "smoke",
  });
  const captureBundlePath = path.join(config.workspaceRoot, `${runId}-web-ai-capture.json`);
  fs.writeFileSync(captureBundlePath, `${JSON.stringify({
    schema: "mossbridge_app_daily_capture_bundle_v0.1",
    source_client: "smoke_web_ai",
    captured_date: "2026-05-15",
    captured_at: "2026-05-15T00:00:00.000Z",
    timezone: "Asia/Shanghai",
    exporter: { name: "mossbridge-smoke", version: "0.1.0" },
    conversations: [{
      conversation_id: `${runId}-capture-thread`,
      conversation_title: "Window capture smoke",
      source_url: "https://example.invalid/ai/smoke",
      messages: [
        {
          message_id: `${runId}-capture-user`,
          role: "user",
          text: "window capture smoke user tail",
          created_at: "2026-05-15T00:00:00.000Z",
          local_date: "2026-05-15",
          attachments: [],
        },
        {
          message_id: `${runId}-capture-assistant`,
          role: "assistant",
          text: "window capture smoke assistant tail",
          created_at: "2026-05-15T00:00:02.000Z",
          local_date: "2026-05-15",
          attachments: [],
        },
      ],
    }],
  }, null, 2)}\n`, "utf8");
  const captureImport = await importDailyCaptureTarget(captureBundlePath, { memoryService: memory });
  const metabolism = new MemoryMetabolismService({
    config: {
      ...config,
      startWithDreaming: true,
      dreamingPollIntervalMinutes: 1,
      dreamingQuietMinutes: 1,
      dreamingRetryMinutes: 1,
      dreamingMinSourceRecords: 1,
      dreamingMaxSourceRecords: 8,
    },
    memoryService: memory,
  });
  const dreamingQueue = [];
  const dreaming = metabolism.maybeQueueDreaming({
    accountId: "smoke-account",
    senderId: config.identityUserId,
    workspaceRoot: config.workspaceRoot,
    contextToken: "smoke-context-token",
    queue: {
      enqueue(message) {
        dreamingQueue.push(message);
        return message;
      },
    },
    queueHasPending: false,
    runtimeCooldown: null,
    lastActivityAt: Date.now() - 10 * 60_000,
    nowMs: Date.now(),
  });
  if (dreaming?.queued) {
    metabolism.markAttemptDispatched(dreaming.attempt_id, {
      threadId: "smoke-thread",
      turnId: "smoke-turn",
    });
    metabolism.recordReceipt({
      attempt_id: dreaming.attempt_id,
      status: "no_op",
      summary: "Smoke verified the dreaming completion gate without promoting durable memory.",
      mutation_count: 0,
      source_record_ids: dreaming.source_record_ids,
      mutations: [{
        target: "no_op",
        action: "no_op",
        summary: "No durable promotion needed for the smoke record.",
      }],
    });
  }
  const dreamingCompletion = dreaming?.queued
    ? metabolism.completeRuntimeAttempt({
        systemTurn: {
          trigger_kind: "dreaming_opportunity",
          metadata: { dreamingAttemptId: dreaming.attempt_id },
        },
        eventType: "runtime.turn.completed",
        assistantTextFinal: "{\"action\":\"silent\"}",
        writebackResult: { ok: true },
      })
    : null;

  ensureStickerCatalogFilesSync(config);
  const stickerIndex = loadStickerIndexSync(config);
  const stickerTags = loadStickerTagsSync(config);

  const packet = await memory.captureContextPacket({
    userId: config.identityUserId,
    query: "memory chain smoke anchor active thread observation episode window capture smoke",
    recallMode: "user_triggered",
    includeSolitudeDigest: true,
    residentLimit: 4,
    limit: 6,
    preludeOngoingLimit: 4,
    preludeObservationLimit: 4,
    preludeEpisodeLimit: 4,
  });

  const checks = {
    warm_written: Boolean(warm?.record?.material_id),
    warm_recalled: String(packet.runtime_prelude || "").includes("Memory chain smoke anchor"),
    ongoing_written: Boolean(ongoing?.record?.track_id),
    ongoing_recalled: String(packet.runtime_prelude || "").includes("Memory chain smoke active thread"),
    observation_written: Boolean(observation?.record?.observation_id),
    episode_written: Boolean(episode?.record?.episode_id) && Boolean(episodeEntry?.entry?.entry_id),
    episode_exported: fs.existsSync(path.join(memory.layout.episodeJournalDir, config.identityUserId, `${runId}-episode`, "episode.md")),
    case_written: Boolean(caseRecord?.record?.case_id) && Boolean(caseEvent?.event?.event_id),
    case_exported: fs.existsSync(memory.caseIndexStore.get(config.identityUserId, `${runId}-case`, {
      realmId: config.identityRealmId,
      agentId: config.identityAgentId,
    })?.markdown_path || ""),
    solitude_written: Boolean(solitude?.record?.solitude_id),
    notebook_written: fs.existsSync(notebook.filePath) && path.resolve(notebook.filePath).startsWith(path.resolve(config.notebookDir)),
    conversation_cache_written: Boolean(writeback?.appended_record?.path) && fs.existsSync(writeback.appended_record.path),
    capture_imported: captureImport?.ok === true
      && captureImport?.stats?.conversation_cache_written === 1
      && captureImport?.stats?.upstream_packages === 1,
    hot_context_recalled: packet?.hot_context_packet?.upstream?.package_count >= 1
      && String(packet.runtime_prelude || "").includes("Window capture smoke"),
    dreaming_queued: dreaming?.queued === true && dreamingQueue.length === 1,
    dreaming_receipt_completed: dreamingCompletion?.ok === true,
    sticker_catalog_ready: Object.keys(stickerIndex).length > 0 && stickerTags.length > 0,
    hot_storage_ready: [
      memory.layout.hotCacheDir,
      memory.layout.hotUpstreamContextDir,
      memory.layout.hotContextBasinDir,
      memory.layout.hotContextProjectionDir,
      memory.layout.hotContextSnapshotDir,
    ].every((dir) => fs.existsSync(dir)),
    metabolism_storage_ready: fs.existsSync(memory.layout.dreamingMutationLogDir),
  };
  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([label]) => label);

  const result = {
    ok: failed.length === 0 && packet?.ok === true,
    summary: {
      runtime: config.runtime,
      state_dir: config.stateDir,
      data_root: config.asherieDataRoot,
      workspace_root: config.workspaceRoot,
      run_id: runId,
      checked_count: Object.keys(checks).length,
      failed_count: failed.length,
      context_packet_ok: packet?.ok === true,
      metabolism_status: "quiet_window_scheduler_and_receipt_gate_ready",
    },
    checks,
    failed,
    policy: "This smoke writes only into the configured isolated state/data/workspace roots. It verifies bridge-owned memory write and recall paths, including local web AI capture import, not live WeChat login or external account sync.",
  };

  printResult(result);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function loadEnv() {
  const stateDir = process.env.MOSSBRIDGE_STATE_DIR || path.join(os.homedir(), ".mossbridge");
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(stateDir, ".env"),
  ];
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      return;
    }
  }
  dotenv.config();
}

function requireExplicitEnv(name, errors) {
  if (!normalizeText(process.env[name])) {
    errors.push(`${name} must be set explicitly for the memory-chain smoke`);
  }
}

function requireSeparatePath(leftName, leftPath, rightName, rightPath, errors) {
  const left = normalizePath(leftPath);
  const right = normalizePath(rightPath);
  if (!left || !right) {
    return;
  }
  if (left === right || isInside(left, right) || isInside(right, left)) {
    errors.push(`${leftName} and ${rightName} must be separate paths for memory-chain smoke tests`);
  }
}

function isInside(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function normalizePath(value) {
  const normalized = normalizeText(value);
  return normalized ? path.resolve(normalized) : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    printResult({
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    });
    process.exitCode = 1;
  });
}

module.exports = { main };
