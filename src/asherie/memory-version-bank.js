const fs = require("fs");
const path = require("path");
const {
  canonicalAgentId,
  canonicalUserId,
  resolveSingleIdentity,
} = require("./single-identity");

class MemoryVersionBank {
  constructor(baseDir, options = {}) {
    this.baseDir = path.resolve(baseDir);
    this.identity = resolveSingleIdentity(options.identity || {});
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  clearUser(userId) {
    const userDir = path.join(this.baseDir, normalizeText(userId));
    const versionsDir = path.join(userDir, "versions");
    const deletedVersions = fs.existsSync(versionsDir)
      ? fs.readdirSync(versionsDir).filter((entry) => entry.endsWith(".json")).length
      : 0;
    fs.rmSync(userDir, { recursive: true, force: true });
    return {
      deleted_versions: deletedVersions,
    };
  }

  listVersions(userId) {
    const manifest = this.loadManifest(userId);
    return {
      user_id: normalizeText(userId),
      active_version: manifest.active_version || null,
      versions: Array.isArray(manifest.versions) ? manifest.versions : [],
    };
  }

  activateVersion(userId, version) {
    const target = normalizeText(version);
    const manifest = this.loadManifest(userId);
    const exists = Array.isArray(manifest.versions) && manifest.versions.some((item) => normalizeText(item.version) === target);
    if (!exists) {
      throw new Error(`version not found: ${target}`);
    }
    manifest.active_version = target;
    this.saveManifest(userId, manifest);
    return {
      user_id: normalizeText(userId),
      active_version: target,
    };
  }

  upsertVersion(userId, assistantId, payload = {}, versionLabel = "", activate = true) {
    const manifest = this.loadManifest(userId);
    const version = normalizeText(versionLabel) || generateVersionLabel();
    const normalizedPayload = normalizePayload(payload);
    const counts = countPayload(normalizedPayload);
    const createdAt = new Date().toISOString();
    const canonicalUser = canonicalUserId(userId, this.identity);
    const canonicalAssistant = canonicalAgentId(assistantId, this.identity);
    const record = {
      meta: {
        user_id: canonicalUser,
        assistant_id: canonicalAssistant,
        version,
        created_at: createdAt,
        counts,
      },
      payload: normalizedPayload,
    };

    fs.writeFileSync(
      this.versionPath(userId, version),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );

    const versions = Array.isArray(manifest.versions)
      ? manifest.versions.filter((item) => normalizeText(item.version) !== version)
      : [];
    versions.push({
      version,
      assistant_id: canonicalAssistant,
      created_at: createdAt,
      counts,
    });
    versions.sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")));
    manifest.versions = versions;
    if (activate) {
      manifest.active_version = version;
    }
    this.saveManifest(userId, manifest);
    return {
      user_id: canonicalUser,
      version,
      active_version: manifest.active_version || null,
      counts,
    };
  }

  loadVersionPayload(userId, version = "") {
    const manifest = this.loadManifest(userId);
    const resolvedVersion = normalizeText(version) || normalizeText(manifest.active_version);
    if (!resolvedVersion) {
      throw new Error("no active version");
    }
    const filePath = this.versionPath(userId, resolvedVersion);
    if (!fs.existsSync(filePath)) {
      throw new Error(`version file not found: ${resolvedVersion}`);
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      version: resolvedVersion,
      payload: parsed && typeof parsed === "object" ? (parsed.payload || {}) : {},
    };
  }

  toIndexRecords(payload = {}) {
    const records = [];
    const normalized = normalizePayload(payload);

    normalized.persona_memos.forEach((item) => {
      const content = normalizeText(item.content);
      if (!content) {
        return;
      }
      records.push({
        role: "assistant",
        content,
        metadata: {
          source_type: "persona_memo",
          memory_id: item.id,
          type: item.type,
          object_name: item.object_name,
          tags: normalizeTags(item.tags),
        },
      });
    });

    normalized.hard_facts.forEach((item) => {
      const factKey = normalizeText(item.fact_key);
      if (!factKey) {
        return;
      }
      records.push({
        role: "assistant",
        content: `${factKey}: ${item.fact_value ?? ""}`,
        metadata: {
          source_type: "hard_fact",
          memory_id: item.id,
          fact_key: factKey,
          tags: ["#事实", factKey],
        },
      });
    });

    normalized.case_updates.forEach((item) => {
      const summary = normalizeText(item.summary);
      const nextAction = normalizeText(item.next_action);
      if (!summary && !nextAction) {
        return;
      }
      const content = nextAction ? `${summary}\n下一步: ${nextAction}`.trim() : summary;
      records.push({
        role: "assistant",
        content,
        metadata: {
          source_type: "case_update",
          memory_id: item.id,
          case_id: item.case_id,
          event_type: item.event_type,
          tags: ["#case", normalizeText(item.event_type) || "update"],
        },
      });
    });

    return records;
  }

  userDir(userId) {
    const resolved = path.join(this.baseDir, canonicalUserId(userId, this.identity));
    const versionsDir = path.join(resolved, "versions");
    fs.mkdirSync(versionsDir, { recursive: true });
    return resolved;
  }

  manifestPath(userId) {
    return path.join(this.userDir(userId), "manifest.json");
  }

  versionPath(userId, version) {
    return path.join(this.userDir(userId), "versions", `${normalizeText(version)}.json`);
  }

  defaultManifest(userId) {
    return {
      user_id: canonicalUserId(userId, this.identity),
      active_version: null,
      versions: [],
      updated_at: new Date().toISOString(),
    };
  }

  loadManifest(userId) {
    const filePath = this.manifestPath(userId);
    if (!fs.existsSync(filePath)) {
      const data = this.defaultManifest(userId);
      fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      return data;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : this.defaultManifest(userId);
    } catch {
      const fallback = this.defaultManifest(userId);
      fs.writeFileSync(filePath, `${JSON.stringify(fallback, null, 2)}\n`, "utf8");
      return fallback;
    }
  }

  saveManifest(userId, manifest = {}) {
    const payload = {
      ...manifest,
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(this.manifestPath(userId), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}

function normalizePayload(payload = {}) {
  return {
    persona_memos: Array.isArray(payload.persona_memos) ? payload.persona_memos : [],
    hard_facts: Array.isArray(payload.hard_facts) ? payload.hard_facts : [],
    case_updates: Array.isArray(payload.case_updates) ? payload.case_updates : [],
  };
}

function countPayload(payload = {}) {
  const normalized = normalizePayload(payload);
  return {
    persona: normalized.persona_memos.length,
    sql: normalized.hard_facts.length,
    case: normalized.case_updates.length,
  };
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) {
    return tags.map((item) => normalizeText(item)).filter(Boolean);
  }
  const value = normalizeText(tags);
  return value ? [value] : [];
}

function generateVersionLabel() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hours = String(now.getUTCHours()).padStart(2, "0");
  const minutes = String(now.getUTCMinutes()).padStart(2, "0");
  const seconds = String(now.getUTCSeconds()).padStart(2, "0");
  return `v${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  MemoryVersionBank,
  countPayload,
  normalizePayload,
};
