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
const DEFAULT_STATE_DIR = path.join(os.homedir(), ".asheriebridge");

async function main() {
  const args = process.argv.slice(2);
  const metadataPath = readFlag(args, "--metadata");
  const imagesDir = readFlag(args, "--images");
  const stateDir = readFlag(args, "--state-dir") || process.env.ASHERIEBRIDGE_STATE_DIR || DEFAULT_STATE_DIR;
  const dryRun = hasFlag(args, "--dry-run");

  if (!metadataPath || !imagesDir) {
    throw new Error("Usage: import-talkmaker-emojis.js --metadata <emojis_metadata.json> --images <images_dir> [--state-dir <dir>] [--dry-run]");
  }

  const config = buildConfig({ stateDir });
  const entries = loadTalkmakerMetadata({ metadataPath, imagesDir });
  const planned = entries.map((entry) => ({
    ...entry,
    tags: tagsForMeaning(entry.meaning),
    desc: buildStickerDesc(entry),
  }));

  if (dryRun) {
    printPlan({ planned, stateDir });
    return;
  }

  const result = await importStickers({ config, planned });
  console.log(`Imported stickers: created=${result.createdCount}, deduped=${result.dedupedCount}, total=${result.results.length}`);
  for (const item of result.results) {
    const marker = item.created ? "created" : "deduped";
    console.log(`${marker} ${item.stickerId} ${item.sourceId} tags=${item.tags.join(",")} desc=${item.desc}`);
  }
}

function buildConfig({ stateDir }) {
  const repoRoot = path.resolve(__dirname, "..");
  return {
    stateDir,
    stickersDir: path.join(stateDir, "stickers"),
    stickerAssetsDir: path.join(stateDir, "stickers", "assets"),
    stickersIndexFile: path.join(stateDir, "stickers", "index.json"),
    stickerTagsFile: path.join(stateDir, "stickers", "tags.json"),
    stickersTemplateDir: path.join(repoRoot, "templates", "stickers"),
    stickersTemplateIndexFile: path.join(repoRoot, "templates", "stickers", "index.json"),
    stickerTagsTemplateFile: path.join(repoRoot, "templates", "stickers", "tags.json"),
    stickerNormalizeGifScript: path.join(repoRoot, "scripts", "normalize-sticker-gif.js"),
  };
}

function loadTalkmakerMetadata({ metadataPath, imagesDir }) {
  const resolvedMetadataPath = path.resolve(metadataPath);
  const resolvedImagesDir = path.resolve(imagesDir);
  const parsed = JSON.parse(fs.readFileSync(resolvedMetadataPath, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("Talkmaker metadata must be a JSON array.");
  }
  return parsed
    .map((item, index) => normalizeTalkmakerEntry({ item, index, imagesDir: resolvedImagesDir }))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId, "en", { numeric: true }));
}

function normalizeTalkmakerEntry({ item, index, imagesDir }) {
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
    meaning,
    rawContent,
    fileName,
    filePath,
  };
}

function tagsForMeaning(meaning) {
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
  return unique([SERIES_TAG, ...semanticTags]).slice(0, 3);
}

function buildStickerDesc(entry) {
  const raw = compactRawContent(entry.rawContent);
  return `${SERIES_TAG}${entry.meaning}：${raw}`;
}

function compactRawContent(rawContent) {
  const normalized = normalizeText(rawContent).replace(/\s+/g, " ");
  if (!normalized) {
    return "小萝卜系列表情包。";
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
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "asheriebridge-talkmaker-"));
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
        stickerId: duplicateStickerId,
        created: false,
        deduped: true,
        tags: index[duplicateStickerId]?.tags || [],
        desc: index[duplicateStickerId]?.desc || "",
      };
    }
    const stickerId = allocateNextStickerId(index);
    const stickerPath = resolveStickerFilePath(config, stickerId);
    await fsp.mkdir(path.dirname(stickerPath), { recursive: true });
    await fsp.copyFile(normalizedGifPath, stickerPath);
    index[stickerId] = {
      tags: item.tags,
      desc: item.desc,
    };
    hashByStickerId.set(stickerId, normalizedHash);
    return {
      sourceId: item.sourceId,
      stickerId,
      created: true,
      deduped: false,
      tags: item.tags,
      desc: item.desc,
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
  console.log(`Talkmaker sticker import dry run: entries=${planned.length}, stateDir=${stateDir}`);
  for (const item of planned) {
    console.log(`${item.sourceId} tags=${item.tags.join(",")} desc=${item.desc}`);
  }
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
  loadTalkmakerMetadata,
  tagsForMeaning,
};
