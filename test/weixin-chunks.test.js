const test = require("node:test");
const assert = require("node:assert/strict");

const {
  splitUtf8,
  compactPlainTextForWeixin,
  normalizeWeixinReplyText,
  finalizeWeixinDeliveryChunk,
  stripSentenceTailChineseFullStops,
  stripChunkTailChineseFullStops,
  normalizeInboundWeixinEmojiShortcodes,
  normalizeWeixinBracketEmojiShortcodes,
  chunkReplyTextForWeixin,
  mergeShortChunks,
  packChunksForWeixinDelivery,
  splitTextAtBoundaries,
  findBoundaryPunctuationEnd,
  collectStreamingBoundaries,
  trimOuterBlankLines,
} = require("../src/adapters/channel/weixin/index");
const { bodyFromItemList } = require("../src/adapters/channel/weixin/message-utils");

test("normalizeWeixinReplyText trims outer blank lines but preserves internal blank lines", () => {
  const text = "line1\r\n\r\n\nline2\n\n\nline3";
  assert.equal(normalizeWeixinReplyText(text), "line1\n\n\nline2\n\n\nline3");
  assert.equal(compactPlainTextForWeixin(text), "line1\n\n\nline2\n\n\nline3");
});

test("stripChunkTailChineseFullStops removes only a single final full stop", () => {
  assert.equal(stripChunkTailChineseFullStops("你好。"), "你好");
  assert.equal(stripChunkTailChineseFullStops("你好。。。"), "你好。。。");
  assert.equal(stripChunkTailChineseFullStops("你好。\n世界。"), "你好。\n世界");
  assert.equal(stripChunkTailChineseFullStops("你好。\""), "你好\"");
  assert.equal(stripChunkTailChineseFullStops("a。b。c。"), "a。b。c");
  assert.equal(stripSentenceTailChineseFullStops("你好。"), "你好");
  assert.equal(finalizeWeixinDeliveryChunk("\n\n你好。\n\n"), "你好");
});

test("normalizeWeixinBracketEmojiShortcodes converts known WeChat emoji labels only", () => {
  assert.equal(normalizeWeixinBracketEmojiShortcodes("宝宝[微笑][坏笑]"), "宝宝🙂😏");
  assert.equal(normalizeWeixinBracketEmojiShortcodes("保留 [track_id:abc] 和 [unknown]"), "保留 [track_id:abc] 和 [unknown]");
});

test("normalizeInboundWeixinEmojiShortcodes keeps transport placeholders out of runtime text", () => {
  assert.equal(normalizeInboundWeixinEmojiShortcodes("[哇]连上了"), "😲连上了");
  assert.equal(
    normalizeInboundWeixinEmojiShortcodes("宝宝[右哼哼]"),
    "宝宝（用户发来了一个哼哼、别扭或小不满的微信表情）"
  );
  assert.equal(normalizeInboundWeixinEmojiShortcodes("保留 [track_id:abc]"), "保留 [track_id:abc]");
});

test("bodyFromItemList normalizes WeChat emoji placeholders before runtime intake", () => {
  const text = bodyFromItemList([{
    type: 1,
    text_item: {
      text: "宝宝[右哼哼]",
    },
  }]);
  assert.equal(text, "宝宝（用户发来了一个哼哼、别扭或小不满的微信表情）");
});

test("collectStreamingBoundaries finds paragraph, list and punctuation breaks", () => {
  const text = "第一段。\n\n第二段\n- list1\n- list2\n最后！对吧？";
  const boundaries = collectStreamingBoundaries(text);
  assert.ok(boundaries.length > 0, "should find boundaries");
  assert.ok(boundaries.some((b) => b > 0), "should have positive boundaries");
  // paragraph break comes after the double newline
  assert.ok(boundaries.some((b) => b >= 6), "should break after paragraph");
  // list breaks
  assert.ok(boundaries.some((b) => b >= 10 && b < 17), "should break before first list item");
  assert.ok(boundaries.some((b) => b >= 17 && b < 24), "should break before second list item");
});

test("chunkReplyTextForWeixin merges short natural boundaries", () => {
  // Each unit is below MIN_WEIXIN_CHUNK (20), so they get merged
  const text = "A。\n\nB。\n\nC。";
  const chunks = chunkReplyTextForWeixin(text);
  assert.deepEqual(chunks, ["A。\n\nB。\n\nC。"]);
});

test("chunkReplyTextForWeixin does not merge chunks above min length", () => {
  const longA = "A".repeat(25) + "。";
  const longB = "B".repeat(25) + "。";
  const text = `${longA}\n\n${longB}`;
  const chunks = chunkReplyTextForWeixin(text);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], `${longA}\n\n`);
  assert.equal(chunks[1], longB);
});

test("chunkReplyTextForWeixin merges short adjacent chunks", () => {
  const text = ["短1", "短2", "这是一段比较长的话，不应该和前面的短句合并在一起"].join("\n\n");
  const chunks = chunkReplyTextForWeixin(text);
  assert.equal(chunks[0], "短1\n\n短2\n\n");
  assert.ok(!chunks[1].startsWith("短2"));
});

test("mergeShortChunks only merges when both sides are short", () => {
  const chunks = [`${"a".repeat(15)}\n\n`, `${"b".repeat(15)}\n`, "c".repeat(100)];
  const merged = mergeShortChunks(chunks, 3800, 20);
  assert.equal(merged[0], `${"a".repeat(15)}\n\n${"b".repeat(15)}\n`);
  assert.equal(merged[1], "c".repeat(100));
});

test("mergeShortChunks does not merge when one side is long", () => {
  const chunks = ["短", "c".repeat(100)];
  const merged = mergeShortChunks(chunks, 3800, 20);
  assert.equal(merged.length, 2);
  assert.equal(merged[0], "短");
  assert.equal(merged[1], "c".repeat(100));
});

test("packChunksForWeixinDelivery limits to maxMessages", () => {
  const chunks = Array.from({ length: 15 }, (_, i) => `chunk-${i}`);
  const packed = packChunksForWeixinDelivery(chunks, 10, 3800);
  assert.equal(packed.length, 10);
});

test("packChunksForWeixinDelivery groups tail when over limit", () => {
  const chunks = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
  const packed = packChunksForWeixinDelivery(chunks, 10, 3800);
  assert.equal(packed.length, 10);
  assert.equal(packed[0], "1");
  assert.ok(packed[9].includes("11") || packed[9].includes("12"));
});

test("splitUtf8 hard-truncates oversized text", () => {
  const text = "a".repeat(10_000);
  const chunks = splitUtf8(text, 3800);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 3800);
  assert.equal(chunks[1].length, 3800);
  assert.equal(chunks[2].length, 2400);
});

test("splitTextAtBoundaries preserves original separators", () => {
  const text = "A。\n\nB。";
  const units = splitTextAtBoundaries(text, collectStreamingBoundaries(text));
  assert.deepEqual(units, ["A。\n\n", "B。"]);
});

test("findBoundaryPunctuationEnd keeps repeated punctuation together", () => {
  assert.equal(findBoundaryPunctuationEnd("哇！！！下一句", 1), 4);
  assert.equal(findBoundaryPunctuationEnd("等等......下一句", 2), 8);
  assert.equal(findBoundaryPunctuationEnd("a. b", 1), 0);
});

test("trimOuterBlankLines strips leading and trailing blank lines", () => {
  assert.equal(trimOuterBlankLines("\n\nhello\n\n"), "hello");
});
