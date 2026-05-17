const { CodexRpcClient } = require("./rpc-client");
const { buildOpeningTurnText, buildSystemWakeTurnText, buildInstructionRefreshText } = require("../shared-instructions");
const { mapCodexMessageToRuntimeEvent } = require("./events");
const {
  extractAssistantText,
  extractFailureText,
  extractThreadId,
  extractTurnId,
  extractThreadIdFromParams,
  extractTurnIdFromParams,
  isAssistantItemCompleted,
} = require("./message-utils");
const { findModelByQuery } = require("./model-catalog");
const { SessionStore } = require("./session-store");
const { normalizeToolProfile, resolveCodexProjectToolMcpServerConfig } = require("./mcp-config");

function createCodexRuntimeAdapter(config) {
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId: "codex" });
  const clientsByProfile = new Map();
  const readyStateByProfile = new Map();
  const eventListeners = new Set();
  const configuredModel = normalizeText(config.codexModel);
  const configuredModelProvider = normalizeText(config.codexModelProvider);

  function resolveModel(model = "", storedParams = null) {
    if (configuredModel) {
      return configuredModel;
    }
    if (storedParams && normalizeText(storedParams.modelProvider) !== configuredModelProvider) {
      return "";
    }
    return normalizeText(model);
  }

  function ensureClient({ toolProfile = "" } = {}) {
    const normalizedToolProfile = normalizeToolProfile(toolProfile);
    let runtimeClient = clientsByProfile.get(normalizedToolProfile);
    if (!runtimeClient) {
      runtimeClient = new CodexRpcClient({
        endpoint: config.codexEndpoint,
        codexCommand: config.codexCommand,
        env: process.env,
        extraWritableRoots: [config.stateDir],
        mcpServerConfig: resolveCodexProjectToolMcpServerConfig({ toolProfile: normalizedToolProfile }),
      });
      runtimeClient.__mossbridgeToolProfile = normalizedToolProfile;
      runtimeClient.onMessage((message) => {
        const event = mapCodexMessageToRuntimeEvent(message);
        if (!event) {
          return;
        }
        for (const listener of eventListeners) {
          listener(event, message);
        }
      });
      clientsByProfile.set(normalizedToolProfile, runtimeClient);
    }
    return runtimeClient;
  }

  function resolveToolProfileForOperation({ bindingKey = "", threadId = "", metadata = {}, toolProfile = "" } = {}) {
    const rawMetadataToolProfile = normalizeText(toolProfile || metadata?.systemToolProfile || metadata?.toolProfile);
    if (rawMetadataToolProfile) {
      return normalizeToolProfile(rawMetadataToolProfile);
    }
    const normalizedBindingKey = normalizeText(bindingKey);
    if (normalizedBindingKey) {
      const binding = sessionStore.getBinding(normalizedBindingKey) || {};
      const rawBindingToolProfile = normalizeText(binding.systemToolProfile || binding.toolProfile);
      if (rawBindingToolProfile) {
        return normalizeToolProfile(rawBindingToolProfile);
      }
    }
    const normalizedThreadId = normalizeText(threadId);
    if (normalizedThreadId) {
      const linked = sessionStore.findBindingForThreadId(normalizedThreadId);
      if (linked?.bindingKey) {
        const binding = sessionStore.getBinding(linked.bindingKey) || {};
        const rawLinkedBindingToolProfile = normalizeText(binding.systemToolProfile || binding.toolProfile);
        if (rawLinkedBindingToolProfile) {
          return normalizeToolProfile(rawLinkedBindingToolProfile);
        }
      }
    }
    return "foreground";
  }

  return {
    describe() {
      return {
        id: "codex",
        kind: "runtime",
        endpoint: config.codexEndpoint || "(spawn)",
        sessionsFile: config.sessionsFile,
        model: configuredModel,
        modelProvider: configuredModelProvider,
      };
    },
    createClient() {
      return ensureClient();
    },
    onEvent(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    getSessionStore() {
      return sessionStore;
    },
    getTurnCapabilities({ model = "" } = {}) {
      const forcedNativeImageInput = config.codexNativeImageInput;
      if (typeof forcedNativeImageInput === "boolean") {
        return {
          nativeImageInput: forcedNativeImageInput,
          toolImageRead: false,
        };
      }
      const effectiveModel = normalizeText(configuredModel) || normalizeText(model);
      const catalog = sessionStore.getAvailableModelCatalog();
      const catalogModel = findModelByQuery(catalog?.models, effectiveModel);
      return {
        nativeImageInput: hasImageInputModality(catalogModel),
        toolImageRead: false,
      };
    },
    async initialize(options = {}) {
      const toolProfile = resolveToolProfileForOperation(options);
      const runtimeClient = ensureClient({ toolProfile });
      const readyState = readyStateByProfile.get(toolProfile);
      if (readyState && runtimeClient.isReady && runtimeClient.isTransportReady()) {
        return readyState;
      }
      await runtimeClient.connect();
      await runtimeClient.initialize();
      const catalog = await refreshModelCatalog(runtimeClient, sessionStore).catch(() => ({ models: [] }));
      const models = catalog.models || [];
      const nextReadyState = {
        endpoint: config.codexEndpoint || "(spawn)",
        models,
        toolProfile,
      };
      readyStateByProfile.set(toolProfile, nextReadyState);
      return nextReadyState;
    },
    async refreshModelCatalog() {
      const runtimeClient = ensureClient();
      await runtimeClient.connect();
      await runtimeClient.initialize();
      return refreshModelCatalog(runtimeClient, sessionStore);
    },
    async close() {
      for (const runtimeClient of clientsByProfile.values()) {
        await runtimeClient.close();
      }
      readyStateByProfile.clear();
      clientsByProfile.clear();
    },
    async startFreshThreadDraft() {
      return {};
    },
    async respondApproval({ requestId, decision, result = null }) {
      const runtimeClient = ensureClient();
      await this.initialize();
      if (requestId == null || String(requestId).trim() === "") {
        throw new Error("approval response requires a requestId");
      }
      const responsePayload = result && typeof result === "object"
        ? result
        : { decision: decision === "accept" ? "accept" : "decline" };
      await runtimeClient.sendResponse(requestId, responsePayload);
      return {
        requestId,
        ...(result && typeof result === "object"
          ? { result: responsePayload }
          : { decision: responsePayload.decision }),
      };
    },
    async cancelTurn({ threadId, turnId, bindingKey = "" } = {}) {
      const toolProfile = resolveToolProfileForOperation({ bindingKey, threadId });
      const runtimeClient = ensureClient({ toolProfile });
      await this.initialize({ toolProfile });
      await runtimeClient.cancelTurn({ threadId, turnId });
      return { threadId, turnId };
    },
    async resumeThread({ threadId, bindingKey = "" } = {}) {
      const toolProfile = resolveToolProfileForOperation({ bindingKey, threadId });
      const runtimeClient = ensureClient({ toolProfile });
      await this.initialize({ toolProfile });
      return runtimeClient.resumeThread({
        threadId,
        model: configuredModel,
        modelProvider: configuredModelProvider,
      });
    },
    async compactThread({ threadId, bindingKey = "" } = {}) {
      const toolProfile = resolveToolProfileForOperation({ bindingKey, threadId });
      const runtimeClient = ensureClient({ toolProfile });
      await this.initialize({ toolProfile });
      return runtimeClient.compactThread({ threadId });
    },
    async refreshThreadInstructions({ threadId, workspaceRoot, model = "", modelProvider = "" }) {
      const runtimeClient = ensureClient();
      await this.initialize();
      const refreshText = buildInstructionRefreshText(config);
      const desiredModel = resolveModel(model, { modelProvider });
      await runtimeClient.resumeThread({
        threadId,
        model: desiredModel,
        modelProvider: configuredModelProvider,
      });
      const completion = waitForTurnCompletion(runtimeClient, threadId);
      await runtimeClient.sendUserMessage({
        threadId,
        text: refreshText,
        model: desiredModel,
        modelProvider: configuredModelProvider,
        workspaceRoot,
      });
      const result = await completion;
      return { threadId, ...result };
    },
    async sendTextTurn(args) {
      return this.sendTurn(args);
    },
    async sendTurn({ bindingKey, workspaceRoot, text, attachments = [], metadata = {}, model = "" }) {
      const toolProfile = resolveToolProfileForOperation({ bindingKey, metadata });
      const runtimeClient = ensureClient({ toolProfile });
      await this.initialize({ toolProfile });

      let threadId = sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      const storedParams = sessionStore.getRuntimeParamsForWorkspace(bindingKey, workspaceRoot);
      const desiredModel = resolveModel(model, storedParams);
      const desiredModelProvider = configuredModelProvider;
      if (threadId && !runtimeParamsMatch(storedParams, {
        model: desiredModel,
        modelProvider: desiredModelProvider,
      })) {
        sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
        threadId = "";
      }
      sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
        model: desiredModel,
        modelProvider: desiredModelProvider,
      });
      const skipOpeningInstructions = Boolean(metadata?.skipOpeningInstructions);
      let outboundText = skipOpeningInstructions ? buildSystemWakeTurnText(config, text) : text;
      if (!threadId) {
        const response = await runtimeClient.startThread({
          cwd: workspaceRoot,
          model: desiredModel,
          modelProvider: desiredModelProvider,
        });
        threadId = extractThreadId(response);
        if (!threadId) {
          throw new Error("thread/start did not return a thread id");
        }
        sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata);
        outboundText = skipOpeningInstructions ? buildSystemWakeTurnText(config, text) : buildOpeningTurnText(config, text);
      } else {
        await runtimeClient.resumeThread({
          threadId,
          model: desiredModel,
          modelProvider: desiredModelProvider,
        }).catch(async () => {
          sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
          const recreated = await runtimeClient.startThread({
            cwd: workspaceRoot,
            model: desiredModel,
            modelProvider: desiredModelProvider,
          });
          threadId = extractThreadId(recreated);
          if (!threadId) {
            throw new Error("thread/start did not return a thread id");
          }
          sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata);
          sessionStore.setRuntimeParamsForWorkspace(bindingKey, workspaceRoot, {
            model: desiredModel,
            modelProvider: desiredModelProvider,
          });
          outboundText = skipOpeningInstructions ? buildSystemWakeTurnText(config, text) : buildOpeningTurnText(config, text);
        });
      }

      const response = await runtimeClient.sendUserMessage({
        threadId,
        text: outboundText,
        attachments,
        model: desiredModel,
        modelProvider: desiredModelProvider,
        workspaceRoot,
      });
      return {
        threadId,
        turnId: extractTurnId(response),
      };
    },
  };
}

module.exports = { createCodexRuntimeAdapter };

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function runtimeParamsMatch(storedParams, desiredParams) {
  return normalizeText(storedParams?.model) === normalizeText(desiredParams?.model)
    && normalizeText(storedParams?.modelProvider) === normalizeText(desiredParams?.modelProvider);
}

function hasImageInputModality(model) {
  const modalities = Array.isArray(model?.inputModalities) ? model.inputModalities : [];
  return modalities.some((item) => normalizeText(item).toLowerCase() === "image");
}

async function refreshModelCatalog(runtimeClient, sessionStore) {
  const modelResponse = await runtimeClient.listModels();
  const models = Array.isArray(modelResponse?.result?.data)
    ? modelResponse.result.data
    : [];
  const catalog = models.length ? sessionStore.setAvailableModelCatalog(models) : null;
  return {
    models: catalog?.models || [],
    updatedAt: catalog?.updatedAt || "",
    source: "codex_rpc_model_list",
    acceptsRawModel: true,
  };
}

function waitForTurnCompletion(client, threadId) {
  return new Promise((resolve, reject) => {
    let activeTurnId = "";
    const itemOrder = [];
    const completedTextByItemId = new Map();

    const cleanup = () => {
      unsubscribe();
      clearTimeout(timer);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("codex turn timed out"));
    }, 10 * 60_000);

    const unsubscribe = client.onMessage((message) => {
      const params = message?.params || {};
      if (extractThreadIdFromParams(params) !== threadId) {
        return;
      }

      if ((message?.method === "turn/started" || message?.method === "turn/start") && !activeTurnId) {
        activeTurnId = extractTurnIdFromParams(params);
        return;
      }

      if (isAssistantItemCompleted(message)) {
        const itemId = typeof params?.item?.id === "string" ? params.item.id.trim() : `item-${itemOrder.length + 1}`;
        if (!completedTextByItemId.has(itemId)) {
          itemOrder.push(itemId);
        }
        completedTextByItemId.set(itemId, extractAssistantText(params));
        return;
      }

      if (message?.method === "turn/failed") {
        cleanup();
        reject(new Error(extractFailureText(params)));
        return;
      }

      if (message?.method === "turn/completed") {
        const completedTurnId = extractTurnIdFromParams(params);
        if (activeTurnId && completedTurnId && completedTurnId !== activeTurnId) {
          return;
        }
        cleanup();
        const text = itemOrder
          .map((itemId) => completedTextByItemId.get(itemId) || "")
          .filter(Boolean)
          .join("\n\n")
          .trim();
        resolve({
          turnId: completedTurnId || activeTurnId,
          text: text || "Completed.",
        });
      }
    });
  });
}
