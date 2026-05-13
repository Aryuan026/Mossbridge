#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");

const { readConfig } = require("../src/core/config");
const { AsherieMemoryService } = require("../src/services/asherie-memory-service");

async function main() {
  loadEnv();
  const config = readConfig();
  const errors = [];

  requireExplicitEnv("MOSSBRIDGE_STATE_DIR", errors);
  requireExplicitEnv("MOSSBRIDGE_DATA_ROOT", errors);
  requireExplicitEnv("MOSSBRIDGE_WORKSPACE_ROOT", errors);
  requireSeparatePath("MOSSBRIDGE_STATE_DIR", config.stateDir, "MOSSBRIDGE_DATA_ROOT", config.asherieDataRoot, errors);
  requireSeparatePath("MOSSBRIDGE_STATE_DIR", config.stateDir, "MOSSBRIDGE_WORKSPACE_ROOT", config.workspaceRoot, errors);
  requireSeparatePath("MOSSBRIDGE_DATA_ROOT", config.asherieDataRoot, "MOSSBRIDGE_WORKSPACE_ROOT", config.workspaceRoot, errors);

  if (errors.length) {
    printResult({ ok: false, errors });
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(config.workspaceRoot, { recursive: true });

  const service = new AsherieMemoryService({ config });
  const packet = await service.captureContextPacket({
    query: "mossbridge empty memory smoke",
    recall_mode: "user_triggered",
  });
  const layout = service.layout;
  const requiredDirs = {
    storage_root: layout.storageRoot,
    cache_root: layout.cacheRoot,
    warm_memory: layout.warmMemoryDir,
    ongoing_parent: path.dirname(layout.ongoingTrackStorePath),
    conversation_cache: layout.conversationCacheDir,
    observation_journal: layout.observationJournalDir,
    episode_journal: layout.episodeJournalDir,
    solitude_journal: layout.solitudeJournalDir,
    notebook: layout.notebookDir,
    case_index: layout.caseIndexDir,
    memory_tree: layout.memoryTreeDir,
    truth_layer: layout.truthLayerDir,
    memory_versions: layout.memoryVersionBankDir,
    raw_transcript_archive: layout.rawTranscriptArchiveDir,
    raw_transcript_active: layout.rawTranscriptActiveDir,
    dreaming_mutation_log: layout.dreamingMutationLogDir,
    relationship_contracts: layout.relationshipContractDir,
    runtime_state: layout.runtimeStateDir,
    startup_state: layout.startupStateDir,
    wechat_transport_state: layout.wechatTransportStateDir,
    hub_state: layout.hubStateDir,
  };
  const missingDirs = Object.entries(requiredDirs)
    .filter(([, dir]) => !fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
    .map(([label, dir]) => ({ label, path: dir }));

  const identityMatches = packet?.cold_scope?.agent_id === config.identityAgentId
    && packet?.cold_scope?.owner_id === config.identityUserId
    && packet?.cold_scope?.realm_id === config.identityRealmId;

  const result = {
    ok: missingDirs.length === 0 && packet?.ok === true && identityMatches,
    summary: {
      runtime: config.runtime,
      state_dir: config.stateDir,
      data_root: config.asherieDataRoot,
      workspace_root: config.workspaceRoot,
      identity: {
        user_id: config.identityUserId,
        realm_id: config.identityRealmId,
        agent_id: config.identityAgentId,
      },
      context_packet_ok: packet?.ok === true,
      identity_matches_context: identityMatches,
      required_dir_count: Object.keys(requiredDirs).length,
      missing_dir_count: missingDirs.length,
    },
    missing_dirs: missingDirs,
    first_version_policy: "This smoke verifies the local Mossbridge brain only: hot cache, notebook, warm memory, ongoing, journals, case, and topology roots. External imports, app capture sync, and Notion sync are deferred extension paths.",
  };

  printResult(result);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function loadEnv() {
  const stateDir = process.env.MOSSBRIDGE_STATE_DIR || path.join(os.homedir(), ".mossbridge");
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(stateDir, ".env"),
  ];
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      return;
    }
  }
  dotenv.config();
}

function requireExplicitEnv(name, errors) {
  if (!normalizeText(process.env[name])) {
    errors.push(`${name} must be set explicitly for the empty memory smoke`);
  }
}

function requireSeparatePath(leftName, leftPath, rightName, rightPath, errors) {
  const left = normalizePath(leftPath);
  const right = normalizePath(rightPath);
  if (!left || !right) {
    return;
  }
  if (left === right || isInside(left, right) || isInside(right, left)) {
    errors.push(`${leftName} and ${rightName} must be separate paths for smoke tests`);
  }
}

function isInside(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function normalizePath(value) {
  const normalized = normalizeText(value);
  return normalized ? path.resolve(normalized) : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    printResult({
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    });
    process.exitCode = 1;
  });
}

module.exports = { main };
