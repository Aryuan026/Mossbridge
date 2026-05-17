#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { readConfig } = require("../src/core/config");
const { createProjectTooling } = require("../src/tools/create-project-tooling");

function main() {
  const args = parseArgs(process.argv.slice(2));
  applyAuditDefaultEnv();
  const config = readConfig();
  const tooling = createProjectTooling(config, {});
  const tools = tooling.toolHost.listTools({ toolProfile: args.profile });
  const report = buildReport({
    tools,
    repoRoot: path.resolve(__dirname, ".."),
    limit: args.limit,
    profile: args.profile,
  });

  const output = args.format === "markdown"
    ? formatMarkdown(report)
    : `${JSON.stringify(report, null, 2)}\n`;

  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, output);
  } else {
    process.stdout.write(output);
  }
}

function applyAuditDefaultEnv() {
  const base = path.join(os.tmpdir(), "mossbridge-tool-catalog-audit");
  if (!process.env.MOSSBRIDGE_STATE_DIR) {
    process.env.MOSSBRIDGE_STATE_DIR = path.join(base, "state");
  }
  if (!process.env.MOSSBRIDGE_DATA_ROOT) {
    process.env.MOSSBRIDGE_DATA_ROOT = path.join(base, "data");
  }
  if (!process.env.MOSSBRIDGE_WORKSPACE_ROOT) {
    process.env.MOSSBRIDGE_WORKSPACE_ROOT = path.join(base, "workspace");
  }
}

function parseArgs(argv) {
  const args = {
    format: "json",
    limit: 25,
    out: "",
    profile: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--format") {
      args.format = normalizeFormat(argv[index + 1]);
      index += 1;
      continue;
    }
    if (value.startsWith("--format=")) {
      args.format = normalizeFormat(value.slice("--format=".length));
      continue;
    }
    if (value === "--limit") {
      args.limit = normalizeLimit(argv[index + 1]);
      index += 1;
      continue;
    }
    if (value.startsWith("--limit=")) {
      args.limit = normalizeLimit(value.slice("--limit=".length));
      continue;
    }
    if (value === "--profile") {
      args.profile = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    if (value.startsWith("--profile=")) {
      args.profile = value.slice("--profile=".length).trim();
      continue;
    }
    if (value === "--out") {
      args.out = path.resolve(String(argv[index + 1] || ""));
      index += 1;
      continue;
    }
    if (value.startsWith("--out=")) {
      args.out = path.resolve(value.slice("--out=".length));
    }
  }
  return args;
}

function normalizeFormat(value) {
  return value === "markdown" ? "markdown" : "json";
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 25;
}

function buildReport({ tools, repoRoot, limit, profile }) {
  const serialized = JSON.stringify(tools);
  const rows = tools.map((tool, index) => buildToolRow(tool, index));
  const packageJson = readJson(path.join(repoRoot, "package.json")) || {};
  const groups = groupRows(rows);

  return {
    generatedAt: new Date().toISOString(),
    repo: normalizeText(packageJson.name) || path.basename(repoRoot),
    profile: normalizeText(profile) || "full",
    toolCount: tools.length,
    catalogChars: serialized.length,
    approxPromptTokens: Math.ceil(serialized.length / 4),
    catalogHash: hashText(serialized),
    topByTotalChars: rows
      .slice()
      .sort((left, right) => right.totalChars - left.totalChars)
      .slice(0, limit),
    groups,
    names: rows.map((row) => row.name),
  };
}

function buildToolRow(tool, index) {
  const description = String(tool.description || "");
  const inputSchema = tool.inputSchema || {};
  const schemaText = JSON.stringify(inputSchema);
  return {
    index,
    name: String(tool.name || ""),
    group: resolveGroup(String(tool.name || "")),
    descriptionChars: description.length,
    schemaChars: schemaText.length,
    totalChars: description.length + schemaText.length,
    toolHash: hashText(JSON.stringify(tool)).slice(0, 12),
  };
}

function resolveGroup(name) {
  const normalized = name.replace(/^mossbridge_/u, "");
  const groupRules = [
    ["memory_case_", "memory_case"],
    ["memory_episode_", "memory_episode"],
    ["memory_observation_", "memory_observation"],
    ["memory_ongoing_", "memory_ongoing"],
    ["memory_warm_", "memory_warm"],
    ["memory_cold_", "memory_cold"],
    ["memory_metabolism_", "memory_metabolism"],
    ["sticker_", "sticker"],
    ["timeline_", "timeline"],
    ["wakeup_", "wakeup"],
    ["solitude_journal_", "solitude_journal"],
    ["reminder_", "reminder"],
    ["channel_", "channel"],
  ];
  const match = groupRules.find(([prefix]) => normalized.startsWith(prefix));
  if (match) {
    return match[1];
  }
  return normalized.split("_").slice(0, 2).join("_") || "other";
}

function groupRows(rows) {
  const totals = new Map();
  for (const row of rows) {
    const current = totals.get(row.group) || {
      group: row.group,
      toolCount: 0,
      descriptionChars: 0,
      schemaChars: 0,
      totalChars: 0,
      heaviestTool: "",
      heaviestToolChars: 0,
    };
    current.toolCount += 1;
    current.descriptionChars += row.descriptionChars;
    current.schemaChars += row.schemaChars;
    current.totalChars += row.totalChars;
    if (row.totalChars > current.heaviestToolChars) {
      current.heaviestTool = row.name;
      current.heaviestToolChars = row.totalChars;
    }
    totals.set(row.group, current);
  }
  return [...totals.values()].sort((left, right) => right.totalChars - left.totalChars);
}

function formatMarkdown(report) {
  const lines = [
    `# Tool Catalog Audit: ${report.repo}`,
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- profile: ${report.profile}`,
    `- toolCount: ${report.toolCount}`,
    `- catalogChars: ${report.catalogChars}`,
    `- approxPromptTokens: ${report.approxPromptTokens}`,
    `- catalogHash: ${report.catalogHash}`,
    "",
    "## Top Tools By Size",
    "",
    "| total | desc | schema | group | tool | hash |",
    "| ---: | ---: | ---: | --- | --- | --- |",
  ];
  for (const row of report.topByTotalChars) {
    lines.push(`| ${row.totalChars} | ${row.descriptionChars} | ${row.schemaChars} | ${row.group} | \`${row.name}\` | \`${row.toolHash}\` |`);
  }
  lines.push(
    "",
    "## Groups By Size",
    "",
    "| total | tools | desc | schema | group | heaviest tool |",
    "| ---: | ---: | ---: | ---: | --- | --- |",
  );
  for (const group of report.groups) {
    lines.push(`| ${group.totalChars} | ${group.toolCount} | ${group.descriptionChars} | ${group.schemaChars} | ${group.group} | \`${group.heaviestTool}\` |`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

main();
