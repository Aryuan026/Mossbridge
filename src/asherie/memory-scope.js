const {
  canonicalAgentId,
  canonicalRealmId,
  canonicalUserId,
  resolveSingleIdentity,
} = require("./single-identity");

function buildColdScope({
  userId = "",
  defaultRealmId = "",
  ownerId = "",
  realmId = "",
  agentId = "mossbridge",
  identity = null,
} = {}) {
  const resolvedIdentity = resolveSingleIdentity(identity || {});
  void userId;
  void defaultRealmId;
  void ownerId;
  void realmId;
  void agentId;
  const resolvedOwnerId = canonicalUserId("", resolvedIdentity);
  const resolvedRealmId = canonicalRealmId("", resolvedIdentity);
  const resolvedAgentId = canonicalAgentId("", resolvedIdentity);
  return {
    owner_id: resolvedOwnerId,
    realm_id: resolvedRealmId,
    bot_id: resolvedAgentId,
    agent_id: resolvedAgentId,
  };
}

module.exports = {
  buildColdScope,
};
