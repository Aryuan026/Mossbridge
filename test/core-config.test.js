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
  "MOSSBRIDGE_MAINTENANCE_PROFILE",
  "MOSSBRIDGE_MAINTENANCE_ALLOW_SELF_REPAIR",
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

    assert.equal(config.stickersDir, path.join("/tmp/bridge-state", "stickers"));
    assert.equal(config.stickerAssetsDir, path.join("/tmp/bridge-state", "stickers", "assets"));
    assert.equal(config.stickersIndexFile, path.join("/tmp/bridge-state", "stickers", "index.json"));
    assert.equal(config.stickerTagsFile, path.join("/tmp/bridge-state", "stickers", "tags.json"));
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
    assert.equal(config.stickersDir, expectedRoot);
    assert.equal(config.stickerAssetsDir, path.join(expectedRoot, "assets"));
    assert.equal(config.stickersIndexFile, path.join(expectedRoot, "index.json"));
    assert.equal(config.stickerTagsFile, path.join(expectedRoot, "tags.json"));
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
