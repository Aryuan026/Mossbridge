const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { CaseIndexStore } = require("../src/asherie/case-index-store");

test("case index store writes work provenance without requiring runtime injection", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-case-index-"));
  const store = new CaseIndexStore(root);

  const created = store.upsert("owner", {
    case_id: "bridge-proactive-memory-2026-05-06",
    realm_id: "default",
    agent_id: "moss",
    title: "Bridge proactive memory repair",
    kind: "system_architecture",
    summary: "Make random checkins recall recent conversation tail before long-term memory.",
    user_goal: "Avoid wrong proactive topics in WeChat.",
    related_cold_refs: ["cold:project/proactive-memory"],
    changed_files: ["src/services/asherie-memory-service.js"],
    tests: [{ command: "node --test test/asherie-memory-service.test.js", status: "planned" }],
    decisions: [{ summary: "Keep case index quiet unless explicitly searched." }],
  });

  assert.equal(created.case_id, "bridge-proactive-memory-2026-05-06");
  assert.equal(created.event_count, 0);
  assert.equal(created.case_folders.original_request, "01_original_request");
  assert.equal(created.case_folders.working_versions, "02_working_versions");
  assert.equal(created.case_folders.user_approved_final, "03_user_approved_final");
  assert.equal(created.cleanup_policy.ai_may_delete_working_versions, false);
  assert.deepEqual(created.related_cold_refs, ["cold:project/proactive-memory"]);
  assert.ok(fs.existsSync(created.case_workspace.original_request_dir));
  assert.ok(fs.existsSync(created.case_workspace.working_versions_dir));
  assert.ok(fs.existsSync(created.case_workspace.user_approved_final_dir));
  assert.ok(fs.existsSync(created.markdown_path));
  const storedCase = JSON.parse(fs.readFileSync(path.join(created.case_dir, "case.json"), "utf8"));
  assert.equal(storedCase.case_folders.root, ".");
  assert.equal(JSON.stringify(storedCase.case_folders).includes(root), false);

  const event = store.appendEvent("owner", created.case_id, {
    realm_id: "default",
    agent_id: "moss",
    event_type: "test",
    summary: "Focused memory tests passed.",
    tests: [{ command: "node --test test/asherie-memory-service.test.js", status: "passed" }],
    source_refs: ["conversation_cache:owner__20260504_20260513"],
  });
  assert.equal(event.event_type, "test");

  const artifact = store.linkArtifact("owner", created.case_id, {
    realm_id: "default",
    agent_id: "moss",
    title: "case markdown",
    path: created.markdown_path,
    status: "user_approved_final",
    final_artifact_id: "final-001",
    storage_id: "CASE-20260509-001",
    checksum: "sha256:abc",
    size_bytes: 128,
  });
  assert.equal(artifact.ok, true);
  assert.equal(artifact.artifact.status, "user_approved_final");
  assert.equal(artifact.artifact.final_artifact_id, "final-001");
  assert.equal(artifact.artifact.storage_id, "CASE-20260509-001");
  assert.equal(artifact.artifact.size_bytes, 128);

  const searched = store.list("owner", { query: "proactive memory", limit: 5 });
  assert.equal(searched.length, 1);
  assert.equal(searched[0].case_id, created.case_id);
  assert.equal(searched[0].event_count, 2);
  assert.ok(searched[0].artifacts.some((item) => item.title === "case markdown"));
  assert.ok(store.list("owner", { query: "CASE-20260509-001", limit: 5 }).some((item) => item.case_id === created.case_id));

  const read = store.get("owner", created.case_id, {
    realmId: "default",
    agentId: "moss",
    includeEvents: true,
  });
  assert.equal(read.events.length, 2);

  const exported = store.exportMarkdown("owner", created.case_id, {
    realmId: "default",
    agentId: "moss",
  });
  assert.equal(exported.ok, true);
  const markdown = fs.readFileSync(exported.path, "utf8");
  assert.match(markdown, /Bridge proactive memory repair/);
  assert.match(markdown, /02_working_versions/);
  assert.match(markdown, /user_approved_final/);
  assert.match(markdown, /CASE-20260509-001/);
});
