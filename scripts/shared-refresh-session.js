const path = require("path");
const {
  stateDir,
  resolveBoundThread,
} = require("./shared-common");
const { SessionRefreshRequestStore } = require("../src/core/session-refresh-request-store");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtimeId = normalizeText(process.env.MOSSBRIDGE_RUNTIME) || "codex";
  const workspaceHint = args.workspace || process.env.MOSSBRIDGE_WORKSPACE_ROOT || process.cwd();
  const target = resolveBoundThread(workspaceHint);
  if (!target.bindingKey) {
    throw new Error("could not resolve a bound WeChat binding for this workspace");
  }
  const store = new SessionRefreshRequestStore({
    filePath: process.env.MOSSBRIDGE_SESSION_REFRESH_REQUESTS_FILE
      || path.join(stateDir, "session-refresh-requests.json"),
  });
  const request = store.requestRefresh({
    bindingKey: target.bindingKey,
    workspaceRoot: target.workspaceRoot,
    runtimeId,
    oldThreadId: target.threadId,
    reason: args.reason || "manual_maintenance",
    requestedBy: args.requestedBy || "codex_maintenance",
  });
  console.log("session_refresh_request=queued");
  console.log(`runtime=${runtimeId}`);
  console.log(`workspace=${request.workspaceRoot}`);
  console.log(`old_thread=${request.oldThreadId || "(none)"}`);
  console.log(`request_id=${request.id}`);
  console.log("apply_on=next normal user message");
}

function parseArgs(argv = []) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workspace") {
      out.workspace = normalizeText(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--reason") {
      out.reason = normalizeText(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--requested-by") {
      out.requestedBy = normalizeText(argv[index + 1]);
      index += 1;
    }
  }
  return out;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error || "unknown error"));
  process.exit(1);
});
