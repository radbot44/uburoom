'use strict';
const { CAPABILITIES } = require('../shared/sync/policy.mjs');

// Deliberate allowlist of nonprivate running settings. Never spread config or
// its nested objects here: future configuration fields are private by default.
function runningSettings(config) {
  const select = (source, keys) => Object.fromEntries(keys.map(key => [key, source?.[key]]));
  const permissions = source => select(source, CAPABILITIES);
  const transcoding = config.transcoding;
  const ubuplayer = config.ubuplayer !== undefined ? !!config.ubuplayer : transcoding?.ubuplayer !== false;
  return {
    source: 'running',
    settings: {
      access: select(config.accessPolicy, ['discordServer', 'sourceMembers', 'password', 'accounts', 'publicWeb']),
      rooms: {
        singleRoom: !!config.singleRoom,
        limits: select(config.roomLimits, [
          'maxSaved',
          'maxOpen',
          'minRetained',
          'inactiveDays',
          'maxMembers',
          'maxPeople',
          'recoverySeconds',
          'maxQueue',
          'maxHistory',
        ]),
        hostPermissions: permissions(config.roomPermissions?.host),
        viewerPermissions: permissions(config.roomPermissions?.viewer),
      },
      directory: select(config.directory, ['discord']),
      transcoding: {
        ...select(transcoding, ['policy', 'provider', 'uburoom', 'encoder', 'cpuFallback', 'maxJobs']),
        ubuplayer,
        formats: transcoding?.formats?.slice() || [],
        allowOriginal: !!transcoding?.qualities?.some(quality => quality.id === 'direct'),
        qualities: (transcoding?.qualities || [])
          .filter(quality => quality.id !== 'direct')
          .map(quality => ({ height: quality.height, mbps: quality.bitrate / 1000 })),
      },
    },
  };
}

module.exports = { runningSettings };
