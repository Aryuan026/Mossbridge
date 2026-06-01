const path = require("path");
const os = require("os");
const { ClaudeCodeProcessClient } = require("./process-client");
const { mapClaudeCodeMessageToRuntimeEvent } = require("./events");
const { ensureClaudeProjectMcpConfig, normalizeToolProfile } = require("./project-settings");
const { SessionStore } = require("../codex/session-store");
const { buildOpeningTurnText, buildSystemWakeTurnText, buildInstructionRefreshText } = require("../shared-instructions");
const { ClaudeCodeIpcServer } = require("./ipc-server");

const CLAUDE_RESUME_SESSION_TIMEOUT_MS = 8000;
const CLAUDE_OPENING_SESSION_TIMEOUT_MS = 90_000;
const DEFAULT_CLAUDE_SESSION_APPEND_PROMPT = "";

function createClaudeCodeRuntimeAdapter(config) {
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId: "claudecode" });
  const clientsByKey = new Map();
  const pendingApprovals = new Map();
  let globalListener = null;
  const ipcSocketPath = path.join(
    config.stateDir || path.join(os.homedir(), ".mossbridge"),
    "claudecode-runtime.sock",
  );
  const ipcServer = new ClaudeCodeIpcServer({ socketPath: ipcSocketPath });

  ipcServer.on("clientMessage", (msg) => {
    const workspaceRoot = normalizeText(msg?.workspaceRoot);
    if (msg?.type === "sendUserMessage" && workspaceRoot) {
      const [, client] = findPreferredClientEntryForWorkspace(workspaceRoot) || [];
      if (client?.alive) {
        client.sendUserMessage({ text: msg.text || "" }).catch(() => {});
      }
    }
    if (msg?.type === "respondApproval") {
      const clientKey = pendingApprovals.get(msg.requestId);
      const [, client] = clientKey
        ? [clientKey, clientsByKey.get(clientKey)]
        : findPreferredClientEntryForWorkspace(workspaceRoot) || [];
      if (client?.alive) {
        client.sendResponse(msg.requestId, { decision: msg.decision }).catch(() => {});
      }
    }
  });

  function resolveRuntimeCallScope({ bindingKey = "", threadId = "", metadata = {}, systemRuntimeBinding = false } = {}) {
    let effectiveBindingKey = normalizeText(bindingKey);
    let effectiveSystemRuntimeBinding = Boolean(systemRuntimeBinding || metadata?.systemRuntimeBinding);
    let effectiveToolProfile = normalizeText(metadata?.systemToolProfile || metadata?.toolProfile);
    const normalizedThreadId = normalizeThreadId(threadId);
    if (!effectiveBindingKey && normalizedThreadId) {
      const linked = sessionStore.findBindingForThreadId(normalizedThreadId);
      effectiveBindingKey = normalizeText(linked?.bindingKey);
      effectiveSystemRuntimeBinding = effectiveSystemRuntimeBinding || Boolean(linked?.systemRuntimeBinding);
      if (!effectiveToolProfile) {
        effectiveToolProfile = normalizeText(linked?.systemToolProfile || linked?.toolProfile);
      }
    }
    if (effectiveBindingKey) {
      const binding = sessionStore.getBinding(effectiveBindingKey);
      effectiveSystemRuntimeBinding = effectiveSystemRuntimeBinding || Boolean(binding?.systemRuntimeBinding);
      if (!effectiveToolProfile) {
        effectiveToolProfile = normalizeText(binding?.systemToolProfile || binding?.toolProfile);
      }
    }
    if (isSystemRuntimeBindingKey(effectiveBindingKey)) {
      effectiveSystemRuntimeBinding = true;
    }
    return {
      bindingKey: effectiveBindingKey,
      systemRuntimeBinding: effectiveSystemRuntimeBinding,
      toolProfile: normalizeToolProfile(effectiveToolProfile),
    };
  }

  function buildClientKey(workspaceRoot, options = {}) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    const scope = resolveClientScope(options);
    return `${normalizedWorkspaceRoot}::${scope}`;
  }

  function resolveClientScope({ bindingKey = "", systemRuntimeBinding = false, toolProfile = "" } = {}) {
    const normalizedBindingKey = normalizeText(bindingKey);
    const normalizedToolProfile = normalizeToolProfile(toolProfile);
    const profileSuffix = normalizedToolProfile === "full" ? "" : `:${normalizedToolProfile}`;
    if (systemRuntimeBinding || isSystemRuntimeBindingKey(normalizedBindingKey)) {
      return `system:${normalizedBindingKey || "default"}${profileSuffix}`;
    }
    return `user:${normalizedBindingKey || "default"}${profileSuffix}`;
  }

  function ensureClient(workspaceRoot, { modelOverride = "", bindingKey = "", systemRuntimeBinding = false, toolProfile = "", clientKey = "" } = {}) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    const normalizedToolProfile = normalizeToolProfile(toolProfile);
    const resolvedClientKey = clientKey || buildClientKey(normalizedWorkspaceRoot, { bindingKey, systemRuntimeBinding, toolProfile: normalizedToolProfile });
    const existingClient = clientsByKey.get(resolvedClientKey);
    if (existingClient) {
      return existingClient;
    }
    const resolvedModel = normalizeModelId(modelOverride) || normalizeModelId(config.claudeModel);
    const projectSettings = ensureClaudeProjectMcpConfig({
      workspaceRoot: normalizedWorkspaceRoot,
      mossbridgeHome: process.env.MOSSBRIDGE_HOME || path.resolve(__dirname, "..", "..", "..", ".."),
      toolProfile: normalizedToolProfile,
    });
    console.log(
      `[claudecode-runtime] workspace=${normalizedWorkspaceRoot} scope=${resolveClientScope({ bindingKey, systemRuntimeBinding, toolProfile: normalizedToolProfile })} model=${resolvedModel || "(default)"} mcp_config=${projectSettings.configPath} server=${projectSettings.serverName}`
    );
    const client = new ClaudeCodeProcessClient({
      command: config.claudeCommand || "claude",
      cwd: normalizedWorkspaceRoot,
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
      workspaceRoot: normalizedWorkspaceRoot,
    });
    client.__mossbridgeClientKey = resolvedClientKey;
    client.__mossbridgeWorkspaceRoot = normalizedWorkspaceRoot;
    client.onMessage((event, raw) => {
      if (event.type === "session.id") {
        // sendTextTurn owns binding updates. Broadcasting a fresh session id to
        // every binding in the same workspace lets short-lived system turns
        // overwrite the real chat thread.
        return;
      }
      const mapped = mapClaudeCodeMessageToRuntimeEvent(event, raw);
      if (mapped?.payload && !mapped.payload.workspaceRoot) {
        mapped.payload.workspaceRoot = normalizedWorkspaceRoot;
      }
      if (mapped?.type === "runtime.approval.requested") {
        if (pendingApprovals.size >= 100) {
          const firstKey = pendingApprovals.keys().next().value;
          pendingApprovals.delete(firstKey);
        }
        pendingApprovals.set(mapped.payload.requestId, resolvedClientKey);
      }
      if (mapped?.type === "runtime.turn.failed" || mapped?.type === "runtime.process.closed") {
        if (clientsByKey.get(resolvedClientKey) === client) {
          clientsByKey.delete(resolvedClientKey);
        }
        clearApprovalsForClientKey(resolvedClientKey);
      }
      if (mapped && globalListener) {
        globalListener(mapped, raw);
      }
    });
    clientsByKey.set(resolvedClientKey, client);
    return client;
  }

  async function attachClientToThread(workspaceRoot, threadId = "", modelOverride = "", options = {}) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    const normalizedThreadId = normalizeThreadId(threadId);
    const normalizedModel = normalizeModelId(modelOverride) || normalizeModelId(config.claudeModel);
    if (!normalizedWorkspaceRoot) {
      throw new Error("workspaceRoot is required");
    }

    const scope = resolveRuntimeCallScope({ ...options, threadId: normalizedThreadId });
    const clientKey = buildClientKey(normalizedWorkspaceRoot, scope);
    const existingClient = clientsByKey.get(clientKey);
    if (
      normalizedThreadId
      && clientMatchesThread(existingClient, normalizedThreadId)
      && clientMatchesModel(existingClient, normalizedModel)
    ) {
      return { client: existingClient, threadId: normalizedThreadId };
    }

    if (!normalizedThreadId && existingClient?.alive) {
      await closeClientByKey(clientKey);
    }

    const client = ensureClient(normalizedWorkspaceRoot, {
      modelOverride: normalizedModel,
      bindingKey: scope.bindingKey,
      systemRuntimeBinding: scope.systemRuntimeBinding,
      toolProfile: scope.toolProfile,
      clientKey,
    });
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
        await closeClientByKey(clientKey);
      }
      const freshClient = ensureClient(normalizedWorkspaceRoot, {
        modelOverride: normalizedModel,
        bindingKey: scope.bindingKey,
        systemRuntimeBinding: scope.systemRuntimeBinding,
        toolProfile: scope.toolProfile,
        clientKey,
      });
      await freshClient.connect(normalizedThreadId);
      if (normalizedThreadId) {
        return { client: freshClient, threadId: normalizedThreadId };
      }
      return { client: freshClient, threadId: freshClient.sessionId || normalizedThreadId };
    }

    return { client, threadId: client.sessionId || normalizedThreadId };
  }

  function findClientEntryByThreadId(threadId) {
    const normalizedThreadId = normalizeThreadId(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    for (const [clientKey, client] of clientsByKey.entries()) {
      if (clientMatchesThread(client, normalizedThreadId)) {
        return [clientKey, client];
      }
    }
    return null;
  }

  function findPreferredClientEntryForWorkspace(workspaceRoot) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return null;
    }
    let firstAlive = null;
    for (const [clientKey, client] of clientsByKey.entries()) {
      if (!client?.alive || normalizeText(client.__mossbridgeWorkspaceRoot || client.workspaceRoot) !== normalizedWorkspaceRoot) {
        continue;
      }
      if (!firstAlive) {
        firstAlive = [clientKey, client];
      }
      if (clientKey.includes("::user:")) {
        return [clientKey, client];
      }
    }
    return firstAlive;
  }

  async function closeClientByKey(clientKey) {
    const normalizedClientKey = normalizeText(clientKey);
    if (!normalizedClientKey) {
      return;
    }
    const client = clientsByKey.get(normalizedClientKey);
    if (!client) {
      return;
    }
    await client.close();
    if (clientsByKey.get(normalizedClientKey) === client) {
      clientsByKey.delete(normalizedClientKey);
    }
    clearApprovalsForClientKey(normalizedClientKey);
  }

  async function closeWorkspaceClient(workspaceRoot, options = {}) {
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    if (!normalizedWorkspaceRoot) {
      return;
    }
    if (options?.threadId) {
      const [clientKey] = findClientEntryByThreadId(options.threadId) || [];
      if (clientKey) {
        await closeClientByKey(clientKey);
        return;
      }
    }
    if (options?.bindingKey || options?.systemRuntimeBinding) {
      await closeClientByKey(buildClientKey(normalizedWorkspaceRoot, options));
      return;
    }
    for (const [clientKey, client] of [...clientsByKey.entries()]) {
      if (normalizeText(client.__mossbridgeWorkspaceRoot || client.workspaceRoot) === normalizedWorkspaceRoot) {
        await closeClientByKey(clientKey);
      }
    }
  }

  async function closeIdleSystemClient({
    threadId = "",
    workspaceRoot = "",
    bindingKey = "",
    systemRuntimeBinding = false,
    systemToolProfile = "",
    toolProfile = "",
  } = {}) {
    const scope = resolveRuntimeCallScope({
      bindingKey,
      threadId,
      metadata: {
        systemRuntimeBinding,
        systemToolProfile: systemToolProfile || toolProfile,
        toolProfile,
      },
      systemRuntimeBinding,
    });
    if (!scope.systemRuntimeBinding) {
      return { closed: false, reason: "not_system_runtime" };
    }

    let entry = findClientEntryByThreadId(threadId);
    const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
    if (!entry && normalizedWorkspaceRoot) {
      const clientKey = buildClientKey(normalizedWorkspaceRoot, scope);
      const client = clientsByKey.get(clientKey);
      if (client) {
        entry = [clientKey, client];
      }
    }
    if (!entry) {
      return { closed: false, reason: "not_found" };
    }

    const [clientKey, client] = entry;
    if (!clientKey.includes("::system:")) {
      return { closed: false, reason: "not_system_client", clientKey };
    }
    if (normalizeText(client?.pendingTurnId)) {
      return { closed: false, reason: "active_turn", clientKey };
    }
    if (!client?.alive) {
      if (clientsByKey.get(clientKey) === client) {
        clientsByKey.delete(clientKey);
      }
      clearApprovalsForClientKey(clientKey);
      return { closed: false, reason: "not_alive", clientKey };
    }

    await closeClientByKey(clientKey);
    return { closed: true, clientKey };
  }

  function clearApprovalsForClientKey(clientKey) {
    for (const [requestId, candidateClientKey] of pendingApprovals.entries()) {
      if (candidateClientKey === clientKey) {
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
    hasActiveTurn({ bindingKey = "", workspaceRoot = "", threadId = "", systemRuntimeBinding = false } = {}) {
      const scope = resolveRuntimeCallScope({ bindingKey, threadId, metadata: { systemRuntimeBinding } });
      const clientKey = buildClientKey(workspaceRoot, scope);
      const client = clientsByKey.get(clientKey);
      if (client?.alive && normalizeText(client.pendingTurnId)) {
        return true;
      }
      if (threadId) {
        const [, threadClient] = findClientEntryByThreadId(threadId) || [];
        return Boolean(threadClient?.alive && normalizeText(threadClient.pendingTurnId));
      }
      return false;
    },
    async closeIdleSystemClient(options = {}) {
      return closeIdleSystemClient(options);
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
      for (const clientKey of [...clientsByKey.keys()]) {
        await closeClientByKey(clientKey);
      }
      await ipcServer.close();
    },
    async startFreshThreadDraft({ bindingKey = "", workspaceRoot, systemRuntimeBinding = false } = {}) {
      const scope = resolveRuntimeCallScope({ bindingKey, metadata: { systemRuntimeBinding } });
      if (scope.bindingKey) {
        sessionStore.clearPendingThreadIdForWorkspace(scope.bindingKey, workspaceRoot);
      } else {
        for (const binding of sessionStore.listBindings()) {
          if (binding.activeWorkspaceRoot === workspaceRoot) {
            sessionStore.clearPendingThreadIdForWorkspace(binding.bindingKey, workspaceRoot);
          }
        }
      }
      await closeWorkspaceClient(workspaceRoot, scope.bindingKey || scope.systemRuntimeBinding ? scope : {});
      return { workspaceRoot };
    },
    async respondApproval({ requestId, decision, result = null }) {
      const clientKey = pendingApprovals.get(requestId);
      const candidates = clientKey
        ? [clientsByKey.get(clientKey)]
        : [...clientsByKey.values()];
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
    async cancelTurn({ threadId, turnId, workspaceRoot, bindingKey = "", systemRuntimeBinding = false } = {}) {
      const [clientKey] = findClientEntryByThreadId(threadId) || [];
      if (clientKey) {
        await closeClientByKey(clientKey);
        return { threadId, turnId };
      }
      if (workspaceRoot && (bindingKey || systemRuntimeBinding)) {
        await closeWorkspaceClient(workspaceRoot, { bindingKey, systemRuntimeBinding });
        return { threadId, turnId };
      }
      if (workspaceRoot) {
        const [preferredClientKey] = findPreferredClientEntryForWorkspace(workspaceRoot) || [];
        if (preferredClientKey) {
          await closeClientByKey(preferredClientKey);
        }
      }
      return { threadId, turnId };
    },
    async resumeThread({ threadId, workspaceRoot, model = "", bindingKey = "", systemRuntimeBinding = false } = {}) {
      if (!workspaceRoot) {
        return { threadId };
      }
      const scope = resolveRuntimeCallScope({ bindingKey, threadId, metadata: { systemRuntimeBinding } });
      const attached = await attachClientToThread(workspaceRoot, threadId, model, scope);
      return { threadId: attached.threadId };
    },
    async compactThread({ threadId, workspaceRoot, model = "", bindingKey = "", systemRuntimeBinding = false } = {}) {
      const scope = resolveRuntimeCallScope({ bindingKey, threadId, metadata: { systemRuntimeBinding } });
      const { client, threadId: activeThreadId } = await attachClientToThread(workspaceRoot, threadId, model, scope);
      await client.sendUserMessage({ text: "/compact", threadId: activeThreadId });
      return { threadId: activeThreadId, turnId: client.pendingTurnId };
    },
    async refreshThreadInstructions({ threadId, workspaceRoot, model = "", bindingKey = "", systemRuntimeBinding = false } = {}) {
      const scope = resolveRuntimeCallScope({ bindingKey, threadId, metadata: { systemRuntimeBinding } });
      const { client, threadId: activeThreadId } = await attachClientToThread(workspaceRoot, threadId, model, scope);
      const refreshText = buildInstructionRefreshText(config);
      await client.sendUserMessage({ text: refreshText, threadId: activeThreadId });
      return { threadId: activeThreadId };
    },
    async sendTextTurn({ bindingKey, workspaceRoot, text, metadata = {}, model = "" }) {
      const scope = resolveRuntimeCallScope({ bindingKey, metadata });
      let threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      if (!threadId) {
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
      }
      let openingTurn = !threadId;
      const skipOpeningInstructions = Boolean(metadata?.skipOpeningInstructions);
      let attached;
      try {
        try {
          attached = await attachClientToThread(workspaceRoot, threadId, model, scope);
        } catch (error) {
          if (!threadId) {
            throw error;
          }
          sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
          sessionStore.clearPendingThreadIdForWorkspace(bindingKey, workspaceRoot);
          threadId = "";
          openingTurn = true;
          attached = await attachClientToThread(workspaceRoot, "", model, scope);
        }
        const { client, threadId: activeThreadId } = attached;
        const outboundText = skipOpeningInstructions
          ? buildSystemWakeTurnText(config, text)
          : (openingTurn ? buildOpeningTurnText(config, text) : text);
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
            await closeWorkspaceClient(workspaceRoot, { ...scope, threadId });
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
      } catch (error) {
        if (attached?.client) {
          const clientKey = attached.client.__mossbridgeClientKey || buildClientKey(workspaceRoot, scope);
          await closeClientByKey(clientKey).catch((closeError) => {
            console.error(`[claudecode-runtime] failed to close failed turn client: ${closeError.message}`);
          });
        }
        throw error;
      }
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

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeThreadId(value) {
  return typeof value === "string" ? value.replace(/\s+/g, "").trim() : "";
}

function normalizeModelId(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isSystemRuntimeBindingKey(value) {
  return normalizeText(value).includes("#mossbridge-system");
}

function clientMatchesThread(client, threadId) {
  const normalizedThreadId = normalizeThreadId(threadId);
  if (!normalizedThreadId || !client?.alive) {
    return false;
  }
  return normalizeThreadId(client.sessionId) === normalizedThreadId
    || normalizeThreadId(client.resumeSessionId) === normalizedThreadId
    || normalizeThreadId(client.activeThreadId) === normalizedThreadId;
}

function clientMatchesModel(client, model) {
  const normalizedModel = normalizeModelId(model);
  if (!normalizedModel) {
    return true;
  }
  return normalizeModelId(client?.model) === normalizedModel;
}
