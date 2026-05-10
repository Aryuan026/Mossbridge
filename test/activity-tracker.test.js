const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getConversationHeat,
  recordAiReply,
  recordUserMessage,
  resetActivityForTests,
} = require("../src/core/activity-tracker");

test("conversation heat becomes hot after dense back-and-forth and cools after quiet time", () => {
  const originalNow = Date.now;
  try {
    let nowMs = Date.parse("2026-05-09T10:00:00.000Z");
    Date.now = () => nowMs;
    resetActivityForTests();

    for (let index = 0; index < 3; index += 1) {
      recordUserMessage();
      nowMs += 60_000;
      recordAiReply();
      nowMs += 60_000;
    }

    const hot = getConversationHeat({
      nowMs,
      windowMs: 20 * 60_000,
      recentWindowMs: 12 * 60_000,
      minEvents: 6,
    });
    assert.equal(hot.hot, true);
    assert.equal(hot.eventCount, 6);
    assert.equal(hot.userEventCount, 3);
    assert.equal(hot.assistantEventCount, 3);

    const cooled = getConversationHeat({
      nowMs: nowMs + 13 * 60_000,
      windowMs: 20 * 60_000,
      recentWindowMs: 12 * 60_000,
      minEvents: 6,
    });
    assert.equal(cooled.hot, false);
  } finally {
    Date.now = originalNow;
    resetActivityForTests();
  }
});
