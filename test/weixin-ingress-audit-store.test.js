const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { WeixinIngressAuditStore } = require("../src/core/weixin-ingress-audit-store");

test("WeixinIngressAuditStore persists poll and inbound audit snapshots", () => {
  const filePath = path.join(
    os.tmpdir(),
    `mossbridge-weixin-audit-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
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

test("WeixinIngressAuditStore persists poll failure snapshots", () => {
  const filePath = path.join(
    os.tmpdir(),
    `mossbridge-weixin-audit-failure-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  try {
    const store = new WeixinIngressAuditStore({ filePath });
    store.recordPollFailure({
      error: "fetch failed".repeat(40),
      name: "TypeError",
      causeCode: "UND_ERR_CONNECT_TIMEOUT",
      apiLabel: "getUpdates",
      apiEndpoint: "ilink/bot/getupdates",
      consecutiveFailures: 3,
    });

    const snapshot = new WeixinIngressAuditStore({ filePath }).snapshot();
    assert.equal(snapshot.lastPollFailure.kind, "poll_failure");
    assert.equal(snapshot.lastPollFailure.name, "TypeError");
    assert.equal(snapshot.lastPollFailure.causeCode, "UND_ERR_CONNECT_TIMEOUT");
    assert.equal(snapshot.lastPollFailure.apiLabel, "getUpdates");
    assert.equal(snapshot.lastPollFailure.apiEndpoint, "ilink/bot/getupdates");
    assert.equal(snapshot.lastPollFailure.consecutiveFailures, 3);
    assert.equal(snapshot.lastPollFailure.error.endsWith("..."), true);
    assert.equal(snapshot.recentEvents.length, 1);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test("WeixinIngressAuditStore persists poll recovery snapshots", () => {
  const filePath = path.join(
    os.tmpdir(),
    `mossbridge-weixin-audit-recovery-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  try {
    const store = new WeixinIngressAuditStore({ filePath });
    store.recordPollRecovery({
      consecutiveFailures: 4,
      outageDurationMs: 125000,
    });

    const snapshot = new WeixinIngressAuditStore({ filePath }).snapshot();
    assert.equal(snapshot.lastPollRecovery.kind, "poll_recovery");
    assert.equal(snapshot.lastPollRecovery.consecutiveFailures, 4);
    assert.equal(snapshot.lastPollRecovery.outageDurationMs, 125000);
    assert.equal(snapshot.recentEvents.length, 1);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test("WeixinIngressAuditStore persists outbound delivery snapshots", () => {
  const filePath = path.join(
    os.tmpdir(),
    `mossbridge-weixin-audit-outbound-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  try {
    const store = new WeixinIngressAuditStore({ filePath });
    store.recordOutbound({
      threadId: "thread-1",
      turnId: "turn-1",
      userId: "user-1",
      kind: "plain_reply",
      status: "sent",
      attempt: "initial",
      contextTokenPresent: true,
      textPreview: "reply".repeat(80),
      error: "fetch failed",
      errorName: "TypeError",
      causeName: "ConnectTimeoutError",
      causeCode: "UND_ERR_CONNECT_TIMEOUT",
      apiLabel: "sendMessage",
      apiEndpoint: "ilink/bot/sendmessage",
      apiTimeoutMs: 15000,
      deferReason: "context_token_rejected",
      immediateSent: false,
      deferred: true,
      prefixDelivered: false,
      contextTokenAgeMs: 12345,
    });

    const snapshot = new WeixinIngressAuditStore({ filePath }).snapshot();
    assert.equal(snapshot.lastOutbound.kind, "outbound");
    assert.equal(snapshot.lastOutbound.status, "sent");
    assert.equal(snapshot.lastOutbound.attempt, "initial");
    assert.equal(snapshot.lastOutbound.contextTokenPresent, true);
    assert.equal(snapshot.lastOutbound.textPreview.endsWith("..."), true);
    assert.equal(snapshot.lastOutbound.error, "fetch failed");
    assert.equal(snapshot.lastOutbound.errorName, "TypeError");
    assert.equal(snapshot.lastOutbound.causeName, "ConnectTimeoutError");
    assert.equal(snapshot.lastOutbound.causeCode, "UND_ERR_CONNECT_TIMEOUT");
    assert.equal(snapshot.lastOutbound.apiLabel, "sendMessage");
    assert.equal(snapshot.lastOutbound.apiEndpoint, "ilink/bot/sendmessage");
    assert.equal(snapshot.lastOutbound.apiTimeoutMs, 15000);
    assert.equal(snapshot.lastOutbound.contextTokenAgeMs, 12345);
    assert.equal(snapshot.lastOutbound.deferReason, "context_token_rejected");
    assert.equal(snapshot.lastOutbound.deferred, true);
    assert.equal(snapshot.lastOutbound.prefixDelivered, false);
    assert.equal(snapshot.recentEvents.length, 1);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test("WeixinIngressAuditStore persists attachment intake snapshots", () => {
  const filePath = path.join(
    os.tmpdir(),
    `mossbridge-weixin-audit-attachment-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  try {
    const store = new WeixinIngressAuditStore({ filePath });
    store.recordAttachmentIntake({
      messageId: "42",
      senderId: "user-1",
      savedCount: 1,
      failedCount: 1,
      imageCount: 1,
      fileCount: 0,
      savedFiles: ["wechat/inbox/2026-05-17/photo.jpg"],
      failedReasons: ["file: attachment download timed out after 30000ms"],
      savedDiagnostics: [{
        kind: "image",
        declaredSizeBytes: 12345,
        downloadedSizeBytes: 12000,
        contentType: "image/jpeg",
        directUrlCount: 0,
        hasEncryptedQueryParam: true,
        candidateCount: 2,
        referenceTypes: ["encrypted_query_param", "filekey"],
      }],
      failedDiagnostics: [{
        kind: "image",
        declaredSizeBytes: 45678,
        directUrlCount: 0,
        hasEncryptedQueryParam: true,
        hasFileKey: true,
        candidateCount: 2,
        errorCode: "ATTACHMENT_DOWNLOAD_TIMEOUT",
        errorStatus: 408,
        downloadStage: "response_body",
      }],
    });

    const snapshot = new WeixinIngressAuditStore({ filePath }).snapshot();
    assert.equal(snapshot.lastAttachmentIntake.kind, "attachment_intake");
    assert.equal(snapshot.lastAttachmentIntake.savedCount, 1);
    assert.equal(snapshot.lastAttachmentIntake.failedCount, 1);
    assert.deepEqual(snapshot.lastAttachmentIntake.savedFiles, ["wechat/inbox/2026-05-17/photo.jpg"]);
    assert.match(snapshot.lastAttachmentIntake.failedReasons[0], /timed out/);
    assert.equal(snapshot.lastAttachmentIntake.savedDiagnostics[0].declaredSizeBytes, 12345);
    assert.equal(snapshot.lastAttachmentIntake.failedDiagnostics[0].errorCode, "ATTACHMENT_DOWNLOAD_TIMEOUT");
    assert.equal(snapshot.lastAttachmentIntake.failedDiagnostics[0].downloadStage, "response_body");
    assert.deepEqual(snapshot.lastAttachmentIntake.savedDiagnostics[0].referenceTypes, ["encrypted_query_param", "filekey"]);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test("WeixinIngressAuditStore keeps recent events bounded", () => {
  const filePath = path.join(
    os.tmpdir(),
    `mossbridge-weixin-audit-bounded-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
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
