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

module.exports = {
  buildCodexMcpConfigArgs,
  normalizeToolProfile,
  resolveCodexProjectToolMcpServerConfig,
};
