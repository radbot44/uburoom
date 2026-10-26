'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runningSettings } = require('../server/operator-settings');

test('runningSettings extracts and maps complete configuration correctly', () => {
  const mockConfig = {
    accessPolicy: {
      discord: true,
      plex: false,
      requirePlex: true,
      requirePlexInActivity: true,
      publicWeb: false,
      extraSecret: 'hidden'
    },
    singleRoom: true,
    roomLimits: {
      maxSaved: 10,
      maxOpen: 5,
      minRetained: 2,
      inactiveDays: 30,
      maxMembers: 50,
      maxPeople: 100,
      recoverySeconds: 15,
      maxQueue: 200,
      maxHistory: 50,
      internalSecretLimit: 999
    },
    roomPermissions: {
      host: {
        playPause: true,
        seek: true,
        chooseMedia: true,
        addQueue: true,
        editQueue: true,
        autoplay: true,
        roomSettings: true,
        closeRoom: true,
        deleteRoom: true,
        continueWithoutHost: true,
        addHosts: true,
        kickParticipants: true,
        unlistedPermission: true
      },
      viewer: {
        playPause: false,
        seek: false,
        chooseMedia: false,
        addQueue: true,
        editQueue: false,
        autoplay: false,
        roomSettings: false,
        closeRoom: false,
        deleteRoom: false,
        continueWithoutHost: false,
        addHosts: false,
        kickParticipants: false
      }
    },
    directory: {
      discord: true,
      plex: true,
      secretDirKey: 'private'
    },
    transcoding: {
      policy: 'auto',
      plex: true,
      uburoom: true,
      encoder: 'hardware',
      cpuFallback: false,
      maxJobs: 4,
      internalTranscodeSecret: 'secret',
      formats: ['h264', 'hevc'],
      qualities: [
        { id: 'direct', height: 1080, bitrate: 10000 },
        { id: '1080p', height: 1080, bitrate: 8000 },
        { id: '720p', height: 720, bitrate: 4000 }
      ]
    },
    plexToken: 'secret-token-123',
    botToken: 'bot-secret-456'
  };

  const result = runningSettings(mockConfig);

  assert.equal(result.source, 'running');
  assert.deepEqual(result.settings.access, {
    discord: true,
    plex: false,
    requirePlex: true,
    requirePlexInActivity: true,
    publicWeb: false
  });
  assert.equal(result.settings.rooms.singleRoom, true);
  assert.deepEqual(result.settings.rooms.limits, {
    maxSaved: 10,
    maxOpen: 5,
    minRetained: 2,
    inactiveDays: 30,
    maxMembers: 50,
    maxPeople: 100,
    recoverySeconds: 15,
    maxQueue: 200,
    maxHistory: 50
  });
  assert.deepEqual(result.settings.rooms.hostPermissions, {
    playPause: true,
    seek: true,
    chooseMedia: true,
    addQueue: true,
    editQueue: true,
    autoplay: true,
    roomSettings: true,
    closeRoom: true,
    deleteRoom: true,
    continueWithoutHost: true,
    addHosts: true,
    kickParticipants: true
  });
  assert.deepEqual(result.settings.rooms.viewerPermissions, {
    playPause: false,
    seek: false,
    chooseMedia: false,
    addQueue: true,
    editQueue: false,
    autoplay: false,
    roomSettings: false,
    closeRoom: false,
    deleteRoom: false,
    continueWithoutHost: false,
    addHosts: false,
    kickParticipants: false
  });
  assert.deepEqual(result.settings.directory, {
    discord: true,
    plex: true
  });
  assert.equal(result.settings.transcoding.policy, 'auto');
  assert.equal(result.settings.transcoding.plex, true);
  assert.equal(result.settings.transcoding.uburoom, true);
  assert.equal(result.settings.transcoding.encoder, 'hardware');
  assert.equal(result.settings.transcoding.cpuFallback, false);
  assert.equal(result.settings.transcoding.maxJobs, 4);
  assert.deepEqual(result.settings.transcoding.formats, ['h264', 'hevc']);
  assert.equal(result.settings.transcoding.allowOriginal, true);
  assert.deepEqual(result.settings.transcoding.qualities, [
    { height: 1080, mbps: 8 },
    { height: 720, mbps: 4 }
  ]);
});

test('runningSettings handles transcoding qualities and formats accurately', () => {
  const formats = ['webm', 'mp4'];
  const configWithoutDirect = {
    transcoding: {
      formats,
      qualities: [
        { id: '1080p', height: 1080, bitrate: 6000 },
        { id: '480p', height: 480, bitrate: 1500 }
      ]
    }
  };

  const result = runningSettings(configWithoutDirect);

  assert.equal(result.settings.transcoding.allowOriginal, false);
  assert.deepEqual(result.settings.transcoding.qualities, [
    { height: 1080, mbps: 6 },
    { height: 480, mbps: 1.5 }
  ]);

  // Ensure formats array is cloned and not mutated when source array is modified
  assert.deepEqual(result.settings.transcoding.formats, ['webm', 'mp4']);
  assert.notEqual(result.settings.transcoding.formats, formats);
  result.settings.transcoding.formats.push('mkv');
  assert.deepEqual(formats, ['webm', 'mp4']);
});

test('runningSettings safely handles empty or partial configuration objects', () => {
  const emptyResult = runningSettings({});

  assert.equal(emptyResult.source, 'running');
  assert.deepEqual(emptyResult.settings.access, {
    discord: undefined,
    plex: undefined,
    requirePlex: undefined,
    requirePlexInActivity: undefined,
    publicWeb: undefined
  });
  assert.equal(emptyResult.settings.rooms.singleRoom, false);
  assert.deepEqual(emptyResult.settings.rooms.limits, {
    maxSaved: undefined,
    maxOpen: undefined,
    minRetained: undefined,
    inactiveDays: undefined,
    maxMembers: undefined,
    maxPeople: undefined,
    recoverySeconds: undefined,
    maxQueue: undefined,
    maxHistory: undefined
  });
  assert.deepEqual(emptyResult.settings.rooms.hostPermissions, {
    playPause: undefined,
    seek: undefined,
    chooseMedia: undefined,
    addQueue: undefined,
    editQueue: undefined,
    autoplay: undefined,
    roomSettings: undefined,
    closeRoom: undefined,
    deleteRoom: undefined,
    continueWithoutHost: undefined,
    addHosts: undefined,
    kickParticipants: undefined
  });
  assert.deepEqual(emptyResult.settings.rooms.viewerPermissions, {
    playPause: undefined,
    seek: undefined,
    chooseMedia: undefined,
    addQueue: undefined,
    editQueue: undefined,
    autoplay: undefined,
    roomSettings: undefined,
    closeRoom: undefined,
    deleteRoom: undefined,
    continueWithoutHost: undefined,
    addHosts: undefined,
    kickParticipants: undefined
  });
  assert.deepEqual(emptyResult.settings.directory, {
    discord: undefined,
    plex: undefined
  });
  assert.deepEqual(emptyResult.settings.transcoding, {
    policy: undefined,
    plex: undefined,
    uburoom: undefined,
    encoder: undefined,
    cpuFallback: undefined,
    maxJobs: undefined,
    formats: [],
    allowOriginal: false,
    qualities: []
  });
});

test('runningSettings strictly enforces allowlist and excludes sensitive/unlisted fields', () => {
  const sensitiveConfig = {
    accessPolicy: { discord: true, secretAccessKey: 'DO_NOT_LEAK' },
    singleRoom: 'truthy_value',
    roomLimits: { maxSaved: 5, secretLimitKey: 'DO_NOT_LEAK' },
    roomPermissions: {
      host: { playPause: true, secretHostPerm: 'DO_NOT_LEAK' },
      viewer: { playPause: false, secretViewerPerm: 'DO_NOT_LEAK' }
    },
    directory: { discord: false, secretDirectoryKey: 'DO_NOT_LEAK' },
    transcoding: {
      encoder: 'auto',
      secretTranscodeKey: 'DO_NOT_LEAK'
    },
    plexToken: 'SUPER_SECRET_PLEX_TOKEN',
    botToken: 'SUPER_SECRET_BOT_TOKEN',
    credentialKeyFile: '/path/to/key',
    dbPassword: 'secretpassword'
  };

  const result = runningSettings(sensitiveConfig);
  const jsonString = JSON.stringify(result);

  assert.equal(jsonString.includes('DO_NOT_LEAK'), false);
  assert.equal(jsonString.includes('SUPER_SECRET_PLEX_TOKEN'), false);
  assert.equal(jsonString.includes('SUPER_SECRET_BOT_TOKEN'), false);
  assert.equal(jsonString.includes('/path/to/key'), false);
  assert.equal(jsonString.includes('secretpassword'), false);

  assert.equal('secretAccessKey' in result.settings.access, false);
  assert.equal('secretLimitKey' in result.settings.rooms.limits, false);
  assert.equal('secretHostPerm' in result.settings.rooms.hostPermissions, false);
  assert.equal('secretViewerPerm' in result.settings.rooms.viewerPermissions, false);
  assert.equal('secretDirectoryKey' in result.settings.directory, false);
  assert.equal('secretTranscodeKey' in result.settings.transcoding, false);
  assert.equal('plexToken' in result.settings, false);
});
