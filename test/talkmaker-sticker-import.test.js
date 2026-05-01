const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const {
  buildStickerDesc,
  compactRawContent,
  loadTalkmakerMetadata,
  tagsForMeaning,
} = require("../scripts/import-talkmaker-emojis");

test("talkmaker import maps exported meanings to bridge-sized sticker tags", () => {
  assert.deepEqual(tagsForMeaning("比心点赞"), ["小萝卜", "比心", "点赞"]);
  assert.deepEqual(tagsForMeaning("好啊/没问题"), ["小萝卜", "OK", "赞同"]);
  assert.deepEqual(tagsForMeaning("怒火中烧"), ["小萝卜", "生气", "暴躁"]);
});

test("talkmaker import keeps descriptions compact but concrete", () => {
  const desc = buildStickerDesc({
    meaning: "委屈哭泣",
    rawContent: "<raw>一个白色的卡通角色，头顶有绿色叶子，眼角有泪珠，嘴巴向下，整体表情非常委屈和难过。",
  });
  assert.match(desc, /^小萝卜委屈哭泣：/);
  assert.match(desc, /绿色叶子/);
  assert.ok(desc.length < 140);

  const compact = compactRawContent("一个卡通风格的白色萝卜小人，头顶有绿色叶子。");
  assert.equal(compact, "白色萝卜小人，头顶有绿色叶子。");
});

test("talkmaker import loads metadata and sorts by source id", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "talkmaker-import-test-"));
  const imagesDir = path.join(root, "images");
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.writeFileSync(path.join(imagesDir, "b.gif"), "gif-b");
  fs.writeFileSync(path.join(imagesDir, "a.gif"), "gif-a");
  const metadataPath = path.join(root, "emojis_metadata.json");
  fs.writeFileSync(metadataPath, JSON.stringify([
    { id: "emoji-id-0002", meaning: "开心跳跃", rawContent: "第二张", fileName: "b.gif" },
    { id: "emoji-id-0001", meaning: "生气", rawContent: "第一张", fileName: "a.gif" },
  ]));

  const entries = loadTalkmakerMetadata({ metadataPath, imagesDir });
  assert.deepEqual(entries.map((item) => item.sourceId), ["emoji-id-0001", "emoji-id-0002"]);
  assert.deepEqual(entries.map((item) => item.meaning), ["生气", "开心跳跃"]);
});
