#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const {
  allocateNextStickerId,
  ensureStickerCatalogFilesSync,
  loadStickerIndexSync,
  loadStickerTagsSync,
  normalizeStickerGif,
  resolveStickerFilePath,
} = require("../src/services/sticker-service");

const SERIES_TAG = "小萝卜";
const DEFAULT_STATE_DIR = path.join(os.homedir(), ".mossbridge");
const DEFAULT_IMPORT_STATUS = "archive";
const IMPORT_STATUS_VALUES = ["active", "archive"];

async function main() {
  const args = process.argv.slice(2);
  const manifestPath = readFlag(args, "--manifest");
  const metadataPath = readFlag(args, "--metadata") || readFlag(args, "--talkmaker-metadata");
  const imagesDir = readFlag(args, "--images");
  const stateDir = readFlag(args, "--state-dir") || process.env.MOSSBRIDGE_STATE_DIR || DEFAULT_STATE_DIR;
  const dataRoot = readFlag(args, "--data-root") || process.env.MOSSBRIDGE_DATA_ROOT || "";
  const stickersDir = readFlag(args, "--stickers-dir") || process.env.MOSSBRIDGE_STICKERS_DIR || "";
  const pack = readFlag(args, "--pack") || (metadataPath ? SERIES_TAG : "");
  const statusFlag = readFlag(args, "--status");
  const status = statusFlag ? normalizeImportStatus(statusFlag) : "";
  const source = readFlag(args, "--source") || (metadataPath ? "talkmaker" : "manifest");
  const dryRun = hasFlag(args, "--dry-run");

  if (!manifestPath && (!metadataPath || !imagesDir)) {
    throw new Error("Usage: import-talkmaker-emojis.js (--manifest <stickers.json> [--images <dir>] | --metadata <emojis_metadata.json> --images <dir>) [--pack <name>] [--status active|archive] [--state-dir <dir>] [--dry-run]");
  }

  const config = buildConfig({ stateDir, dataRoot, stickersDir });
  const entries = manifestPath
    ? loadStickerManifest({ manifestPath, imagesDir, defaultPack: pack, defaultStatus: status, defaultSource: source })
    : loadTalkmakerMetadata({ metadataPath, imagesDir, defaultPack: pack, defaultStatus: status || DEFAULT_IMPORT_STATUS, defaultSource: source });
  const planned = entries.map((entry) => planStickerEntry(entry));

  if (dryRun) {
    printPlan({ planned, stateDir });
    return;
  }

  const result = await importStickers({ config, planned });
  console.log(`Imported stickers: created=${result.createdCount}, deduped=${result.dedupedCount}, total=${result.results.length}`);
  for (const item of result.results) {
    const marker = item.created ? "created" : "deduped";
    console.log(`${marker} ${item.stickerId} ${item.sourceId} pack=${item.pack || "(none)"} status=${item.status || "(existing)"} tags=${item.tags.join(",")} desc=${item.desc}`);
  }
}

function buildConfig({ stateDir, dataRoot = "", stickersDir = "" }) {
  const repoRoot = path.resolve(__dirname, "..");
  const resolvedStickersDir = stickersDir
    ? path.resolve(stickersDir)
    : (dataRoot ? path.join(path.resolve(dataRoot), "storage", "stickers") : path.join(stateDir, "stickers"));
  return {
    stateDir,
    stickersDir: resolvedStickersDir,
    stickerAssetsDir: path.join(resolvedStickersDir, "assets"),
    stickersIndexFile: path.join(resolvedStickersDir, "index.json"),
    stickerTagsFile: path.join(resolvedStickersDir, "tags.json"),
    stickersTemplateDir: path.join(repoRoot, "templates", "stickers"),
    stickersTemplateIndexFile: path.join(repoRoot, "templates", "stickers", "index.json"),
    stickerTagsTemplateFile: path.join(repoRoot, "templates", "stickers", "tags.json"),
    stickerNormalizeGifScript: path.join(repoRoot, "scripts", "normalize-sticker-gif.js"),
  };
}

function loadTalkmakerMetadata({
  metadataPath,
  imagesDir,
  defaultPack = SERIES_TAG,
  defaultStatus = DEFAULT_IMPORT_STATUS,
  defaultSource = "talkmaker",
}) {
  const resolvedMetadataPath = path.resolve(metadataPath);
  const resolvedImagesDir = path.resolve(imagesDir);
  const parsed = JSON.parse(fs.readFileSync(resolvedMetadataPath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("Talkmaker metadata must be a JSON array.");
  }
  return parsed
    .map((item, index) => normalizeTalkmakerEntry({
      item,
      index,
      imagesDir: resolvedImagesDir,
      defaultPack,
      defaultStatus,
      defaultSource,
    }))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId, "en", { numeric: true }));
}

function normalizeTalkmakerEntry({ item, index, imagesDir, defaultPack = SERIES_TAG, defaultStatus = DEFAULT_IMPORT_STATUS, defaultSource = "talkmaker" }) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`Metadata item must be an object: ${index}`);
  }
  const sourceId = normalizeText(item.id) || `talkmaker-${String(index + 1).padStart(4, "0")}`;
  const meaning = normalizeText(item.meaning);
  const rawContent = normalizeText(item.rawContent).replace(/^<raw>/i, "").trim();
  const fileName = normalizeText(item.fileName);
  if (!meaning || !fileName) {
    throw new Error(`Metadata item is missing meaning or fileName: ${sourceId}`);
  }
  const filePath = path.resolve(imagesDir, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Image file does not exist for ${sourceId}: ${filePath}`);
  }
  return {
    sourceId,
    source: defaultSource,
    pack: defaultPack,
    status: normalizeImportStatus(defaultStatus),
    favorite: false,
    meaning,
    rawContent,
    fileName,
    filePath,
  };
}

function loadStickerManifest({ manifestPath, imagesDir = "", defaultPack = "", defaultStatus = "", defaultSource = "manifest" }) {
  const resolvedManifestPath = path.resolve(manifestPath);
  const manifestDir = path.dirname(resolvedManifestPath);
  const parsed = loadJsonOrJsonl(resolvedManifestPath);
  const manifestDefaults = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : {};
  const items = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(items)) {
    throw new Error("Sticker manifest must be a JSON array, JSONL file, or an object with an items array.");
  }
  const resolvedImagesDir = imagesDir ? path.resolve(imagesDir) : manifestDir;
  const resolvedPack = normalizeText(defaultPack) || normalizeText(manifestDefaults.pack);
  const resolvedStatus = normalizeImportStatus(defaultStatus || manifestDefaults.status || DEFAULT_IMPORT_STATUS);
  const resolvedSource = normalizeText(defaultSource) || normalizeText(manifestDefaults.source) || "manifest";
  return items
    .map((item, index) => normalizeManifestEntry({
      item,
      index,
      imagesDir: resolvedImagesDir,
      manifestDir,
      defaultPack: resolvedPack,
      defaultStatus: resolvedStatus,
      defaultSource: resolvedSource,
    }))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId, "en", { numeric: true }));
}

function normalizeManifestEntry({
  item,
  index,
  imagesDir,
  manifestDir,
  defaultPack = "",
  defaultStatus = DEFAULT_IMPORT_STATUS,
  defaultSource = "manifest",
}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`Manifest item must be an object: ${index}`);
  }
  const sourceId = normalizeText(item.sourceId) || normalizeText(item.id) || `manifest-${String(index + 1).padStart(4, "0")}`;
  const meaning = normalizeText(item.meaning) || normalizeText(item.title);
  const rawContent = normalizeText(item.rawContent) || normalizeText(item.raw) || normalizeText(item.description);
  const fileName = normalizeText(item.fileName) || normalizeText(item.filename);
  const filePath = resolveManifestFilePath({
    filePath: normalizeText(item.filePath) || normalizeText(item.path),
    fileName,
    imagesDir,
    manifestDir,
    sourceId,
  });
  return {
    sourceId,
    source: normalizeText(item.source) || defaultSource,
    pack: normalizeText(item.pack) || defaultPack,
    status: normalizeImportStatus(item.status || defaultStatus),
    favorite: Boolean(item.favorite),
    meaning,
    rawContent,
    fileName: fileName || path.basename(filePath),
    filePath,
    tags: Array.isArray(item.tags) ? item.tags : [],
    desc: normalizeText(item.desc),
  };
}

function resolveManifestFilePath({ filePath = "", fileName = "", imagesDir = "", manifestDir = "", sourceId = "" }) {
  const candidate = filePath
    ? (path.isAbsolute(filePath) ? filePath : path.resolve(manifestDir, filePath))
    : path.resolve(imagesDir || manifestDir, fileName);
  if (!fileName && !filePath) {
    throw new Error(`Manifest item is missing filePath or fileName: ${sourceId}`);
  }
  if (!fs.existsSync(candidate)) {
    throw new Error(`Image file does not exist for ${sourceId}: ${candidate}`);
  }
  return candidate;
}

function loadJsonOrJsonl(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  if (path.extname(filePath).toLowerCase() === ".jsonl") {
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  return JSON.parse(raw);
}

function planStickerEntry(entry) {
  const pack = normalizeText(entry.pack);
  const tags = Array.isArray(entry.tags) && entry.tags.length
    ? normalizeImportTags(entry.tags, pack)
    : tagsForMeaning(entry.meaning, pack);
  return {
    ...entry,
    pack,
    status: normalizeImportStatus(entry.status || DEFAULT_IMPORT_STATUS),
    source: normalizeText(entry.source),
    sourceId: normalizeText(entry.sourceId),
    favorite: Boolean(entry.favorite),
    tags,
    desc: normalizeText(entry.desc) || buildStickerDesc(entry),
  };
}

function tagsForMeaning(meaning, pack = SERIES_TAG) {
  const normalized = normalizeText(meaning);
  const mapping = [
    [/挑衅|得意/, ["得意", "挑衅"]],
    [/再见/, ["再见", "可爱"]],
    [/头晕/, ["头晕", "难受"]],
    [/委屈哭泣/, ["委屈", "想哭"]],
    [/打哈欠/, ["困", "打哈欠"]],
    [/拜托/, ["拜托", "害羞"]],
    [/说话/, ["说话", "提醒"]],
    [/比心点赞/, ["比心", "点赞"]],
    [/开心跳跃/, ["开心", "耶"]],
    [/点赞/, ["点赞", "赞同"]],
    [/偷看/, ["偷看", "期待"]],
    [/震惊/, ["震惊", "冷汗"]],
    [/一脚踹开/, ["拒绝", "暴躁"]],
    [/一起玩/, ["一起玩", "可爱"]],
    [/累趴/, ["累", "躺平"]],
    [/放屁/, ["调皮", "无语"]],
    [/搞破坏/, ["调皮", "搞破坏"]],
    [/比心飞吻/, ["比心", "亲亲"]],
    [/疑惑/, ["疑惑", "问号"]],
    [/大哭/, ["大哭", "想哭"]],
    [/活泼可爱/, ["可爱", "开心"]],
    [/委屈/, ["委屈", "难过"]],
    [/偷笑/, ["偷笑", "可爱"]],
    [/敬礼/, ["收到", "敬礼"]],
    [/期待/, ["期待", "害羞"]],
    [/开心跑来/, ["开心", "跑来"]],
    [/好热/, ["流汗", "好热"]],
    [/好啊|没问题/, ["OK", "赞同"]],
    [/拒绝/, ["拒绝", "No"]],
    [/亲亲/, ["亲亲", "撒娇"]],
    [/看电视/, ["摸鱼", "看戏"]],
    [/好耶/, ["开心", "耶"]],
    [/害羞/, ["害羞", "撒娇"]],
    [/怒火中烧/, ["生气", "暴躁"]],
    [/秀肌肉/, ["鼓励", "加油"]],
    [/心动/, ["心动", "爱心"]],
    [/郁闷/, ["郁闷", "无奈"]],
    [/无语/, ["无语", "郁闷"]],
    [/生气/, ["生气", "暴躁"]],
  ];
  const matched = mapping.find(([pattern]) => pattern.test(normalized));
  const semanticTags = matched ? matched[1] : [normalized || "可爱"];
  return unique([pack, ...semanticTags]).slice(0, 3);
}

function buildStickerDesc(entry) {
  const pack = normalizeText(entry.pack) || SERIES_TAG;
  const meaning = normalizeText(entry.meaning);
  const raw = compactRawContent(entry.rawContent);
  return `${pack}${meaning ? meaning : "表情"}：${raw}`;
}

function compactRawContent(rawContent) {
  const normalized = normalizeText(rawContent).replace(/\s+/g, " ");
  if (!normalized) {
    return "表情包。";
  }
  const withoutFiller = normalized
    .replace(/生气雪情绪/g, "生气情绪")
    .replace(/胡晕/g, "胡萝卜")
    .replace(/^一[个张]卡通(?:风格|化)?(?:的)?/, "")
    .replace(/^一[个张]/, "");
  return limitText(withoutFiller, 110);
}

function limitText(text, maxLength) {
  const normalized = normalizeText(text);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

async function importStickers({ config, planned }) {
  ensureStickerCatalogFilesSync(config);
  const index = loadStickerIndexSync(config);
  const tagCatalog = loadStickerTagsSync(config);
  const hashByStickerId = buildExistingHashIndex({ config, index });
  const results = [];

  for (const item of planned) {
    const imported = await importOneSticker({ config, index, hashByStickerId, item });
    results.push(imported);
    tagCatalog.splice(0, tagCatalog.length, ...unique([...tagCatalog, ...item.tags]));
  }

  await writeJsonFile(config.stickersIndexFile, index);
  await writeJsonFile(config.stickerTagsFile, tagCatalog);
  return {
    results,
    createdCount: results.filter((item) => item.created).length,
    dedupedCount: results.filter((item) => item.deduped).length,
  };
}

async function importOneSticker({ config, index, hashByStickerId, item }) {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mossbridge-talkmaker-"));
  const normalizedGifPath = path.join(tempDir, "normalized.gif");
  try {
    await normalizeStickerGif({
      inputPath: item.filePath,
      outputPath: normalizedGifPath,
      scriptPath: config.stickerNormalizeGifScript,
    });
    const normalizedBuffer = await fsp.readFile(normalizedGifPath);
    const normalizedHash = computeBufferHash(normalizedBuffer);
    const duplicateStickerId = findDuplicateStickerId(hashByStickerId, normalizedHash);
    if (duplicateStickerId) {
      return {
        sourceId: item.sourceId,
        source: item.source,
        stickerId: duplicateStickerId,
        created: false,
        deduped: true,
        tags: index[duplicateStickerId]?.tags || [],
        desc: index[duplicateStickerId]?.desc || "",
        pack: index[duplicateStickerId]?.pack || "",
        status: index[duplicateStickerId]?.status || "",
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
    return {
      sourceId: item.sourceId,
      stickerId,
      created: true,
      deduped: false,
      tags: item.tags,
      desc: item.desc,
      pack: item.pack,
      status: item.status,
      favorite: item.favorite,
      source: item.source,
    };
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function buildExistingHashIndex({ config, index }) {
  const hashByStickerId = new Map();
  for (const stickerId of Object.keys(index)) {
    const filePath = resolveStickerFilePath(config, stickerId);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    try {
      hashByStickerId.set(stickerId, computeBufferHash(fs.readFileSync(filePath)));
    } catch {
      // Ignore unreadable stickers during duplicate checks.
    }
  }
  return hashByStickerId;
}

function findDuplicateStickerId(hashByStickerId, hash) {
  for (const [stickerId, existingHash] of hashByStickerId.entries()) {
    if (existingHash === hash) {
      return stickerId;
    }
  }
  return "";
}

function computeBufferHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function writeJsonFile(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function printPlan({ planned, stateDir }) {
  console.log(`Sticker import dry run: entries=${planned.length}, stateDir=${stateDir}`);
  for (const item of planned) {
    console.log(`${item.sourceId} pack=${item.pack || "(none)"} status=${item.status} tags=${item.tags.join(",")} desc=${item.desc}`);
  }
}

function normalizeImportTags(tags, pack = "") {
  return unique([pack, ...tags]).slice(0, 3);
}

function normalizeImportStatus(status) {
  const normalized = normalizeText(status).toLowerCase();
  return IMPORT_STATUS_VALUES.includes(normalized) ? normalized : DEFAULT_IMPORT_STATUS;
}

function unique(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizeText(value))
    .filter(Boolean)));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readFlag(args, flag) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      return String(args[index + 1] || "").trim();
    }
  }
  return "";
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error || "unknown error");
    console.error(message);
    process.exit(1);
  });
}

module.exports = {
  buildStickerDesc,
  compactRawContent,
  loadStickerManifest,
  loadTalkmakerMetadata,
  normalizeImportStatus,
  planStickerEntry,
  tagsForMeaning,
};
