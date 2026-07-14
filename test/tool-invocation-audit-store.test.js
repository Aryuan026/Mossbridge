const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ToolInvocationAuditStore } = require("../src/core/tool-invocation-audit-store");

test("tool invocation audit is text-free and stores bounded result counts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-tool-audit-"));
  const store = new ToolInvocationAuditStore({ filePath: path.join(dir, "tool-audit.jsonl") });
  const secretArgument = "private argument should not persist";
  const secretResult = "private result body should not persist";

  try {
    const record = store.append({
      toolName: "mossbridge_sticker_send",
      toolProfile: "foreground",
      context: { runtimeId: "codex", threadId: "thread-1", bindingKey: "binding-1" },
      startedAtMs: 100,
      completedAtMs: 125,
      result: {
        ok: true,
        data: {
          sent_count: 1,
          results: [{ text: secretResult }],
          args: secretArgument,
        },
      },
    });
    const records = store.recent({ threadId: "thread-1", sinceMs: 90 });

    assert.equal(record.kind, "mossbridge_tool_invocation_receipt.v0");
    assert.equal(records.length, 1);
    assert.equal(records[0].tool_name, "mossbridge_sticker_send");
    assert.equal(records[0].result.counts.sent_count, 1);
    assert.equal(records[0].result.item_count, 1);
    assert.equal(records[0].arguments_included, false);
    assert.equal(records[0].result_payload_included, false);
    const serialized = JSON.stringify(records);
    assert.equal(serialized.includes(secretArgument), false);
    assert.equal(serialized.includes(secretResult), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("tool invocation audit records failures without persisting error text", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-tool-audit-failure-"));
  const store = new ToolInvocationAuditStore({ filePath: path.join(dir, "tool-audit.jsonl") });

  try {
    store.append({
      toolName: "mossbridge_memory_warm_write",
      toolProfile: "foreground",
      context: { threadId: "thread-2" },
      startedAtMs: 200,
      completedAtMs: 240,
      error: new Error("private failure body"),
    });
    const records = store.recent({ threadId: "thread-2" });

    assert.equal(records[0].status, "failed");
    assert.equal(records[0].result.error_present, true);
    assert.equal(JSON.stringify(records).includes("private failure body"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
