const fs = require("fs");
const path = require("path");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { loadPersistedContextTokens } = require("../adapters/channel/weixin/context-token-store");
const { resolvePreferredSenderId } = require("../core/default-targets");

const DEFAULT_MAX_SEND_BYTES = 20 * 1024 * 1024;
const DEFAULT_SEND_TIMEOUT_MS = 120_000;

class ChannelFileService {
  constructor({ config, channelAdapter, sessionStore }) {
    this.config = config;
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
  }

  async sendToCurrentChat({ filePath = "", userId = "", forceLargeFile = false } = {}, context = {}) {
    const account = resolveSelectedAccount(this.config);
    const targetUserId = normalizeText(userId)
      || normalizeText(context?.senderId)
      || resolvePreferredSenderId({
        config: this.config,
        accountId: account.accountId,
        sessionStore: this.sessionStore,
      });
    if (!targetUserId) {
      throw new Error("Cannot determine which WeChat user should receive the file.");
    }

    const contextTokens = loadPersistedContextTokens(this.config, account.accountId);
    const contextToken = String(contextTokens[targetUserId] || "").trim();
    if (!contextToken) {
      throw new Error(`Cannot find a context token for user ${targetUserId}. Let this user talk to the bot once first.`);
    }

    const requestedPath = normalizeText(filePath);
    if (!requestedPath) {
      throw new Error("Missing file path to send.");
    }
    const resolvedPath = path.resolve(requestedPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File does not exist: ${resolvedPath}`);
    }
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      throw new Error(`Only files can be sent, not directories: ${resolvedPath}`);
    }
    const sizeBytes = Math.max(0, Number(stat.size) || 0);
    const maxBytes = resolvePositiveInt(this.config?.channelFileMaxBytes, DEFAULT_MAX_SEND_BYTES);
    if (!forceLargeFile && maxBytes > 0 && sizeBytes > maxBytes) {
      throw buildChannelFileError("CHANNEL_FILE_TOO_LARGE", [
        `File is too large for safe WeChat delivery: ${formatBytes(sizeBytes)}.`,
        `Current safe limit is ${formatBytes(maxBytes)}.`,
        "Link it as a case artifact, send a summary/path first, or use an external handoff for the final file.",
      ].join(" "), {
        filePath: resolvedPath,
        sizeBytes,
        maxBytes,
      });
    }
    const timeoutMs = resolvePositiveInt(this.config?.channelFileSendTimeoutMs, DEFAULT_SEND_TIMEOUT_MS);

    await this.channelAdapter.sendTyping({
      userId: targetUserId,
      status: 1,
      contextToken,
    }).catch(() => {});
    let delivery = null;
    try {
      delivery = await withTimeout(this.channelAdapter.sendFile({
        userId: targetUserId,
        filePath: resolvedPath,
        contextToken,
      }), timeoutMs, {
        filePath: resolvedPath,
        sizeBytes,
      });
    } finally {
      await this.channelAdapter.sendTyping({
        userId: targetUserId,
        status: 0,
        contextToken,
      }).catch(() => {});
    }
    return { ok: true, status: "sent", userId: targetUserId, filePath: resolvedPath, sizeBytes, delivery };
  }
}

function withTimeout(promise, timeoutMs, diagnostics = {}) {
  const timeout = Math.max(1, Number(timeoutMs) || DEFAULT_SEND_TIMEOUT_MS);
  let timer = null;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(buildChannelFileError(
        "CHANNEL_FILE_SEND_TIMEOUT",
        `File delivery timed out after ${timeout}ms. Keep the local path/case artifact and use an external handoff if the file is important.`,
        {
          ...diagnostics,
          timeoutMs: timeout,
        },
      ));
    }, timeout);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function buildChannelFileError(code, message, diagnostics = {}) {
  const error = new Error(message);
  error.code = code;
  error.channelFile = sanitizeChannelFileDiagnostics({
    ...diagnostics,
    code,
  });
  return error;
}

function sanitizeChannelFileDiagnostics(value = {}) {
  return {
    code: normalizeText(value.code),
    filePath: normalizeText(value.filePath),
    sizeBytes: normalizeNullableNumber(value.sizeBytes),
    maxBytes: normalizeNullableNumber(value.maxBytes),
    timeoutMs: normalizeNullableNumber(value.timeoutMs),
  };
}

function resolvePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeNullableNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${bytes} B`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { ChannelFileService };
