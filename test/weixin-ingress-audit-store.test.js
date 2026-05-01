const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { WeixinIngressAuditStore } = require("../src/core/weixin-ingress-audit-store");

test("WeixinIngressAuditStore persists poll and inbound audit snapshots", () => {
  const filePath = path.join(
    os.tmpdir(),
    `asheriebridge-weixin-audit-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  try {
    const store = new WeixinIngressAuditStore({ filePath });
    store.recordPoll({
      messageCount: 1,
      syncBufferChanged: true,
      messageIds: ["42"],
    });
    store.recordInbound({
      stage: "accepted",
      messageId: "42",
      senderId: "user-1",
      textPreview: "hello".repeat(80),
    });

    const reloaded = new WeixinIngressAuditStore({ filePath });
    const snapshot = reloaded.snapshot();
    assert.equal(snapshot.lastPoll.messageCount, 1);
    assert.equal(snapshot.lastInbound.stage, "accepted");
    assert.equal(snapshot.lastInbound.textPreview.endsWith("..."), true);
    assert.equal(snapshot.recentEvents.length, 2);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test("WeixinIngressAuditStore keeps recent events bounded", () => {
  const filePath = path.join(
    os.tmpdir(),
    `asheriebridge-weixin-audit-bounded-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  try {
    const store = new WeixinIngressAuditStore({ filePath });
    for (let index = 0; index < 105; index += 1) {
      store.recordInbound({
        stage: "filtered",
        messageId: String(index),
      });
    }
    assert.equal(store.snapshot().recentEvents.length, 100);
    assert.equal(store.snapshot().recentEvents[0].messageId, "5");
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});
