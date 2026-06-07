const EXPLICIT_MEMORY_PATTERN = /(还记得|记不记得|记得|上次|以前|之前|过去|当时|那天|长期记忆|冷记忆|温记忆|记忆树|纠正|更正|修正|改记忆|写进记忆|常驻|memory|recall|cold|warm|resident|pinned)/iu;
const ONGOING_PATTERN = /(ongoing|待办|悬着|挂着|跟进|收尾|进展|主线|项目|工作流|bug|debug|服务器|部署|代码|mossbridge|bridge|codex|claude|wechat|微信|前端|内网穿透|手机端|记忆系统|case|设备|预约)/iu;
const ONGOING_OVERVIEW_PATTERN = /((最近|目前|现在|这阵子|这段时间).*(脑子|挂着|主线|待办|进展|事情|任务|忙)|脑子里.*(什么|哪些|挂着))/iu;
const EPISODE_PATTERN = /(episode|小事记|相册|照片|旅行|这本书|读书|共读|章节|第.{0,4}章|书里|附件|文件|上传)/iu;
const OBSERVATION_PATTERN = /(观察|默契|相处|关系连续|自我连贯|自己管理|偏好|习惯|风格|我是不是|你觉得我|了解我)/iu;
const WARM_TOPIC_PATTERN = /(coffee|morning|sleep|taste|preference|habit|relationship|important|meaningful|symbol|keepsake|memento|喜欢|讨厌|偏好|习惯|风格|审美|颜色|色系|关系|我们|彼此|重要|有意义|珍贵|象征|信物|纪念|家族|家庭|亲属|亲戚|生日|约定|作息|熬夜|恢复|咖啡)/iu;
const AFFECTIVE_RELATIONAL_PATTERN = /(担心|怕|害怕|焦虑|不安|慌|难过|委屈|破防|崩了|想哭|哭了|冷冷|冷淡|生硬|工具化|公事公办|生疏|不熟|不对劲|不像|疏远|没得选|失去|丢掉|离开|分离|安全感|陪我|陪玩|玩啥|玩什么|黏糊|黏黏|萌萌|撒娇|亲昵|贴近)/iu;
const TEMPORAL_PATTERN = /(昨天|前天|大前天|刚才|刚刚|上次|那天|当时|之前那|前面|今天.*(早上|上午|中午|下午|晚上|图|文件|消息|回复))/iu;
const READING_PATTERN = /(读书|共读|这本书|章节|第.{0,4}章|书里|小说|epub|txt)/iu;
const LOW_CONTEXT_MARKERS = /(mua|宝宝|亲亲|抱抱|抱住|贴贴|晚安|早安|想你|哼|呜|嘿嘿|哈哈|摸摸|蹭蹭|亲一口|搂住|困了|睡了|醒了)/iu;
const QUESTION_OR_TASK_PATTERN = /(怎么|为什么|什么|哪个|哪种|能不能|会不会|要不要|帮我|检查|看看|处理|写|推|部署|修|改|删|删除|结束|不要|打开|搜索|读|发|上传)/iu;
const ACTIVE_TASK_PATTERN = /(怎么|为什么|什么|哪个|哪种|能不能|会不会|要不要|帮我|检查|看看|处理|写|推|部署|修|改一下|改掉|删|删除|结束|不要|打开|搜索|读|发|上传)/iu;

function resolveMemoryDeliveryProfile({
  query = "",
  recallFocus = {},
  recallMode = "user_triggered",
  runtimeProfile = "",
  forceRecentContext = false,
} = {}) {
  const text = normalizeText(query);
  const mode = normalizeText(recallMode).toLowerCase();
  const runtime = normalizeText(runtimeProfile).toLowerCase();
  const explicitMemory = EXPLICIT_MEMORY_PATTERN.test(text);
  const explicitOngoing = ONGOING_PATTERN.test(text) || ONGOING_OVERVIEW_PATTERN.test(text);
  const explicitEpisode = EPISODE_PATTERN.test(text);
  const explicitObservation = OBSERVATION_PATTERN.test(text);
  const explicitWarm = WARM_TOPIC_PATTERN.test(text);
  const affectiveRelational = AFFECTIVE_RELATIONAL_PATTERN.test(text);
  const temporalReference = TEMPORAL_PATTERN.test(text);
  const readingContext = READING_PATTERN.test(text);
  const gateTriggered = Boolean(recallFocus?.should_trigger || recallFocus?.semantic_recall_signal || recallFocus?.explicit_recall_signal);
  const lowContext = looksLikeLowContextChat(text) && !(
    explicitMemory
    || explicitOngoing
    || explicitEpisode
    || explicitObservation
    || affectiveRelational
    || temporalReference
    || Boolean(forceRecentContext)
  );
  const casualBackground = Boolean(text) && !(
    explicitMemory
    || explicitOngoing
    || explicitEpisode
    || explicitObservation
    || explicitWarm
    || affectiveRelational
    || temporalReference
    || readingContext
    || gateTriggered
    || Boolean(forceRecentContext)
    || ACTIVE_TASK_PATTERN.test(text)
  );

  let tier = "resident_only";
  if (runtime === "proactive_lite") {
    tier = "heartbeat_lite";
  } else if (Boolean(forceRecentContext) || explicitMemory || ONGOING_OVERVIEW_PATTERN.test(text)) {
    tier = "full";
  } else if (affectiveRelational && !explicitOngoing && !explicitEpisode && !explicitObservation) {
    tier = "affective_warm";
  } else if (gateTriggered || readingContext || explicitWarm || explicitOngoing || explicitEpisode || explicitObservation) {
    tier = "focused";
  } else if (lowContext || casualBackground) {
    tier = "ambient_warm";
  }

  const includeWarm = ["affective_warm", "focused", "full"].includes(tier);
  const includeAmbientWarm = ["ambient_warm", "affective_warm", "heartbeat_lite"].includes(tier)
    || Boolean(forceRecentContext);
  let includeOngoing = tier === "full" || tier === "focused";
  let includeEpisode = ["focused", "full"].includes(tier) && explicitEpisode;
  let includeObservation = tier === "full" || tier === "focused";
  let includeTemporal = tier !== "resident_only" && tier !== "ambient_warm" && temporalReference;
  let includeCold = !["resident_only", "ambient_warm", "affective_warm", "heartbeat_lite"].includes(tier);

  if (mode === "proactive" && runtime === "proactive_lite") {
    includeOngoing = includeOngoing && explicitOngoing;
    includeEpisode = includeEpisode && explicitEpisode;
    includeObservation = includeObservation && explicitObservation;
    includeTemporal = includeTemporal && temporalReference;
    includeCold = false;
  }

  return {
    tier,
    low_context: lowContext,
    explicit_memory: explicitMemory,
    explicit_ongoing: explicitOngoing,
    explicit_episode: explicitEpisode,
    explicit_observation: explicitObservation,
    explicit_warm: explicitWarm,
    affective_relational: affectiveRelational,
    temporal_reference: temporalReference,
    reading_context: readingContext,
    include_resident: true,
    include_ambient_warm: includeAmbientWarm,
    include_warm: includeWarm,
    include_ongoing: includeOngoing,
    include_episode: includeEpisode,
    include_observation: includeObservation,
    include_temporal: includeTemporal,
    include_cold: includeCold,
  };
}

function looksLikeLowContextChat(value = "") {
  const compact = normalizeText(value).replace(/\s+/gu, "");
  if (!compact) {
    return true;
  }
  if (compact.length <= 18 && LOW_CONTEXT_MARKERS.test(compact) && !QUESTION_OR_TASK_PATTERN.test(compact)) {
    return true;
  }
  return false;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  resolveMemoryDeliveryProfile,
  looksLikeLowContextChat,
};
