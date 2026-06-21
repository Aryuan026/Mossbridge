#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");

const { readConfig } = require("../src/core/config");
const { importDailyCaptureTarget } = require("../src/importers/app-daily-capture");
const { AsherieMemoryService } = require("../src/services/asherie-memory-service");
const { MemoryMetabolismService } = require("../src/services/memory-metabolism-service");

async function main(argv = process.argv.slice(2)) {
  loadEnv();
  const targetPath = argv.find((item) => item && !String(item).startsWith("--")) || "";
  if (!targetPath || argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    process.exitCode = targetPath ? 0 : 1;
    return;
  }

  const config = readConfig();
  const errors = [];
  requireExplicitEnv("MOSSBRIDGE_STATE_DIR", errors);
  requireExplicitEnv("MOSSBRIDGE_DATA_ROOT", errors);
  requireSeparatePath("MOSSBRIDGE_STATE_DIR", config.stateDir, "MOSSBRIDGE_DATA_ROOT", config.asherieDataRoot, errors);
  if (errors.length) {
    printResult({ ok: false, imported: false, errors });
    process.exitCode = 1;
    return;
  }

  const memoryService = new AsherieMemoryService({ config });
  const memoryMetabolism = new MemoryMetabolismService({ config, memoryService });
  const result = await importDailyCaptureTarget(targetPath, { memoryService, memoryMetabolism });
  printResult({
    ok: result.ok,
    imported: result.imported === true,
    staged_dir: result.staged_dir,
    stage_ref: result.stage_ref,
    scope: result.scope,
    stats: result.stats,
    errors: result.errors || [],
    warnings: result.warnings || [],
  });
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

function requireExplicitEnv(name, errors) {
  if (!normalizeText(process.env[name])) {
    errors.push(`${name} must be set explicitly before importing capture data`);
  }
}

function requireSeparatePath(leftName, leftValue, rightName, rightValue, errors) {
  const left = normalizeText(leftValue) ? path.resolve(leftValue) : "";
  const right = normalizeText(rightValue) ? path.resolve(rightValue) : "";
  if (left && right && left === right) {
    errors.push(`${leftName} and ${rightName} must be different paths`);
  }
}

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
  for (const warning of result.warnings || []) {
    console.error(`[mossbridge:capture:warning] ${warning}`);
  }
  for (const error of result.errors || []) {
    console.error(`[mossbridge:capture:error] ${error}`);
  }
}

function printUsage() {
  console.log("Usage: npm run capture:import -- <bundle.json|staged-directory>");
  console.log("Requires explicit MOSSBRIDGE_STATE_DIR and MOSSBRIDGE_DATA_ROOT.");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[mossbridge:capture:import:error] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
