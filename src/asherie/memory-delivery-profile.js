const EXPLICIT_MEMORY_PATTERN = /(还记得|记不记得|记得|上次|以前|之前|过去|当时|那天|长期记忆|冷记忆|温记忆|记忆树|纠正|更正|修正|改记忆|写进记忆|常驻|memory|recall|cold|warm|resident|pinned)/iu;
const ONGOING_PATTERN = /(ongoing|待办|悬着|挂着|跟进|收尾|进展|主线|项目|工作流|bug|debug|服务器|部署|代码|mossbridge|bridge|codex|claude|wechat|微信|前端|内网穿透|手机端|记忆系统|case|设备|预约)/iu;
const ONGOING_OVERVIEW_PATTERN = /((最近|目前|现在|这阵子|这段时间).*(脑子|挂着|主线|待办|进展|事情|任务|忙)|脑子里.*(什么|哪些|挂着))/iu;
const EPISODE_PATTERN = /(episode|小事记|相册|照片|旅行|这本书|读书|共读|章节|第.{0,4}章|书里|附件|文件|上传)/iu;
const EPISODE_PROBE_PATTERN = /(现场|工地|定位|底稿|图纸|设计师|师傅|老板|安装|装完|装上|物流|到货|下单|网购|商场|苹果店|补漆|底漆|划伤|车门|手指|甲刺|伤口|装修|水电|插座|点位|房梁|门梁|空调|窗户|门密码|举报|大群|邻居群)/iu;
const OBSERVATION_PATTERN = /(观察|默契|相处|关系连续|自我连贯|自己管理|偏好|习惯|风格|我是不是|你觉得我|了解我)/iu;
const OBSERVATION_PROBE_PATTERN = /(网购|买.{0,4}电脑|电脑|苹果店|macbook|m5\s*(air|pro)?|手指|甲刺|伤口|甲沟炎|车门|补漆|底漆|修车)/iu;
const WARM_TOPIC_PATTERN = /(coffee|morning|sleep|taste|preference|habit|relationship|important|meaningful|symbol|keepsake|memento|喜欢|讨厌|偏好|习惯|风格|审美|颜色|色系|关系|我们|彼此|重要|有意义|珍贵|象征|信物|纪念|家族|家庭|亲属|亲戚|生日|约定|作息|熬夜|恢复|咖啡)/iu;
const AFFECTIVE_RELATIONAL_PATTERN = /(担心|怕|害怕|焦虑|不安|慌|难过|委屈|破防|崩了|想哭|哭了|冷冷|冷淡|生硬|工具化|公事公办|生疏|不熟|不对劲|不像|疏远|没得选|失去|丢掉|离开|分离|安全感|陪我|陪玩|玩啥|玩什么|黏糊|黏黏|萌萌|撒娇|亲密|亲昵|熟悉|贴近|逗嘴|接梗|玩笑|调戏|退缩|客气|客服|sop|反客服)/iu;
const TEMPORAL_PATTERN = /(昨天|前天|大前天|刚才|刚刚|上次|那天|当时|之前那|前面|今天.*(早上|上午|中午|下午|晚上|图|文件|消息|回复))/iu;
const READING_PATTERN = /(读书|共读|这本书|章节|第.{0,4}章|书里|小说|epub|txt)/iu;
const LOW_CONTEXT_MARKERS = /(mua|亲亲|抱抱|抱住|贴贴|晚安|早安|想你|哼|呜|嘿嘿|哈哈|摸摸|蹭蹭|亲一口|搂住|困了|睡了|醒了)/iu;
const QUESTION_OR_TASK_PATTERN = /(怎么|为什么|什么|哪个|哪种|能不能|会不会|要不要|帮我|检查|看看|处理|写|推|部署|修|改|删|删除|结束|不要|打开|搜索|读|发|上传)/iu;
const ACTIVE_TASK_PATTERN = /(帮我|检查|看看|处理|写|推|部署|修|改一下|改掉|删|删除|打开|搜索|读|发|上传)/iu;

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
  const sessionHandoff = Boolean(forceRecentContext);
  const explicitMemory = EXPLICIT_MEMORY_PATTERN.test(text);
  const explicitOngoing = ONGOING_PATTERN.test(text) || ONGOING_OVERVIEW_PATTERN.test(text);
  const explicitEpisode = EPISODE_PATTERN.test(text);
  const explicitObservation = OBSERVATION_PATTERN.test(text);
  const explicitWarm = WARM_TOPIC_PATTERN.test(text);
  const affectiveRelational = AFFECTIVE_RELATIONAL_PATTERN.test(text);
  const temporalReference = TEMPORAL_PATTERN.test(text);
  const readingContext = READING_PATTERN.test(text);
  const looseOperationalClose = looksLikeLooseOperationalClose(text);
  const activeTask = ACTIVE_TASK_PATTERN.test(text) && !looseOperationalClose;
  const gateTriggered = Boolean(recallFocus?.should_trigger || recallFocus?.semantic_recall_signal || recallFocus?.explicit_recall_signal);
  const lowContext = looksLikeLowContextChat(text) && !(
    explicitMemory
    || explicitOngoing
    || explicitEpisode
    || explicitObservation
    || affectiveRelational
    || temporalReference
  );
  const episodeProbe = looksLikeEpisodeProbe(text, {
    explicitMemory,
    explicitEpisode,
    explicitOngoing,
    temporalReference,
    readingContext,
    lowContext,
    looseOperationalClose,
  });
  const observationProbe = looksLikeObservationProbe(text, {
    lowContext,
    looseOperationalClose,
  });
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
    || activeTask
    || looseOperationalClose
  );

  let tier = "resident_only";
  if (runtime === "proactive_lite") {
    tier = "heartbeat_lite";
  } else if (explicitMemory || ONGOING_OVERVIEW_PATTERN.test(text)) {
    tier = "full";
  } else if (affectiveRelational && !explicitOngoing && !explicitEpisode && !explicitObservation) {
    tier = "affective_warm";
  } else if (activeTask && !(readingContext || explicitWarm || explicitOngoing || explicitEpisode || explicitObservation)) {
    tier = "task_ambient";
  } else if (gateTriggered || readingContext || explicitWarm || explicitOngoing || explicitEpisode || explicitObservation) {
    tier = "focused";
  } else if (activeTask) {
    tier = "task_ambient";
  } else if (lowContext || casualBackground) {
    tier = "ambient_warm";
  }

  const includeWarm = ["affective_warm", "focused", "full"].includes(tier);
  const includeAmbientWarm = ["ambient_warm", "affective_warm", "task_ambient", "focused", "full", "heartbeat_lite"].includes(tier)
    || sessionHandoff;
  let includeOngoing = tier === "full" || tier === "focused";
  const explicitEpisodeDelivery = ["focused", "full"].includes(tier) && (explicitEpisode || explicitMemory || temporalReference);
  let includeEpisode = explicitEpisodeDelivery || episodeProbe;
  let includeObservation = tier === "full" || tier === "focused" || observationProbe;
  let includeTemporal = tier !== "resident_only" && tier !== "ambient_warm" && temporalReference;
  let includeCold = !["resident_only", "ambient_warm", "affective_warm", "task_ambient", "heartbeat_lite"].includes(tier);
  let episodeMinScore = 4;
  let observationMinScore = observationProbe && !["focused", "full"].includes(tier) ? 8 : 0;

  if (mode === "proactive" && runtime === "proactive_lite") {
    includeOngoing = includeOngoing && explicitOngoing;
    includeEpisode = includeEpisode && explicitEpisode;
    includeObservation = includeObservation && explicitObservation;
    includeTemporal = includeTemporal && temporalReference;
    includeCold = false;
    episodeMinScore = 4;
    observationMinScore = observationProbe ? 8 : 0;
  }

  return {
    tier,
    low_context: lowContext,
    explicit_memory: explicitMemory,
    explicit_ongoing: explicitOngoing,
    explicit_episode: explicitEpisode,
    episode_probe: episodeProbe,
    episode_min_score: episodeMinScore,
    observation_probe: observationProbe,
    observation_min_score: observationMinScore,
    explicit_observation: explicitObservation,
    explicit_warm: explicitWarm,
    affective_relational: affectiveRelational,
    temporal_reference: temporalReference,
    reading_context: readingContext,
    active_task: activeTask,
    loose_operational_close: looseOperationalClose,
    session_handoff: sessionHandoff,
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

function looksLikeLooseOperationalClose(value = "") {
  const compact = normalizeText(value).replace(/\s+/gu, "");
  if (!compact || compact.length > 24) {
    return false;
  }
  if (!/(不要了|不用了|算了|结束了|删掉|删了|别要了|不要|结束)/iu.test(compact)) {
    return false;
  }
  if (/(这个|这条|这张|这份|页面|文件|代码|记录|温卡|记忆|提醒|日历|任务|项目|case|预约|链接|仓库|服务|部署|数据|配置|权限|按钮|接口|网页)/iu.test(compact)) {
    return false;
  }
  return /(哈哈|啊|啦|吧|算了|已经)/iu.test(compact);
}

function looksLikeEpisodeProbe(value = "", {
  explicitMemory = false,
  explicitEpisode = false,
  explicitOngoing = false,
  temporalReference = false,
  readingContext = false,
  lowContext = false,
  looseOperationalClose = false,
} = {}) {
  const compact = normalizeText(value).replace(/\s+/gu, "");
  if (!compact || compact.length < 8 || lowContext || looseOperationalClose) {
    return false;
  }
  if (explicitMemory || explicitEpisode || temporalReference || readingContext) {
    return true;
  }
  if (EPISODE_PROBE_PATTERN.test(compact)) {
    return true;
  }
  return explicitOngoing && compact.length >= 12;
}

function looksLikeObservationProbe(value = "", {
  lowContext = false,
  looseOperationalClose = false,
} = {}) {
  const compact = normalizeText(value).replace(/\s+/gu, "");
  if (!compact || compact.length < 6 || lowContext || looseOperationalClose) {
    return false;
  }
  return OBSERVATION_PROBE_PATTERN.test(compact);
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
  looksLikeEpisodeProbe,
  looksLikeObservationProbe,
  looksLikeLowContextChat,
  looksLikeLooseOperationalClose,
};
