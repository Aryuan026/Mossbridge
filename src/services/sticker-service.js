const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { loadPersistedContextTokens } = require("../adapters/channel/weixin/context-token-store");
const { resolvePreferredSenderId } = require("../core/default-targets");
const { resolveWorkspaceOfficePaths } = require("../core/workspace-office-layout");

const execFileAsync = promisify(execFile);
const DEFAULT_PICK_LIMIT = 5;
const MAX_PICK_LIMIT = 20;
const MAX_STICKER_SAVE_BATCH_SIZE = 10;
const MAX_STICKER_MUTATION_BATCH_SIZE = 50;
const MIN_STICKER_DESC_CHARS = 16;
const STICKER_STATUS_ACTIVE = "active";
const STICKER_STATUS_ARCHIVE = "archive";
const STICKER_STATUS_VALUES = [STICKER_STATUS_ACTIVE, STICKER_STATUS_ARCHIVE];
const STICKER_TAG_GUIDANCE = "Reuse existing tags when they fit. Otherwise create short new tags; new tags are added to the tag list.";
const STICKER_DESC_GUIDANCE = `Prefer descs of ${MIN_STICKER_DESC_CHARS} or more characters. If readable text exists, append it after the short scene description.`;
const STICKER_DESC_FIELD_DESCRIPTION = `A concrete sticker description. ${STICKER_DESC_GUIDANCE}`;
const STICKER_STATUS_FIELD_DESCRIPTION = "Optional sticker status. active is available for normal picking; archive stays searchable but is not picked by default.";

class StickerService {
  constructor({ config, channelAdapter, sessionStore, channelFileService }) {
    this.config = config;
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.channelFileService = channelFileService;
  }

  async listTags() {
    ensureStickerCatalogFilesSync(this.config);
    return {
      tags: loadStickerTagsSync(this.config),
      guidance: `Choose 1-3 short tags. ${STICKER_TAG_GUIDANCE} Make desc concrete enough to identify the sticker. ${STICKER_DESC_GUIDANCE}`,
    };
  }

  async saveFromInbox({ items = [], userId = "" } = {}, context = {}) {
    ensureStickerCatalogFilesSync(this.config);
    const normalizedItems = normalizeStickerSaveItems(items, this.config);
    const index = loadStickerIndexSync(this.config);
    const tagCatalog = loadStickerTagsSync(this.config);
    const hashByStickerId = buildStickerHashIndex(this.config, index);
    const createdPaths = [];
    const results = [];

    try {
      for (const item of normalizedItems) {
        const saved = await saveStickerEntry({
          config: this.config,
          index,
          tagCatalog,
          hashByStickerId,
          item,
        });
        results.push(saved.result);
        if (saved.createdPath) {
          createdPaths.push(saved.createdPath);
        }
      }

      const createdCount = results.filter((item) => item.created).length;
      if (createdCount > 0) {
        await writeJsonFile(this.config.stickersIndexFile, index);
        await writeJsonFile(this.config.stickerTagsFile, tagCatalog);
        for (const item of results) {
          if (!item.created) {
            continue;
          }
          await this.sendContextText({
            text: buildStickerSavedText(item),
            userId,
            context,
          });
        }
      }

      return {
        results,
        createdCount,
        dedupedCount: results.filter((item) => item.deduped).length,
      };
    } catch (error) {
      await Promise.all(createdPaths.map((filePath) => fsp.rm(filePath, { force: true }).catch(() => {})));
      throw error;
    }
  }

  async pick({ tag = "", limit = DEFAULT_PICK_LIMIT, pack = "", status = STICKER_STATUS_ACTIVE, includeArchive = false } = {}) {
    ensureStickerCatalogFilesSync(this.config);
    const normalizedTag = normalizeText(tag);
    if (!normalizedTag) {
      throw new Error("Sticker tag is required.");
    }
    const normalizedLimit = normalizePickLimit(limit);
    const normalizedPack = normalizeText(pack);
    const normalizedStatus = normalizeStickerStatus(status, STICKER_STATUS_ACTIVE);
    const index = loadStickerIndexSync(this.config);
    const entries = Object.entries(index)
      .filter(([stickerId, value]) => Array.isArray(value?.tags)
        && value.tags.includes(normalizedTag)
        && (!normalizedPack || normalizeText(value?.pack) === normalizedPack)
        && (includeArchive || normalizeStickerStatus(value?.status, STICKER_STATUS_ACTIVE) === normalizedStatus)
        && fs.existsSync(resolveStickerFilePath(this.config, stickerId)))
      .slice(-normalizedLimit)
      .reverse()
      .map(([stickerId, value]) => ({
        stickerId,
        desc: normalizeText(value?.desc),
        tags: Array.isArray(value?.tags) ? value.tags : [],
        pack: normalizeText(value?.pack),
        status: normalizeStickerStatus(value?.status, STICKER_STATUS_ACTIVE),
        favorite: Boolean(value?.favorite),
      }));

    return {
      tag: normalizedTag,
      pack: normalizedPack,
      status: includeArchive ? "any" : normalizedStatus,
      candidates: entries,
    };
  }

  async list({ tag = "", limit = MAX_PICK_LIMIT, includeMissing = false, pack = "", status = "" } = {}) {
    ensureStickerCatalogFilesSync(this.config);
    const normalizedTag = normalizeText(tag);
    const normalizedPack = normalizeText(pack);
    const normalizedStatus = normalizeOptionalStickerStatus(status);
    const normalizedLimit = normalizePickLimit(limit);
    const index = loadStickerIndexSync(this.config);
    const stickers = Object.entries(index)
      .filter(([, value]) => !normalizedTag || (Array.isArray(value?.tags) && value.tags.includes(normalizedTag)))
      .filter(([, value]) => !normalizedPack || normalizeText(value?.pack) === normalizedPack)
      .filter(([, value]) => !normalizedStatus || normalizeStickerStatus(value?.status, STICKER_STATUS_ACTIVE) === normalizedStatus)
      .map(([stickerId, value]) => {
        const filePath = resolveStickerFilePath(this.config, stickerId);
        return {
          stickerId,
          tags: Array.isArray(value?.tags) ? value.tags : [],
          desc: normalizeText(value?.desc),
          pack: normalizeText(value?.pack),
          status: normalizeStickerStatus(value?.status, STICKER_STATUS_ACTIVE),
          favorite: Boolean(value?.favorite),
          source: normalizeText(value?.source),
          sourceId: normalizeText(value?.sourceId),
          filePath,
          hasFile: fs.existsSync(filePath),
        };
      })
      .filter((item) => includeMissing || item.hasFile)
      .slice(-normalizedLimit)
      .reverse();

    return {
      tag: normalizedTag,
      pack: normalizedPack,
      status: normalizedStatus,
      count: stickers.length,
      stickers,
    };
  }

  async sendToCurrentChat({ stickerId = "", userId = "" } = {}, context = {}) {
    ensureStickerCatalogFilesSync(this.config);
    const normalizedStickerId = normalizeStickerId(stickerId);
    if (!normalizedStickerId) {
      throw new Error("Sticker id is required.");
    }
    const index = loadStickerIndexSync(this.config);
    if (!index[normalizedStickerId]) {
      throw new Error(`Sticker not found: ${normalizedStickerId}`);
    }
    const filePath = resolveStickerFilePath(this.config, normalizedStickerId);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Sticker file is missing: ${filePath}`);
    }
    const delivery = await this.channelFileService.sendToCurrentChat({
      filePath,
      userId,
    }, context);
    return {
      stickerId: normalizedStickerId,
      filePath,
      delivery,
    };
  }

  async delete({ items = [] } = {}, context = {}) {
    ensureStickerCatalogFilesSync(this.config);
    const index = loadStickerIndexSync(this.config);
    const normalizedItems = normalizeStickerDeleteItems(items);
    const normalizedStickerIds = normalizedItems.map((item) => item.stickerId);
    for (const stickerId of normalizedStickerIds) {
      if (!index[stickerId]) {
        throw new Error(`Sticker not found: ${stickerId}`);
      }
    }
    const nextIndex = { ...index };
    for (const stickerId of normalizedStickerIds) {
      delete nextIndex[stickerId];
    }
    await writeJsonFile(this.config.stickersIndexFile, nextIndex);

    const results = [];
    for (const stickerId of normalizedStickerIds) {
      const filePath = resolveStickerFilePath(this.config, stickerId);
      await fsp.rm(filePath, { force: true }).catch(() => {});
      results.push({
        stickerId,
        filePath,
        deleted: true,
      });
    }

    await this.sendContextText({
      text: buildStickerDeletedText(normalizedStickerIds),
      context,
    });

    return {
      results,
      deletedCount: results.length,
    };
  }

  async update({ items = [] } = {}) {
    ensureStickerCatalogFilesSync(this.config);
    const index = loadStickerIndexSync(this.config);
    const normalizedItems = normalizeStickerUpdateItems(items);
    for (const item of normalizedItems) {
      if (!index[item.stickerId]) {
        throw new Error(`Sticker not found: ${item.stickerId}`);
      }
    }
    const tagCatalog = loadStickerTagsSync(this.config);
    for (const item of normalizedItems) {
      const previous = index[item.stickerId] || {};
      index[item.stickerId] = {
        tags: item.tags,
        desc: item.desc,
        pack: item.pack ?? normalizeText(previous.pack),
        status: item.status ?? normalizeStickerStatus(previous.status, STICKER_STATUS_ACTIVE),
        favorite: item.favorite ?? Boolean(previous.favorite),
        source: item.source ?? normalizeText(previous.source),
        sourceId: item.sourceId ?? normalizeText(previous.sourceId),
      };
      tagCatalog.splice(0, tagCatalog.length, ...mergeStickerTagCatalog(tagCatalog, item.tags));
    }
    await writeJsonFile(this.config.stickersIndexFile, index);
    await writeJsonFile(this.config.stickerTagsFile, tagCatalog);
    return {
      results: normalizedItems.map((item) => ({
        stickerId: item.stickerId,
        tags: item.tags,
        desc: item.desc,
        updated: true,
      })),
      updatedCount: normalizedItems.length,
    };
  }

  async sendContextText({ text = "", userId = "", context = {} } = {}) {
    const normalizedText = normalizeText(text);
    if (!normalizedText || !this.channelAdapter || typeof this.channelAdapter.sendText !== "function") {
      return false;
    }
    let account = null;
    try {
      account = resolveSelectedAccount(this.config);
    } catch {
      return false;
    }
    const targetUserId = normalizeText(userId)
      || normalizeText(context?.senderId)
      || resolvePreferredSenderId({
        config: this.config,
        accountId: account.accountId,
        sessionStore: this.sessionStore,
      });
    if (!targetUserId) {
      return false;
    }
    const contextTokens = loadPersistedContextTokens(this.config, account.accountId);
    const contextToken = normalizeText(contextTokens[targetUserId]);
    if (!contextToken) {
      return false;
    }
    await this.channelAdapter.sendText({
      userId: targetUserId,
      text: normalizedText,
      contextToken,
      preserveBlock: true,
    }).catch(() => {});
    return true;
  }
}

function buildStickerPaths(config = {}) {
  const stateDir = normalizeText(config.stateDir);
  const officePaths = resolveWorkspaceOfficePaths({ config });
  const stateInboxDir = path.join(stateDir, "inbox");
  const workspaceInboxDir = normalizeText(officePaths.inboxRoot);
  return {
    stateDir,
    inboxDir: stateInboxDir,
    stateInboxDir,
    workspaceInboxDir,
    allowedInboxDirs: Array.from(new Set([stateInboxDir, workspaceInboxDir].map((value) => normalizeText(value)).filter(Boolean))),
    stickersDir: normalizeText(config.stickersDir) || path.join(stateDir, "stickers"),
    stickerAssetsDir: normalizeText(config.stickerAssetsDir) || path.join(stateDir, "stickers", "assets"),
    stickersIndexFile: normalizeText(config.stickersIndexFile) || path.join(stateDir, "stickers", "index.json"),
    stickerTagsFile: normalizeText(config.stickerTagsFile) || path.join(stateDir, "stickers", "tags.json"),
    stickersTemplateDir: normalizeText(config.stickersTemplateDir) || path.resolve(__dirname, "..", "..", "templates", "stickers"),
    stickersTemplateIndexFile: normalizeText(config.stickersTemplateIndexFile) || path.resolve(__dirname, "..", "..", "templates", "stickers", "index.json"),
    stickerTagsTemplateFile: normalizeText(config.stickerTagsTemplateFile) || path.resolve(__dirname, "..", "..", "templates", "stickers", "tags.json"),
  };
}

function ensureStickerCatalogFilesSync(config = {}) {
  const paths = buildStickerPaths(config);
  if (paths.stickersTemplateDir && fs.existsSync(paths.stickersTemplateDir) && !fs.existsSync(paths.stickersDir)) {
    fs.cpSync(paths.stickersTemplateDir, paths.stickersDir, { recursive: true });
  }
  fs.mkdirSync(paths.stickerAssetsDir, { recursive: true });
  const templateIndex = normalizeStickerIndexPayload(loadJsonFileSync(paths.stickersTemplateIndexFile, {}));
  if (!fs.existsSync(paths.stickersIndexFile)) {
    writeJsonFileSync(paths.stickersIndexFile, templateIndex);
  } else {
    mergeStickerTemplateIndexSync(paths, templateIndex);
  }
  copyTemplateStickerAssetsSync(paths, templateIndex);
  if (!fs.existsSync(paths.stickerTagsFile)) {
    const templateTags = loadStickerTagsTemplateSync(config);
    writeJsonFileSync(paths.stickerTagsFile, templateTags);
  } else {
    mergeStickerTemplateTagsSync(paths, loadStickerTagsTemplateSync(config));
  }
}

function loadStickerIndexSync(config = {}) {
  ensureStickerCatalogFilesSync(config);
  try {
    const raw = fs.readFileSync(buildStickerPaths(config).stickersIndexFile, "utf8");
    return normalizeStickerIndexPayload(JSON.parse(raw));
  } catch {
    return {};
  }
}

function loadStickerTagsSync(config = {}) {
  ensureStickerCatalogFilesSync(config);
  try {
    const raw = fs.readFileSync(buildStickerPaths(config).stickerTagsFile, "utf8");
    const parsed = JSON.parse(raw);
    const normalized = Array.isArray(parsed)
      ? Array.from(new Set(parsed.map((value) => normalizeText(value)).filter(Boolean)))
      : [];
    return normalized.length ? normalized : loadStickerTagsTemplateSync(config);
  } catch {
    return loadStickerTagsTemplateSync(config);
  }
}

function loadStickerTagsTemplateSync(config = {}) {
  const templatePath = buildStickerPaths(config).stickerTagsTemplateFile;
  return loadStickerTagsFileSync(templatePath);
}

function loadStickerTagsFileSync(filePath = "") {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? Array.from(new Set(parsed.map((value) => normalizeText(value)).filter(Boolean)))
      : [];
  } catch {
    return [];
  }
}

function mergeStickerTemplateIndexSync(paths, templateIndex = {}) {
  if (!Object.keys(templateIndex).length) {
    return;
  }
  const currentIndex = normalizeStickerIndexPayload(loadJsonFileSync(paths.stickersIndexFile, {}));
  let changed = false;
  for (const [stickerId, templateEntry] of Object.entries(templateIndex)) {
    if (currentIndex[stickerId]) {
      continue;
    }
    currentIndex[stickerId] = templateEntry;
    changed = true;
  }
  if (changed) {
    writeJsonFileSync(paths.stickersIndexFile, currentIndex);
  }
}

function copyTemplateStickerAssetsSync(paths, templateIndex = {}) {
  if (!paths.stickersTemplateDir || !fs.existsSync(paths.stickersTemplateDir)) {
    return;
  }
  const currentIndex = normalizeStickerIndexPayload(loadJsonFileSync(paths.stickersIndexFile, {}));
  const templateAssetDir = path.join(paths.stickersTemplateDir, "assets");
  if (!fs.existsSync(templateAssetDir)) {
    return;
  }
  fs.mkdirSync(paths.stickerAssetsDir, { recursive: true });
  for (const [stickerId, templateEntry] of Object.entries(templateIndex)) {
    const sourcePath = path.join(templateAssetDir, `${stickerId}.gif`);
    const targetPath = path.join(paths.stickerAssetsDir, `${stickerId}.gif`);
    if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) {
      continue;
    }
    if (!stickerEntriesEqual(currentIndex[stickerId], templateEntry)) {
      continue;
    }
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function mergeStickerTemplateTagsSync(paths, templateTags = []) {
  const currentTags = loadStickerTagsFileSync(paths.stickerTagsFile);
  const nextTags = mergeStickerTagCatalog(currentTags, templateTags);
  if (nextTags.length !== currentTags.length) {
    writeJsonFileSync(paths.stickerTagsFile, nextTags);
  }
}

function normalizeStickerIndexPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const normalized = {};
  for (const [stickerId, entry] of Object.entries(value)) {
    const normalizedStickerId = normalizeStickerId(stickerId);
    if (!normalizedStickerId) {
      continue;
    }
    normalized[normalizedStickerId] = {
      tags: Array.isArray(entry?.tags)
        ? Array.from(new Set(entry.tags.map((item) => normalizeText(item)).filter(Boolean)))
        : [],
      desc: normalizeText(entry?.desc),
      pack: normalizeText(entry?.pack),
      status: normalizeStickerStatus(entry?.status, STICKER_STATUS_ACTIVE),
      favorite: Boolean(entry?.favorite),
      source: normalizeText(entry?.source),
      sourceId: normalizeText(entry?.sourceId),
    };
  }
  return normalized;
}

function stickerEntriesEqual(left, right) {
  const normalizedLeft = normalizeStickerIndexPayload({ item: left }).item || { tags: [], desc: "" };
  const normalizedRight = normalizeStickerIndexPayload({ item: right }).item || { tags: [], desc: "" };
  return normalizedLeft.desc === normalizedRight.desc
    && normalizedLeft.tags.length === normalizedRight.tags.length
    && normalizedLeft.tags.every((tag, index) => tag === normalizedRight.tags[index]);
}

function resolveStickerFilePath(config = {}, stickerId = "") {
  return path.join(buildStickerPaths(config).stickerAssetsDir, `${normalizeStickerId(stickerId)}.gif`);
}

function normalizeStickerTags(tags) {
  if (!Array.isArray(tags)) {
    throw new Error("Sticker tags must be an array.");
  }
  const normalized = Array.from(new Set(tags.map((value) => normalizeText(value)).filter(Boolean)));
  if (normalized.length < 1 || normalized.length > 3) {
    throw new Error("Sticker tags must contain 1 to 3 labels.");
  }
  return normalized;
}

function normalizeStickerDesc(desc) {
  const normalized = normalizeText(desc);
  if (!normalized) {
    throw new Error("Sticker description is required.");
  }
  return normalized;
}

function normalizeStickerStatus(status, fallback = STICKER_STATUS_ACTIVE) {
  const normalized = normalizeText(status).toLowerCase();
  if (STICKER_STATUS_VALUES.includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeOptionalStickerStatus(status) {
  const normalized = normalizeText(status);
  return normalized ? normalizeStickerStatus(normalized, STICKER_STATUS_ACTIVE) : "";
}

function normalizePickLimit(limit) {
  if (!Number.isInteger(limit)) {
    return DEFAULT_PICK_LIMIT;
  }
  return Math.max(1, Math.min(MAX_PICK_LIMIT, limit));
}

function allocateNextStickerId(index = {}) {
  const max = Object.keys(index)
    .map((key) => {
      const match = key.match(/^stk_(\d+)$/i);
      return match ? Number.parseInt(match[1], 10) : 0;
    })
    .reduce((current, value) => Math.max(current, value), 0);
  return `stk_${String(max + 1).padStart(3, "0")}`;
}

function buildStickerHashIndex(config = {}, index = {}) {
  const hashByStickerId = new Map();
  for (const stickerId of Object.keys(index)) {
    const filePath = resolveStickerFilePath(config, stickerId);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    try {
      hashByStickerId.set(stickerId, computeBufferHash(fs.readFileSync(filePath)));
    } catch {
      // Ignore unreadable sticker files during duplicate checks.
    }
  }
  return hashByStickerId;
}

function findDuplicateStickerByHash(config = {}, index = {}, hashByStickerId = new Map(), targetHash = "") {
  for (const stickerId of Object.keys(index)) {
    if (hashByStickerId.get(stickerId) === targetHash) {
      return {
        stickerId,
        filePath: resolveStickerFilePath(config, stickerId),
      };
    }
  }
  return null;
}

function computeBufferHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function normalizeStickerGif({ inputPath, outputPath, scriptPath }) {
  const rawScriptPath = normalizeText(scriptPath);
  if (!rawScriptPath) {
    throw new Error("Sticker gif normalization script path is required.");
  }
  const normalizedScriptPath = path.resolve(rawScriptPath);
  if (!fs.existsSync(normalizedScriptPath)) {
    throw new Error(`Sticker gif normalization script not found: ${normalizedScriptPath}`);
  }
  try {
    await execFileAsync(process.execPath, [
      normalizedScriptPath,
      "--input", path.resolve(inputPath),
      "--output", path.resolve(outputPath),
      "--size", "240",
    ]);
  } catch (error) {
    const stderr = normalizeText(error?.stderr);
    const stdout = normalizeText(error?.stdout);
    const message = stderr || stdout || (error instanceof Error ? error.message : String(error || "unknown error"));
    throw new Error(`Sticker GIF normalization failed: ${message}`);
  }
}

function buildStickerSavedText({ stickerId, tags, desc }) {
  return [
    "Sticker saved",
    `ID: ${stickerId}`,
    `Tags: ${(Array.isArray(tags) ? tags : []).join(", ")}`,
    `Description: ${normalizeText(desc)}`,
    "If this sticker was saved by mistake, ask to delete it.",
  ].join("\n");
}

function normalizeStickerSaveItems(items, config = {}) {
  if (!Array.isArray(items)) {
    throw new Error("Sticker save items must be an array.");
  }
  if (!items.length) {
    throw new Error("Sticker save items cannot be empty.");
  }
  if (items.length > MAX_STICKER_SAVE_BATCH_SIZE) {
    throw new Error(`Sticker save batch size must be ${MAX_STICKER_SAVE_BATCH_SIZE} or less.`);
  }
  return items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Sticker save item must be an object: ${index}`);
    }
    return {
      filePath: resolveStickerInboxFilePath(config, item.filePath),
      tags: normalizeStickerTags(item.tags),
      desc: normalizeStickerDesc(item.desc),
      pack: normalizeText(item.pack),
      status: normalizeStickerStatus(item.status, STICKER_STATUS_ACTIVE),
      favorite: Boolean(item.favorite),
      source: normalizeText(item.source),
      sourceId: normalizeText(item.sourceId),
    };
  });
}

function normalizeStickerUpdateItems(items) {
  if (!Array.isArray(items)) {
    throw new Error("Sticker update items must be an array.");
  }
  if (!items.length) {
    throw new Error("Sticker update items cannot be empty.");
  }
  if (items.length > MAX_STICKER_MUTATION_BATCH_SIZE) {
    throw new Error(`Sticker update batch size must be ${MAX_STICKER_MUTATION_BATCH_SIZE} or less.`);
  }
  const seen = new Set();
  return items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Sticker update item must be an object: ${index}`);
    }
    const stickerId = normalizeStickerId(item.stickerId);
    if (!stickerId) {
      throw new Error("Sticker id is required.");
    }
    if (seen.has(stickerId)) {
      throw new Error(`Duplicate sticker id in update batch: ${stickerId}`);
    }
    seen.add(stickerId);
    return {
      stickerId,
      tags: normalizeStickerTags(item.tags),
      desc: normalizeStickerDesc(item.desc),
      pack: hasOwn(item, "pack") ? normalizeText(item.pack) : undefined,
      status: hasOwn(item, "status") ? normalizeStickerStatus(item.status, STICKER_STATUS_ACTIVE) : undefined,
      favorite: hasOwn(item, "favorite") ? Boolean(item.favorite) : undefined,
      source: hasOwn(item, "source") ? normalizeText(item.source) : undefined,
      sourceId: hasOwn(item, "sourceId") ? normalizeText(item.sourceId) : undefined,
    };
  });
}

function normalizeStickerDeleteItems(items) {
  if (!Array.isArray(items)) {
    throw new Error("Sticker delete items must be an array.");
  }
  if (!items.length) {
    throw new Error("Sticker delete items cannot be empty.");
  }
  if (items.length > MAX_STICKER_MUTATION_BATCH_SIZE) {
    throw new Error(`Sticker delete batch size must be ${MAX_STICKER_MUTATION_BATCH_SIZE} or less.`);
  }
  const seen = new Set();
  const normalized = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Sticker delete item must be an object: ${index}`);
    }
    const stickerId = normalizeStickerId(item.stickerId);
    if (!stickerId) {
      throw new Error("Sticker id is required.");
    }
    if (seen.has(stickerId)) {
      continue;
    }
    seen.add(stickerId);
    normalized.push({ stickerId });
  }
  return normalized;
}

function resolveStickerInboxFilePath(config = {}, filePath = "") {
  const normalizedInput = normalizeText(filePath);
  if (!normalizedInput) {
    throw new Error("Missing sticker inbox file path.");
  }
  const resolvedInputPath = path.resolve(normalizedInput);
  if (!fs.existsSync(resolvedInputPath)) {
    throw new Error(`Sticker inbox file does not exist: ${resolvedInputPath}`);
  }
  const paths = buildStickerPaths(config);
  const allowedInboxDirs = paths.allowedInboxDirs.length ? paths.allowedInboxDirs : [paths.inboxDir].filter(Boolean);
  if (!allowedInboxDirs.some((allowedDir) => isUnderDirectory(resolvedInputPath, allowedDir))) {
    throw new Error(`Sticker inbox file must be under one of: ${allowedInboxDirs.join(", ")}`);
  }
  const stat = fs.statSync(resolvedInputPath);
  if (!stat.isFile()) {
    throw new Error(`Sticker inbox file must be a file: ${resolvedInputPath}`);
  }
  return resolvedInputPath;
}

function mergeStickerTagCatalog(currentTags = [], incomingTags = []) {
  const base = Array.isArray(currentTags)
    ? currentTags.map((value) => normalizeText(value)).filter(Boolean)
    : [];
  const extra = Array.isArray(incomingTags)
    ? incomingTags.map((value) => normalizeText(value)).filter(Boolean)
    : [];
  return Array.from(new Set([...base, ...extra]));
}

async function saveStickerEntry({
  config = {},
  index = {},
  tagCatalog = [],
  hashByStickerId = new Map(),
  item = {},
} = {}) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "asheriebridge-sticker-save-"));
  const normalizedGifPath = path.join(tempDir, "normalized.gif");
  try {
    await normalizeStickerGif({
      inputPath: item.filePath,
      outputPath: normalizedGifPath,
      scriptPath: config.stickerNormalizeGifScript,
    });
    const normalizedBuffer = await fsp.readFile(normalizedGifPath);
    const normalizedHash = computeBufferHash(normalizedBuffer);
    const duplicate = findDuplicateStickerByHash(config, index, hashByStickerId, normalizedHash);
    if (duplicate) {
      return {
        result: {
          stickerId: duplicate.stickerId,
          filePath: duplicate.filePath,
          created: false,
          deduped: true,
          tags: index[duplicate.stickerId]?.tags || [],
          desc: index[duplicate.stickerId]?.desc || "",
        },
        createdPath: "",
      };
    }

    const stickerId = allocateNextStickerId(index);
    const stickerPath = resolveStickerFilePath(config, stickerId);
    await fsp.mkdir(path.dirname(stickerPath), { recursive: true });
    await fsp.copyFile(normalizedGifPath, stickerPath);
    index[stickerId] = {
      tags: item.tags,
      desc: item.desc,
      pack: item.pack,
      status: item.status,
      favorite: item.favorite,
      source: item.source,
      sourceId: item.sourceId,
    };
    hashByStickerId.set(stickerId, normalizedHash);
    tagCatalog.splice(0, tagCatalog.length, ...mergeStickerTagCatalog(tagCatalog, item.tags));
    return {
      result: {
        stickerId,
        filePath: stickerPath,
        created: true,
        deduped: false,
        tags: item.tags,
        desc: item.desc,
        pack: item.pack,
        status: item.status,
        favorite: item.favorite,
        source: item.source,
        sourceId: item.sourceId,
      },
      createdPath: stickerPath,
    };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function buildStickerDeletedText(stickerIds) {
  const normalizedIds = Array.isArray(stickerIds)
    ? stickerIds.map((value) => normalizeStickerId(value)).filter(Boolean)
    : [normalizeStickerId(stickerIds)].filter(Boolean);
  return [
    "Sticker deleted",
    `ID: ${normalizedIds.join(", ")}`,
  ].join("\n");
}

function loadJsonFileSync(filePath = "", fallback = null) {
  if (!filePath || !fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeStickerId(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isUnderDirectory(filePath, parentDir) {
  const normalizedParentDir = path.resolve(parentDir);
  const normalizedFilePath = path.resolve(filePath);
  return normalizedFilePath === normalizedParentDir || normalizedFilePath.startsWith(`${normalizedParentDir}${path.sep}`);
}

async function writeJsonFile(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonFileSync(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

module.exports = {
  DEFAULT_PICK_LIMIT,
  MIN_STICKER_DESC_CHARS,
  STICKER_TAG_GUIDANCE,
  STICKER_DESC_GUIDANCE,
  STICKER_DESC_FIELD_DESCRIPTION,
  STICKER_STATUS_ACTIVE,
  STICKER_STATUS_ARCHIVE,
  STICKER_STATUS_FIELD_DESCRIPTION,
  StickerService,
  allocateNextStickerId,
  buildStickerPaths,
  ensureStickerCatalogFilesSync,
  loadStickerTagsTemplateSync,
  loadStickerTagsSync,
  loadStickerIndexSync,
  normalizeStickerGif,
  resolveStickerFilePath,
};
