const fs = require("fs");
const path = require("path");

const { normalizePayload } = require("./memory-version-bank");
const {
  canonicalAgentId,
  canonicalRealmId,
  canonicalUserId,
  resolveSingleIdentity,
} = require("./single-identity");

class ColdRootStore {
  constructor(baseDir, { memoryVersionBank, identity } = {}) {
    this.baseDir = path.resolve(baseDir);
    this.memoryVersionBank = memoryVersionBank || null;
    this.identity = resolveSingleIdentity(identity || {});
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  searchRoots(args = {}) {
    const scope = this.resolveScope(args);
    const index = this.ensureProjection({
      ...scope,
      version: normalizeText(args.version),
    });
    const rows = Array.isArray(index.roots) ? index.roots : [];
    const limit = clampLimit(args.limit, 8, 1, 50);
    const query = normalizeText(args.query || args.text);
    const minScore = Math.max(1, Number(args.min_score ?? args.minScore) || 2);
    const hits = query
      ? scoreRootRows(rows, query, limit, { minScore })
      : rows.slice(0, limit);
    return {
      ok: true,
      user_id: scope.userId,
      realm_id: scope.realmId,
      agent_id: scope.agentId,
      active_version: index.source_version || null,
      source_kind: normalizeText(index.source_kind) || "memory_version",
      total_root_count: Array.isArray(index.roots) ? index.roots.length : 0,
      hit_count: hits.length,
      hits,
    };
  }

  inspectDuplicateRoots(args = {}) {
    const scope = this.resolveScope(args);
    const index = this.ensureProjection({
      ...scope,
      version: normalizeText(args.version),
    });
    const rows = Array.isArray(index.roots) ? index.roots : [];
    const query = normalizeText(args.query || args.text);
    const limit = clampLimit(args.limit, 8, 1, 30);
    const maxRows = clampLimit(args.max_rows ?? args.maxRows, 220, 1, 500);
    const minScore = clampDuplicateScore(args.min_score ?? args.minScore, 78);
    const candidateRows = query
      ? scoreRootRows(rows, query, maxRows, { minScore: 1 })
      : rows.slice(0, maxRows);
    const clusters = buildDuplicateRootClusters(candidateRows, { limit, minScore });
    return {
      ok: true,
      user_id: scope.userId,
      realm_id: scope.realmId,
      agent_id: scope.agentId,
      active_version: index.source_version || null,
      source_kind: normalizeText(index.source_kind) || "memory_version",
      total_root_count: rows.length,
      scanned_root_count: candidateRows.length,
      duplicate_cluster_count: clusters.length,
      clusters,
    };
  }

  expandRootVines(args = {}) {
    const scope = this.resolveScope(args);
    const rootKeys = normalizeRootKeys(args.root_keys || args.rootKeys || args.root_key || args.rootKey);
    const limit = clampLimit(args.limit, 6, 1, 20);
    const perRootLimit = clampLimit(args.per_root_limit || args.perRootLimit, 3, 1, 10);
    const pointerMeta = resolveLegacyVinePointer(this.baseDir, scope);
    if (!rootKeys.length || !pointerMeta) {
      return {
        ok: true,
        user_id: scope.userId,
        realm_id: scope.realmId,
        agent_id: scope.agentId,
        source_kind: pointerMeta ? "truth_layer_vines" : "empty",
        active_version: pointerMeta ? pointerMeta.sourceVersion : null,
        seed_count: rootKeys.length,
        related_count: 0,
        related_roots: [],
      };
    }
    const parsed = readJsonFile(pointerMeta.indexPath);
    const related = [];
    const seen = new Set();
    for (const rootKey of rootKeys) {
      const edges = collectVineEdgesForRoot(parsed, rootKey);
      edges
        .slice()
        .sort((left, right) => (Number(right?.score) || 0) - (Number(left?.score) || 0))
        .slice(0, perRootLimit)
        .forEach((edge) => {
          const other = edge && typeof edge === "object" && edge.other && typeof edge.other === "object"
            ? edge.other
            : {};
          const otherKey = normalizeText(other.root_key);
          if (!otherKey || rootKeys.includes(otherKey)) {
            return;
          }
          const relationKey = `${rootKey} -> ${otherKey}`;
          if (seen.has(relationKey)) {
            return;
          }
          seen.add(relationKey);
          related.push({
            seed_root_key: rootKey,
            root_key: otherKey,
            canonical_name: normalizeText(other.canonical_name) || otherKey,
            anchor_type: normalizeText(other.anchor_type),
            tree_path: normalizeText(other.tree_path),
            primary_relation: normalizeText(edge.primary_relation) || "related",
            direction: normalizeText(edge.direction),
            score: Number(edge.score) || 0,
            overlap: edge.overlap && typeof edge.overlap === "object" ? edge.overlap : {},
          });
        });
    }
    related.sort((left, right) => (Number(right.score) || 0) - (Number(left.score) || 0));
    return {
      ok: true,
      user_id: scope.userId,
      realm_id: scope.realmId,
      agent_id: scope.agentId,
      source_kind: "truth_layer_vines",
      active_version: pointerMeta.sourceVersion,
      seed_count: rootKeys.length,
      related_count: related.length,
      related_roots: related.slice(0, limit),
    };
  }

  readRoot(args = {}) {
    const scope = this.resolveScope(args);
    const rootKey = normalizeText(args.root_key || args.rootKey);
    if (!rootKey) {
      throw new Error("root_key is required");
    }
    const index = this.ensureProjection({
      ...scope,
      version: normalizeText(args.version),
    });
    const row = findRootRow(index, rootKey);
    if (!row) {
      return {
        ok: false,
        user_id: scope.userId,
        realm_id: scope.realmId,
        agent_id: scope.agentId,
        active_version: index.source_version || null,
        root_key: rootKey,
        root: null,
        error: `cold root not found: ${rootKey}`,
      };
    }
    return {
      ok: true,
      user_id: scope.userId,
      realm_id: scope.realmId,
      agent_id: scope.agentId,
      active_version: index.source_version || null,
      source_kind: normalizeText(index.source_kind) || "memory_version",
      root_key: rootKey,
      root: this.loadRootFile(row.file, scope),
      error: "",
    };
  }

  patchRoot(args = {}) {
    const scope = this.resolveScope(args);
    const rootKey = normalizeText(args.root_key || args.rootKey);
    const mode = normalizePatchMode(args.mode);
    const changes = args.changes && typeof args.changes === "object" && !Array.isArray(args.changes)
      ? { ...args.changes }
      : {};
    if (!rootKey) {
      throw new Error("root_key is required");
    }
    if (mode !== "delete" && !Object.keys(changes).length) {
      throw new Error("changes are required unless mode is delete");
    }

    const index = this.ensureProjection({
      ...scope,
      version: normalizeText(args.version),
    });
    if (normalizeText(index.source_kind) === "truth_layer_snapshot") {
      return {
        ok: false,
        user_id: scope.userId,
        realm_id: scope.realmId,
        agent_id: scope.agentId,
        previous_root_key: rootKey,
        root_key: rootKey,
        version: index.source_version || null,
        active_version: index.source_version || null,
        deleted: false,
        root: null,
        error: "legacy truth-layer roots are read-only until a cold memory version is materialized",
      };
    }
    const row = findRootRow(index, rootKey);
    if (!row) {
      return {
        ok: false,
        user_id: scope.userId,
        realm_id: scope.realmId,
        agent_id: scope.agentId,
        previous_root_key: rootKey,
        root_key: rootKey,
        version: index.source_version || null,
        active_version: index.source_version || null,
        deleted: false,
        root: null,
        error: `cold root not found: ${rootKey}`,
      };
    }

    const loaded = this.memoryVersionBank
      ? this.memoryVersionBank.loadVersionPayload(scope.userId, index.source_version || "")
      : { version: "", payload: {} };
    const payload = normalizePayload(loaded.payload || {});
    const section = normalizeText(row.payload_section);
    const sourceItems = Array.isArray(payload[section]) ? payload[section].map(cloneValue) : [];
    const targetIndex = findSourceItemIndex(row, sourceItems);
    if (targetIndex < 0) {
      return {
        ok: false,
        user_id: scope.userId,
        realm_id: scope.realmId,
        agent_id: scope.agentId,
        previous_root_key: rootKey,
        root_key: rootKey,
        version: loaded.version || index.source_version || null,
        active_version: loaded.version || index.source_version || null,
        deleted: false,
        root: null,
        error: `cold root target missing from active payload: ${rootKey}`,
      };
    }

    const currentItem = sourceItems[targetIndex] && typeof sourceItems[targetIndex] === "object"
      ? sourceItems[targetIndex]
      : {};
    let nextItems = sourceItems;
    let nextItem = null;
    if (mode === "delete") {
      nextItems = sourceItems.filter((_, itemIndex) => itemIndex !== targetIndex);
    } else {
      nextItem = mode === "replace"
        ? { ...changes }
        : { ...currentItem, ...changes };
      if (!normalizeText(nextItem.id) && normalizeText(currentItem.id)) {
        nextItem.id = currentItem.id;
      }
      nextItems = sourceItems.map((item, itemIndex) => (itemIndex === targetIndex ? nextItem : item));
    }

    const updatedPayload = {
      ...payload,
      [section]: nextItems,
    };
    const write = this.memoryVersionBank.upsertVersion(
      scope.userId,
      canonicalAgentId(args.assistant_id || args.assistantId, this.identity),
      updatedPayload,
      normalizeText(args.version_label || args.versionLabel),
      true,
    );
    const nextIndex = this.projectVersion({
      ...scope,
      sourceVersion: write.version,
      payload: updatedPayload,
    });
    const nextRootKey = nextItem ? buildRootKey(row.source_type, nextItem, targetIndex) : "";
    const nextRow = nextRootKey ? findRootRow(nextIndex, nextRootKey) : null;
    return {
      ok: true,
      user_id: scope.userId,
      realm_id: scope.realmId,
      agent_id: scope.agentId,
      previous_version: loaded.version || index.source_version || null,
      version: write.version,
      active_version: write.active_version || write.version,
      previous_root_key: rootKey,
      root_key: nextRow?.root_key || rootKey,
      deleted: mode === "delete",
      mode,
      root: nextRow ? this.loadRootFile(nextRow.file, scope) : null,
      error: "",
    };
  }

  ensureProjection(args = {}) {
    const scope = this.resolveScope(args);
    const requestedVersion = normalizeText(args.version);
    if (args.payload && typeof args.payload === "object") {
      return this.projectVersion({
        ...scope,
        sourceVersion: normalizeText(args.sourceVersion || requestedVersion),
        payload: args.payload,
      });
    }
    if (!this.memoryVersionBank) {
      return this.loadLegacyIndex(scope) || this.writeEmptyIndex(scope);
    }
    try {
      const loaded = this.memoryVersionBank.loadVersionPayload(scope.userId, requestedVersion);
      const existing = this.loadIndex(scope);
      if (existing && normalizeText(existing.source_version) === normalizeText(loaded.version)) {
        return existing;
      }
      return this.projectVersion({
        ...scope,
        sourceVersion: loaded.version,
        payload: loaded.payload,
      });
    } catch (error) {
      if (!requestedVersion) {
        const legacy = this.loadLegacyIndex(scope);
        if (legacy) {
          return legacy;
        }
      }
      return this.writeEmptyIndex(scope);
    }
  }

  describeActiveSource(args = {}) {
    const scope = this.resolveScope(args);
    const index = this.ensureProjection({
      ...scope,
      version: normalizeText(args.version),
    });
    return {
      user_id: scope.userId,
      realm_id: scope.realmId,
      agent_id: scope.agentId,
      source_kind: normalizeText(index.source_kind) || "memory_version",
      active_version: index.source_version || null,
      root_count: Array.isArray(index.roots) ? index.roots.length : 0,
      scope_mode: normalizeText(index.scope_mode),
      snapshot_path: normalizeText(index.snapshot_path),
    };
  }

  projectVersion({ userId, realmId, agentId, sourceVersion, payload } = {}) {
    const scope = this.resolveScope({ userId, realmId, agentId });
    const rootsDir = this.rootsDir(scope);
    fs.rmSync(rootsDir, { recursive: true, force: true });
    fs.mkdirSync(rootsDir, { recursive: true });

    const rows = buildProjectedRootRows(rootsDir, normalizePayload(payload), normalizeText(sourceVersion));
    rows.forEach((row) => {
      fs.writeFileSync(row.write_file, `${JSON.stringify(row.root, null, 2)}\n`, "utf8");
    });

    const index = {
      user_id: scope.userId,
      realm_id: scope.realmId,
      agent_id: scope.agentId,
      source_kind: "memory_version",
      source_version: normalizeText(sourceVersion),
      generated_at: new Date().toISOString(),
      root_count: rows.length,
      roots: rows.map(({ root, write_file, ...summary }) => summary),
    };
    fs.writeFileSync(this.indexPath(scope), `${JSON.stringify(index, null, 2)}\n`, "utf8");
    return index;
  }

  loadIndex(args = {}) {
    const scope = this.resolveScope(args);
    const filePath = this.indexPath(scope);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  writeEmptyIndex(args = {}) {
    const scope = this.resolveScope(args);
    const rootsDir = this.rootsDir(scope);
    fs.rmSync(rootsDir, { recursive: true, force: true });
    fs.mkdirSync(rootsDir, { recursive: true });
    const index = {
      user_id: scope.userId,
      realm_id: scope.realmId,
      agent_id: scope.agentId,
      source_kind: "empty",
      source_version: "",
      generated_at: new Date().toISOString(),
      root_count: 0,
      roots: [],
    };
    fs.writeFileSync(this.indexPath(scope), `${JSON.stringify(index, null, 2)}\n`, "utf8");
    return index;
  }

  loadRootFile(filePath, scope = null) {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.scopeDir(scope || this.resolveScope({})), filePath);
    try {
      const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  scopeDir(scope) {
    return path.join(this.baseDir, scope.userId, scope.realmId, scope.agentId);
  }

  rootsDir(scope) {
    return path.join(this.scopeDir(scope), "roots");
  }

  indexPath(scope) {
    return path.join(this.scopeDir(scope), "active-index.json");
  }

  loadLegacyIndex(args = {}) {
    const scope = this.resolveScope(args);
    const pointerMeta = resolveLegacySnapshotPointer(this.baseDir, scope);
    if (!pointerMeta) {
      return null;
    }
    const parsed = readJsonFile(pointerMeta.indexPath);
    const roots = Array.isArray(parsed?.roots)
      ? parsed.roots.map((row) => normalizeLegacyRootRow(row, pointerMeta))
      : [];
    return {
      user_id: scope.userId,
      realm_id: scope.realmId,
      agent_id: scope.agentId,
      source_kind: "truth_layer_snapshot",
      source_version: pointerMeta.sourceVersion,
      generated_at: normalizeText(parsed?.generated_at) || normalizeText(pointerMeta.pointer?.generated_at) || new Date().toISOString(),
      root_count: roots.length,
      roots,
      scope_mode: pointerMeta.scopeMode,
      snapshot_path: pointerMeta.snapshotPath,
    };
  }

  resolveScope(args = {}) {
    const userId = canonicalUserId(args.userId || args.user_id, this.identity);
    const realmId = canonicalRealmId(args.realmId || args.realm_id, this.identity);
    const agentId = canonicalAgentId(args.agentId || args.agent_id, this.identity);
    return { userId, realmId, agentId };
  }
}

function buildProjectedRootRows(rootsDir, payload = {}, sourceVersion = "") {
  const rows = [];
  const appendRow = (section, sourceType, item, itemIndex) => {
    const rootKey = buildRootKey(sourceType, item, itemIndex);
    const title = buildRootTitle(sourceType, item, itemIndex);
    const summary = buildRootSummary(sourceType, item);
    const bodyMarkdown = buildRootBody(sourceType, item);
    const tags = buildRootTags(sourceType, item);
    const root = {
      root_key: rootKey,
      source_type: sourceType,
      payload_section: section,
      source_version: sourceVersion,
      item_id: normalizeText(item.id),
      item_index: itemIndex,
      title,
      summary,
      body_markdown: bodyMarkdown,
      tags,
      search_text: buildSearchText(rootKey, title, summary, bodyMarkdown, tags, item),
      item: cloneValue(item),
    };
    rows.push({
      root_key: rootKey,
      source_type: sourceType,
      payload_section: section,
      source_version: sourceVersion,
      item_id: root.item_id,
      item_index: itemIndex,
      title,
      summary,
      tags,
      search_text: root.search_text,
      file: path.join("roots", `${encodeURIComponent(rootKey)}.json`),
      write_file: path.join(rootsDir, `${encodeURIComponent(rootKey)}.json`),
      root,
    });
  };

  listItems(payload.persona_memos).forEach((item, itemIndex) => appendRow("persona_memos", "persona_memo", item, itemIndex));
  listItems(payload.hard_facts).forEach((item, itemIndex) => appendRow("hard_facts", "hard_fact", item, itemIndex));
  listItems(payload.case_updates).forEach((item, itemIndex) => appendRow("case_updates", "case_update", item, itemIndex));

  return rows;
}

function findRootRow(index, rootKey) {
  const rows = Array.isArray(index?.roots) ? index.roots : [];
  return rows.find((row) => normalizeText(row.root_key) === normalizeText(rootKey)) || null;
}

function buildDuplicateRootClusters(rows, { limit = 8, minScore = 78 } = {}) {
  const uniqueRows = uniqueRootRows(rows);
  if (uniqueRows.length < 2) {
    return [];
  }
  const pairs = [];
  for (let leftIndex = 0; leftIndex < uniqueRows.length - 1; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < uniqueRows.length; rightIndex += 1) {
      const scored = scoreDuplicateRootPair(uniqueRows[leftIndex], uniqueRows[rightIndex]);
      if (scored.score >= minScore) {
        pairs.push({
          left: normalizeText(uniqueRows[leftIndex].root_key),
          right: normalizeText(uniqueRows[rightIndex].root_key),
          score: scored.score,
          reason: scored.reason,
        });
      }
    }
  }
  if (!pairs.length) {
    return [];
  }

  const parent = new Map(uniqueRows.map((row) => [normalizeText(row.root_key), normalizeText(row.root_key)]));
  const find = (key) => {
    const current = parent.get(key) || key;
    if (current === key) {
      return key;
    }
    const root = find(current);
    parent.set(key, root);
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent.set(rightRoot, leftRoot);
    }
  };
  pairs.forEach((pair) => union(pair.left, pair.right));

  const grouped = new Map();
  uniqueRows.forEach((row) => {
    const key = normalizeText(row.root_key);
    const root = find(key);
    if (!grouped.has(root)) {
      grouped.set(root, []);
    }
    grouped.get(root).push(row);
  });

  return [...grouped.values()]
    .filter((groupRows) => groupRows.length > 1)
    .map((groupRows, clusterIndex) => {
      const rootKeys = new Set(groupRows.map((row) => normalizeText(row.root_key)));
      const groupPairs = pairs.filter((pair) => rootKeys.has(pair.left) && rootKeys.has(pair.right));
      const keepRoot = chooseDuplicateKeepRoot(groupRows);
      const duplicateRows = groupRows.filter((row) => normalizeText(row.root_key) !== normalizeText(keepRoot?.root_key));
      return {
        cluster_id: `cold_dup_${String(clusterIndex + 1).padStart(2, "0")}`,
        score: Math.max(...groupPairs.map((pair) => pair.score)),
        reasons: uniqueTexts(groupPairs.map((pair) => pair.reason)).slice(0, 4),
        root_keys: sortRootRows(groupRows).map((row) => normalizeText(row.root_key)),
        suggested_keep_root_key: normalizeText(keepRoot?.root_key),
        roots: sortRootRows(groupRows).map(summarizeDuplicateRootRow),
        suggested_actions: [
          ...sortRootRows(groupRows).map((row) => ({
            tool: "mossbridge_memory_cold_root_read",
            root_key: normalizeText(row.root_key),
            reason: "Read exact root content before changing cold memory.",
          })),
          {
            tool: "mossbridge_memory_cold_patch",
            root_key: normalizeText(keepRoot?.root_key),
            mode: "merge",
            reason: "If the roots contain complementary evidence, merge verified fields into this root first.",
          },
          ...sortRootRows(duplicateRows).map((row) => ({
            tool: "mossbridge_memory_cold_patch",
            root_key: normalizeText(row.root_key),
            mode: "delete",
            reason: "Delete only after merged evidence or explicit user confirmation that this root is stale.",
          })),
        ],
      };
    })
    .sort((left, right) => {
      const scoreDiff = (Number(right.score) || 0) - (Number(left.score) || 0);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
      const sizeDiff = right.root_keys.length - left.root_keys.length;
      if (sizeDiff !== 0) {
        return sizeDiff;
      }
      return String(left.root_keys[0] || "").localeCompare(String(right.root_keys[0] || ""));
    })
    .slice(0, limit)
    .map((cluster, index) => ({
      ...cluster,
      cluster_id: `cold_dup_${String(index + 1).padStart(2, "0")}`,
    }));
}

function uniqueRootRows(rows) {
  const seen = new Set();
  const output = [];
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const rootKey = normalizeText(row?.root_key);
    if (!rootKey || seen.has(rootKey)) {
      return;
    }
    seen.add(rootKey);
    output.push(row);
  });
  return output;
}

function scoreDuplicateRootPair(left, right) {
  const leftSource = normalizeText(left?.source_type);
  const rightSource = normalizeText(right?.source_type);
  const sameSource = leftSource && leftSource === rightSource;
  const leftIdentity = duplicateIdentityKey(left);
  const rightIdentity = duplicateIdentityKey(right);
  if (sameSource && leftIdentity && leftIdentity === rightIdentity) {
    return { score: 100, reason: "same source type and normalized root identity" };
  }

  const leftFingerprint = duplicateTextFingerprint(left);
  const rightFingerprint = duplicateTextFingerprint(right);
  if (leftFingerprint && leftFingerprint === rightFingerprint) {
    return { score: sameSource ? 96 : 88, reason: "same normalized root text" };
  }

  const leftLabel = duplicateLabel(left);
  const rightLabel = duplicateLabel(right);
  if (leftLabel && leftLabel === rightLabel) {
    return { score: sameSource ? 92 : 82, reason: "same normalized root label" };
  }

  const overlapScore = scoreDuplicateTokenOverlap(left, right);
  if (!overlapScore) {
    return { score: 0, reason: "" };
  }
  const adjustedScore = sameSource ? overlapScore : Math.min(overlapScore, 74);
  return {
    score: adjustedScore,
    reason: "high title/summary token overlap",
  };
}

function duplicateIdentityKey(row) {
  const sourceType = normalizeText(row?.source_type);
  const label = duplicateLabel(row);
  if (!sourceType || !label) {
    return "";
  }
  if (sourceType === "hard_fact") {
    return `${sourceType}:${label}`;
  }
  const fingerprint = duplicateTextFingerprint(row);
  return fingerprint ? `${sourceType}:${fingerprint}` : `${sourceType}:${label}`;
}

function duplicateLabel(row) {
  return normalizeDuplicateText([
    row?.canonical_name,
    row?.tree_path,
    row?.title,
  ].map(normalizeText).find(Boolean));
}

function duplicateTextFingerprint(row) {
  return normalizeDuplicateText([
    row?.source_type,
    row?.title,
    row?.summary,
    Array.isArray(row?.tags) ? row.tags.join(" ") : "",
  ].join(" "));
}

function scoreDuplicateTokenOverlap(left, right) {
  const leftTokens = duplicateTokenSet(left);
  const rightTokens = duplicateTokenSet(right);
  if (leftTokens.size < 3 || rightTokens.size < 3) {
    return 0;
  }
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  if (!intersection) {
    return 0;
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const jaccard = intersection / union;
  const coverage = intersection / Math.min(leftTokens.size, rightTokens.size);
  return Math.round(Math.max(jaccard * 100, coverage * 86));
}

function duplicateTokenSet(row) {
  const text = [
    row?.title,
    row?.summary,
    Array.isArray(row?.tags) ? row.tags.join(" ") : "",
  ].map(normalizeText).filter(Boolean).join(" ");
  return new Set(tokenizeQuery(text).filter((token) => !isDuplicateStopToken(token)));
}

function isDuplicateStopToken(token) {
  const normalized = normalizeText(token).toLowerCase();
  return !normalized || [
    "user",
    "uses",
    "like",
    "likes",
    "want",
    "wants",
    "needs",
    "prefers",
    "this",
    "that",
    "with",
    "from",
    "the",
    "and",
  ].includes(normalized);
}

function chooseDuplicateKeepRoot(rows) {
  return sortRootRows(rows)
    .slice()
    .sort((left, right) => {
      const qualityDiff = scoreRootQuality(right) - scoreRootQuality(left);
      if (qualityDiff !== 0) {
        return qualityDiff;
      }
      const leftIndex = Number.isInteger(Number(left?.item_index)) ? Number(left.item_index) : Number.MAX_SAFE_INTEGER;
      const rightIndex = Number.isInteger(Number(right?.item_index)) ? Number(right.item_index) : Number.MAX_SAFE_INTEGER;
      if (leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
      }
      return normalizeText(left?.root_key).localeCompare(normalizeText(right?.root_key));
    })[0] || null;
}

function scoreRootQuality(row) {
  const summaryLength = normalizeText(row?.summary).length;
  const tagCount = Array.isArray(row?.tags) ? row.tags.length : 0;
  const idBonus = normalizeText(row?.item_id) ? 8 : 0;
  const legacyBonus = (Number(row?.version_count) || 0) + (Number(row?.branch_count) || 0);
  return Math.min(80, summaryLength) + (tagCount * 6) + idBonus + legacyBonus;
}

function summarizeDuplicateRootRow(row) {
  return {
    root_key: normalizeText(row?.root_key),
    source_type: normalizeText(row?.source_type),
    payload_section: normalizeText(row?.payload_section),
    title: normalizeText(row?.title),
    canonical_name: normalizeText(row?.canonical_name),
    summary: normalizeText(row?.summary),
    tags: Array.isArray(row?.tags) ? row.tags.map((tag) => normalizeText(tag)).filter(Boolean).slice(0, 8) : [],
    item_id: normalizeText(row?.item_id),
    item_index: Number.isFinite(Number(row?.item_index)) ? Number(row.item_index) : null,
    file: normalizeText(row?.file),
  };
}

function sortRootRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .slice()
    .sort((left, right) => {
      const sourceDiff = normalizeText(left?.source_type).localeCompare(normalizeText(right?.source_type));
      if (sourceDiff !== 0) {
        return sourceDiff;
      }
      const titleDiff = normalizeText(left?.title).localeCompare(normalizeText(right?.title));
      if (titleDiff !== 0) {
        return titleDiff;
      }
      return normalizeText(left?.root_key).localeCompare(normalizeText(right?.root_key));
    });
}

function resolveLegacySnapshotPointer(baseDir, scope) {
  const candidates = [
    {
      scopeMode: "scoped",
      pointerPath: path.join(baseDir, "scopes", scope.userId, scope.realmId, "sql_roots", "latest.json"),
    },
    {
      scopeMode: "global",
      pointerPath: path.join(baseDir, "sql_roots", "latest.json"),
    },
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.pointerPath)) {
      continue;
    }
    const pointer = readJsonFile(candidate.pointerPath);
    const snapshotPath = normalizeText(pointer?.latest_snapshot);
    if (!snapshotPath) {
      continue;
    }
    const indexPath = path.join(snapshotPath, "index.json");
    if (!fs.existsSync(indexPath)) {
      continue;
    }
    return {
      ...candidate,
      pointer,
      snapshotPath,
      indexPath,
      sourceVersion: buildLegacySourceVersion(snapshotPath),
    };
  }
  return null;
}

function resolveLegacyVinePointer(baseDir, scope) {
  const candidates = [
    {
      scopeMode: "scoped",
      pointerPath: path.join(baseDir, "scopes", scope.userId, scope.realmId, "sql_vines", "runtime", "latest.json"),
    },
    {
      scopeMode: "scoped",
      pointerPath: path.join(baseDir, "scopes", scope.userId, scope.realmId, "sql_vines", "latest.json"),
    },
    {
      scopeMode: "global",
      pointerPath: path.join(baseDir, "sql_vines", "runtime", "latest.json"),
    },
    {
      scopeMode: "global",
      pointerPath: path.join(baseDir, "sql_vines", "latest.json"),
    },
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.pointerPath)) {
      continue;
    }
    const pointer = readJsonFile(candidate.pointerPath);
    const snapshotPath = normalizeText(pointer?.latest_snapshot);
    if (!snapshotPath) {
      continue;
    }
    const indexPath = path.join(snapshotPath, "index.json");
    if (!fs.existsSync(indexPath)) {
      continue;
    }
    return {
      ...candidate,
      pointer,
      snapshotPath,
      indexPath,
      sourceVersion: buildLegacyVineSourceVersion(snapshotPath),
    };
  }
  return null;
}

function buildLegacySourceVersion(snapshotPath) {
  const label = path.basename(normalizeText(snapshotPath));
  return label ? `truth_layer:${label}` : "truth_layer:latest";
}

function buildLegacyVineSourceVersion(snapshotPath) {
  const label = path.basename(normalizeText(snapshotPath));
  return label ? `truth_vines:${label}` : "truth_vines:latest";
}

function collectVineEdgesForRoot(index, rootKey) {
  const normalizedRootKey = normalizeText(rootKey);
  if (!normalizedRootKey || !index || typeof index !== "object") {
    return [];
  }
  const byRoot = index.by_root && typeof index.by_root === "object" ? index.by_root : {};
  if (Array.isArray(byRoot[normalizedRootKey])) {
    return byRoot[normalizedRootKey];
  }
  const edges = Array.isArray(index.edges) ? index.edges : [];
  return edges
    .map((edge) => normalizeRuntimeVineEdge(edge, normalizedRootKey))
    .filter(Boolean);
}

function normalizeRuntimeVineEdge(edge, rootKey) {
  if (!edge || typeof edge !== "object") {
    return null;
  }
  const fromRoot = edge.from_root && typeof edge.from_root === "object" ? edge.from_root : {};
  const toRoot = edge.to_root && typeof edge.to_root === "object" ? edge.to_root : {};
  const fromKey = normalizeText(fromRoot.root_key);
  const toKey = normalizeText(toRoot.root_key);
  if (fromKey === rootKey && toKey) {
    return {
      direction: normalizeText(edge.direction) || "out",
      other: toRoot,
      primary_relation: normalizeText(edge.primary_relation) || normalizeText(edge.relation) || "related",
      score: Number(edge.score) || 0,
      overlap: edge.overlap && typeof edge.overlap === "object" ? edge.overlap : {},
    };
  }
  if (toKey === rootKey && fromKey) {
    return {
      direction: normalizeText(edge.direction) || "in",
      other: fromRoot,
      primary_relation: normalizeText(edge.primary_relation) || normalizeText(edge.relation) || "related",
      score: Number(edge.score) || 0,
      overlap: edge.overlap && typeof edge.overlap === "object" ? edge.overlap : {},
    };
  }
  return null;
}

function normalizeLegacyRootRow(row, pointerMeta) {
  const record = row && typeof row === "object" ? row : {};
  const canonicalName = normalizeText(record.canonical_name);
  const rootKey = normalizeText(record.root_key);
  return {
    root_key: rootKey,
    source_type: normalizeText(record.anchor_type) || "truth_root",
    payload_section: "truth_layer",
    source_version: pointerMeta.sourceVersion,
    item_id: "",
    item_index: -1,
    title: canonicalName || rootKey,
    summary: buildLegacyRootSummary(record),
    tags: [
      normalizeText(record.anchor_type),
      normalizeText(record.tree_path),
      normalizeText(record.evolution_status),
    ].filter(Boolean),
    search_text: normalizeText(record.search_text),
    file: normalizeLegacyRootFile(record.file, pointerMeta.snapshotPath),
    tree_path: normalizeText(record.tree_path),
    canonical_name: canonicalName,
    anchor_type: normalizeText(record.anchor_type),
    version_count: Number(record.version_count) || 0,
    branch_count: Number(record.branch_count) || 0,
    evolution_status: normalizeText(record.evolution_status),
  };
}

function normalizeLegacyRootFile(filePath, snapshotPath) {
  const resolved = normalizeText(filePath);
  if (path.isAbsolute(resolved)) {
    return resolved;
  }
  return resolved ? path.join(snapshotPath, resolved) : "";
}

function buildLegacyRootSummary(row) {
  const canonicalName = normalizeText(row?.canonical_name);
  const treePath = normalizeText(row?.tree_path);
  const status = normalizeText(row?.evolution_status);
  return [canonicalName, treePath, status].filter(Boolean).join(" | ");
}

function readJsonFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function findSourceItemIndex(row, items) {
  const itemId = normalizeText(row.item_id);
  if (itemId) {
    const byId = items.findIndex((item) => normalizeText(item?.id) === itemId);
    if (byId >= 0) {
      return byId;
    }
  }

  if (row.source_type === "hard_fact") {
    const title = normalizeText(row.title);
    if (title) {
      const byFactKey = items.findIndex((item) => normalizeText(item?.fact_key) === title);
      if (byFactKey >= 0) {
        return byFactKey;
      }
    }
  }

  const numericIndex = Number(row.item_index);
  if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < items.length) {
    const candidate = items[numericIndex];
    if (buildRootKey(row.source_type, candidate, numericIndex) === normalizeText(row.root_key)) {
      return numericIndex;
    }
  }

  return items.findIndex((item, itemIndex) => buildRootKey(row.source_type, item, itemIndex) === normalizeText(row.root_key));
}

function scoreRootRows(rows, query, limit, { minScore = 2 } = {}) {
  const needle = normalizeText(query).toLowerCase();
  const tokens = tokenizeQuery(needle);
  return rows
    .map((row) => {
      const score = scoreRootRow(row, needle, tokens);
      return { score, row };
    })
    .filter((entry) => entry.score >= minScore)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => entry.row);
}

function scoreRootRow(row, needle, tokens) {
  const hay = normalizeText(row.search_text).toLowerCase();
  const labels = [
    row?.root_key,
    row?.title,
    row?.canonical_name,
    row?.tree_path,
  ].map((item) => normalizeText(item).toLowerCase()).filter(Boolean).join(" ");
  let score = tokens.length ? scoreTokens(hay, tokens) : (hay.includes(needle) ? 1 : 0);
  tokens.forEach((token) => {
    if (labels.includes(token)) {
      score += 6;
    }
  });
  if (needle && labels.includes(needle)) {
    score += 12;
  }
  if (needle && labels.split(/\s+/u).includes(needle)) {
    score += 20;
  }
  return score;
}

function tokenizeQuery(text) {
  const source = normalizeText(text).toLowerCase();
  if (!source) {
    return [];
  }
  const tokens = new Set();
  source
    .split(/[\s，。！？、；：""''（）【】…—·]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2)
    .forEach((part) => tokens.add(part));
  const cjk = [...source].filter((char) => char >= "\u4e00" && char <= "\u9fff");
  for (let index = 0; index < cjk.length - 1; index += 1) {
    tokens.add(`${cjk[index]}${cjk[index + 1]}`);
  }
  for (let index = 0; index < cjk.length - 2; index += 1) {
    tokens.add(`${cjk[index]}${cjk[index + 1]}${cjk[index + 2]}`);
  }
  const ascii = source.match(/[a-z0-9]{2,}/g) || [];
  ascii.forEach((part) => tokens.add(part));
  return [...tokens];
}

function scoreTokens(haystack, tokens) {
  return tokens.reduce((count, token) => (haystack.includes(token) ? count + 1 : count), 0);
}

function buildRootKey(sourceType, item, itemIndex) {
  const object = item && typeof item === "object" ? item : {};
  const anchor = normalizeText(object.id)
    || normalizeText(object.fact_key)
    || normalizeText(object.case_id)
    || normalizeText(object.object_name)
    || String(itemIndex + 1);
  return `${normalizeText(sourceType)}:${anchor}`;
}

function buildRootTitle(sourceType, item, itemIndex) {
  const object = item && typeof item === "object" ? item : {};
  if (sourceType === "persona_memo") {
    return normalizeText(object.object_name)
      || normalizeText(object.type)
      || truncateText(normalizeText(object.content), 42)
      || `Persona memo ${itemIndex + 1}`;
  }
  if (sourceType === "hard_fact") {
    return normalizeText(object.fact_key)
      || normalizeText(object.id)
      || `Hard fact ${itemIndex + 1}`;
  }
  return normalizeText(object.case_id)
    || normalizeText(object.event_type)
    || truncateText(normalizeText(object.summary), 42)
    || `Case update ${itemIndex + 1}`;
}

function buildRootSummary(sourceType, item) {
  const object = item && typeof item === "object" ? item : {};
  if (sourceType === "persona_memo") {
    return truncateText(normalizeText(object.content), 140);
  }
  if (sourceType === "hard_fact") {
    return truncateText(normalizeText(object.fact_value), 140);
  }
  const summary = normalizeText(object.summary);
  const nextAction = normalizeText(object.next_action);
  return truncateText([summary, nextAction].filter(Boolean).join(" | "), 140);
}

function buildRootBody(sourceType, item) {
  const object = item && typeof item === "object" ? item : {};
  if (sourceType === "persona_memo") {
    return normalizeText(object.content);
  }
  if (sourceType === "hard_fact") {
    const factKey = normalizeText(object.fact_key);
    const factValue = normalizeText(object.fact_value);
    return [factKey, factValue].filter(Boolean).join(": ");
  }
  const parts = [];
  const summary = normalizeText(object.summary);
  const nextAction = normalizeText(object.next_action);
  const eventType = normalizeText(object.event_type);
  if (summary) {
    parts.push(summary);
  }
  if (nextAction) {
    parts.push(`Next: ${nextAction}`);
  }
  if (eventType) {
    parts.push(`Event: ${eventType}`);
  }
  return parts.join("\n");
}

function buildRootTags(sourceType, item) {
  const object = item && typeof item === "object" ? item : {};
  const base = Array.isArray(object.tags)
    ? object.tags.map((tag) => normalizeText(tag)).filter(Boolean)
    : [];
  if (sourceType === "hard_fact") {
    const factKey = normalizeText(object.fact_key);
    return factKey ? [...base, factKey] : base;
  }
  if (sourceType === "case_update") {
    const eventType = normalizeText(object.event_type);
    return eventType ? [...base, eventType] : base;
  }
  return base;
}

function buildSearchText(rootKey, title, summary, bodyMarkdown, tags, item) {
  const parts = [
    rootKey,
    title,
    summary,
    bodyMarkdown,
    ...(Array.isArray(tags) ? tags : []),
  ];
  if (item && typeof item === "object") {
    Object.values(item).forEach((value) => {
      if (typeof value === "string") {
        parts.push(value);
      }
    });
  }
  return parts.map((part) => normalizeText(part)).filter(Boolean).join(" ");
}

function listItems(value) {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object")
    : [];
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function truncateText(value, limit = 120) {
  const text = normalizeText(value).replace(/\s+/g, " ");
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function clampLimit(value, fallback, min = 1, max = 50) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}

function clampDuplicateScore(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(100, Math.max(50, Math.trunc(numeric)));
}

function normalizePatchMode(value) {
  const mode = normalizeText(value).toLowerCase();
  if (mode === "replace" || mode === "delete") {
    return mode;
  }
  return "merge";
}

function normalizeRootKeys(value) {
  const source = Array.isArray(value) ? value : [value];
  const seen = new Set();
  const output = [];
  source
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .forEach((item) => {
      if (!seen.has(item)) {
        seen.add(item);
        output.push(item);
      }
    });
  return output;
}

function normalizeDuplicateText(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function uniqueTexts(values) {
  const seen = new Set();
  const output = [];
  (Array.isArray(values) ? values : []).forEach((value) => {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    output.push(normalized);
  });
  return output;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  ColdRootStore,
};
