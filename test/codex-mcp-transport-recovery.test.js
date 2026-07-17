const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createCodexMcpTransportRecoveryRequester,
  isCodexMcpTransportFailureText,
} = require("../src/core/codex-mcp-transport-recovery");

test("Codex MCP transport failure matcher stays narrow", () => {
  assert.equal(isCodexMcpTransportFailureText("Transport closed"), true);
  assert.equal(isCodexMcpTransportFailureText("tool call failed for mcp: broken pipe"), true);
  assert.equal(isCodexMcpTransportFailureText("我在代码审查里看到了 Transport closed。"), false);
});

test("Codex MCP transport recovery request is text-free and forbids action replay", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-mcp-recovery-"));
  const filePath = path.join(tempRoot, "recovery.json");
  const request = createCodexMcpTransportRecoveryRequester({
    filePath,
    now: () => new Date("2026-07-17T03:00:00.000Z"),
  });

  const result = request({
    userText: "private text",
    arguments: { action: "send_sticker" },
  });
  const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));

  assert.deepEqual(result, {
    requested: true,
    reason: "transport_closed_before_toolhost",
  });
  assert.equal(stored.action_replay_allowed, false);
  assert.equal(stored.tool_outcome_reached, false);
  assert.equal(stored.request_contains_tool_arguments, false);
  assert.equal(stored.request_contains_user_text, false);
  assert.equal(JSON.stringify(stored).includes("private text"), false);
  assert.equal(JSON.stringify(stored).includes("send_sticker"), false);
});
