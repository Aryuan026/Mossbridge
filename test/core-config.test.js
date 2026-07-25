const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { readConfig } = require("../src/core/config");

const BRIDGE_ENV_KEYS = [
  "MOSSBRIDGE_STATE_DIR",
  "MOSSBRIDGE_DATA_ROOT",
  "MOSSBRIDGE_STICKERS_DIR",
  "MOSSBRIDGE_STICKER_ASSETS_DIR",
  "MOSSBRIDGE_STICKERS_INDEX_FILE",
  "MOSSBRIDGE_STICKER_TAGS_FILE",
  "MOSSBRIDGE_NOTEBOOK_DIR",
  "MOSSBRIDGE_DIARY_DIR",
  "MOSSBRIDGE_IDENTITY_USER_ID",
  "MOSSBRIDGE_IDENTITY_REALM_ID",
  "MOSSBRIDGE_IDENTITY_AGENT_ID",
  "MOSSBRIDGE_MAINTENANCE_PROFILE",
  "MOSSBRIDGE_MAINTENANCE_ALLOW_SELF_REPAIR",
  "MOSSBRIDGE_ALLOW_OPEN_INBOUND",
  "MOSSBRIDGE_CODEX_ENDPOINT",
  "MOSSBRIDGE_CODEX_COMMAND",
  "MOSSBRIDGE_CODEX_RPC_REQUEST_TIMEOUT_MS",
  "MOSSBRIDGE_CODEX_MODEL",
  "MOSSBRIDGE_CODEX_MODEL_PROVIDER",
  "MOSSBRIDGE_CODEX_NATIVE_IMAGE_INPUT",
  "MOSSBRIDGE_MODEL_CHOICES",
  "MOSSBRIDGE_CODEX_MODEL_CHOICES",
  "MOSSBRIDGE_CLAUDE_MODEL_CHOICES",
  "MOSSBRIDGE_CHECKIN_DAILY_CACHE_READ_WEIGHT",
  "MOSSBRIDGE_CHECKIN_MODEL_MIN_GAP_MINUTES",
  "MOSSBRIDGE_SYSTEM_BUDGET_DREAMING_DEFER_MINUTES",
  "MOSSBRIDGE_SYSTEM_BUDGET_COMPACT_RUNTIME_TEXT_MAX_CHARS",
  "MOSSBRIDGE_BACKGROUND_RUNTIME_CIRCUIT",
  "MOSSBRIDGE_BACKGROUND_RUNTIME_CIRCUIT_FAILURE_THRESHOLD",
  "MOSSBRIDGE_BACKGROUND_RUNTIME_CIRCUIT_COOLDOWN_MINUTES",
  "MOSSBRIDGE_DEFERRED_SYSTEM_REPLY_MAX_AGE_MINUTES",
];

function withBridgeEnv(values, fn) {
  const previous = new Map(BRIDGE_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of BRIDGE_ENV_KEYS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of BRIDGE_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("readConfig keeps standalone sticker catalog under bridge state by default", () => {
  withBridgeEnv({ MOSSBRIDGE_STATE_DIR: "/tmp/bridge-state" }, () => {
    const config = readConfig();

    assert.equal(config.asherieDataRoot, path.join("/tmp/bridge-state", "mossbridge_data"));
    assert.equal(config.stickersDir, path.join("/tmp/bridge-state", "stickers"));
    assert.equal(config.stickerAssetsDir, path.join("/tmp/bridge-state", "stickers", "assets"));
    assert.equal(config.stickersIndexFile, path.join("/tmp/bridge-state", "stickers", "index.json"));
    assert.equal(config.stickerTagsFile, path.join("/tmp/bridge-state", "stickers", "tags.json"));
    assert.equal(config.notebookDir, path.join("/tmp/bridge-state", "mossbridge_data", "storage", "notebook"));
    assert.equal(config.diaryDir, config.notebookDir);
  });
});

test("readConfig shares data-root sticker catalog when a data root is configured", () => {
  withBridgeEnv({
    MOSSBRIDGE_STATE_DIR: "/tmp/bridge-state",
    MOSSBRIDGE_DATA_ROOT: "/tmp/mossbridge-data",
  }, () => {
    const config = readConfig();
    const expectedRoot = path.join("/tmp/mossbridge-data", "storage", "stickers");

    assert.equal(config.asherieDataRoot, "/tmp/mossbridge-data");
    assert.equal(config.notebookDir, path.join("/tmp/mossbridge-data", "storage", "notebook"));
    assert.equal(config.diaryDir, config.notebookDir);
    assert.equal(config.stickersDir, expectedRoot);
    assert.equal(config.stickerAssetsDir, path.join(expectedRoot, "assets"));
    assert.equal(config.stickersIndexFile, path.join(expectedRoot, "index.json"));
    assert.equal(config.stickerTagsFile, path.join(expectedRoot, "tags.json"));
  });
});

test("readConfig lets notebook storage override the data-root default", () => {
  withBridgeEnv({
    MOSSBRIDGE_STATE_DIR: "/tmp/bridge-state",
    MOSSBRIDGE_DATA_ROOT: "/tmp/mossbridge-data",
    MOSSBRIDGE_NOTEBOOK_DIR: "/tmp/manual-notebook",
  }, () => {
    const config = readConfig();

    assert.equal(config.notebookDir, "/tmp/manual-notebook");
    assert.equal(config.diaryDir, "/tmp/manual-notebook");
  });
});

test("readConfig lets explicit sticker catalog override the shared data root", () => {
  withBridgeEnv({
    MOSSBRIDGE_STATE_DIR: "/tmp/bridge-state",
    MOSSBRIDGE_DATA_ROOT: "/tmp/asherie-home-data",
    MOSSBRIDGE_STICKERS_DIR: "/tmp/manual-stickers",
  }, () => {
    const config = readConfig();

    assert.equal(config.stickersDir, "/tmp/manual-stickers");
    assert.equal(config.stickerAssetsDir, path.join("/tmp/manual-stickers", "assets"));
    assert.equal(config.stickersIndexFile, path.join("/tmp/manual-stickers", "index.json"));
    assert.equal(config.stickerTagsFile, path.join("/tmp/manual-stickers", "tags.json"));
  });
});

test("readConfig defaults public bridge maintenance to safe self-check", () => {
  withBridgeEnv({ MOSSBRIDGE_STATE_DIR: "/tmp/bridge-state" }, () => {
    const config = readConfig();

    assert.equal(config.maintenanceProfile, "safe_self_check");
    assert.equal(config.maintenanceAllowSelfRepair, false);
  });
});

test("readConfig keeps open inbound enrollment disabled by default", () => {
  withBridgeEnv({ MOSSBRIDGE_STATE_DIR: "/tmp/bridge-state" }, () => {
    const config = readConfig();

    assert.equal(config.allowOpenInbound, false);
  });
});

test("readConfig enables open inbound enrollment only when explicitly requested", () => {
  withBridgeEnv({
    MOSSBRIDGE_STATE_DIR: "/tmp/bridge-state",
    MOSSBRIDGE_ALLOW_OPEN_INBOUND: "true",
  }, () => {
    const config = readConfig();

    assert.equal(config.allowOpenInbound, true);
  });
});

test("readConfig loads deferred system reply max age", () => {
  withBridgeEnv({
    MOSSBRIDGE_STATE_DIR: "/tmp/bridge-state",
    MOSSBRIDGE_DEFERRED_SYSTEM_REPLY_MAX_AGE_MINUTES: "12",
  }, () => {
    const config = readConfig();

    assert.equal(config.deferredSystemReplyMaxAgeMinutes, 12);
  });
});

test("readConfig defaults public memory identity to moss agent", () => {
  withBridgeEnv({ MOSSBRIDGE_STATE_DIR: "/tmp/bridge-state" }, () => {
    const config = readConfig();

    assert.equal(config.identityUserId, "owner");
    assert.equal(config.identityRealmId, "default");
    assert.equal(config.identityAgentId, "moss");
  });
});

test("readConfig lets public maintenance self-repair be explicitly enabled", () => {
  withBridgeEnv({
    MOSSBRIDGE_STATE_DIR: "/tmp/bridge-state",
    MOSSBRIDGE_MAINTENANCE_PROFILE: "private_cloud_ready",
    MOSSBRIDGE_MAINTENANCE_ALLOW_SELF_REPAIR: "true",
  }, () => {
    const config = readConfig();

    assert.equal(config.maintenanceProfile, "private_cloud_ready");
    assert.equal(config.maintenanceAllowSelfRepair, true);
  });
});

test("readConfig exposes model choices for WeChat model menus", () => {
  withBridgeEnv({
    MOSSBRIDGE_STATE_DIR: "/tmp/bridge-state",
    MOSSBRIDGE_MODEL_CHOICES: "fast=gpt-5.4-mini",
    MOSSBRIDGE_CODEX_MODEL_CHOICES: "local=gemma4:26b-32k@ollama",
    MOSSBRIDGE_CLAUDE_MODEL_CHOICES: "opus=claude-opus-4-6",
  }, () => {
    const config = readConfig();

    assert.deepEqual(config.modelChoices, ["fast=gpt-5.4-mini"]);
    assert.deepEqual(config.codexModelChoices, ["local=gemma4:26b-32k@ollama"]);
    assert.deepEqual(config.claudeModelChoices, ["opus=claude-opus-4-6"]);
  });
});

test("readConfig preserves explicit Codex runtime endpoint and model config", () => {
  withBridgeEnv({
    MOSSBRIDGE_STATE_DIR: "/tmp/bridge-state",
    MOSSBRIDGE_CODEX_ENDPOINT: "ws://127.0.0.1:9876",
    MOSSBRIDGE_CODEX_COMMAND: "codex",
    MOSSBRIDGE_CODEX_MODEL: "gpt-test",
    MOSSBRIDGE_CODEX_MODEL_PROVIDER: "openai",
    MOSSBRIDGE_CODEX_NATIVE_IMAGE_INPUT: "true",
  }, () => {
    const config = readConfig();

    assert.equal(config.codexEndpoint, "ws://127.0.0.1:9876");
    assert.equal(config.codexCommand, "codex");
    assert.equal(config.codexModel, "gpt-test");
    assert.equal(config.codexModelProvider, "openai");
    assert.equal(config.codexNativeImageInput, true);
  });
});

test("readConfig bounds the Codex RPC request timeout", () => {
  withBridgeEnv({
    MOSSBRIDGE_STATE_DIR: "/tmp/bridge-state",
    MOSSBRIDGE_CODEX_RPC_REQUEST_TIMEOUT_MS: "90000",
  }, () => {
    const config = readConfig();

    assert.equal(config.codexRpcRequestTimeoutMs, 90000);
  });
  withBridgeEnv({
    MOSSBRIDGE_STATE_DIR: "/tmp/bridge-state",
    MOSSBRIDGE_CODEX_RPC_REQUEST_TIMEOUT_MS: "1",
  }, () => {
    const config = readConfig();

    assert.equal(config.codexRpcRequestTimeoutMs, 5000);
  });
  withBridgeEnv({
    MOSSBRIDGE_STATE_DIR: "/tmp/bridge-state",
    MOSSBRIDGE_CODEX_RPC_REQUEST_TIMEOUT_MS: "999999",
  }, () => {
    const config = readConfig();

    assert.equal(config.codexRpcRequestTimeoutMs, 120000);
  });
});

test("readConfig loads weighted checkin budget tuning", () => {
  withBridgeEnv({
    MOSSBRIDGE_STATE_DIR: "/tmp/bridge-state",
    MOSSBRIDGE_CHECKIN_DAILY_CACHE_READ_WEIGHT: "0.1",
    MOSSBRIDGE_CHECKIN_MODEL_MIN_GAP_MINUTES: "75",
    MOSSBRIDGE_SYSTEM_BUDGET_DREAMING_DEFER_MINUTES: "20",
    MOSSBRIDGE_SYSTEM_BUDGET_COMPACT_RUNTIME_TEXT_MAX_CHARS: "6000",
  }, () => {
    const config = readConfig();

    assert.equal(config.checkinDailyCacheReadWeight, 0.1);
    assert.equal(config.checkinModelMinGapMinutes, 75);
    assert.equal(config.systemBudgetDreamingDeferMinutes, 20);
    assert.equal(config.systemBudgetCompactRuntimeTextMaxChars, 6000);
  });
});

test("readConfig keeps background runtime circuit under bridge state with Mossbridge env", () => {
  withBridgeEnv({
    MOSSBRIDGE_STATE_DIR: "/tmp/bridge-state",
    MOSSBRIDGE_BACKGROUND_RUNTIME_CIRCUIT: "false",
    MOSSBRIDGE_BACKGROUND_RUNTIME_CIRCUIT_FAILURE_THRESHOLD: "2",
    MOSSBRIDGE_BACKGROUND_RUNTIME_CIRCUIT_COOLDOWN_MINUTES: "30",
  }, () => {
    const config = readConfig();

    assert.equal(config.backgroundRuntimeCircuitEnabled, false);
    assert.equal(config.backgroundRuntimeCircuitFailureThreshold, 2);
    assert.equal(config.backgroundRuntimeCircuitCooldownMinutes, 30);
    assert.equal(config.backgroundRuntimeCircuitFile, path.join("/tmp/bridge-state", "background-runtime-circuit.json"));
  });
});
