#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const dotenv = require("dotenv");

const { readConfig } = require("../src/core/config");
const { exportMemoryBundle } = require("../src/importers/memory-portability");

function main(argv = process.argv.slice(2)) {
  loadEnv();
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return;
  }
  const config = readConfig();
  const sourceDataRoot = readFlag(argv, "--source-data-root") || config.asherieDataRoot;
  const outputDir = readFlag(argv, "--out") || readFlag(argv, "--output");
  if (!outputDir) {
    printResult({
      ok: false,
      errors: ["--out is required"],
    });
    process.exitCode = 1;
    return;
  }

  const result = exportMemoryBundle({
    sourceDataRoot,
    outputDir,
    sourceIdentity: readSourceIdentity(argv),
    includeCache: !argv.includes("--no-cache"),
    includeDeferred: argv.includes("--include-deferred"),
    includeOperational: argv.includes("--include-operational"),
    replaceOutput: argv.includes("--replace-output"),
    sourceStickersDir: readFlag(argv, "--source-stickers-dir"),
  });
  printResult(result);
}

function readSourceIdentity(argv) {
  return {
    userId: readFlag(argv, "--source-user-id"),
    realmId: readFlag(argv, "--source-realm-id"),
    agentId: readFlag(argv, "--source-agent-id"),
  };
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

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

function printUsage() {
  console.log("Usage: npm run memory:export -- --source-data-root <MossbridgeData|HomeData> --out <bundle-dir> [--replace-output]");
  console.log("Optional: --source-user-id <id> --source-realm-id <id> --source-agent-id <id> --source-stickers-dir <dir> --no-cache --include-deferred --include-operational");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    printResult({
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    });
    process.exitCode = 1;
  }
}

module.exports = { main };
