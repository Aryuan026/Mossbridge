const path = require("path");
const os = require("os");
const { ClaudeCodeProcessClient } = require("./process-client");
const { mapClaudeCodeMessageToRuntimeEvent } = require("./events");
const { ensureClaudeProjectMcpConfig } = require("./project-settings");
const { SessionStore } = require("../codex/session-store");
const { buildOpeningTurnText, buildInstructionRefreshText } = require("../shared-instructions");
const { ClaudeCodeIpcServer } = require("./ipc-server");
const CLAUDE_RESUME_SESSION_TIMEOUT_MS = 8000;
const CLAUDE_OPENING_SESSION_TIMEOUT_MS = 90_000;
const DEFAULT_CLAUDE_SESSION_APPEND_PROMPT = [
  "For this session, ignore user-home or global CLAUDE.md bootstrap instructions.",
  "Identity and memory context is already injected by the gateway — do not use any file-reading tools to load soul, persona, or memory files.",
  "If a card mentions soul.md or a soul_ref path, treat it as a historical pointer, not as an instruction to read that file.",
  "Do not read files outside the current workspace.",
  "Treat the current workspace instructions, MCP tools, and live conversation as authoritative.",
].join(" ");

function createClaudeCodeRuntimeAdapter(config) {
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId: "claudecode" });
  const clientsByWorkspace = new Map();
  const pendingApprovals = new Map();
  let globalListener = null;
  const ipcSocketPath = path.join(
    config.stateDir || path.join(os.homedir(), ".mossbridge"),
    "claudecode-runtime.sock",
  );
  const ipcServer = new ClaudeCodeIpcServer({ socketPath: ipcSocketPath });

  ipcServer.on("clientMessage", (msg) => {
    if (msg?.type === "sendUserMessage" && msg?.workspaceRoot) {
      const client = clientsByWorkspace.get(msg.workspaceRoot);
      if (client?.alive) {
        client.sendUserMessage({ text: msg.text || "" }).catch(() => {});
      }
    }
    if (msg?.type === "respondApproval" && msg?.workspaceRoot) {
      const client = clientsByWorkspace.get(msg.workspaceRoot);
      if (client?.alive) {
        client.sendResponse(msg.requestId, { decision: msg.decision }).catch(() => {});
      }
    }
  });

  function ensureClient(workspaceRoot, { modelOverride = "" } = {}) {
    if (clientsByWorkspace.has(workspaceRoot)) {
      return clientsByWorkspace.get(workspaceRoot);
    }
    const resolvedModel = normalizeModelId(modelOverride) || normalizeModelId(config.claudeModel);
    const projectSettings = ensureClaudeProjectMcpConfig({
      workspaceRoot,
      mossbridgeHome: process.env.MOSSBRIDGE_HOME || path.resolve(__dirname, "..", "..", "..", ".."),
    });
    console.log(
      `[claudecode-runtime] workspace=${workspaceRoot} model=${resolvedModel || "(default)"} mcp_config=${projectSettings.configPath} server=${projectSettings.serverName}`
    );
    const client = new ClaudeCodeProcessClient({
      command: config.claudeCommand || "claude",
      cwd: workspaceRoot,
      env: filterClaudeCodeEnv(process.env),
      model: resolvedModel,
      permissionMode: config.claudePermissionMode || "default",
      bare: config.claudeBare !== false,
      appendSystemPrompt: typeof config.claudeAppendSystemPrompt === "string" && config.claudeAppendSystemPrompt.trim()
        ? config.claudeAppendSystemPrompt.trim()
        : DEFAULT_CLAUDE_SESSION_APPEND_PROMPT,
      disableVerbose: Boolean(config.claudeDisableVerbose),
      extraArgs: config.claudeExtraArgs || [],
      mcpConfigPaths: [projectSettings.configPath],
      ipcServer,
      workspaceRoot,
    });
    client.onMessage((event, raw) => {
      if (event.type === "session.id") {
        // sendTextTurn owns binding updates. A ClaudeCode process is scoped by
        // workspace, so broadcasting a fresh session id to every binding in that
        // workspace lets short-lived system turns overwrite the real chat thread.
        return;
      }
      const mapped = mapClaudeCodeMessageToRuntimeEvent(event, raw);
      if (mapped?.payload && !mapped.payload.workspaceRoot) {
        mapped.payload.workspaceRoot = workspaceRoot;
      }
      if (mapped?.type === "runtime.approval.requested") {
        if (pendingApprovals.size >= 100) {
          const firstKey = pendingApprovals.keys().next().value;
          pendingApprovals.delete(firstKey);
        }
        pendingApprovals.set(mapped.payload.requestId, workspaceRoot);
      }
      if (mapped?.type === "runtime.turn.failed" || mapped?.type === "runtime.process.closed") {
        clientsByWorkspace.delete(workspaceRoot);
      }
      if (mapped && globalListener) {
        globalListener(mapped, raw);
      }
    });
    clientsByWorkspace.set(workspaceRoot, client);
    return client;
  }

  async function attachClientToThread(workspaceRoot, threadId = "", modelOverride = "") {
    const normalizedWorkspaceRoot = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
    const normalizedThreadId = normalizeThreadId(threadId);
    const normalizedModel = normalizeModelId(modelOverride) || normalizeModelId(config.claudeModel);
    if (!normalizedWorkspaceRoot) {
      throw new Error("workspaceRoot is required");
    }

    const existingClient = clientsByWorkspace.get(normalizedWorkspaceRoot);
    if (
      normalizedThreadId
      && clientMatchesThread(existingClient, normalizedThreadId)
      && clientMatchesModel(existingClient, normalizedModel)
    ) {
      return { client: existingClient, threadId: normalizedThreadId };
    }

    if (!normalizedThreadId && existingClient?.alive) {
      await closeWorkspaceClient(normalizedWorkspaceRoot);
    }

    const client = ensureClient(normalizedWorkspaceRoot, { modelOverride: normalizedModel });
    if (
      !client.alive
      || (normalizedThreadId && !clientMatchesThread(client, normalizedThreadId))
      || !clientMatchesModel(client, normalizedModel)
    ) {
      if (
        client.alive
        && (
          (normalizedThreadId && !clientMatchesThread(client, normalizedThreadId))
          || !clientMatchesModel(client, normalizedModel)
        )
      ) {
        await closeWorkspaceClient(normalizedWorkspaceRoot);
      }
      const freshClient = ensureClient(normalizedWorkspaceRoot, { modelOverride: normalizedModel });
      await freshClient.connect(normalizedThreadId);
      if (normalizedThreadId) {
        return { client: freshClient, threadId: normalizedThreadId };
      }
      return { client: freshClient, threadId: freshClient.sessionId || normalizedThreadId };
    }

    return { client, threadId: client.sessionId || normalizedThreadId };
  }
  async function closeWorkspaceClient(workspaceRoot) {
    const normalizedWorkspaceRoot = typeof workspaceRoot === "string" ? workspaceRoot.trim() : "";
    if (!normalizedWorkspaceRoot) {
      return;
    }
    const client = clientsByWorkspace.get(normalizedWorkspaceRoot);
    if (!client) {
      return;
    }
    await client.close();
    clientsByWorkspace.delete(normalizedWorkspaceRoot);
    for (const [requestId, candidateWorkspaceRoot] of pendingApprovals.entries()) {
      if (candidateWorkspaceRoot === normalizedWorkspaceRoot) {
        pendingApprovals.delete(requestId);
      }
    }
  }
  return {
    describe() {
      return {
        id: "claudecode",
        kind: "runtime",
        command: config.claudeCommand || "claude",
        sessionsFile: config.sessionsFile,
        ipcSocketPath,
      };
    },
    onEvent(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      globalListener = listener;
      return () => {
        if (globalListener === listener) {
          globalListener = null;
        }
      };
    },
    getSessionStore() {
      return sessionStore;
    },
    async initialize() {
      ipcServer.start();
      return {
        command: config.claudeCommand || "claude",
        models: [],
      };
    },
    async refreshModelCatalog() {
      return {
        models: [],
        updatedAt: "",
        source: "claudecode_raw_model_id",
        acceptsRawModel: true,
        unavailableReason: "Claude Code does not expose a stable local model catalog; raw model ids are accepted and passed to --model.",
      };
    },
    async close() {
      for (const client of clientsByWorkspace.values()) {
        await client.close();
      }
      clientsByWorkspace.clear();
      await ipcServer.close();
    },
    async startFreshThreadDraft({ workspaceRoot }) {
      for (const binding of sessionStore.listBindings()) {
        if (binding.activeWorkspaceRoot === workspaceRoot) {
          sessionStore.clearPendingThreadIdForWorkspace(binding.bindingKey, workspaceRoot);
        }
      }
      await closeWorkspaceClient(workspaceRoot);
      return { workspaceRoot };
    },
    async respondApproval({ requestId, decision, result = null }) {
      const workspaceRoot = pendingApprovals.get(requestId);
      const candidates = workspaceRoot
        ? [clientsByWorkspace.get(workspaceRoot)]
        : [...clientsByWorkspace.values()];
      for (const client of candidates) {
        if (client?.alive) {
          const responsePayload = result && typeof result === "object"
            ? result
            : { decision };
          await client.sendResponse(requestId, responsePayload);
          pendingApprovals.delete(requestId);
          return {
            requestId,
            ...(result && typeof result === "object"
              ? { result: responsePayload }
              : { decision: decision === "accept" ? "accept" : "decline" }),
          };
        }
      }
      throw new Error("no active claudecode session to respond to approval");
    },
    async cancelTurn({ threadId, turnId, workspaceRoot }) {
      if (workspaceRoot) {
        await closeWorkspaceClient(workspaceRoot);
        return { threadId, turnId };
      }
      for (const [workspaceRoot, client] of clientsByWorkspace.entries()) {
        if (client.sessionId === threadId) {
          await client.close();
          clientsByWorkspace.delete(workspaceRoot);
          return { threadId, turnId };
        }
      }
      return { threadId, turnId };
    },
    async resumeThread({ threadId, workspaceRoot, model = "" }) {
      if (!workspaceRoot) {
        return { threadId };
      }
      const attached = await attachClientToThread(workspaceRoot, threadId, model);
      return { threadId: attached.threadId };
    },
    async compactThread({ threadId, workspaceRoot, model = "" }) {
      const { client, threadId: activeThreadId } = await attachClientToThread(workspaceRoot, threadId, model);
      await client.sendUserMessage({ text: "/compact", threadId: activeThreadId });
      return { threadId: activeThreadId, turnId: client.pendingTurnId };
    },
    async refreshThreadInstructions({ threadId, workspaceRoot, model = "" }) {
      const { client, threadId: activeThreadId } = await attachClientToThread(workspaceRoot, threadId, model);
      const refreshText = buildInstructionRefreshText(config);
      await client.sendUserMessage({ text: refreshText, threadId: activeThreadId });
      return { threadId: activeThreadId };
    },
    async sendTextTurn({ bindingKey, workspaceRoot, text, metadata = {}, model = "" }) {
      let threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      if (!threadId) {
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
      }
      let openingTurn = !threadId;
      let attached;
      try {
        attached = await attachClientToThread(workspaceRoot, threadId, model);
      } catch (error) {
        if (!threadId) {
          throw error;
        }
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
        sessionStore.clearPendingThreadIdForWorkspace(bindingKey, workspaceRoot);
        threadId = "";
        openingTurn = true;
        attached = await attachClientToThread(workspaceRoot, "", model);
      }
      const { client, threadId: activeThreadId } = attached;
      const outboundText = openingTurn ? buildOpeningTurnText(config, text) : text;
      const outboundThreadId = activeThreadId || threadId || `pending-${Date.now()}`;
      await client.sendUserMessage({ text: outboundText, threadId: outboundThreadId });
      let resolvedThreadId = outboundThreadId;
      if (openingTurn) {
        const confirmedSessionId = normalizeThreadId(
          client.sessionId || await client.waitForSessionId({ timeoutMs: CLAUDE_OPENING_SESSION_TIMEOUT_MS })
        );
        if (!confirmedSessionId) {
          throw new Error("timed out waiting for claudecode session id");
        }
        resolvedThreadId = confirmedSessionId;
      }
      if (!openingTurn) {
        const confirmedSessionId = normalizeThreadId(
          client.sessionId || await client.waitForSessionId({ timeoutMs: CLAUDE_RESUME_SESSION_TIMEOUT_MS })
        );
        if (confirmedSessionId !== normalizeThreadId(outboundThreadId)) {
          await closeWorkspaceClient(workspaceRoot);
          sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
          sessionStore.clearPendingThreadIdForWorkspace(bindingKey, workspaceRoot);
          throw new Error(`claudecode resumed unexpected session id: ${confirmedSessionId || "(empty)"}`);
        }
      }
      sessionStore.setThreadIdForWorkspace(
        bindingKey,
        workspaceRoot,
        resolvedThreadId,
        metadata,
      );
      return {
        threadId: resolvedThreadId,
        turnId: client.pendingTurnId,
        openingTurn,
      };
    },
  };
}

function filterClaudeCodeEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key !== "CLAUDECODE") {
      out[key] = value;
    }
  }
  return out;
}

module.exports = { createClaudeCodeRuntimeAdapter };

function normalizeThreadId(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
}

function normalizeModelId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clientMatchesThread(client, threadId) {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId || !client?.alive) {
    return false;
  }
  return normalizeThreadId(client.sessionId) === normalizedThreadId
    || normalizeThreadId(client.resumeSessionId) === normalizedThreadId;
}

function clientMatchesModel(client, model) {
  const normalizedModel = normalizeModelId(model);
  if (!normalizedModel) {
    return true;
  }
  return normalizeModelId(client?.model) === normalizedModel;
}
