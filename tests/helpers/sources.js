'use strict';
// Normalized `sources:` entries for tests, made by the same validation config.yaml goes through.
const os = require('node:os');
const { validateSources } = require('../../server/sources');

const context = { base: process.cwd(), platform: process.platform, dataDirectory: os.tmpdir() };

/** Validates a raw `sources:` list (YAML keys) into the entries `config.sources` holds. */
function sources(list) {
  return validateSources(list, context);
}

/** One Plex source entry; `settings` use the YAML keys (`url`, `token`, `delivery`, `direct_token`...). */
function plexSource(settings = {}) {
  return sources([
    {
      id: 'plex',
      type: 'plex',
      url: 'http://plex-fixture.invalid:32400',
      token: 'fixture-owner',
      ...settings,
    },
  ])[0];
}

module.exports = { sources, plexSource, context };
