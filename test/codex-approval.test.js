const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { MossbridgeApp } = require("../src/core/app");
const { SessionRefreshRequestStore } = require("../src/core/session-refresh-request-store");
const { mapCodexMessageToRuntimeEvent } = require("../src/adapters/runtime/codex/events");
const { readLatestCodexSessionTokenUsage } = require("../src/adapters/runtime/codex/session-usage");
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

test("codex token count events map current usage separately from cumulative totals", () => {
  const directEvent = mapCodexMessageToRuntimeEvent({
    type: "event_msg",
    payload: {
      type: "token_count",
      thread_id: "thread-direct",
      info: {
        thread_id: "thread-direct-info",
        model_context_window: 200000,
        last_token_usage: {
          input_tokens: 1200,
          cached_input_tokens: 300,
          output_tokens: 80,
          reasoning_output_tokens: 20,
          total_tokens: 1600,
        },
        total_token_usage: {
          input_tokens: 100000,
          cached_input_tokens: 90000,
          output_tokens: 8000,
          reasoning_output_tokens: 2000,
          total_tokens: 200000,
        },
      },
    },
  });

  assert.equal(directEvent.type, "runtime.context.updated");
  assert.equal(directEvent.payload.runtimeId, "codex");
  assert.equal(directEvent.payload.threadId, "thread-direct");
  assert.equal(directEvent.payload.currentTokens, 1600);
  assert.equal(directEvent.payload.contextWindow, 200000);
  assert.equal(directEvent.payload.cachedInputTokens, 300);
  assert.equal(directEvent.payload.reasoningTokens, 20);
  assert.equal(directEvent.payload.cumulativeTotalTokens, 200000);

  const rpcEvent = mapCodexMessageToRuntimeEvent({
    method: "event_msg",
    params: {
      msg: {
        type: "token_count",
        info: {
          thread_id: "thread-rpc",
          model_context_window: 200000,
          last_token_usage: {
            input_tokens: 5000,
            cached_input_tokens: 2000,
            output_tokens: 400,
            reasoning_output_tokens: 50,
            total_tokens: 7450,
          },
          total_token_usage: {
            input_tokens: 500000,
            cached_input_tokens: 200000,
            output_tokens: 40000,
            reasoning_output_tokens: 5000,
            total_tokens: 745000,
          },
        },
      },
    },
  });

  assert.equal(rpcEvent.type, "runtime.context.updated");
  assert.equal(rpcEvent.payload.threadId, "thread-rpc");
  assert.equal(rpcEvent.payload.currentTokens, 7450);
  assert.equal(rpcEvent.payload.cumulativeTotalTokens, 745000);
});

test("codex token count current context uses last usage, not cumulative session total", () => {
  const event = mapCodexMessageToRuntimeEvent({
    type: "event_msg",
    payload: {
      type: "token_count",
      thread_id: "thread-large-cumulative",
      info: {
        model_context_window: 258400,
        last_token_usage: {
          input_tokens: 237160,
          cached_input_tokens: 235392,
          output_tokens: 119,
          total_tokens: 237279,
        },
        total_token_usage: {
          input_tokens: 55000000,
          cached_input_tokens: 54000000,
          output_tokens: 416639,
          total_tokens: 55416639,
        },
      },
    },
  });

  assert.equal(event.payload.currentTokens, 237279);
  assert.equal(event.payload.cumulativeTotalTokens, 55416639);
});

test("codex session usage fallback reads latest token_count from session jsonl", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-codex-session-"));
  const threadId = "019f10de-9207-7542-aca5-258214d683d9";
  const sessionDir = path.join(tempRoot, "sessions", "2026", "06", "29");
  const sessionFile = path.join(sessionDir, `rollout-2026-06-29T08-54-09-${threadId}.jsonl`);
  try {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(sessionFile, [
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 100 }, model_context_window: 258400 } } }),
      JSON.stringify({
        timestamp: "2026-07-01T12:21:30.335Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 237160,
              cached_input_tokens: 235392,
              output_tokens: 119,
              total_tokens: 237279,
            },
            total_token_usage: {
              total_tokens: 55416639,
            },
            model_context_window: 258400,
          },
        },
      }),
    ].join("\n"));

    const usage = readLatestCodexSessionTokenUsage({ threadId, codexHome: tempRoot });

    assert.equal(usage.runtimeId, "codex");
    assert.equal(usage.threadId, threadId);
    assert.equal(usage.currentTokens, 237279);
    assert.equal(usage.contextWindow, 258400);
    assert.equal(usage.cumulativeTotalTokens, 55416639);
    assert.equal(usage.source, "codex_session_jsonl");
    assert.equal(usage.sourceFile, sessionFile);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("recordLatestRuntimeSessionContextUsage queues Codex jsonl pressure for the bound thread", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-codex-jsonl-pressure-"));
  const store = new SessionRefreshRequestStore({
    filePath: path.join(tempRoot, "session-refresh-requests.json"),
  });
  const recorded = [];
  const controlEvents = [];
  const appLike = {
    config: {
      sessionRefreshMinIntervalMs: 60_000,
    },
    sessionRefreshRequests: store,
    lastAutoSessionRefreshAtByScope: new Map(),
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
      getLatestContextUsage({ threadId }) {
        assert.equal(threadId, "thread-jsonl");
        return {
          runtimeId: "codex",
          threadId,
          currentTokens: 237279,
          contextWindow: 258400,
          source: "codex_session_jsonl",
        };
      },
      getSessionStore() {
        return {
          findBindingForThreadId(threadId) {
            assert.equal(threadId, "thread-jsonl");
            return {
              bindingKey: "binding-jsonl",
              workspaceRoot: "/workspace",
            };
          },
          getBinding(bindingKey) {
            assert.equal(bindingKey, "binding-jsonl");
            return { systemRuntimeBinding: false };
          },
        };
      },
    },
    runtimeContextUsageStore: {
      recordContext(snapshot) {
        recorded.push(snapshot);
      },
    },
    recordControlEvent(event) {
      controlEvents.push(event);
    },
    maybeQueueAutoSessionRefreshForPressure: MossbridgeApp.prototype.maybeQueueAutoSessionRefreshForPressure,
    pendingAutoCompactByThreadId: new Map(),
    lastAutoCompactAtByThreadId: new Map(),
    recordRuntimeContextUsage: MossbridgeApp.prototype.recordRuntimeContextUsage,
  };

  const usage = MossbridgeApp.prototype.recordLatestRuntimeSessionContextUsage.call(appLike, {
    type: "runtime.turn.completed",
    payload: {
      threadId: "thread-jsonl",
      turnId: "turn-jsonl",
    },
  });

  assert.equal(usage.currentTokens, 237279);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].runtimeId, "codex");
  assert.equal(recorded[0].threadId, "thread-jsonl");
  assert.equal(recorded[0].workspaceRoot, "/workspace");
  assert.equal(recorded[0].bindingKey, "binding-jsonl");
  assert.equal(recorded[0].source, "codex_session_jsonl");
  assert.equal(controlEvents[0].type, "runtime.context.session_refresh_queued");
  assert.equal(controlEvents[0].payload.refreshThresholdPercent, 76);
  assert.equal(store.getPendingRequest({
    bindingKey: "binding-jsonl",
    workspaceRoot: "/workspace",
    runtimeId: "codex",
  }).oldThreadId, "thread-jsonl");
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

test("handleApprovalCommand does not pretend to support persistent runtime MCP tool approval from WeChat", async () => {
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
  assert.deepEqual(sent, ["⚠️ Persistent approval for this runtime MCP tool request is not available from WeChat."]);
});
