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

const DEFAULT_LABEL = "com.asherie.mossbridge";

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
  const runtime = normalizeText(options.runtime || process.env.ASHERIEBRIDGE_RUNTIME) || "claudecode";
  const label = normalizeText(options.label || process.env.ASHERIEBRIDGE_LAUNCHD_LABEL) || DEFAULT_LABEL;
  const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
  return {
    label,
    runtime,
    rootDir,
    stateDir,
    logDir,
    plistPath: path.join(launchAgentsDir, `${label}.plist`),
    nodePath: normalizeText(options.node || process.env.ASHERIEBRIDGE_NODE_PATH) || process.execPath,
    scriptPath: path.join(rootDir, "scripts", "shared-start.js"),
    stdoutPath: path.join(logDir, "launchd.out.log"),
    stderrPath: path.join(logDir, "launchd.err.log"),
    pathEnv: normalizeText(process.env.PATH) || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    home: os.homedir(),
  };
}

function installService(config, { takeover = false } = {}) {
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
  console.log(`plist=${fs.existsSync(config.plistPath) ? config.plistPath : "missing"}`);
  console.log(`launchd=${loaded.status === 0 ? "loaded" : "not_loaded"}`);
  const bridgePid = readPidFile(bridgePidFile);
  console.log(`bridge_pid=${bridgePid || "missing"}`);
  console.log(`bridge_alive=${bridgePid && isPidAlive(bridgePid) ? "yes" : "no"}`);
  if (loaded.status !== 0 && normalizeText(loaded.stderr)) {
    console.log(`launchd_detail=${normalizeText(loaded.stderr).split("\n")[0]}`);
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
    plistKeyValue("ASHERIEBRIDGE_RUNTIME", config.runtime, 4),
    plistKeyValue("ASHERIEBRIDGE_STATE_DIR", config.stateDir, 4),
    plistKeyValue("ASHERIEBRIDGE_SHARED_SUPERVISE", "1", 4),
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
  return /shared-start\.js|npm run shared:start|asheriebridge\.js start/u.test(command);
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

function parseOptions(argv) {
  const out = { takeover: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--takeover") {
      out.takeover = true;
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
    }
  }
  return out;
}

function printUsage() {
  console.log([
    "Usage: node scripts/launchd-service.js <install|uninstall|start|stop|restart|status|print-plist> [--takeover]",
    "Options:",
    "  --runtime <id>   Runtime to start, default claudecode",
    "  --label <label>  launchd label, default com.asherie.mossbridge",
    "  --node <path>    Node.js executable path, default current process.execPath",
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
  buildLaunchdConfig,
  buildPlist,
  escapeXml,
};
