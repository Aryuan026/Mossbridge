#!/usr/bin/env node

const { validateDailyCaptureTarget } = require("../src/importers/app-daily-capture");

function main(argv) {
  const targetPath = argv[0] || "";
  if (!targetPath || targetPath === "--help" || targetPath === "-h") {
    printUsage();
    process.exitCode = targetPath ? 0 : 1;
    return;
  }

  const result = validateDailyCaptureTarget(targetPath);
  console.log(JSON.stringify({
    ok: result.ok,
    summary: result.summary,
    warning_count: result.warnings.length,
    error_count: result.errors.length,
  }, null, 2));

  for (const warning of result.warnings) {
    console.error(`[mossbridge:capture:warning] ${warning}`);
  }
  for (const error of result.errors) {
    console.error(`[mossbridge:capture:error] ${error}`);
  }
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function printUsage() {
  console.log("Usage: node ./scripts/validate-app-daily-capture.js <bundle.json|staged-directory>");
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { main };
