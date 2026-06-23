const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  rootDir,
  stateDir,
  logDir,
  bridgePidFile,
  ensureLogDir,
  isPidAlive,
  readPidFile,
  removePidFileIfMatches,
} = require("./shared-common");

const DEFAULT_LABEL = "com.mossbridge.bridge";

async function main() {
  const command = normalizeText(process.argv[2] || "status");
  const options = parseOptions(process.argv.slice(3));
  const config = buildLaunchdConfig(options);

  switch (command) {
    case "install":
      installService(config, { takeover: options.takeover });
      break;
    case "uninstall":
      uninstallService(config);
      break;
    case "start":
      startService(config, { takeover: options.takeover });
      break;
    case "stop":
      stopService(config);
      break;
    case "restart":
      restartService(config, { takeover: options.takeover });
      break;
    case "status":
      printStatus(config);
      break;
    case "print-plist":
      process.stdout.write(buildPlist(config));
      break;
    default:
      printUsage();
      process.exitCode = 1;
  }
}

function buildLaunchdConfig(options = {}) {
  const runtime = normalizeText(options.runtime || process.env.MOSSBRIDGE_RUNTIME) || "codex";
  const label = normalizeText(options.label || process.env.MOSSBRIDGE_LAUNCHD_LABEL) || DEFAULT_LABEL;
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  const dataRoot = normalizeText(options.dataRoot || process.env.MOSSBRIDGE_DATA_ROOT)
    || path.join(stateDir, "mossbridge_data");
  const workspaceRoot = normalizeText(options.workspaceRoot || process.env.MOSSBRIDGE_WORKSPACE_ROOT)
    || rootDir;
  return {
    label,
    runtime,
    rootDir,
    stateDir,
    dataRoot,
    workspaceRoot,
    allowEphemeral: Boolean(options.allowEphemeral),
    logDir,
    plistPath: path.join(launchAgentsDir, `${label}.plist`),
    nodePath: normalizeText(options.node || process.env.MOSSBRIDGE_NODE_PATH) || process.execPath,
    scriptPath: path.join(rootDir, "scripts", "shared-start.js"),
    stdoutPath: path.join(logDir, "launchd.out.log"),
    stderrPath: path.join(logDir, "launchd.err.log"),
    pathEnv: normalizeText(process.env.PATH) || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    home: os.homedir(),
  };
}

function installService(config, { takeover = false } = {}) {
  assertPersistentServicePaths(config);
  ensureLogDir();
  fs.mkdirSync(path.dirname(config.plistPath), { recursive: true });
  fs.writeFileSync(config.plistPath, buildPlist(config), "utf8");
  if (takeover) {
    stopExistingManualBridge();
  }
  bootout(config, { allowFailure: true });
  bootstrap(config);
  enable(config, { allowFailure: true });
  kickstart(config, { allowFailure: true });
  console.log(`installed ${config.label}`);
  console.log(`plist=${config.plistPath}`);
  console.log(`logs=${config.stdoutPath}`);
}

function uninstallService(config) {
  bootout(config, { allowFailure: true });
  fs.rmSync(config.plistPath, { force: true });
  console.log(`uninstalled ${config.label}`);
}

function startService(config, { takeover = false } = {}) {
  assertPersistentServicePaths(config);
  if (takeover) {
    stopExistingManualBridge();
  }
  if (!fs.existsSync(config.plistPath)) {
    fs.writeFileSync(config.plistPath, buildPlist(config), "utf8");
  }
  bootstrap(config);
  kickstart(config, { allowFailure: true });
  console.log(`started ${config.label}`);
}

function stopService(config) {
  bootout(config, { allowFailure: true });
  console.log(`stopped ${config.label}`);
}

function restartService(config, { takeover = false } = {}) {
  assertPersistentServicePaths(config);
  bootout(config, { allowFailure: true });
  if (takeover) {
    stopExistingManualBridge();
  }
  if (!fs.existsSync(config.plistPath)) {
    fs.writeFileSync(config.plistPath, buildPlist(config), "utf8");
  }
  bootstrap(config);
  kickstart(config, { allowFailure: true });
  console.log(`restarted ${config.label}`);
}

function printStatus(config) {
  const loaded = runLaunchctl(["print", serviceTarget(config)], { allowFailure: true });
  console.log(`label=${config.label}`);
  console.log(`requested_runtime=${config.runtime}`);
  printEphemeralStatus(config);
  console.log(`plist=${fs.existsSync(config.plistPath) ? config.plistPath : "missing"}`);
  if (fs.existsSync(config.plistPath)) {
    const installedRuntime = readInstalledRuntime(config.plistPath);
    console.log(`installed_runtime=${installedRuntime || "unknown"}`);
    if (installedRuntime && installedRuntime !== config.runtime) {
      console.log(`runtime_warning=plist is installed for ${installedRuntime}; run takeover/restart with ${config.runtime} to switch`);
    }
  }
  console.log(`launchd=${loaded.status === 0 ? "loaded" : "not_loaded"}`);
  const bridgePid = readPidFile(bridgePidFile);
  console.log(`bridge_pid=${bridgePid || "missing"}`);
  console.log(`bridge_alive=${bridgePid && isPidAlive(bridgePid) ? "yes" : "no"}`);
  if (loaded.status !== 0 && normalizeText(loaded.stderr)) {
    console.log(`launchd_detail=${normalizeText(loaded.stderr).split("\n")[0]}`);
  }
}

function readInstalledRuntime(plistPath) {
  try {
    const text = fs.readFileSync(plistPath, "utf8");
    const match = text.match(/<key>MOSSBRIDGE_RUNTIME<\/key>\s*<string>([^<]*)<\/string>/u);
    return normalizeText(match?.[1]);
  } catch {
    return "";
  }
}

function buildPlist(config) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    plistKeyValue("Label", config.label),
    "  <key>ProgramArguments</key>",
    "  <array>",
    plistString(config.nodePath),
    plistString(config.scriptPath),
    "  </array>",
    plistKeyValue("WorkingDirectory", config.rootDir),
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    plistKeyValue("PATH", config.pathEnv, 4),
    plistKeyValue("HOME", config.home, 4),
    plistKeyValue("MOSSBRIDGE_RUNTIME", config.runtime, 4),
    plistKeyValue("MOSSBRIDGE_STATE_DIR", config.stateDir, 4),
    plistKeyValue("MOSSBRIDGE_DATA_ROOT", config.dataRoot, 4),
    plistKeyValue("MOSSBRIDGE_WORKSPACE_ROOT", config.workspaceRoot, 4),
    plistKeyValue("MOSSBRIDGE_SHARED_SUPERVISE", "1", 4),
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    plistKeyValue("StandardOutPath", config.stdoutPath),
    plistKeyValue("StandardErrorPath", config.stderrPath),
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function bootstrap(config) {
  runLaunchctl(["bootstrap", guiTarget(), config.plistPath]);
}

function bootout(config, { allowFailure = false } = {}) {
  return runLaunchctl(["bootout", guiTarget(), config.plistPath], { allowFailure });
}

function enable(config, { allowFailure = false } = {}) {
  return runLaunchctl(["enable", serviceTarget(config)], { allowFailure });
}

function kickstart(config, { allowFailure = false } = {}) {
  return runLaunchctl(["kickstart", "-k", serviceTarget(config)], { allowFailure });
}

function runLaunchctl(args, { allowFailure = false } = {}) {
  const result = spawnSync("launchctl", args, { encoding: "utf8" });
  if (!allowFailure && result.status !== 0) {
    const detail = normalizeText(result.stderr) || normalizeText(result.stdout) || `launchctl ${args.join(" ")} failed`;
    throw new Error(detail);
  }
  return result;
}

function stopExistingManualBridge() {
  const bridgePid = readPidFile(bridgePidFile);
  if (!bridgePid || !isPidAlive(bridgePid)) {
    if (bridgePid) {
      removePidFileIfMatches(bridgePidFile, bridgePid);
    }
    return;
  }
  const parentPid = readParentPid(bridgePid);
  if (parentPid && parentLooksLikeSharedStart(parentPid)) {
    safeKill(parentPid, "SIGTERM");
  }
  safeKill(bridgePid, "SIGTERM");
  waitForPidExit(bridgePid, 3000);
  if (isPidAlive(bridgePid)) {
    safeKill(bridgePid, "SIGKILL");
  }
  removePidFileIfMatches(bridgePidFile, bridgePid);
}

function readParentPid(pid) {
  const result = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
  return Number.parseInt(String(result.stdout || "").trim(), 10) || 0;
}

function parentLooksLikeSharedStart(pid) {
  const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  const command = normalizeText(result.stdout);
  return /shared-start\.js|npm run shared:start|mossbridge\.js start/u.test(command);
}

function safeKill(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch {
    // ignore already-dead processes
  }
}

function waitForPidExit(pid, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(pid)) {
      return true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return !isPidAlive(pid);
}

function assertPersistentServicePaths(config) {
  if (config?.allowEphemeral) {
    return;
  }
  const ephemeral = collectEphemeralServicePaths(config);
  if (!ephemeral.length) {
    return;
  }
  const details = ephemeral.map((item) => `${item.name}=${item.path}`).join(", ");
  throw new Error([
    `Refusing to install/start launchd service with ephemeral path(s): ${details}.`,
    "Use persistent MOSSBRIDGE_STATE_DIR, MOSSBRIDGE_DATA_ROOT, and MOSSBRIDGE_WORKSPACE_ROOT before QR/service use.",
    "For disposable service smoke only, rerun with --allow-ephemeral.",
  ].join(" "));
}

function printEphemeralStatus(config) {
  const ephemeral = collectEphemeralServicePaths(config);
  if (!ephemeral.length) {
    console.log("ephemeral_paths=none");
    return;
  }
  console.log(`ephemeral_paths=${ephemeral.map((item) => `${item.name}:${item.path}`).join(",")}`);
  console.log("ephemeral_warning=service install/start/restart will refuse these paths unless --allow-ephemeral is passed");
}

function collectEphemeralServicePaths(config) {
  return [
    { name: "state", path: config?.stateDir },
    { name: "data", path: config?.dataRoot },
    { name: "workspace", path: config?.workspaceRoot },
  ].filter((item) => isEphemeralPath(item.path));
}

function isEphemeralPath(value) {
  const normalized = normalizePathForCompare(value);
  if (!normalized) {
    return false;
  }
  const roots = [
    "/tmp",
    "/private/tmp",
    os.tmpdir(),
  ].map(normalizePathForCompare).filter(Boolean);
  return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function normalizePathForCompare(value) {
  const raw = normalizeText(value);
  if (!raw) {
    return "";
  }
  return path.resolve(raw).replace(/\\/g, "/").replace(/\/+$/u, "");
}

function parseOptions(argv) {
  const out = { takeover: false, allowEphemeral: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--takeover") {
      out.takeover = true;
      continue;
    }
    if (arg === "--allow-ephemeral") {
      out.allowEphemeral = true;
      continue;
    }
    if (arg === "--runtime") {
      out.runtime = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--label") {
      out.label = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--node") {
      out.node = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--data-root") {
      out.dataRoot = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--workspace-root") {
      out.workspaceRoot = argv[index + 1] || "";
      index += 1;
    }
  }
  return out;
}

function printUsage() {
  console.log([
    "Usage: node scripts/launchd-service.js <install|uninstall|start|stop|restart|status|print-plist> [--takeover] [--allow-ephemeral]",
    "Options:",
    "  --runtime <id>   Runtime to start, default codex",
    "  --label <label>  launchd label, default com.mossbridge.bridge",
    "  --node <path>    Node.js executable path, default current process.execPath",
    "  --data-root <path>  Data root for the LaunchAgent environment",
    "  --workspace-root <path>  Workspace root for the LaunchAgent environment",
    "  --allow-ephemeral  Permit service install/start/restart with /tmp state/data/workspace paths",
  ].join("\n"));
}

function guiTarget() {
  return `gui/${process.getuid()}`;
}

function serviceTarget(config) {
  return `${guiTarget()}/${config.label}`;
}

function plistKeyValue(key, value, indent = 2) {
  return `${" ".repeat(indent)}<key>${escapeXml(key)}</key>\n${" ".repeat(indent)}<string>${escapeXml(value)}</string>`;
}

function plistString(value, indent = 4) {
  return `${" ".repeat(indent)}<string>${escapeXml(value)}</string>`;
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  assertPersistentServicePaths,
  buildLaunchdConfig,
  buildPlist,
  collectEphemeralServicePaths,
  escapeXml,
  isEphemeralPath,
};
