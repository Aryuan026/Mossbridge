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
  const envDefaultModel = runtime === "claudecode" ? normalizeText(env.MOSSBRIDGE_CLAUDE_MODEL) : "";

  if (!options.model && !options.clear) {
    return formatSummary({
      runtime,
      workspaceRoot,
      sessionFile,
      envFile,
      bindingKey: selected?.bindingKey || "",
      threadId: getThreadId(selected?.binding, workspaceRoot, runtime),
      sessionModel: currentModel,
      envDefaultModel,
      changed: false,
    });
  }

  if (!selected) {
    throw new Error(`No bound WeChat session found for workspace: ${workspaceRoot}`);
  }

  const nextModel = options.clear ? "" : options.model;
  setBindingModel(selected.binding, workspaceRoot, nextModel);
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
    envDefaultModel: runtime === "claudecode" ? nextModel || envDefaultModel : envDefaultModel,
    changed: true,
    envUpdated,
  });
}

function parseArgs(argv = []) {
  const options = {
    model: "",
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

function setBindingModel(binding, workspaceRoot, model) {
  binding.activeWorkspaceRoot = normalizeText(binding.activeWorkspaceRoot) || workspaceRoot;
  binding.codexParamsByWorkspaceRoot = {
    ...(binding.codexParamsByWorkspaceRoot && typeof binding.codexParamsByWorkspaceRoot === "object"
      ? binding.codexParamsByWorkspaceRoot
      : {}),
    [workspaceRoot]: {
      model: normalizeText(model),
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
  envDefaultModel,
  changed,
  envUpdated = false,
}) {
  const lines = [];
  lines.push(changed ? "Model selection updated." : "Model selection status.");
  lines.push(`runtime: ${runtime}`);
  lines.push(`workspace: ${workspaceRoot}`);
  lines.push(`session_model: ${sessionModel || "(default)"}`);
  lines.push(`effective_model: ${sessionModel || envDefaultModel || "(runtime default)"}`);
  if (envDefaultModel) {
    lines.push(`env_default: ${envDefaultModel}`);
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
