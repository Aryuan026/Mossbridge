const SINGLE_USER_ID = "owner";
const SINGLE_AGENT_ID = "moss";
const SINGLE_REALM_ID = "default";

function resolveSingleIdentity(source = {}) {
  return {
    userId: normalizeText(source.userId || source.identityUserId) || SINGLE_USER_ID,
    realmId: normalizeText(source.realmId || source.identityRealmId) || SINGLE_REALM_ID,
    agentId: normalizeText(source.agentId || source.identityAgentId) || SINGLE_AGENT_ID,
  };
}

function singleUserId(source = {}) {
  return resolveSingleIdentity(source).userId;
}

function singleAgentId(source = {}) {
  return resolveSingleIdentity(source).agentId;
}

function singleRealmId(source = {}) {
  return resolveSingleIdentity(source).realmId;
}

function canonicalUserId(_value = "", source = {}) {
  return resolveSingleIdentity(source).userId;
}

function canonicalAgentId(_value = "", source = {}) {
  return resolveSingleIdentity(source).agentId;
}

function canonicalRealmId(_value = "", source = {}) {
  return resolveSingleIdentity(source).realmId;
}

function canonicalScopedUserId(_value = "", source = {}) {
  return resolveSingleIdentity(source).userId;
}

function buildIdentityMeta(source = {}) {
  const identity = resolveSingleIdentity(source);
  return {
    user_id: identity.userId,
    realm_id: identity.realmId,
    agent_id: identity.agentId,
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  SINGLE_USER_ID,
  SINGLE_AGENT_ID,
  SINGLE_REALM_ID,
  resolveSingleIdentity,
  singleUserId,
  singleAgentId,
  singleRealmId,
  canonicalUserId,
  canonicalAgentId,
  canonicalRealmId,
  canonicalScopedUserId,
  buildIdentityMeta,
};
