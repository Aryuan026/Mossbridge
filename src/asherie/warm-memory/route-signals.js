const RELATIONSHIP_ROW_TERMS = Object.freeze([
  "relationship", "bond", "anchor", "meaningful", "important", "intimate", "intimacy",
  "voice", "expression", "style", "playful", "tease", "warmth", "anti-sop",
  "关系", "重要", "珍贵", "有意义", "锚点", "陪伴", "牵绊", "羁绊",
  "亲密", "亲昵", "熟悉", "黏糊", "黏黏", "接梗", "逗嘴", "玩笑", "撒娇",
  "口吻", "语气", "表达", "反客服", "客气", "工具化",
]);

const FAMILY_STORY_ROW_TERMS = Object.freeze([
  "family", "gossip", "story",
  "家族", "家庭", "亲属", "亲戚", "八卦", "吃瓜", "连续剧",
]);

const IDENTITY_ROW_TERMS = Object.freeze([
  "identity", "persona", "self", "role",
  "身份", "自我", "角色",
]);

const SYMBOLIC_ROW_TERMS = Object.freeze([
  "symbol", "symbolic", "keepsake", "memento", "token",
  "象征", "信物", "纪念", "纪念物", "象征物", "寄托",
]);

const OBJECT_ROW_TERMS = Object.freeze([
  "necklace", "ring", "bracelet", "gift", "letter", "photo", "locket",
  "项链", "戒指", "手链", "礼物", "照片", "相片", "信件", "书信", "合照",
]);

const BROAD_IMPORTANCE_QUERY_TERMS = Object.freeze([
  "important", "meaningful", "precious", "special",
  "重要", "有意义", "珍贵", "特别", "在意",
]);

const RELATIONAL_QUERY_TERMS = Object.freeze([
  "relationship", "bond", "us", "together", "intimacy", "voice", "expression", "playful", "tease",
  "关系", "我们", "彼此", "之间", "亲密", "亲昵", "熟悉", "黏糊", "黏黏",
  "接梗", "逗嘴", "玩笑", "撒娇", "调戏", "退缩", "口吻", "语气", "表达",
  "反客服", "客气", "工具化", "公事公办",
]);

const SYMBOLIC_QUERY_TERMS = Object.freeze([
  "symbol", "symbolic", "keepsake", "memento", "token",
  "象征", "信物", "纪念", "纪念物", "象征物",
]);

const OBJECT_QUERY_TERMS = Object.freeze([
  "necklace", "ring", "bracelet", "gift", "letter", "photo", "locket",
  "项链", "戒指", "手链", "礼物", "照片", "相片", "信件", "书信",
]);

const WARM_ROUTE_SIGNAL_TERMS = Object.freeze(Array.from(new Set([
  ...RELATIONSHIP_ROW_TERMS,
  ...FAMILY_STORY_ROW_TERMS,
  ...SYMBOLIC_ROW_TERMS,
  ...OBJECT_ROW_TERMS,
  ...BROAD_IMPORTANCE_QUERY_TERMS,
  ...RELATIONAL_QUERY_TERMS,
  ...SYMBOLIC_QUERY_TERMS,
  ...OBJECT_QUERY_TERMS,
])));

function buildWarmRouteSignals(row = {}, queryTokens = []) {
  const title = normalizeText(row.title).toLowerCase();
  const summary = normalizeText(row.summary).toLowerCase();
  const body = normalizeText(row.body_markdown).toLowerCase();
  const tags = Array.isArray(row.tags) ? row.tags.map((item) => normalizeText(item).toLowerCase()) : [];
  const entities = Array.isArray(row.entities) ? row.entities.map((item) => normalizeText(item).toLowerCase()) : [];
  const aliases = Array.isArray(row.aliases) ? row.aliases.map((item) => normalizeText(item).toLowerCase()) : [];
  const materialType = normalizeText(row.material_type).toLowerCase();
  const memoryFamily = normalizeText(row.memory_family).toLowerCase();
  const storylineId = normalizeText(row.storyline_id).toLowerCase();
  const haystack = [
    title,
    summary,
    body,
    tags.join(" "),
    entities.join(" "),
    aliases.join(" "),
    memoryFamily,
    storylineId,
    materialType,
  ].filter(Boolean).join("\n");
  const querySet = new Set((Array.isArray(queryTokens) ? queryTokens : []).map((item) => normalizeText(item).toLowerCase()).filter(Boolean));

  return {
    relationshipTagged: textContainsAny(haystack, RELATIONSHIP_ROW_TERMS),
    identityTagged: textContainsAny(haystack, IDENTITY_ROW_TERMS),
    symbolicTagged: textContainsAny(haystack, SYMBOLIC_ROW_TERMS),
    objectTagged: textContainsAny(haystack, OBJECT_ROW_TERMS),
    familyStoryTagged: isFamilyStoryRow(row, haystack),
    queryBroadImportance: queryHasAny(querySet, BROAD_IMPORTANCE_QUERY_TERMS),
    queryRelational: queryHasAny(querySet, RELATIONAL_QUERY_TERMS),
    querySymbolic: queryHasAny(querySet, SYMBOLIC_QUERY_TERMS),
    queryObject: queryHasAny(querySet, OBJECT_QUERY_TERMS),
  };
}

function buildWarmRoutePrior(
  row,
  {
    queryTokens = [],
    recallMode = "",
    exactMatch = 0,
    keywordHits = [],
  } = {},
) {
  const signals = buildWarmRouteSignals(row, queryTokens);
  const reasons = [];
  let score = 0;

  if (signals.relationshipTagged) {
    score += 0.05;
    reasons.push("relationship_anchor");
  }
  if (isResidentAnchorRow(row)) {
    score += 0.16;
    reasons.push("resident_anchor");
  }
  if (signals.identityTagged && !signals.relationshipTagged) {
    score += 0.03;
    reasons.push("identity_anchor");
  }
  if (signals.familyStoryTagged) {
    score += 0.1;
    reasons.push("family_story");
  }
  if (isProactiveRecallMode(recallMode) && signals.symbolicTagged) {
    score += 0.12;
    reasons.push("proactive_symbolic");
  }
  if (isProactiveRecallMode(recallMode) && signals.objectTagged) {
    score += 0.09;
    reasons.push("proactive_object");
  }
  if (signals.queryBroadImportance && (signals.relationshipTagged || signals.symbolicTagged || signals.objectTagged)) {
    score += 0.14;
    reasons.push("importance_bridge");
  }
  if (signals.queryRelational && (signals.relationshipTagged || signals.identityTagged)) {
    score += 0.12;
    reasons.push("relation_bridge");
  }
  if (signals.querySymbolic && (signals.symbolicTagged || signals.objectTagged)) {
    score += 0.13;
    reasons.push("symbolic_bridge");
  }
  if (signals.queryObject && signals.objectTagged) {
    score += 0.15;
    reasons.push("object_bridge");
  }
  if (Number(exactMatch) >= 0.8) {
    score += 0.08;
    reasons.push("exact_anchor");
  } else if (Number(exactMatch) >= 0.5) {
    score += 0.05;
    reasons.push("partial_anchor");
  }
  if ((Array.isArray(keywordHits) ? keywordHits.length : 0) > 0 && (signals.relationshipTagged || signals.symbolicTagged || signals.objectTagged)) {
    score += 0.04;
    reasons.push("keyword_bridge");
  }

  return {
    routePrior: round(clamp(score, 0, 0.72)),
    routeReasons: Array.from(new Set(reasons)),
    routeSignals: signals,
  };
}

function buildWarmRouteScanBonus(row = {}) {
  const signals = buildWarmRouteSignals(row, []);
  const reasons = [];
  let score = 0;

  if (signals.relationshipTagged) {
    score += 0.18;
    reasons.push("relationship_anchor");
  }
  if (isResidentAnchorRow(row)) {
    score += 0.26;
    reasons.push("resident_anchor");
  }
  if (signals.symbolicTagged) {
    score += 0.14;
    reasons.push("symbolic_anchor");
  }
  if (signals.objectTagged) {
    score += 0.08;
    reasons.push("object_anchor");
  }
  if (signals.identityTagged && !signals.relationshipTagged) {
    score += 0.06;
    reasons.push("identity_anchor");
  }
  if (signals.familyStoryTagged) {
    score += 0.12;
    reasons.push("family_story");
  }

  return {
    score: round(clamp(score, 0, 0.42)),
    reasons,
  };
}

function normalizeRecallMode(recallMode) {
  return normalizeText(recallMode).toLowerCase();
}

function isBackgroundRecallMode(recallMode) {
  return ["background_recall", "background", "auto_recall"].includes(normalizeRecallMode(recallMode));
}

function isProactiveRecallMode(recallMode) {
  return normalizeRecallMode(recallMode) === "proactive";
}

function isResidentAnchorRow(row = {}) {
  if (row?.pinned === true) {
    return true;
  }
  return normalizeText(row?.certainty_state).toLowerCase() === "anchor";
}

function isFamilyStoryRow(row = {}, haystack = "") {
  const memoryFamily = normalizeText(row.memory_family).toLowerCase();
  if (["family_story", "ongoing_story", "storyline", "gossip_thread"].includes(memoryFamily)) {
    return true;
  }
  if (normalizeText(row.storyline_id)) {
    return true;
  }
  return textContainsAny(haystack, FAMILY_STORY_ROW_TERMS);
}

function textContainsAny(haystack, terms) {
  return terms.some((term) => haystack.includes(normalizeText(term).toLowerCase()));
}

function queryHasAny(querySet, terms) {
  return terms.some((term) => querySet.has(normalizeText(term).toLowerCase()));
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
  WARM_ROUTE_SIGNAL_TERMS,
  buildWarmRouteSignals,
  buildWarmRoutePrior,
  buildWarmRouteScanBonus,
  isBackgroundRecallMode,
  isProactiveRecallMode,
  normalizeRecallMode,
};
