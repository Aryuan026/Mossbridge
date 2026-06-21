const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  importDailyCaptureTarget,
  stageDailyCaptureTarget,
  validateDailyCaptureBundle,
  validateDailyCaptureDirectory,
  validateDailyCaptureTarget,
} = require("../src/importers/app-daily-capture");
const { AsherieMemoryService } = require("../src/services/asherie-memory-service");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-capture-test-"));
}

function validBundle() {
  return {
    schema: "mossbridge_app_daily_capture_bundle_v0.1",
    source_client: "chatgpt_web",
    captured_date: "2026-05-10",
    captured_at: "2026-05-10T15:30:00.000Z",
    timezone: "Asia/Shanghai",
    conversations: [
      {
        conversation_id: "thread-1",
        conversation_title: "daily note",
        source_url: "https://chatgpt.com/c/thread-1",
        messages: [
          {
            message_id: "msg-1",
            role: "user",
            text: "hello",
            created_at: "2026-05-10T08:30:00.000Z",
            local_date: "2026-05-10",
            attachments: [],
          },
          {
            message_id: "msg-2",
            role: "assistant",
            text: "hi",
            created_at: "2026-05-10T08:30:05.000Z",
            local_date: "2026-05-10",
            attachments: [],
          },
        ],
      },
    ],
  };
}

test("validates single-file app daily capture bundle", () => {
  const result = validateDailyCaptureBundle(validBundle());

  assert.equal(result.ok, true);
  assert.equal(result.summary.shape, "bundle");
  assert.equal(result.summary.source_client, "chatgpt_web");
  assert.equal(result.summary.conversation_count, 1);
  assert.equal(result.summary.message_count, 2);
});

test("validates staged app daily capture directory", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({
    schema: "mossbridge_app_daily_capture_v0.1",
    source_client: "chatgpt_web",
    captured_date: "2026-05-10",
    captured_at: "2026-05-10T15:30:00.000Z",
    conversation_count: 1,
    message_count: 1,
  }), "utf8");
  fs.writeFileSync(path.join(dir, "conversations.jsonl"), `${JSON.stringify({
    source_client: "chatgpt_web",
    conversation_id: "thread-1",
    message_id: "msg-1",
    role: "user",
    text: "hello",
    created_at: "2026-05-10T08:30:00.000Z",
    local_date: "2026-05-10",
    attachments: [],
  })}\n`, "utf8");

  const result = validateDailyCaptureDirectory(dir);

  assert.equal(result.ok, true);
  assert.equal(result.summary.shape, "staged_directory");
  assert.equal(result.summary.conversation_count, 1);
  assert.equal(result.summary.message_count, 1);
});

test("validateDailyCaptureTarget accepts bundle file", () => {
  const dir = tempDir();
  const filePath = path.join(dir, "capture.json");
  fs.writeFileSync(filePath, JSON.stringify(validBundle()), "utf8");

  const result = validateDailyCaptureTarget(filePath);

  assert.equal(result.ok, true);
  assert.equal(result.summary.shape, "bundle");
});

test("stages source-neutral web AI capture bundle", () => {
  const dir = tempDir();
  const filePath = path.join(dir, "capture.json");
  const captureRoot = path.join(dir, "data", "cache", "app_daily_captures");
  const bundle = validBundle();
  bundle.source_client = "claude_web";
  bundle.conversations[0].source_url = "https://claude.ai/chat/thread-1";
  fs.writeFileSync(filePath, JSON.stringify(bundle), "utf8");

  const result = stageDailyCaptureTarget(filePath, { appDailyCaptureDir: captureRoot });

  assert.equal(result.ok, true);
  assert.equal(result.staged, true);
  assert.equal(result.wrote, true);
  assert.equal(result.summary.shape, "staged_directory");
  assert.equal(result.summary.source_client, "claude_web");
  assert.equal(fs.existsSync(path.join(result.staged_dir, "manifest.json")), true);
  assert.equal(fs.existsSync(path.join(result.staged_dir, "conversations.jsonl")), true);
});

test("imports source-neutral web AI capture into conversation cache and hot context", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "capture.json");
  const bundle = validBundle();
  bundle.source_client = "perplexity_web";
  bundle.conversations[0].conversation_title = "deployment thread";
  bundle.conversations[0].source_url = "https://www.perplexity.ai/search/thread-1";
  bundle.conversations[0].messages[0].text = "继续整理 Mossbridge deployment checklist";
  bundle.conversations[0].messages[1].text = "先检查 isolated state/data，再跑 capture import。";
  fs.writeFileSync(filePath, JSON.stringify(bundle), "utf8");
  const service = new AsherieMemoryService({
    config: {
      stateDir: path.join(dir, "state"),
      asherieDataRoot: path.join(dir, "data"),
      runtime: "codex",
      identityUserId: "owner",
      identityRealmId: "default",
      identityAgentId: "moss",
    },
  });

  const result = await importDailyCaptureTarget(filePath, { memoryService: service });

  assert.equal(result.ok, true);
  assert.equal(result.imported, true);
  assert.equal(result.stats.conversation_cache_written, 1);
  assert.equal(result.stats.hot_turns_written, 2);
  assert.equal(result.stats.upstream_packages, 1);

  const packet = await service.captureContextPacket({
    query: "deployment checklist",
    include_runtime_prelude_guidance: false,
  });

  assert.equal(packet.hot_context_packet.upstream.package_count, 1);
  assert.match(packet.runtime_prelude, /hot-source/);
  assert.match(packet.runtime_prelude, /perplexity_web/);
  assert.match(packet.runtime_prelude, /deployment checklist/);

  const second = await importDailyCaptureTarget(filePath, { memoryService: service });

  assert.equal(second.ok, true);
  assert.equal(second.stats.conversation_cache_written, 0);
  assert.equal(second.stats.conversation_cache_skipped, 1);
});

test("capture import reports source-event write failures as warnings", async () => {
  const dir = tempDir();
  const filePath = path.join(dir, "capture.json");
  fs.writeFileSync(filePath, JSON.stringify(validBundle()), "utf8");
  const service = new AsherieMemoryService({
    config: {
      stateDir: path.join(dir, "state"),
      asherieDataRoot: path.join(dir, "data"),
      runtime: "codex",
      identityUserId: "owner",
      identityRealmId: "default",
      identityAgentId: "moss",
    },
  });

  const result = await importDailyCaptureTarget(filePath, {
    memoryService: service,
    memoryMetabolism: {
      recordSourceEvent() {
        throw new Error("ledger disk unavailable");
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.stats.source_events_failed > 0, true);
  assert.match(result.warnings.join("\n"), /ledger disk unavailable/);
});

test("rejects invalid role and missing text or attachments", () => {
  const bundle = validBundle();
  bundle.conversations[0].messages[0].role = "external_executor";
  bundle.conversations[0].messages[0].text = "";

  const result = validateDailyCaptureBundle(bundle);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /role must be one of/);
  assert.match(result.errors.join("\n"), /text or attachments/);
});
