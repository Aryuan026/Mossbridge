const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SolitudeJournalStore } = require("../src/asherie/solitude-journal-store");

test("solitude journal stores shareable wakeup reflections without raw chain-of-thought", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-solitude-journal-"));
  const store = new SolitudeJournalStore(root, {
    identity: { userId: "owner", realmId: "default", agentId: "aji" },
  });

  const written = store.append("owner", {
    ts_utc: "2026-05-09T12:00:00.000Z",
    entry_type: "experience",
    wake_context: "random_checkin",
    summary: "Silence should still leave a useful backstage handle.",
    reasoning_summary: "A checkin can be productive without interrupting the user.",
    evidence: ["checkin_opportunity"],
    next_actions: ["prefer solitude journal when no user-facing message is useful"],
    tags: ["wakeup", "self-review"],
    confidence: 0.7,
  });

  assert.equal(written.ok, true);
  assert.equal(written.record.entry_type, "experience");
  assert.match(written.record.chain_of_thought_policy, /do not store raw hidden chain-of-thought/i);
  assert.ok(fs.existsSync(path.join(root, "2026-05.jsonl")));

  const found = store.search("owner", { query: "productive interrupting", limit: 5 });
  assert.equal(found.count, 1);
  assert.equal(found.hits[0].solitude_id, written.solitude_id);
  assert.equal(found.hits[0].entry_type, "experience");
});

test("solitude journal builds a backstage digest from recent notes and repeated lessons", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-solitude-digest-"));
  const store = new SolitudeJournalStore(root, {
    identity: { userId: "owner", realmId: "default", agentId: "aji" },
  });

  store.append("owner", {
    ts_utc: "2026-05-09T13:00:00.000Z",
    entry_type: "experience",
    wake_context: "random_checkin",
    summary: "Pre-sleep checkin stayed silent because dreaming was due soon.",
    lesson: "If dreaming is due within an hour, prefer quiet maintenance over interrupting.",
    next_actions: ["wait for dreaming before sending a casual ping"],
    tags: ["pre-sleep", "maintenance"],
    confidence: 0.8,
  });
  store.append("owner", {
    ts_utc: "2026-05-09T14:00:00.000Z",
    entry_type: "experience",
    wake_context: "random_checkin",
    summary: "Another pre-sleep checkin chose timeline maintenance and silence.",
    lesson: "If dreaming is due within an hour, prefer quiet maintenance over interrupting.",
    next_actions: ["wait for dreaming before sending a casual ping"],
    tags: ["pre-sleep", "maintenance"],
    confidence: 0.78,
  });
  store.append("owner", {
    ts_utc: "2026-05-09T15:00:00.000Z",
    entry_type: "capability_request",
    wake_context: "maintenance",
    summary: "Need a clearer health summary before deciding whether to speak.",
    tags: ["maintenance"],
    confidence: 0.7,
  });

  const digest = store.buildDigest("owner", { query: "pre-sleep", recentLimit: 2 });

  assert.equal(digest.ok, true);
  assert.equal(digest.recent_notes.length, 2);
  assert.equal(digest.recurring_patterns.tags[0].value, "maintenance");
  assert.equal(digest.recurring_patterns.lessons[0].count, 2);
  assert.equal(digest.promotion_candidates[0].entry_type, "capability_request");
  assert.match(digest.policy, /not a front-stage voice rule/i);
});
