const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MEMORY_BUNDLE_SCHEMA = "mossbridge_memory_bundle_v0.1";

const BASE_EXPORT_ENTRIES = Object.freeze([
  { relPath: "storage/curated_memories.json", kind: "file", group: "stable" },
  { relPath: "storage/warm_memory", kind: "dir", group: "stable" },
  { relPath: "storage/ongoing_tracks.json", kind: "file", group: "stable" },
  { relPath: "storage/ongoing_tracks.archive.jsonl", kind: "file", group: "stable" },
  { relPath: "storage/calendar_items.json", kind: "file", group: "stable" },
  { relPath: "storage/notebook", kind: "dir", group: "stable" },
  { relPath: "storage/observation_journal", kind: "dir", group: "stable" },
  { relPath: "storage/episode_journal", kind: "dir", group: "stable" },
  { relPath: "storage/case_index", kind: "dir", group: "stable" },
  { relPath: "storage/solitude_journal", kind: "dir", group: "stable" },
  { relPath: "storage/truth_layer", kind: "dir", group: "stable" },
  { relPath: "storage/memory_tree", kind: "dir", group: "stable" },
  { relPath: "storage/memory_versions", kind: "dir", group: "stable" },
  { relPath: "storage/relationship_contracts", kind: "dir", group: "stable" },
  { relPath: "storage/stickers", kind: "dir", group: "stable" },
  { relPath: "cache/conversation_cache", kind: "dir", group: "cache" },
  { relPath: "cache/hot", kind: "dir", group: "cache" },
  { relPath: "cache/wakeup_journal.json", kind: "file", group: "cache" },
  { relPath: "cache/calendar_pending_actions.json", kind: "file", group: "cache" },
]);

const DEFERRED_EXPORT_ENTRIES = Object.freeze([
  { relPath: "storage/notion_sync", kind: "dir", group: "deferred" },
  { relPath: "cache/app_daily_captures", kind: "dir", group: "deferred" },
  { relPath: "cache/raw_transcript_active", kind: "dir", group: "deferred" },
  { relPath: "storage/raw_transcript_archive", kind: "dir", group: "deferred" },
]);

const OPERATIONAL_EXPORT_ENTRIES = Object.freeze([
  { relPath: "storage/dreaming_mutation_log", kind: "dir", group: "operational" },
]);

const USER_KEYS = new Set(["scoped_user_id", "user_id", "owner_id"]);
const REALM_KEYS = new Set(["realm_id"]);
const AGENT_KEYS = new Set(["agent_id", "assistant_id", "bot_id"]);
const STRING_PATH_KEYS = new Set(["relative_path"]);
const STRING_SCOPE_KEYS = new Set(["scope_id"]);

function exportMemoryBundle({
  sourceDataRoot = "",
  outputDir = "",
  sourceIdentity = {},
  includeCache = true,
  includeDeferred = false,
  includeOperational = false,
  replaceOutput = false,
  sourceStickersDir = "",
} = {}) {
  const sourceRoot = normalizePath(sourceDataRoot);
  const outDir = normalizePath(outputDir);
  if (!sourceRoot) {
    throw new Error("sourceDataRoot is required");
  }
  if (!outDir) {
    throw new Error("outputDir is required");
  }
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    throw new Error(`source data root does not exist: ${sourceRoot}`);
  }
  if (samePath(sourceRoot, outDir) || isInside(outDir, sourceRoot)) {
    throw new Error("outputDir must not be inside sourceDataRoot");
  }
  if (fs.existsSync(outDir)) {
    const entries = fs.readdirSync(outDir);
    if (entries.length && !replaceOutput) {
      throw new Error(`outputDir is not empty: ${outDir}`);
    }
    if (replaceOutput) {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(path.join(outDir, "data"), { recursive: true });

  const entries = resolveExportEntries({ includeCache, includeDeferred, includeOperational });
  const copied = [];
  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.relPath);
    if (!fs.existsSync(sourcePath)) {
      continue;
    }
    const destPath = path.join(outDir, "data", entry.relPath);
    const stats = copyAny(sourcePath, destPath);
    copied.push({
      rel_path: entry.relPath,
      kind: entry.kind,
      group: entry.group,
      files: stats.files,
      bytes: stats.bytes,
    });
  }
  const stickersSource = normalizePath(sourceStickersDir);
  if (stickersSource && fs.existsSync(stickersSource) && fs.statSync(stickersSource).isDirectory()) {
    const destPath = path.join(outDir, "data", "storage", "stickers");
    fs.rmSync(destPath, { recursive: true, force: true });
    const stats = copyAny(stickersSource, destPath);
    const existingIndex = copied.findIndex((item) => item.rel_path === "storage/stickers");
    const row = {
      rel_path: "storage/stickers",
      kind: "dir",
      group: "stable",
      files: stats.files,
      bytes: stats.bytes,
      source_override: "sourceStickersDir",
    };
    if (existingIndex >= 0) {
      copied[existingIndex] = row;
    } else {
      copied.push(row);
    }
  }

  const detected = detectMemoryIdentities(path.join(outDir, "data"));
  const identity = normalizeIdentity(sourceIdentity, detected.primary || {});
  const manifest = {
    schema: MEMORY_BUNDLE_SCHEMA,
    created_at: new Date().toISOString(),
    source: {
      data_root_name: path.basename(sourceRoot),
      data_root_digest: digestText(sourceRoot),
    },
    source_identity: identity,
    detected_identities: detected,
    include_cache: Boolean(includeCache),
    include_deferred: Boolean(includeDeferred),
    include_operational: Boolean(includeOperational),
    entries: copied,
  };
  writeJson(path.join(outDir, "manifest.json"), manifest);
  return {
    ok: true,
    bundle_dir: outDir,
    manifest_path: path.join(outDir, "manifest.json"),
    source_identity: identity,
    detected_identities: detected,
    entry_count: copied.length,
    file_count: copied.reduce((sum, item) => sum + (Number(item.files) || 0), 0),
    byte_count: copied.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
  };
}

function importMemoryBundle({
  bundleDir = "",
  targetDataRoot = "",
  sourceIdentity = {},
  targetIdentity = {},
  apply = false,
  replace = false,
} = {}) {
  const resolvedBundleDir = normalizePath(bundleDir);
  const targetRoot = normalizePath(targetDataRoot);
  if (!resolvedBundleDir) {
    throw new Error("bundleDir is required");
  }
  if (!targetRoot) {
    throw new Error("targetDataRoot is required");
  }
  const manifestPath = path.join(resolvedBundleDir, "manifest.json");
  const dataDir = path.join(resolvedBundleDir, "data");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`memory bundle manifest not found: ${manifestPath}`);
  }
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    throw new Error(`memory bundle data directory not found: ${dataDir}`);
  }
  if (samePath(dataDir, targetRoot) || isInside(targetRoot, dataDir) || isInside(dataDir, targetRoot)) {
    throw new Error("targetDataRoot must be separate from bundle data");
  }
  const manifest = readJson(manifestPath);
  if (manifest.schema !== MEMORY_BUNDLE_SCHEMA) {
    throw new Error(`unsupported memory bundle schema: ${manifest.schema || "(missing)"}`);
  }

  const detected = detectMemoryIdentities(dataDir);
  const source = normalizeIdentity(sourceIdentity, manifest.source_identity || detected.primary || {});
  const target = normalizeIdentity(targetIdentity, {
    userId: "owner",
    realmId: "default",
    agentId: "moss",
  });
  const mapping = buildIdentityMapping(source, target);
  const files = walkFiles(dataDir)
    .map((sourcePath) => {
      const relPath = normalizeRelPath(path.relative(dataDir, sourcePath));
      return {
        sourcePath,
        relPath,
        destRelPath: rewriteRelPath(relPath, mapping),
      };
    })
    .sort((left, right) => left.relPath.localeCompare(right.relPath));
  const roots = resolveReplaceRoots(manifest, mapping);

  const stats = {
    planned_files: files.length,
    written_files: 0,
    skipped_existing: 0,
    rewritten_json_files: 0,
    copied_bytes: 0,
  };
  const conflicts = [];

  if (apply && !replace) {
    for (const file of files) {
      const destPath = path.join(targetRoot, file.destRelPath);
      if (!fs.existsSync(destPath)) {
        continue;
      }
      conflicts.push({
        rel_path: file.destRelPath,
        reason: "exists",
      });
    }
    if (conflicts.length) {
      stats.skipped_existing = conflicts.length;
      return {
        ok: false,
        applied: false,
        replaced: false,
        bundle_dir: resolvedBundleDir,
        target_data_root: targetRoot,
        source_identity: source,
        target_identity: target,
        mapping,
        replace_roots: roots,
        stats,
        conflicts,
        policy: "Apply aborted before writing because target files already exist. Re-run dry-run first, or use --apply --replace only with an isolated target data root.",
      };
    }
  }

  if (apply) {
    fs.mkdirSync(targetRoot, { recursive: true });
    if (replace) {
      for (const relPath of roots) {
        fs.rmSync(path.join(targetRoot, relPath), { recursive: true, force: true });
      }
    }
  }

  for (const file of files) {
    const destPath = path.join(targetRoot, file.destRelPath);
    const exists = fs.existsSync(destPath);
    if (exists && !replace) {
      conflicts.push({
        rel_path: file.destRelPath,
        reason: "exists",
      });
      stats.skipped_existing += 1;
      continue;
    }
    if (!apply) {
      continue;
    }
    const result = copyPortableFile(file.sourcePath, destPath, mapping);
    stats.written_files += 1;
    stats.copied_bytes += result.bytes;
    if (result.rewritten) {
      stats.rewritten_json_files += 1;
    }
  }

  return {
    ok: conflicts.length === 0 || !apply,
    applied: Boolean(apply),
    replaced: Boolean(replace),
    bundle_dir: resolvedBundleDir,
    target_data_root: targetRoot,
    source_identity: source,
    target_identity: target,
    mapping,
    replace_roots: roots,
    stats,
    conflicts,
    policy: apply
      ? "Imported only memory data from the bundle into the target data root; runtime state, accounts, sessions, and WeChat tokens are not part of this bundle."
      : "Dry run only. Re-run with --apply to write files.",
  };
}

function detectMemoryIdentities(dataRoot) {
  const root = normalizePath(dataRoot);
  const users = new Set();
  const realms = new Set();
  const agents = new Set();
  const scopedUsers = new Set();

  collectWarmPathIdentities(root, users, realms, agents);
  collectCasePathIdentities(root, users, realms, agents, scopedUsers);
  collectEpisodePathIdentities(root, scopedUsers);
  collectMemoryVersionPathIdentities(root, users);
  collectConversationCacheIdentities(root, scopedUsers);
  collectHotPathIdentities(root, users, realms, agents);
  collectJsonFieldIdentities(root, users, realms, agents, scopedUsers);

  const out = {
    users: [...users].sort(),
    scoped_users: [...scopedUsers].sort(),
    realms: [...realms].sort(),
    agents: [...agents].sort(),
  };
  out.primary = {
    userId: out.users[0] || out.scoped_users[0] || "",
    realmId: out.realms[0] || "",
    agentId: out.agents[0] || "",
  };
  return out;
}

function resolveExportEntries({ includeCache, includeDeferred, includeOperational }) {
  let entries = BASE_EXPORT_ENTRIES.filter((entry) => includeCache || entry.group !== "cache");
  if (includeDeferred) {
    entries = entries.concat(DEFERRED_EXPORT_ENTRIES);
  }
  if (includeOperational) {
    entries = entries.concat(OPERATIONAL_EXPORT_ENTRIES);
  }
  return entries;
}

function copyAny(sourcePath, destPath) {
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    let files = 0;
    let bytes = 0;
    for (const filePath of walkFiles(sourcePath)) {
      const relPath = path.relative(sourcePath, filePath);
      const target = path.join(destPath, relPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(filePath, target);
      files += 1;
      bytes += fs.statSync(filePath).size;
    }
    if (!files) {
      fs.mkdirSync(destPath, { recursive: true });
    }
    return { files, bytes };
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(sourcePath, destPath);
  return { files: 1, bytes: stat.size };
}

function copyPortableFile(sourcePath, destPath, mapping) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext === ".json") {
    const parsed = readJson(sourcePath);
    writeJson(destPath, remapIdentityValue(parsed, mapping));
    return { bytes: fs.statSync(destPath).size, rewritten: true };
  }
  if (ext === ".jsonl") {
    const lines = fs.readFileSync(sourcePath, "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.stringify(remapIdentityValue(JSON.parse(line), mapping));
        } catch {
          return line;
        }
      });
    fs.writeFileSync(destPath, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
    return { bytes: fs.statSync(destPath).size, rewritten: true };
  }
  if (ext === ".md") {
    const text = fs.readFileSync(sourcePath, "utf8");
    fs.writeFileSync(destPath, rewriteMarkdownIdentityFields(text, mapping), "utf8");
    return { bytes: fs.statSync(destPath).size, rewritten: true };
  }
  fs.copyFileSync(sourcePath, destPath);
  return { bytes: fs.statSync(destPath).size, rewritten: false };
}

function remapIdentityValue(value, mapping, key = "") {
  if (Array.isArray(value)) {
    return value.map((item) => remapIdentityValue(item, mapping, key));
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      return remapIdentityString(key, value, mapping);
    }
    return value;
  }
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const normalizedKey = normalizeKey(rawKey);
    out[rawKey] = remapIdentityValue(rawValue, mapping, normalizedKey);
  }
  return out;
}

function remapIdentityString(key, value, mapping) {
  if (USER_KEYS.has(key)) {
    return replaceExact(value, mapping.source.userId, mapping.target.userId);
  }
  if (REALM_KEYS.has(key)) {
    return replaceExact(value, mapping.source.realmId, mapping.target.realmId);
  }
  if (AGENT_KEYS.has(key)) {
    return replaceExact(value, mapping.source.agentId, mapping.target.agentId);
  }
  if (STRING_PATH_KEYS.has(key)) {
    return rewriteRelPath(value, mapping);
  }
  if (STRING_SCOPE_KEYS.has(key)) {
    return rewriteScopeString(value, mapping);
  }
  return value;
}

function rewriteRelPath(relPath, mapping) {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) {
    return normalized;
  }
  const parts = normalized.split("/");
  const source = mapping.source || {};
  const target = mapping.target || {};
  if (parts[0] === "storage" && parts[1] === "warm_memory") {
    if (parts[2] === warmSafe(source.userId)) parts[2] = warmSafe(target.userId);
    if (parts[3] === warmSafe(source.realmId)) parts[3] = warmSafe(target.realmId);
    if (parts[4] === warmSafe(source.agentId)) parts[4] = warmSafe(target.agentId);
    return parts.join("/");
  }
  if (parts[0] === "storage" && parts[1] === "case_index") {
    if (parts[2] === caseSafe(source.userId)) parts[2] = caseSafe(target.userId);
    if (parts[3] === caseSafe(source.realmId)) parts[3] = caseSafe(target.realmId);
    if (parts[4] === caseSafe(source.agentId)) parts[4] = caseSafe(target.agentId);
    return parts.join("/");
  }
  if (parts[0] === "storage" && parts[1] === "episode_journal") {
    if (parts[2] === caseSafe(source.userId)) parts[2] = caseSafe(target.userId);
    return parts.join("/");
  }
  if (parts[0] === "storage" && parts[1] === "memory_versions") {
    if (parts[2] === source.userId) parts[2] = target.userId;
    return parts.join("/");
  }
  if (parts[0] === "storage" && parts[1] === "truth_layer") {
    if (parts[2] === source.userId) parts[2] = target.userId;
    if (parts[3] === source.realmId) parts[3] = target.realmId;
    if (parts[4] === source.agentId) parts[4] = target.agentId;
    return parts.join("/");
  }
  if (parts[0] === "storage" && parts[1] === "memory_tree") {
    if (parts[2] === source.userId) parts[2] = target.userId;
    if (parts[3] === source.realmId) parts[3] = target.realmId;
    if (parts[4] === source.agentId) parts[4] = target.agentId;
    if (parts[2] === "scopes") {
      if (parts[3] === source.userId) parts[3] = target.userId;
      if (parts[4] === source.realmId) parts[4] = target.realmId;
      if (parts[5] === source.agentId) parts[5] = target.agentId;
    }
    return parts.join("/");
  }
  if (parts[0] === "cache" && parts[1] === "conversation_cache" && parts[2]) {
    parts[2] = rewriteFilenamePrefix(parts[2], `${cacheSafe(source.userId)}__`, `${cacheSafe(target.userId)}__`);
    return parts.join("/");
  }
  if (parts[0] === "cache" && parts[1] === "hot" && parts.length >= 4) {
    const prefix = `${hotSafe(source.userId)}__${hotSafe(source.realmId)}__${hotSafe(source.agentId)}__`;
    const nextPrefix = `${hotSafe(target.userId)}__${hotSafe(target.realmId)}__${hotSafe(target.agentId)}__`;
    parts[3] = rewriteFilenamePrefix(parts[3], prefix, nextPrefix);
    return parts.join("/");
  }
  return normalized;
}

function rewriteScopeString(value, mapping) {
  let next = value;
  const source = mapping.source || {};
  const target = mapping.target || {};
  next = next.replace(
    `${source.userId}::${source.realmId}::${source.agentId}`,
    `${target.userId}::${target.realmId}::${target.agentId}`,
  );
  next = next.replace(
    `${hotSafe(source.userId)}__${hotSafe(source.realmId)}__${hotSafe(source.agentId)}__`,
    `${hotSafe(target.userId)}__${hotSafe(target.realmId)}__${hotSafe(target.agentId)}__`,
  );
  return next;
}

function rewriteMarkdownIdentityFields(text, mapping) {
  return String(text || "").replace(
    /^(scoped_user_id|user_id|owner_id|realm_id|agent_id|assistant_id|bot_id):\s*(.*)$/gmu,
    (line, key, value) => `${key}: ${remapIdentityString(normalizeKey(key), String(value || "").trim(), mapping)}`,
  );
}

function buildIdentityMapping(sourceIdentity, targetIdentity) {
  return {
    source: normalizeIdentity(sourceIdentity, {}),
    target: normalizeIdentity(targetIdentity, {}),
  };
}

function normalizeIdentity(input = {}, fallback = {}) {
  const value = input && typeof input === "object" ? input : {};
  const base = fallback && typeof fallback === "object" ? fallback : {};
  return {
    userId: normalizeText(value.userId || value.user_id || value.scopedUserId || value.scoped_user_id || base.userId || base.user_id),
    realmId: normalizeText(value.realmId || value.realm_id || base.realmId || base.realm_id),
    agentId: normalizeText(value.agentId || value.agent_id || value.assistantId || value.assistant_id || base.agentId || base.agent_id),
  };
}

function resolveReplaceRoots(manifest, mapping) {
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const roots = entries
    .map((entry) => normalizeRelPath(entry.rel_path || entry.relPath))
    .filter(Boolean)
    .map((relPath) => rewriteRelPath(relPath, mapping));
  return [...new Set(roots)].sort();
}

function collectWarmPathIdentities(root, users, realms, agents) {
  const dir = path.join(root, "storage", "warm_memory");
  if (!fs.existsSync(dir)) return;
  for (const user of listDirs(dir)) {
    users.add(user);
    for (const realm of listDirs(path.join(dir, user))) {
      realms.add(realm);
      for (const agent of listDirs(path.join(dir, user, realm))) {
        agents.add(agent);
      }
    }
  }
}

function collectCasePathIdentities(root, users, realms, agents, scopedUsers) {
  const dir = path.join(root, "storage", "case_index");
  if (!fs.existsSync(dir)) return;
  for (const user of listDirs(dir)) {
    users.add(user);
    scopedUsers.add(user);
    for (const realm of listDirs(path.join(dir, user))) {
      realms.add(realm);
      for (const agent of listDirs(path.join(dir, user, realm))) {
        agents.add(agent);
      }
    }
  }
}

function collectEpisodePathIdentities(root, scopedUsers) {
  const dir = path.join(root, "storage", "episode_journal");
  if (!fs.existsSync(dir)) return;
  listDirs(dir).forEach((item) => scopedUsers.add(item));
}

function collectMemoryVersionPathIdentities(root, users) {
  const dir = path.join(root, "storage", "memory_versions");
  if (!fs.existsSync(dir)) return;
  listDirs(dir).forEach((item) => users.add(item));
}

function collectConversationCacheIdentities(root, scopedUsers) {
  const dir = path.join(root, "cache", "conversation_cache");
  if (!fs.existsSync(dir)) return;
  for (const fileName of fs.readdirSync(dir)) {
    const index = fileName.indexOf("__");
    if (index > 0) {
      scopedUsers.add(fileName.slice(0, index));
    }
  }
}

function collectHotPathIdentities(root, users, realms, agents) {
  const hotRoot = path.join(root, "cache", "hot");
  if (!fs.existsSync(hotRoot)) return;
  for (const filePath of walkFiles(hotRoot)) {
    const fileName = path.basename(filePath);
    const parts = fileName.split("__");
    if (parts.length >= 4) {
      users.add(parts[0]);
      realms.add(parts[1]);
      agents.add(parts[2]);
    }
  }
}

function collectJsonFieldIdentities(root, users, realms, agents, scopedUsers) {
  let scanned = 0;
  for (const filePath of walkFiles(root)) {
    if (scanned > 500) break;
    if (![".json", ".jsonl"].includes(path.extname(filePath).toLowerCase())) {
      continue;
    }
    const rows = readJsonRows(filePath).slice(0, 200);
    for (const row of rows) {
      collectIdentityFields(row, users, realms, agents, scopedUsers);
    }
    scanned += 1;
  }
}

function collectIdentityFields(value, users, realms, agents, scopedUsers, key = "") {
  if (Array.isArray(value)) {
    value.forEach((item) => collectIdentityFields(item, users, realms, agents, scopedUsers, key));
    return;
  }
  if (!value || typeof value !== "object") {
    const text = normalizeText(value);
    if (!text) return;
    if (key === "scoped_user_id") scopedUsers.add(text);
    if (USER_KEYS.has(key)) users.add(text);
    if (REALM_KEYS.has(key)) realms.add(text);
    if (AGENT_KEYS.has(key)) agents.add(text);
    return;
  }
  for (const [rawKey, rawValue] of Object.entries(value)) {
    collectIdentityFields(rawValue, users, realms, agents, scopedUsers, normalizeKey(rawKey));
  }
}

function readJsonRows(filePath) {
  try {
    if (filePath.endsWith(".jsonl")) {
      return fs.readFileSync(filePath, "utf8")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((item) => item && typeof item === "object");
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return [parsed];
  } catch {
    return [];
  }
}

function walkFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".DS_Store") {
        continue;
      }
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(target);
      } else if (entry.isFile()) {
        out.push(target);
      }
    }
  }
  return out.sort();
}

function listDirs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => item.name)
    .sort();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function replaceExact(value, source, target) {
  if (!source || !target) {
    return value;
  }
  return value === source ? target : value;
}

function rewriteFilenamePrefix(fileName, sourcePrefix, targetPrefix) {
  if (sourcePrefix && fileName.startsWith(sourcePrefix)) {
    return `${targetPrefix}${fileName.slice(sourcePrefix.length)}`;
  }
  return fileName;
}

function normalizeKey(key) {
  return normalizeText(key).replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).toLowerCase();
}

function normalizePath(value) {
  const normalized = normalizeText(value);
  return normalized ? path.resolve(normalized) : "";
}

function normalizeRelPath(value) {
  return normalizeText(value).replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter(Boolean).join("/");
}

function samePath(left, right) {
  return normalizePath(left) === normalizePath(right);
}

function isInside(childPath, parentPath) {
  const child = normalizePath(childPath);
  const parent = normalizePath(parentPath);
  if (!child || !parent || child === parent) {
    return false;
  }
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function digestText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function warmSafe(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "") || "card";
}

function caseSafe(value) {
  return normalizeText(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function hotSafe(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "_")
    .replace(/^[._-]+|[._-]+$/gu, "") || "default";
}

function cacheSafe(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "") || "default";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  MEMORY_BUNDLE_SCHEMA,
  detectMemoryIdentities,
  exportMemoryBundle,
  importMemoryBundle,
  rewriteRelPath,
};
