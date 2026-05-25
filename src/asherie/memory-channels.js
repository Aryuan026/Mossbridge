const { buildWarmMemoryRecallPacket } = require("./warm-memory/search");
const { buildWarmRouteSignals } = require("./warm-memory/route-signals");

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
  const hiddenIds = new Set(
    (Array.isArray(excludeMaterialIds) ? excludeMaterialIds : [excludeMaterialIds])
      .map((item) => normalizeText(item))
      .filter(Boolean),
  );
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
      if (hiddenIds.has(materialId) && !isResidentAnchorRow(row)) {
        return false;
      }
      const signals = buildWarmRouteSignals(row, []);
      return Boolean(
        signals.relationshipTagged
        || signals.symbolicTagged
        || signals.objectTagged
        || signals.identityTagged,
      );
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
      const signals = buildWarmRouteSignals(row, []);
      const reasons = [];
      if (isResidentAnchorRow(row)) {
        reasons.push("resident_anchor");
      }
      if (signals.relationshipTagged) {
        reasons.push("relationship_anchor");
      }
      if (signals.symbolicTagged) {
        reasons.push("symbolic_anchor");
      }
      if (signals.objectTagged) {
        reasons.push("object_anchor");
      }
      if (signals.identityTagged && !signals.relationshipTagged) {
        reasons.push("identity_anchor");
      }
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

function buildMemoryRetrievalPacket({
  mode = "",
  warmMemoryPacket = null,
  residentWarmPacket = null,
  episodeJournalPacket = null,
  observationJournalPacket = null,
  solitudeJournalPacket = null,
  curatedHits = [],
  liteFallbackHits = [],
  hippocovePacket = null,
  hippocoveOk = true,
  hippocoveError = "",
  coldRouteTag = "",
} = {}) {
  const warmPacket = warmMemoryPacket && typeof warmMemoryPacket === "object" ? { ...warmMemoryPacket } : {};
  const residentPacket = residentWarmPacket && typeof residentWarmPacket === "object" ? { ...residentWarmPacket } : {};
  const episodePacket = episodeJournalPacket && typeof episodeJournalPacket === "object" ? { ...episodeJournalPacket } : {};
  const observationPacket = observationJournalPacket && typeof observationJournalPacket === "object" ? { ...observationJournalPacket } : {};
  const solitudePacket = solitudeJournalPacket && typeof solitudeJournalPacket === "object" ? { ...solitudeJournalPacket } : {};
  const curated = Array.isArray(curatedHits) ? curatedHits.filter(isObject).map((item) => ({ ...item })) : [];
  const lite = Array.isArray(liteFallbackHits) ? liteFallbackHits.filter(isObject).map((item) => ({ ...item })) : [];
  const coldPacket = hippocovePacket && typeof hippocovePacket === "object" ? { ...hippocovePacket } : {};

  const warmHitCount = Array.isArray(warmPacket.hits) ? warmPacket.hits.length : 0;
  const residentHitCount = Array.isArray(residentPacket.hits) ? residentPacket.hits.length : 0;
  const episodeHitCount = Array.isArray(episodePacket.hits) ? episodePacket.hits.length : 0;
  const observationHitCount = Array.isArray(observationPacket.hits) ? observationPacket.hits.length : 0;
  const solitudeHitCount = Number(solitudePacket.hit_count) || 0;
  const localHitCount = curated.length + lite.length;
  const coldHitCount = Object.keys(coldPacket).length ? 1 : 0;
  const route = [];
  if (warmHitCount) {
    route.push("warm_memory");
  }
  if (residentHitCount) {
    route.push("resident_warm");
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
    episode_journal_packet: episodePacket,
    observation_journal_packet: observationPacket,
    solitude_journal_packet: solitudePacket,
    curated_hits: curated,
    lite_fallback_hits: lite,
    hippocove_packet: coldPacket,
    hippocove_ok: Boolean(hippocoveOk),
    hippocove_error: normalizeText(hippocoveError),
    channel_counts: {
      warm_hit_count: warmHitCount,
      resident_hit_count: residentHitCount,
      episode_hit_count: episodeHitCount,
      observation_hit_count: observationHitCount,
      solitude_hit_count: solitudeHitCount,
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
        episode_hit: episodeHitCount > 0,
        observation_hit: observationHitCount > 0,
        solitude_hit: solitudeHitCount > 0,
        cold_hit: Boolean(coldHitCount),
        carried: (warmHitCount > 0 || residentHitCount > 0) && Boolean(coldHitCount),
      },
    },
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isResidentAnchorRow(row = {}) {
  if (row?.pinned === true) {
    return true;
  }
  return normalizeText(row?.certainty_state).toLowerCase() === "anchor";
}

function residentAnchorPriority(row = {}) {
  return isResidentAnchorRow(row) ? 1 : 0;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  buildMemoryRetrievalPacket,
  buildResidentWarmMemoryPacket,
  buildWarmMemoryRuntimePacket,
};
