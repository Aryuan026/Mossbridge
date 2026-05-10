const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  RuntimeCooldownStore,
  parseResetDateTimeText,
  parseResetClockText,
  resolveCapacityResetAtMs,
} = require("../src/core/runtime-cooldown-store");

test("runtime cooldown parses Claude reset clocks in Shanghai time", () => {
  const nowMs = Date.parse("2026-05-08T05:45:00.000Z"); // 13:45 Asia/Shanghai.
  const resetAtMs = resolveCapacityResetAtMs("You've hit your limit · resets 2:50pm (Asia/Shanghai)", {
    nowMs,
    graceMs: 0,
  });

  assert.deepEqual(parseResetClockText("resets 2:50pm (Asia/Shanghai)"), {
    hour: 14,
    minute: 50,
  });
  assert.equal(new Date(resetAtMs).toISOString(), "2026-05-08T06:50:00.000Z");
});

test("runtime cooldown respects explicit Claude weekly reset dates", () => {
  const nowMs = Date.parse("2026-05-10T01:01:01.000Z"); // 09:01 Asia/Shanghai.
  const text = "You've hit your limit · resets May 14 at 12pm (Asia/Shanghai)";
  const resetAtMs = resolveCapacityResetAtMs(text, {
    nowMs,
    graceMs: 0,
  });

  assert.deepEqual(parseResetDateTimeText(text), {
    hasDate: true,
    month: 5,
    day: 14,
    year: undefined,
    hour: 12,
    minute: 0,
  });
  assert.equal(parseResetClockText(text), null);
  assert.equal(new Date(resetAtMs).toISOString(), "2026-05-14T04:00:00.000Z");
});

test("runtime cooldown store persists active cooldowns and expires them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-runtime-cooldown-"));
  const store = new RuntimeCooldownStore({ filePath: path.join(dir, "cooldowns.json") });
  const nowMs = Date.parse("2026-05-08T05:45:00.000Z");

  const recorded = store.setCapacityCooldown({
    runtimeId: "claudecode",
    text: "You've hit your limit · resets 2:50pm (Asia/Shanghai)",
    source: "system",
    threadId: "thread-1",
    nowMs,
  });

  assert.equal(recorded.runtimeId, "claudecode");
  assert.equal(recorded.reason, "runtime_capacity");
  assert.equal(recorded.source, "system");
  assert.ok(store.getActiveCooldown("claudecode", nowMs + 10_000));
  assert.equal(store.getActiveCooldown("claudecode", Date.parse("2026-05-08T07:00:00.000Z")), null);
});
