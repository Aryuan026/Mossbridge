const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const CODEX_COMPANION_PROFILE_ID = "mossbridge_codex_companion_v0";
const CODEX_COMPANION_PERSONALITY = "none";
const CODEX_COMPANION_VERSION_PREFIX = "mossbridge_codex_companion_base.v1";

function prepareCodexCompanionProfile({ enabled = false, instructionsFile = "" } = {}) {
  const requested = enabled === true;
  if (!requested) {
    return buildProfile({
      requested,
      applied: false,
      skipReason: "disabled",
    });
  }

  const resolvedInstructionsFile = normalizePath(instructionsFile);
  if (!resolvedInstructionsFile) {
    throw new Error("MOSSBRIDGE_CODEX_COMPANION_PROFILE requires an instructions file");
  }

  const delivery = readCodexCompanionDelivery({
    instructionsFile: resolvedInstructionsFile,
  });

  return buildProfile({
    requested,
    applied: true,
    instructionsFile: resolvedInstructionsFile,
    baseInstructions: delivery.baseInstructions,
    baseInstructionsVersion: delivery.baseInstructionsVersion,
    baseInstructionsSha256: delivery.baseInstructionsSha256,
    baseInstructionsChars: delivery.baseInstructionsChars,
    personality: CODEX_COMPANION_PERSONALITY,
    deliveryMode: "thread_start_resume",
    threadOverrideApplied: true,
    runtimeIsolationApplied: false,
    localRuntimeIsolationStatus: "hold_lane_safety",
  });
}

function readCodexCompanionDelivery(profile = {}) {
  const resolvedInstructionsFile = normalizePath(profile.instructionsFile);
  if (!resolvedInstructionsFile) {
    throw new Error("Codex companion instructions file is not configured");
  }
  const baseInstructions = fs.readFileSync(resolvedInstructionsFile, "utf8").trim();
  if (!baseInstructions) {
    throw new Error(`Codex companion instructions file is empty: ${resolvedInstructionsFile}`);
  }
  const baseInstructionsSha256 = sha256(baseInstructions);
  return {
    instructionsFile: resolvedInstructionsFile,
    baseInstructions,
    baseInstructionsVersion: buildBaseInstructionsVersion(baseInstructionsSha256),
    baseInstructionsSha256,
    baseInstructionsChars: baseInstructions.length,
  };
}

function buildCodexCompanionDiagnostics(profile = {}, { deliveryVerified = false, delivered = null } = {}) {
  const deliveredShape = delivered && typeof delivered === "object" ? delivered : null;
  const effective = deliveredShape || profile;
  return {
    profile_id: profile.id || CODEX_COMPANION_PROFILE_ID,
    requested: profile.requested === true,
    applied: profile.applied === true,
    delivery_mode: profile.deliveryMode || "disabled",
    delivery_verified: profile.applied === true && deliveryVerified === true,
    base_instructions_version: effective.baseInstructionsVersion || "",
    base_instructions_sha256: effective.baseInstructionsSha256 || "",
    base_instructions_chars: effective.baseInstructionsChars || 0,
    personality: profile.personality || "",
    runtime_isolation_applied: profile.runtimeIsolationApplied === true,
    thread_instruction_override: profile.threadOverrideApplied === true,
    local_runtime_isolation_status: profile.localRuntimeIsolationStatus || "",
    bridge_mcp_preserved: true,
    persistent_threads_preserved: true,
    skip_reason: profile.skipReason || "",
  };
}

function buildProfile({
  requested = false,
  applied = false,
  skipReason = "",
  instructionsFile = "",
  baseInstructions = "",
  baseInstructionsVersion = "",
  baseInstructionsSha256 = "",
  baseInstructionsChars = 0,
  personality = "",
  deliveryMode = "disabled",
  threadOverrideApplied = false,
  runtimeIsolationApplied = false,
  localRuntimeIsolationStatus = "",
} = {}) {
  return {
    id: CODEX_COMPANION_PROFILE_ID,
    requested,
    applied,
    skipReason,
    instructionsFile,
    baseInstructions,
    baseInstructionsVersion,
    baseInstructionsSha256,
    baseInstructionsChars,
    personality,
    deliveryMode,
    threadOverrideApplied,
    runtimeIsolationApplied,
    localRuntimeIsolationStatus,
    diagnostics: buildCodexCompanionDiagnostics({
      id: CODEX_COMPANION_PROFILE_ID,
      requested,
      applied,
      skipReason,
      baseInstructionsVersion,
      baseInstructionsSha256,
      baseInstructionsChars,
      personality,
      deliveryMode,
      threadOverrideApplied,
      runtimeIsolationApplied,
      localRuntimeIsolationStatus,
    }),
  };
}

function normalizePath(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? path.resolve(normalized) : "";
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function buildBaseInstructionsVersion(sha) {
  const normalizedSha = typeof sha === "string" ? sha.trim() : "";
  if (!normalizedSha) {
    return "";
  }
  return `${CODEX_COMPANION_VERSION_PREFIX}:${normalizedSha.slice(0, 24)}`;
}

module.exports = {
  CODEX_COMPANION_PERSONALITY,
  CODEX_COMPANION_PROFILE_ID,
  CODEX_COMPANION_VERSION_PREFIX,
  buildCodexCompanionDiagnostics,
  prepareCodexCompanionProfile,
  readCodexCompanionDelivery,
};
