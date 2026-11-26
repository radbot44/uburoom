'use strict';
const { randomUUID } = require('node:crypto');

// Public service marker for setup probes. The boot ID is opaque and stays fixed for this
// process so an operator can recognize a new instance even when its version hasn't changed.
const service = 'uburoom';
const bootId = randomUUID();

module.exports = { service, bootId };
