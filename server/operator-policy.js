'use strict';

// Call with the canonical account UUID from a current authenticated server
// session, never a provider ID or client-supplied actor. Recheck after awaited
// work before committing a future administration operation.
/** @param {InstanceType<typeof import('./accounts').Accounts>} registry */
function isServerOperator(registry, config, userId) {
  if (typeof userId !== 'string' || !userId) return false;
  const account = registry.canonical(userId);
  if (!account || account.id !== userId) return false;
  // Exact verified identities from operator.identities, of any sign-in method (discord, plex, uburoom).
  const operators = config.serverOperator?.identities || [];
  if (!operators.length) return false;
  return registry
    .identities(account.id)
    .some(
      identity =>
        identity.verified === 1 &&
        operators.some(operator => operator.provider === identity.provider && operator.subject === identity.subject),
    );
}

module.exports = { isServerOperator };
