const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ensureClaudeProjectMcpConfig,
  buildClaudeProjectMcpServerConfig,
} = require("../src/adapters/runtime/claudecode/project-settings");

test("ensureClaudeProjectMcpConfig upserts asheriebridge MCP server into workspace .mcp.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-claude-settings-"));
  const workspaceRoot = path.join(root, "workspace");
  const asheriebridgeHome = path.join(root, "asheriebridge-home");
  const configPath = path.join(workspaceRoot, ".mcp.json");

  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(asheriebridgeHome, "bin"), { recursive: true });
  fs.writeFileSync(path.join(asheriebridgeHome, "bin", "asheriebridge.js"), "#!/usr/bin/env node\n", "utf8");
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      other: {
        command: "uvx",
        args: ["other"],
      },
    },
  }, null, 2));

  const result = ensureClaudeProjectMcpConfig({ workspaceRoot, asheriebridgeHome });
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.equal(result.configPath, configPath);
  assert.deepEqual(saved.mcpServers.other, {
    command: "uvx",
    args: ["other"],
  });
  assert.deepEqual(saved.mcpServers.asheriebridge_tools, buildClaudeProjectMcpServerConfig({
    workspaceRoot,
    asheriebridgeHome,
  }));
});

test("ensureClaudeProjectMcpConfig rewrites stale asheriebridge MCP server config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-claude-settings-stale-"));
  const workspaceRoot = path.join(root, "workspace");
  const asheriebridgeHome = path.join(root, "asheriebridge-home");
  const configPath = path.join(workspaceRoot, ".mcp.json");

  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(asheriebridgeHome, "bin"), { recursive: true });
  fs.writeFileSync(path.join(asheriebridgeHome, "bin", "asheriebridge.js"), "#!/usr/bin/env node\n", "utf8");
  fs.writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      asheriebridge_tools: {
        command: "node",
        args: ["old.js"],
      },
    },
  }, null, 2));

  ensureClaudeProjectMcpConfig({ workspaceRoot, asheriebridgeHome });

  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(saved.mcpServers.asheriebridge_tools, buildClaudeProjectMcpServerConfig({
    workspaceRoot,
    asheriebridgeHome,
  }));
});
