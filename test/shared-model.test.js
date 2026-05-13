const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runSharedModel } = require("../scripts/shared-model");

test("shared model command updates the bound workspace model without a running bridge", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-shared-model-"));
  const stateDir = path.join(tempRoot, "state");
  const sessionFile = path.join(stateDir, "sessions.json");
  const envFile = path.join(tempRoot, ".env");
  const workspaceRoot = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(sessionFile, `${JSON.stringify({
    bindings: {
      "default:account:user": {
        workspaceId: "default",
        accountId: "account",
        senderId: "user",
        activeWorkspaceRoot: workspaceRoot,
        threadIdByWorkspaceRootByRuntime: {
          claudecode: {
            [workspaceRoot]: "thread-1",
          },
        },
        codexParamsByWorkspaceRoot: {
          [workspaceRoot]: {
            model: "opus",
          },
        },
      },
    },
    approvalCommandAllowlistByWorkspaceRoot: {},
    approvalPromptStateByThreadId: {},
    availableModelCatalog: { models: [], updatedAt: "" },
  }, null, 2)}\n`);

  const output = runSharedModel({
    argv: ["--env-file", envFile, "claude-opus-4-6"],
    env: {
      MOSSBRIDGE_RUNTIME: "claudecode",
      MOSSBRIDGE_STATE_DIR: stateDir,
      MOSSBRIDGE_SESSIONS_FILE: sessionFile,
      MOSSBRIDGE_WORKSPACE_ROOT: workspaceRoot,
    },
    cwd: tempRoot,
  });

  const updated = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  assert.equal(
    updated.bindings["default:account:user"].codexParamsByWorkspaceRoot[workspaceRoot].model,
    "claude-opus-4-6"
  );
  assert.match(fs.readFileSync(envFile, "utf8"), /MOSSBRIDGE_CLAUDE_MODEL=claude-opus-4-6/);
  assert.match(output, /Model selection updated/);
  assert.match(output, /session_model: claude-opus-4-6/);
  assert.match(output, /effective_model: claude-opus-4-6/);
  assert.match(output, /applies_to: next_turn/);
});

test("shared model command treats default as clearing the workspace override", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-shared-model-clear-"));
  const stateDir = path.join(tempRoot, "state");
  const sessionFile = path.join(stateDir, "sessions.json");
  const workspaceRoot = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(sessionFile, `${JSON.stringify({
    bindings: {
      "default:account:user": {
        workspaceId: "default",
        accountId: "account",
        senderId: "user",
        activeWorkspaceRoot: workspaceRoot,
        codexParamsByWorkspaceRoot: {
          [workspaceRoot]: {
            model: "gpt-5.5",
          },
        },
      },
    },
    approvalCommandAllowlistByWorkspaceRoot: {},
    approvalPromptStateByThreadId: {},
    availableModelCatalog: { models: [], updatedAt: "" },
  }, null, 2)}\n`);

  const output = runSharedModel({
    argv: ["default"],
    env: {
      MOSSBRIDGE_RUNTIME: "codex",
      MOSSBRIDGE_STATE_DIR: stateDir,
      MOSSBRIDGE_SESSIONS_FILE: sessionFile,
      MOSSBRIDGE_WORKSPACE_ROOT: workspaceRoot,
    },
    cwd: tempRoot,
  });

  const updated = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
  assert.equal(
    updated.bindings["default:account:user"].codexParamsByWorkspaceRoot[workspaceRoot].model,
    ""
  );
  assert.match(output, /session_model: \(default\)/);
  assert.match(output, /effective_model: \(runtime default\)/);
});
