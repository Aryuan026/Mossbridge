const fs = require("fs");
const path = require("path");
const {
  listProjectToolNames,
  normalizeToolProfile,
  TOOL_PROFILE_CHECKIN_LITE,
} = require("../../../tools/tool-host");

function resolveCodexProjectToolMcpServerConfig({ mossbridgeHome = "", toolProfile = "" } = {}) {
  const home = normalizeNonEmptyString(mossbridgeHome)
    || process.env.MOSSBRIDGE_HOME
    || path.resolve(__dirname, "..", "..", "..", "..");
  const scriptPath = path.join(home, "bin", "mossbridge.js");
  if (!fs.existsSync(scriptPath)) {
    return null;
  }
  const normalizedToolProfile = normalizeToolProfile(toolProfile || process.env.MOSSBRIDGE_TOOL_PROFILE || "foreground");
  if (normalizedToolProfile === TOOL_PROFILE_CHECKIN_LITE) {
    return null;
  }
  return {
    name: "mossbridge_tools",
    command: process.execPath,
    toolProfile: normalizedToolProfile,
    env: resolveProjectToolMcpEnv(process.env),
    args: [
      scriptPath,
      "tool-mcp-server",
      "--runtime-id",
      "codex",
      "--tool-profile",
      normalizedToolProfile,
    ],
  };
}

function buildCodexMcpConfigArgs(mcpServerConfig) {
  if (!mcpServerConfig || typeof mcpServerConfig !== "object") {
    return [];
  }
  const name = normalizeNonEmptyString(mcpServerConfig.name) || "mossbridge_tools";
  const command = normalizeNonEmptyString(mcpServerConfig.command);
  const args = Array.isArray(mcpServerConfig.args)
    ? mcpServerConfig.args.map((value) => normalizeNonEmptyString(value)).filter(Boolean)
    : [];
  const env = normalizeEnvMap(mcpServerConfig.env);
  if (!command) {
    return [];
  }
  const toolProfile = normalizeToolProfile(mcpServerConfig.toolProfile || "foreground");
  const configArgs = [
    "-c",
    `mcp_servers.${name}.command=${quoteTomlString(command)}`,
    "-c",
    `mcp_servers.${name}.args=${formatTomlArray(args)}`,
  ];
  for (const [key, value] of Object.entries(env)) {
    configArgs.push(
      "-c",
      `mcp_servers.${name}.env.${key}=${quoteTomlString(value)}`,
    );
  }
  for (const toolName of listProjectToolNames({ toolProfile })) {
    configArgs.push(
      "-c",
      `mcp_servers.${name}.tools.${toolName}.approval_mode=${quoteTomlString("auto")}`,
    );
  }
  return configArgs;
}

function quoteTomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function formatTomlArray(values) {
  return `[${values.map((value) => quoteTomlString(value)).join(",")}]`;
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

const TOOL_MCP_ENV_ALLOWLIST = [
  "MOSSBRIDGE_ENV_FILE",
  "MOSSBRIDGE_HOME",
  "MOSSBRIDGE_STATE_DIR",
  "MOSSBRIDGE_DATA_ROOT",
  "MOSSBRIDGE_WORKSPACE_ID",
  "MOSSBRIDGE_WORKSPACE_ROOT",
  "MOSSBRIDGE_WORKSPACE_INBOX_DIR",
  "MOSSBRIDGE_WORKSPACE_ATTACHMENT_NOTES_DIR",
  "MOSSBRIDGE_WORKSPACE_ATTACHMENT_JOURNAL_FILE",
  "MOSSBRIDGE_ACCOUNT_ID",
  "MOSSBRIDGE_CHANNEL",
  "MOSSBRIDGE_RUNTIME",
  "MOSSBRIDGE_NOTEBOOK_DIR",
  "MOSSBRIDGE_DIARY_DIR",
  "MOSSBRIDGE_STICKERS_DIR",
  "MOSSBRIDGE_STICKER_ASSETS_DIR",
  "MOSSBRIDGE_STICKERS_INDEX_FILE",
  "MOSSBRIDGE_STICKER_TAGS_FILE",
  "MOSSBRIDGE_CHANNEL_FILE_MAX_BYTES",
  "MOSSBRIDGE_CHANNEL_FILE_SEND_TIMEOUT_MS",
  "MOSSBRIDGE_CHANNEL_FILE_ALLOWED_ROOTS",
  "MOSSBRIDGE_WEIXIN_BASE_URL",
  "MOSSBRIDGE_WEIXIN_CDN_BASE_URL",
  "MOSSBRIDGE_IDENTITY_USER_ID",
  "MOSSBRIDGE_IDENTITY_REALM_ID",
  "MOSSBRIDGE_IDENTITY_AGENT_ID",
  "MOSSBRIDGE_ASHERIE_TRUTH_LAYER_DIR",
  "MOSSBRIDGE_ASHERIE_MEMORY_TREE_DIR",
  "MOSSBRIDGE_ASHERIE_CASE_INDEX_DIR",
  "MOSSBRIDGE_ASHERIE_OBSERVATION_JOURNAL_DIR",
  "MOSSBRIDGE_ASHERIE_EPISODE_JOURNAL_DIR",
  "MOSSBRIDGE_ASHERIE_SOLITUDE_JOURNAL_DIR",
  "MOSSBRIDGE_ASHERIE_APP_DAILY_CAPTURE_DIR",
  "MOSSBRIDGE_ASHERIE_WARM_MEMORY_DIR",
  "MOSSBRIDGE_ASHERIE_MEMORY_VERSION_BANK_DIR",
  "TIMELINE_FOR_AGENT_STATE_DIR",
  "TIMELINE_FOR_AGENT_CHROME_PATH",
];

function resolveProjectToolMcpEnv(sourceEnv = process.env) {
  const env = {};
  for (const key of TOOL_MCP_ENV_ALLOWLIST) {
    const value = normalizeNonEmptyString(sourceEnv?.[key]);
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

function normalizeEnvMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const env = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeEnvKey(rawKey);
    const text = normalizeNonEmptyString(rawValue);
    if (!key || !text) {
      continue;
    }
    if (isSensitiveEnvKey(key)) {
      continue;
    }
    env[key] = text;
  }
  return env;
}

function normalizeEnvKey(value) {
  const key = normalizeNonEmptyString(value);
  return /^[A-Z_][A-Z0-9_]*$/u.test(key) ? key : "";
}

function isSensitiveEnvKey(key) {
  return /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|COOKIE|AUTHORIZATION|PRIVATE[_-]?KEY)/iu.test(key);
}

module.exports = {
  buildCodexMcpConfigArgs,
  normalizeToolProfile,
  resolveCodexProjectToolMcpServerConfig,
  resolveProjectToolMcpEnv,
};
