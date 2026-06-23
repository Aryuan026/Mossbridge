const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  listenUrl,
  stateDir,
  appServerPidFile,
  bridgePidFile,
  readPidFile,
  isPidAlive,
} = require("./shared-common");

const DEFAULT_LAUNCHD_LABEL = "com.mossbridge.bridge";

async function main() {
  const runtimeSelection = resolveStatusRuntime();
  const runtime = runtimeSelection.runtime;
  const isCodex = runtime === "codex";
  console.log(`runtime=${runtime}`);
  console.log(`runtime_source=${runtimeSelection.source}`);
  console.log(`listen=${listenUrl}`);
  printPidState("shared_app_server_pid", appServerPidFile);
  printPidState("shared_mossbridge_pid", bridgePidFile);
  printInboundAccessState();
  if (!isCodex) {
    console.log(`readyz=skipped`);
  } else {
    console.log(`readyz=${await checkReadyz() ? "ok" : "down"}`);
  }
  printWeixinUpstreamState();
}

function printInboundAccessState() {
  const allowed = String(process.env.MOSSBRIDGE_ALLOWED_USER_IDS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const openEnrollment = parseBool(process.env.MOSSBRIDGE_ALLOW_OPEN_INBOUND);
  const status = allowed.length
    ? "allowlist_configured"
    : (openEnrollment ? "open_enrollment" : "closed_empty_allowlist");
  console.log(`inbound_access=${status}`);
  console.log(`inbound_allowed_user_count=${allowed.length}`);
  if (!allowed.length && !openEnrollment) {
    console.log("inbound_warning=MOSSBRIDGE_ALLOWED_USER_IDS is empty and MOSSBRIDGE_ALLOW_OPEN_INBOUND is false; normal WeChat inbound is rejected.");
  } else if (!allowed.length && openEnrollment) {
    console.log("inbound_warning=temporary open enrollment is enabled; identify the sender id, then fill MOSSBRIDGE_ALLOWED_USER_IDS and disable MOSSBRIDGE_ALLOW_OPEN_INBOUND.");
  }
}

function resolveStatusRuntime() {
  const explicit = normalizeText(process.env.MOSSBRIDGE_RUNTIME);
  if (explicit) {
    return { runtime: explicit, source: "env" };
  }
  const installed = readInstalledLaunchdRuntime();
  if (installed) {
    return { runtime: installed, source: "launchd_plist" };
  }
  return { runtime: "codex", source: "default" };
}

function readInstalledLaunchdRuntime() {
  const label = normalizeText(process.env.MOSSBRIDGE_LAUNCHD_LABEL) || DEFAULT_LAUNCHD_LABEL;
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  try {
    const text = fs.readFileSync(plistPath, "utf8");
    const match = text.match(/<key>MOSSBRIDGE_RUNTIME<\/key>\s*<string>([^<]*)<\/string>/u);
    return normalizeText(match?.[1]);
  } catch {
    return "";
  }
}

function printPidState(label, filePath) {
  const pid = readPidFile(filePath);
  if (!pid) {
    console.log(`${label}=missing`);
    return;
  }
  if (!isPidAlive(pid)) {
    console.log(`${label}=stale`);
    return;
  }
  console.log(`${label}=${pid}`);
}

function printWeixinUpstreamState() {
  const auditPath = path.join(stateDir, "weixin-ingress-audit.json");
  const audit = readJson(auditPath);
  if (!audit || (!audit.lastPoll && !audit.lastPollFailure)) {
    console.log("weixin_upstream=unknown");
    console.log("weixin_last_poll=missing");
    return;
  }
  const nowMs = Date.now();
  const lastPollMs = parseTimestamp(audit.lastPoll?.ts);
  const lastFailureMs = parseTimestamp(audit.lastPollFailure?.ts);
  const lastPollAgeSeconds = lastPollMs ? Math.round((nowMs - lastPollMs) / 1000) : -1;
  const lastFailureAgeSeconds = lastFailureMs ? Math.round((nowMs - lastFailureMs) / 1000) : -1;
  const failureIsNewer = lastFailureMs && (!lastPollMs || lastFailureMs > lastPollMs);
  const pollIsFresh = lastPollMs && nowMs - lastPollMs <= 90_000;
  const upstream = failureIsNewer ? "failing" : (pollIsFresh ? "ok" : "stale");
  console.log(`weixin_upstream=${upstream}`);
  console.log(`weixin_last_poll=${audit.lastPoll?.ts || "missing"}`);
  console.log(`weixin_last_poll_age_seconds=${lastPollAgeSeconds}`);
  console.log(`weixin_last_failure=${audit.lastPollFailure?.ts || "missing"}`);
  console.log(`weixin_last_failure_age_seconds=${lastFailureAgeSeconds}`);
  console.log(`weixin_consecutive_failures=${Math.max(0, Number(audit.lastPollFailure?.consecutiveFailures) || 0)}`);
  console.log(`weixin_last_failure_error=${normalizeText(audit.lastPollFailure?.error) || "missing"}`);
  console.log(`weixin_last_failure_cause=${normalizeText(audit.lastPollFailure?.causeCode) || normalizeText(audit.lastPollFailure?.causeName) || "missing"}`);
  console.log(`weixin_last_failure_api=${normalizeText(audit.lastPollFailure?.apiLabel) || "missing"}`);
  console.log(`weixin_last_recovery=${audit.lastPollRecovery?.ts || "missing"}`);
  console.log(`weixin_last_recovery_failures=${Math.max(0, Number(audit.lastPollRecovery?.consecutiveFailures) || 0)}`);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function parseTimestamp(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseBool(value) {
  const normalized = normalizeText(value).toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function checkReadyz() {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port: new URL(listenUrl).port,
        path: "/readyz",
        timeout: 600,
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

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
