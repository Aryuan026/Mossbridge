const test = require("node:test");
const assert = require("node:assert/strict");

const { MossbridgeApp } = require("../src/core/app");

function createHarness({
  runtimeId = "codex",
  selectedModel = "",
  catalog = null,
  refreshResult,
  claudeModel = "",
} = {}) {
  let model = selectedModel;
  let currentCatalog = catalog;
  const sent = [];
  const sessionStore = {
    buildBindingKey() {
      return "default:account:user";
    },
    getRuntimeParamsForWorkspace() {
      return { model };
    },
    setRuntimeParamsForWorkspace(_bindingKey, _workspaceRoot, next) {
      model = String(next?.model || "").trim();
    },
    getAvailableModelCatalog() {
      return currentCatalog;
    },
    setAvailableModelCatalog(models) {
      currentCatalog = {
        models: Array.isArray(models) ? models : [],
        updatedAt: "2026-05-10T00:00:00.000Z",
      };
      return currentCatalog;
    },
  };
  const runtimeAdapter = {
    describe() {
      return { id: runtimeId };
    },
    getSessionStore() {
      return sessionStore;
    },
  };
  if (refreshResult !== undefined) {
    runtimeAdapter.refreshModelCatalog = async () => refreshResult;
  }
  const appLike = {
    config: { claudeModel },
    runtimeAdapter,
    resolveWorkspaceRoot() {
      return "/workspace";
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
    resolveRuntimeDefaultModel: MossbridgeApp.prototype.resolveRuntimeDefaultModel,
    resolveEffectiveModelLabel: MossbridgeApp.prototype.resolveEffectiveModelLabel,
    handleModelRefreshCommand: MossbridgeApp.prototype.handleModelRefreshCommand,
  };
  return {
    appLike,
    sent,
    getModel: () => model,
    getCatalog: () => currentCatalog,
  };
}

function normalizedMessage() {
  return {
    workspaceId: "default",
    accountId: "account",
    senderId: "user",
    contextToken: "ctx",
  };
}

test("model command reports selected, effective, and catalog state", async () => {
  const { appLike, sent } = createHarness({
    selectedModel: "gpt-5.5",
    catalog: {
      models: [
        { model: "gpt-5.4", isDefault: true },
        { model: "gpt-5.5" },
      ],
      updatedAt: "2026-05-10T00:00:00.000Z",
    },
  });

  await MossbridgeApp.prototype.handleModelCommand.call(appLike, normalizedMessage(), { args: "" });

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^\[Mossbridge] model_status/);
  assert.match(sent[0].text, /selected_model: gpt-5\.5/);
  assert.match(sent[0].text, /runtime_default: gpt-5\.4/);
  assert.match(sent[0].text, /effective_model: gpt-5\.5/);
  assert.match(sent[0].text, /available_models: gpt-5\.4, gpt-5\.5/);
});

test("model default clears the workspace override", async () => {
  const { appLike, sent, getModel } = createHarness({
    runtimeId: "claudecode",
    selectedModel: "claude-sonnet-4-6",
    claudeModel: "claude-opus-4-6",
  });

  await MossbridgeApp.prototype.handleModelCommand.call(appLike, normalizedMessage(), { args: "default" });

  assert.equal(getModel(), "");
  assert.match(sent[0].text, /^\[Mossbridge] model_selected/);
  assert.match(sent[0].text, /selected_model: \(default\)/);
  assert.match(sent[0].text, /effective_model: claude-opus-4-6/);
  assert.match(sent[0].text, /applies_to: next_turn/);
});

test("model refresh updates a runtime catalog", async () => {
  const { appLike, sent, getCatalog } = createHarness({
    refreshResult: {
      models: [
        { model: "gpt-5.4", isDefault: true },
        { model: "gpt-5.5" },
      ],
      source: "codex_rpc_model_list",
      acceptsRawModel: true,
    },
  });

  await MossbridgeApp.prototype.handleModelCommand.call(appLike, normalizedMessage(), { args: "refresh" });

  assert.equal(getCatalog().models.length, 2);
  assert.match(sent[0].text, /^\[Mossbridge] model_catalog_refreshed/);
  assert.match(sent[0].text, /catalog: 2 models/);
  assert.match(sent[0].text, /available_models: gpt-5\.4, gpt-5\.5/);
});

test("claudecode model command accepts raw model ids when no catalog exists", async () => {
  const { appLike, sent, getModel } = createHarness({
    runtimeId: "claudecode",
    refreshResult: {
      models: [],
      source: "claudecode_raw_model_id",
      acceptsRawModel: true,
    },
  });

  await MossbridgeApp.prototype.handleModelCommand.call(appLike, normalizedMessage(), { args: "claude-sonnet-4-6" });

  assert.equal(getModel(), "claude-sonnet-4-6");
  assert.match(sent[0].text, /^\[Mossbridge] model_selected/);
  assert.match(sent[0].text, /selected_model: claude-sonnet-4-6/);
  assert.match(sent[0].text, /source: raw_model_id/);
});

test("model command rejects unknown ids when a catalog is available", async () => {
  const { appLike, sent, getModel } = createHarness({
    selectedModel: "gpt-5.4",
    catalog: {
      models: [
        { model: "gpt-5.4", isDefault: true },
      ],
      updatedAt: "2026-05-10T00:00:00.000Z",
    },
  });

  await MossbridgeApp.prototype.handleModelCommand.call(appLike, normalizedMessage(), { args: "not-a-model" });

  assert.equal(getModel(), "gpt-5.4");
  assert.match(sent[0].text, /^\[Mossbridge] model_not_found/);
  assert.match(sent[0].text, /hint: \/model refresh/);
});
