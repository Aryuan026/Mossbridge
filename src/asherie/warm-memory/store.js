const fs = require("fs");
const path = require("path");

const {
  WarmMemoryScope,
  buildMaterialMarkdown,
  materialRelativePath,
  normalizeMaterialRecord,
} = require("./contracts");
const { buildWarmRouteScanBonus } = require("./route-signals");

const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30000;

class WarmMemoryStore {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
  }

  scopeDir(scope) {
    ensureScope(scope);
    return path.join(this.rootDir, ...scope.toPathParts());
  }

  indexPath(scope) {
    return path.join(this.scopeDir(scope), "index.json");
  }

  readIndex(scope) {
    const filePath = this.indexPath(scope);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const rows = Array.isArray(parsed.records) ? parsed.records : Array.isArray(parsed) ? parsed : [];
      const output = {};
      rows.forEach((item) => {
        if (!item || typeof item !== "object") {
          return;
        }
        const materialId = normalizeText(item.material_id);
        if (!materialId) {
          return;
        }
        output[materialId] = { ...item };
      });
      return output;
    } catch {
      return {};
    }
  }

  writeIndex(scope, records) {
    const scopeDir = this.scopeDir(scope);
    fs.mkdirSync(scopeDir, { recursive: true });
    const payload = {
      scope_id: scope.scopeId(),
      records: Array.isArray(records) ? records : [],
    };
    const target = this.indexPath(scope);
    const tmpPath = `${target}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, target);
  }

  upsertMaterial(scope, payload = {}) {
    return this.withIndexLock(scope, () => {
      const index = this.readIndex(scope);
      const requestedMaterialId = normalizeText(payload.material_id || payload.materialId);
      const existing = requestedMaterialId && index[requestedMaterialId]
        ? { ...index[requestedMaterialId] }
        : {};
      const merged = {
        ...existing,
        ...payload,
      };
      const record = normalizeMaterialRecord(merged, {
        nowIso: normalizeText(existing.created_at),
      });
      if (existing.created_at) {
        record.created_at = normalizeText(existing.created_at);
      }
      // Preserve existing pinned/resident state when not explicitly included in the update payload.
      if (
        existing.material_id
        && !Object.prototype.hasOwnProperty.call(payload, "pinned")
        && typeof existing.pinned === "boolean"
      ) {
        record.pinned = existing.pinned;
      }
      if (
        existing.material_id
        && !Object.prototype.hasOwnProperty.call(payload, "resident")
        && !Object.prototype.hasOwnProperty.call(payload, "residentMemory")
        && !Object.prototype.hasOwnProperty.call(payload, "resident_memory")
        && !Object.prototype.hasOwnProperty.call(payload, "residentWarm")
        && !Object.prototype.hasOwnProperty.call(payload, "resident_warm")
        && typeof existing.resident === "boolean"
      ) {
        record.resident = existing.resident;
      }
      if (
        existing.material_id
        && !Object.prototype.hasOwnProperty.call(payload, "resident_kind")
        && !Object.prototype.hasOwnProperty.call(payload, "residentKind")
        && normalizeText(existing.resident_kind)
      ) {
        record.resident_kind = normalizeText(existing.resident_kind);
      }
      record.write_count = existing.material_id ? Math.max(1, Number(existing.write_count) || 1) + 1 : 1;
      const accessLog = Array.isArray(record.access_log) ? record.access_log.slice() : [];
      const stamp = normalizeText(record.updated_at || record.created_at);
      if (stamp && accessLog[accessLog.length - 1] !== stamp) {
        accessLog.push(stamp);
      }
      record.access_log = accessLog.slice(-128);
      record.last_accessed_at = record.access_log[record.access_log.length - 1] || stamp;

      const relativePath = materialRelativePath(scope, record);
      const absolutePath = path.join(this.rootDir, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, buildMaterialMarkdown(record), "utf8");

      const stored = {
        ...record,
        relative_path: relativePath,
      };
      index[record.material_id] = stored;
      const ordered = Object.values(index).sort((left, right) => {
        return String(right.updated_at || "").localeCompare(String(left.updated_at || ""));
      });
      this.writeIndex(scope, ordered);
      return stored;
    });
  }

  applyRecallFeedback(scope, feedbackRows = []) {
    const rows = Array.isArray(feedbackRows)
      ? feedbackRows.filter((item) => item && typeof item === "object").map((item) => ({ ...item }))
      : [];
    if (!rows.length) {
      return { updated: 0, reinforced: 0 };
    }
    return this.withIndexLock(scope, () => {
      const index = this.readIndex(scope);
      let updated = 0;
      let reinforced = 0;

      rows.forEach((row) => {
        const materialId = normalizeText(row.material_id || row.materialId);
        if (!materialId || !index[materialId]) {
          return;
        }
        const current = { ...index[materialId] };
        const recalledAt = normalizeText(row.recalled_at || row.recalledAt) || new Date().toISOString();
        const accessLog = Array.isArray(current.access_log) ? current.access_log.slice() : [];
        if (recalledAt && accessLog[accessLog.length - 1] !== recalledAt) {
          accessLog.push(recalledAt);
        }
        current.access_log = accessLog.slice(-128);
        current.last_accessed_at = current.access_log[current.access_log.length - 1] || recalledAt;
        current.recall_count = (Number(current.recall_count) || 0) + 1;
        const suggestedBoost = Number(row.storage_boost ?? row.storageBoost);
        const currentBoost = Number(current.storage_boost) || 1;
        if (Number.isFinite(suggestedBoost) && suggestedBoost > currentBoost) {
          current.storage_boost = suggestedBoost;
          current.desirable_difficulty_hits = (Number(current.desirable_difficulty_hits) || 0) + 1;
          reinforced += 1;
        }
        index[materialId] = current;
        updated += 1;
      });

      const ordered = Object.values(index).sort((left, right) => {
        return String(right.updated_at || "").localeCompare(String(left.updated_at || ""));
      });
      this.writeIndex(scope, ordered);
      return { updated, reinforced };
    });
  }

  getMaterial(scope, materialId) {
    return this.readIndex(scope)[normalizeText(materialId)] || null;
  }

  listMaterials(scope, { materialTypes = [], limit = 80 } = {}) {
    const allowed = new Set(
      (Array.isArray(materialTypes) ? materialTypes : [materialTypes])
        .map((item) => normalizeText(item).toLowerCase())
        .filter(Boolean),
    );
    let rows = Object.values(this.readIndex(scope));
    if (allowed.size) {
      rows = rows.filter((row) => allowed.has(normalizeText(row.material_type).toLowerCase()));
    }
    rows.sort((left, right) => {
      const scoreDelta = scanPriority(right) - scanPriority(left);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return String(right.updated_at || "").localeCompare(String(left.updated_at || ""));
    });
    return rows.slice(0, Math.max(1, Number(limit) || 1));
  }

  countMaterials(scope, { materialTypes = [] } = {}) {
    return this.listMaterials(scope, { materialTypes, limit: 100000 }).length;
  }

  deleteMaterial(scope, materialId) {
    const target = normalizeText(materialId);
    if (!target) {
      return { ok: false, error: "empty material_id" };
    }
    return this.withIndexLock(scope, () => {
      const index = this.readIndex(scope);
      const record = index[target];
      if (!record) {
        return { ok: false, error: `material_id not found: ${target}` };
      }
      delete index[target];
      const relativePath = normalizeText(record.relative_path);
      if (relativePath) {
        fs.rmSync(path.join(this.rootDir, relativePath), { force: true });
      }
      const ordered = Object.values(index).sort((left, right) => String(right.updated_at || "").localeCompare(String(left.updated_at || "")));
      this.writeIndex(scope, ordered);
      return {
        ok: true,
        deleted_material_id: target,
      };
    });
  }

  clearScope(scope) {
    return this.withIndexLock(scope, () => {
      const scopeDir = this.scopeDir(scope);
      const recordCount = this.countMaterials(scope);
      const markdownCount = fs.existsSync(scopeDir)
        ? walkMarkdownFiles(scopeDir).length
        : 0;
      fs.rmSync(scopeDir, { recursive: true, force: true });
      return {
        deleted_records: recordCount,
        deleted_markdown_files: markdownCount,
      };
    });
  }

  withIndexLock(scope, fn) {
    const scopeDir = this.scopeDir(scope);
    fs.mkdirSync(scopeDir, { recursive: true });
    const lockDir = path.join(scopeDir, "index.json.lock");
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        fs.mkdirSync(lockDir);
        fs.writeFileSync(
          path.join(lockDir, "owner.json"),
          `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
          "utf8",
        );
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }
        try {
          const stat = fs.statSync(lockDir);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
            fs.rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {}
        if (Date.now() >= deadline) {
          throw new Error(`warm memory index is locked: ${lockDir}`);
        }
        sleepSync(50);
      }
    }
    try {
      return fn();
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }
}

function walkMarkdownFiles(rootDir) {
  const output = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.existsSync(current) ? fs.readdirSync(current, { withFileTypes: true }) : [];
    entries.forEach((entry) => {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(target);
        return;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        output.push(target);
      }
    });
  }
  return output;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, Math.max(1, Number(ms) || 1));
}

function scanPriority(row = {}) {
  const lastTouch = parseIso(row.last_accessed_at || row.updated_at || row.created_at);
  const hoursSince = lastTouch
    ? Math.max(0, (Date.now() - lastTouch.getTime()) / (60 * 60 * 1000))
    : 24;
  const freshness = 1 / (1 + (hoursSince / 24));
  const storageStrength = Math.max(0, Number(row.storage_strength) || 0);
  const storageBoost = Math.max(1, Number(row.storage_boost) || 1);
  const recallCount = Math.max(0, Number(row.recall_count) || 0);
  const writeCount = Math.max(1, Number(row.write_count) || 1);
  const routeBonus = Number(buildWarmRouteScanBonus(row).score) || 0;
  return (
    freshness * 2.2
    + Math.log1p(storageStrength) * 0.6
    + Math.log1p(storageBoost) * 0.5
    + recallCount * 0.12
    + Math.max(0, writeCount - 1) * 0.08
    + routeBonus
  );
}

function parseIso(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function ensureScope(scope) {
  if (!(scope instanceof WarmMemoryScope)) {
    throw new Error("WarmMemoryStore expects a WarmMemoryScope");
  }
}

module.exports = {
  WarmMemoryStore,
};
