const fs = require("fs");
const path = require("path");

const TOOL_PROFILE_FULL = "full";
const TOOL_PROFILE_FOREGROUND = "foreground";
const TOOL_PROFILE_TASK = "task";
const TOOL_PROFILE_CHECKIN_LITE = "checkin_lite";

function ensureClaudeProjectMcpConfig({ workspaceRoot, mossbridgeHome = "", toolProfile = "" } = {}) {
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    throw new Error("workspaceRoot is required to configure Claude project tools.");
  }

  const normalizedToolProfile = normalizeToolProfile(toolProfile);
  cleanupDefaultClaudeProjectMcpConfig({ workspaceRoot: normalizedWorkspaceRoot });
  if (normalizedToolProfile === TOOL_PROFILE_CHECKIN_LITE) {
    return ensureClaudeLiteMcpConfig({ workspaceRoot: normalizedWorkspaceRoot });
  }
  return ensureClaudeProfileMcpConfig({
    workspaceRoot: normalizedWorkspaceRoot,
    mossbridgeHome,
    toolProfile: normalizedToolProfile,
  });
}

function ensureClaudeProfileMcpConfig({ workspaceRoot, mossbridgeHome = "", toolProfile = TOOL_PROFILE_FOREGROUND } = {}) {
  const normalizedToolProfile = normalizeToolProfile(toolProfile);
  const configPath = path.join(workspaceRoot, `.mcp.mossbridge-${normalizedToolProfile}.json`);
  const current = readJsonObject(configPath);
  const next = {
    ...current,
    mcpServers: {
      ...(current.mcpServers && typeof current.mcpServers === "object" ? current.mcpServers : {}),
      mossbridge_tools: buildClaudeProjectMcpServerConfig({
        workspaceRoot,
        mossbridgeHome,
        toolProfile: normalizedToolProfile,
      }),
    },
  };

  if (!jsonEquals(current, next)) {
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  }

  return {
    configPath,
    serverName: "mossbridge_tools",
    toolProfile: normalizedToolProfile,
    config: next,
  };
}

function ensureClaudeLiteMcpConfig({ workspaceRoot } = {}) {
  const configPath = path.join(workspaceRoot, ".mcp.mossbridge-checkin-lite.json");
  const next = {
    mcpServers: {},
  };
  const current = readJsonObject(configPath);
  if (!jsonEquals(current, next)) {
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  }
  return {
    configPath,
    serverName: "(none)",
    toolProfile: TOOL_PROFILE_CHECKIN_LITE,
    config: next,
  };
}

function buildClaudeProjectMcpServerConfig({ workspaceRoot, mossbridgeHome = "", toolProfile = "" } = {}) {
  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  const normalizedToolProfile = normalizeToolProfile(toolProfile);
  const home = normalizeText(mossbridgeHome)
    || process.env.MOSSBRIDGE_HOME
    || path.resolve(__dirname, "..", "..", "..", "..");
  const scriptPath = path.join(home, "bin", "mossbridge.js");
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Mossbridge MCP entrypoint not found: ${scriptPath}`);
  }
  return {
    command: process.execPath,
    args: [
      scriptPath,
      "tool-mcp-server",
      "--runtime-id",
      "claudecode",
      "--workspace-root",
      normalizedWorkspaceRoot,
      "--tool-profile",
      normalizedToolProfile,
    ],
  };
}

function cleanupDefaultClaudeProjectMcpConfig({ workspaceRoot } = {}) {
  const configPath = path.join(workspaceRoot, ".mcp.json");
  const current = readJsonObject(configPath);
  const servers = current.mcpServers && typeof current.mcpServers === "object"
    ? { ...current.mcpServers }
    : null;
  if (!servers || !Object.prototype.hasOwnProperty.call(servers, "mossbridge_tools")) {
    return;
  }
  delete servers.mossbridge_tools;
  const next = {
    ...current,
    mcpServers: servers,
  };
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n", "utf8");
}

function readJsonObject(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // ignore
  }
  return {};
}

function jsonEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeToolProfile(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === TOOL_PROFILE_CHECKIN_LITE) {
    return TOOL_PROFILE_CHECKIN_LITE;
  }
  if (normalized === TOOL_PROFILE_FULL || normalized === "maintenance" || normalized === "dreaming") {
    return TOOL_PROFILE_FULL;
  }
  if (normalized === TOOL_PROFILE_TASK || normalized === "case") {
    return TOOL_PROFILE_TASK;
  }
  return TOOL_PROFILE_FOREGROUND;
}

module.exports = {
  ensureClaudeProjectMcpConfig,
  buildClaudeProjectMcpServerConfig,
  normalizeToolProfile,
  TOOL_PROFILE_CHECKIN_LITE,
  TOOL_PROFILE_FOREGROUND,
  TOOL_PROFILE_FULL,
  TOOL_PROFILE_TASK,
};
