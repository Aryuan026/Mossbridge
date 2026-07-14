const fs = require("fs");
const os = require("os");
const path = require("path");
const { normalizeCodexTokenCountPayload } = require("./events");

const MAX_SESSION_FILES_TO_SCAN = 5000;

function readLatestCodexSessionTokenUsage({ threadId = "", codexHome = "" } = {}) {
  const normalizedThreadId = normalizeText(threadId);
  if (!normalizedThreadId) {
    return null;
  }
  const filePath = findCodexSessionFileForThreadId(normalizedThreadId, { codexHome });
  if (!filePath) {
    return null;
  }
  const payload = readLatestTokenCountPayloadFromFile(filePath);
  if (!payload) {
    return null;
  }
  return {
    ...normalizeCodexTokenCountPayload({
      ...payload,
      thread_id: payload.thread_id || normalizedThreadId,
    }),
    source: "codex_session_jsonl",
    sourceFile: filePath,
  };
}

function findCodexSessionFileForThreadId(threadId = "", { codexHome = "" } = {}) {
  const normalizedThreadId = normalizeText(threadId);
  if (!normalizedThreadId) {
    return "";
  }
  const sessionsRoot = path.join(resolveCodexHome(codexHome), "sessions");
  if (!fs.existsSync(sessionsRoot)) {
    return "";
  }
  let scanned = 0;
  const matches = [];
  const stack = [sessionsRoot];
  while (stack.length && scanned < MAX_SESSION_FILES_TO_SCAN) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => right.name.localeCompare(left.name));
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      scanned += 1;
      if (entry.name.includes(normalizedThreadId)) {
        matches.push(entryPath);
      }
    }
  }
  if (!matches.length) {
    return "";
  }
  matches.sort((left, right) => safeMtimeMs(right) - safeMtimeMs(left));
  return matches[0];
}

function readLatestTokenCountPayloadFromFile(filePath = "") {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line || !line.includes("token_count")) {
      continue;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = parsed?.payload;
    if (payload?.type === "token_count" && payload.info && typeof payload.info === "object") {
      return payload;
    }
  }
  return null;
}

function resolveCodexHome(codexHome = "") {
  return normalizeText(codexHome)
    || normalizeText(process.env.CODEX_HOME)
    || path.join(os.homedir(), ".codex");
}

function safeMtimeMs(filePath = "") {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  findCodexSessionFileForThreadId,
  readLatestCodexSessionTokenUsage,
  readLatestTokenCountPayloadFromFile,
};
