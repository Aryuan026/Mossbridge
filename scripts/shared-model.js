const fs = require("fs");
const os = require("os");
const path = require("path");

try {
  require("dotenv").config({ path: path.join(process.cwd(), ".env") });
} catch {
  // ignore
}

try {
  require("dotenv").config({ path: path.join(os.homedir(), ".mossbridge", ".env") });
} catch {
  // ignore
}

const rootDir = path.resolve(__dirname, "..");

async function main() {
  const result = runSharedModel({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
  });
  process.stdout.write(result);
}

function runSharedModel({ argv = [], env = process.env, cwd = process.cwd() } = {}) {
  const options = parseArgs(argv);
  const runtime = normalizeText(env.MOSSBRIDGE_RUNTIME) || "codex";
  const stateDir = normalizeText(env.MOSSBRIDGE_STATE_DIR) || path.join(os.homedir(), ".mossbridge");
  const sessionFile = options.sessionFile
    || normalizeText(env.MOSSBRIDGE_SESSIONS_FILE)
    || path.join(stateDir, "sessions.json");
  const envFile = options.envFile
    || normalizeText(env.MOSSBRIDGE_ENV_FILE)
    || path.join(rootDir, ".env");
  const workspaceRoot = path.resolve(
    options.workspaceRoot
    || normalizeText(env.MOSSBRIDGE_WORKSPACE_ROOT)
    || cwd
  );
  const state = loadSessionState(sessionFile);
  const selected = selectBindingForWorkspace(state, workspaceRoot, runtime, normalizeText(env.MOSSBRIDGE_ACCOUNT_ID));
  const currentModel = getBindingModel(selected?.binding, workspaceRoot);
  const currentProvider = getBindingModelProvider(selected?.binding, workspaceRoot);
  const envDefaultModel = runtime === "claudecode"
    ? normalizeText(env.MOSSBRIDGE_CLAUDE_MODEL)
    : normalizeText(env.MOSSBRIDGE_CODEX_MODEL);
  const envDefaultProvider = runtime === "codex" ? normalizeText(env.MOSSBRIDGE_CODEX_MODEL_PROVIDER) : "";
  const modelChoices = resolveConfiguredModelChoices(runtime, env);

  if (!options.model && !options.clear && !options.providerSpecified) {
    return formatSummary({
      runtime,
      workspaceRoot,
      sessionFile,
      envFile,
      bindingKey: selected?.bindingKey || "",
      threadId: getThreadId(selected?.binding, workspaceRoot, runtime),
      sessionModel: currentModel,
      sessionProvider: currentProvider,
      envDefaultModel,
      envDefaultProvider,
      modelChoices,
      changed: false,
    });
  }

  if (!selected) {
    throw new Error(`No bound WeChat session found for workspace: ${workspaceRoot}`);
  }

  const resolvedChoice = !options.clear && options.model
    ? resolveModelChoice(modelChoices, options.model)
    : null;
  if (!options.clear && options.model && modelChoices.length && !resolvedChoice) {
    throw new Error(buildModelNotFoundText(options.model, modelChoices));
  }
  const nextModel = options.clear ? "" : resolvedChoice?.model || options.model;
  const nextProvider = runtime === "codex"
    ? options.providerSpecified
      ? options.provider
      : options.clear
        ? ""
        : resolvedChoice?.modelProvider || currentProvider
    : currentProvider;
  setBindingRuntimeParams(selected.binding, workspaceRoot, {
    model: nextModel,
    modelProvider: nextProvider,
  });
  state.bindings[selected.bindingKey] = selected.binding;
  saveSessionState(sessionFile, state);

  let envUpdated = false;
  if (runtime === "claudecode" && nextModel) {
    upsertEnvValue(envFile, "MOSSBRIDGE_CLAUDE_MODEL", nextModel);
    envUpdated = true;
  }

  return formatSummary({
    runtime,
    workspaceRoot,
    sessionFile,
    envFile,
    bindingKey: selected.bindingKey,
    threadId: getThreadId(selected.binding, workspaceRoot, runtime),
    sessionModel: nextModel,
    sessionProvider: nextProvider,
    envDefaultModel: runtime === "claudecode" ? nextModel || envDefaultModel : envDefaultModel,
    envDefaultProvider,
    modelChoices,
    changed: true,
    envUpdated,
  });
}

function parseArgs(argv = []) {
  const options = {
    model: "",
    provider: "",
    providerSpecified: false,
    clear: false,
    workspaceRoot: "",
    sessionFile: "",
    envFile: "",
  };
  const modelParts = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || "").trim();
    if (!arg) {
      continue;
    }
    if (arg === "--clear") {
      options.clear = true;
      continue;
    }
    if (["default", "clear", "reset"].includes(arg.toLowerCase())) {
      options.clear = true;
      continue;
    }
    if (arg === "--provider" || arg === "-p") {
      index += 1;
      if (!argv[index]) {
        throw new Error("--provider requires a provider value");
      }
      options.providerSpecified = true;
      options.provider = normalizeModelProviderArg(argv[index]);
      continue;
    }
    if (arg.startsWith("--provider=")) {
      options.providerSpecified = true;
      options.provider = normalizeModelProviderArg(arg.slice("--provider=".length));
      continue;
    }
    if (arg === "--workspace") {
      index += 1;
      options.workspaceRoot = String(argv[index] || "").trim();
      continue;
    }
    if (arg === "--session-file") {
      index += 1;
      options.sessionFile = String(argv[index] || "").trim();
      continue;
    }
    if (arg === "--env-file") {
      index += 1;
      options.envFile = String(argv[index] || "").trim();
      continue;
    }
    modelParts.push(arg);
  }
  options.model = modelParts.join(" ").trim();
  if (options.clear && options.model) {
    throw new Error("Use either --clear or a model name, not both.");
  }
  return options;
}

function loadSessionState(sessionFile) {
  try {
    const raw = fs.readFileSync(sessionFile, "utf8");
    const parsed = JSON.parse(raw);
    return {
      bindings: {},
      approvalCommandAllowlistByWorkspaceRoot: {},
      approvalPromptStateByThreadId: {},
      availableModelCatalog: { models: [], updatedAt: "" },
      ...(parsed && typeof parsed === "object" ? parsed : {}),
    };
  } catch {
    return {
      bindings: {},
      approvalCommandAllowlistByWorkspaceRoot: {},
      approvalPromptStateByThreadId: {},
      availableModelCatalog: { models: [], updatedAt: "" },
    };
  }
}

function saveSessionState(sessionFile, state) {
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function selectBindingForWorkspace(state, workspaceRoot, runtime, accountId = "") {
  const entries = Object.entries(state.bindings || {});
  const candidates = entries
    .filter(([, binding]) => !accountId || normalizeText(binding?.accountId) === accountId)
    .map(([bindingKey, binding], index) => ({ bindingKey, binding, index }));
  const exact = candidates.find(({ binding }) =>
    normalizeText(binding?.activeWorkspaceRoot) === workspaceRoot
    || Boolean(getThreadId(binding, workspaceRoot, runtime))
    || Boolean(getBindingModel(binding, workspaceRoot))
    || Boolean(getBindingModelProvider(binding, workspaceRoot))
  );
  return exact || candidates[0] || null;
}

function getBindingModel(binding, workspaceRoot) {
  if (!binding || !workspaceRoot) {
    return "";
  }
  const params = binding.codexParamsByWorkspaceRoot && typeof binding.codexParamsByWorkspaceRoot === "object"
    ? binding.codexParamsByWorkspaceRoot
    : {};
  return normalizeText(params[workspaceRoot]?.model);
}

function getBindingModelProvider(binding, workspaceRoot) {
  if (!binding || !workspaceRoot) {
    return "";
  }
  const params = binding.codexParamsByWorkspaceRoot && typeof binding.codexParamsByWorkspaceRoot === "object"
    ? binding.codexParamsByWorkspaceRoot
    : {};
  return normalizeText(params[workspaceRoot]?.modelProvider || params[workspaceRoot]?.model_provider);
}

function setBindingRuntimeParams(binding, workspaceRoot, { model = "", modelProvider = "" } = {}) {
  binding.activeWorkspaceRoot = normalizeText(binding.activeWorkspaceRoot) || workspaceRoot;
  const previous = binding.codexParamsByWorkspaceRoot && typeof binding.codexParamsByWorkspaceRoot === "object"
    ? binding.codexParamsByWorkspaceRoot
    : {};
  binding.codexParamsByWorkspaceRoot = {
    ...previous,
    [workspaceRoot]: {
      ...(previous[workspaceRoot] && typeof previous[workspaceRoot] === "object" ? previous[workspaceRoot] : {}),
      model: normalizeText(model),
      modelProvider: normalizeText(modelProvider),
    },
  };
}

function getThreadId(binding, workspaceRoot, runtime) {
  if (!binding || !workspaceRoot) {
    return "";
  }
  const runtimeMap = binding.threadIdByWorkspaceRootByRuntime && typeof binding.threadIdByWorkspaceRootByRuntime === "object"
    ? binding.threadIdByWorkspaceRootByRuntime
    : {};
  const scoped = runtimeMap[normalizeText(runtime)] || {};
  return normalizeText(scoped[workspaceRoot]);
}

function resolveConfiguredModelChoices(runtime, env = process.env) {
  const globalChoices = readEnvList(env.MOSSBRIDGE_MODEL_CHOICES);
  const runtimeChoices = runtime === "codex"
    ? readEnvList(env.MOSSBRIDGE_CODEX_MODEL_CHOICES)
    : readEnvList(env.MOSSBRIDGE_CLAUDE_MODEL_CHOICES);
  const choices = [];
  const seen = new Set();
  for (const choice of [...globalChoices, ...runtimeChoices]) {
    const parsed = parseConfiguredModelChoice(choice, runtime);
    if (!parsed.model) {
      continue;
    }
    const key = `${parsed.model.toLowerCase()}@${parsed.modelProvider.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    choices.push(parsed);
  }
  return choices;
}

function parseConfiguredModelChoice(value, runtime) {
  const text = normalizeText(value);
  const eqIndex = text.indexOf("=");
  const alias = eqIndex > 0 ? normalizeText(text.slice(0, eqIndex)) : "";
  const target = eqIndex > 0 ? normalizeText(text.slice(eqIndex + 1)) : text;
  if (!target) {
    return { model: "", modelProvider: "", aliases: [] };
  }
  const split = splitModelProviderTarget(target, runtime);
  return {
    model: split.model,
    modelProvider: split.provider,
    aliases: alias ? [alias] : [],
  };
}

function splitModelProviderTarget(target, runtime) {
  const text = normalizeText(target);
  if (runtime !== "codex") {
    return { model: text, provider: "" };
  }
  const atIndex = text.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === text.length - 1) {
    return { model: text, provider: "" };
  }
  return {
    model: normalizeText(text.slice(0, atIndex)),
    provider: normalizeModelProviderArg(text.slice(atIndex + 1)),
  };
}

function resolveModelChoice(choices, query) {
  const normalizedQuery = normalizeText(query).toLowerCase();
  if (!normalizedQuery || !Array.isArray(choices)) {
    return null;
  }
  const exact = choices.find((choice) =>
    normalizeText(choice.model).toLowerCase() === normalizedQuery
    || normalizeText(choice.modelProvider ? `${choice.model}@${choice.modelProvider}` : choice.model).toLowerCase() === normalizedQuery
    || normalizeText(choice.aliases?.[0]).toLowerCase() === normalizedQuery
  );
  if (exact) {
    return exact;
  }
  const loose = choices.filter((choice) => {
    const candidates = [choice.model, choice.aliases?.[0]].map((item) => normalizeText(item).toLowerCase()).filter(Boolean);
    return candidates.some((candidate) => candidate.includes(normalizedQuery));
  });
  return loose.length === 1 ? loose[0] : null;
}

function buildModelNotFoundText(query, choices) {
  const suggestions = suggestModelChoices(query, choices);
  const lines = [
    "Model not found.",
    `query: ${normalizeText(query) || "(empty)"}`,
  ];
  if (suggestions.length) {
    lines.push(`did_you_mean: ${suggestions.join(", ")}`);
  }
  if (choices.length) {
    lines.push(`available: ${formatModelChoices(choices)}`);
  }
  return lines.join("\n");
}

function suggestModelChoices(query, choices) {
  const normalizedQuery = normalizeText(query).toLowerCase();
  if (!normalizedQuery) {
    return [];
  }
  return (Array.isArray(choices) ? choices : [])
    .map((choice) => {
      const label = formatModelChoice(choice);
      const candidates = [choice.model, choice.aliases?.[0]].map((item) => normalizeText(item).toLowerCase()).filter(Boolean);
      const score = candidates.some((candidate) => candidate.includes(normalizedQuery))
        ? 80
        : candidates.some((candidate) => normalizedQuery.includes(candidate))
          ? 50
          : 0;
      return { label, score };
    })
    .filter((item) => item.score > 0)
    .slice(0, 3)
    .map((item) => item.label);
}

function formatModelChoices(choices) {
  return (Array.isArray(choices) ? choices : []).map(formatModelChoice).filter(Boolean).join(", ");
}

function formatModelChoice(choice) {
  const alias = normalizeText(choice?.aliases?.[0]);
  const model = normalizeText(choice?.model);
  const provider = normalizeText(choice?.modelProvider);
  const modelWithProvider = provider ? `${model}@${provider}` : model;
  return alias ? `${alias}=${modelWithProvider}` : modelWithProvider;
}

function readEnvList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function upsertEnvValue(envFile, key, value) {
  const line = `${key}=${value}`;
  let raw = "";
  try {
    raw = fs.readFileSync(envFile, "utf8");
  } catch {
    raw = "";
  }
  const lines = raw.split(/\r?\n/);
  let replaced = false;
  const next = lines.map((existing) => {
    if (existing.startsWith(`${key}=`)) {
      replaced = true;
      return line;
    }
    return existing;
  });
  if (!replaced) {
    if (next.length && next[next.length - 1] !== "") {
      next.push("");
    }
    next.push(line);
  }
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.writeFileSync(envFile, `${next.join("\n").replace(/\n+$/u, "")}\n`, "utf8");
}

function formatSummary({
  runtime,
  workspaceRoot,
  sessionFile,
  envFile,
  bindingKey,
  threadId,
  sessionModel,
  sessionProvider,
  envDefaultModel,
  envDefaultProvider,
  modelChoices = [],
  changed,
  envUpdated = false,
}) {
  const lines = [];
  lines.push(changed ? "Model selection updated." : "Model selection status.");
  lines.push(`runtime: ${runtime}`);
  lines.push(`workspace: ${workspaceRoot}`);
  lines.push(`session_model: ${sessionModel || "(default)"}`);
  lines.push(`effective_model: ${sessionModel || envDefaultModel || "(runtime default)"}`);
  if (runtime === "codex") {
    lines.push(`session_provider: ${sessionProvider || "(default)"}`);
    lines.push(`effective_provider: ${sessionProvider || envDefaultProvider || "(default)"}`);
  }
  if (envDefaultModel) {
    lines.push(`env_model: ${envDefaultModel}`);
  }
  if (envDefaultProvider) {
    lines.push(`env_provider: ${envDefaultProvider}`);
  }
  if (runtime === "codex" && (envDefaultModel || envDefaultProvider)) {
    lines.push("note: Codex env model/provider is pinned and may override this session selection until the shared bridge is restarted with env updated or cleared.");
  }
  if (modelChoices.length) {
    lines.push(`available: ${formatModelChoices(modelChoices)}`);
  }
  if (changed) {
    lines.push("applies_to: next_turn");
  }
  lines.push(`thread: ${threadId || "(not bound yet)"}`);
  lines.push(`binding: ${bindingKey || "(not found)"}`);
  lines.push(`sessions: ${sessionFile}`);
  if (envUpdated) {
    lines.push(`env: ${envFile}`);
  }
  return `${lines.join("\n")}\n`;
}

function normalizeModelProviderArg(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["", "default", "cloud", "none", "clear"].includes(normalized)) {
    return "";
  }
  return normalizeText(value);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  runSharedModel,
  selectBindingForWorkspace,
};
