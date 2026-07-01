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
