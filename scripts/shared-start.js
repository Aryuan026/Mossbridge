const { spawn } = require("child_process");
const {
  rootDir,
  listenUrl,
  bridgePidFile,
  writePidFile,
  removePidFileIfMatches,
  ensureSharedAppServer,
  ensureBridgeNotRunning,
} = require("./shared-common");

async function main() {
  const runtime = process.env.ASHERIEBRIDGE_RUNTIME || "codex";
  const supervise = process.env.ASHERIEBRIDGE_SHARED_SUPERVISE !== "0";
  let shuttingDown = false;
  let restartCount = 0;
  console.log(`starting shared bridge runtime=${runtime}`);
  if (supervise) {
    console.log("shared bridge supervisor=enabled");
  }
  const appServer = await ensureSharedAppServer();
  const appServerPidLabel = appServer.pid ? ` pid=${appServer.pid}` : "";
  if (appServer.status === "skipped") {
    console.log(`shared app-server skipped (runtime=${runtime})`);
  } else {
    console.log(`shared app-server ${appServer.status}${appServerPidLabel} listen=${listenUrl}`);
  }

  const existingBridgePid = ensureBridgeNotRunning();
  if (existingBridgePid) {
    console.log(`shared asheriebridge already running pid=${existingBridgePid}`);
    return;
  }

  const childEnv = { ...process.env };
  const isCodex = runtime === "codex";
  if (isCodex) {
    childEnv.ASHERIEBRIDGE_CODEX_ENDPOINT = listenUrl;
  }

  let child = null;

  const startChild = () => {
    child = spawn(process.execPath, ["./bin/asheriebridge.js", "start", "--checkin"], {
      cwd: rootDir,
      env: childEnv,
      stdio: "inherit",
    });
    writePidFile(bridgePidFile, child.pid);

    child.on("exit", (code, signal) => {
      removePidFileIfMatches(bridgePidFile, child.pid);
      if (shuttingDown || signal) {
        if (signal && !shuttingDown) {
          process.kill(process.pid, signal);
          return;
        }
        process.exit(code ?? 0);
        return;
      }
      if (!supervise) {
        process.exit(code ?? 0);
        return;
      }
      restartCount += 1;
      const delayMs = Math.min(30_000, 1_000 * restartCount);
      console.error(
        `shared asheriebridge exited code=${code ?? "unknown"}; restarting in ${Math.round(delayMs / 1000)}s`
      );
      setTimeout(startChild, delayMs);
    });
  };

  const stop = (signal) => {
    shuttingDown = true;
    if (child && !child.killed) {
      child.kill(signal);
    }
  };

  process.on("exit", () => {
    if (child?.pid) {
      removePidFileIfMatches(bridgePidFile, child.pid);
    }
  });
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  startChild();
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
