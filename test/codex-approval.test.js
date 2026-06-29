const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { MossbridgeApp } = require("../src/core/app");
const { mapCodexMessageToRuntimeEvent } = require("../src/adapters/runtime/codex/events");
const {
  buildCodexMcpConfigArgs,
  resolveCodexProjectToolMcpServerConfig,
  resolveProjectToolMcpEnv,
} = require("../src/adapters/runtime/codex/mcp-config");

test("codex MCP config auto-approves foreground mossbridge tools by default", () => {
  const args = buildCodexMcpConfigArgs({
    name: "mossbridge_tools",
    command: "/usr/bin/node",
    args: ["/workspace/bin/mossbridge.js", "tool-mcp-server"],
  });

  assert.deepEqual(args.slice(0, 4), [
    "-c",
    "mcp_servers.mossbridge_tools.command=\"/usr/bin/node\"",
    "-c",
    "mcp_servers.mossbridge_tools.args=[\"/workspace/bin/mossbridge.js\",\"tool-mcp-server\"]",
  ]);
  assert.match(
    args.join("\n"),
    /mcp_servers\.mossbridge_tools\.tools\.mossbridge_channel_send_file\.approval_mode="auto"/
  );
  assert.match(
    args.join("\n"),
    /mcp_servers\.mossbridge_tools\.tools\.mossbridge_reminder_create\.approval_mode="auto"/
  );
  assert.doesNotMatch(
    args.join("\n"),
    /mcp_servers\.mossbridge_tools\.tools\.mossbridge_timeline_screenshot\.approval_mode="auto"/
  );
  assert.doesNotMatch(
    args.join("\n"),
    /mcp_servers\.mossbridge_tools\.tools\.whereabouts_snapshot\.approval_mode="auto"/
  );
});

test("codex lightweight checkins do not attach the project MCP server", () => {
  assert.equal(
    resolveCodexProjectToolMcpServerConfig({ toolProfile: "checkin_lite" }),
    null,
  );
});

test("codex project MCP server config inherits safe runtime env", () => {
  const previous = {
    MOSSBRIDGE_STATE_DIR: process.env.MOSSBRIDGE_STATE_DIR,
    MOSSBRIDGE_DATA_ROOT: process.env.MOSSBRIDGE_DATA_ROOT,
    MOSSBRIDGE_ACCOUNT_ID: process.env.MOSSBRIDGE_ACCOUNT_ID,
    MOSSBRIDGE_CODEX_API_KEY: process.env.MOSSBRIDGE_CODEX_API_KEY,
  };
  process.env.MOSSBRIDGE_STATE_DIR = "/srv/mossbridge/state";
  process.env.MOSSBRIDGE_DATA_ROOT = "/srv/mossbridge/data";
  process.env.MOSSBRIDGE_ACCOUNT_ID = "account-1";
  process.env.MOSSBRIDGE_CODEX_API_KEY = "secret";

  try {
    const config = resolveCodexProjectToolMcpServerConfig({
      mossbridgeHome: path.resolve(__dirname, ".."),
      toolProfile: "foreground",
    });

    assert.equal(config.env.MOSSBRIDGE_STATE_DIR, "/srv/mossbridge/state");
    assert.equal(config.env.MOSSBRIDGE_DATA_ROOT, "/srv/mossbridge/data");
    assert.equal(config.env.MOSSBRIDGE_ACCOUNT_ID, "account-1");
    assert.equal(config.env.MOSSBRIDGE_CODEX_API_KEY, undefined);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("codex MCP config passes safe mossbridge env to project tool subprocesses", () => {
  const args = buildCodexMcpConfigArgs({
    name: "mossbridge_tools",
    command: "/usr/bin/node",
    args: ["/workspace/bin/mossbridge.js", "tool-mcp-server"],
    env: {
      MOSSBRIDGE_ENV_FILE: "/etc/mossbridge/mossbridge.env",
      MOSSBRIDGE_STATE_DIR: "/srv/mossbridge/state",
      MOSSBRIDGE_ACCOUNT_ID: "wechat-account-1",
      MOSSBRIDGE_DATA_ROOT: "/srv/mossbridge/data",
      MOSSBRIDGE_STICKERS_DIR: "/srv/mossbridge/data/storage/stickers",
      MOSSBRIDGE_IDENTITY_AGENT_ID: "moss",
      MOSSBRIDGE_CODEX_API_KEY: "secret",
      MOSSBRIDGE_LOCATION_TOKEN: "secret",
      PUBLIC_API_KEYS: "secret",
      BAD_KEY: "",
      "not-valid": "/tmp/nope",
    },
  });
  const joined = args.join("\n");

  assert.match(joined, /mcp_servers\.mossbridge_tools\.env\.MOSSBRIDGE_ENV_FILE="\/etc\/mossbridge\/mossbridge\.env"/);
  assert.match(joined, /mcp_servers\.mossbridge_tools\.env\.MOSSBRIDGE_STATE_DIR="\/srv\/mossbridge\/state"/);
  assert.match(joined, /mcp_servers\.mossbridge_tools\.env\.MOSSBRIDGE_ACCOUNT_ID="wechat-account-1"/);
  assert.match(joined, /mcp_servers\.mossbridge_tools\.env\.MOSSBRIDGE_DATA_ROOT="\/srv\/mossbridge\/data"/);
  assert.match(joined, /mcp_servers\.mossbridge_tools\.env\.MOSSBRIDGE_STICKERS_DIR="\/srv\/mossbridge\/data\/storage\/stickers"/);
  assert.match(joined, /mcp_servers\.mossbridge_tools\.env\.MOSSBRIDGE_IDENTITY_AGENT_ID="moss"/);
  assert.doesNotMatch(joined, /CODEX_API_KEY/);
  assert.doesNotMatch(joined, /LOCATION_TOKEN/);
  assert.doesNotMatch(joined, /PUBLIC_API_KEYS/);
  assert.doesNotMatch(joined, /not-valid/);
});

test("codex MCP env resolver keeps runtime paths but excludes secrets", () => {
  const env = resolveProjectToolMcpEnv({
    MOSSBRIDGE_STATE_DIR: "/srv/mossbridge/state",
    MOSSBRIDGE_ACCOUNT_ID: "account-1",
    MOSSBRIDGE_DATA_ROOT: "/srv/mossbridge/data",
    MOSSBRIDGE_IDENTITY_USER_ID: "owner",
    MOSSBRIDGE_CODEX_API_KEY: "secret",
    MOSSBRIDGE_LOCATION_TOKEN: "secret",
  });

  assert.deepEqual(env, {
    MOSSBRIDGE_STATE_DIR: "/srv/mossbridge/state",
    MOSSBRIDGE_DATA_ROOT: "/srv/mossbridge/data",
    MOSSBRIDGE_ACCOUNT_ID: "account-1",
    MOSSBRIDGE_IDENTITY_USER_ID: "owner",
  });
});

test("codex MCP elicitation approvals map to runtime approval events", () => {
  const event = mapCodexMessageToRuntimeEvent({
    id: "req-mcp-1",
    method: "mcpServer/elicitation/request",
    params: {
      serverName: "mossbridge_tools",
      threadId: "thread-1",
      turnId: "turn-1",
      mode: "form",
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        persist: ["session", "always"],
        tool_description: "Create a reminder in Mossbridge. Input: { text: string, delayMinutes?: integer }",
        tool_params_display: [
          { name: "delayMinutes", display_name: "delayMinutes", value: 5 },
          { name: "text", display_name: "text", value: "hello" },
        ],
      },
      message: "Allow the mossbridge_tools MCP server to run tool \"mossbridge_reminder_create\"?",
      requestedSchema: {
        type: "object",
        properties: {},
      },
    },
  });

  assert.equal(event.type, "runtime.approval.requested");
  assert.equal(event.payload.kind, "mcp_tool_call");
  assert.equal(event.payload.threadId, "thread-1");
  assert.deepEqual(event.payload.commandTokens, ["mcp_tool", "mossbridge_tools", "mossbridge_reminder_create"]);
  assert.equal(event.payload.command, "mossbridge_reminder_create\ndelayMinutes: 5\ntext: hello");
  assert.deepEqual(event.payload.responseTemplate.supportedCommands, ["yes", "no"]);
  assert.deepEqual(event.payload.responseTemplate.responseByCommand.yes, {
    action: "accept",
  });
  assert.equal(event.payload.elicitation.approvalKind, "mcp_tool_call");
  assert.deepEqual(event.payload.elicitation.persistScopes, ["session", "always"]);
  assert.deepEqual(event.payload.elicitation.toolParamsDisplay, [
    { name: "delayMinutes", displayName: "delayMinutes", value: 5 },
    { name: "text", displayName: "text", value: "hello" },
  ]);
  assert.deepEqual(event.payload.responseTemplate.responseByCommand.no, {
    action: "cancel",
  });
});

test("handleRuntimeEvent auto-approves project-native Codex MCP elicitation approvals", async () => {
  const responses = [];
  const appLike = {
    config: { stateDir: "/tmp/mossbridge-test-state" },
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot: "/workspace" };
          },
          getApprovalPromptState() {
            return null;
          },
          rememberApprovalPrompt() {},
          getApprovalCommandAllowlistForWorkspace() {
            return [];
          },
        };
      },
      async respondApproval(payload) {
        responses.push(payload);
      },
    },
    threadStateStore: {
      resolveApproval() {},
    },
    async sendApprovalPrompt() {
      throw new Error("should not prompt for project-native Codex MCP tools");
    },
  };

  await MossbridgeApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      kind: "mcp_elicitation",
      elicitation: {
        approvalKind: "mcp_tool_call",
      },
      threadId: "thread-1",
      requestId: "req-project-tool",
      commandTokens: ["mcp_tool", "mossbridge_tools", "mossbridge_reminder_create"],
      responseTemplate: {
        responseByCommand: {
          yes: {
            action: "accept",
          },
        },
      },
    },
  });

  assert.deepEqual(responses, [{
    requestId: "req-project-tool",
    result: {
      action: "accept",
    },
  }]);
});

test("handleApprovalCommand sends MCP elicitation responses back through the runtime", async () => {
  const responses = [];
  const sent = [];
  const approval = {
    kind: "mcp_tool_call",
    requestId: "req-ext-mcp",
    commandTokens: ["mcp_tool", "notes_server", "note_create"],
    responseTemplate: {
      supportedCommands: ["yes", "no"],
      responseByCommand: {
        yes: {
          action: "accept",
        },
        no: {
          action: "cancel",
        },
      },
    },
  };

  const appLike = {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      async respondApproval(payload) {
        responses.push(payload);
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          clearApprovalPrompt() {},
          rememberApprovalPrefixForWorkspace() {
            throw new Error("should not remember allowlists for MCP elicitation responses");
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return { pendingApproval: approval };
      },
      resolveApproval() {},
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await MossbridgeApp.prototype.handleApprovalCommand.call(
    appLike,
    { workspaceId: "workspace-id", accountId: "account-id", senderId: "user-1", contextToken: "ctx-1" },
    { name: "yes" },
  );

  assert.deepEqual(responses, [{
    requestId: "req-ext-mcp",
    result: {
      action: "accept",
    },
  }]);
  assert.deepEqual(sent, ["✅ This request has been approved."]);
});

test("handleApprovalCommand does not pretend to support persistent Codex MCP tool approval from WeChat", async () => {
  const responses = [];
  const sent = [];
  const approval = {
    kind: "mcp_tool_call",
    requestId: "req-ext-mcp",
    commandTokens: ["mcp_tool", "notes_server", "note_create"],
    responseTemplate: {
      supportedCommands: ["yes", "no"],
      responseByCommand: {
        yes: {
          action: "accept",
        },
        no: {
          action: "cancel",
        },
      },
    },
  };

  const appLike = {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      async respondApproval(payload) {
        responses.push(payload);
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          clearApprovalPrompt() {},
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return { pendingApproval: approval };
      },
      resolveApproval() {},
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await MossbridgeApp.prototype.handleApprovalCommand.call(
    appLike,
    { workspaceId: "workspace-id", accountId: "account-id", senderId: "user-1", contextToken: "ctx-1" },
    { name: "always" },
  );

  assert.deepEqual(responses, []);
  assert.deepEqual(sent, ["⚠️ Persistent approval for this Codex MCP tool request is not available from WeChat."]);
});
