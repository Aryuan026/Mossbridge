const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

test("claudecode runtime adapter applies model overrides and recreates the client when the model changes", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-claudecode-model-"));
  const workspaceRoot = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const processClientPath = require.resolve("../src/adapters/runtime/claudecode/process-client");
  const projectSettingsPath = require.resolve("../src/adapters/runtime/claudecode/project-settings");
  const ipcServerPath = require.resolve("../src/adapters/runtime/claudecode/ipc-server");
  const adapterPath = require.resolve("../src/adapters/runtime/claudecode/index");

  const originalProcessClient = require.cache[processClientPath];
  const originalProjectSettings = require.cache[projectSettingsPath];
  const originalIpcServer = require.cache[ipcServerPath];
  const originalAdapter = require.cache[adapterPath];
  const projectSettingCalls = [];

  class MockClaudeCodeProcessClient {
    static instances = [];

    constructor(options = {}) {
      this.model = options.model || "";
      this.cwd = options.cwd || "";
      this.appendSystemPrompt = options.appendSystemPrompt || "";
      this.alive = false;
      this.sessionId = "";
      this.resumeSessionId = "";
      this.pendingTurnId = "";
      this.listener = null;
      this.sentMessages = [];
      MockClaudeCodeProcessClient.instances.push(this);
    }

    onMessage(listener) {
      this.listener = listener;
      return () => {
        if (this.listener === listener) {
          this.listener = null;
        }
      };
    }

    async connect(resumeSessionId = "") {
      this.alive = true;
      this.resumeSessionId = resumeSessionId || "";
      this.sessionId = resumeSessionId || `session-${this.model || "default"}`;
      if (this.listener) {
        this.listener({ type: "session.id", sessionId: this.sessionId }, {
          type: "system",
          session_id: this.sessionId,
        });
      }
    }

    async sendUserMessage({ text = "" } = {}) {
      this.sentMessages.push(text);
      this.pendingTurnId = `turn-${this.model || "default"}`;
    }

    async waitForSessionId() {
      return this.sessionId;
    }

    async close() {
      this.alive = false;
    }
  }

  class MockClaudeCodeIpcServer {
    constructor() {}
    on() {}
    start() {}
    async close() {}
    broadcast() {}
  }

  require.cache[processClientPath] = {
    id: processClientPath,
    filename: processClientPath,
    loaded: true,
    exports: { ClaudeCodeProcessClient: MockClaudeCodeProcessClient },
  };
  require.cache[projectSettingsPath] = {
    id: projectSettingsPath,
    filename: projectSettingsPath,
    loaded: true,
    exports: {
      ensureClaudeProjectMcpConfig(args = {}) {
        projectSettingCalls.push(args);
        return {
          configPath: path.join(tempRoot, "mock.mcp.json"),
          serverName: "mock_tools",
        };
      },
      normalizeToolProfile(value) {
        if (value === "checkin_lite") {
          return "checkin_lite";
        }
        return value === "full" ? "full" : "foreground";
      },
    },
  };
  require.cache[ipcServerPath] = {
    id: ipcServerPath,
    filename: ipcServerPath,
    loaded: true,
    exports: { ClaudeCodeIpcServer: MockClaudeCodeIpcServer },
  };
  delete require.cache[adapterPath];

  const { createClaudeCodeRuntimeAdapter } = require("../src/adapters/runtime/claudecode/index");

  try {
    const adapter = createClaudeCodeRuntimeAdapter({
      stateDir: tempRoot,
      sessionsFile: path.join(tempRoot, "sessions.json"),
      claudeCommand: "claude",
      weixinInstructionsFile: path.join(tempRoot, "weixin-instructions.md"),
      weixinOperationsFile: "",
    });
    fs.writeFileSync(path.join(tempRoot, "weixin-instructions.md"), "STABLE WECHAT RULE", "utf8");
    await adapter.initialize();

    const sessionStore = adapter.getSessionStore();
    const bindingKey = sessionStore.buildBindingKey({
      workspaceId: "default",
      accountId: "demo-account",
      senderId: "demo-sender",
    });

    const firstTurn = await adapter.sendTextTurn({
      bindingKey,
      workspaceRoot,
      text: "hello",
      model: "sonnet",
      metadata: {},
    });

    assert.equal(MockClaudeCodeProcessClient.instances.length, 1);
    assert.equal(MockClaudeCodeProcessClient.instances[0].model, "sonnet");
    assert.equal(MockClaudeCodeProcessClient.instances[0].appendSystemPrompt, "");
    assert.equal(firstTurn.threadId, "session-sonnet");
    assert.equal(projectSettingCalls.at(-1).toolProfile, "foreground");
    assert.match(MockClaudeCodeProcessClient.instances[0].sentMessages[0], /WECHAT SESSION INSTRUCTIONS/);
    assert.match(MockClaudeCodeProcessClient.instances[0].sentMessages[0], /STABLE WECHAT RULE/);

    const secondTurn = await adapter.sendTextTurn({
      bindingKey,
      workspaceRoot,
      text: "hello again",
      model: "opus",
      metadata: {},
    });

    assert.equal(MockClaudeCodeProcessClient.instances.length, 2);
    assert.equal(MockClaudeCodeProcessClient.instances[1].model, "opus");
    assert.equal(secondTurn.threadId, "session-sonnet");
    assert.equal(MockClaudeCodeProcessClient.instances[0].alive, false);

    const activeUserClient = MockClaudeCodeProcessClient.instances[1];
    const systemBindingKey = `${bindingKey}#mossbridge-system`;
    sessionStore.updateBinding(systemBindingKey, {
      workspaceId: "default",
      accountId: "demo-account",
      senderId: "demo-sender#mossbridge-system",
      replySenderId: "demo-sender",
      systemRuntimeBinding: true,
      systemToolProfile: "checkin_lite",
      activeWorkspaceRoot: workspaceRoot,
    });
    const systemTurn = await adapter.sendTextTurn({
      bindingKey: systemBindingKey,
      workspaceRoot,
      text: "background checkin",
      model: "opus",
      metadata: { systemRuntimeBinding: true, skipOpeningInstructions: true },
    });

    assert.equal(MockClaudeCodeProcessClient.instances.length, 3);
    assert.equal(systemTurn.threadId, "session-opus");
    assert.equal(activeUserClient.alive, true);
    assert.equal(MockClaudeCodeProcessClient.instances[2].alive, true);
    assert.equal(projectSettingCalls.at(-1).toolProfile, "checkin_lite");
    assert.match(MockClaudeCodeProcessClient.instances[2].sentMessages[0], /^MOSSBRIDGE WAKE ANCHOR/);
    assert.match(MockClaudeCodeProcessClient.instances[2].sentMessages[0], /STABLE WECHAT RULE/);
    assert.match(MockClaudeCodeProcessClient.instances[2].sentMessages[0], /WAKE INPUT\nbackground checkin/);
    assert.doesNotMatch(MockClaudeCodeProcessClient.instances[2].sentMessages[0], /WECHAT SESSION INSTRUCTIONS/);

    const foregroundCleanup = await adapter.closeIdleSystemClient({
      bindingKey,
      workspaceRoot,
      threadId: secondTurn.threadId,
    });
    assert.equal(foregroundCleanup.closed, false);
    assert.equal(foregroundCleanup.reason, "not_system_runtime");
    assert.equal(activeUserClient.alive, true);

    MockClaudeCodeProcessClient.instances[2].pendingTurnId = "";
    const systemCleanup = await adapter.closeIdleSystemClient({
      bindingKey: systemBindingKey,
      workspaceRoot,
      threadId: systemTurn.threadId,
      systemRuntimeBinding: true,
      systemToolProfile: "checkin_lite",
    });
    assert.equal(systemCleanup.closed, true);
    assert.equal(activeUserClient.alive, true);
    assert.equal(MockClaudeCodeProcessClient.instances[2].alive, false);

    await adapter.close();
  } finally {
    if (originalProcessClient) {
      require.cache[processClientPath] = originalProcessClient;
    } else {
      delete require.cache[processClientPath];
    }
    if (originalProjectSettings) {
      require.cache[projectSettingsPath] = originalProjectSettings;
    } else {
      delete require.cache[projectSettingsPath];
    }
    if (originalIpcServer) {
      require.cache[ipcServerPath] = originalIpcServer;
    } else {
      delete require.cache[ipcServerPath];
    }
    if (originalAdapter) {
      require.cache[adapterPath] = originalAdapter;
    } else {
      delete require.cache[adapterPath];
    }
  }
});

test("claudecode runtime adapter closes an opening client when session id verification fails", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-claudecode-open-timeout-"));
  const workspaceRoot = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const processClientPath = require.resolve("../src/adapters/runtime/claudecode/process-client");
  const projectSettingsPath = require.resolve("../src/adapters/runtime/claudecode/project-settings");
  const ipcServerPath = require.resolve("../src/adapters/runtime/claudecode/ipc-server");
  const adapterPath = require.resolve("../src/adapters/runtime/claudecode/index");

  const originalProcessClient = require.cache[processClientPath];
  const originalProjectSettings = require.cache[projectSettingsPath];
  const originalIpcServer = require.cache[ipcServerPath];
  const originalAdapter = require.cache[adapterPath];

  class MockClaudeCodeProcessClient {
    static instances = [];

    constructor(options = {}) {
      this.model = options.model || "";
      this.cwd = options.cwd || "";
      this.alive = false;
      this.sessionId = "";
      this.resumeSessionId = "";
      this.pendingTurnId = "";
      this.listener = null;
      this.closeCalls = 0;
      MockClaudeCodeProcessClient.instances.push(this);
    }

    onMessage(listener) {
      this.listener = listener;
      return () => {
        if (this.listener === listener) {
          this.listener = null;
        }
      };
    }

    async connect(resumeSessionId = "") {
      this.alive = true;
      this.resumeSessionId = resumeSessionId || "";
      this.sessionId = resumeSessionId || "";
    }

    async sendUserMessage() {
      this.pendingTurnId = "turn-opening";
    }

    async waitForSessionId() {
      throw new Error("timed out waiting for claudecode session id");
    }

    async close() {
      this.closeCalls += 1;
      this.alive = false;
    }
  }

  class MockClaudeCodeIpcServer {
    constructor() {}
    on() {}
    start() {}
    async close() {}
    broadcast() {}
  }

  require.cache[processClientPath] = {
    id: processClientPath,
    filename: processClientPath,
    loaded: true,
    exports: { ClaudeCodeProcessClient: MockClaudeCodeProcessClient },
  };
  require.cache[projectSettingsPath] = {
    id: projectSettingsPath,
    filename: projectSettingsPath,
    loaded: true,
    exports: {
      ensureClaudeProjectMcpConfig() {
        return {
          configPath: path.join(tempRoot, "mock.mcp.json"),
          serverName: "mock_tools",
        };
      },
      normalizeToolProfile(value) {
        if (value === "checkin_lite") {
          return "checkin_lite";
        }
        return value === "full" ? "full" : "foreground";
      },
    },
  };
  require.cache[ipcServerPath] = {
    id: ipcServerPath,
    filename: ipcServerPath,
    loaded: true,
    exports: { ClaudeCodeIpcServer: MockClaudeCodeIpcServer },
  };
  delete require.cache[adapterPath];

  const { createClaudeCodeRuntimeAdapter } = require("../src/adapters/runtime/claudecode/index");

  try {
    const adapter = createClaudeCodeRuntimeAdapter({
      stateDir: tempRoot,
      sessionsFile: path.join(tempRoot, "sessions.json"),
      claudeCommand: "claude",
    });
    await adapter.initialize();

    const sessionStore = adapter.getSessionStore();
    const bindingKey = sessionStore.buildBindingKey({
      workspaceId: "default",
      accountId: "demo-account",
      senderId: "demo-sender",
    });

    await assert.rejects(
      adapter.sendTextTurn({
        bindingKey,
        workspaceRoot,
        text: "hello",
        metadata: {},
      }),
      /timed out waiting for claudecode session id/
    );

    assert.equal(MockClaudeCodeProcessClient.instances.length, 1);
    assert.equal(MockClaudeCodeProcessClient.instances[0].closeCalls, 1);
    assert.equal(MockClaudeCodeProcessClient.instances[0].alive, false);

    await adapter.close();
  } finally {
    if (originalProcessClient) {
      require.cache[processClientPath] = originalProcessClient;
    } else {
      delete require.cache[processClientPath];
    }
    if (originalProjectSettings) {
      require.cache[projectSettingsPath] = originalProjectSettings;
    } else {
      delete require.cache[projectSettingsPath];
    }
    if (originalIpcServer) {
      require.cache[ipcServerPath] = originalIpcServer;
    } else {
      delete require.cache[ipcServerPath];
    }
    if (originalAdapter) {
      require.cache[adapterPath] = originalAdapter;
    } else {
      delete require.cache[adapterPath];
    }
  }
});
