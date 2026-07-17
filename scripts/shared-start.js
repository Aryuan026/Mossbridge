const { spawn } = require("child_process");
const {
  rootDir,
  listenUrl,
  appServerRecoveryRequestFile,
  bridgePidFile,
  writePidFile,
  removePidFileIfMatches,
  ensureSharedAppServer,
  readSharedAppServerRecoveryRequest,
  clearSharedAppServerRecoveryRequest,
  recycleSharedAppServer,
  ensureBridgeNotRunning,
} = require("./shared-common");

async function main() {
  const runtime = process.env.MOSSBRIDGE_RUNTIME || "codex";
  const supervise = process.env.MOSSBRIDGE_SHARED_SUPERVISE !== "0";
  let shuttingDown = false;
  let recoveryInProgress = false;
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
    console.log(`shared mossbridge already running pid=${existingBridgePid}`);
    return;
  }

  const childEnv = { ...process.env };
  const isCodex = runtime === "codex";
  if (isCodex) {
    childEnv.MOSSBRIDGE_CODEX_ENDPOINT = listenUrl;
    childEnv.MOSSBRIDGE_SHARED_RECOVERY_REQUEST_FILE = appServerRecoveryRequestFile;
  }

  let child = null;

  const startChild = () => {
    const startedChild = spawn(process.execPath, ["./bin/mossbridge.js", "start"], {
      cwd: rootDir,
      env: childEnv,
      stdio: "inherit",
    });
    child = startedChild;
    writePidFile(bridgePidFile, startedChild.pid);

    startedChild.on("exit", (code, signal) => {
      removePidFileIfMatches(bridgePidFile, startedChild.pid);
      if (child === startedChild) {
        child = null;
      }
      if (recoveryInProgress) {
        return;
      }
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
        `shared mossbridge exited code=${code ?? "unknown"}; restarting in ${Math.round(delayMs / 1000)}s`
      );
      setTimeout(startChild, delayMs);
    });
  };

  const stopBridgeForRecovery = async () => {
    const runningChild = child;
    if (!runningChild || runningChild.exitCode != null || runningChild.signalCode) {
      return;
    }
    await new Promise((resolve) => {
      let settled = false;
      let forceTimer = null;
      let doneTimer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        clearTimeout(doneTimer);
        resolve();
      };
      runningChild.once("exit", finish);
      runningChild.kill("SIGTERM");
      forceTimer = setTimeout(() => {
        if (runningChild.exitCode == null && !runningChild.signalCode) {
          runningChild.kill("SIGKILL");
        }
      }, 8_000);
      doneTimer = setTimeout(finish, 10_000);
    });
    if (runningChild.exitCode == null && !runningChild.signalCode) {
      throw new Error("Bridge child did not stop before shared app-server recovery");
    }
  };

  const recoverSharedAppServer = async () => {
    if (shuttingDown || recoveryInProgress) {
      return;
    }
    const request = readSharedAppServerRecoveryRequest();
    if (!request) {
      return;
    }
    recoveryInProgress = true;
    console.warn(
      `shared app-server recovery starting reason=${request.reason} action_replay_allowed=false`
    );
    try {
      await stopBridgeForRecovery();
      const recovered = await recycleSharedAppServer();
      clearSharedAppServerRecoveryRequest();
      restartCount = 0;
      console.log(`shared app-server recovery complete status=${recovered.status} pid=${recovered.pid || 0}`);
      if (!shuttingDown) {
        recoveryInProgress = false;
        startChild();
      }
    } catch (error) {
      console.error(`shared app-server recovery failed: ${error.message || String(error)}`);
      if (!shuttingDown && !child) {
        recoveryInProgress = false;
        startChild();
      }
    } finally {
      recoveryInProgress = false;
    }
  };

  const recoveryTimer = isCodex
    ? setInterval(() => {
        void recoverSharedAppServer();
      }, 1_000)
    : null;

  const stop = (signal) => {
    shuttingDown = true;
    if (recoveryTimer) {
      clearInterval(recoveryTimer);
    }
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
