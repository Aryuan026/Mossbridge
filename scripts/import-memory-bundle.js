#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");

const { readConfig } = require("../src/core/config");
const { importMemoryBundle } = require("../src/importers/memory-portability");

function main(argv = process.argv.slice(2)) {
  loadEnv();
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return;
  }
  const config = readConfig();
  const bundleDir = readFlag(argv, "--bundle") || argv.find((item) => item && !String(item).startsWith("--")) || "";
  const errors = [];
  if (!bundleDir) {
    errors.push("--bundle or bundle path is required");
  }
  requireExplicitEnv("MOSSBRIDGE_STATE_DIR", errors);
  requireExplicitEnv("MOSSBRIDGE_DATA_ROOT", errors);
  requireSeparatePath("MOSSBRIDGE_STATE_DIR", config.stateDir, "MOSSBRIDGE_DATA_ROOT", config.asherieDataRoot, errors);
  if (errors.length) {
    printResult({ ok: false, applied: false, errors });
    process.exitCode = 1;
    return;
  }

  const result = importMemoryBundle({
    bundleDir,
    targetDataRoot: config.asherieDataRoot,
    sourceIdentity: {
      userId: readFlag(argv, "--source-user-id"),
      realmId: readFlag(argv, "--source-realm-id"),
      agentId: readFlag(argv, "--source-agent-id"),
    },
    targetIdentity: {
      userId: readFlag(argv, "--target-user-id") || config.identityUserId,
      realmId: readFlag(argv, "--target-realm-id") || config.identityRealmId,
      agentId: readFlag(argv, "--target-agent-id") || config.identityAgentId,
    },
    apply: argv.includes("--apply"),
    replace: argv.includes("--replace"),
  });
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
    path.join(os.homedir(), ".mossbridge", ".env"),
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) {
      continue;
    }
    dotenv.config({ path: envPath });
    return;
  }
  dotenv.config();
}

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || index === argv.length - 1) {
    return "";
  }
  return String(argv[index + 1] || "").trim();
}

function requireExplicitEnv(name, errors) {
  if (!normalizeText(process.env[name])) {
    errors.push(`${name} must be set explicitly before importing a memory bundle`);
  }
}

function requireSeparatePath(leftName, leftValue, rightName, rightValue, errors) {
  const left = normalizePath(leftValue);
  const right = normalizePath(rightValue);
  if (!left || !right) {
    return;
  }
  if (left === right || isInside(left, right) || isInside(right, left)) {
    errors.push(`${leftName} and ${rightName} must be separate paths`);
  }
}

function isInside(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
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

function printUsage() {
  console.log("Usage: MOSSBRIDGE_STATE_DIR=/tmp/state MOSSBRIDGE_DATA_ROOT=/tmp/data npm run memory:import -- --bundle <bundle-dir> [--apply] [--replace]");
  console.log("Dry run is the default. Use --apply to write, and --replace only for an isolated target data root.");
  console.log("Optional: --source-user-id <id> --source-realm-id <id> --source-agent-id <id> --target-user-id <id> --target-realm-id <id> --target-agent-id <id>");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    printResult({
      ok: false,
      applied: false,
      errors: [error instanceof Error ? error.message : String(error)],
    });
    process.exitCode = 1;
  }
}

module.exports = { main };
