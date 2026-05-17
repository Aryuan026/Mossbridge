const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { resolveBodyInput } = require("../src/services/text-input");
const { buildTimelineFailureMessage, prepareTimelineInvocation } = require("../src/integrations/timeline");

function createTempFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-command-test-"));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

test("reminder body can be loaded from --text-file", async () => {
  const filePath = createTempFile("reminder.txt", "  remember me  \n");
  const body = await resolveBodyInput({ text: "", textFile: filePath });
  assert.equal(body, "remember me");
});

test("diary body can be loaded from --text-file", async () => {
  const filePath = createTempFile("diary.md", "\nline one\nline two\n");
  const body = await resolveBodyInput({ text: "", textFile: filePath });
  assert.equal(body, "line one\nline two");
});

test("timeline invocation translates --locale and --events-file", () => {
  const filePath = createTempFile("events.json", "[{\"title\":\"ship it\"}]");
  const prepared = prepareTimelineInvocation("write", [
    "--date", "2026-04-11",
    "--locale", "en",
    "--events-file", filePath,
  ]);

  assert.deepEqual(prepared.extraEnv, { TIMELINE_FOR_AGENT_LOCALE: "en" });
  assert.deepEqual(prepared.args, [
    "--date", "2026-04-11",
    "--json", "[{\"title\":\"ship it\"}]",
  ]);
});

test("timeline invocation rejects mixed json sources", () => {
  assert.throws(() => {
    prepareTimelineInvocation("write", ["--json", "[]", "--events-json", "[]"]);
  }, /Use only one of --json, --events-json, or --events-file/);
});

test("timeline failure message explains port conflicts", () => {
  const message = buildTimelineFailureMessage({
    subcommand: "serve",
    code: 1,
    stderr: "Error: listen EADDRINUSE: address already in use 127.0.0.1:4317",
  });
  assert.match(message, /port is already in use/i);
  assert.match(message, /4317/);
});

test("shared refresh resolves binding key from real sessions map shape", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-shared-common-"));
  const stateDir = path.join(tempRoot, "state");
  const accountsDir = path.join(stateDir, "accounts");
  const sessionsFile = path.join(stateDir, "sessions.json");
  const workspaceRoot = path.join(tempRoot, "workspace");
  const bindingKey = "default:account-1:user-1";
  fs.mkdirSync(accountsDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(accountsDir, "account-1.json"), JSON.stringify({
    accountId: "account-1",
    savedAt: "2026-05-16T10:00:00.000Z",
  }), "utf8");
  fs.writeFileSync(sessionsFile, JSON.stringify({
    bindings: {
      [bindingKey]: {
        accountId: "account-1",
        senderId: "user-1",
        activeWorkspaceRoot: workspaceRoot,
        updatedAt: "2026-05-16T10:01:00.000Z",
        threadIdByWorkspaceRootByRuntime: {
          claudecode: {
            [workspaceRoot]: "thread-claude-1",
          },
        },
      },
    },
  }), "utf8");

  const previousEnv = {
    MOSSBRIDGE_RUNTIME: process.env.MOSSBRIDGE_RUNTIME,
    MOSSBRIDGE_STATE_DIR: process.env.MOSSBRIDGE_STATE_DIR,
    MOSSBRIDGE_SESSIONS_FILE: process.env.MOSSBRIDGE_SESSIONS_FILE,
  };
  process.env.MOSSBRIDGE_RUNTIME = "claudecode";
  process.env.MOSSBRIDGE_STATE_DIR = stateDir;
  process.env.MOSSBRIDGE_SESSIONS_FILE = sessionsFile;
  const modulePath = require.resolve("../scripts/shared-common");
  delete require.cache[modulePath];
  try {
    const { resolveBoundThread } = require("../scripts/shared-common");
    const target = resolveBoundThread(workspaceRoot);
    assert.equal(target.bindingKey, bindingKey);
    assert.equal(target.threadId, "thread-claude-1");
    assert.equal(target.workspaceRoot, workspaceRoot);
  } finally {
    delete require.cache[modulePath];
    restoreEnv(previousEnv);
  }
});

function restoreEnv(previousEnv) {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
