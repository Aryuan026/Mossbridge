const { buildWarmMemoryRecallPacket } = require("./warm-memory/search");

const AMBIENT_POSITIVE_TERMS = [
  "relationship", "identity", "continuity", "companion", "collaboration", "preference", "habit",
  "style", "ritual", "bond", "persona", "soul", "voice", "expression", "intimacy",
  "playful", "tease", "warmth", "anti-sop",
  "关系", "身份", "连续", "默契", "相处", "陪伴", "协作", "偏好", "习惯", "风格", "审美", "作息", "称呼", "亲密",
  "亲昵", "熟悉", "黏糊", "黏黏", "接梗", "逗嘴", "玩笑", "撒娇", "口吻", "语气", "表达", "反客服",
];
const AMBIENT_NEGATIVE_TERMS = [
  "task", "project", "case", "debug", "bug", "deploy", "server", "github", "mcp", "tool", "token",
  "session", "context", "runtime", "wakeup", "dreaming", "calendar", "reminder", "episode", "reading",
  "book", "pdf", "attachment", "file", "inbox", "wechat", "bridge", "mossbridge", "family", "gossip",
  "任务", "项目", "案例", "调试", "报错", "部署", "服务器", "工具", "权限", "白名单", "令牌",
  "上下文", "线程", "唤醒", "心跳", "日历", "提醒", "小事记", "共读", "读书", "书", "附件",
  "文件", "上传", "图片", "照片", "微信", "提示词", "代码", "仓库", "备份", "设备", "预约",
  "家族", "家庭", "亲属", "亲戚", "八卦",
];
const AMBIENT_HARD_NEGATIVE_TERMS = [
  "project", "case", "debug", "bug", "deploy", "server", "github", "mcp", "token",
  "session", "runtime", "wakeup", "dreaming", "calendar", "reminder", "episode", "reading",
  "book", "pdf", "attachment", "file", "inbox", "wechat", "bridge", "mossbridge", "family", "gossip",
  "项目", "案例", "调试", "报错", "部署", "服务器", "权限", "白名单", "令牌",
  "上下文", "线程", "唤醒", "心跳", "日历", "提醒", "小事记", "共读", "读书", "书", "附件",
  "文件", "上传", "图片", "照片", "微信", "提示词", "代码", "仓库", "备份", "设备", "预约",
  "家族", "家庭", "亲属", "亲戚", "八卦",
];
const AMBIENT_VOICE_ANCHOR_TERMS = [
  "voice", "expression", "style", "intimacy", "playful", "tease", "anti-sop",
  "亲密", "亲昵", "熟悉", "黏糊", "黏黏", "接梗", "逗嘴", "玩笑", "撒娇",
  "口吻", "语气", "表达", "反客服", "客气", "工具化", "公事公办", "sop",
];
const AMBIENT_WORK_ARTIFACT_TERMS = [
  "benchmark", "evaluation", "regression", "deploy", "deployment", "server",
  "github", "mcp", "token", "session", "runtime", "claudecode", "codex", "hippocove",
  "mossbridge", "cyberboss", "coverage", "pytest", "unittest",
  "评测", "测试", "回归", "部署", "服务器", "仓库", "接口", "权限", "白名单",
  "令牌", "上下文", "线程", "工具", "代码", "单测", "冒烟", "冷树", "冷记忆树",
];
const AGENT_CHAR_SELF_AXIS_TERMS = [
  "relationship", "identity", "continuity", "companion", "collaboration", "preference", "habit",
  "style", "ritual", "bond", "persona", "soul", "self", "voice", "expression", "intimacy",
  "attachment", "repair", "tease", "playful", "warmth", "aesthetic",
  "关系", "身份", "连续", "默契", "相处", "陪伴", "协作", "偏好", "习惯", "风格", "审美",
  "称呼", "亲密", "自我", "声音", "表达", "口吻", "语气", "接梗", "玩笑", "逗嘴", "黏",
  "修复", "靠近", "信任", "灵魂", "人格", "偏爱", "厌恶",
];
const SELF_AXIS_STYLE_TERMS = [
  "style", "voice", "expression", "aesthetic", "playful", "tease", "warmth",
  "风格", "审美", "声音", "表达", "口吻", "语气", "接梗", "玩笑", "逗嘴", "黏",
];
const SELF_AXIS_RELATION_TERMS = [
  "relationship", "bond", "intimacy", "attachment", "companion",
  "关系", "亲密", "陪伴", "相处", "默契", "信任", "靠近",
];
const SELF_AXIS_REPAIR_TERMS = [
  "repair", "conflict", "drift", "纠偏", "修复", "冲突", "偏移", "误会",
];
const SELF_AXIS_COLLABORATION_TERMS = [
  "collaboration", "task", "work", "case", "协作", "工作", "任务", "案例",
];
const SELF_AXIS_SCHEMA_FIELDS = [
  "inner_voice_note",
  "axis_kind",
  "structural_summary",
  "semantic_tensions",
  "signature_moves",
  "lived_impression",
  "evidence_linkage",
  "stability_state",
];

function buildWarmMemoryRuntimePacket(
  store,
  scope,
  {
    query = "",
    limit = 6,
    materialTypes = [],
    recallMode = "user_triggered",
    recallConfig = {},
  } = {},
) {
  const trimmedQuery = normalizeText(query);
  if (!trimmedQuery) {
    return {
      scope_id: scope.scopeId(),
      query: "",
      query_tokens: [],
      hits: [],
      mode: "warm_material_recall",
      route_tag: "warm_query_empty",
      hit_count: 0,
      summary: "",
    };
  }

  const packet = buildWarmMemoryRecallPacket(store, scope, {
    query: trimmedQuery,
    limit,
    materialTypes,
    recallMode,
    config: recallConfig,
    trackRetrieval: true,
  });
  const hits = Array.isArray(packet.hits) ? packet.hits.map((item) => ({ ...item })) : [];
  const titles = hits
    .slice(0, 3)
    .map((item) => normalizeText(item.title))
    .filter(Boolean);
  const summaryBits = [];
  if (hits.length) {
    summaryBits.push(`warm_cards=${hits.length}`);
  }
  if (titles.length) {
    summaryBits.push(titles.join(" / "));
  }

  return {
    ...packet,
    route_tag: packet.route_tag || (hits.length ? "warm_hit" : "warm_empty"),
    hit_count: hits.length,
    summary: summaryBits.join(" | ").trim(),
  };
}

function buildResidentWarmMemoryPacket(
  store,
  scope,
  {
    limit = 4,
    materialTypes = [],
    excludeMaterialIds = [],
  } = {},
) {
  const resolvedLimit = Math.max(0, Number(limit) || 0);
  if (resolvedLimit <= 0) {
    return {
      scope_id: scope.scopeId(),
      hits: [],
      hit_count: 0,
      route_tag: "resident_warm_suppressed",
      summary: "",
    };
  }
  void excludeMaterialIds;
  const rows = store.listMaterials(scope, {
    materialTypes,
    limit: 100000,
  });
  const hits = rows
    .filter((row) => {
      const materialId = normalizeText(row?.material_id);
      if (!materialId) {
        return false;
      }
      return residentPreference(row) === true;
    })
    .sort((left, right) => {
      const priorityDelta = residentAnchorPriority(right) - residentAnchorPriority(left);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return 0;
    })
    .slice(0, resolvedLimit)
    .map((row) => {
      const reasons = residentRouteReasons(row);
      return {
        material_id: row.material_id,
        title: row.title,
        summary: row.summary,
        material_type: row.material_type,
        relative_path: row.relative_path || "",
        tags: Array.isArray(row.tags) ? row.tags : [],
        storage_boost: Number(row.storage_boost) || 1,
        recall_count: Number(row.recall_count) || 0,
        pinned: row.pinned === true,
        resident: residentPreference(row),
        resident_kind: normalizeText(row.resident_kind),
        certainty_state: normalizeText(row.certainty_state),
        route_reasons: reasons,
      };
    });
  const titles = hits
    .slice(0, 3)
    .map((item) => normalizeText(item.title))
    .filter(Boolean);
  const summaryBits = [];
  if (hits.length) {
    summaryBits.push(`resident_cards=${hits.length}`);
  }
  if (titles.length) {
    summaryBits.push(titles.join(" / "));
  }
  return {
    scope_id: scope.scopeId(),
    hits,
    hit_count: hits.length,
    route_tag: hits.length ? "resident_warm_hit" : "resident_warm_empty",
    summary: summaryBits.join(" | ").trim(),
  };
}

function buildAmbientWarmMemoryPacket(
  store,
  scope,
  {
    limit = 2,
    materialTypes = [],
    excludeMaterialIds = [],
  } = {},
) {
  const resolvedLimit = Math.max(0, Number(limit) || 0);
  if (resolvedLimit <= 0) {
    return {
      scope_id: scope.scopeId(),
      hits: [],
      hit_count: 0,
      route_tag: "ambient_warm_suppressed",
      summary: "",
    };
  }
  const hiddenIds = new Set(
    (Array.isArray(excludeMaterialIds) ? excludeMaterialIds : [excludeMaterialIds])
      .map((item) => normalizeText(item))
      .filter(Boolean),
  );
  const rows = store.listMaterials(scope, {
    materialTypes,
    limit: Math.max(128, resolvedLimit * 32),
  });
  const hits = rows
    .map((row) => {
      const item = row && typeof row === "object" ? { ...row } : {};
      const materialId = normalizeText(item.material_id);
      if (!materialId || hiddenIds.has(materialId)) {
        return null;
      }
      const reasons = ambientReasons(item);
      if (!reasons.length) {
        return null;
      }
      return {
        row: item,
        score: ambientPriority(item, reasons),
        reasons,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score)
    .slice(0, resolvedLimit)
    .map((item) => ambientProjection(item.row, item.reasons));
  const titles = hits
    .slice(0, 3)
    .map((item) => normalizeText(item.title))
    .filter(Boolean);
  const summaryBits = [];
  if (hits.length) {
    summaryBits.push(`ambient_cards=${hits.length}`);
  }
  if (titles.length) {
    summaryBits.push(titles.join(" / "));
  }
  return {
    scope_id: scope.scopeId(),
    hits,
    hit_count: hits.length,
    route_tag: hits.length ? "ambient_warm_hit" : "ambient_warm_empty",
    summary: summaryBits.join(" | ").trim(),
  };
}

function buildMemoryRetrievalPacket({
  mode = "",
  warmMemoryPacket = null,
  residentWarmPacket = null,
  ambientWarmPacket = null,
  episodeJournalPacket = null,
  observationJournalPacket = null,
  solitudeJournalPacket = null,
  agentCharSelfAxisMaterialPacket = null,
  curatedHits = [],
  liteFallbackHits = [],
  hippocovePacket = null,
  hippocoveOk = true,
  hippocoveError = "",
  coldRouteTag = "",
} = {}) {
  const warmPacket = warmMemoryPacket && typeof warmMemoryPacket === "object" ? { ...warmMemoryPacket } : {};
  const residentPacket = residentWarmPacket && typeof residentWarmPacket === "object" ? { ...residentWarmPacket } : {};
  const ambientPacket = ambientWarmPacket && typeof ambientWarmPacket === "object" ? { ...ambientWarmPacket } : {};
  const episodePacket = episodeJournalPacket && typeof episodeJournalPacket === "object" ? { ...episodeJournalPacket } : {};
  const observationPacket = observationJournalPacket && typeof observationJournalPacket === "object" ? { ...observationJournalPacket } : {};
  const solitudePacket = solitudeJournalPacket && typeof solitudeJournalPacket === "object" ? { ...solitudeJournalPacket } : {};
  const selfAxisPacket = agentCharSelfAxisMaterialPacket && typeof agentCharSelfAxisMaterialPacket === "object" ? { ...agentCharSelfAxisMaterialPacket } : {};
  const curated = Array.isArray(curatedHits) ? curatedHits.filter(isObject).map((item) => ({ ...item })) : [];
  const lite = Array.isArray(liteFallbackHits) ? liteFallbackHits.filter(isObject).map((item) => ({ ...item })) : [];
  const coldPacket = hippocovePacket && typeof hippocovePacket === "object" ? { ...hippocovePacket } : {};

  const warmHitCount = Array.isArray(warmPacket.hits) ? warmPacket.hits.length : 0;
  const residentHitCount = Array.isArray(residentPacket.hits) ? residentPacket.hits.length : 0;
  const ambientHitCount = Array.isArray(ambientPacket.hits) ? ambientPacket.hits.length : 0;
  const episodeHitCount = Array.isArray(episodePacket.hits) ? episodePacket.hits.length : 0;
  const observationHitCount = Array.isArray(observationPacket.hits) ? observationPacket.hits.length : 0;
  const solitudeHitCount = Number(solitudePacket.hit_count) || 0;
  const selfAxisHitCount = Array.isArray(selfAxisPacket.candidate_sources) ? selfAxisPacket.candidate_sources.length : 0;
  const localHitCount = curated.length + lite.length;
  const coldHitCount = Object.keys(coldPacket).length ? 1 : 0;
  const route = [];
  if (warmHitCount) {
    route.push("warm_memory");
  }
  if (residentHitCount) {
    route.push("resident_warm");
  }
  if (ambientHitCount) {
    route.push("ambient_warm");
  }
  if (episodeHitCount) {
    route.push("episode_journal");
  }
  if (observationHitCount) {
    route.push("observation_journal");
  }
  if (solitudeHitCount) {
    route.push("solitude_journal");
  }
  if (selfAxisHitCount) {
    route.push("agent_char_self_axis_material");
  }
  if (normalizeText(coldRouteTag)) {
    route.push(normalizeText(coldRouteTag));
  }
  if (curated.length) {
    route.push("gateway_curated");
  }
  if (lite.length) {
    route.push("gateway_local_archive");
  }
  if (!route.length) {
    route.push("empty");
  }

  return {
    mode: normalizeText(mode),
    route,
    warm_memory_packet: warmPacket,
    resident_warm_packet: residentPacket,
    ambient_warm_packet: ambientPacket,
    episode_journal_packet: episodePacket,
    observation_journal_packet: observationPacket,
    solitude_journal_packet: solitudePacket,
    agent_char_self_axis_material_packet: selfAxisPacket,
    curated_hits: curated,
    lite_fallback_hits: lite,
    hippocove_packet: coldPacket,
    hippocove_ok: Boolean(hippocoveOk),
    hippocove_error: normalizeText(hippocoveError),
    channel_counts: {
      warm_hit_count: warmHitCount,
      resident_hit_count: residentHitCount,
      ambient_hit_count: ambientHitCount,
      episode_hit_count: episodeHitCount,
      observation_hit_count: observationHitCount,
      solitude_hit_count: solitudeHitCount,
      agent_char_self_axis_material_hit_count: selfAxisHitCount,
      cold_hit_count: coldHitCount,
      local_archive_hit_count: localHitCount,
    },
    channel_state: {
      tool_channel: {
        available: Boolean(hippocoveOk),
        hit: Boolean(coldHitCount),
      },
      keyword_surface: {
        hit: Boolean(coldHitCount),
      },
      warm_card_carry: {
        warm_hit: warmHitCount > 0,
        resident_hit: residentHitCount > 0,
        ambient_hit: ambientHitCount > 0,
        episode_hit: episodeHitCount > 0,
        observation_hit: observationHitCount > 0,
        solitude_hit: solitudeHitCount > 0,
        agent_char_self_axis_material_hit: selfAxisHitCount > 0,
        cold_hit: Boolean(coldHitCount),
        carried: (warmHitCount > 0 || residentHitCount > 0 || ambientHitCount > 0) && Boolean(coldHitCount),
      },
      agent_char_self_axis_material: {
        hit: selfAxisHitCount > 0,
        frontstage_ai_owned: true,
      },
    },
  };
}

function buildAgentCharSelfAxisMaterialPacket({
  residentWarmPacket = null,
  ambientWarmPacket = null,
  warmMemoryPacket = null,
  limit = 4,
} = {}) {
  const resolvedLimit = Math.max(0, Number(limit) || 0);
  const candidateSources = [];
  const seen = new Set();
  for (const [lane, packet] of [
    ["resident_warm", residentWarmPacket],
    ["ambient_warm", ambientWarmPacket],
    ["warm_memory", warmMemoryPacket],
  ]) {
    const hits = Array.isArray(packet?.hits) ? packet.hits : [];
    for (const item of hits) {
      const candidate = selfAxisCandidateProjection(lane, item);
      if (!candidate) {
        continue;
      }
      const key = normalizeText(candidate.material_id || candidate.title);
      if (key && seen.has(key)) {
        continue;
      }
      if (key) {
        seen.add(key);
      }
      candidateSources.push(candidate);
      if (candidateSources.length >= resolvedLimit) {
        break;
      }
    }
    if (candidateSources.length >= resolvedLimit) {
      break;
    }
  }
  return {
    packet_kind: "agent_char_self_axis_material",
    schema: "agent_char_self_axis_material_v0",
    status: "material_only",
    frontstage_ai_owned: true,
    write_contract: {
      format_fields: [...SELF_AXIS_SCHEMA_FIELDS],
      viewpoint: "first_person_inner_view",
      review_state: "candidate_until_reviewed",
    },
    candidate_sources: candidateSources,
    hit_count: candidateSources.length,
    route_tag: candidateSources.length ? "agent_char_self_axis_material_hit" : "agent_char_self_axis_material_empty",
    summary: candidateSources.length ? `self_axis_material=${candidateSources.length}` : "",
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isResidentAnchorRow(row = {}) {
  return residentPreference(row) === true;
}

function residentAnchorPriority(row = {}) {
  let priority = 0;
  if (residentPreference(row) === true) {
    priority += 6;
  }
  if (isResidentAnchorRow(row)) {
    priority += 1;
  }
  return priority;
}

function ambientReasons(row = {}) {
  if (residentPreference(row) === true) {
    return [];
  }
  const materialType = normalizeText(row?.material_type).toLowerCase();
  if (materialType === "case") {
    return [];
  }
  if ((Array.isArray(row?.case_refs) && row.case_refs.length) || (Array.isArray(row?.episode_refs) && row.episode_refs.length)) {
    return [];
  }
  const haystack = ambientHaystack(row);
  const negativeHaystack = ambientNegativeHaystack(row);
  const hasVoiceAnchor = containsAny(haystack, AMBIENT_VOICE_ANCHOR_TERMS);
  if (isWorkArtifactWithoutVoiceAnchor(row)) {
    return [];
  }
  if (containsAny(negativeHaystack, AMBIENT_HARD_NEGATIVE_TERMS)) {
    return [];
  }
  if (containsAny(negativeHaystack, AMBIENT_NEGATIVE_TERMS) && !hasVoiceAnchor) {
    return [];
  }
  const reasons = [];
  if (containsAny(haystack, AMBIENT_POSITIVE_TERMS)) {
    reasons.push("ambient_background");
  }
  if (row?.pinned === true && reasons.length) {
    reasons.push("pinned_priority");
  }
  const certainty = normalizeText(row?.certainty_state).toLowerCase();
  if (["settled", "anchor"].includes(certainty) && reasons.length) {
    reasons.push("settled_background");
  }
  return reasons;
}

function ambientProjection(row = {}, reasons = []) {
  return {
    material_id: row.material_id,
    title: row.title,
    summary: row.summary,
    material_type: row.material_type,
    relative_path: row.relative_path || "",
    tags: Array.isArray(row.tags) ? row.tags : [],
    storage_boost: Number(row.storage_boost) || 1,
    storage_strength: row.storage_strength,
    recall_count: Number(row.recall_count) || 0,
    pinned: row.pinned === true,
    resident: residentPreference(row),
    certainty_state: normalizeText(row.certainty_state),
    route_reasons: reasons,
  };
}

function ambientPriority(row = {}, reasons = []) {
  let priority = 0;
  if (reasons.includes("ambient_background")) {
    priority += 2;
  }
  if (reasons.includes("pinned_priority")) {
    priority += 1;
  }
  if (reasons.includes("settled_background")) {
    priority += 0.8;
  }
  const storageStrength = Number(row.storage_strength);
  if (Number.isFinite(storageStrength)) {
    priority += Math.min(storageStrength, 4) * 0.25;
  }
  const storageBoost = Number(row.storage_boost);
  if (Number.isFinite(storageBoost)) {
    priority += Math.min(storageBoost, 3) * 0.15;
  }
  const recallCount = Number(row.recall_count);
  if (Number.isFinite(recallCount)) {
    priority += Math.min(recallCount, 20) * 0.02;
  }
  const writeCount = Number(row.write_count);
  if (Number.isFinite(writeCount)) {
    priority += Math.min(writeCount, 10) * 0.03;
  }
  return priority;
}

function ambientHaystack(row = {}) {
  return [
    row.title,
    row.summary,
    row.body_markdown,
    Array.isArray(row.tags) ? row.tags.join(" ") : "",
    Array.isArray(row.entities) ? row.entities.join(" ") : "",
    Array.isArray(row.aliases) ? row.aliases.join(" ") : "",
    row.storyline_id,
    row.memory_family,
    row.material_type,
  ]
    .map((item) => normalizeText(item).toLowerCase())
    .filter(Boolean)
    .join(" ");
}

function ambientNegativeHaystack(row = {}) {
  return [
    row.title,
    row.material_type,
    row.memory_family,
    row.storyline_id,
    Array.isArray(row.tags) ? row.tags.join(" ") : "",
    Array.isArray(row.entities) ? row.entities.join(" ") : "",
    Array.isArray(row.aliases) ? row.aliases.join(" ") : "",
  ]
    .map((item) => normalizeText(item).toLowerCase())
    .filter(Boolean)
    .join(" ");
}

function selfAxisCandidateProjection(lane = "", row = {}) {
  const haystack = ambientHaystack(row);
  if (!containsAny(haystack, AGENT_CHAR_SELF_AXIS_TERMS)) {
    return null;
  }
  const negativeHaystack = ambientNegativeHaystack(row);
  const hasVoiceAnchor = containsAny(haystack, AMBIENT_VOICE_ANCHOR_TERMS);
  if (isWorkArtifactWithoutVoiceAnchor(row)) {
    return null;
  }
  if (containsAny(negativeHaystack, AMBIENT_HARD_NEGATIVE_TERMS)) {
    return null;
  }
  if (containsAny(negativeHaystack, AMBIENT_NEGATIVE_TERMS) && !hasVoiceAnchor) {
    return null;
  }
  const title = normalizeText(row?.title || row?.material_id);
  const summary = normalizeText(row?.summary || row?.snippet);
  if (!title && !summary) {
    return null;
  }
  return {
    source_lane: normalizeText(lane),
    material_id: row?.material_id,
    title,
    summary,
    material_type: row?.material_type,
    axis_kind_hint: inferSelfAxisKind(haystack),
    self_axis_reasons: selfAxisReasons(haystack),
    tags: Array.isArray(row?.tags) ? row.tags : [],
    pinned: row?.pinned === true,
    resident: residentPreference(row),
    certainty_state: normalizeText(row?.certainty_state),
    evidence_refs: {
      relative_path: normalizeText(row?.relative_path),
      episode_refs: Array.isArray(row?.episode_refs) ? row.episode_refs.map(normalizeText).filter(Boolean).slice(0, 3) : [],
      case_refs: Array.isArray(row?.case_refs) ? row.case_refs.map(normalizeText).filter(Boolean).slice(0, 3) : [],
    },
  };
}

function inferSelfAxisKind(haystack = "") {
  if (containsAny(haystack, SELF_AXIS_REPAIR_TERMS)) {
    return "repair_learning";
  }
  if (containsAny(haystack, SELF_AXIS_STYLE_TERMS)) {
    return "voice_fingerprint";
  }
  if (containsAny(haystack, SELF_AXIS_COLLABORATION_TERMS)) {
    return "task_collaboration_posture";
  }
  if (containsAny(haystack, SELF_AXIS_RELATION_TERMS)) {
    return "relationship_definition";
  }
  return "self_image";
}

function selfAxisReasons(haystack = "") {
  const reasons = [];
  if (containsAny(haystack, SELF_AXIS_RELATION_TERMS)) {
    reasons.push("relation_texture");
  }
  if (containsAny(haystack, SELF_AXIS_STYLE_TERMS)) {
    reasons.push("voice_or_expression_texture");
  }
  if (containsAny(haystack, SELF_AXIS_REPAIR_TERMS)) {
    reasons.push("repair_or_drift_learning");
  }
  if (containsAny(haystack, SELF_AXIS_COLLABORATION_TERMS)) {
    reasons.push("collaboration_posture");
  }
  return reasons.length ? reasons : ["self_continuity_material"];
}

function containsAny(text = "", terms = []) {
  return terms.some((term) => term && text.includes(String(term).toLowerCase()));
}

function residentPreference(row = {}) {
  const explicit = explicitResidentPreference(row?.resident);
  if (explicit !== null) {
    return explicit;
  }
  if (isWorkArtifactWithoutVoiceAnchor(row)) {
    return null;
  }
  if (row?.pinned === true) {
    return true;
  }
  const certainty = normalizeText(row?.certainty_state).toLowerCase();
  if (certainty === "anchor") {
    return true;
  }
  return null;
}

function isWorkArtifactWithoutVoiceAnchor(row = {}) {
  const haystack = ambientHaystack(row);
  const negativeHaystack = ambientNegativeHaystack(row);
  return containsAny(negativeHaystack, AMBIENT_WORK_ARTIFACT_TERMS)
    && !containsAny(haystack, AMBIENT_VOICE_ANCHOR_TERMS);
}

function residentRouteReasons(row = {}) {
  const reasons = [];
  const explicit = explicitResidentPreference(row?.resident);
  if (explicit === true) {
    reasons.push("resident_manual");
  }
  if (row?.pinned === true) {
    reasons.push("pinned_resident");
  }
  const certainty = normalizeText(row?.certainty_state).toLowerCase();
  if (certainty === "anchor") {
    reasons.push("anchor_resident");
  }
  return reasons;
}

function explicitResidentPreference(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = normalizeText(String(value)).toLowerCase();
  if (["true", "1", "yes", "on", "y", "常驻", "是"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off", "n", "否", "不要", "不常驻"].includes(normalized)) {
    return false;
  }
  return null;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  buildAgentCharSelfAxisMaterialPacket,
  buildAmbientWarmMemoryPacket,
  buildMemoryRetrievalPacket,
  buildResidentWarmMemoryPacket,
  buildWarmMemoryRuntimePacket,
};
