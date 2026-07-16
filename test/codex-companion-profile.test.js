const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createCodexRuntimeAdapter } = require("../src/adapters/runtime/codex");
const { prepareCodexCompanionProfile } = require("../src/adapters/runtime/codex/companion-profile");
const { CodexRpcClient } = require("../src/adapters/runtime/codex/rpc-client");

const TEMPLATE_FILE = path.resolve(__dirname, "..", "templates", "codex-companion-base.md");

test("codex companion profile is text-free by default", () => {
  const profile = prepareCodexCompanionProfile({ enabled: false, instructionsFile: TEMPLATE_FILE });

  assert.equal(profile.requested, false);
  assert.equal(profile.applied, false);
  assert.equal(profile.diagnostics.delivery_mode, "disabled");
  assert.equal(profile.diagnostics.delivery_verified, false);
  assert.equal(profile.diagnostics.base_instructions_chars, 0);
  assert.doesNotMatch(JSON.stringify(profile.diagnostics), /conversation companion runtime/i);
});

test("codex companion profile reads neutral base instructions without exposing prompt body in diagnostics", () => {
  const profile = prepareCodexCompanionProfile({ enabled: true, instructionsFile: TEMPLATE_FILE });
  const diagnosticsText = JSON.stringify(profile.diagnostics);

  assert.equal(profile.applied, true);
  assert.match(profile.baseInstructions, /conversation companion runtime/i);
  assert.equal(profile.personality, "none");
  assert.equal(profile.diagnostics.delivery_mode, "thread_start_resume");
  assert.equal(profile.diagnostics.thread_instruction_override, true);
  assert.equal(profile.diagnostics.runtime_isolation_applied, false);
  assert.equal(profile.diagnostics.local_runtime_isolation_status, "hold_lane_safety");
  assert.equal(profile.diagnostics.base_instructions_sha256.length, 64);
  assert.equal(profile.diagnostics.base_instructions_chars, profile.baseInstructions.length);
  assert.doesNotMatch(diagnosticsText, /conversation companion runtime/i);
  assert.doesNotMatch(diagnosticsText, /baseInstructions/i);
});

test("codex companion thread overrides apply only to foreground start and resume", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-companion-"));
  const calls = [];
  const restore = stubCodexClient(calls);
  try {
    const adapter = createCodexRuntimeAdapter(buildConfig(tmp, { codexCompanionProfile: true }));

    await adapter.sendTurn({
      bindingKey: "fg",
      workspaceRoot: path.join(tmp, "foreground"),
      text: "hello",
    });
    await adapter.sendTurn({
      bindingKey: "fg",
      workspaceRoot: path.join(tmp, "foreground"),
      text: "again",
    });
    await adapter.sendTurn({
      bindingKey: "task",
      workspaceRoot: path.join(tmp, "task"),
      text: "work",
      metadata: { toolProfile: "task" },
    });
    await adapter.sendTurn({
      bindingKey: "full",
      workspaceRoot: path.join(tmp, "full"),
      text: "tool work",
      metadata: { toolProfile: "full" },
    });
    await adapter.sendTurn({
      bindingKey: "lite",
      workspaceRoot: path.join(tmp, "checkin-lite"),
      text: "light checkin",
      metadata: { systemToolProfile: "checkin_lite" },
    });

    const foregroundStart = calls.find((call) => call.profile === "foreground" && call.method === "thread/start");
    const foregroundResume = calls.find((call) => call.profile === "foreground" && call.method === "thread/resume");
    const taskStart = calls.find((call) => call.profile === "task" && call.method === "thread/start");
    const fullStart = calls.find((call) => call.profile === "full" && call.method === "thread/start");
    const checkinLiteStart = calls.find((call) => call.profile === "checkin_lite" && call.method === "thread/start");

    assert.ok(foregroundStart);
    assert.ok(foregroundResume);
    assert.ok(taskStart);
    assert.ok(fullStart);
    assert.ok(checkinLiteStart);
    assert.match(foregroundStart.params.baseInstructions, /conversation companion runtime/i);
    assert.equal(foregroundStart.params.personality, "none");
    assert.match(foregroundResume.params.baseInstructions, /conversation companion runtime/i);
    assert.equal(foregroundResume.params.personality, "none");
    assert.equal(taskStart.params.baseInstructions, undefined);
    assert.equal(taskStart.params.personality, undefined);
    assert.equal(fullStart.params.baseInstructions, undefined);
    assert.equal(fullStart.params.personality, undefined);
    assert.equal(checkinLiteStart.params.baseInstructions, undefined);
    assert.equal(checkinLiteStart.params.personality, undefined);
    assert.equal(adapter.describe().companionProfile.delivery_verified, true);
    assert.doesNotMatch(JSON.stringify(adapter.describe().companionProfile), /conversation companion runtime/i);
    await adapter.close();
  } finally {
    restore();
  }
});

test("disabled codex companion profile leaves thread parameters unchanged", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-companion-off-"));
  const calls = [];
  const restore = stubCodexClient(calls);
  try {
    const adapter = createCodexRuntimeAdapter(buildConfig(tmp, { codexCompanionProfile: false }));

    await adapter.sendTurn({
      bindingKey: "fg",
      workspaceRoot: path.join(tmp, "foreground"),
      text: "hello",
    });

    const foregroundStart = calls.find((call) => call.profile === "foreground" && call.method === "thread/start");
    assert.ok(foregroundStart);
    assert.equal(foregroundStart.params.baseInstructions, undefined);
    assert.equal(foregroundStart.params.personality, undefined);
    assert.equal(adapter.describe().companionProfile.requested, false);
    assert.equal(adapter.describe().companionProfile.applied, false);
    await adapter.close();
  } finally {
    restore();
  }
});

test("failed companion resume rpc is not marked delivery verified", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-companion-fail-"));
  const calls = [];
  const restore = stubCodexClient(calls, {
    resumeThread() {
      throw new Error("resume failed");
    },
  });
  try {
    const adapter = createCodexRuntimeAdapter(buildConfig(tmp, { codexCompanionProfile: true }));

    await assert.rejects(
      adapter.resumeThread({ threadId: "thread-1" }),
      /resume failed/,
    );

    const resumeCall = calls.find((call) => call.method === "thread/resume");
    assert.ok(resumeCall);
    assert.match(resumeCall.params.baseInstructions, /conversation companion runtime/i);
    assert.equal(adapter.describe().companionProfile.delivery_verified, false);
    await adapter.close();
  } finally {
    restore();
  }
});

function buildConfig(tmp, overrides = {}) {
  return {
    stateDir: path.join(tmp, "state"),
    sessionsFile: path.join(tmp, "state", "sessions.json"),
    codexEndpoint: "ws://127.0.0.1:65535",
    codexCommand: "codex",
    codexHome: path.join(tmp, "codex-home"),
    codexModel: "",
    codexModelProvider: "",
    codexNativeImageInput: null,
    codexCompanionProfile: false,
    codexCompanionInstructionsFile: TEMPLATE_FILE,
    ...overrides,
  };
}

function stubCodexClient(calls, overrides = {}) {
  const originals = {
    connect: CodexRpcClient.prototype.connect,
    initialize: CodexRpcClient.prototype.initialize,
    listModels: CodexRpcClient.prototype.listModels,
    startThread: CodexRpcClient.prototype.startThread,
    resumeThread: CodexRpcClient.prototype.resumeThread,
    sendUserMessage: CodexRpcClient.prototype.sendUserMessage,
    close: CodexRpcClient.prototype.close,
  };

  CodexRpcClient.prototype.connect = async function connect() {};
  CodexRpcClient.prototype.initialize = async function initialize() {
    this.isReady = true;
  };
  CodexRpcClient.prototype.listModels = async function listModels() {
    return { result: { data: [] } };
  };
  CodexRpcClient.prototype.startThread = async function startThread(params = {}) {
    calls.push({ profile: this.__mossbridgeToolProfile, method: "thread/start", params });
    const id = `thread-${this.__mossbridgeToolProfile}-${calls.length}`;
    return { result: { thread: { id } } };
  };
  CodexRpcClient.prototype.resumeThread = async function resumeThread(params = {}) {
    calls.push({ profile: this.__mossbridgeToolProfile, method: "thread/resume", params });
    if (typeof overrides.resumeThread === "function") {
      return overrides.resumeThread.call(this, params);
    }
    return { result: { thread: { id: params.threadId } } };
  };
  CodexRpcClient.prototype.sendUserMessage = async function sendUserMessage(params = {}) {
    calls.push({ profile: this.__mossbridgeToolProfile, method: "turn/start", params });
    return { result: { turn: { id: `turn-${calls.length}` } } };
  };
  CodexRpcClient.prototype.close = async function close() {
    this.isReady = false;
  };

  return () => {
    for (const [name, value] of Object.entries(originals)) {
      CodexRpcClient.prototype[name] = value;
    }
  };
}
