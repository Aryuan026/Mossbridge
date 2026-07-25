const os = require("os");
const path = require("path");

function readConfig() {
  const argv = process.argv.slice(2);
  const mode = argv[0] || "";
  const stateDir = readBridgeTextEnv("STATE_DIR") || path.join(os.homedir(), ".mossbridge");
  const configuredAsherieDataRoot = readTextEnv("MOSSBRIDGE_DATA_ROOT");
  const asherieDataRoot = configuredAsherieDataRoot || path.join(stateDir, "mossbridge_data");
  const stickersDir = readBridgeTextEnv("STICKERS_DIR")
    || (configuredAsherieDataRoot
      ? path.join(asherieDataRoot, "storage", "stickers")
      : path.join(stateDir, "stickers"));
  const notebookDir = readBridgeTextEnv("NOTEBOOK_DIR")
    || readBridgeTextEnv("DIARY_DIR")
    || path.join(asherieDataRoot, "storage", "notebook");

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
    userGender: readBridgeTextEnv("USER_GENDER") || "neutral",
    allowedUserIds: readBridgeListEnv("ALLOWED_USER_IDS"),
    allowOpenInbound: readBridgeBoolEnv("ALLOW_OPEN_INBOUND"),
    channel: readBridgeTextEnv("CHANNEL") || "weixin",
    runtime: readBridgeTextEnv("RUNTIME") || "codex",
    timelineCommand: readBridgeTextEnv("TIMELINE_COMMAND") || "timeline-for-agent",
    maintenanceProfile: readBridgeTextEnv("MAINTENANCE_PROFILE") || "safe_self_check",
    maintenanceAllowSelfRepair: readBridgeOptionalBoolEnv("MAINTENANCE_ALLOW_SELF_REPAIR") ?? false,
    accountId: readBridgeTextEnv("ACCOUNT_ID"),
    weixinBaseUrl: readBridgeTextEnv("WEIXIN_BASE_URL") || "https://ilinkai.weixin.qq.com",
    weixinCdnBaseUrl: readBridgeTextEnv("WEIXIN_CDN_BASE_URL") || "https://novac2c.cdn.weixin.qq.com/c2c",
    attachmentDownloadTimeoutMs: readBridgeIntEnv("ATTACHMENT_DOWNLOAD_TIMEOUT_MS") || 30_000,
    channelFileMaxBytes: readBridgeIntEnv("CHANNEL_FILE_MAX_BYTES") || 20 * 1024 * 1024,
    channelFileSendTimeoutMs: readBridgeIntEnv("CHANNEL_FILE_SEND_TIMEOUT_MS") || 120_000,
    weixinConfigFile: path.join(stateDir, "weixin-config.json"),
    weixinMinChunkChars: readBridgeIntEnv("WEIXIN_MIN_CHUNK_CHARS"),
    weixinQrBotType: readBridgeTextEnv("WEIXIN_QR_BOT_TYPE") || "3",
    accountsDir: path.join(stateDir, "accounts"),
    reminderQueueFile: path.join(stateDir, "reminder-queue.json"),
    systemMessageQueueFile: path.join(stateDir, "system-message-queue.json"),
    deferredSystemReplyQueueFile: path.join(stateDir, "deferred-system-replies.json"),
    deferredSystemReplyMaxAgeMinutes: clampInt(readBridgeIntEnv("DEFERRED_SYSTEM_REPLY_MAX_AGE_MINUTES"), 30, 1, 24 * 60),
    checkinConfigFile: path.join(stateDir, "checkin-config.json"),
    controlLedgerFile: path.join(stateDir, "control-events.jsonl"),
    memoryMetabolismStateFile: path.join(stateDir, "memory-metabolism-state.json"),
    checkinContextTokenMaxAgeMinutes: readBridgeIntEnv("CHECKIN_CONTEXT_TOKEN_MAX_AGE_MINUTES"),
    checkinRuntimeTextMaxChars: readBridgeIntEnv("CHECKIN_RUNTIME_TEXT_MAX_CHARS"),
    checkinTokenBackoffPercent: readBridgeIntEnv("CHECKIN_TOKEN_BACKOFF_PERCENT"),
    checkinTokenSevereBackoffPercent: readBridgeIntEnv("CHECKIN_TOKEN_SEVERE_BACKOFF_PERCENT"),
    checkinTokenBackoffMultiplier: readBridgeIntEnv("CHECKIN_TOKEN_BACKOFF_MULTIPLIER"),
    checkinTokenSevereBackoffMultiplier: readBridgeIntEnv("CHECKIN_TOKEN_SEVERE_BACKOFF_MULTIPLIER"),
    checkinMaxBackoffMinutes: readBridgeIntEnv("CHECKIN_MAX_BACKOFF_MINUTES"),
    checkinDailyTokenBudget: readBridgeIntEnv("CHECKIN_DAILY_TOKEN_BUDGET"),
    checkinDailyThreadBudget: readBridgeIntEnv("CHECKIN_DAILY_THREAD_BUDGET"),
    checkinDailyCacheReadWeight: readBridgeNumberEnv("CHECKIN_DAILY_CACHE_READ_WEIGHT"),
    checkinModelMinGapMinutes: readBridgeNumberEnv("CHECKIN_MODEL_MIN_GAP_MINUTES"),
    checkinQuietHours: readBridgeTextEnv("CHECKIN_QUIET_HOURS"),
    checkinMorningContextTokenGraceHours: readBridgeTextEnv("CHECKIN_MORNING_CONTEXT_TOKEN_GRACE_HOURS"),
    checkinMorningContextTokenMaxAgeMinutes: readBridgeIntEnv("CHECKIN_MORNING_CONTEXT_TOKEN_MAX_AGE_MINUTES"),
    systemBudgetDreamingDeferMinutes: readBridgeIntEnv("SYSTEM_BUDGET_DREAMING_DEFER_MINUTES"),
    systemBudgetCompactRuntimeTextMaxChars: readBridgeIntEnv("SYSTEM_BUDGET_COMPACT_RUNTIME_TEXT_MAX_CHARS"),
    backgroundRuntimeCircuitEnabled: readBridgeOptionalBoolEnv("BACKGROUND_RUNTIME_CIRCUIT") ?? true,
    backgroundRuntimeCircuitFailureThreshold: clampInt(readBridgeIntEnv("BACKGROUND_RUNTIME_CIRCUIT_FAILURE_THRESHOLD"), 3, 1, 20),
    backgroundRuntimeCircuitCooldownMinutes: clampInt(readBridgeIntEnv("BACKGROUND_RUNTIME_CIRCUIT_COOLDOWN_MINUTES"), 45, 1, 24 * 60),
    checkinHotWindowMinutes: readBridgeIntEnv("CHECKIN_HOT_WINDOW_MINUTES"),
    checkinHotRecentMinutes: readBridgeIntEnv("CHECKIN_HOT_RECENT_MINUTES"),
    checkinHotMinEvents: readBridgeIntEnv("CHECKIN_HOT_MIN_EVENTS"),
    runtimeContextUsageFile: path.join(stateDir, "runtime-context-usage.json"),
    sessionRefreshRequestsFile: path.join(stateDir, "session-refresh-requests.json"),
    sessionRefreshPressurePercent: readBridgeIntEnv("SESSION_REFRESH_PRESSURE_PERCENT"),
    sessionRefreshMinIntervalMs: readBridgeIntEnv("SESSION_REFRESH_MIN_INTERVAL_MS"),
    runtimeCooldownFile: path.join(stateDir, "runtime-cooldowns.json"),
    backgroundRuntimeCircuitFile: path.join(stateDir, "background-runtime-circuit.json"),
    weixinIngressAuditFile: path.join(stateDir, "weixin-ingress-audit.json"),
    timelineScreenshotQueueFile: path.join(stateDir, "timeline-screenshot-queue.json"),
    projectToolContextFile: path.join(stateDir, "project-tool-runtime-context.json"),
    toolInvocationAuditFile: path.join(stateDir, "tool-invocation-audit.jsonl"),
    stickersDir,
    stickerAssetsDir: readBridgeTextEnv("STICKER_ASSETS_DIR") || path.join(stickersDir, "assets"),
    stickersIndexFile: readBridgeTextEnv("STICKERS_INDEX_FILE") || path.join(stickersDir, "index.json"),
    stickerTagsFile: readBridgeTextEnv("STICKER_TAGS_FILE") || path.join(stickersDir, "tags.json"),
    stickerDeliveryAuditFile: path.join(stateDir, "sticker-delivery-audit.json"),
    stickersTemplateDir: path.resolve(__dirname, "..", "..", "templates", "stickers"),
    stickersTemplateIndexFile: path.resolve(__dirname, "..", "..", "templates", "stickers", "index.json"),
    stickerTagsTemplateFile: path.resolve(__dirname, "..", "..", "templates", "stickers", "tags.json"),
    stickerNormalizeGifScript: path.resolve(__dirname, "..", "..", "scripts", "normalize-sticker-gif.js"),
    weixinInstructionsFile: path.join(stateDir, "weixin-instructions.md"),
    weixinOperationsFile: path.resolve(__dirname, "..", "..", "templates", "weixin-operations.md"),
    identityUserId: readBridgeTextEnv("IDENTITY_USER_ID") || "owner",
    identityRealmId: readBridgeTextEnv("IDENTITY_REALM_ID") || "default",
    identityAgentId: readBridgeTextEnv("IDENTITY_AGENT_ID") || "moss",
    notebookDir,
    diaryDir: notebookDir,
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
    codexRpcRequestTimeoutMs: clampInt(readBridgeIntEnv("CODEX_RPC_REQUEST_TIMEOUT_MS"), 45_000, 5_000, 120_000),
    codexHome: readBridgeTextEnv("CODEX_HOME") || readTextEnv("CODEX_HOME") || path.join(os.homedir(), ".codex"),
    codexModel: readBridgeTextEnv("CODEX_MODEL"),
    codexModelProvider: readBridgeTextEnv("CODEX_MODEL_PROVIDER"),
    codexNativeImageInput: readBridgeOptionalBoolEnv("CODEX_NATIVE_IMAGE_INPUT"),
    codexCompanionProfile: readBridgeBoolEnv("CODEX_COMPANION_PROFILE"),
    codexCompanionInstructionsFile: readBridgeTextEnv("CODEX_COMPANION_INSTRUCTIONS_FILE")
      || path.resolve(__dirname, "..", "..", "templates", "codex-companion-base.md"),
    modelChoices: readBridgeListEnv("MODEL_CHOICES"),
    codexModelChoices: readBridgeListEnv("CODEX_MODEL_CHOICES"),
    claudeCommand: readBridgeTextEnv("CLAUDE_COMMAND") || "claude",
    claudeModel: readBridgeTextEnv("CLAUDE_MODEL") || "",
    claudeModelChoices: readBridgeListEnv("CLAUDE_MODEL_CHOICES"),
    claudeContextWindow: readBridgeIntEnv("CLAUDE_CONTEXT_WINDOW"),
    claudeMaxOutputTokens: readIntEnv("CLAUDE_CODE_MAX_OUTPUT_TOKENS"),
    claudeAutoCompactEnabled: readBridgeOptionalBoolEnv("CLAUDE_AUTO_COMPACT") ?? true,
    claudeAutoCompactThresholdPercent: readBridgeIntEnv("CLAUDE_AUTO_COMPACT_THRESHOLD_PERCENT") || 85,
    claudeAutoCompactMinIntervalMs: readBridgeIntEnv("CLAUDE_AUTO_COMPACT_MIN_INTERVAL_MS") || 30 * 60 * 1000,
    claudePermissionMode: readBridgeTextEnv("CLAUDE_PERMISSION_MODE") || "default",
    claudeBare: readBridgeOptionalBoolEnv("CLAUDE_BARE") ?? false,
    claudeAppendSystemPrompt: readBridgeTextEnv("CLAUDE_APPEND_SYSTEM_PROMPT"),
    claudeDisableVerbose: readBridgeBoolEnv("CLAUDE_DISABLE_VERBOSE"),
    claudeExtraArgs: readBridgeListEnv("CLAUDE_EXTRA_ARGS"),
    sessionsFile: path.join(stateDir, "sessions.json"),
    startWithCheckin: (mode === "start" && hasArgFlag(argv, "--checkin")) || readBridgeBoolEnv("ENABLE_CHECKIN"),
    startWithDreaming: (mode === "start" && hasArgFlag(argv, "--dreaming")) || readBridgeBoolEnv("ENABLE_DREAMING"),
    dreamingPollIntervalMinutes: readBridgeIntEnv("DREAMING_POLL_INTERVAL_MINUTES") || 15,
    dreamingQuietMinutes: readBridgeIntEnv("DREAMING_QUIET_MINUTES") || 45,
    dreamingRetryMinutes: readBridgeIntEnv("DREAMING_RETRY_MINUTES") || 20,
    dreamingWindowHours: readBridgeIntEnv("DREAMING_WINDOW_HOURS") || 24,
    dreamingMaxSourceRecords: readBridgeIntEnv("DREAMING_MAX_SOURCE_RECORDS") || 24,
    dreamingMinSourceRecords: readBridgeIntEnv("DREAMING_MIN_SOURCE_RECORDS") || 2,
    asherieDataRoot,
    asherieTruthLayerDir: readTextEnv("MOSSBRIDGE_ASHERIE_TRUTH_LAYER_DIR"),
    asherieMemoryTreeDir: readTextEnv("MOSSBRIDGE_ASHERIE_MEMORY_TREE_DIR"),
    asherieCaseIndexDir: readTextEnv("MOSSBRIDGE_ASHERIE_CASE_INDEX_DIR"),
    asherieObservationJournalDir: readTextEnv("MOSSBRIDGE_ASHERIE_OBSERVATION_JOURNAL_DIR"),
    asherieEpisodeJournalDir: readTextEnv("MOSSBRIDGE_ASHERIE_EPISODE_JOURNAL_DIR"),
    asherieSolitudeJournalDir: readTextEnv("MOSSBRIDGE_ASHERIE_SOLITUDE_JOURNAL_DIR"),
    asherieNotionSyncDir: readTextEnv("MOSSBRIDGE_ASHERIE_NOTION_SYNC_DIR"),
    asherieAppDailyCaptureDir: readTextEnv("MOSSBRIDGE_ASHERIE_APP_DAILY_CAPTURE_DIR"),
    asherieWarmMemoryDir: readTextEnv("MOSSBRIDGE_ASHERIE_WARM_MEMORY_DIR"),
    asherieMemoryVersionBankDir: readTextEnv("MOSSBRIDGE_ASHERIE_MEMORY_VERSION_BANK_DIR"),
    asherieContextCacheLimit: readBridgeIntEnv("ASHERIE_CONTEXT_CACHE_LIMIT") || 50,
    asherieProactiveContextCacheLimit: readBridgeIntEnv("ASHERIE_PROACTIVE_CONTEXT_CACHE_LIMIT") || 50,
    asherieRecallRecentRecordLimit: readBridgeIntEnv("ASHERIE_RECALL_RECENT_RECORD_LIMIT") || 8,
    asheriePreludeWarmLimit: readBridgeIntEnv("ASHERIE_PRELUDE_WARM_LIMIT") || 6,
    asheriePreludeResidentWarmLimit: readBridgeIntEnv("ASHERIE_PRELUDE_RESIDENT_WARM_LIMIT") || 5,
    asheriePreludeAmbientWarmLimit: readBridgeIntEnv("ASHERIE_PRELUDE_AMBIENT_WARM_LIMIT") || 2,
    asheriePreludeOngoingLimit: readBridgeIntEnv("ASHERIE_PRELUDE_ONGOING_LIMIT") || 5,
    asheriePreludeOngoingShadowLimit: readBridgeIntEnv("ASHERIE_PRELUDE_ONGOING_SHADOW_LIMIT") || 6,
    asheriePreludeObservationLimit: readBridgeIntEnv("ASHERIE_PRELUDE_OBSERVATION_LIMIT") || 4,
    asheriePreludeHotUpstreamLimit: readBridgeIntEnv("ASHERIE_PRELUDE_HOT_UPSTREAM_LIMIT") || 4,
    asheriePreludeHotTurnLimit: readBridgeIntEnv("ASHERIE_PRELUDE_HOT_TURN_LIMIT") || 6,
    asheriePreludeHotSnapshotLimit: readBridgeIntEnv("ASHERIE_PRELUDE_HOT_SNAPSHOT_LIMIT") || 2,
    asheriePreludeLocalArchiveLimit: readBridgeIntEnv("ASHERIE_PRELUDE_LOCAL_ARCHIVE_LIMIT") || 2,
    asheriePreludeRecentSnippetLimit: readBridgeIntEnv("ASHERIE_PRELUDE_RECENT_SNIPPET_LIMIT") || 8,
    asheriePreludeRecentThreadLimit: readBridgeIntEnv("ASHERIE_PRELUDE_RECENT_THREAD_LIMIT") || 8,
  };
}

function readBridgeTextEnv(suffix) {
  return readTextEnv(`MOSSBRIDGE_${suffix}`);
}

function readBridgeListEnv(suffix) {
  return readListEnv(`MOSSBRIDGE_${suffix}`);
}

function readBridgeBoolEnv(suffix) {
  return readBoolEnv(`MOSSBRIDGE_${suffix}`);
}

function readBridgeOptionalBoolEnv(suffix) {
  return readOptionalBoolEnv(`MOSSBRIDGE_${suffix}`);
}

function readBridgeIntEnv(suffix) {
  return readIntEnv(`MOSSBRIDGE_${suffix}`);
}

function readBridgeNumberEnv(suffix) {
  return readNumberEnv(`MOSSBRIDGE_${suffix}`);
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

function readNumberEnv(name) {
  const value = readTextEnv(name);
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
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
  const fromJson = parseKnownPlacesJson(readTextEnv("MOSSBRIDGE_LOCATION_KNOWN_PLACES"));
  const fromCenters = [
    parseKnownPlaceCenter("home", readTextEnv("MOSSBRIDGE_LOCATION_HOME_CENTER")),
    parseKnownPlaceCenter("work", readTextEnv("MOSSBRIDGE_LOCATION_WORK_CENTER")),
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
