#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

try {
  require("dotenv").config({ path: path.join(process.cwd(), ".env") });
} catch {
  // Optional dependency during diagnostics; ignore when unavailable.
}

try {
  require("dotenv").config({ path: path.join(os.homedir(), ".asheriebridge", ".env") });
} catch {
  // Optional user-level bridge env.
}

const args = process.argv.slice(2);
const includePreviews = hasFlag("--include-previews");
const writeOutput = hasFlag("--write");
const stateDir = readValueFlag("--state-dir")
  || process.env.ASHERIEBRIDGE_STATE_DIR
  || path.join(os.homedir(), ".asheriebridge");
const dataRoot = readValueFlag("--data-root")
  || process.env.ASHERIEBRIDGE_DATA_ROOT
  || path.join(stateDir, "asherie_gateway");
const homeHealthUrl = readValueFlag("--home-health-url") || "http://127.0.0.1:8089/health";

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});

async function main() {
  const report = {
    generated_at: new Date().toISOString(),
    cwd: process.cwd(),
    git: readGitMeta(),
    options: {
      include_previews: includePreviews,
      state_dir: stateDir,
      data_root: dataRoot,
      home_health_url: homeHealthUrl,
    },
    process: buildProcessSection(),
    bridge_state: buildBridgeStateSection(),
    memory_storage: buildMemoryStorageSection(),
    home_health: await fetchJsonWithTimeout(homeHealthUrl, 900),
    notes: [
      "This report is local diagnostics only. It avoids raw conversation previews unless --include-previews is passed.",
      "Use it after the travel pressure test to correlate silence, queue buildup, wakeups, memory sediment, and context pressure.",
    ],
  };

  if (writeOutput) {
    const outputDir = path.join(stateDir, "diagnostics");
    fs.mkdirSync(outputDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outputPath = path.join(outputDir, `travel-diagnostics-${stamp}.json`);
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(outputPath);
    return;
  }

  console.log(JSON.stringify(report, null, 2));
}

function buildProcessSection() {
  const logDir = path.join(stateDir, "logs");
  const bridgePid = readPid(path.join(logDir, "shared-wechat.pid"));
  const appServerPid = readPid(path.join(logDir, "shared-app-server.pid"));
  return {
    shared_wechat: {
      pid: bridgePid || null,
      alive: bridgePid ? isPidAlive(bridgePid) : false,
      command: bridgePid ? readProcessCommand(bridgePid) : "",
    },
    shared_app_server: {
      pid: appServerPid || null,
      alive: appServerPid ? isPidAlive(appServerPid) : false,
      command: appServerPid ? readProcessCommand(appServerPid) : "",
    },
  };
}

function buildBridgeStateSection() {
  const audit = readJson(path.join(stateDir, "weixin-ingress-audit.json"));
  const runtimeUsage = readJson(path.join(stateDir, "runtime-context-usage.json"));
  const sessions = readJson(path.join(stateDir, "sessions.json"));
  const contextTokens = readContextTokenSummary();
  const stickerIndex = readJson(path.join(stateDir, "stickers", "index.json"));
  return {
    queues: {
      system_messages: readArrayLength(path.join(stateDir, "system-message-queue.json"), "messages"),
      deferred_system_replies: readArrayLength(path.join(stateDir, "deferred-system-replies.json"), "replies"),
      reminders: readArrayLength(path.join(stateDir, "reminder-queue.json"), "reminders"),
      timeline_screenshots: readArrayLength(path.join(stateDir, "timeline-screenshot-queue.json"), "jobs"),
    },
    weixin_ingress: summarizeAudit(audit),
    runtime_context: summarizeRuntimeUsage(runtimeUsage),
    sessions: summarizeSessions(sessions),
    context_tokens: contextTokens,
    stickers: {
      exists: Boolean(stickerIndex),
      count: Array.isArray(stickerIndex)
        ? stickerIndex.length
        : Object.keys(stickerIndex || {}).length,
      updated_at: readMtime(path.join(stateDir, "stickers", "index.json")),
    },
  };
}

function buildMemoryStorageSection() {
  const storageRoot = path.join(dataRoot, "storage");
  const cacheRoot = path.join(dataRoot, "cache");
  return {
    data_root: summarizeDir(dataRoot, 1),
    storage_root: summarizeDir(storageRoot, 1),
    cache_root: summarizeDir(cacheRoot, 1),
    warm_memory: summarizeDir(path.join(storageRoot, "warm_memory"), 3),
    observation_journal: summarizeJsonlDir(path.join(storageRoot, "observation_journal")),
    ongoing_tracks: summarizeJsonFile(path.join(storageRoot, "ongoing_tracks.json")),
    conversation_cache: summarizeJsonlDir(path.join(cacheRoot, "conversation_cache")),
    wakeup_journal: summarizeJsonFile(path.join(cacheRoot, "wakeup_journal.json")),
    calendar_items: summarizeJsonFile(path.join(storageRoot, "calendar_items.json")),
    memory_tree: summarizeDir(path.join(storageRoot, "memory_tree"), 3),
    case_index: summarizeDir(path.join(storageRoot, "case_index"), 3),
    dreaming_mutation_log: summarizeDir(path.join(storageRoot, "dreaming_mutation_log"), 3),
    app_daily_captures: summarizeDir(path.join(cacheRoot, "app_daily_captures"), 3),
  };
}

function summarizeAudit(audit) {
  if (!audit || typeof audit !== "object") {
    return { exists: false };
  }
  const events = Array.isArray(audit.recentEvents) ? audit.recentEvents : [];
  const errorEvents = events.filter((event) => event?.error || event?.errcode || event?.ret);
  const inbound = events.filter((event) => event?.kind === "inbound");
  return {
    exists: true,
    last_poll: sanitizeEvent(audit.lastPoll),
    last_inbound: sanitizeEvent(audit.lastInbound),
    recent_event_count: events.length,
    recent_inbound_count: inbound.length,
    recent_error_count: errorEvents.length,
    recent_errors: errorEvents.slice(-8).map(sanitizeEvent),
    latest_events: events.slice(-8).map(sanitizeEvent),
    updated_at: readMtime(path.join(stateDir, "weixin-ingress-audit.json")),
  };
}

function summarizeRuntimeUsage(runtimeUsage) {
  if (!runtimeUsage || typeof runtimeUsage !== "object") {
    return { exists: false };
  }
  const latestByRuntime = runtimeUsage.latestContextByRuntimeId || {};
  const claudecode = latestByRuntime.claudecode || {};
  const currentTokens = Number(claudecode.currentTokens) || 0;
  const thresholdTokens = Number(claudecode.compactThresholdTokens) || 0;
  const contextWindow = Number(claudecode.contextWindow) || 0;
  return {
    exists: true,
    claudecode: {
      thread_id: claudecode.threadId || "",
      workspace_root: claudecode.workspaceRoot || "",
      current_tokens: currentTokens,
      context_window: contextWindow,
      compact_threshold_tokens: thresholdTokens,
      compact_threshold_percent: Number(claudecode.compactThresholdPercent) || 0,
      over_threshold: Boolean(thresholdTokens && currentTokens >= thresholdTokens),
      near_threshold: Boolean(thresholdTokens && currentTokens >= thresholdTokens * 0.95),
      context_window_usage_ratio: contextWindow ? round(currentTokens / contextWindow, 4) : 0,
      threshold_usage_ratio: thresholdTokens ? round(currentTokens / thresholdTokens, 4) : 0,
      updated_at: claudecode.updatedAt || "",
    },
    auto_compact_events: Array.isArray(runtimeUsage.autoCompactEvents)
      ? runtimeUsage.autoCompactEvents.slice(-8)
      : [],
  };
}

function summarizeSessions(sessions) {
  if (!sessions || typeof sessions !== "object") {
    return { exists: false };
  }
  return {
    exists: true,
    binding_count: Object.keys(sessions.bindings || {}).length,
    approval_workspace_count: Object.keys(sessions.approvalCommandAllowlistByWorkspaceRoot || {}).length,
    prompt_thread_count: Object.keys(sessions.approvalPromptStateByThreadId || {}).length,
    model_catalog_keys: Object.keys(sessions.availableModelCatalog || {}),
    updated_at: readMtime(path.join(stateDir, "sessions.json")),
  };
}

function readContextTokenSummary() {
  const accountsDir = path.join(stateDir, "accounts");
  if (!fs.existsSync(accountsDir)) {
    return { exists: false, file_count: 0, token_key_count: 0 };
  }
  const files = fs.readdirSync(accountsDir).filter((name) => name.endsWith(".context-tokens.json"));
  let tokenKeyCount = 0;
  for (const file of files) {
    const payload = readJson(path.join(accountsDir, file));
    tokenKeyCount += Object.keys(payload || {}).filter((key) => Boolean(payload[key])).length;
  }
  return {
    exists: true,
    file_count: files.length,
    token_key_count: tokenKeyCount,
    updated_at: files.map((file) => readMtime(path.join(accountsDir, file))).filter(Boolean).sort().at(-1) || "",
  };
}

function summarizeJsonFile(filePath) {
  const payload = readJson(filePath);
  if (!payload) {
    return { exists: false, path: filePath };
  }
  return {
    exists: true,
    path: filePath,
    bytes: readFileSize(filePath),
    updated_at: readMtime(filePath),
    type: Array.isArray(payload) ? "array" : typeof payload,
    count: Array.isArray(payload) ? payload.length : Object.keys(payload || {}).length,
    latest_items: Array.isArray(payload) ? payload.slice(-5).map(sanitizeMemoryLikeRow) : [],
  };
}

function summarizeJsonlDir(dirPath) {
  const dir = summarizeDir(dirPath, 3);
  if (!dir.exists) {
    return dir;
  }
  const files = listFiles(dirPath, 4).filter((item) => item.path.endsWith(".jsonl"));
  let lineCount = 0;
  for (const item of files) {
    lineCount += countLines(item.path);
  }
  return {
    ...dir,
    jsonl_file_count: files.length,
    jsonl_line_count: lineCount,
    latest_files: files.sort((left, right) => right.mtime.localeCompare(left.mtime)).slice(0, 8),
  };
}

function summarizeDir(dirPath, maxDepth = 2) {
  if (!fs.existsSync(dirPath)) {
    return { exists: false, path: dirPath };
  }
  const files = listFiles(dirPath, maxDepth);
  return {
    exists: true,
    path: dirPath,
    file_count: files.length,
    latest_files: files.sort((left, right) => right.mtime.localeCompare(left.mtime)).slice(0, 8),
  };
}

function listFiles(root, maxDepth = 2) {
  const output = [];
  const baseDepth = root.split(path.sep).length;
  walk(root);
  return output;

  function walk(current) {
    let entries = [];
    try {
      entries = fs.readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const filePath = path.join(current, entry);
      let stats = null;
      try {
        stats = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        const depth = filePath.split(path.sep).length - baseDepth;
        if (depth < maxDepth) {
          walk(filePath);
        }
        continue;
      }
      output.push({
        path: filePath,
        bytes: stats.size,
        mtime: stats.mtime.toISOString(),
      });
    }
  }
}

function sanitizeEvent(event) {
  if (!event || typeof event !== "object") {
    return null;
  }
  const result = {};
  for (const key of [
    "kind",
    "stage",
    "messageId",
    "messageType",
    "contextTokenPresent",
    "ret",
    "errcode",
    "error",
    "messageCount",
    "syncBufferChanged",
    "ts",
  ]) {
    if (key in event) {
      result[key] = event[key];
    }
  }
  if (includePreviews && event.textPreview) {
    result.textPreview = String(event.textPreview).slice(0, 240);
  }
  return result;
}

function sanitizeMemoryLikeRow(row) {
  if (!row || typeof row !== "object") {
    return null;
  }
  return {
    record_id: row.record_id || row.id || "",
    event_type: row.event_type || "",
    decision: row.decision || "",
    status: row.status || "",
    delivery: row.delivery || "",
    source_client: row.source_client || row.sourceClient || "",
    ts_utc: row.ts_utc || row.created_at || row.createdAt || "",
    updated_at: row.updated_at || row.updatedAt || row.updated_at_utc || "",
  };
}

function fetchJsonWithTimeout(url, timeoutMs) {
  return new Promise((resolve) => {
    const client = String(url).startsWith("https:") ? https : http;
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        let json = null;
        try {
          json = body ? JSON.parse(body) : null;
        } catch {
          json = null;
        }
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status_code: res.statusCode,
          body: json,
        });
      });
    });
    req.on("error", (error) => resolve({ ok: false, error: error.message || String(error) }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
  });
}

function readGitMeta() {
  return {
    branch: runGit(["branch", "--show-current"]),
    commit: runGit(["rev-parse", "--short", "HEAD"]),
    status_short: runGit(["status", "--short"]),
  };
}

function runGit(args) {
  try {
    return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function readPid(filePath) {
  const raw = readText(filePath);
  const pid = Number.parseInt(raw, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readProcessCommand(pid) {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function readArrayLength(filePath, key) {
  const payload = readJson(filePath);
  if (!payload) {
    return { exists: false, count: 0, updated_at: "" };
  }
  const list = Array.isArray(payload) ? payload : payload[key];
  return {
    exists: true,
    count: Array.isArray(list) ? list.length : 0,
    updated_at: readMtime(filePath),
  };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function countLines(filePath) {
  const text = readText(filePath);
  return text ? text.split(/\r?\n/).filter(Boolean).length : 0;
}

function readMtime(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return "";
  }
}

function readFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function hasFlag(flag) {
  return args.includes(flag);
}

function readValueFlag(flag) {
  const index = args.indexOf(flag);
  if (index < 0) {
    return "";
  }
  return args[index + 1] || "";
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}
