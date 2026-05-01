const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class WakeupStore {
  constructor(filePath, maxRecords = 500) {
    this.filePath = path.resolve(filePath);
    this.maxRecords = Math.max(50, Number(maxRecords) || 50);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, "[]\n", "utf8");
    }
  }

  append(record = {}) {
    const rows = this.load();
    const payload = {
      ...record,
      record_id: normalizeText(record.record_id) || createRecordId("wake"),
      ts_utc: normalizeText(record.ts_utc) || new Date().toISOString(),
      cleared: Boolean(record.cleared),
      cleared_at: normalizeText(record.cleared_at),
    };
    rows.push(payload);
    this.save(rows);
    return payload;
  }

  updateRecord(recordId, changes = {}) {
    const targetId = normalizeText(recordId);
    if (!targetId || !changes || typeof changes !== "object") {
      return null;
    }
    const rows = this.load();
    let updated = null;
    const nextRows = rows.map((row) => {
      if (normalizeText(row.record_id) !== targetId) {
        return row;
      }
      updated = { ...row, ...changes };
      return updated;
    });
    if (updated) {
      this.save(nextRows);
    }
    return updated;
  }

  recent(scopedUserId = "", limit = 20, includeCleared = false) {
    let rows = this.load().slice().reverse();
    const scoped = normalizeText(scopedUserId);
    if (scoped) {
      rows = rows.filter((item) => normalizeText(item.scoped_user_id) === scoped);
    }
    if (!includeCleared) {
      rows = rows.filter((item) => !item.cleared);
    }
    return rows.slice(0, Math.max(1, Math.min(Number(limit) || 20, 200)));
  }

  latestForContext(scopedUserId, contextKey) {
    const scoped = normalizeText(scopedUserId);
    const key = normalizeText(contextKey);
    if (!scoped || !key) {
      return null;
    }
    const rows = this.load();
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (normalizeText(row.scoped_user_id) !== scoped) {
        continue;
      }
      if (normalizeText(row.context_key) !== key) {
        continue;
      }
      return row;
    }
    return null;
  }

  lastSend(scopedUserId) {
    const scoped = normalizeText(scopedUserId);
    if (!scoped) {
      return null;
    }
    const rows = this.load();
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (normalizeText(row.scoped_user_id) !== scoped) {
        continue;
      }
      if (normalizeText(row.decision) !== "send") {
        continue;
      }
      return row;
    }
    return null;
  }

  clear(scopedUserId = "", beforeTs = "") {
    const scoped = normalizeText(scopedUserId);
    const cutoff = parseIso(beforeTs);
    const clearedAt = new Date().toISOString();
    let changed = 0;
    const nextRows = this.load().map((row) => {
      if (scoped && normalizeText(row.scoped_user_id) !== scoped) {
        return row;
      }
      if (row.cleared) {
        return row;
      }
      const rowTs = parseIso(row.ts_utc);
      if (cutoff && rowTs && rowTs > cutoff) {
        return row;
      }
      changed += 1;
      return {
        ...row,
        cleared: true,
        cleared_at: clearedAt,
      };
    });
    if (changed) {
      this.save(nextRows);
    }
    return changed;
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") : [];
    } catch {
      return [];
    }
  }

  save(records) {
    const trimmed = Array.isArray(records) ? records.slice(-this.maxRecords) : [];
    fs.writeFileSync(this.filePath, `${JSON.stringify(trimmed, null, 2)}\n`, "utf8");
  }
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseIso(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function createRecordId(prefix) {
  if (typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = {
  WakeupStore,
};
