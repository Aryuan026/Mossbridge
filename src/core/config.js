const os = require("os");
const path = require("path");

function readConfig() {
  const argv = process.argv.slice(2);
  const mode = argv[0] || "";
  const stateDir = readBridgeTextEnv("STATE_DIR") || path.join(os.homedir(), ".asheriebridge");

  return {
    mode,
    argv,
    stateDir,
    workspaceId: readBridgeTextEnv("WORKSPACE_ID") || "default",
    workspaceRoot: readBridgeTextEnv("WORKSPACE_ROOT") || process.cwd(),
    workspaceInboxDir: readBridgeTextEnv("WORKSPACE_INBOX_DIR") || path.join("wechat", "inbox"),
    workspaceAttachmentNotesDir: readBridgeTextEnv("WORKSPACE_ATTACHMENT_NOTES_DIR") || path.join("context", "attachment-notes"),
    workspaceAttachmentJournalFile: readBridgeTextEnv("WORKSPACE_ATTACHMENT_JOURNAL_FILE") || path.join("context", "attachment-journal.jsonl"),
    userName: readBridgeTextEnv("USER_NAME") || "User",
    userGender: readBridgeTextEnv("USER_GENDER") || "female",
    allowedUserIds: readBridgeListEnv("ALLOWED_USER_IDS"),
    channel: readBridgeTextEnv("CHANNEL") || "weixin",
    runtime: readBridgeTextEnv("RUNTIME") || "codex",
    timelineCommand: readBridgeTextEnv("TIMELINE_COMMAND") || "timeline-for-agent",
    accountId: readBridgeTextEnv("ACCOUNT_ID"),
    weixinBaseUrl: readBridgeTextEnv("WEIXIN_BASE_URL") || "https://ilinkai.weixin.qq.com",
    weixinCdnBaseUrl: readBridgeTextEnv("WEIXIN_CDN_BASE_URL") || "https://novac2c.cdn.weixin.qq.com/c2c",
    weixinConfigFile: path.join(stateDir, "weixin-config.json"),
    weixinMinChunkChars: readBridgeIntEnv("WEIXIN_MIN_CHUNK_CHARS"),
    weixinQrBotType: readBridgeTextEnv("WEIXIN_QR_BOT_TYPE") || "3",
    accountsDir: path.join(stateDir, "accounts"),
    reminderQueueFile: path.join(stateDir, "reminder-queue.json"),
    systemMessageQueueFile: path.join(stateDir, "system-message-queue.json"),
    deferredSystemReplyQueueFile: path.join(stateDir, "deferred-system-replies.json"),
    checkinConfigFile: path.join(stateDir, "checkin-config.json"),
    timelineScreenshotQueueFile: path.join(stateDir, "timeline-screenshot-queue.json"),
    projectToolContextFile: path.join(stateDir, "project-tool-runtime-context.json"),
    stickersDir: path.join(stateDir, "stickers"),
    stickerAssetsDir: path.join(stateDir, "stickers", "assets"),
    stickersIndexFile: path.join(stateDir, "stickers", "index.json"),
    stickerTagsFile: path.join(stateDir, "stickers", "tags.json"),
    stickersTemplateDir: path.resolve(__dirname, "..", "..", "templates", "stickers"),
    stickersTemplateIndexFile: path.resolve(__dirname, "..", "..", "templates", "stickers", "index.json"),
    stickerTagsTemplateFile: path.resolve(__dirname, "..", "..", "templates", "stickers", "tags.json"),
    stickerNormalizeGifScript: path.resolve(__dirname, "..", "..", "scripts", "normalize-sticker-gif.js"),
    weixinInstructionsFile: path.join(stateDir, "weixin-instructions.md"),
    weixinOperationsFile: path.resolve(__dirname, "..", "..", "templates", "weixin-operations.md"),
    identityUserId: readBridgeTextEnv("IDENTITY_USER_ID") || "owner",
    identityRealmId: readBridgeTextEnv("IDENTITY_REALM_ID") || "default",
    identityAgentId: readBridgeTextEnv("IDENTITY_AGENT_ID") || "aji",
    diaryDir: path.join(stateDir, "diary"),
    locationStoreFile: path.join(stateDir, "locations.json"),
    locationHost: readBridgeTextEnv("LOCATION_HOST") || "0.0.0.0",
    locationPort: readBridgeIntEnv("LOCATION_PORT") || 4318,
    locationToken: readBridgeTextEnv("LOCATION_TOKEN"),
    locationHistoryLimit: readBridgeIntEnv("LOCATION_HISTORY_LIMIT") || 1000,
    locationMovementEventLimit: readBridgeIntEnv("LOCATION_MOVEMENT_EVENT_LIMIT"),
    locationBatteryHistoryLimit: readBridgeIntEnv("LOCATION_BATTERY_HISTORY_LIMIT"),
    locationKnownPlaces: readKnownPlacesEnv(),
    locationKnownPlaceRadiusMeters: readBridgeIntEnv("LOCATION_PLACE_RADIUS_METERS") || 150,
    locationStayMergeRadiusMeters: readBridgeIntEnv("LOCATION_STAY_MERGE_RADIUS_METERS") || 100,
    locationStayBreakConfirmRadiusMeters: readBridgeIntEnv("LOCATION_STAY_BREAK_RADIUS_METERS") || 200,
    locationStayBreakConfirmSamples: readBridgeIntEnv("LOCATION_STAY_BREAK_SAMPLES") || 2,
    locationMajorMoveThresholdMeters: readBridgeIntEnv("LOCATION_MAJOR_MOVE_THRESHOLD_METERS") || 1000,
    startWithLocationServer: resolveLocationServerEnabled({
      mode,
      enabled: readBridgeOptionalBoolEnv("ENABLE_LOCATION_SERVER"),
    }),
    syncBufferDir: path.join(stateDir, "sync-buffers"),
    codexEndpoint: readBridgeTextEnv("CODEX_ENDPOINT"),
    codexCommand: readBridgeTextEnv("CODEX_COMMAND"),
    claudeCommand: readBridgeTextEnv("CLAUDE_COMMAND") || "claude",
    claudeModel: readBridgeTextEnv("CLAUDE_MODEL") || "",
    claudeContextWindow: readBridgeIntEnv("CLAUDE_CONTEXT_WINDOW"),
    claudeMaxOutputTokens: readIntEnv("CLAUDE_CODE_MAX_OUTPUT_TOKENS"),
    claudePermissionMode: readBridgeTextEnv("CLAUDE_PERMISSION_MODE") || "default",
    claudeBare: readBridgeOptionalBoolEnv("CLAUDE_BARE") ?? false,
    claudeAppendSystemPrompt: readBridgeTextEnv("CLAUDE_APPEND_SYSTEM_PROMPT"),
    claudeDisableVerbose: readBridgeBoolEnv("CLAUDE_DISABLE_VERBOSE"),
    claudeExtraArgs: readBridgeListEnv("CLAUDE_EXTRA_ARGS"),
    sessionsFile: path.join(stateDir, "sessions.json"),
    startWithCheckin: (mode === "start" && hasArgFlag(argv, "--checkin")) || readBridgeBoolEnv("ENABLE_CHECKIN"),
    asherieDataRoot: readTextEnv("ASHERIEBRIDGE_DATA_ROOT") || path.join(stateDir, "asherie_gateway"),
    asherieTruthLayerDir: readTextEnv("ASHERIEBRIDGE_ASHERIE_TRUTH_LAYER_DIR"),
    asherieWarmMemoryDir: readTextEnv("ASHERIEBRIDGE_ASHERIE_WARM_MEMORY_DIR"),
    asherieMemoryVersionBankDir: readTextEnv("ASHERIEBRIDGE_ASHERIE_MEMORY_VERSION_BANK_DIR"),
    asherieContextCacheLimit: readBridgeIntEnv("ASHERIE_CONTEXT_CACHE_LIMIT") || 50,
    asherieProactiveContextCacheLimit: readBridgeIntEnv("ASHERIE_PROACTIVE_CONTEXT_CACHE_LIMIT") || 50,
    asherieRecallRecentRecordLimit: readBridgeIntEnv("ASHERIE_RECALL_RECENT_RECORD_LIMIT") || 8,
    asheriePreludeWarmLimit: readBridgeIntEnv("ASHERIE_PRELUDE_WARM_LIMIT") || 6,
    asheriePreludeResidentWarmLimit: readBridgeIntEnv("ASHERIE_PRELUDE_RESIDENT_WARM_LIMIT") || 5,
    asheriePreludeOngoingLimit: readBridgeIntEnv("ASHERIE_PRELUDE_ONGOING_LIMIT") || 5,
    asheriePreludeOngoingShadowLimit: readBridgeIntEnv("ASHERIE_PRELUDE_ONGOING_SHADOW_LIMIT") || 6,
    asheriePreludeRecentSnippetLimit: readBridgeIntEnv("ASHERIE_PRELUDE_RECENT_SNIPPET_LIMIT") || 8,
    asheriePreludeRecentThreadLimit: readBridgeIntEnv("ASHERIE_PRELUDE_RECENT_THREAD_LIMIT") || 8,
  };
}

function readBridgeTextEnv(suffix) {
  return readTextEnv(`ASHERIEBRIDGE_${suffix}`);
}

function readBridgeListEnv(suffix) {
  return readListEnv(`ASHERIEBRIDGE_${suffix}`);
}

function readBridgeBoolEnv(suffix) {
  return readBoolEnv(`ASHERIEBRIDGE_${suffix}`);
}

function readBridgeOptionalBoolEnv(suffix) {
  return readOptionalBoolEnv(`ASHERIEBRIDGE_${suffix}`);
}

function readBridgeIntEnv(suffix) {
  return readIntEnv(`ASHERIEBRIDGE_${suffix}`);
}

function readListEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readListEnvAny(names) {
  for (const name of names) {
    const value = readListEnv(name);
    if (value.length) {
      return value;
    }
  }
  return [];
}

function readTextEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function readTextEnvAny(names) {
  for (const name of names) {
    const value = readTextEnv(name);
    if (value) {
      return value;
    }
  }
  return "";
}

function readBoolEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function readBoolEnvAny(names) {
  for (const name of names) {
    const value = readTextEnv(name).toLowerCase();
    if (!value) {
      continue;
    }
    return value === "1" || value === "true" || value === "yes" || value === "on";
  }
  return false;
}

function readOptionalBoolEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "1" || value === "true" || value === "yes" || value === "on") {
    return true;
  }
  if (value === "0" || value === "false" || value === "no" || value === "off") {
    return false;
  }
  return undefined;
}

function readOptionalBoolEnvAny(names) {
  for (const name of names) {
    const value = readTextEnv(name).toLowerCase();
    if (!value) {
      continue;
    }
    if (value === "1" || value === "true" || value === "yes" || value === "on") {
      return true;
    }
    if (value === "0" || value === "false" || value === "no" || value === "off") {
      return false;
    }
  }
  return undefined;
}

function readIntEnv(name) {
  const value = readTextEnv(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readIntEnvAny(names) {
  for (const name of names) {
    const parsed = readIntEnv(name);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readKnownPlacesEnv() {
  const fromJson = parseKnownPlacesJson(readTextEnv("ASHERIEBRIDGE_LOCATION_KNOWN_PLACES"));
  const fromCenters = [
    parseKnownPlaceCenter("home", readTextEnv("ASHERIEBRIDGE_LOCATION_HOME_CENTER")),
    parseKnownPlaceCenter("work", readTextEnv("ASHERIEBRIDGE_LOCATION_WORK_CENTER")),
  ].filter(Boolean);
  return [...fromJson, ...fromCenters];
}

function parseKnownPlacesJson(value) {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseKnownPlaceCenter(tag, value) {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }
  return { tag, latitude, longitude };
}

function hasArgFlag(argv, flag) {
  return Array.isArray(argv) && argv.some((item) => String(item || "").trim() === flag);
}

function resolveLocationServerEnabled({ mode, enabled }) {
  if (mode !== "start") {
    return false;
  }
  if (typeof enabled === "boolean") {
    return enabled;
  }
  return false;
}

module.exports = { readConfig };
