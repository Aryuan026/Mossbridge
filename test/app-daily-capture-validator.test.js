const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  validateDailyCaptureBundle,
  validateDailyCaptureDirectory,
  validateDailyCaptureTarget,
} = require("../src/importers/app-daily-capture");

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

test("rejects invalid role and missing text or attachments", () => {
  const bundle = validBundle();
  bundle.conversations[0].messages[0].role = "external_executor";
  bundle.conversations[0].messages[0].text = "";

  const result = validateDailyCaptureBundle(bundle);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /role must be one of/);
  assert.match(result.errors.join("\n"), /text or attachments/);
});
