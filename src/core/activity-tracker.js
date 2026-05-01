const ACTIVE_WINDOW_MS = 5 * 60_000; // 5 minutes

let lastUserMessageAt = 0;
let lastAiReplyAt = 0;

function recordUserMessage() {
  lastUserMessageAt = Date.now();
}

function recordAiReply() {
  lastAiReplyAt = Date.now();
}

function hasRecentActivity(windowMs = ACTIVE_WINDOW_MS) {
  const now = Date.now();
  return (now - lastUserMessageAt < windowMs) || (now - lastAiReplyAt < windowMs);
}

function getLastActivityAt() {
  return Math.max(lastUserMessageAt, lastAiReplyAt);
}

module.exports = { recordUserMessage, recordAiReply, hasRecentActivity, getLastActivityAt, ACTIVE_WINDOW_MS };
