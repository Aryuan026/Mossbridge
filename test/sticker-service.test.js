const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  StickerService,
  allocateNextStickerId,
  buildStickerPaths,
  ensureStickerCatalogFilesSync,
  loadStickerIndexSync,
  loadStickerTagsSync,
  resolveStickerFilePath,
} = require("../src/services/sticker-service");

test("ensureStickerCatalogFilesSync bootstraps the preset sticker catalog", () => {
  const config = createTempStickerConfig();
  ensureStickerCatalogFilesSync(config);

  assert.ok(fs.existsSync(config.stickersIndexFile));
  assert.ok(fs.existsSync(config.stickerTagsFile));
  assert.ok(fs.existsSync(config.stickerAssetsDir));
  const index = loadStickerIndexSync(config);
  assert.equal(Object.keys(index).length, 11);
  assert.equal(index.stk_009.desc, "抱着枕头和小熊的小猫晚安 good night");
  assert.ok(fs.existsSync(resolveStickerFilePath(config, "stk_009")));
  assert.ok(loadStickerTagsSync(config).includes("开心"));
});

test("StickerService saves, dedupes, updates, picks, sends, and deletes stickers", async () => {
  const config = createTempStickerConfig();
  const inboxFile = writeInboxGif(config, "happy.gif", "GIF89a-happy");
  const sentFiles = [];
  const service = new StickerService({
    config,
    channelAdapter: null,
    sessionStore: null,
    channelFileService: {
      async sendToCurrentChat(args, context) {
        sentFiles.push({ args, context });
        return { ok: true, ...args };
      },
    },
  });

  const saved = await service.saveFromInbox({
    items: [{
      filePath: inboxFile,
      tags: ["开心", "可爱"],
      desc: "一张开心晃尾巴的测试表情，适合轻松回应。",
    }],
  });
  assert.equal(saved.createdCount, 1);
  assert.equal(saved.results[0].stickerId, "stk_012");
  assert.ok(fs.existsSync(resolveStickerFilePath(config, "stk_012")));

  const deduped = await service.saveFromInbox({
    items: [{
      filePath: inboxFile,
      tags: ["开心"],
      desc: "同一张表情再次保存时应该去重。",
    }],
  });
  assert.equal(deduped.createdCount, 0);
  assert.equal(deduped.dedupedCount, 1);
  assert.equal(deduped.results[0].stickerId, "stk_012");

  const picked = await service.pick({ tag: "开心", limit: 3 });
  assert.ok(picked.candidates.some((item) => item.stickerId === "stk_012"));
  const listed = await service.list({ tag: "GPT", limit: 20 });
  assert.equal(listed.count, 8);
  assert.ok(listed.stickers.every((item) => item.tags.includes("GPT")));

  const updated = await service.update({
    items: [{
      stickerId: "stk_012",
      tags: ["得意"],
      desc: "一张得意又可爱的测试表情，用来轻轻嘚瑟。",
    }],
  });
  assert.equal(updated.updatedCount, 1);
  assert.equal(loadStickerIndexSync(config).stk_012.tags[0], "得意");

  const delivery = await service.sendToCurrentChat({ stickerId: "stk_012", userId: "user-a" }, { threadId: "t1" });
  assert.equal(delivery.stickerId, "stk_012");
  assert.equal(sentFiles.length, 1);
  assert.equal(sentFiles[0].args.userId, "user-a");

  const deleted = await service.delete({ items: [{ stickerId: "stk_012" }] });
  assert.equal(deleted.deletedCount, 1);
  assert.equal(fs.existsSync(resolveStickerFilePath(config, "stk_012")), false);
});

test("StickerService keeps archive stickers searchable but out of default picking", async () => {
  const config = createTempStickerConfig();
  const index = loadStickerIndexSync(config);
  index.stk_012 = {
    tags: ["开心", "小萝卜"],
    desc: "归档里的开心小萝卜，只在翻大仓时出现。",
    pack: "小萝卜",
    status: "archive",
    favorite: true,
    source: "manifest",
    sourceId: "demo-1",
  };
  fs.writeFileSync(config.stickersIndexFile, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  fs.copyFileSync(resolveStickerFilePath(config, "stk_001"), resolveStickerFilePath(config, "stk_012"));
  const service = new StickerService({
    config,
    channelAdapter: null,
    sessionStore: null,
    channelFileService: null,
  });

  const defaultPick = await service.pick({ tag: "小萝卜", limit: 5 });
  assert.equal(defaultPick.candidates.length, 0);

  const archivePick = await service.pick({ tag: "小萝卜", status: "archive", limit: 5 });
  assert.equal(archivePick.candidates[0].stickerId, "stk_012");
  assert.equal(archivePick.candidates[0].pack, "小萝卜");
  assert.equal(archivePick.candidates[0].favorite, true);

  const listed = await service.list({ pack: "小萝卜", status: "archive", limit: 5 });
  assert.equal(listed.stickers[0].sourceId, "demo-1");
});

test("StickerService searches Home-shaped catalog entries and sends asset_file images", async () => {
  const config = createTempStickerConfig();
  const index = loadStickerIndexSync(config);
  index.stk_012 = {
    tags: ["抱抱", "安慰"],
    desc: "软软抱抱安慰。",
    meaning: "给你抱抱",
    raw_content: "一只小狗把哭哭猫抱进怀里，适合难过时软着陆。",
    use_when: ["用户难过、委屈、需要被接住的时候。"],
    avoid_when: ["严肃决策或需要先解释事实的时候。"],
    frontstage_effect: "温柔收尾",
    drawer: "core",
    group: "affection_hug",
    asset_file: "stk_012.png",
    mime_type: "image/png",
    status: "active",
  };
  fs.writeFileSync(config.stickersIndexFile, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(config.stickerAssetsDir, "stk_012.png"), "PNG-soft-hug");
  const sentFiles = [];
  const service = new StickerService({
    config,
    channelAdapter: null,
    sessionStore: null,
    channelFileService: {
      async sendToCurrentChat(args, context) {
        sentFiles.push({ args, context });
        return { ok: true };
      },
    },
  });

  const searched = await service.search({ query: "难过的时候给她一个软软抱抱", limit: 3 });

  assert.equal(searched.candidates[0].stickerId, "stk_012");
  assert.equal(searched.candidates[0].assetFile, "stk_012.png");
  assert.equal(searched.candidates[0].rawContent, "一只小狗把哭哭猫抱进怀里，适合难过时软着陆。");
  assert.equal(searched.candidates[0].drawer, "core");

  const delivery = await service.sendToCurrentChat({ stickerId: "stk_012", userId: "user-a" }, { threadId: "t1" });
  assert.equal(delivery.assetFile, "stk_012.png");
  assert.equal(delivery.mimeType, "image/png");
  assert.equal(sentFiles[0].args.filePath, path.join(config.stickerAssetsDir, "stk_012.png"));
});

test("StickerService records sticker delivery audit with WeChat media fallback details", async () => {
  const config = createTempStickerConfig();
  const index = loadStickerIndexSync(config);
  index.stk_012 = {
    tags: ["抱抱"],
    desc: "一张被微信图片出口降级测试的抱抱表情。",
    asset_file: "stk_012.png",
    mime_type: "image/png",
    status: "active",
  };
  fs.writeFileSync(config.stickersIndexFile, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  const assetPath = path.join(config.stickerAssetsDir, "stk_012.png");
  fs.writeFileSync(assetPath, "PNG-soft-hug");
  const service = new StickerService({
    config,
    channelAdapter: null,
    sessionStore: null,
    channelFileService: {
      async sendToCurrentChat(args) {
        return {
          ok: true,
          status: "sent",
          userId: args.userId,
          filePath: args.filePath,
          sizeBytes: fs.statSync(args.filePath).size,
          delivery: {
            kind: "file",
            fileName: path.basename(args.filePath),
            fallbackFrom: "image",
            fallbackReason: "image upload failed: CDN 500",
          },
        };
      },
    },
  });

  await service.sendToCurrentChat({ stickerId: "stk_012", userId: "user-a" }, { threadId: "t1" });

  const audit = JSON.parse(fs.readFileSync(config.stickerDeliveryAuditFile, "utf8"));
  assert.equal(audit.lastDelivery.status, "sent");
  assert.equal(audit.lastDelivery.stickerId, "stk_012");
  assert.equal(audit.lastDelivery.sourceFileName, "stk_012.png");
  assert.equal(audit.lastDelivery.sourceMimeType, "image/png");
  assert.equal(audit.lastDelivery.deliveryMimeType, "image/png");
  assert.equal(audit.lastDelivery.deliveryTransform, "none");
  assert.equal(audit.lastDelivery.channelDeliveryKind, "file");
  assert.equal(audit.lastDelivery.fallbackFrom, "image");
  assert.match(audit.lastDelivery.fallbackReason, /CDN 500/);
  assert.equal(audit.lastDelivery.attempts.length, 1);
  assert.equal(audit.lastDelivery.attempts[0].status, "sent");
});

test("StickerService records an attempting audit before channel delivery returns", async () => {
  const config = createTempStickerConfig();
  const index = loadStickerIndexSync(config);
  index.stk_012 = {
    tags: ["抱抱"],
    desc: "一张发送中断测试表情。",
    asset_file: "stk_012.jpg",
    mime_type: "image/jpeg",
    status: "active",
  };
  fs.writeFileSync(config.stickersIndexFile, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  const assetPath = path.join(config.stickerAssetsDir, "stk_012.jpg");
  fs.writeFileSync(assetPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]));
  const service = new StickerService({
    config,
    channelAdapter: null,
    sessionStore: null,
    channelFileService: {
      async sendToCurrentChat() {
        const audit = JSON.parse(fs.readFileSync(config.stickerDeliveryAuditFile, "utf8"));
        assert.equal(audit.lastDelivery.status, "attempting");
        assert.equal(audit.lastDelivery.stickerId, "stk_012");
        assert.equal(audit.lastDelivery.sourceActualMimeType, "image/jpeg");
        assert.equal(audit.lastDelivery.attempts[0].status, "pending");
        throw new Error("simulated interrupted image delivery");
      },
    },
  });

  await assert.rejects(
    () => service.sendToCurrentChat({ stickerId: "stk_012", userId: "user-a" }, { threadId: "t1" }),
    /simulated interrupted image delivery/
  );
  const audit = JSON.parse(fs.readFileSync(config.stickerDeliveryAuditFile, "utf8"));
  assert.equal(audit.lastDelivery.status, "failed");
  assert.equal(audit.lastDelivery.sourceActualMimeType, "image/jpeg");
  assert.equal(audit.lastDelivery.attempts[0].status, "failed");
  assert.match(audit.lastDelivery.error, /simulated interrupted/);
});

test("StickerService sends gif stickers as static png previews first for WeChat stability", {
  skip: process.platform !== "darwin" || !fs.existsSync("/usr/bin/sips"),
}, async () => {
  const config = createTempStickerConfig();
  const index = loadStickerIndexSync(config);
  index.stk_012 = {
    tags: ["挥手"],
    desc: "一张会动的挥手测试表情。",
    status: "active",
  };
  fs.writeFileSync(config.stickersIndexFile, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    resolveStickerFilePath(config, "stk_012"),
    Buffer.from("R0lGODlhAQABAIABAP///wAAACH5BAEKAAEALAAAAAABAAEAAAICRAEAOw==", "base64")
  );
  const sentFiles = [];
  const service = new StickerService({
    config,
    channelAdapter: null,
    sessionStore: null,
    channelFileService: {
      async sendToCurrentChat(args, context) {
        sentFiles.push({ args, context });
        return { ok: true };
      },
    },
  });

  const delivery = await service.sendToCurrentChat({ stickerId: "stk_012", userId: "user-a" }, { threadId: "t1" });

  assert.equal(delivery.mimeType, "image/gif");
  assert.equal(delivery.deliveryMimeType, "image/png");
  assert.equal(delivery.deliveryTransform, "gif_static_png_preview");
  assert.equal(sentFiles.length, 1);
  assert.match(sentFiles[0].args.filePath, /send-cache\/stk_012-\d+-\d+\.png$/);
  assert.ok(fs.existsSync(sentFiles[0].args.filePath));
});

test("StickerService falls back to animated gif only if static png preview delivery fails", {
  skip: process.platform !== "darwin" || !fs.existsSync("/usr/bin/sips"),
}, async () => {
  const config = createTempStickerConfig();
  const index = loadStickerIndexSync(config);
  index.stk_012 = {
    tags: ["挥手"],
    desc: "一张会动的挥手测试表情。",
    status: "active",
  };
  fs.writeFileSync(config.stickersIndexFile, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    resolveStickerFilePath(config, "stk_012"),
    Buffer.from("R0lGODlhAQABAIABAP///wAAACH5BAEKAAEALAAAAAABAAEAAAICRAEAOw==", "base64")
  );
  const sentFiles = [];
  const service = new StickerService({
    config,
    channelAdapter: null,
    sessionStore: null,
    channelFileService: {
      async sendToCurrentChat(args, context) {
        sentFiles.push({ args, context });
        if (sentFiles.length === 1) {
          throw new Error("CDN upload failed: 500");
        }
        return { ok: true };
      },
    },
  });

  const delivery = await service.sendToCurrentChat({ stickerId: "stk_012", userId: "user-a" }, { threadId: "t1" });

  assert.equal(delivery.mimeType, "image/gif");
  assert.equal(delivery.deliveryMimeType, "image/gif");
  assert.equal(delivery.deliveryTransform, "gif_original_small_fallback");
  assert.equal(delivery.attemptedDeliveries.length, 1);
  assert.match(sentFiles[0].args.filePath, /send-cache\/stk_012-\d+-\d+\.png$/);
  assert.ok(fs.existsSync(sentFiles[0].args.filePath));
  assert.equal(sentFiles[1].args.filePath, resolveStickerFilePath(config, "stk_012"));
});

test("ensureStickerCatalogFilesSync merges presets without overwriting custom ids", () => {
  const config = createTempStickerConfig();
  fs.mkdirSync(config.stickersDir, { recursive: true });
  fs.writeFileSync(config.stickersIndexFile, `${JSON.stringify({
    stk_001: {
      tags: ["自定义"],
      desc: "用户自己已经占用的表情编号。",
    },
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(config.stickerTagsFile, `${JSON.stringify(["自定义"], null, 2)}\n`, "utf8");

  ensureStickerCatalogFilesSync(config);
  const index = loadStickerIndexSync(config);
  assert.equal(index.stk_001.desc, "用户自己已经占用的表情编号。");
  assert.equal(index.stk_002.desc, "三个人举牌应援小G LOVE满屏爱心");
  assert.ok(loadStickerTagsSync(config).includes("自定义"));
  assert.ok(loadStickerTagsSync(config).includes("GPT"));
  assert.equal(fs.existsSync(resolveStickerFilePath(config, "stk_001")), false);
  assert.ok(fs.existsSync(resolveStickerFilePath(config, "stk_002")));
});

test("StickerService only saves files from managed inbox roots", async () => {
  const config = createTempStickerConfig();
  const outsideFile = path.join(config.testRoot, "outside.gif");
  fs.writeFileSync(outsideFile, "GIF89a-outside");
  const service = new StickerService({
    config,
    channelAdapter: null,
    sessionStore: null,
    channelFileService: null,
  });

  await assert.rejects(
    () => service.saveFromInbox({
      items: [{
        filePath: outsideFile,
        tags: ["开心"],
        desc: "这张不在托管 inbox 里的测试图不能直接保存。",
      }],
    }),
    /managed inbox|under one of/
  );
});

test("allocateNextStickerId uses the next numeric sticker id", () => {
  assert.equal(allocateNextStickerId({ stk_001: {}, stk_009: {}, other: {} }), "stk_010");
});

function createTempStickerConfig() {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mossbridge-sticker-test-"));
  const stateDir = path.join(testRoot, "state");
  const workspaceRoot = path.join(testRoot, "workspace");
  return {
    testRoot,
    stateDir,
    workspaceRoot,
    workspaceInboxDir: path.join("wechat", "inbox"),
    stickersDir: path.join(stateDir, "stickers"),
    stickerAssetsDir: path.join(stateDir, "stickers", "assets"),
    stickersIndexFile: path.join(stateDir, "stickers", "index.json"),
    stickerTagsFile: path.join(stateDir, "stickers", "tags.json"),
    stickerDeliveryAuditFile: path.join(stateDir, "sticker-delivery-audit.json"),
    stickersTemplateDir: path.resolve(__dirname, "..", "templates", "stickers"),
    stickersTemplateIndexFile: path.resolve(__dirname, "..", "templates", "stickers", "index.json"),
    stickerTagsTemplateFile: path.resolve(__dirname, "..", "templates", "stickers", "tags.json"),
    stickerNormalizeGifScript: path.resolve(__dirname, "..", "scripts", "normalize-sticker-gif.js"),
  };
}

function writeInboxGif(config, fileName, content) {
  const paths = buildStickerPaths(config);
  const inboxDir = path.join(paths.workspaceInboxDir, "2026-05-01");
  fs.mkdirSync(inboxDir, { recursive: true });
  const filePath = path.join(inboxDir, fileName);
  fs.writeFileSync(filePath, content);
  return filePath;
}
