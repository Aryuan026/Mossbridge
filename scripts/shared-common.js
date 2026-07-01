const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const dotenv = require("dotenv");

loadEnv();

const rootDir = path.resolve(__dirname, "..");
const port = resolveSharedPort(process.env.MOSSBRIDGE_SHARED_PORT);
const listenUrl = `ws://127.0.0.1:${port}`;
const stateDir = process.env.MOSSBRIDGE_STATE_DIR || path.join(os.homedir(), ".mossbridge");
const logDir = path.join(stateDir, "logs");
const appServerPidFile = path.join(logDir, "shared-app-server.pid");
const bridgePidFile = path.join(logDir, "shared-wechat.pid");
const appServerLogFile = path.join(logDir, "shared-app-server.log");
const accountsDir = path.join(stateDir, "accounts");
const sessionFile = process.env.MOSSBRIDGE_SESSIONS_FILE || path.join(stateDir, "sessions.json");

function resolvePreferredStateDirectory() {
  return process.env.MOSSBRIDGE_STATE_DIR || path.join(os.homedir(), ".mossbridge");
}

function loadEnv() {
  const stateDirCandidate = resolvePreferredStateDirectory();
  const candidates = [
    process.env.MOSSBRIDGE_ENV_FILE,
    path.join(process.cwd(), ".env"),
    path.join(stateDirCandidate, ".env"),
    path.join(os.homedir(), ".mossbridge", ".env"),
  ];
  for (const envPath of candidates.map(normalizePathCandidate).filter(Boolean)) {
    if (!fs.existsSync(envPath)) {
      continue;
    }
    dotenv.config({ path: envPath });
    return envPath;
  }
  dotenv.config();
  return "";
}

function normalizePathCandidate(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? path.resolve(normalized) : "";
}

function ensureLogDir() {
  fs.mkdirSync(logDir, { recursive: true });
}

function isPidAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return false;
  }
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    if (error && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function readPidFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    return raw ? Number.parseInt(raw, 10) : 0;
  } catch {
    return 0;
  }
}

function writePidFile(filePath, pid) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${pid}\n`, "utf8");
}

function removePidFileIfMatches(filePath, pid) {
  const current = readPidFile(filePath);
  if (current && current === pid) {
    fs.rmSync(filePath, { force: true });
  }
}

function resolveSharedPort(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "8765";
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("MOSSBRIDGE_SHARED_PORT must be an integer from 1 to 65535");
  }
  return String(parsed);
}

function checkReadyz() {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port: Number(port),
        path: "/readyz",
        timeout: 500,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 300);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForReadyz({ attempts = 10, delayMs = 300 } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    if (await checkReadyz()) {
      return true;
    }
    await sleep(delayMs);
  }
  return false;
}

function openLogFile(filePath) {
  return fs.openSync(filePath, "a");
}

function spawnDetachedCommand(command, args, { logFile, cwd = rootDir, env = {} } = {}) {
  const stdoutFd = openLogFile(logFile);
  const stderrFd = openLogFile(logFile);
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", stdoutFd, stderrFd],
    shell: process.platform === "win32",
  });
  child.unref();
  return child.pid;
}

async function ensureSharedAppServer() {
  if (process.env.MOSSBRIDGE_RUNTIME && process.env.MOSSBRIDGE_RUNTIME !== "codex") {
    return { pid: 0, status: "skipped" };
  }

  ensureLogDir();
  const pidFromFile = readPidFile(appServerPidFile);
  if (pidFromFile && isPidAlive(pidFromFile) && (await checkReadyz())) {
    return { pid: pidFromFile, status: "already_running" };
  }

  if (await checkReadyz()) {
    return { pid: pidFromFile || 0, status: "already_running_unknown_pid" };
  }

  const env = {
    MOSSBRIDGE_STATE_DIR: stateDir,
    TIMELINE_FOR_AGENT_STATE_DIR: stateDir,
  };
  if (!process.env.TIMELINE_FOR_AGENT_CHROME_PATH) {
    env.TIMELINE_FOR_AGENT_CHROME_PATH =
      process.env.MOSSBRIDGE_SCREENSHOT_CHROME_PATH
      || (process.platform === "darwin"
        ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        : "");
  }

  const command = process.env.MOSSBRIDGE_CODEX_COMMAND || "codex";
  const {
    buildCodexMcpConfigArgs,
    resolveCodexProjectToolMcpServerConfig,
  } = require("../src/adapters/runtime/codex/mcp-config");
  const mcpConfigArgs = buildCodexMcpConfigArgs(resolveCodexProjectToolMcpServerConfig({
    mossbridgeHome: process.env.MOSSBRIDGE_HOME || rootDir,
  }));
  const pid = spawnDetachedCommand(command, [...mcpConfigArgs, "app-server", "--listen", listenUrl], {
    logFile: appServerLogFile,
    env,
  });
  writePidFile(appServerPidFile, pid);

  const ready = await waitForReadyz();
  if (!ready) {
    throw new Error(`failed to start shared app-server; check ${appServerLogFile}`);
  }

  writePidFile(appServerPidFile, pid);
  return { pid, status: "started" };
}

function ensureBridgeNotRunning() {
  const pidFromFile = readPidFile(bridgePidFile);
  if (pidFromFile && isPidAlive(pidFromFile)) {
    return pidFromFile;
  }
  if (pidFromFile) {
    fs.rmSync(bridgePidFile, { force: true });
  }
  return 0;
}

function resolveCurrentAccountId() {
  if (!fs.existsSync(accountsDir)) {
    return "";
  }
  const entries = fs.readdirSync(accountsDir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".context-tokens.json"))
    .map((name) => {
      const fullPath = path.join(accountsDir, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        return {
          accountId: normalizeText(parsed?.accountId),
          savedAt: parseTimestamp(parsed?.savedAt),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((entry) => entry.accountId);
  entries.sort((left, right) => right.savedAt - left.savedAt);
  return entries[0]?.accountId || "";
}

function resolveBoundThread(workspaceRoot) {
  if (!fs.existsSync(sessionFile)) {
    throw new Error(`session file not found: ${sessionFile}`);
  }
  const runtimeId = normalizeText(process.env.MOSSBRIDGE_RUNTIME || "codex");
  const data = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  const currentAccountId = resolveCurrentAccountId();
  const bindings = Object.entries(data.bindings || {})
    .map(([bindingKey, binding]) => ({
      ...(binding || {}),
      bindingKey: normalizeText(binding?.bindingKey) || normalizeText(bindingKey),
    }))
    .filter((binding) => !currentAccountId || normalizeText(binding?.accountId) === currentAccountId)
    .sort((left, right) => parseTimestamp(right?.updatedAt) - parseTimestamp(left?.updatedAt));

  const normalizedWorkspaceRoot = normalizeText(workspaceRoot);
  const exact = bindings.find((binding) => getThreadId(binding, normalizedWorkspaceRoot, runtimeId));
  if (exact) {
    return {
      bindingKey: normalizeText(exact.bindingKey),
      accountId: normalizeText(exact.accountId),
      senderId: normalizeText(exact.senderId),
      threadId: getThreadId(exact, normalizedWorkspaceRoot, runtimeId),
      workspaceRoot: normalizedWorkspaceRoot,
    };
  }

  const active = bindings.find((binding) => {
    const activeWorkspaceRoot = normalizeText(binding?.activeWorkspaceRoot);
    return activeWorkspaceRoot && getThreadId(binding, activeWorkspaceRoot, runtimeId);
  });
  if (active) {
    const activeWorkspaceRoot = normalizeText(active.activeWorkspaceRoot);
    return {
      bindingKey: normalizeText(active.bindingKey),
      accountId: normalizeText(active.accountId),
      senderId: normalizeText(active.senderId),
      threadId: getThreadId(active, activeWorkspaceRoot, runtimeId),
      workspaceRoot: activeWorkspaceRoot,
    };
  }

  throw new Error(`no bound WeChat thread found for workspace: ${workspaceRoot}`);
}

function getThreadId(binding, workspaceRoot, runtimeId = "") {
  if (!workspaceRoot) {
    return "";
  }
  const map = getThreadMapForRuntime(binding, runtimeId);
  return normalizeText(map[workspaceRoot]);
}

function getThreadMapForRuntime(binding, runtimeId) {
  const normalizedRuntimeId = normalizeText(runtimeId);
  const runtimeMap = binding && typeof binding.threadIdByWorkspaceRootByRuntime === "object"
    ? binding.threadIdByWorkspaceRootByRuntime
    : {};
  const scoped = runtimeMap[normalizedRuntimeId];
  return scoped && typeof scoped === "object" ? scoped : {};
}

function parseTimestamp(value) {
  const parsed = Date.parse(normalizeText(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  rootDir,
  port,
  listenUrl,
  resolveSharedPort,
  loadEnv,
  stateDir,
  logDir,
  appServerPidFile,
  bridgePidFile,
  appServerLogFile,
  accountsDir,
  sessionFile,
  ensureLogDir,
  isPidAlive,
  readPidFile,
  writePidFile,
  removePidFileIfMatches,
  ensureSharedAppServer,
  ensureBridgeNotRunning,
  resolveBoundThread,
};
