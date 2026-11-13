'use strict';
// Where development runs write screenshots, generated media and reports: outside the
// repository, in the sibling folder uburoom-evidence/artifacts. UBUROOM_EVIDENCE overrides it.
const path = require('node:path');

const EVIDENCE = path.resolve(
  process.env.UBUROOM_EVIDENCE || path.join(__dirname, '..', '..', '..', 'uburoom-evidence', 'artifacts'),
);

module.exports = { EVIDENCE };
