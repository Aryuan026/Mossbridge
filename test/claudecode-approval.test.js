const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { MossbridgeApp } = require("../src/core/app");
const { mapClaudeCodeMessageToRuntimeEvent } = require("../src/adapters/runtime/claudecode/events");
const { SessionStore } = require("../src/adapters/runtime/codex/session-store");

test("claudecode approval events extract command tokens from exec_command input", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-1",
    toolName: "exec_command",
    input: {
      cmd: "mossbridge reminder write --delay 30m --text 'Reminder text'",
    },
  });

  assert.deepEqual(event.payload.commandTokens, ["mossbridge", "reminder", "write"]);
});

test("claudecode approval events prefer prefix_rule when present", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-2",
    toolName: "exec_command",
    input: {
      cmd: "npm run timeline:build -- --locale en",
      prefix_rule: ["npm", "run", "timeline:build"],
    },
  });

  assert.deepEqual(event.payload.commandTokens, ["npm", "run", "timeline:build"]);
});

test("claudecode approval events canonicalize diary commands for stable always matching", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-diary",
    toolName: "exec_command",
    input: {
      cmd: "/tmp/mossbridge/bin/mossbridge diary write --date 2026-04-17 --title '4.17' --text 'hello'",
    },
  });

  assert.deepEqual(event.payload.commandTokens, ["mossbridge", "diary", "write"]);
});

test("claudecode approval events canonicalize view_image tool approvals", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-img",
    toolName: "view_image",
    input: {
      path: "/tmp/example.png",
    },
  });

  assert.deepEqual(event.payload.commandTokens, ["view_image"]);
});

test("claudecode approval events canonicalize MCP tool approvals for stable always matching", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-mcp-timeline",
    toolName: "mcp__mossbridge_tools__mossbridge_timeline_write",
    input: {
      date: "2026-04-21",
      events: [],
    },
  });

  assert.deepEqual(event.payload.commandTokens, ["mcp_tool", "mossbridge_tools", "mossbridge_timeline_write"]);
  assert.match(event.payload.command, /^mossbridge_timeline_write\b/);
});

test("claudecode approval events canonicalize Read image approvals for stable matching", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-read-image",
    toolName: "Read",
    input: {
      file_path: "/tmp/mossbridge-state/inbox/2026-04-17/attachment-5.jpg",
    },
  });

  assert.deepEqual(event.payload.commandTokens, ["read_image"]);
  assert.equal(event.payload.filePath, "/tmp/mossbridge-state/inbox/2026-04-17/attachment-5.jpg");
});

test("claudecode approval events keep non-image Read approvals as file reads", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-read-text",
    toolName: "Read",
    input: {
      file_path: "/tmp/mossbridge-state/inbox/2026-04-17/note.txt",
    },
  });

  assert.deepEqual(event.payload.commandTokens, []);
  assert.equal(event.payload.filePath, "/tmp/mossbridge-state/inbox/2026-04-17/note.txt");
});

test("claudecode approval events capture Write file paths for state-dir auto approve", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "approval.requested",
    sessionId: "thread-1",
    requestId: "req-write",
    toolName: "Write",
    input: {
      file_path: "/tmp/mossbridge-state/notes/today.md",
      content: "hello",
    },
  });

  assert.equal(event.payload.filePath, "/tmp/mossbridge-state/notes/today.md");
  assert.deepEqual(event.payload.filePaths, ["/tmp/mossbridge-state/notes/today.md"]);
});

test("claudecode assistant events map usage into context snapshots", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent(
    {
      type: "context.updated",
      sessionId: "thread-1",
    },
    {
      message: {
        usage: {
          input_tokens: 7,
          cache_creation_input_tokens: 12150,
          cache_read_input_tokens: 13535,
          output_tokens: 1509,
        },
      },
    },
  );

  assert.equal(event.type, "runtime.context.updated");
  assert.equal(event.payload.runtimeId, "claudecode");
  assert.equal(event.payload.threadId, "thread-1");
  assert.equal(event.payload.currentTokens, 27201);
});

test("claudecode turn.failed events map into runtime failures", () => {
  const event = mapClaudeCodeMessageToRuntimeEvent({
    type: "turn.failed",
    sessionId: "thread-1",
    turnId: "turn-1",
    text: "Prompt is too long",
    reason: "prompt_too_long",
  });

  assert.equal(event.type, "runtime.turn.failed");
  assert.deepEqual(event.payload, {
    threadId: "thread-1",
    turnId: "turn-1",
    text: "Prompt is too long",
    reason: "prompt_too_long",
  });
});

test("claudecode process close only fails an active turn", () => {
  const activeClose = mapClaudeCodeMessageToRuntimeEvent({
    type: "process.close",
    sessionId: "thread-1",
    turnId: "turn-1",
    code: 1,
    stderrTail: "model unavailable",
  });
  const idleClose = mapClaudeCodeMessageToRuntimeEvent({
    type: "process.closed",
    sessionId: "thread-1",
    code: 0,
  });

  assert.equal(activeClose.type, "runtime.turn.failed");
  assert.match(activeClose.payload.text, /exit code: 1/);
  assert.match(activeClose.payload.text, /model unavailable/);
  assert.equal(idleClose.type, "runtime.process.closed");
  assert.doesNotMatch(idleClose.payload.text, /turn\.failed/);
});

test("handleRuntimeEvent prompts for project shell commands instead of auto-approving them", async () => {
  const prompts = [];
  const appLike = {
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
        throw new Error(`should not auto-approve ${JSON.stringify(payload)}`);
      },
    },
    threadStateStore: {
      resolveApproval() {},
    },
    async sendApprovalPrompt(payload) {
      prompts.push(payload);
    },
  };

  await MossbridgeApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-3",
      commandTokens: ["mossbridge", "timeline", "write", "--date", "2026-04-17"],
    },
  });

  assert.equal(prompts.length, 1);
});

test("handleNewCommand asks runtime to start a fresh draft before clearing the saved thread", async () => {
  const calls = [];
  const appLike = {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      startFreshThreadDraft: async ({ workspaceRoot }) => {
        calls.push(["fresh", workspaceRoot]);
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          clearThreadIdForWorkspace(bindingKey, workspaceRoot) {
            calls.push(["clear", bindingKey, workspaceRoot]);
          },
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        calls.push(["send", payload.text]);
      },
    },
  };

  await MossbridgeApp.prototype.handleNewCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.deepEqual(calls, [
    ["fresh", "/workspace"],
    ["clear", "binding-1", "/workspace"],
    ["send", "✅ Switched to a fresh thread draft\nworkspace: /workspace"],
  ]);
});

test("handleCompactCommand invokes runtime compaction for the current thread", async () => {
  const calls = [];
  const appLike = {
    pendingOperationByRunKey: new Map(),
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    streamDelivery: {
      queueReplyTargetForThread(threadId, payload) {
        calls.push(["queue", threadId, payload.userId, payload.contextToken, payload.provider]);
      },
    },
    scheduleRuntimeEventWatchdog(payload) {
      calls.push(["watchdog", payload.threadId, payload.workspaceRoot]);
    },
    runtimeAdapter: {
      async compactThread(payload) {
        calls.push(["compact", payload.threadId, payload.workspaceRoot, payload.model]);
        return { threadId: payload.threadId, turnId: "turn-1" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "claude-sonnet" };
          },
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        calls.push(["send", payload.text]);
      },
    },
  };

  await MossbridgeApp.prototype.handleCompactCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
    provider: "weixin",
  });

  assert.deepEqual(calls, [
    ["queue", "thread-1", "user-1", "ctx-1", "weixin"],
    ["watchdog", "thread-1", "/workspace"],
    ["compact", "thread-1", "/workspace", "claude-sonnet"],
    ["send", "🗜️ Compact request sent\nthread: thread-1"],
  ]);
  assert.equal(appLike.pendingOperationByRunKey.get("thread-1:turn-1")?.kind, "compact");
});

test("handleCompactCommand reports when there is no active thread", async () => {
  const calls = [];
  const appLike = {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "";
          },
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        calls.push(payload.text);
      },
    },
  };

  await MossbridgeApp.prototype.handleCompactCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.deepEqual(calls, [
    "💡 There is no active thread yet. Send a normal message first.",
  ]);
});

test("handleStopCommand passes workspaceRoot through to runtime cancellation", async () => {
  const calls = [];
  const appLike = {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    threadStateStore: {
      getThreadState(threadId) {
        calls.push(["state", threadId]);
        return {
          threadId,
          turnId: "turn-1",
          status: "running",
        };
      },
    },
    runtimeAdapter: {
      async cancelTurn(payload) {
        calls.push(["cancel", payload.threadId, payload.turnId, payload.workspaceRoot]);
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        calls.push(["send", payload.text]);
      },
    },
  };

  await MossbridgeApp.prototype.handleStopCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.deepEqual(calls, [
    ["state", "thread-1"],
    ["cancel", "thread-1", "turn-1", "/workspace"],
    ["send", "⏹️ Stop request sent\nthread: thread-1"],
  ]);
});

test("handleStopCommand allows stopping while waiting for approval", async () => {
  const calls = [];
  const appLike = {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    threadStateStore: {
      getThreadState() {
        return {
          threadId: "thread-1",
          turnId: "turn-1",
          status: "waiting_approval",
        };
      },
    },
    runtimeAdapter: {
      async cancelTurn(payload) {
        calls.push(payload);
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        calls.push(payload.text);
      },
    },
  };

  await MossbridgeApp.prototype.handleStopCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.equal(calls[0].workspaceRoot, "/workspace");
  assert.equal(calls[1], "⏹️ Stop request sent\nthread: thread-1");
});

test("handleRuntimeEvent reports compact completion back to WeChat", async () => {
  const sent = [];
  const appLike = {
    pendingOperationByRunKey: new Map([
      ["thread-1:turn-1", {
        kind: "compact",
        userId: "user-1",
        contextToken: "ctx-1",
      }],
    ]),
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return null;
          },
        };
      },
    },
    turnGateStore: {
      releaseThread() {},
      isPending() {
        return false;
      },
    },
    hasPendingInboundMessage() {
      return false;
    },
    async flushPendingInboundMessages() {},
    async flushPendingSystemMessages() {},
    async stopTypingForThread() {},
    async writebackRuntimeTurn() {},
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await MossbridgeApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.turn.completed",
    payload: {
      threadId: "thread-1",
      turnId: "turn-1",
    },
  });

  assert.deepEqual(sent, ["✅ Compact finished\nthread: thread-1"]);
  assert.equal(appLike.pendingOperationByRunKey.size, 0);
});

test("maybeCloseIdleSystemRuntimeClient closes completed claudecode system clients only", async () => {
  const originalLog = console.log;
  console.log = () => {};
  try {
    const cleanupCalls = [];
    const appLike = {
      runtimeAdapter: {
        describe() {
          return { id: "claudecode" };
        },
        getSessionStore() {
          return {
            getBinding(bindingKey) {
              if (bindingKey === "system-binding") {
                return {
                  systemRuntimeBinding: true,
                  systemToolProfile: "checkin_lite",
                  activeWorkspaceRoot: "/workspace",
                };
              }
              return {
                systemRuntimeBinding: false,
                activeWorkspaceRoot: "/workspace",
              };
            },
          };
        },
        async closeIdleSystemClient(payload) {
          cleanupCalls.push(payload);
          return { closed: true };
        },
      },
    };

    await MossbridgeApp.prototype.maybeCloseIdleSystemRuntimeClient.call(appLike, {
      event: {
        type: "runtime.turn.completed",
        payload: {
          threadId: "system-thread",
          turnId: "turn-1",
        },
      },
      linked: {
        bindingKey: "system-binding",
        workspaceRoot: "/workspace",
      },
    });

    assert.equal(cleanupCalls.length, 1);
    assert.deepEqual(cleanupCalls[0], {
      threadId: "system-thread",
      workspaceRoot: "/workspace",
      bindingKey: "system-binding",
      systemRuntimeBinding: true,
      systemToolProfile: "checkin_lite",
    });

    await MossbridgeApp.prototype.maybeCloseIdleSystemRuntimeClient.call(appLike, {
      event: {
        type: "runtime.turn.completed",
        payload: {
          threadId: "user-thread",
          turnId: "turn-2",
        },
      },
      linked: {
        bindingKey: "user-binding",
        workspaceRoot: "/workspace",
      },
    });

    assert.equal(cleanupCalls.length, 1);
  } finally {
    console.log = originalLog;
  }
});

test("handleRuntimeEvent auto-approves built-in view_image approvals without prompting", async () => {
  const responses = [];
  const appLike = {
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
      throw new Error("should not prompt for view_image");
    },
  };

  await MossbridgeApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-img-2",
      commandTokens: ["view_image"],
    },
  });

  assert.deepEqual(responses, [{ requestId: "req-img-2", decision: "accept" }]);
});

test("handleRuntimeEvent auto-approves project-native MCP tool approvals without prompting", async () => {
  const responses = [];
  const appLike = {
    config: { stateDir: path.join(os.tmpdir(), "mossbridge-approval-test") },
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
      throw new Error("should not prompt for project-native MCP tools");
    },
  };

  await MossbridgeApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-project-tool",
      commandTokens: ["mcp_tool", "mossbridge_tools", "mossbridge_timeline_write"],
    },
  });

  assert.deepEqual(responses, [{ requestId: "req-project-tool", decision: "accept" }]);
});

test("handleRuntimeEvent auto-approves inbox image reads for claudecode without prompting", async () => {
  const responses = [];
  const stateDir = path.join(os.tmpdir(), "mossbridge-approval-test");
  const workspaceRoot = path.join(os.tmpdir(), "mossbridge-office-workspace");
  const appLike = {
    config: {
      stateDir,
      workspaceRoot,
      workspaceInboxDir: path.join("wechat", "inbox"),
      workspaceAttachmentNotesDir: path.join("context", "attachment-notes"),
      workspaceAttachmentJournalFile: path.join("context", "attachment-journal.jsonl"),
    },
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot };
          },
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
      throw new Error("should not prompt for inbox image read");
    },
  };

  await MossbridgeApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-read-img-2",
      filePath: path.join(workspaceRoot, "wechat", "inbox", "2026-04-17", "attachment.jpg"),
      commandTokens: ["read_image"],
    },
  });

  assert.deepEqual(responses, [{ requestId: "req-read-img-2", decision: "accept" }]);
});

test("handleRuntimeEvent auto-approves workspace attachment note writes without prompting", async () => {
  const responses = [];
  const stateDir = path.join(os.tmpdir(), "mossbridge-approval-test");
  const workspaceRoot = path.join(os.tmpdir(), "mossbridge-office-workspace");
  const appLike = {
    config: {
      stateDir,
      workspaceRoot,
      workspaceInboxDir: path.join("wechat", "inbox"),
      workspaceAttachmentNotesDir: path.join("context", "attachment-notes"),
      workspaceAttachmentJournalFile: path.join("context", "attachment-journal.jsonl"),
    },
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot };
          },
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
      throw new Error("should not prompt for attachment note write");
    },
  };

  await MossbridgeApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-write-note",
      filePath: path.join(workspaceRoot, "context", "attachment-notes", "2026-04-26", "meteor.md"),
      commandTokens: [],
    },
  });

  assert.deepEqual(responses, [{ requestId: "req-write-note", decision: "accept" }]);
});

test("handleRuntimeEvent auto-approves any state-dir file operation without prompting", async () => {
  const responses = [];
  const stateDir = path.join(os.tmpdir(), "mossbridge-approval-test");
  const appLike = {
    config: { stateDir },
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
      throw new Error("should not prompt for state-dir file operation");
    },
  };

  await MossbridgeApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-write-2",
      filePath: path.join(stateDir, "notes", "today.md"),
      filePaths: [path.join(stateDir, "notes", "today.md")],
      commandTokens: [],
      reason: "Tool: Write",
      command: "Write\nfile_path: \"/tmp/mossbridge-approval-test/notes/today.md\"",
    },
  });

  assert.deepEqual(responses, [{ requestId: "req-write-2", decision: "accept" }]);
});

test("handleRuntimeEvent auto-denies external soul seed reads without prompting", async () => {
  const responses = [];
  const appLike = {
    config: { stateDir: path.join(os.tmpdir(), "mossbridge-approval-test") },
    streamDelivery: {
      async handleRuntimeEvent() {},
    },
    runtimeAdapter: {
      getSessionStore() {
        return {
          clearApprovalPrompt() {},
          findBindingForThreadId() {
            return { bindingKey: "binding-1", workspaceRoot: "/tmp/mossbridge-workspace" };
          },
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
      throw new Error("should not prompt for identity seed read");
    },
  };

  await MossbridgeApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-soul-read",
      filePath: "/tmp/mossbridge-memory/00_System/soul.md",
      filePaths: ["/tmp/mossbridge-memory/00_System/soul.md"],
      commandTokens: [],
      reason: "Tool: Read",
      command: "Read\nfile_path: \"/tmp/mossbridge-memory/00_System/soul.md\"",
    },
  });

  assert.deepEqual(responses, [{ requestId: "req-soul-read", decision: "decline" }]);
});

test("handleRuntimeEvent still prompts for non-inbox image reads", async () => {
  const responses = [];
  const prompts = [];
  const stateDir = path.join(os.tmpdir(), "mossbridge-approval-test");
  const appLike = {
    config: { stateDir },
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
          getApprovalCommandAllowlistForWorkspace() {
            return [];
          },
          getApprovalPromptState() {
            return null;
          },
          rememberApprovalPrompt() {},
        };
      },
      async respondApproval(payload) {
        responses.push(payload);
      },
    },
    threadStateStore: {
      resolveApproval() {},
    },
    async sendApprovalPrompt(payload) {
      prompts.push(payload);
    },
  };

  await MossbridgeApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-read-img-3",
      filePath: "/tmp/mossbridge-external/photo.jpg",
      commandTokens: ["read_image"],
      reason: "Tool: Read",
      command: "Read\nfile_path: \"/tmp/mossbridge-external/photo.jpg\"",
    },
  });

  assert.deepEqual(responses, []);
  assert.equal(prompts.length, 1);
});

test("handleRuntimeEvent auto-approves allowlisted prefixes for claudecode approvals", async () => {
  const responses = [];
  const appLike = {
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
          getApprovalCommandAllowlistForWorkspace() {
            return [["npm", "run", "timeline:build"]];
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
      throw new Error("should not prompt for allowlisted commands");
    },
  };

  await MossbridgeApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-4",
      commandTokens: ["npm", "run", "timeline:build", "--", "--locale", "en"],
    },
  });

  assert.deepEqual(responses, [{ requestId: "req-4", decision: "accept" }]);
});

test("handleRuntimeEvent auto-approves allowlisted MCP tool approvals", async () => {
  const responses = [];
  const appLike = {
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
          getApprovalCommandAllowlistForWorkspace() {
            return [["mcp_tool", "mossbridge_tools", "mossbridge_timeline_write"]];
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
      throw new Error("should not prompt for allowlisted MCP tools");
    },
  };

  await MossbridgeApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.approval.requested",
    payload: {
      threadId: "thread-1",
      requestId: "req-mcp-allow",
      commandTokens: ["mcp_tool", "mossbridge_tools", "mossbridge_timeline_write"],
    },
  });

  assert.deepEqual(responses, [{ requestId: "req-mcp-allow", decision: "accept" }]);
});

test("handleSwitchCommand stores the actual claudecode thread returned by runtime", async () => {
  const calls = [];
  const appLike = {
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      async resumeThread({ threadId, workspaceRoot }) {
        calls.push(["resume", threadId, workspaceRoot]);
        return { threadId: "actual-thread" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId) {
            calls.push(["set", bindingKey, workspaceRoot, threadId]);
          },
          setPendingThreadIdForWorkspace(bindingKey, workspaceRoot, threadId) {
            calls.push(["pending", bindingKey, workspaceRoot, threadId]);
          },
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        calls.push(["send", payload.text]);
      },
    },
  };

  await MossbridgeApp.prototype.handleSwitchCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "target-thread",
  });

  assert.deepEqual(calls, [
    ["resume", "target-thread", "/workspace"],
    ["set", "binding-1", "/workspace", "actual-thread"],
    ["pending", "binding-1", "/workspace", "actual-thread"],
    ["send", "🔁 Thread switch requested\nworkspace: /workspace\ntarget: actual-thread\nIt will be verified on the next normal message."],
  ]);
});

test("session store does not reuse legacy thread ids across runtimes", () => {
  const sessionsFile = path.join(
    os.tmpdir(),
    `mossbridge-session-store-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  fs.writeFileSync(sessionsFile, JSON.stringify({
    bindings: {
      "binding-1": {
        activeWorkspaceRoot: "/workspace",
        threadIdByWorkspaceRoot: {
          "/workspace": "codex-thread",
        },
      },
    },
  }, null, 2));

  const claudecodeStore = new SessionStore({ filePath: sessionsFile, runtimeId: "claudecode" });
  const codexStore = new SessionStore({ filePath: sessionsFile, runtimeId: "codex" });

  assert.equal(claudecodeStore.getThreadIdForWorkspace("binding-1", "/workspace"), "");
  assert.equal(codexStore.getThreadIdForWorkspace("binding-1", "/workspace"), "");
});

test("codex session store reads runtime-scoped thread ids", () => {
  const sessionsFile = path.join(
    os.tmpdir(),
    `mossbridge-codex-runtime-scoped-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  fs.writeFileSync(sessionsFile, JSON.stringify({
    bindings: {
      "binding-1": {
        activeWorkspaceRoot: "/workspace",
        threadIdByWorkspaceRootByRuntime: {
          codex: {
            "/workspace": "codex-thread",
          },
        },
      },
    },
  }, null, 2));

  const codexStore = new SessionStore({ filePath: sessionsFile, runtimeId: "codex" });

  assert.equal(codexStore.getThreadIdForWorkspace("binding-1", "/workspace"), "codex-thread");
  assert.deepEqual(codexStore.listWorkspaceRoots("binding-1"), ["/workspace"]);
  assert.deepEqual(codexStore.findBindingForThreadId("codex-thread"), {
    bindingKey: "binding-1",
    workspaceRoot: "/workspace",
  });
});

test("codex session store does not reuse legacy thread ids without runtime-scoped binding", () => {
  const sessionsFile = path.join(
    os.tmpdir(),
    `mossbridge-codex-thread-store-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  fs.writeFileSync(sessionsFile, JSON.stringify({
    bindings: {
      "binding-1": {
        activeWorkspaceRoot: "/workspace",
        threadIdByWorkspaceRoot: {
          "/workspace": "legacy-codex-thread",
        },
      },
    },
  }, null, 2));

  const codexStore = new SessionStore({ filePath: sessionsFile, runtimeId: "codex" });

  assert.equal(codexStore.getThreadIdForWorkspace("binding-1", "/workspace"), "");
  assert.deepEqual(codexStore.listWorkspaceRoots("binding-1"), []);
  assert.equal(codexStore.findBindingForThreadId("legacy-codex-thread"), null);
});

test("claudecode session store keeps pending thread targets runtime-scoped", () => {
  const sessionsFile = path.join(
    os.tmpdir(),
    `mossbridge-pending-thread-store-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  const claudecodeStore = new SessionStore({ filePath: sessionsFile, runtimeId: "claudecode" });
  claudecodeStore.setPendingThreadIdForWorkspace("binding-1", "/workspace", "claude-target");
  const codexStore = new SessionStore({ filePath: sessionsFile, runtimeId: "codex" });

  assert.equal(claudecodeStore.getPendingThreadIdForWorkspace("binding-1", "/workspace"), "claude-target");
  assert.equal(codexStore.getPendingThreadIdForWorkspace("binding-1", "/workspace"), "");
});

test("handleStatusCommand asks to configure claudecode context window before showing context", async () => {
  const sent = [];
  const appLike = {
    config: {
      claudeModel: "claude-sonnet",
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          getPendingThreadIdForWorkspace() {
            return "";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "" };
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "idle" };
      },
      getLatestContext() {
        return {
          runtimeId: "claudecode",
          currentTokens: 18000,
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await MossbridgeApp.prototype.handleStatusCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.match(sent[0], /📦 context: set MOSSBRIDGE_CLAUDE_CONTEXT_WINDOW/);
});

test("handleStatusCommand shows approximate context details for claudecode when configured", async () => {
  const sent = [];
  const appLike = {
    config: {
      claudeContextWindow: 130000,
      claudeMaxOutputTokens: 64000,
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          getPendingThreadIdForWorkspace() {
            return "";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "kimi-for-coding" };
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return {
          status: "idle",
          context: {
            runtimeId: "claudecode",
            currentTokens: 18000,
          },
        };
      },
      getLatestContext() {
        return null;
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await MossbridgeApp.prototype.handleStatusCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.match(sent[0], /📦 context: approx 18k\/66k \| 73% left \| reserve 64k/);
});

test("handleStatusCommand uses persisted claudecode context when live thread state is cold", async () => {
  const sent = [];
  const appLike = {
    config: {
      claudeContextWindow: 200000,
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          getPendingThreadIdForWorkspace() {
            return "";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "claude-opus-4-6" };
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "idle" };
      },
      getLatestContext() {
        return null;
      },
    },
    runtimeContextUsageStore: {
      getContext(payload) {
        assert.deepEqual(payload, { threadId: "thread-1", runtimeId: "claudecode" });
        return {
          runtimeId: "claudecode",
          threadId: "thread-1",
          currentTokens: 88000,
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await MossbridgeApp.prototype.handleStatusCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.match(sent[0], /📦 context: approx 88k\/200k \| 56% left/);
});

test("recordRuntimeContextUsage schedules claudecode auto compact above threshold", () => {
  const recorded = [];
  const appLike = {
    config: {
      claudeContextWindow: 100000,
      claudeAutoCompactEnabled: true,
      claudeAutoCompactThresholdPercent: 80,
      claudeAutoCompactMinIntervalMs: 0,
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          findBindingForThreadId(threadId) {
            assert.equal(threadId, "thread-1");
            return {
              bindingKey: "binding-1",
              workspaceRoot: "/workspace",
            };
          },
        };
      },
    },
    runtimeContextUsageStore: {
      recordContext(snapshot) {
        recorded.push(snapshot);
      },
    },
    pendingAutoCompactByThreadId: new Map(),
    lastAutoCompactAtByThreadId: new Map(),
  };

  MossbridgeApp.prototype.recordRuntimeContextUsage.call(appLike, {
    type: "runtime.context.updated",
    payload: {
      runtimeId: "claudecode",
      threadId: "thread-1",
      currentTokens: 81000,
    },
  });

  assert.equal(recorded[0].compactThresholdTokens, 80000);
  assert.equal(appLike.pendingAutoCompactByThreadId.get("thread-1").shouldCompact, true);
});

test("maybeAutoCompactAfterTurn silently requests claudecode compaction", async () => {
  const calls = [];
  const appLike = {
    config: {},
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          getRuntimeParamsForWorkspace(bindingKey, workspaceRoot) {
            calls.push(["params", bindingKey, workspaceRoot]);
            return { model: "claude-opus-4-6" };
          },
        };
      },
      async compactThread(payload) {
        calls.push(["compact", payload.threadId, payload.workspaceRoot, payload.model]);
        return { threadId: payload.threadId, turnId: "compact-turn-1" };
      },
    },
    turnGateStore: {
      isPending() {
        return false;
      },
    },
    requestAutoCompact: MossbridgeApp.prototype.requestAutoCompact,
    hasPendingInboundMessage() {
      return false;
    },
    runtimeContextUsageStore: {
      recordAutoCompact(event) {
        calls.push(["record", event.threadId, event.reason]);
      },
    },
    streamDelivery: {
      suppressNextRunForThread(threadId) {
        calls.push(["suppress", threadId]);
      },
    },
    pendingAutoCompactByThreadId: new Map([
      ["thread-1", {
        shouldCompact: true,
        reason: "context_threshold",
        currentTokens: 81000,
        compactThresholdTokens: 80000,
      }],
    ]),
    pendingOperationByRunKey: new Map(),
    lastAutoCompactAtByThreadId: new Map(),
  };

  await MossbridgeApp.prototype.maybeAutoCompactAfterTurn.call(appLike, {
    event: {
      type: "runtime.turn.completed",
      payload: {
        threadId: "thread-1",
        turnId: "turn-1",
      },
    },
    linked: {
      bindingKey: "binding-1",
      workspaceRoot: "/workspace",
    },
    pendingOperation: null,
  });

  assert.deepEqual(calls, [
    ["params", "binding-1", "/workspace"],
    ["record", "thread-1", "context_threshold"],
    ["suppress", "thread-1"],
    ["compact", "thread-1", "/workspace", "claude-opus-4-6"],
  ]);
  assert.equal(appLike.pendingAutoCompactByThreadId.has("thread-1"), false);
  assert.deepEqual(appLike.pendingOperationByRunKey.get("thread-1:compact-turn-1"), {
    kind: "compact",
    auto: true,
    notify: false,
    reason: "context_threshold",
  });
});

test("handleStatusCommand asks to reduce claudecode max output tokens when reserve exceeds window", async () => {
  const sent = [];
  const appLike = {
    config: {
      claudeContextWindow: 130000,
      claudeMaxOutputTokens: 140000,
    },
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "claudecode" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          getPendingThreadIdForWorkspace() {
            return "";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "kimi-for-coding" };
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return {
          status: "idle",
          context: {
            runtimeId: "claudecode",
            currentTokens: 18000,
          },
        };
      },
      getLatestContext() {
        return null;
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await MossbridgeApp.prototype.handleStatusCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.match(sent[0], /📦 context: reduce CLAUDE_CODE_MAX_OUTPUT_TOKENS/);
});

test("handleStatusCommand shows codex context details", async () => {
  const sent = [];
  const appLike = {
    config: {},
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          getPendingThreadIdForWorkspace() {
            return "";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "gpt-5.4" };
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "idle" };
      },
      getLatestContext() {
        return {
          runtimeId: "codex",
          currentTokens: 1234,
          contextWindow: 200000,
        };
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await MossbridgeApp.prototype.handleStatusCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.match(sent[0], /📦 context: 1.2k\/200k \| 99% left/);
});

test("handleStatusCommand shows codex context as unavailable when no context data is available", async () => {
  const sent = [];
  const appLike = {
    config: {},
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    runtimeAdapter: {
      describe() {
        return { id: "codex" };
      },
      getSessionStore() {
        return {
          buildBindingKey() {
            return "binding-1";
          },
          getThreadIdForWorkspace() {
            return "thread-1";
          },
          getPendingThreadIdForWorkspace() {
            return "";
          },
          getRuntimeParamsForWorkspace() {
            return { model: "gpt-5.4" };
          },
        };
      },
    },
    threadStateStore: {
      getThreadState() {
        return { status: "idle" };
      },
      getLatestContext() {
        return null;
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload.text);
      },
    },
  };

  await MossbridgeApp.prototype.handleStatusCommand.call(appLike, {
    workspaceId: "default",
    accountId: "account-1",
    senderId: "user-1",
    contextToken: "ctx-1",
  });

  assert.match(sent[0], /📦 context: unavailable/);
});
