const fs = require("fs");
const path = require("path");
const { normalizeAccountId } = require("./account-store");

function ensureAccountsDir(config) {
  fs.mkdirSync(config.accountsDir, { recursive: true });
}

function resolveContextTokenPath(config, accountId) {
  ensureAccountsDir(config);
  return path.join(config.accountsDir, `${normalizeAccountId(accountId)}.context-tokens.json`);
}

function resolveContextTokenMetadataPath(config, accountId) {
  ensureAccountsDir(config);
  return path.join(config.accountsDir, `${normalizeAccountId(accountId)}.context-token-meta.json`);
}

function loadPersistedContextTokens(config, accountId) {
  try {
    const filePath = resolveContextTokenPath(config, accountId);
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([userId, token]) => typeof userId === "string" && userId.trim() && typeof token === "string" && token.trim())
        .map(([userId, token]) => [userId.trim(), token.trim()])
    );
  } catch {
    return {};
  }
}

function loadPersistedContextTokenMetadata(config, accountId) {
  try {
    const filePath = resolveContextTokenMetadataPath(config, accountId);
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([userId, meta]) => {
          const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
          if (!normalizedUserId) {
            return null;
          }
          const updatedAt = typeof meta?.updatedAt === "string" ? meta.updatedAt.trim() : "";
          const parsedAt = Date.parse(updatedAt);
          if (!Number.isFinite(parsedAt)) {
            return null;
          }
          return [normalizedUserId, { updatedAt: new Date(parsedAt).toISOString() }];
        })
        .filter(Boolean)
    );
  } catch {
    return {};
  }
}

function savePersistedContextTokens(config, accountId, tokens) {
  const normalizedTokens = Object.fromEntries(
    Object.entries(tokens || {})
      .filter(([userId, token]) => typeof userId === "string" && userId.trim() && typeof token === "string" && token.trim())
      .map(([userId, token]) => [userId.trim(), token.trim()])
  );
  const filePath = resolveContextTokenPath(config, accountId);
  fs.writeFileSync(filePath, JSON.stringify(normalizedTokens, null, 2), "utf8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort
  }
  return normalizedTokens;
}

function savePersistedContextTokenMetadata(config, accountId, metadata) {
  const normalizedMetadata = Object.fromEntries(
    Object.entries(metadata || {})
      .map(([userId, meta]) => {
        const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
        const updatedAt = typeof meta?.updatedAt === "string" ? meta.updatedAt.trim() : "";
        const parsedAt = Date.parse(updatedAt);
        if (!normalizedUserId || !Number.isFinite(parsedAt)) {
          return null;
        }
        return [normalizedUserId, { updatedAt: new Date(parsedAt).toISOString() }];
      })
      .filter(Boolean)
  );
  const filePath = resolveContextTokenMetadataPath(config, accountId);
  fs.writeFileSync(filePath, JSON.stringify(normalizedMetadata, null, 2), "utf8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best effort
  }
  return normalizedMetadata;
}

function persistContextTokenMetadata(config, accountId, userId, updatedAt = new Date().toISOString()) {
  const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
  const parsedAt = Date.parse(updatedAt);
  if (!normalizedUserId || !Number.isFinite(parsedAt)) {
    return loadPersistedContextTokenMetadata(config, accountId);
  }
  const existing = loadPersistedContextTokenMetadata(config, accountId);
  return savePersistedContextTokenMetadata(config, accountId, {
    ...existing,
    [normalizedUserId]: {
      updatedAt: new Date(parsedAt).toISOString(),
    },
  });
}

function persistContextToken(config, accountId, userId, token) {
  const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
  const normalizedToken = typeof token === "string" ? token.trim() : "";
  if (!normalizedUserId || !normalizedToken) {
    return loadPersistedContextTokens(config, accountId);
  }
  const existing = loadPersistedContextTokens(config, accountId);
  if (existing[normalizedUserId] === normalizedToken) {
    persistContextTokenMetadata(config, accountId, normalizedUserId);
    return existing;
  }
  persistContextTokenMetadata(config, accountId, normalizedUserId);
  return savePersistedContextTokens(config, accountId, {
    ...existing,
    [normalizedUserId]: normalizedToken,
  });
}

function getPersistedContextTokenAgeMs(config, accountId, userId, nowMs = Date.now()) {
  const normalizedUserId = typeof userId === "string" ? userId.trim() : "";
  if (!normalizedUserId) {
    return null;
  }
  const tokens = loadPersistedContextTokens(config, accountId);
  if (!tokens[normalizedUserId]) {
    return null;
  }
  const metadata = loadPersistedContextTokenMetadata(config, accountId);
  const updatedAtMs = Date.parse(metadata[normalizedUserId]?.updatedAt || "");
  if (Number.isFinite(updatedAtMs)) {
    return Math.max(0, Number(nowMs) - updatedAtMs);
  }
  try {
    const stat = fs.statSync(resolveContextTokenPath(config, accountId));
    const mtimeMs = Number(stat?.mtimeMs);
    if (Number.isFinite(mtimeMs)) {
      return Math.max(0, Number(nowMs) - mtimeMs);
    }
  } catch {
    // no legacy timestamp available
  }
  return null;
}

function clearPersistedContextTokens(config, accountId) {
  try {
    const filePath = resolveContextTokenPath(config, accountId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // best effort
  }
  try {
    const metadataPath = resolveContextTokenMetadataPath(config, accountId);
    if (fs.existsSync(metadataPath)) {
      fs.unlinkSync(metadataPath);
    }
  } catch {
    // best effort
  }
}

module.exports = {
  clearPersistedContextTokens,
  getPersistedContextTokenAgeMs,
  loadPersistedContextTokenMetadata,
  loadPersistedContextTokens,
  persistContextToken,
  resolveContextTokenMetadataPath,
  resolveContextTokenPath,
};
