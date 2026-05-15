const LONG_TERM_KEYWORDS = [
  "还记得",
  "记得",
  "以前",
  "之前",
  "过去",
  "长期",
  "一直",
  "历史",
  "关系",
  "偏好",
  "习惯",
  "风格",
  "背景",
  "上次说过",
];

const SEMANTIC_RECALL_PATTERNS = [
  /[?？]/i,
  /(什么|怎么|哪|哪个|哪种|会不会|知不知道|记不记得|该不该|能不能|为什么)/i,
  /(喜欢|讨厌|过敏|避雷|想吃|吃什么|喝什么|减肥|减脂|健身|运动|睡眠|作息|压力|加班|疲劳|体重|饮食|体质|安全)/i,
  /(最近|一直|这阵子|这段时间|长期|主线|忙哪条线)/i,
  /(先.*还是|更像.*还是|到底是.*还是)/i,
];

const MEMORY_TRIGGER_PATTERNS = [
  /还记得/i,
  /记不记得/i,
  /上次(?:说过|提过|聊过)?/i,
  /之前(?:说过|提过|聊过)?/i,
  /以前(?:说过|提过|聊过)?/i,
  /过去(?:说过|提过|聊过)?/i,
  /我们.*?(?:说过|提过|聊过)/i,
  /我.*?(?:说过|提过|聊过)/i,
  /你.*?(?:记得|还记得)/i,
  /当时/i,
  /那天/i,
];

const PHATIC_PATTERNS = [
  /^你好[呀吗啊哦]?$/i,
  /^在吗[呀啊]?$/i,
  /^早[啊呀]?$/i,
  /^晚安$/i,
  /^收到$/i,
];

const TECHNICAL_META_PATTERNS = [
  /gateway/i,
  /external[\s_-]?chatbox/i,
  /provider[\s_-]?runtime/i,
  /system[\s_-]?turn/i,
  /unicode/i,
  /emoji/i,
  /主动(?:发送|唤醒)?测试/i,
  /对上口/i,
  /桥/i,
];

const HANGING_HINT_PATTERNS = [
  /还/i,
  /先/i,
  /继续/i,
  /等/i,
  /待会/i,
  /晚点/i,
  /回头/i,
  /最近/i,
  /今天/i,
  /今晚/i,
  /明天/i,
  /之后/i,
  /准备/i,
  /要/i,
  /得/i,
  /没/i,
  /想/i,
];

function buildRecallFocus({ query = "", recentRecords = [], recentRecordLimit = 4 } = {}) {
  const currentQuery = normalizeText(query);
  const recentTurns = buildRecentTurns(recentRecords, recentRecordLimit);
  const trigger = shouldTriggerLongTermRecall({
    query: currentQuery,
    recentTurns,
  });
  const recallQuery = buildRecallQuery({
    currentQuery,
    recentTurns,
    shouldExpand: shouldExpandWithRecentContext(currentQuery, trigger),
  });
  return {
    current_query: currentQuery,
    recall_query: recallQuery,
    recent_turns: recentTurns,
    used_recent_context: recallQuery !== currentQuery,
    ...trigger,
  };
}

function buildRecentTurns(records = [], limit = 4) {
  const source = Array.isArray(records) ? records.slice(0, Math.max(1, limit)).reverse() : [];
  const turns = [];
  source.forEach((record) => {
    if (!record || typeof record !== "object") {
      return;
    }
    const query = normalizeText(record.query);
    const reply = normalizeText(record.assistant_text_final);
    if (query) {
      turns.push({ role: "user", content: query });
    }
    if (reply) {
      turns.push({ role: "assistant", content: reply });
    }
  });
  return turns.slice(-Math.max(1, limit * 2));
}

function shouldTriggerLongTermRecall({ query = "", recentTurns = [] } = {}) {
  const text = normalizeText(query);
  const keywordHits = LONG_TERM_KEYWORDS.filter((token) => text.includes(token));
  const phatic = isPhaticMessage(text);
  const technicalMeta = looksLikeTechnicalMeta(text);
  const explicitRecallSignal = keywordHits.length > 0 || MEMORY_TRIGGER_PATTERNS.some((pattern) => pattern.test(text));
  const semanticRecallSignal = (
    Boolean(text)
    && text.length >= 4
    && !phatic
    && !technicalMeta
    && SEMANTIC_RECALL_PATTERNS.some((pattern) => pattern.test(text))
  );
  const hangingSignal = looksLikeHangingLine(text) && recentTurns.length > 0;
  const shouldTrigger = explicitRecallSignal || semanticRecallSignal || hangingSignal;
  const reasons = [];
  if (keywordHits.length) {
    reasons.push("keyword_hit");
  }
  if (explicitRecallSignal) {
    reasons.push("explicit_recall_signal");
  }
  if (semanticRecallSignal) {
    reasons.push("semantic_recall_signal");
  }
  if (hangingSignal) {
    reasons.push("hanging_signal");
  }
  if (recentTurns.length > 0) {
    reasons.push("recent_context_available");
  }
  return {
    should_trigger: shouldTrigger,
    keyword_hits: keywordHits,
    explicit_recall_signal: explicitRecallSignal,
    semantic_recall_signal: semanticRecallSignal,
    hanging_signal: hangingSignal,
    phatic,
    technical_meta: technicalMeta,
    reasons,
  };
}

function shouldExpandWithRecentContext(currentQuery, trigger = {}) {
  if (!trigger.should_trigger) {
    return false;
  }
  if (trigger.explicit_recall_signal) {
    return true;
  }
  if (!trigger.hanging_signal) {
    return false;
  }
  return isUnderspecifiedContinuation(currentQuery);
}

function buildRecallQuery({ currentQuery = "", recentTurns = [], shouldExpand = false } = {}) {
  const base = normalizeText(currentQuery);
  if (!base) {
    return "";
  }
  if (!shouldExpand || !recentTurns.length) {
    return base;
  }
  const extras = [];
  for (let index = recentTurns.length - 1; index >= 0; index -= 1) {
    const turn = recentTurns[index];
    const content = normalizeText(turn?.content);
    if (!content || content === base) {
      continue;
    }
    extras.push(truncateText(content, 60));
    if (extras.length >= 2) {
      break;
    }
  }
  return [base, ...extras].filter(Boolean).join(" ").trim();
}

function isPhaticMessage(text) {
  const lowered = normalizeText(text).toLowerCase();
  if (!lowered) {
    return true;
  }
  return PHATIC_PATTERNS.some((pattern) => pattern.test(lowered));
}

function isUnderspecifiedContinuation(text) {
  const normalized = normalizeText(text);
  const compact = normalized.replace(/\s+/g, "");
  if (!compact || compact.length > 28) {
    return false;
  }
  return /(这个|那个|这事|那事|这样|那样|还没|还要|还能|也行|也不|不行|可以|算了|继续|接着|先这样|就这样|它|他|她)/i.test(normalized);
}

function looksLikeTechnicalMeta(text) {
  return TECHNICAL_META_PATTERNS.some((pattern) => pattern.test(text));
}

function looksLikeHangingLine(text) {
  const lowered = normalizeText(text).toLowerCase();
  if (!lowered || isPhaticMessage(lowered) || looksLikeTechnicalMeta(lowered)) {
    return false;
  }
  return HANGING_HINT_PATTERNS.some((pattern) => pattern.test(lowered));
}

function truncateText(value, limit = 80) {
  const text = normalizeText(value).replace(/\s+/g, " ");
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  buildRecallFocus,
};
