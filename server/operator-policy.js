'use strict';

// Call with the canonical account UUID from a current authenticated server
// session, never a provider ID or client-supplied actor. Recheck after awaited
// work before committing a future administration operation.
/** @param {import('./accounts').Accounts | undefined} registry */
function isServerOperator(registry, config, userId) {
  if (!registry || typeof userId !== 'string' || !userId) return false;
  const account = registry.canonical(userId);
  if (!account || account.id !== userId) return false;
  const operator = config.serverOperator;
  if (!operator) return false;
  return registry.identities(account.id).some(identity => identity.verified === 1 &&
    (identity.provider === 'discord' && !!operator.discordId && identity.subject === operator.discordId ||
      identity.provider === 'plex' && !!operator.plexId && identity.subject === operator.plexId));
}

module.exports = { isServerOperator };
