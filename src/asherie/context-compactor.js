const TOKEN_PATTERN = /[a-zA-Z0-9._/-]{2,}|[\u4e00-\u9fff]{2,}/gu;

function compactMessages(
  messages = [],
  query = "",
  enabled = true,
  recentKeep = 6,
  relevantKeep = 4,
  digestMaxChars = 1200,
) {
  const report = {
    enabled: Boolean(enabled),
    recentKeep: Math.max(0, Number(recentKeep) || 0),
    relevantKeep: Math.max(0, Number(relevantKeep) || 0),
    digestMaxChars: Math.max(0, Number(digestMaxChars) || 0),
    totalMessages: Array.isArray(messages) ? messages.length : 0,
    keptMessages: Array.isArray(messages) ? messages.length : 0,
    droppedMessages: 0,
    selectedRelevantIndexes: [],
    selectedRecentIndexes: [],
    digestChars: 0,
    queryTerms: [],
  };

  const copied = Array.isArray(messages)
    ? messages.filter((item) => item && typeof item === "object").map((item) => ({ ...item }))
    : [];
  if (!enabled || copied.length <= 2) {
    return {
      compactedMessages: copied,
      digest: "",
      report,
    };
  }

  const leadingSystem = [];
  const body = [];
  let seenNonSystem = false;
  copied.forEach((item, index) => {
    const role = normalizeText(item.role);
    if (role === "system" && !seenNonSystem) {
      leadingSystem.push([index, item]);
      return;
    }
    seenNonSystem = true;
    body.push([index, item]);
  });

  if (!body.length) {
    return {
      compactedMessages: copied,
      digest: "",
      report,
    };
  }

  const keepRecent = Math.max(0, Math.min(report.recentKeep, body.length));
  const recentSlice = keepRecent > 0 ? body.slice(-keepRecent) : [];
  const recentIndexes = new Set(recentSlice.map(([index]) => index));
  report.selectedRecentIndexes = [...recentIndexes].sort((left, right) => left - right);

  const olderSlice = keepRecent > 0 ? body.slice(0, body.length - keepRecent) : body;
  const queryTerms = extractTerms(query);
  report.queryTerms = queryTerms;

  const ranked = [];
  olderSlice.forEach(([index, item]) => {
    const role = normalizeText(item.role);
    const text = contentToText(item.content);
    let score = scoreMessage(text, queryTerms);
    if (role === "user") {
      score += 1;
    }
    if (score > 0) {
      ranked.push([score, index]);
    }
  });
  ranked.sort((left, right) => right[0] - left[0]);

  const keepRelevant = Math.max(0, Math.min(report.relevantKeep, ranked.length));
  const relevantIndexes = new Set(ranked.slice(0, keepRelevant).map(([, index]) => index));
  report.selectedRelevantIndexes = [...relevantIndexes].sort((left, right) => left - right);

  const keepIndexes = new Set([...recentIndexes, ...relevantIndexes]);
  const keptBody = [];
  const droppedBody = [];
  body.forEach(([index, item]) => {
    if (keepIndexes.has(index)) {
      keptBody.push(item);
      return;
    }
    droppedBody.push([index, item]);
  });

  let digest = "";
  if (droppedBody.length && report.digestMaxChars > 0) {
    const lines = droppedBody
      .map(([, item]) => shortLine(normalizeText(item.role) || "unknown", contentToText(item.content)))
      .filter(Boolean);
    digest = lines.join("\n");
    if (digest.length > report.digestMaxChars) {
      digest = `${digest.slice(0, Math.max(0, report.digestMaxChars - 1)).trimEnd()}…`;
    }
  }

  const compactedMessages = leadingSystem.map(([, item]) => item).concat(keptBody);
  report.keptMessages = compactedMessages.length;
  report.droppedMessages = copied.length - compactedMessages.length;
  report.digestChars = digest.length;
  return {
    compactedMessages,
    digest,
    report,
  };
}

function contentToText(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const parts = [];
    let imageCount = 0;
    content.forEach((item) => {
      if (typeof item === "string") {
        if (item.trim()) {
          parts.push(item.trim());
        }
        return;
      }
      if (!item || typeof item !== "object") {
        return;
      }
      const type = normalizeText(item.type);
      if (type === "text") {
        const text = normalizeText(item.text);
        if (text) {
          parts.push(text);
        }
        return;
      }
      if (type === "image_url" || type === "input_image") {
        imageCount += 1;
      }
    });
    if (imageCount) {
      parts.push(`[图片 x${imageCount}]`);
    }
    return parts.join("\n").trim();
  }
  if (content == null) {
    return "";
  }
  return String(content).trim();
}

function normalizeTextBlock(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .replace(/\n{3,}/g, "\n\n");
}

function extractTerms(text) {
  const normalized = normalizeTextBlock(text).toLowerCase();
  if (!normalized) {
    return [];
  }
  const matches = normalized.match(TOKEN_PATTERN) || [];
  const seen = new Set();
  const output = [];
  matches.forEach((term) => {
    const trimmed = term.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    output.push(trimmed);
  });
  return output.slice(0, 80);
}

function scoreMessage(text, terms) {
  if (!terms.length) {
    return 0;
  }
  const blob = normalizeTextBlock(text).toLowerCase();
  if (!blob) {
    return 0;
  }
  return terms.reduce((score, term) => {
    if (!blob.includes(term)) {
      return score;
    }
    return score + 1 + Math.floor(Math.min(term.length, 6) / 2);
  }, 0);
}

function shortLine(role, text, maxLen = 120) {
  const compact = normalizeTextBlock(text).replace(/\s+/g, " ");
  if (!compact) {
    return "";
  }
  const shortened = compact.length > maxLen
    ? `${compact.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`
    : compact;
  return `- (${role}) ${shortened}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  compactMessages,
};
