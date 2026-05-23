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
const { StickerDeliveryAuditStore } = require("../core/sticker-delivery-audit-store");
const { resolveWorkspaceOfficePaths } = require("../core/workspace-office-layout");

const execFileAsync = promisify(execFile);
const DEFAULT_PICK_LIMIT = 5;
const MAX_PICK_LIMIT = 20;
const DEFAULT_TAG_LIST_LIMIT = 160;
const MAX_TAG_LIST_LIMIT = 240;
const MAX_STICKER_SAVE_BATCH_SIZE = 10;
const MAX_STICKER_MUTATION_BATCH_SIZE = 50;
const MIN_STICKER_DESC_CHARS = 16;
const STICKER_STATUS_ACTIVE = "active";
const STICKER_STATUS_ARCHIVE = "archive";
const STICKER_STATUS_VALUES = [STICKER_STATUS_ACTIVE, STICKER_STATUS_ARCHIVE];
const SUPPORTED_STICKER_EXTENSIONS = [".gif", ".png", ".jpg", ".jpeg", ".webp"];
const STICKER_TAG_GUIDANCE = "Reuse existing tags when they fit. Otherwise create short new tags; new tags are added to the tag list.";
const STICKER_DESC_GUIDANCE = `Prefer descs of ${MIN_STICKER_DESC_CHARS} or more characters. If readable text exists, append it after the short scene description.`;
const STICKER_DESC_FIELD_DESCRIPTION = `A concrete sticker description. ${STICKER_DESC_GUIDANCE}`;
const STICKER_STATUS_FIELD_DESCRIPTION = "Optional sticker status. active is available for normal picking; archive stays searchable but is not picked by default.";
const STICKER_SEMANTIC_FIELDS = ["meaning", "gesture", "frontstageEffect", "tone", "useWhen", "avoidWhen", "rawContent", "group", "drawer"];
const STICKER_SEARCH_FIELD_WEIGHTS = {
  meaning: 5.0,
  useWhen: 4.2,
  rawContent: 3.4,
  desc: 3.0,
  tags: 2.8,
  gesture: 2.0,
  frontstageEffect: 2.0,
  tone: 1.4,
  pack: 1.0,
};
const STICKER_SEND_PREVIEW_SIZE = 512;
const STICKER_SEND_PREVIEW_TOOL = "/usr/bin/sips";
const STICKER_ANIMATED_GIF_DIRECT_MAX_BYTES = 768 * 1024;
const STICKER_STATIC_PREVIEW_EXTENSIONS = new Set([".gif", ".webp"]);

class StickerService {
  constructor({ config, channelAdapter, sessionStore, channelFileService }) {
    this.config = config;
    this.channelAdapter = channelAdapter;
    this.sessionStore = sessionStore;
    this.channelFileService = channelFileService;
    this.deliveryAuditStore = new StickerDeliveryAuditStore({
      filePath: this.config?.stickerDeliveryAuditFile,
    });
  }

  async listTags({ query = "", limit = DEFAULT_TAG_LIST_LIMIT } = {}) {
    ensureStickerCatalogFilesSync(this.config);
    const normalizedQuery = normalizeText(query).toLowerCase();
    const allTags = loadStickerTagsSync(this.config);
    const normalizedLimit = normalizeTagListLimit(limit);
    const tags = normalizedQuery
      ? allTags.filter((tag) => tag.toLowerCase().includes(normalizedQuery))
      : allTags;
    return {
      tags: tags.slice(0, normalizedLimit),
      totalCount: allTags.length,
      matchedCount: tags.length,
      truncated: tags.length > normalizedLimit,
      guidance: `For sending, prefer semantic sticker_search by mood/scene. Use tags mostly for saving or narrow curation. ${STICKER_TAG_GUIDANCE} ${STICKER_DESC_GUIDANCE}`,
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
        && fs.existsSync(resolveStickerFilePath(this.config, stickerId, value)))
      .slice(-normalizedLimit)
      .reverse()
      .map(([stickerId, value]) => ({
        stickerId,
        desc: normalizeText(value?.desc),
        tags: Array.isArray(value?.tags) ? value.tags : [],
        pack: normalizeText(value?.pack),
        status: normalizeStickerStatus(value?.status, STICKER_STATUS_ACTIVE),
        favorite: Boolean(value?.favorite),
        group: normalizeText(value?.group),
        drawer: normalizeText(value?.drawer),
        ...pickStickerSemanticFields(value),
        assetFile: normalizeStickerAssetFile(value?.assetFile || value?.asset_file),
        mimeType: normalizeText(value?.mimeType || value?.mime_type) || guessStickerMimeType(resolveStickerFilePath(this.config, stickerId, value)),
      }));

    return {
      tag: normalizedTag,
      pack: normalizedPack,
      status: includeArchive ? "any" : normalizedStatus,
      candidates: entries,
    };
  }

  async search({ query = "", limit = DEFAULT_PICK_LIMIT, pack = "", status = STICKER_STATUS_ACTIVE, includeArchive = false } = {}) {
    ensureStickerCatalogFilesSync(this.config);
    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery) {
      throw new Error("Sticker query is required.");
    }
    const normalizedLimit = normalizePickLimit(limit);
    const normalizedPack = normalizeText(pack);
    const normalizedStatus = normalizeStickerStatus(status, STICKER_STATUS_ACTIVE);
    const tokens = tokenizeStickerSearchText(normalizedQuery);
    const index = loadStickerIndexSync(this.config);
    const scored = [];

    for (const [stickerId, value] of Object.entries(index)) {
      if (normalizedPack && normalizeText(value?.pack) !== normalizedPack) {
        continue;
      }
      if (!includeArchive && normalizeStickerStatus(value?.status, STICKER_STATUS_ACTIVE) !== normalizedStatus) {
        continue;
      }
      if (!fs.existsSync(resolveStickerFilePath(this.config, stickerId, value))) {
        continue;
      }
      let score = scoreStickerEntry(value, normalizedQuery, tokens);
      if (Boolean(value?.favorite)) {
        score += 0.25;
      }
      if (score <= 0) {
        continue;
      }
      scored.push([score, stickerId, value]);
    }

    scored.sort((left, right) => right[0] - left[0]);
    return {
      query: normalizedQuery,
      pack: normalizedPack,
      status: includeArchive ? "any" : normalizedStatus,
      candidates: scored.slice(0, normalizedLimit).map(([score, stickerId, value]) => ({
        stickerId,
        desc: normalizeText(value?.desc),
        tags: Array.isArray(value?.tags) ? value.tags : [],
        pack: normalizeText(value?.pack),
        status: normalizeStickerStatus(value?.status, STICKER_STATUS_ACTIVE),
        favorite: Boolean(value?.favorite),
        group: normalizeText(value?.group),
        drawer: normalizeText(value?.drawer),
        ...pickStickerSemanticFields(value),
        assetFile: normalizeStickerAssetFile(value?.assetFile || value?.asset_file),
        mimeType: normalizeText(value?.mimeType || value?.mime_type) || guessStickerMimeType(resolveStickerFilePath(this.config, stickerId, value)),
        score: Number(score.toFixed(4)),
      })),
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
        const filePath = resolveStickerFilePath(this.config, stickerId, value);
        return {
          stickerId,
          tags: Array.isArray(value?.tags) ? value.tags : [],
          desc: normalizeText(value?.desc),
          pack: normalizeText(value?.pack),
          status: normalizeStickerStatus(value?.status, STICKER_STATUS_ACTIVE),
          favorite: Boolean(value?.favorite),
          group: normalizeText(value?.group),
          drawer: normalizeText(value?.drawer),
          source: normalizeText(value?.source),
          sourceId: normalizeText(value?.sourceId),
          ...pickStickerSemanticFields(value),
          assetFile: normalizeStickerAssetFile(value?.assetFile || value?.asset_file),
          mimeType: normalizeText(value?.mimeType || value?.mime_type) || guessStickerMimeType(filePath),
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
    const entry = index[normalizedStickerId];
    if (!entry) {
      throw new Error(`Sticker not found: ${normalizedStickerId}`);
    }
    const filePath = resolveStickerFilePath(this.config, normalizedStickerId, entry);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Sticker file is missing: ${filePath}`);
    }
    const sourceStat = safeFileStat(filePath);
    const deliveryCandidates = await prepareStickerDeliveryCandidates({
      config: this.config,
      stickerId: normalizedStickerId,
      filePath,
    });
    const attemptedDeliveries = [];
    const deliveryAttempts = [];
    let delivery = null;
    let deliveredCandidate = null;
    for (const candidate of deliveryCandidates) {
      const attempt = {
        status: "pending",
        filePath: candidate.filePath,
        transform: candidate.transform,
        mimeType: guessStickerMimeType(candidate.filePath),
        actualMimeType: sniffMimeTypeFromFile(candidate.filePath),
        sizeBytes: safeFileStat(candidate.filePath)?.size,
        delivery: null,
        error: "",
      };
      this.recordDeliveryAudit(buildStickerDeliveryAuditPayload({
        status: "attempting",
        stickerId: normalizedStickerId,
        userId,
        entry,
        sourceFilePath: filePath,
        sourceStat,
        deliveryFilePath: candidate.filePath,
        deliveryStat: safeFileStat(candidate.filePath),
        deliveryTransform: candidate.transform,
        deliveryTransformError: candidate.error,
        deliveryMimeType: attempt.mimeType,
        attempts: [...deliveryAttempts, attempt],
      }));
      try {
        delivery = await this.channelFileService.sendToCurrentChat({
          filePath: candidate.filePath,
          userId,
        }, context);
        attempt.status = "sent";
        attempt.delivery = delivery?.delivery || null;
        deliveryAttempts.push(attempt);
        deliveredCandidate = candidate;
        break;
      } catch (error) {
        attempt.status = "failed";
        attempt.error = error instanceof Error ? error.message : String(error || "unknown error");
        deliveryAttempts.push(attempt);
        this.recordDeliveryAudit(buildStickerDeliveryAuditPayload({
          status: "attempt_failed",
          stickerId: normalizedStickerId,
          userId,
          entry,
          sourceFilePath: filePath,
          sourceStat,
          deliveryFilePath: candidate.filePath,
          deliveryStat: safeFileStat(candidate.filePath),
          deliveryTransform: candidate.transform,
          deliveryTransformError: candidate.error,
          deliveryMimeType: attempt.mimeType,
          attempts: deliveryAttempts,
          error: attempt.error,
        }));
        attemptedDeliveries.push({
          filePath: candidate.filePath,
          transform: candidate.transform,
          error: attempt.error,
        });
      }
    }
    if (!deliveredCandidate) {
      const lastAttempt = attemptedDeliveries.at(-1);
      this.recordDeliveryAudit(buildStickerDeliveryAuditPayload({
        status: "failed",
        stickerId: normalizedStickerId,
        userId,
        entry,
        sourceFilePath: filePath,
        sourceStat,
        attempts: deliveryAttempts,
        error: lastAttempt?.error || "unknown error",
      }));
      throw new Error(`Sticker delivery failed: ${lastAttempt?.error || "unknown error"}`);
    }
    const result = {
      stickerId: normalizedStickerId,
      filePath,
      assetFile: normalizeStickerAssetFile(entry.assetFile || entry.asset_file),
      mimeType: normalizeText(entry.mimeType || entry.mime_type) || guessStickerMimeType(filePath),
      deliveryFilePath: deliveredCandidate.filePath,
      deliveryMimeType: guessStickerMimeType(deliveredCandidate.filePath),
      deliveryTransform: deliveredCandidate.transform,
      deliveryTransformError: deliveredCandidate.error,
      attemptedDeliveries,
      delivery,
    };
    this.recordDeliveryAudit(buildStickerDeliveryAuditPayload({
      status: "sent",
      stickerId: normalizedStickerId,
      userId: normalizeText(delivery?.userId) || userId,
      entry,
      sourceFilePath: filePath,
      sourceStat,
      deliveryFilePath: deliveredCandidate.filePath,
      deliveryStat: safeFileStat(deliveredCandidate.filePath),
      deliveryTransform: deliveredCandidate.transform,
      deliveryTransformError: deliveredCandidate.error,
      deliveryMimeType: result.deliveryMimeType,
      delivery: delivery?.delivery || null,
      attempts: deliveryAttempts,
    }));
    return result;
  }

  recordDeliveryAudit(payload = {}) {
    try {
      return this.deliveryAuditStore?.recordDelivery?.(payload);
    } catch {
      return null;
    }
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
      const filePath = resolveStickerFilePath(this.config, stickerId, index[stickerId]);
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
        meaning: item.meaning ?? normalizeText(previous.meaning),
        gesture: item.gesture ?? normalizeText(previous.gesture),
        frontstageEffect: item.frontstageEffect ?? normalizeText(previous.frontstageEffect || previous.frontstage_effect),
        tone: item.tone ?? normalizeTextList(previous.tone),
        useWhen: item.useWhen ?? normalizeTextList(previous.useWhen || previous.use_when),
        avoidWhen: item.avoidWhen ?? normalizeTextList(previous.avoidWhen || previous.avoid_when),
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
      const merged = mergeStickerTemplateSemantics(currentIndex[stickerId], templateEntry);
      if (!stickerEntriesEqual(currentIndex[stickerId], merged)) {
        currentIndex[stickerId] = merged;
        changed = true;
      }
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
      group: normalizeText(entry?.group),
      drawer: normalizeText(entry?.drawer),
      source: normalizeText(entry?.source),
      sourceId: normalizeText(entry?.sourceId || entry?.source_id),
      meaning: normalizeText(entry?.meaning),
      gesture: normalizeText(entry?.gesture),
      frontstageEffect: normalizeText(entry?.frontstageEffect || entry?.frontstage_effect),
      tone: normalizeTextList(entry?.tone),
      useWhen: normalizeTextList(entry?.useWhen || entry?.use_when),
      avoidWhen: normalizeTextList(entry?.avoidWhen || entry?.avoid_when),
      rawContent: normalizeText(entry?.rawContent || entry?.raw_content),
      assetFile: normalizeStickerAssetFile(entry?.assetFile || entry?.asset_file),
      mimeType: normalizeText(entry?.mimeType || entry?.mime_type),
      sha256: normalizeText(entry?.sha256),
      assetWidth: normalizeNonNegativeInt(entry?.assetWidth || entry?.asset_width),
      assetHeight: normalizeNonNegativeInt(entry?.assetHeight || entry?.asset_height),
      assetSizeBytes: normalizeNonNegativeInt(entry?.assetSizeBytes || entry?.asset_size_bytes),
      assetProcessed: Boolean(entry?.assetProcessed || entry?.asset_processed),
      assetProcessingNotes: normalizeText(entry?.assetProcessingNotes || entry?.asset_processing_notes),
    };
  }
  return normalized;
}

function stickerEntriesEqual(left, right) {
  const normalizedLeft = normalizeStickerIndexPayload({ item: left }).item || { tags: [], desc: "" };
  const normalizedRight = normalizeStickerIndexPayload({ item: right }).item || { tags: [], desc: "" };
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
}

function mergeStickerTemplateSemantics(current, template) {
  const merged = normalizeStickerIndexPayload({ item: current }).item || {};
  const templateEntry = normalizeStickerIndexPayload({ item: template }).item || {};
  merged.tags = mergeStickerTagCatalog(merged.tags, templateEntry.tags);
  for (const field of STICKER_SEMANTIC_FIELDS) {
    const currentValue = merged[field];
    const templateValue = templateEntry[field];
    const currentEmpty = Array.isArray(currentValue)
      ? currentValue.length === 0
      : !normalizeText(currentValue);
    const templateEmpty = Array.isArray(templateValue)
      ? templateValue.length === 0
      : !normalizeText(templateValue);
    if (currentEmpty && !templateEmpty) {
      merged[field] = templateValue;
    }
  }
  return merged;
}

function resolveStickerFilePath(config = {}, stickerId = "", entry = null) {
  const assetFile = normalizeStickerAssetFile(entry?.assetFile || entry?.asset_file);
  if (assetFile) {
    return path.join(buildStickerPaths(config).stickerAssetsDir, assetFile);
  }
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

function normalizeTagListLimit(limit) {
  if (!Number.isInteger(limit)) {
    return DEFAULT_TAG_LIST_LIMIT;
  }
  return Math.max(1, Math.min(MAX_TAG_LIST_LIMIT, limit));
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
  for (const [stickerId, entry] of Object.entries(index)) {
    const filePath = resolveStickerFilePath(config, stickerId, entry);
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
  for (const [stickerId, entry] of Object.entries(index)) {
    if (hashByStickerId.get(stickerId) === targetHash) {
      return {
        stickerId,
        filePath: resolveStickerFilePath(config, stickerId, entry),
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
      meaning: normalizeText(item.meaning),
      gesture: normalizeText(item.gesture),
      frontstageEffect: normalizeText(item.frontstageEffect || item.frontstage_effect),
      tone: normalizeTextList(item.tone),
      useWhen: normalizeTextList(item.useWhen || item.use_when),
      avoidWhen: normalizeTextList(item.avoidWhen || item.avoid_when),
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
      meaning: hasOwn(item, "meaning") ? normalizeText(item.meaning) : undefined,
      gesture: hasOwn(item, "gesture") ? normalizeText(item.gesture) : undefined,
      frontstageEffect: hasOwn(item, "frontstageEffect") || hasOwn(item, "frontstage_effect")
        ? normalizeText(item.frontstageEffect || item.frontstage_effect)
        : undefined,
      tone: hasOwn(item, "tone") ? normalizeTextList(item.tone) : undefined,
      useWhen: hasOwn(item, "useWhen") || hasOwn(item, "use_when")
        ? normalizeTextList(item.useWhen || item.use_when)
        : undefined,
      avoidWhen: hasOwn(item, "avoidWhen") || hasOwn(item, "avoid_when")
        ? normalizeTextList(item.avoidWhen || item.avoid_when)
        : undefined,
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
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mossbridge-sticker-save-"));
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
      meaning: item.meaning,
      gesture: item.gesture,
      frontstageEffect: item.frontstageEffect,
      tone: item.tone,
      useWhen: item.useWhen,
      avoidWhen: item.avoidWhen,
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

async function prepareStickerDeliveryCandidates({ config = {}, stickerId = "", filePath = "" } = {}) {
  const normalizedFilePath = normalizeText(filePath);
  const ext = path.extname(normalizedFilePath).toLowerCase();
  if (!STICKER_STATIC_PREVIEW_EXTENSIONS.has(ext)) {
    return [{
      filePath: normalizedFilePath,
      transform: "none",
      error: "",
    }];
  }

  const candidates = [];
  let previewError = "";

  try {
    const previewPath = await ensureStickerPngPreview({
      config,
      stickerId,
      filePath: normalizedFilePath,
    });
    if (previewPath) {
      candidates.push({
        filePath: previewPath,
        transform: `${ext.slice(1)}_static_png_preview`,
        error: "",
      });
    }
  } catch (error) {
    previewError = error instanceof Error ? error.message : String(error || "unknown error");
  }

  const originalStat = await fsp.stat(normalizedFilePath).catch(() => null);
  if (ext === ".gif" && originalStat?.isFile() && originalStat.size <= STICKER_ANIMATED_GIF_DIRECT_MAX_BYTES) {
    candidates.push({
      filePath: normalizedFilePath,
      transform: "gif_original_small_fallback",
      error: previewError,
    });
  } else {
    candidates.push({
      filePath: normalizedFilePath,
      transform: `${ext.slice(1) || "sticker"}_original_fallback`,
      error: previewError,
    });
  }

  return candidates;
}

async function ensureStickerPngPreview({ config = {}, stickerId = "", filePath = "" } = {}) {
  if (process.platform !== "darwin" || !fs.existsSync(STICKER_SEND_PREVIEW_TOOL)) {
    return "";
  }
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`Sticker file is not a file: ${filePath}`);
  }
  const stickerPaths = buildStickerPaths(config);
  const cacheDir = path.join(stickerPaths.stickersDir || normalizeText(config.stateDir) || os.tmpdir(), "send-cache");
  const cacheKey = [
    normalizeStickerId(stickerId) || "sticker",
    String(stat.size),
    String(Math.floor(stat.mtimeMs)),
  ].join("-");
  const outputPath = path.join(cacheDir, `${cacheKey}.png`);
  if (await fileExistsWithContent(outputPath)) {
    return outputPath;
  }
  await fsp.mkdir(cacheDir, { recursive: true });
  const tempPath = path.join(cacheDir, `${cacheKey}.${process.pid}.${Date.now()}.tmp.png`);
  try {
    await execFileAsync(STICKER_SEND_PREVIEW_TOOL, [
      "-s", "format", "png",
      "-Z", String(STICKER_SEND_PREVIEW_SIZE),
      filePath,
      "--out", tempPath,
    ]);
    if (!await fileExistsWithContent(tempPath)) {
      throw new Error(`Sticker preview conversion produced no output: ${tempPath}`);
    }
    await fsp.rename(tempPath, outputPath).catch(async (error) => {
      if (await fileExistsWithContent(outputPath)) {
        return;
      }
      throw error;
    });
    return outputPath;
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function fileExistsWithContent(filePath = "") {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
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

function normalizeTextList(value) {
  const rawItems = Array.isArray(value) ? value : (typeof value === "string" ? [value] : []);
  const seen = new Set();
  const result = [];
  for (const raw of rawItems) {
    const text = normalizeText(raw);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push(text);
  }
  return result;
}

function pickStickerSemanticFields(value = {}) {
  return {
    meaning: normalizeText(value?.meaning),
    gesture: normalizeText(value?.gesture),
    frontstageEffect: normalizeText(value?.frontstageEffect || value?.frontstage_effect),
    tone: normalizeTextList(value?.tone),
    useWhen: normalizeTextList(value?.useWhen || value?.use_when),
    avoidWhen: normalizeTextList(value?.avoidWhen || value?.avoid_when),
    rawContent: normalizeText(value?.rawContent || value?.raw_content),
  };
}

function scoreStickerEntry(value = {}, query, tokens = []) {
  let score = 0;
  for (const [field, weight] of Object.entries(STICKER_SEARCH_FIELD_WEIGHTS)) {
    const fieldText = stringifyStickerSearchField(field === "tags" ? value.tags : value[field]);
    if (!fieldText) {
      continue;
    }
    const lower = fieldText.toLowerCase();
    if (lower.includes(String(query || "").toLowerCase())) {
      score += weight * 2;
    }
    for (const token of tokens) {
      if (lower.includes(token)) {
        score += weight;
      }
    }
  }
  return score;
}

function stringifyStickerSearchField(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeText(item)).filter(Boolean).join(" ");
  }
  return normalizeText(value);
}

function tokenizeStickerSearchText(text) {
  const normalized = normalizeText(text).toLowerCase();
  const tokens = new Set(
    normalized
      .split(/[^\p{L}\p{N}]+/u)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2)
  );
  const compact = Array.from(normalized.replace(/\s+/g, ""));
  for (let index = 0; index < compact.length - 1; index += 1) {
    const token = `${compact[index]}${compact[index + 1]}`;
    if (/[\p{L}\p{N}]/u.test(token)) {
      tokens.add(token);
    }
  }
  return Array.from(tokens).slice(0, 80);
}

function guessStickerMimeType(filePath = "") {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") {
    return "image/png";
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  if (ext === ".gif") {
    return "image/gif";
  }
  return "application/octet-stream";
}

function buildStickerDeliveryAuditPayload({
  status = "",
  stickerId = "",
  userId = "",
  entry = {},
  sourceFilePath = "",
  sourceStat = null,
  deliveryFilePath = "",
  deliveryStat = null,
  deliveryTransform = "",
  deliveryTransformError = "",
  deliveryMimeType = "",
  delivery = null,
  attempts = [],
  error = "",
} = {}) {
  return {
    status,
    stickerId,
    userId,
    sourceAssetFile: normalizeStickerAssetFile(entry.assetFile || entry.asset_file),
    sourceFilePath,
    sourceMimeType: normalizeText(entry.mimeType || entry.mime_type) || guessStickerMimeType(sourceFilePath),
    sourceActualMimeType: sniffMimeTypeFromFile(sourceFilePath),
    sourceSizeBytes: sourceStat?.size,
    deliveryFilePath,
    deliveryMimeType: normalizeText(deliveryMimeType) || guessStickerMimeType(deliveryFilePath),
    deliveryActualMimeType: sniffMimeTypeFromFile(deliveryFilePath),
    deliverySizeBytes: deliveryStat?.size,
    deliveryTransform,
    deliveryTransformError,
    delivery,
    attempts,
    error,
  };
}

function safeFileStat(filePath = "") {
  const normalizedFilePath = normalizeText(filePath);
  if (!normalizedFilePath) {
    return null;
  }
  try {
    const stat = fs.statSync(normalizedFilePath);
    return stat?.isFile?.() ? stat : null;
  } catch {
    return null;
  }
}

function sniffMimeTypeFromFile(filePath = "") {
  const normalizedFilePath = normalizeText(filePath);
  if (!normalizedFilePath) {
    return "";
  }
  let header = null;
  try {
    const fd = fs.openSync(normalizedFilePath, "r");
    try {
      header = Buffer.alloc(16);
      const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
      header = header.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }
  const ascii = header.toString("ascii", 0, Math.min(header.length, 12));
  if (ascii.startsWith("GIF87a") || ascii.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  return "";
}

function normalizeStickerAssetFile(value) {
  const raw = normalizeText(value);
  if (!raw) {
    return "";
  }
  const name = path.basename(raw);
  const ext = normalizeStickerExtension(path.extname(name));
  if (!ext) {
    return "";
  }
  const stem = normalizeStickerId(path.basename(name, path.extname(name)));
  return stem ? `${stem}${ext}` : "";
}

function normalizeStickerExtension(value) {
  let ext = normalizeText(value).toLowerCase();
  if (ext === ".jpeg") {
    ext = ".jpg";
  }
  return SUPPORTED_STICKER_EXTENSIONS.includes(ext) ? ext : "";
}

function normalizeNonNegativeInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
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
