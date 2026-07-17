const fs = require("fs");
const path = require("path");

const CODEX_MCP_TRANSPORT_RECOVERY_SCHEMA = "codex_mcp_transport_recovery.v1";
const CODEX_MCP_TRANSPORT_RECOVERY_REASON = "transport_closed_before_toolhost";

function isCodexMcpTransportFailureText(text) {
  const normalized = normalizeText(text);
  if (!normalized || normalized.length > 1_000) {
    return false;
  }
  if (normalized.toLowerCase() === "transport closed") {
    return true;
  }
  const hasToolFailureContext = /(?:tool call error|tool call failed|tools\/call|mcp)/iu.test(normalized);
  if (!hasToolFailureContext) {
    return false;
  }
  return /(?:transport (?:closed|send error|receive error)|broken pipe|connection reset|timed out awaiting tools\/call)/iu.test(normalized);
}

function createCodexMcpTransportRecoveryRequester({ filePath = "", now = () => new Date() } = {}) {
  const normalizedPath = normalizeText(filePath);
  return function requestCodexMcpTransportRecovery() {
    if (!normalizedPath) {
      return {
        requested: false,
        reason: "shared_supervisor_unavailable",
      };
    }

    const payload = {
      schema_version: CODEX_MCP_TRANSPORT_RECOVERY_SCHEMA,
      reason: CODEX_MCP_TRANSPORT_RECOVERY_REASON,
      requested_at: now().toISOString(),
      action_replay_allowed: false,
      tool_outcome_reached: false,
      request_contains_tool_arguments: false,
      request_contains_user_text: false,
    };
    fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
    const tempPath = `${normalizedPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, normalizedPath);
    return {
      requested: true,
      reason: CODEX_MCP_TRANSPORT_RECOVERY_REASON,
    };
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  CODEX_MCP_TRANSPORT_RECOVERY_REASON,
  CODEX_MCP_TRANSPORT_RECOVERY_SCHEMA,
  createCodexMcpTransportRecoveryRequester,
  isCodexMcpTransportFailureText,
};
