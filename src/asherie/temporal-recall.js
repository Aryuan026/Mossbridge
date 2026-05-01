const DEFAULT_LIMIT = 8;

const FUZZY_PAST_PATTERNS = [
  /上次/u,
  /那天/u,
  /当时/u,
  /之前那(?:次|天|回)?/u,
  /前面(?:说|聊|提)?/u,
];

function buildTemporalRecallPlan({ query = "", referenceTime = null, limit = DEFAULT_LIMIT } = {}) {
  const text = normalizeText(query);
  if (!text) {
    return emptyPlan();
  }
  const now = parseDate(referenceTime) || new Date();
  const exactDate = resolveExactDate(text, now);
  if (exactDate) {
    return planForRange({
      query: text,
      label: exactDate.label,
      start: startOfLocalDay(exactDate.date),
      end: endOfLocalDay(exactDate.date),
      reason: "exact_date",
      limit,
    });
  }

  const relative = resolveRelativeRange(text, now);
  if (relative) {
    return planForRange({
      query: text,
      label: relative.label,
      start: relative.start,
      end: relative.end,
      reason: relative.reason,
      limit,
    });
  }

  if (FUZZY_PAST_PATTERNS.some((pattern) => pattern.test(text))) {
    return planForRange({
      query: text,
      label: "recent_past",
      start: addLocalDays(startOfLocalDay(now), -14),
      end: endOfLocalDay(now),
      reason: "fuzzy_past_reference",
      limit,
    });
  }

  return emptyPlan();
}

function buildTemporalRecallPacket({ plan = null, records = [] } = {}) {
  const safePlan = plan && typeof plan === "object" ? plan : emptyPlan();
  const rows = Array.isArray(records) ? records.filter((item) => item && typeof item === "object") : [];
  return {
    enabled: Boolean(safePlan.should_recall),
    label: normalizeText(safePlan.label),
    reason: normalizeText(safePlan.reason),
    query: normalizeText(safePlan.query),
    topic_query: normalizeText(safePlan.topic_query),
    window_start_utc: normalizeText(safePlan.window_start_utc),
    window_end_utc: normalizeText(safePlan.window_end_utc),
    hit_count: rows.length,
    hits: rows,
    summary: rows.length
      ? `temporal_window=${normalizeText(safePlan.label) || "matched"} | hits=${rows.length}`
      : "",
  };
}

function emptyPlan() {
  return {
    should_recall: false,
    label: "",
    reason: "",
    query: "",
    topic_query: "",
    window_start_utc: "",
    window_end_utc: "",
    limit: DEFAULT_LIMIT,
  };
}

function planForRange({ query, label, start, end, reason, limit }) {
  const safeStart = parseDate(start);
  const safeEnd = parseDate(end);
  if (!safeStart || !safeEnd) {
    return emptyPlan();
  }
  return {
    should_recall: true,
    label: normalizeText(label),
    reason: normalizeText(reason),
    query: normalizeText(query),
    topic_query: stripTemporalWords(query),
    window_start_utc: safeStart.toISOString(),
    window_end_utc: safeEnd.toISOString(),
    limit: Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, 24)),
  };
}

function resolveExactDate(text, now) {
  const full = text.match(/(20\d{2})[年/-]\s*(\d{1,2})[月/-]\s*(\d{1,2})(?:日|号)?/u);
  if (full) {
    const date = new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]));
    if (isValidDate(date) && date <= addLocalDays(endOfLocalDay(now), 1)) {
      return { date, label: formatLocalDateLabel(date) };
    }
  }

  const chineseDate = text.match(/(?<!\d)(\d{1,2})月(\d{1,2})(?:日|号)?/u);
  if (chineseDate) {
    const date = inferMonthDay(Number(chineseDate[1]), Number(chineseDate[2]), now);
    if (date) {
      return { date, label: formatLocalDateLabel(date) };
    }
  }

  const slashDate = text.match(/(?<!\d)(\d{1,2})[/-](\d{1,2})(?!\d)/u);
  if (slashDate) {
    const date = inferMonthDay(Number(slashDate[1]), Number(slashDate[2]), now);
    if (date) {
      return { date, label: formatLocalDateLabel(date) };
    }
  }

  return null;
}

function resolveRelativeRange(text, now) {
  const todayStart = startOfLocalDay(now);
  if (/大前天/u.test(text)) {
    const day = addLocalDays(todayStart, -3);
    return { label: "大前天", start: day, end: endOfLocalDay(day), reason: "relative_day" };
  }
  if (/前天/u.test(text)) {
    const day = addLocalDays(todayStart, -2);
    return { label: "前天", start: day, end: endOfLocalDay(day), reason: "relative_day" };
  }
  if (/昨天/u.test(text)) {
    const day = addLocalDays(todayStart, -1);
    return { label: "昨天", start: day, end: endOfLocalDay(day), reason: "relative_day" };
  }
  if (/(刚才|刚刚|早些时候|方才)/u.test(text)) {
    return {
      label: "刚才",
      start: new Date(now.getTime() - (6 * 60 * 60 * 1000)),
      end: now,
      reason: "recent_hours",
    };
  }
  const recentDays = text.match(/(?:这|最近|前)(\d+|两|三|几)天/u);
  if (recentDays) {
    const days = parseChineseSmallNumber(recentDays[1]) || 3;
    return {
      label: recentDays[0],
      start: addLocalDays(todayStart, -Math.max(1, days - 1)),
      end: endOfLocalDay(now),
      reason: "relative_day_range",
    };
  }
  if (/(这两天|这几天|前两天|前几天|最近几天)/u.test(text)) {
    return {
      label: RegExp.lastMatch || "最近几天",
      start: addLocalDays(todayStart, -2),
      end: endOfLocalDay(now),
      reason: "relative_day_range",
    };
  }
  if (/(上周|上星期|上礼拜)/u.test(text)) {
    const thisWeekStart = startOfLocalWeek(now);
    const start = addLocalDays(thisWeekStart, -7);
    return {
      label: "上周",
      start,
      end: endOfLocalDay(addLocalDays(start, 6)),
      reason: "relative_week",
    };
  }
  if (/(上个月|上月)/u.test(text)) {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = endOfLocalDay(new Date(now.getFullYear(), now.getMonth(), 0));
    return {
      label: "上个月",
      start,
      end,
      reason: "relative_month",
    };
  }
  if (/今天/u.test(text) && /(刚|早上|上午|中午|下午|晚上|夜里|之前|前面|那个|那件|说|聊|提|图|文件|消息|回复)/u.test(text)) {
    return {
      label: "今天",
      start: todayStart,
      end: endOfLocalDay(now),
      reason: "today_reference",
    };
  }
  return null;
}

function stripTemporalWords(value) {
  return normalizeText(value)
    .replace(/20\d{2}[年/-]\s*\d{1,2}[月/-]\s*\d{1,2}(?:日|号)?/gu, " ")
    .replace(/\d{1,2}月\d{1,2}(?:日|号)?/gu, " ")
    .replace(/\d{1,2}[/-]\d{1,2}/gu, " ")
    .replace(/(大前天|前天|昨天|今天|刚才|刚刚|早些时候|方才|这两天|这几天|前两天|前几天|最近几天|上周|上星期|上礼拜|上个月|上月|上次|那天|当时|之前那次|之前那天|前面)/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferMonthDay(month, day, now) {
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  let date = new Date(now.getFullYear(), month - 1, day);
  if (!isValidDate(date) || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  if (date > addLocalDays(endOfLocalDay(now), 2)) {
    date = new Date(now.getFullYear() - 1, month - 1, day);
  }
  return isValidDate(date) ? date : null;
}

function parseChineseSmallNumber(value) {
  const text = normalizeText(value);
  if (/^\d+$/.test(text)) {
    return Number(text);
  }
  return {
    两: 2,
    三: 3,
    几: 3,
  }[text] || 0;
}

function startOfLocalDay(value) {
  const date = parseDate(value) || new Date();
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function endOfLocalDay(value) {
  const date = parseDate(value) || new Date();
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function startOfLocalWeek(value) {
  const date = startOfLocalDay(value);
  const day = date.getDay() || 7;
  return addLocalDays(date, 1 - day);
}

function addLocalDays(value, days) {
  const date = parseDate(value) || new Date();
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + Number(days || 0), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
}

function formatLocalDateLabel(value) {
  const date = parseDate(value) || new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function parseDate(value) {
  if (value instanceof Date && isValidDate(value)) {
    return value;
  }
  const text = normalizeText(value);
  if (!text) {
    return null;
  }
  const parsed = new Date(text);
  return isValidDate(parsed) ? parsed : null;
}

function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  buildTemporalRecallPacket,
  buildTemporalRecallPlan,
  stripTemporalWords,
};
