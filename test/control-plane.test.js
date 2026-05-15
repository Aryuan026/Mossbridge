const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  CONTROL_LAYER,
  CONTROL_SCOPE,
  CONTROL_SEVERITY,
  ControlLedgerStore,
  createControlPlane,
  sanitizePayload,
} = require("../src/control/control-plane");

test("control ledger persists normalized bridge events without leaking tokens", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-control-"));
  const filePath = path.join(dir, "control-events.jsonl");
  const plane = createControlPlane({
    controlLedgerFile: filePath,
    runtime: "codex",
  });

  const event = plane.record({
    type: "Runtime Turn Dispatch Requested",
    layer: CONTROL_LAYER.EXECUTIVE,
    scope: CONTROL_SCOPE.RUNTIME,
    source: "test",
    subject: "thread-1",
    reason: "wechat_inbound",
    payload: {
      contextToken: "secret-token",
      workspaceRoot: "/tmp/workspace",
      nested: {
        authorization: "Bearer secret",
        ok: true,
      },
    },
  });

  assert.equal(event.type, "runtime_turn_dispatch_requested");
  assert.equal(event.scope, CONTROL_SCOPE.RUNTIME);
  assert.equal(event.layer, CONTROL_LAYER.EXECUTIVE);
  assert.equal(event.runtimeId, "codex");

  const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/u);
  assert.equal(lines.length, 1);
  const persisted = JSON.parse(lines[0]);
  assert.equal(persisted.payload.contextToken, "[redacted]");
  assert.equal(persisted.payload.nested.authorization, "[redacted]");
  assert.equal(persisted.payload.workspaceRoot, "/tmp/workspace");
});

test("control ledger can filter and summarize recent events", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-control-"));
  const store = new ControlLedgerStore({
    filePath: path.join(dir, "control-events.jsonl"),
    maxEvents: 3,
  });

  store.append({
    type: "memory.context.delivered",
    layer: CONTROL_LAYER.TACTICAL,
    scope: CONTROL_SCOPE.MEMORY,
    severity: CONTROL_SEVERITY.INFO,
  });
  store.append({
    type: "runtime.cooldown.entered",
    layer: CONTROL_LAYER.TACTICAL,
    scope: CONTROL_SCOPE.RUNTIME,
    severity: CONTROL_SEVERITY.WARN,
  });

  assert.equal(store.list({ scope: CONTROL_SCOPE.MEMORY }).length, 1);
  const summary = store.summarize();
  assert.equal(summary.sampleSize, 2);
  assert.equal(summary.byScope.memory, 1);
  assert.equal(summary.byScope.runtime, 1);
  assert.equal(summary.bySeverity.warn, 1);
});

test("control payload sanitizer trims noisy operational payloads", () => {
  const sanitized = sanitizePayload({
    veryLong: "x".repeat(800),
    password: "secret",
    list: Array.from({ length: 40 }, (_, index) => index),
  });

  assert.equal(sanitized.password, "[redacted]");
  assert.equal(sanitized.veryLong.length, 600);
  assert.equal(sanitized.list.length, 24);
});
