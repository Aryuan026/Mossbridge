const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  ensureClaudeProjectMcpConfig,
  buildClaudeProjectMcpServerConfig,
} = require("../src/adapters/runtime/claudecode/project-settings");

test("ensureClaudeProjectMcpConfig writes foreground MCP profile and keeps default config clean", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-claude-settings-"));
  const workspaceRoot = path.join(root, "workspace");
  const mossbridgeHome = path.join(root, "mossbridge-home");
  const defaultConfigPath = path.join(workspaceRoot, ".mcp.json");
  const profileConfigPath = path.join(workspaceRoot, ".mcp.mossbridge-foreground.json");

  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(mossbridgeHome, "bin"), { recursive: true });
  fs.writeFileSync(path.join(mossbridgeHome, "bin", "mossbridge.js"), "#!/usr/bin/env node\n", "utf8");
  fs.writeFileSync(defaultConfigPath, JSON.stringify({
    mcpServers: {
      other: {
        command: "uvx",
        args: ["other"],
      },
    },
  }, null, 2));

  const result = ensureClaudeProjectMcpConfig({ workspaceRoot, mossbridgeHome });
  const saved = JSON.parse(fs.readFileSync(profileConfigPath, "utf8"));
  const defaultSaved = JSON.parse(fs.readFileSync(defaultConfigPath, "utf8"));

  assert.equal(result.configPath, profileConfigPath);
  assert.equal(result.toolProfile, "foreground");
  assert.deepEqual(defaultSaved.mcpServers.other, {
    command: "uvx",
    args: ["other"],
  });
  assert.equal(defaultSaved.mcpServers.mossbridge_tools, undefined);
  assert.deepEqual(saved.mcpServers.mossbridge_tools, buildClaudeProjectMcpServerConfig({
    workspaceRoot,
    mossbridgeHome,
    toolProfile: "foreground",
  }));
});

test("ensureClaudeProjectMcpConfig removes stale default bridge server and rewrites profile config", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-claude-settings-stale-"));
  const workspaceRoot = path.join(root, "workspace");
  const mossbridgeHome = path.join(root, "mossbridge-home");
  const defaultConfigPath = path.join(workspaceRoot, ".mcp.json");
  const profileConfigPath = path.join(workspaceRoot, ".mcp.mossbridge-foreground.json");

  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(mossbridgeHome, "bin"), { recursive: true });
  fs.writeFileSync(path.join(mossbridgeHome, "bin", "mossbridge.js"), "#!/usr/bin/env node\n", "utf8");
  fs.writeFileSync(defaultConfigPath, JSON.stringify({
    mcpServers: {
      mossbridge_tools: {
        command: "node",
        args: ["old.js"],
      },
    },
  }, null, 2));

  ensureClaudeProjectMcpConfig({ workspaceRoot, mossbridgeHome });

  const defaultSaved = JSON.parse(fs.readFileSync(defaultConfigPath, "utf8"));
  const saved = JSON.parse(fs.readFileSync(profileConfigPath, "utf8"));
  assert.equal(defaultSaved.mcpServers.mossbridge_tools, undefined);
  assert.deepEqual(saved.mcpServers.mossbridge_tools, buildClaudeProjectMcpServerConfig({
    workspaceRoot,
    mossbridgeHome,
    toolProfile: "foreground",
  }));
});

test("ensureClaudeProjectMcpConfig creates a no-tool config for lightweight checkins", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-claude-settings-lite-"));
  const workspaceRoot = path.join(root, "workspace");
  const mossbridgeHome = path.join(root, "mossbridge-home");
  const defaultConfigPath = path.join(workspaceRoot, ".mcp.json");
  const liteConfigPath = path.join(workspaceRoot, ".mcp.mossbridge-checkin-lite.json");

  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(mossbridgeHome, "bin"), { recursive: true });
  fs.writeFileSync(path.join(mossbridgeHome, "bin", "mossbridge.js"), "#!/usr/bin/env node\n", "utf8");
  fs.writeFileSync(defaultConfigPath, JSON.stringify({
    mcpServers: {
      other: {
        command: "uvx",
        args: ["other"],
      },
    },
  }, null, 2));

  const result = ensureClaudeProjectMcpConfig({
    workspaceRoot,
    mossbridgeHome,
    toolProfile: "checkin_lite",
  });
  const saved = JSON.parse(fs.readFileSync(liteConfigPath, "utf8"));
  const defaultSaved = JSON.parse(fs.readFileSync(defaultConfigPath, "utf8"));

  assert.equal(result.configPath, liteConfigPath);
  assert.equal(result.toolProfile, "checkin_lite");
  assert.deepEqual(saved, { mcpServers: {} });
  assert.deepEqual(defaultSaved.mcpServers.other, {
    command: "uvx",
    args: ["other"],
  });
  assert.equal(defaultSaved.mcpServers.mossbridge_tools, undefined);
});
