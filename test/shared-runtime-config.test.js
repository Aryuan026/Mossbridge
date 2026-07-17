const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SHARED_COMMON_PATH = path.resolve(__dirname, "../scripts/shared-common.js");

function loadSharedCommonWithEnv(env = {}) {
  const previous = new Map([
    "MOSSBRIDGE_ENV_FILE",
    "MOSSBRIDGE_SHARED_PORT",
    "MOSSBRIDGE_STATE_DIR",
    "MOSSBRIDGE_SESSIONS_FILE",
  ].map((key) => [key, process.env[key]]));
  delete require.cache[SHARED_COMMON_PATH];
  for (const key of previous.keys()) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  try {
    return require(SHARED_COMMON_PATH);
  } finally {
    delete require.cache[SHARED_COMMON_PATH];
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("shared runtime config derives Codex endpoint from the explicit shared port", () => {
  const shared = loadSharedCommonWithEnv({
    MOSSBRIDGE_SHARED_PORT: "9876",
    MOSSBRIDGE_STATE_DIR: "/tmp/mossbridge-shared-config-test",
  });

  assert.equal(shared.port, "9876");
  assert.equal(shared.listenUrl, "ws://127.0.0.1:9876");
});

test("shared runtime config loads custom env file before deriving state and ports", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-shared-env-file-"));
  const envFile = path.join(tempRoot, "custom.env");
  const stateDir = path.join(tempRoot, "state-from-env-file");
  const sessionsFile = path.join(tempRoot, "custom-sessions.json");
  fs.writeFileSync(envFile, [
    `MOSSBRIDGE_STATE_DIR=${stateDir}`,
    "MOSSBRIDGE_SHARED_PORT=9988",
    `MOSSBRIDGE_SESSIONS_FILE=${sessionsFile}`,
    "",
  ].join("\n"), "utf8");
  try {
    const shared = loadSharedCommonWithEnv({
      MOSSBRIDGE_ENV_FILE: envFile,
    });

    assert.equal(shared.stateDir, stateDir);
    assert.equal(shared.listenUrl, "ws://127.0.0.1:9988");
    assert.equal(shared.logDir, path.join(stateDir, "logs"));
    assert.equal(shared.bridgePidFile, path.join(stateDir, "logs", "shared-wechat.pid"));
    assert.equal(shared.appServerPidFile, path.join(stateDir, "logs", "shared-app-server.pid"));
    assert.equal(shared.sessionFile, sessionsFile);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("shared runtime config rejects invalid shared ports instead of silently falling back", () => {
  assert.throws(
    () => loadSharedCommonWithEnv({
      MOSSBRIDGE_SHARED_PORT: "not-a-port",
      MOSSBRIDGE_STATE_DIR: "/tmp/mossbridge-shared-config-test",
    }),
    /MOSSBRIDGE_SHARED_PORT must be an integer from 1 to 65535/,
  );
  assert.throws(
    () => loadSharedCommonWithEnv({
      MOSSBRIDGE_SHARED_PORT: "70000",
      MOSSBRIDGE_STATE_DIR: "/tmp/mossbridge-shared-config-test",
    }),
    /MOSSBRIDGE_SHARED_PORT must be an integer from 1 to 65535/,
  );
});

test("shared app-server recovery marker rejects replay or payload-bearing requests", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-shared-recovery-"));
  const shared = loadSharedCommonWithEnv({
    MOSSBRIDGE_STATE_DIR: path.join(tempRoot, "state"),
  });
  const valid = {
    schema_version: "codex_mcp_transport_recovery.v1",
    reason: "transport_closed_before_toolhost",
    requested_at: "2026-07-17T03:00:00.000Z",
    action_replay_allowed: false,
    tool_outcome_reached: false,
    request_contains_tool_arguments: false,
    request_contains_user_text: false,
  };

  assert.deepEqual(shared.parseSharedAppServerRecoveryRequest(JSON.stringify(valid)), {
    reason: "transport_closed_before_toolhost",
    requestedAt: "2026-07-17T03:00:00.000Z",
  });
  assert.equal(shared.parseSharedAppServerRecoveryRequest(JSON.stringify({
    ...valid,
    action_replay_allowed: true,
  })), null);
  assert.equal(shared.parseSharedAppServerRecoveryRequest(JSON.stringify({
    ...valid,
    request_contains_tool_arguments: true,
  })), null);
});

test("shared app-server ownership requires Codex, app-server, and the exact listener", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-shared-owner-"));
  const shared = loadSharedCommonWithEnv({
    MOSSBRIDGE_STATE_DIR: path.join(tempRoot, "state"),
    MOSSBRIDGE_SHARED_PORT: "8765",
  });

  assert.equal(
    shared.isOwnedSharedAppServerCommand("node /usr/bin/codex app-server --listen ws://127.0.0.1:8765"),
    true,
  );
  assert.equal(shared.isOwnedSharedAppServerCommand("node other.js app-server --listen ws://127.0.0.1:8765"), false);
  assert.equal(shared.isOwnedSharedAppServerCommand("node /usr/bin/codex app-server --listen ws://127.0.0.1:9999"), false);
});

test("shared app-server ownership expands to every process group in the verified session", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-shared-groups-"));
  const shared = loadSharedCommonWithEnv({
    MOSSBRIDGE_STATE_DIR: path.join(tempRoot, "state"),
    MOSSBRIDGE_SHARED_PORT: "8765",
  });
  const processTable = shared.parseProcessTable(`
    123 1 123 123 node /usr/bin/codex app-server --listen ws://127.0.0.1:8765
    124 123 123 123 /usr/lib/codex/codex app-server --listen ws://127.0.0.1:8765
    201 124 201 123 node tool-mcp-server --runtime-id codex
    202 124 202 123 node tool-mcp-server --runtime-id codex
    300 1 300 300 node unrelated-service.js
  `);

  assert.deepEqual(shared.resolveOwnedSharedAppServerSession(123, processTable), {
    leaderPid: 123,
    sessionId: 123,
    processCount: 4,
    processGroups: [201, 202, 123],
  });
  assert.equal(shared.resolveOwnedSharedAppServerSession(300, processTable), null);
});

test("shared app-server recovery fails closed before signaling an unowned pid", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-shared-fail-"));
  const shared = loadSharedCommonWithEnv({
    MOSSBRIDGE_STATE_DIR: path.join(tempRoot, "state"),
    MOSSBRIDGE_SHARED_PORT: "8765",
  });
  const signals = [];

  await assert.rejects(
    () => shared.recycleSharedAppServer({
      readPid: () => 123,
      pidAlive: () => true,
      processTable: () => shared.parseProcessTable(
        "123 1 123 123 node unrelated-service.js",
      ),
      signalGroup: (_pid, signal) => signals.push(signal),
      readyCheck: async () => true,
      ensure: async () => ({ status: "started", pid: 456 }),
      wait: async () => {},
    }),
    /not owned by the shared Codex app-server/,
  );
  assert.deepEqual(signals, []);
});

test("shared app-server recovery stops all owned session process groups before starting a replacement", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-shared-recycle-"));
  const shared = loadSharedCommonWithEnv({
    MOSSBRIDGE_STATE_DIR: path.join(tempRoot, "state"),
    MOSSBRIDGE_SHARED_PORT: "8765",
  });
  const signals = [];
  let alive = true;
  let ready = true;
  let ensured = false;
  let currentTable = shared.parseProcessTable(`
    123 1 123 123 node /usr/bin/codex app-server --listen ws://127.0.0.1:8765
    124 123 123 123 /usr/lib/codex/codex app-server --listen ws://127.0.0.1:8765
    201 124 201 123 node tool-mcp-server --runtime-id codex
    202 124 202 123 node tool-mcp-server --runtime-id codex
  `);

  const result = await shared.recycleSharedAppServer({
    readPid: () => 123,
    pidAlive: () => alive,
    processTable: () => currentTable,
    signalGroup: (pgid, signal) => {
      signals.push([pgid, signal]);
      if (pgid === 123) {
        alive = false;
        ready = false;
        currentTable = [];
      }
    },
    readyCheck: async () => ready,
    ensure: async () => {
      ensured = true;
      return { status: "started", pid: 456 };
    },
    wait: async () => {},
  });

  assert.deepEqual(signals, [
    [201, "SIGTERM"],
    [202, "SIGTERM"],
    [123, "SIGTERM"],
  ]);
  assert.equal(ensured, true);
  assert.deepEqual(result, { status: "started", pid: 456 });
});
