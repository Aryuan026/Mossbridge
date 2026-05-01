const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class CalendarStore {
  constructor(filePath, maxRecords = 2000) {
    this.filePath = path.resolve(filePath);
    this.maxRecords = Math.max(100, Number(maxRecords) || 100);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "[]\n", "utf8");
    }
  }

  listItems(scopedUserId, includeCompleted = true) {
    const scoped = normalizeText(scopedUserId);
    let rows = this.load()
      .filter((item) => normalizeText(item.scoped_user_id) === scoped)
      .map((item) => normalizeCalendarRow(item));
    if (!includeCompleted) {
      rows = rows.filter((item) => !item.completed);
    }
    rows.sort((left, right) => `${left.date || ""} ${left.time || ""}`.localeCompare(`${right.date || ""} ${right.time || ""}`));
    return rows;
  }

  listScopedUserIds(includeCompleted = false) {
    const seen = new Set();
    const output = [];
    this.load().forEach((item) => {
      if (!includeCompleted && item.completed) {
        return;
      }
      const scoped = normalizeText(item.scoped_user_id);
      if (!scoped || seen.has(scoped)) {
        return;
      }
      seen.add(scoped);
      output.push(scoped);
    });
    return output;
  }

  upsert(scopedUserId, payload = {}) {
    const scoped = normalizeText(scopedUserId);
    const rows = this.load();
    const itemId = normalizeText(payload.item_id) || createRecordId("cal");
    const now = localIso();
    const hasSource = Object.prototype.hasOwnProperty.call(payload, "source");
    const hasSourceDetail = Object.prototype.hasOwnProperty.call(payload, "source_detail");
    const hasSourceContext = Object.prototype.hasOwnProperty.call(payload, "source_context");
    const incoming = {
      item_id: itemId,
      scoped_user_id: scoped,
      title: normalizeText(payload.title),
      note: normalizeText(payload.note),
      date: normalizeText(payload.date),
      time: normalizeText(payload.time),
      bucket: normalizeText(payload.bucket) || "temporary",
      completed: Boolean(payload.completed),
      recurrence_label: normalizeText(payload.recurrence_label),
      remind_before_minutes: Number(payload.remind_before_minutes) || 0,
      source: hasSource ? normalizeText(payload.source) || "user" : "user",
      source_detail: hasSourceDetail ? normalizeText(payload.source_detail) : "",
      source_context: hasSourceContext ? normalizeText(payload.source_context) : "",
      last_notified_at: "",
      last_notified_event: "",
      created_at: now,
      updated_at: now,
    };

    let replaced = false;
    const nextRows = rows.map((row) => {
      if (normalizeText(row.item_id) !== itemId || normalizeText(row.scoped_user_id) !== scoped) {
        return row;
      }
      const normalizedRow = normalizeCalendarRow(row);
      replaced = true;
      return {
        ...incoming,
        created_at: normalizeText(normalizedRow.created_at) || now,
        source: hasSource ? incoming.source : (normalizeText(normalizedRow.source) || "user"),
        source_detail: hasSourceDetail ? incoming.source_detail : normalizeText(normalizedRow.source_detail),
        source_context: hasSourceContext ? incoming.source_context : normalizeText(normalizedRow.source_context),
      };
    });
    if (!replaced) {
      nextRows.push(incoming);
    }
    this.save(nextRows);
    return incoming;
  }

  delete(scopedUserId, itemId) {
    const scoped = normalizeText(scopedUserId);
    const target = normalizeText(itemId);
    const rows = this.load();
    const nextRows = rows.filter((row) => {
      return !(
        normalizeText(row.scoped_user_id) === scoped
        && normalizeText(row.item_id) === target
      );
    });
    if (nextRows.length === rows.length) {
      return false;
    }
    this.save(nextRows);
    return true;
  }

  setCompleted(scopedUserId, itemId, completed) {
    const scoped = normalizeText(scopedUserId);
    const target = normalizeText(itemId);
    let updated = null;
    const nextRows = this.load().map((row) => {
      if (normalizeText(row.scoped_user_id) !== scoped || normalizeText(row.item_id) !== target) {
        return row;
      }
      updated = {
        ...row,
        completed: Boolean(completed),
        updated_at: localIso(),
      };
      return updated;
    });
    if (updated) {
      this.save(nextRows);
    }
    return updated;
  }

  markNotified(scopedUserId, itemId, eventType) {
    const scoped = normalizeText(scopedUserId);
    const target = normalizeText(itemId);
    let updated = null;
    const nextRows = this.load().map((row) => {
      if (normalizeText(row.scoped_user_id) !== scoped || normalizeText(row.item_id) !== target) {
        return row;
      }
      updated = {
        ...row,
        last_notified_at: localIso(),
        last_notified_event: normalizeText(eventType),
      };
      return updated;
    });
    if (updated) {
      this.save(nextRows);
    }
    return updated;
  }

  summarizeForWakeup(scopedUserId, nowLocal = new Date()) {
    const current = stripTimezone(nowLocal);
    const upcomingThreshold = new Date(current.getTime() + (2 * 60 * 60 * 1000));
    const recentThreshold = new Date(current.getTime() - (12 * 60 * 60 * 1000));
    const today = currentDateKey(current);
    const tomorrow = currentDateKey(new Date(current.getTime() + (24 * 60 * 60 * 1000)));
    const upcoming = [];
    const overdue = [];
    const changedRecent = [];

    this.listItems(scopedUserId, false).forEach((item) => {
      const scheduledAt = coerceLocalSchedule(item.date, item.time);
      const brief = {
        item_id: normalizeText(item.item_id),
        title: normalizeText(item.title),
        date: normalizeText(item.date),
        time: normalizeText(item.time),
        bucket: normalizeText(item.bucket),
        source: normalizeText(item.source) || "user",
        source_detail: normalizeText(item.source_detail),
        all_day: !scheduledAt,
        last_notified_at: normalizeText(item.last_notified_at),
        last_notified_event: normalizeText(item.last_notified_event),
      };

      if (scheduledAt) {
        if (scheduledAt < current) {
          overdue.push(brief);
        } else if (scheduledAt <= upcomingThreshold) {
          upcoming.push(brief);
        }
      } else {
        const itemDate = normalizeText(item.date);
        if (itemDate && itemDate < today) {
          overdue.push(brief);
        } else if (itemDate && itemDate <= tomorrow) {
          upcoming.push(brief);
        }
      }

      const updatedAt = parseIso(item.updated_at);
      if (updatedAt && stripTimezone(updatedAt) >= recentThreshold) {
        changedRecent.push(brief);
      }
    });

    return {
      upcoming: upcoming.slice(0, 3),
      overdue: overdue.slice(0, 3),
      changed_recent: changedRecent.slice(0, 3),
      counts: {
        pending_total: this.listItems(scopedUserId, false).length,
        upcoming: upcoming.length,
        overdue: overdue.length,
        changed_recent: changedRecent.length,
      },
    };
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") : [];
    } catch {
      return [];
    }
  }

  save(rows) {
    const trimmed = Array.isArray(rows) ? rows.slice(-this.maxRecords) : [];
    fs.writeFileSync(this.filePath, `${JSON.stringify(trimmed, null, 2)}\n`, "utf8");
  }
}

function normalizeCalendarRow(row = {}) {
  return {
    ...row,
    source: normalizeText(row.source) || "user",
    source_detail: normalizeText(row.source_detail),
    source_context: normalizeText(row.source_context),
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function localIso() {
  return new Date().toISOString().slice(0, 19);
}

function parseIso(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function stripTimezone(date) {
  const parsed = date instanceof Date ? date : new Date(date);
  return new Date(
    parsed.getFullYear(),
    parsed.getMonth(),
    parsed.getDate(),
    parsed.getHours(),
    parsed.getMinutes(),
    parsed.getSeconds(),
  );
}

function currentDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function coerceLocalSchedule(dateText, timeText) {
  const dateValue = normalizeText(dateText);
  if (!dateValue) {
    return null;
  }
  const timeValue = normalizeText(timeText);
  const iso = timeValue ? `${dateValue}T${timeValue}:00` : `${dateValue}T00:00:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : stripTimezone(parsed);
}

function createRecordId(prefix) {
  if (typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  }
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  CalendarStore,
};
