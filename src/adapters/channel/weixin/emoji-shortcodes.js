const WEIXIN_BRACKET_EMOJI_MAP = {
  微笑: "🙂",
  笑脸: "🙂",
  呲牙: "😁",
  龇牙: "😁",
  调皮: "😜",
  坏笑: "😏",
  偷笑: "🤭",
  憨笑: "😄",
  可爱: "😊",
  害羞: "☺️",
  亲亲: "😘",
  抱抱: "🫂",
  拥抱: "🫂",
  爱你: "🫶",
  色: "😍",
  得意: "😌",
  酷: "😎",
  发呆: "😐",
  尴尬: "😅",
  流泪: "😢",
  大哭: "😭",
  难过: "😞",
  委屈: "🥺",
  快哭了: "🥺",
  可怜: "🥺",
  发怒: "😠",
  咒骂: "😡",
  抓狂: "😫",
  衰: "😵",
  困: "😪",
  睡: "😴",
  惊讶: "😮",
  惊恐: "😨",
  冷汗: "😰",
  流汗: "😅",
  擦汗: "😅",
  疑问: "❓",
  嘘: "🤫",
  晕: "😵‍💫",
  吐: "🤮",
  白眼: "🙄",
  鄙视: "😒",
  闭嘴: "🤐",
  哈欠: "🥱",
  再见: "👋",
  鼓掌: "👏",
  握手: "🤝",
  强: "👍",
  弱: "👎",
  胜利: "✌️",
  抱拳: "🙏",
  拳头: "✊",
  OK: "👌",
  ok: "👌",
  NO: "🙅",
  no: "🙅",
  爱心: "❤️",
  心碎: "💔",
  玫瑰: "🌹",
  凋谢: "🥀",
  嘴唇: "💋",
  太阳: "☀️",
  月亮: "🌙",
  蛋糕: "🎂",
  炸弹: "💣",
  咖啡: "☕",
  饭: "🍚",
  啤酒: "🍺",
  西瓜: "🍉",
  猪头: "🐷",
  菜刀: "🔪",
  哇: "😲",
  奸笑: "😏",
  捂脸: "🤦",
  机智: "😉",
  皱眉: "🙁",
};

const WEIXIN_BRACKET_EMOJI_CUE_MAP = {
  右哼哼: "用户发来了一个哼哼、别扭或小不满的微信表情",
  左哼哼: "用户发来了一个哼哼、别扭或小不满的微信表情",
};

function normalizeWeixinBracketEmojiShortcodes(text) {
  return String(text || "").replace(/\[([^\]\n]{1,8})\]/g, (match, rawName) => {
    const name = String(rawName || "").trim();
    return Object.prototype.hasOwnProperty.call(WEIXIN_BRACKET_EMOJI_MAP, name)
      ? WEIXIN_BRACKET_EMOJI_MAP[name]
      : match;
  });
}

function normalizeInboundWeixinEmojiShortcodes(text) {
  return String(text || "").replace(/\[([^\]\n]{1,8})\]/g, (match, rawName) => {
    const name = String(rawName || "").trim();
    const cue = WEIXIN_BRACKET_EMOJI_CUE_MAP[name];
    if (cue) {
      return `（${cue}）`;
    }
    return Object.prototype.hasOwnProperty.call(WEIXIN_BRACKET_EMOJI_MAP, name)
      ? WEIXIN_BRACKET_EMOJI_MAP[name]
      : match;
  });
}

module.exports = {
  WEIXIN_BRACKET_EMOJI_MAP,
  normalizeInboundWeixinEmojiShortcodes,
  normalizeWeixinBracketEmojiShortcodes,
};
