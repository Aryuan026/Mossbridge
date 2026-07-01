const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const SHARED_COMMON_PATH = path.resolve(__dirname, "../scripts/shared-common.js");

function loadSharedCommonWithEnv(env = {}) {
  const previous = new Map([
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
