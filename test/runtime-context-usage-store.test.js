const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { RuntimeContextUsageStore } = require("../src/core/runtime-context-usage-store");

test("RuntimeContextUsageStore persists context snapshots by thread and runtime", () => {
  const filePath = path.join(
    os.tmpdir(),
    `mossbridge-context-usage-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  try {
    const store = new RuntimeContextUsageStore({ filePath });
    store.recordContext({
      runtimeId: " claudecode ",
      threadId: " thread-1 ",
      workspaceRoot: " /workspace ",
      bindingKey: " binding-1 ",
      currentTokens: 12345,
    });

    const reloaded = new RuntimeContextUsageStore({ filePath });
    assert.equal(reloaded.getContext({ threadId: "thread-1" }).currentTokens, 12345);
    assert.equal(reloaded.getContext({ runtimeId: "claudecode" }).workspaceRoot, "/workspace");
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test("RuntimeContextUsageStore keeps recent auto compact events", () => {
  const filePath = path.join(
    os.tmpdir(),
    `mossbridge-auto-compact-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  try {
    const store = new RuntimeContextUsageStore({ filePath });
    for (let index = 0; index < 55; index += 1) {
      store.recordAutoCompact({
        threadId: `thread-${index}`,
        reason: "context_threshold",
      });
    }

    const snapshot = store.snapshot();
    assert.equal(snapshot.autoCompactEvents.length, 50);
    assert.equal(snapshot.autoCompactEvents[0].threadId, "thread-5");
    assert.equal(snapshot.autoCompactEvents.at(-1).threadId, "thread-54");
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test("RuntimeContextUsageStore does not let zero usage overwrite an exact positive snapshot", () => {
  const filePath = path.join(
    os.tmpdir(),
    `mossbridge-context-usage-zero-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  try {
    const store = new RuntimeContextUsageStore({ filePath });
    store.recordContext({
      runtimeId: "codex",
      threadId: "thread-positive",
      currentTokens: 76_000,
      contextWindow: 100_000,
      source: "codex_session_jsonl",
    });
    store.recordContext({
      runtimeId: "codex",
      threadId: "thread-positive",
      currentTokens: 0,
      contextWindow: 0,
      source: "empty_runtime_event",
    });

    assert.equal(store.getExactContext("thread-positive").currentTokens, 76_000);
    assert.equal(store.getExactContext("thread-positive").source, "codex_session_jsonl");
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});
