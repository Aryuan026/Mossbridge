const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

test("claudecode runtime adapter applies model overrides and recreates the client when the model changes", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asheriebridge-claudecode-model-"));
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

    async sendUserMessage() {
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
      ensureClaudeProjectMcpConfig() {
        return {
          configPath: path.join(tempRoot, "mock.mcp.json"),
          serverName: "mock_tools",
        };
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

    const firstTurn = await adapter.sendTextTurn({
      bindingKey,
      workspaceRoot,
      text: "hello",
      model: "sonnet",
      metadata: {},
    });

    assert.equal(MockClaudeCodeProcessClient.instances.length, 1);
    assert.equal(MockClaudeCodeProcessClient.instances[0].model, "sonnet");
    assert.equal(firstTurn.threadId, "session-sonnet");

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
