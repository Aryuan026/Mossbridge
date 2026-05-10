const ACTIVE_WINDOW_MS = 5 * 60_000; // 5 minutes
const HOT_ACTIVITY_WINDOW_MS = 20 * 60_000;
const HOT_ACTIVITY_RECENT_MS = 12 * 60_000;
const HOT_ACTIVITY_MIN_EVENTS = 6;
const MAX_ACTIVITY_EVENTS = 200;

let lastUserMessageAt = 0;
let lastAiReplyAt = 0;
let recentActivityEvents = [];

function recordUserMessage() {
  const nowMs = Date.now();
  lastUserMessageAt = nowMs;
  recordActivityEvent("user", nowMs);
}

function recordAiReply() {
  const nowMs = Date.now();
  lastAiReplyAt = nowMs;
  recordActivityEvent("assistant", nowMs);
}

function hasRecentActivity(windowMs = ACTIVE_WINDOW_MS) {
  const now = Date.now();
  return (now - lastUserMessageAt < windowMs) || (now - lastAiReplyAt < windowMs);
}

function getLastActivityAt() {
  return Math.max(lastUserMessageAt, lastAiReplyAt);
}

function getConversationHeat({
  nowMs = Date.now(),
  windowMs = HOT_ACTIVITY_WINDOW_MS,
  recentWindowMs = HOT_ACTIVITY_RECENT_MS,
  minEvents = HOT_ACTIVITY_MIN_EVENTS,
} = {}) {
  const normalizedNowMs = Number(nowMs) || Date.now();
  const normalizedWindowMs = Math.max(1, Number(windowMs) || HOT_ACTIVITY_WINDOW_MS);
  const normalizedRecentWindowMs = Math.max(1, Number(recentWindowMs) || HOT_ACTIVITY_RECENT_MS);
  const normalizedMinEvents = Math.max(1, Number(minEvents) || HOT_ACTIVITY_MIN_EVENTS);
  pruneActivityEvents(normalizedNowMs, normalizedWindowMs);
  const events = recentActivityEvents.filter((event) => normalizedNowMs - event.at <= normalizedWindowMs);
  const lastActivityAt = getLastActivityAt();
  const ageMs = lastActivityAt ? normalizedNowMs - lastActivityAt : Infinity;
  const userEvents = events.filter((event) => event.role === "user").length;
  const assistantEvents = events.filter((event) => event.role === "assistant").length;
  return {
    hot: events.length >= normalizedMinEvents && ageMs <= normalizedRecentWindowMs,
    eventCount: events.length,
    userEventCount: userEvents,
    assistantEventCount: assistantEvents,
    lastActivityAt,
    ageMs,
    windowMs: normalizedWindowMs,
    recentWindowMs: normalizedRecentWindowMs,
    minEvents: normalizedMinEvents,
  };
}

function hasHotConversation(options = {}) {
  return getConversationHeat(options).hot;
}

function recordActivityEvent(role, nowMs = Date.now()) {
  const at = Number(nowMs) || Date.now();
  recentActivityEvents.push({ role, at });
  pruneActivityEvents(at, HOT_ACTIVITY_WINDOW_MS * 2);
}

function pruneActivityEvents(nowMs = Date.now(), windowMs = HOT_ACTIVITY_WINDOW_MS * 2) {
  const cutoff = (Number(nowMs) || Date.now()) - Math.max(1, Number(windowMs) || HOT_ACTIVITY_WINDOW_MS);
  recentActivityEvents = recentActivityEvents
    .filter((event) => event && Number(event.at) >= cutoff)
    .slice(-MAX_ACTIVITY_EVENTS);
}

function resetActivityForTests() {
  lastUserMessageAt = 0;
  lastAiReplyAt = 0;
  recentActivityEvents = [];
}

module.exports = {
  ACTIVE_WINDOW_MS,
  HOT_ACTIVITY_MIN_EVENTS,
  HOT_ACTIVITY_RECENT_MS,
  HOT_ACTIVITY_WINDOW_MS,
  getConversationHeat,
  getLastActivityAt,
  hasHotConversation,
  hasRecentActivity,
  recordAiReply,
  recordUserMessage,
  resetActivityForTests,
};
