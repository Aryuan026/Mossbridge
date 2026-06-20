const { charNgrams, tokenize } = require("./contracts");
const {
  WARM_ROUTE_SIGNAL_TERMS,
  buildWarmRoutePrior,
  isBackgroundRecallMode,
  isProactiveRecallMode,
} = require("./route-signals");

const CONCEPT_SYNONYMS = Object.freeze({
  选择: ["决策", "决定"],
  决策: ["选择", "决定"],
  决定: ["选择", "决策"],
  模式: ["方式", "风格", "习惯"],
  方式: ["模式", "风格"],
  风格: ["模式", "方式"],
  偏好: ["喜欢", "喜好", "倾向"],
  喜欢: ["偏好", "喜好"],
  倾向: ["偏好", "趋势"],
  性格: ["特质", "特点"],
  特质: ["性格", "习惯"],
  习惯: ["偏好", "模式"],
  健康: ["身体", "作息", "睡眠", "饮食", "压力"],
  健身: ["运动", "训练", "减脂", "体重"],
  减脂: ["减肥", "体重", "饮食", "训练"],
  减肥: ["减脂", "体重", "饮食", "运动"],
  睡眠: ["作息", "疲劳", "压力"],
  压力: ["加班", "疲劳", "作息"],
  美甲: ["指甲", "建构", "甲油", "甲面"],
  指甲: ["美甲", "建构"],
  颜色: ["色系", "色调", "配色"],
  色系: ["颜色", "色调", "配色"],
  审美: ["风格", "色系", "偏好"],
  亲密: ["亲昵", "贴近", "熟悉", "黏糊"],
  亲昵: ["亲密", "贴近", "熟悉", "黏糊"],
  熟悉: ["亲密", "亲昵", "默契", "自然"],
  黏糊: ["黏黏", "亲昵", "贴近"],
  黏黏: ["黏糊", "亲昵", "贴近"],
  逗嘴: ["接梗", "玩笑", "调戏"],
  接梗: ["逗嘴", "玩笑", "调戏"],
  玩笑: ["逗嘴", "接梗", "调戏"],
  调戏: ["逗嘴", "接梗", "玩笑"],
  退缩: ["冷淡", "疏远", "不熟"],
  客气: ["客服", "公事公办", "工具化", "sop"],
  客服: ["客气", "公事公办", "工具化", "sop"],
  工具化: ["客气", "客服", "公事公办", "sop"],
  重要: ["有意义", "珍贵", "纪念", "象征"],
  有意义: ["重要", "纪念", "象征"],
  象征: ["信物", "纪念", "有意义"],
  信物: ["象征", "纪念", "寄托"],
  纪念: ["象征", "信物", "重要"],
  粉粉: ["粉色", "裸粉", "豆沙"],
  素色: ["裸色", "裸粉", "低饱和"],
  嬛嬛: ["裸粉", "低饱和", "粉色"],
  八卦: ["吃瓜", "连续剧"],
  吃瓜: ["八卦", "连续剧"],
  家族: ["亲属", "亲戚", "家庭"],
  亲属: ["家族", "亲戚", "家庭"],
  亲戚: ["家族", "亲属", "家庭"],
});

const ENTITY_ALIASES = Object.freeze({
  国防部: ["五角大楼"],
  五角大楼: ["国防部"],
  美国国防部: ["五角大楼", "国防部"],
  pentagon: ["五角大楼", "国防部"],
  openai: ["微软", "gpt"],
  中央: ["中共中央"],
});

const QUERY_STOP_TOKENS = new Set([
  "什么", "哪些", "哪个", "哪种", "哪样", "哪类",
  "如何", "怎么", "怎样", "为何", "为什",
  "多少", "几个", "几种", "几次",
  "是否", "有无", "有没",
  "现在", "目前", "最近", "以前", "之前", "之后", "以后", "曾经",
  "长期", "短期", "一直", "一般", "一样", "一种", "一些",
  "今天", "白天", "晚上", "今晚", "明天", "昨天",
  "还是", "那条", "那些", "这些", "这个", "那个",
  "新闻", "消息", "事情", "问题", "情况", "情形",
  "自己", "起来", "回来", "来啦", "一次", "了一", "了全",
  "好了", "修好", "修好了", "自动", "全自", "全自动", "不自", "不自己",
  "打算", "我要", "我想", "要把", "别的", "哎嘿", "按它", "它的",
  "说法", "生效", "果然", "值得", "话说", "后台", "系统",
  "自然", "不要", "在意", "在后",
  "codex",
  "后来", "后续", "进展", "新进", "新进展", "有新", "有新进", "更新",
  "看看", "看起", "感觉", "感受",
  "时候", "时是", "时的", "时间",
  "我做", "我在", "我有", "我的",
  "知道", "觉得", "记忆", "调用", "突袭", "提问", "根据", "印象",
  "适合", "比较", "这次", "嘻嘻", "啥不", "是啥", "叫嬛",
  "你知", "你知道", "知道是", "记忆调", "忆调用", "调用突", "用突袭",
  "突袭提", "袭提问", "提问根", "问根据", "根据你", "据你对", "你对我",
  "对我的", "的印", "的印象", "印象觉", "象觉得", "觉得我", "得我会",
  "我会", "会比", "会比较", "比较适", "较适合", "适合什", "合什么",
  "什么颜", "么颜色", "颜色的", "的美", "美甲呢",
]);

const QUERY_SIGNAL_TERMS = new Set([
  "选择", "决策", "决定", "模式", "方式", "风格", "偏好", "喜欢", "喜好",
  "倾向", "性格", "特质", "习惯", "忌口", "饮食", "吃面", "加蛋", "清淡", "面条", "过敏", "药物", "项目",
  "人格", "身份", "自我", "立场", "连续性",
  "亲密", "亲昵", "熟悉", "黏糊", "黏黏", "逗嘴", "接梗", "玩笑", "调戏", "退缩",
  "口吻", "语气", "表达", "自然", "客气", "客服", "工具化", "公事公办", "sop", "反客服",
  "担心", "害怕", "焦虑", "不安", "难过", "委屈", "安全感", "没得选",
  "冷淡", "生硬", "工具化", "公事公办", "生疏", "疏远", "分离", "陪我",
  "健康", "身体", "健身", "运动", "训练", "减脂", "减肥", "体重", "睡眠",
  "作息", "压力", "加班", "疲劳", "能量", "恢复",
  "装修", "关系", "家人", "父亲", "妈妈", "生日", "约定",
  "家族", "家庭", "亲属", "亲戚", "八卦", "吃瓜", "连续剧",
  "美甲", "指甲", "建构", "甲油", "甲面", "颜色", "色系", "色调", "配色",
  "审美", "粉粉", "粉色", "素色", "裸色", "裸粉", "豆沙", "低饱和",
  "嬛嬛",
  "国防部", "五角大楼", "争议", "anthropic", "openai", "grok",
  "bridge", "mossbridge", "claudecode", "压测", "死机", "保活", "掉线", "重启", "报错", "bug",
  "小说", "tavern", "剧情", "角色", "创作", "写作",
  "用户",
]);

WARM_ROUTE_SIGNAL_TERMS.forEach((term) => {
  QUERY_SIGNAL_TERMS.add(normalizeText(term).toLowerCase());
});

const ROUTE_ONLY_QUERY_FRAME_TERMS = new Set([
  "我们", "彼此", "之间",
  "us", "together",
]);

Object.entries(CONCEPT_SYNONYMS).forEach(([key, values]) => {
  QUERY_SIGNAL_TERMS.add(normalizeText(key).toLowerCase());
  values.forEach((item) => QUERY_SIGNAL_TERMS.add(normalizeText(item).toLowerCase()));
});

Object.entries(ENTITY_ALIASES).forEach(([key, values]) => {
  QUERY_SIGNAL_TERMS.add(normalizeText(key).toLowerCase());
  values.forEach((item) => QUERY_SIGNAL_TERMS.add(normalizeText(item).toLowerCase()));
});

const QUERY_NOISE_PATTERN = /^(?:我|你|她|他|它|这|那|哪|啥|呢|呀|啊|吧|吗|哈|嘻|根据|提问|记忆|调用|突袭|知道|觉得|比较|适合|印象|什么)+$/;
const QUERY_BRIDGE_NOISE_CHARS = new Set("我你她他它这那哪啥呢呀啊吧吗嘻哈的是得较么知知道忆调用突袭问根据对象会合什".split(""));
const ANSWER_TYPE_RE = /什么([^\s，。？！!?,]{2,4})/;

const EXPLICIT_WARM_RECALL_PATTERNS = [
  /还记得/i,
  /记不记得/i,
  /上次(?:说过|提过|聊过)?/i,
  /之前(?:说过|提过|聊过)?/i,
  /以前(?:说过|提过|聊过)?/i,
  /你.*?(?:对我|觉得我|印象)/i,
  /对我的印象/i,
  /根据.*?印象/i,
  /我.*?(?:偏好|习惯|风格|喜欢|讨厌|适合)/i,
  /长期.*?(?:关系|记忆|印象|偏好)/i,
];

const WARM_TOPIC_INTENT_PATTERNS = [
  /偏好|习惯|风格|喜欢|讨厌|忌口|过敏|体质|审美|美甲|颜色|色系/i,
  /关系|家人|妈妈|父亲|生日|约定|象征|信物|纪念|重要|有意义/i,
  /家族|家庭|亲属|亲戚|八卦|吃瓜|连续剧/i,
  /作息|睡眠|压力|恢复|健康|饮食|吃面|加蛋|清淡|面条|运动|训练|减脂|体重/i,
];

const AFFECTIVE_WARM_INTENT_PATTERNS = [
  /担心|害怕|焦虑|不安|难过|委屈|破防|想哭|哭了|安全感|没得选/i,
  /冷冷|冷淡|生硬|工具化|公事公办|生疏|不熟|不对劲|不像|疏远/i,
  /亲密|亲昵|熟悉|黏糊|黏黏|逗嘴|接梗|玩笑|调戏|退缩|客气|客服|sop|反客服/i,
  /亲密度|执行任务|像在(?:执行|完成)任务|不像(?:熟悉|自己|你)|不像.*?(?:熟悉|亲密|自然|你)/i,
  /失去|丢掉|离开|分离|陪我/i,
];

const OPERATIONAL_WARM_SUPPRESSION_PATTERNS = [
  /删掉|删除|撤掉|取消|关掉|清理|改一下|改掉|重新建|重建/i,
  /提醒|日历|时间|几点|时区|测试|激活|触发/i,
  /服务器|后台|服务|部署|同步|推送|github|仓库|代码|bug|报错|日志/i,
  /模型|sonnet|opus|claude|codex|token|thread|context|mcp|工具|白名单/i,
  /文件夹|目录|路径|附件|图片|inbox|outbox|case|备份|温卡|召回/i,
  /这啥|是啥|啥时候|看不懂|对不上茬/i,
];

const PHATIC_OR_REACTION_PATTERNS = [
  /^(嗯+|啊+|哦+|好+|okk+|收到|哈哈+|嘿嘿+|嘻嘻+|行吧|可以了)[~～。！!，,]*$/i,
  /^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}（）()╮╯▽¯敲打揉脸]+$/u,
];

const DEFAULT_WARM_MEMORY_RECALL_CONFIG = Object.freeze({
  scanLimit: 240,
  candidatePoolLimit: 36,
  timeFloorHours: 0.25,
  defaultDecay: 0.5,
  relationshipDecay: 0.3,
  taskDecay: 0.5,
  noiseDecay: 0.8,
  activationStorageBeta: 0.35,
  storageTransformScale: 1.0,
  storageStrengthCeiling: 3.0,
  userSemanticWeight: 0.56,
  userActivationWeight: 0.16,
  userExactWeight: 0.12,
  userCertaintyWeight: 0.08,
  userRouteWeight: 0.08,
  proactiveSemanticWeight: 0.3,
  proactiveActivationWeight: 0.3,
  proactiveExactWeight: 0.1,
  proactiveCertaintyWeight: 0.14,
  proactiveRouteWeight: 0.16,
  backgroundSemanticWeight: 0.62,
  backgroundActivationWeight: 0.24,
  backgroundExactWeight: 0.04,
  backgroundCertaintyWeight: 0.06,
  backgroundRouteWeight: 0.04,
  lowRetrievalThreshold: 0.2,
  maxStorageBoost: 2.5,
});

function buildWarmMemoryRecallPacket(
  store,
  scope,
  {
    query = "",
    limit = 6,
    materialTypes = [],
    recallMode = "user_triggered",
    config = {},
    trackRetrieval = true,
  } = {},
) {
  const normalizedQuery = normalizeText(query);
  const resolvedConfig = { ...DEFAULT_WARM_MEMORY_RECALL_CONFIG, ...(config || {}) };
  const rawQueryTokens = tokenize(normalizedQuery);
  const signalQueryTokens = buildQuerySignalTokens(rawQueryTokens);
  const answerTypes = detectAnswerTypes(normalizedQuery);
  const retrievalTokens = uniqueTokens([...signalQueryTokens, ...answerTypes]);
  const keywordMatchTokens = expandQueryTokens(retrievalTokens);
  const semanticTokens = retrievalTokens.length ? retrievalTokens : rawQueryTokens;
  const recallGate = buildWarmRecallGate({
    query: normalizedQuery,
    rawQueryTokens,
    retrievalTokens,
    answerTypes,
    recallMode,
  });
  if (recallGate.suppressed) {
    return buildEmptyWarmRecallPacket({
      scope,
      normalizedQuery,
      rawQueryTokens,
      semanticTokens,
      retrievalTokens,
      answerTypes,
      keywordMatchTokens,
      recallMode,
      recallGate,
    });
  }
  const queryTokenCounts = countTerms(semanticTokens);
  const queryNgramCounts = countTerms(
    semanticTokens.length
      ? semanticTokens.flatMap((token) => charNgrams(token))
      : charNgrams(normalizedQuery),
  );
  const candidateLimit = Math.max(Number(limit) || 6, Number(resolvedConfig.candidatePoolLimit) || 36);
  const scanLimit = Math.max(candidateLimit, Number(resolvedConfig.scanLimit) || 240);
  const candidates = store.listMaterials(scope, {
    materialTypes,
    limit: scanLimit,
  });

  const scored = candidates
    .map((row) => scoreWarmRow(row, {
      query: normalizedQuery,
      retrievalTokens,
      keywordMatchTokens,
      queryTokenCounts,
      queryNgramCounts,
      recallMode,
      config: resolvedConfig,
    }))
    .sort((left, right) => (
      right.candidateSeed - left.candidateSeed
      || right.score - left.score
      || right.routePrior - left.routePrior
    ))
    .slice(0, candidateLimit)
    .filter((item) => passesWarmRecallThreshold(item, recallMode, resolvedConfig, recallGate))
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, Number(limit) || 1));

  const recalledAt = new Date().toISOString();
  const hits = scored.map((item) => ({
    material_id: item.row.material_id,
    title: item.row.title,
    summary: item.row.summary,
    material_type: item.row.material_type,
    relative_path: item.row.relative_path || "",
    tags: Array.isArray(item.row.tags) ? item.row.tags : [],
    entities: Array.isArray(item.row.entities) ? item.row.entities : [],
    aliases: Array.isArray(item.row.aliases) ? item.row.aliases : [],
    episode_refs: Array.isArray(item.row.episode_refs) ? item.row.episode_refs : [],
    case_refs: Array.isArray(item.row.case_refs) ? item.row.case_refs : [],
    storyline_id: normalizeText(item.row.storyline_id),
    memory_family: normalizeText(item.row.memory_family),
    memory_layer: normalizeText(item.row.memory_layer),
    source_status: normalizeText(item.row.source_status),
    source_backfill_required: item.row.source_backfill_required === true,
    dreaming_review_required: item.row.dreaming_review_required === true,
    source_archive_refs: Array.isArray(item.row.source_archive_refs) ? item.row.source_archive_refs : [],
    source_trace_ids: Array.isArray(item.row.source_trace_ids) ? item.row.source_trace_ids : [],
    source_span_ids: Array.isArray(item.row.source_span_ids) ? item.row.source_span_ids : [],
    source_material_ids: Array.isArray(item.row.source_material_ids) ? item.row.source_material_ids : [],
    score: round(item.score),
    keyword_hits: item.keywordHits,
    exact_match: round(item.exactMatch),
    semantic_score: round(item.semanticScore),
    semantic_blend: round(item.semanticBlend),
    semantic_policy: item.semanticPolicy,
    activation_score: round(item.activationScore),
    certainty_score: round(item.certaintyScore),
    route_prior: round(item.routePrior),
    route_reasons: item.routeReasons,
    candidate_seed: round(item.candidateSeed),
    snippet: buildSnippet(item.row, item.keywordHits, normalizedQuery),
  }));

  const feedbackRows = trackRetrieval
    ? hits.filter((hit) => shouldApplyWarmRecallFeedback(hit, recallGate)).map((hit) => ({
      material_id: hit.material_id,
      recalled_at: recalledAt,
      storage_boost: Math.min(
        Number(resolvedConfig.maxStorageBoost) || 2.5,
        Math.max(Number(hit.activation_score) || 0, Number(hit.score) || 0) + 1,
      ),
    }))
    : [];
  if (trackRetrieval && feedbackRows.length && typeof store.applyRecallFeedback === "function") {
    store.applyRecallFeedback(scope, feedbackRows);
  }

  return {
    scope_id: scope.scopeId(),
    query: normalizedQuery,
    raw_query_tokens: rawQueryTokens,
    query_tokens: semanticTokens,
    query_signal_tokens: retrievalTokens,
    query_answer_types: answerTypes,
    keyword_match_tokens: keywordMatchTokens,
    hits,
    mode: "warm_material_recall",
    recall_mode: recallMode,
    route_tag: hits.length ? "warm_hit" : "warm_empty",
    recall_gate: recallGate,
    hit_count: hits.length,
    feedback_rows: feedbackRows,
  };
}

function buildEmptyWarmRecallPacket({
  scope,
  normalizedQuery = "",
  rawQueryTokens = [],
  semanticTokens = [],
  retrievalTokens = [],
  answerTypes = [],
  keywordMatchTokens = [],
  recallMode = "user_triggered",
  recallGate = {},
} = {}) {
  return {
    scope_id: scope.scopeId(),
    query: normalizedQuery,
    raw_query_tokens: rawQueryTokens,
    query_tokens: semanticTokens,
    query_signal_tokens: retrievalTokens,
    query_answer_types: answerTypes,
    keyword_match_tokens: keywordMatchTokens,
    hits: [],
    mode: "warm_material_recall",
    recall_mode: recallMode,
    route_tag: recallGate.route_tag || "warm_query_suppressed",
    recall_gate: recallGate,
    hit_count: 0,
    feedback_rows: [],
  };
}

function buildWarmRecallGate({
  query = "",
  retrievalTokens = [],
  answerTypes = [],
  recallMode = "user_triggered",
} = {}) {
  const normalized = normalizeText(query).toLowerCase();
  const tokenList = Array.isArray(retrievalTokens) ? retrievalTokens : [];
  const answerTypeList = Array.isArray(answerTypes) ? answerTypes : [];
  const contentChars = countQueryContentChars(normalized);
  const explicit = hasExplicitWarmRecallIntent(normalized);
  const affectiveIntent = hasAffectiveWarmIntent(normalized);
  const topicIntent = hasWarmTopicIntent(normalized, tokenList, answerTypeList);
  const operational = looksLikeOperationalWarmSuppression(normalized);
  const phatic = looksLikePhaticOrReaction(normalized, contentChars);
  const strongTokenCount = tokenList.filter((token) => isStrongRecallKeyword(token)).length;
  const ordinarySignalCount = tokenList.filter((token) => isOrdinaryWarmSignalToken(token)).length;
  const base = {
    suppressed: false,
    reason: "",
    explicit_intent: explicit,
    topic_intent: topicIntent,
    affective_intent: affectiveIntent,
    operational,
    phatic,
    content_chars: contentChars,
    strong_token_count: strongTokenCount,
    ordinary_signal_count: ordinarySignalCount,
    feedback_policy: explicit ? "explicit" : "high_confidence_only",
  };

  if (isBackgroundRecallMode(recallMode) || isProactiveRecallMode(recallMode)) {
    return {
      ...base,
      reason: "background_or_proactive",
      feedback_policy: "normal",
    };
  }

  if (!normalized) {
    return suppressWarmRecall(base, "empty_query");
  }
  if (explicit || topicIntent || affectiveIntent) {
    return {
      ...base,
      reason: explicit ? "explicit_warm_recall" : (affectiveIntent ? "affective_warm_intent" : "warm_topic_intent"),
    };
  }
  if (phatic) {
    return suppressWarmRecall(base, "phatic_or_reaction");
  }
  if (operational && strongTokenCount < 3) {
    return suppressWarmRecall(base, "operational_low_signal");
  }
  if (contentChars <= 18 && strongTokenCount < 1 && !answerTypeList.length) {
    return suppressWarmRecall(base, "short_low_signal");
  }
  if (!tokenList.length && contentChars <= 28) {
    return suppressWarmRecall(base, "no_signal_tokens");
  }
  if (strongTokenCount < 1 && ordinarySignalCount < 2 && !answerTypeList.length) {
    return suppressWarmRecall(base, "ordinary_low_signal");
  }

  return {
    ...base,
    reason: "ordinary_warm_recall",
  };
}

function suppressWarmRecall(base = {}, reason = "suppressed") {
  return {
    ...base,
    suppressed: true,
    reason,
    route_tag: "warm_query_suppressed",
    feedback_policy: "none",
  };
}

function hasExplicitWarmRecallIntent(text = "") {
  return EXPLICIT_WARM_RECALL_PATTERNS.some((pattern) => pattern.test(text));
}

function hasWarmTopicIntent(text = "", retrievalTokens = [], answerTypes = []) {
  if (WARM_TOPIC_INTENT_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }
  if ((Array.isArray(answerTypes) ? answerTypes : []).some((token) => isStrongRecallKeyword(token))) {
    return true;
  }
  const strongTokenCount = (Array.isArray(retrievalTokens) ? retrievalTokens : [])
    .filter((token) => isStrongRecallKeyword(token)).length;
  return strongTokenCount >= 2 && !looksLikeOperationalWarmSuppression(text);
}

function hasAffectiveWarmIntent(text = "") {
  return AFFECTIVE_WARM_INTENT_PATTERNS.some((pattern) => pattern.test(text));
}

function looksLikeOperationalWarmSuppression(text = "") {
  return OPERATIONAL_WARM_SUPPRESSION_PATTERNS.some((pattern) => pattern.test(text));
}

function looksLikePhaticOrReaction(text = "", contentChars = 0) {
  if (Number(contentChars) <= 2) {
    return true;
  }
  return PHATIC_OR_REACTION_PATTERNS.some((pattern) => pattern.test(text));
}

function countQueryContentChars(text = "") {
  return Array.from(normalizeText(text))
    .filter((char) => /[a-z0-9\u4e00-\u9fff]/i.test(char))
    .length;
}

function shouldApplyWarmRecallFeedback(hit = {}, recallGate = {}) {
  if (recallGate?.suppressed || recallGate?.feedback_policy === "none") {
    return false;
  }
  if (recallGate?.feedback_policy === "normal" || recallGate?.feedback_policy === "explicit") {
    return true;
  }
  const score = Number(hit.score) || 0;
  const semanticBlend = Number(hit.semantic_blend) || 0;
  const semanticScore = Number(hit.semantic_score) || 0;
  const exactMatch = Number(hit.exact_match) || 0;
  const hasStrongKeywordHit = Array.isArray(hit.keyword_hits)
    && hit.keyword_hits.some((token) => isStrongRecallKeyword(token));
  return score >= 0.42
    && semanticBlend >= 0.14
    && (hasStrongKeywordHit || exactMatch > 0 || semanticScore >= 0.08);
}

function scoreWarmRow(
  row,
  {
    query,
    retrievalTokens,
    keywordMatchTokens,
    queryTokenCounts,
    queryNgramCounts,
    recallMode,
    config,
  },
) {
  const title = normalizeText(row.title).toLowerCase();
  const summary = normalizeText(row.summary).toLowerCase();
  const body = normalizeText(row.body_markdown).toLowerCase();
  const tags = Array.isArray(row.tags) ? row.tags.map((item) => normalizeText(item).toLowerCase()) : [];
  const entities = Array.isArray(row.entities) ? row.entities.map((item) => normalizeText(item).toLowerCase()) : [];
  const aliases = Array.isArray(row.aliases) ? row.aliases.map((item) => normalizeText(item).toLowerCase()) : [];
  const episodeRefs = Array.isArray(row.episode_refs) ? row.episode_refs.map((item) => normalizeText(item).toLowerCase()) : [];
  const caseRefs = Array.isArray(row.case_refs) ? row.case_refs.map((item) => normalizeText(item).toLowerCase()) : [];
  const structured = [
    tags.join(" "),
    entities.join(" "),
    aliases.join(" "),
    episodeRefs.join(" "),
    caseRefs.join(" "),
    normalizeText(row.storyline_id).toLowerCase(),
    normalizeText(row.memory_family).toLowerCase(),
  ].join(" ");
  const blob = [title, summary, body, structured].join("\n");
  const keywordHits = uniqueTokens((keywordMatchTokens || []).filter((token) => token && blob.includes(token)));
  const coreKeywordHits = (retrievalTokens || []).filter((token) => token && blob.includes(token));
  const exactMatch = query && (blob.includes(query.toLowerCase()) || title === query.toLowerCase()) ? 1 : 0;

  const rowTokenCounts = countTerms(Array.isArray(row.keywords) ? row.keywords : []);
  const rowNgramCounts = countTerms(Array.isArray(row.ngrams)
    ? row.ngrams
    : (Array.isArray(row.char_ngrams) ? row.char_ngrams : []));
  const lexicalScore = retrievalTokens.length ? coreKeywordHits.length / retrievalTokens.length : 0;
  const semanticScore = clamp(
    (cosineSimilarity(queryTokenCounts, rowTokenCounts) * 0.65)
      + (cosineSimilarity(queryNgramCounts, rowNgramCounts) * 0.35),
  );
  const semanticSimilarity = buildSemanticSimilarity({
    keywordHits: coreKeywordHits,
    queryTokens: retrievalTokens,
    lexicalScore,
    semanticScore,
    recallMode,
  });
  const activationScore = clamp(buildActivationScore(row, config));
  const certaintyScore = clamp(buildCertaintyScore(row));
  const routeInfo = buildWarmRoutePrior(row, {
    queryTokens: retrievalTokens,
    recallMode,
    exactMatch,
    keywordHits: coreKeywordHits,
  });
  const {
    semanticWeight,
    activationWeight,
    exactWeight,
    certaintyWeight,
    routeWeight,
  } = selectRecallWeights(config, recallMode);
  const candidateSeed = buildCandidateSeed({
    exactMatch,
    semanticBlend: semanticSimilarity.combined,
    activationScore,
    routePrior: routeInfo.routePrior,
    recallMode,
  });

  const score = clamp(
    (semanticSimilarity.combined * semanticWeight)
      + (activationScore * activationWeight)
      + (exactMatch * exactWeight)
      + (certaintyScore * certaintyWeight)
      + (routeInfo.routePrior * routeWeight),
    0,
    4,
  );

  return {
    row,
    keywordHits,
    exactMatch,
    lexicalScore,
    semanticScore,
    semanticBlend: semanticSimilarity.combined,
    semanticPolicy: semanticSimilarity.policy,
    activationScore,
    certaintyScore,
    routePrior: routeInfo.routePrior,
    routeReasons: routeInfo.routeReasons,
    candidateSeed,
    score,
  };
}

function selectRecallWeights(config = DEFAULT_WARM_MEMORY_RECALL_CONFIG, recallMode = "user_triggered") {
  if (isBackgroundRecallMode(recallMode)) {
    return {
      semanticWeight: Number(config.backgroundSemanticWeight) || 0.62,
      activationWeight: Number(config.backgroundActivationWeight) || 0.24,
      exactWeight: Number(config.backgroundExactWeight) || 0.04,
      certaintyWeight: Number(config.backgroundCertaintyWeight) || 0.06,
      routeWeight: Number(config.backgroundRouteWeight) || 0.04,
    };
  }
  if (isProactiveRecallMode(recallMode)) {
    return {
      semanticWeight: Number(config.proactiveSemanticWeight) || 0.3,
      activationWeight: Number(config.proactiveActivationWeight) || 0.3,
      exactWeight: Number(config.proactiveExactWeight) || 0.1,
      certaintyWeight: Number(config.proactiveCertaintyWeight) || 0.14,
      routeWeight: Number(config.proactiveRouteWeight) || 0.16,
    };
  }
  return {
    semanticWeight: Number(config.userSemanticWeight) || 0.56,
    activationWeight: Number(config.userActivationWeight) || 0.16,
    exactWeight: Number(config.userExactWeight) || 0.12,
    certaintyWeight: Number(config.userCertaintyWeight) || 0.08,
    routeWeight: Number(config.userRouteWeight) || 0.08,
  };
}

function buildSemanticSimilarity({
  keywordHits = [],
  queryTokens = [],
  lexicalScore = 0,
  semanticScore = 0,
  recallMode = "user_triggered",
} = {}) {
  const hitCount = Number((Array.isArray(keywordHits) ? new Set(keywordHits).size : 0));
  const keywordRatio = hitCount > 0 ? Math.min(1, 1 - Math.exp(-0.7 * hitCount)) : 0;
  const lexical = clamp(lexicalScore);
  const semantic = clamp(semanticScore);
  if (isBackgroundRecallMode(recallMode)) {
    return {
      combined: clamp((semantic * 0.62) + (lexical * 0.25) + (keywordRatio * 0.13)),
      policy: "semantic_background_recall",
    };
  }
  if (isProactiveRecallMode(recallMode)) {
    return {
      combined: clamp((semantic * 0.45) + (lexical * 0.32) + (keywordRatio * 0.23)),
      policy: "proactive_balanced_recall",
    };
  }
  return {
    combined: clamp((keywordRatio * 0.45) + (lexical * 0.3) + (semantic * 0.25)),
    policy: "explicit_search_anchor",
  };
}

function buildCandidateSeed({
  exactMatch = 0,
  semanticBlend = 0,
  activationScore = 0,
  routePrior = 0,
  recallMode = "user_triggered",
} = {}) {
  if (isBackgroundRecallMode(recallMode)) {
    return round((semanticBlend * 0.88) + (exactMatch * 0.12));
  }
  if (isProactiveRecallMode(recallMode)) {
    return round(
      (semanticBlend * 0.45)
      + (routePrior * 0.28)
      + (exactMatch * 0.15)
      + (activationScore * 0.12),
    );
  }
  return round(
    (semanticBlend * 0.56)
    + (exactMatch * 0.16)
    + (routePrior * 0.16)
    + (activationScore * 0.12),
  );
}

function passesWarmRecallThreshold(item, recallMode, config = DEFAULT_WARM_MEMORY_RECALL_CONFIG, recallGate = {}) {
  const threshold = Number(config.lowRetrievalThreshold) || 0.2;
  if ((Number(item?.exactMatch) || 0) > 0) {
    return true;
  }
  const exactMatch = Number(item?.exactMatch) || 0;
  const score = Number(item?.score) || 0;
  const semanticBlend = Number(item?.semanticBlend) || 0;
  const semanticScore = Number(item?.semanticScore) || 0;
  const lexicalScore = Number(item?.lexicalScore) || 0;
  const routePrior = Number(item?.routePrior) || 0;
  const hasStrongKeywordHit = Array.isArray(item?.keywordHits)
    && item.keywordHits.some((token) => isStrongRecallKeyword(token));
  const voiceRow = hasWarmVoiceRoutingAnchor(item?.row);
  const explicitResidentRow = item?.row?.resident === true;
  if (!isBackgroundRecallMode(recallMode) && !isProactiveRecallMode(recallMode)) {
    if (
      recallGate?.affective_intent
      && exactMatch <= 0
      && !voiceRow
      && !explicitResidentRow
      && (!Array.isArray(item?.keywordHits) || item.keywordHits.length <= 1)
    ) {
      return false;
    }
    const semanticFloor = Number(config.userMinimumSemanticBlend) || 0.065;
    const routeFloor = Number(config.userMinimumRoutePrior) || 0.12;
    const semanticScoreFloor = Number(config.userMinimumSemanticScore) || 0.03;
    const lexicalFloor = Number(config.userMinimumLexicalScore) || 0.08;
    if (hasStrongKeywordHit && (semanticScore >= semanticScoreFloor || lexicalScore >= lexicalFloor)) {
      return true;
    }
    if (
      recallGate?.affective_intent
      && hasStrongKeywordHit
      && (routePrior >= 0.05 || lexicalScore >= (lexicalFloor * 0.65) || semanticScore >= (semanticScoreFloor * 0.65))
    ) {
      return true;
    }
    return score > threshold && (
      (semanticBlend >= semanticFloor && semanticScore >= semanticScoreFloor)
      || (routePrior >= routeFloor && lexicalScore >= lexicalFloor)
    );
  }
  if (Array.isArray(item?.keywordHits) && item.keywordHits.length) {
    return true;
  }
  if (score > threshold) {
    return true;
  }
  if (isProactiveRecallMode(recallMode) && (Number(item?.routePrior) || 0) >= 0.18) {
    return true;
  }
  return false;
}

function hasWarmVoiceRoutingAnchor(row = {}) {
  const haystack = [
    row?.title,
    Array.isArray(row?.tags) ? row.tags.join(" ") : "",
    Array.isArray(row?.aliases) ? row.aliases.join(" ") : "",
    normalizeText(row?.memory_family),
    normalizeText(row?.storyline_id),
  ]
    .map((item) => normalizeText(item).toLowerCase())
    .filter(Boolean)
    .join(" ");
  return /voice|expression|style|anti-sop|sop|口吻|语气|表达|接梗|逗嘴|玩笑|反客服|工具化|客气|亲密|熟悉|黏糊|黏黏/i.test(haystack);
}

function isStrongRecallKeyword(token = "") {
  const clean = normalizeText(token).toLowerCase();
  if (!clean || QUERY_STOP_TOKENS.has(clean) || QUERY_NOISE_PATTERN.test(clean)) {
    return false;
  }
  if (ROUTE_ONLY_QUERY_FRAME_TERMS.has(clean)) {
    return false;
  }
  if (/^[a-z0-9_-]{4,}$/i.test(clean)) {
    return true;
  }
  if (/^[\u4e00-\u9fff]{4,}$/.test(clean)) {
    return true;
  }
  return QUERY_SIGNAL_TERMS.has(clean);
}

function isOrdinaryWarmSignalToken(token = "") {
  const clean = normalizeText(token).toLowerCase();
  if (!clean || ROUTE_ONLY_QUERY_FRAME_TERMS.has(clean) || QUERY_STOP_TOKENS.has(clean) || QUERY_NOISE_PATTERN.test(clean)) {
    return false;
  }
  return isStrongRecallKeyword(clean) || /^[a-z0-9_-]{4,}$/i.test(clean) || /^[\u4e00-\u9fff]{4,}$/.test(clean);
}

function buildActivationScore(row, config = DEFAULT_WARM_MEMORY_RECALL_CONFIG) {
  const retrievalCurve = buildRetrievalCurve(row, config);
  const storageStrength = buildStorageStrength(row, config);
  const activationRaw = retrievalCurve.actrRaw + (Number(config.activationStorageBeta) || 0.35) * storageStrength;
  return sigmoid(activationRaw);
}

function buildCertaintyScore(row) {
  const state = normalizeText(row.certainty_state).toLowerCase();
  if (state === "anchor") {
    return 1;
  }
  if (state === "settled") {
    return 1;
  }
  if (state === "tentative") {
    return 0.45;
  }
  if (state === "conflict_open") {
    return 0.1;
  }
  return 0.25;
}

function buildSnippet(row, keywordHits, query) {
  const summary = normalizeText(row.summary);
  if (summary) {
    return summary;
  }
  const body = normalizeText(row.body_markdown);
  if (!body) {
    return "";
  }
  const anchors = keywordHits.length ? keywordHits : [query];
  for (const anchor of anchors) {
    const target = normalizeText(anchor).toLowerCase();
    if (!target) {
      continue;
    }
    const blob = body.toLowerCase();
    const position = blob.indexOf(target);
    if (position >= 0) {
      const start = Math.max(0, position - 80);
      const end = Math.min(body.length, position + target.length + 220);
      const snippet = body.slice(start, end).replace(/\s+/g, " ").trim();
      return start > 0 ? `…${snippet}` : snippet;
    }
  }
  const compact = body.replace(/\s+/g, " ").trim();
  return compact.length > 300 ? `${compact.slice(0, 299)}…` : compact;
}

function cosineSimilarity(left, right) {
  const leftKeys = Object.keys(left || {});
  const rightKeys = Object.keys(right || {});
  if (!leftKeys.length || !rightKeys.length) {
    return 0;
  }
  const dot = leftKeys.reduce((sum, key) => sum + ((left[key] || 0) * (right[key] || 0)), 0);
  if (dot <= 0) {
    return 0;
  }
  const leftNorm = Math.sqrt(leftKeys.reduce((sum, key) => sum + ((left[key] || 0) ** 2), 0));
  const rightNorm = Math.sqrt(rightKeys.reduce((sum, key) => sum + ((right[key] || 0) ** 2), 0));
  if (!leftNorm || !rightNorm) {
    return 0;
  }
  return dot / (leftNorm * rightNorm);
}

function countTerms(items) {
  const output = {};
  (Array.isArray(items) ? items : []).forEach((item) => {
    const key = normalizeText(item);
    if (!key) {
      return;
    }
    output[key] = (output[key] || 0) + 1;
  });
  return output;
}

function expandQueryTokens(tokens = []) {
  const seen = new Set();
  const expanded = [];
  (Array.isArray(tokens) ? tokens : []).forEach((token) => {
    const clean = normalizeText(token).toLowerCase();
    if (!clean || seen.has(clean)) {
      return;
    }
    seen.add(clean);
    expanded.push(clean);
    (CONCEPT_SYNONYMS[clean] || []).forEach((item) => {
      const synonym = normalizeText(item).toLowerCase();
      if (!synonym || seen.has(synonym)) {
        return;
      }
      seen.add(synonym);
      expanded.push(synonym);
    });
    (ENTITY_ALIASES[clean] || []).forEach((item) => {
      const alias = normalizeText(item).toLowerCase();
      if (!alias || seen.has(alias)) {
        return;
      }
      seen.add(alias);
      expanded.push(alias);
    });
  });
  return expanded;
}

function detectAnswerTypes(query = "") {
  const normalizedQuery = normalizeText(query).toLowerCase();
  if (!normalizedQuery) {
    return [];
  }
  const match = ANSWER_TYPE_RE.exec(normalizedQuery);
  if (!match) {
    return [];
  }
  const base = sanitizeAnswerType(match[1]);
  return uniqueTokens([base, ...(CONCEPT_SYNONYMS[base] || [])]);
}

function buildQuerySignalTokens(rawTokens = []) {
  const tokens = Array.isArray(rawTokens) ? rawTokens : [];
  const seen = new Set();
  const output = [];

  const addToken = (token) => {
    const clean = normalizeText(token).toLowerCase();
    if (!clean || seen.has(clean) || shouldDiscardQuerySignalToken(clean)) {
      return;
    }
    seen.add(clean);
    output.push(clean);
  };

  tokens.forEach((token) => {
    const clean = normalizeText(token).toLowerCase();
    if (!clean || shouldDiscardQuerySignalToken(clean)) {
      return;
    }
    if (clean.length >= 8) {
      const embedded = Array.from(QUERY_SIGNAL_TERMS)
        .filter((term) => term.length >= 2 && clean.includes(term))
        .sort((left, right) => right.length - left.length || left.localeCompare(right));
      if (embedded.length) {
        embedded.forEach(addToken);
        return;
      }
      if (/[\u4e00-\u9fff]/.test(clean)) {
        return;
      }
    }
    addToken(clean);
  });

  return output.length ? output : buildFallbackQuerySignalTokens(tokens);
}

function buildFallbackQuerySignalTokens(tokens = []) {
  const seen = new Set();
  const output = [];
  (Array.isArray(tokens) ? tokens : []).forEach((token) => {
    const clean = normalizeText(token).toLowerCase();
    if (!clean || seen.has(clean) || shouldDiscardQuerySignalToken(clean)) {
      return;
    }
    if (/^[a-z0-9_-]{4,}$/i.test(clean)) {
      seen.add(clean);
      output.push(clean);
      return;
    }
    if (/^[\u4e00-\u9fff]{4,}$/.test(clean)) {
      seen.add(clean);
      output.push(clean);
    }
  });
  return output;
}

function shouldDiscardQuerySignalToken(token = "") {
  const clean = normalizeText(token).toLowerCase();
  if (!clean || QUERY_STOP_TOKENS.has(clean) || QUERY_NOISE_PATTERN.test(clean)) {
    return true;
  }
  if (looksLikePathOrAttachmentMetaToken(clean)) {
    return true;
  }
  if (
    clean.length >= 2
    && clean.length <= 3
    && /^[\u4e00-\u9fff]+$/.test(clean)
    && !QUERY_SIGNAL_TERMS.has(clean)
    && clean.split("").some((char) => QUERY_BRIDGE_NOISE_CHARS.has(char))
  ) {
    return true;
  }
  return false;
}

function looksLikePathOrAttachmentMetaToken(token = "") {
  const clean = normalizeText(token).toLowerCase();
  if (!clean) {
    return false;
  }
  if (/^(?:bridge|mossbridge|home|owner|workspace|workspaces|inbox|outbox|attachment|sticker|image|file|data|storage|srv|asherie)[_-]/i.test(clean)) {
    return true;
  }
  return /^(?:png|jpe?g|webp|gif|pdf|docx?|xlsx?|jsonl?|md|txt)$/i.test(clean);
}

function uniqueTokens(tokens = []) {
  const seen = new Set();
  const output = [];
  (Array.isArray(tokens) ? tokens : []).forEach((token) => {
    const clean = normalizeText(token).toLowerCase();
    if (!clean || seen.has(clean)) {
      return;
    }
    seen.add(clean);
    output.push(clean);
  });
  return output;
}

function sanitizeAnswerType(value) {
  let normalized = normalizeText(value).toLowerCase();
  while (normalized.length > 2 && /[呢呀啊吗吧哈哦喔啦]/.test(normalized.slice(-1))) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function parseIso(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildStorageStrength(row, config = DEFAULT_WARM_MEMORY_RECALL_CONFIG) {
  const explicitValue = Math.max(0, Number(row.storage_strength) || 0);
  const scaledExplicit = explicitValue * Math.max(0.1, Number(config.storageTransformScale) || 1);
  const compressedExplicit = scaledExplicit > 0 ? Math.log1p(scaledExplicit) : 0;
  const writeCount = Math.max(1, Number(row.write_count) || 1);
  const recallCount = Math.max(0, Number(row.recall_count) || 0);
  const storageBoost = Math.max(1, Number(row.storage_boost) || 1);
  const fallback = 0.55 + Math.max(0, writeCount - 1) * 0.14 + recallCount * 0.08;
  const base = compressedExplicit > 0 ? compressedExplicit : fallback;
  const ceiling = Math.max(0.5, Number(config.storageStrengthCeiling) || 3);
  return round(Math.min(ceiling, Math.max(0.1, base * storageBoost)));
}

function buildRetrievalCurve(row, config = DEFAULT_WARM_MEMORY_RECALL_CONFIG) {
  const accessLog = Array.isArray(row.access_log)
    ? row.access_log.filter((item) => parseIso(item))
    : [];
  const seededLog = accessLog.length
    ? accessLog
    : [row.last_accessed_at || row.updated_at || row.created_at].filter(Boolean);
  let summation = 0;
  let mentionCount = 0;
  const decay = decayForRow(row, config);
  seededLog.forEach((stamp) => {
    const parsed = parseIso(stamp);
    if (!parsed) {
      return;
    }
    const deltaHours = Math.max((Date.now() - parsed.getTime()) / (60 * 60 * 1000), 0);
    summation += Math.pow(deltaHours + Math.max(0.01, Number(config.timeFloorHours) || 0.25), -Math.max(0.01, decay));
    mentionCount += 1;
  });
  const actrRaw = summation > 0 ? Math.log(summation) : -8;
  return {
    mentionCount,
    actrRaw,
    retrievalStrength: sigmoid(actrRaw),
    decay,
  };
}

function decayForRow(row, config = DEFAULT_WARM_MEMORY_RECALL_CONFIG) {
  const tags = Array.isArray(row.tags) ? row.tags.map((item) => normalizeText(item).toLowerCase()) : [];
  const title = normalizeText(row.title).toLowerCase();
  const materialType = normalizeText(row.material_type).toLowerCase();
  const haystack = [title, materialType, ...tags].join(" ");
  const relationshipHints = ["relationship", "identity", "anchor", "persona", "关系", "身份", "锚点", "偏好"];
  const taskHints = ["task", "project", "plan", "todo", "任务", "项目", "计划"];
  const noiseHints = ["noise", "mood", "fleeting", "碎片", "噪声", "随手"];
  if (relationshipHints.some((item) => haystack.includes(item))) {
    return Number(config.relationshipDecay) || 0.3;
  }
  if (noiseHints.some((item) => haystack.includes(item)) || materialType === "snippet" || materialType === "note") {
    return Number(config.noiseDecay) || 0.8;
  }
  if (taskHints.some((item) => haystack.includes(item)) || materialType === "diary" || materialType === "journal") {
    return Number(config.taskDecay) || 0.5;
  }
  return Number(config.defaultDecay) || 0.5;
}

function sigmoid(value) {
  const numeric = Number(value) || 0;
  if (numeric >= 32) {
    return 1;
  }
  if (numeric <= -32) {
    return 0;
  }
  return 1 / (1 + Math.exp(-numeric));
}

function clamp(value, lower = 0, upper = 1) {
  return Math.max(lower, Math.min(upper, Number(value) || 0));
}

function round(value) {
  return Math.round((Number(value) || 0) * 10000) / 10000;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  DEFAULT_WARM_MEMORY_RECALL_CONFIG,
  buildWarmMemoryRecallPacket,
};
