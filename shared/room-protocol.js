/* Room and playback command validation. Generic sync commands come from shared/sync;
 * Plex media, track, quality and catalog queue extensions stay here.
 */
(function (root) {
  'use strict';
  const syncProtocol =
    typeof module !== 'undefined' && module.exports ? require('./sync/protocol.mjs') : root.uburoomSyncProtocol;
  const { CONTROLS, controls, controlFor, controlAllowed, numeric, validateSyncCommand } = syncProtocol;
  const QUALITIES = Object.freeze([
    { id: 'direct', label: 'Original' },
    { id: '1080p20', label: '1080p · 20 Mbps', width: 1920, height: 1080, bitrate: 20000 },
    { id: '1080p12', label: '1080p · 12 Mbps', width: 1920, height: 1080, bitrate: 12000 },
    { id: '1080p8', label: '1080p · 8 Mbps', width: 1920, height: 1080, bitrate: 8000 },
    { id: '720p4', label: '720p · 4 Mbps', width: 1280, height: 720, bitrate: 4000 },
    { id: '720p2', label: '720p · 2 Mbps', width: 1280, height: 720, bitrate: 2000 },
  ]);
  const qualityId = id => ({ '720p': '720p4', '1080p': '1080p8' })[id] || id;
  // A selector retains its explicit version. Only provider API adapters use
  // ratingKey; equality of rating keys alone never establishes timeline identity.
  function mediaIdentity(value) {
    if (value === 'demo') return { id: value, demo: true };
    const match = typeof value === 'string' && /^(\d{1,20})(?::(\d{1,20}))?$/.exec(value);
    return match ? { id: value, ratingKey: match[1], mediaId: match[2], demo: false } : undefined;
  }
  function qualityDefinition(id) {
    id = qualityId(id);
    if (id === 'direct') return QUALITIES[0];
    const match = /^(\d{3,4})p(\d{1,3}(?:\.\d{1,3})?)$/.exec(id || '');
    if (!match) return;
    const height = Number(match[1]),
      mbps = Number(match[2]);
    if (
      height < 144 ||
      height > 4320 ||
      height % 2 ||
      mbps < 0.1 ||
      mbps > 200 ||
      Math.abs(mbps * 1000 - Math.round(mbps * 1000)) > 1e-8
    )
      return;
    return {
      id,
      label: height + 'p · ' + mbps + ' Mbps',
      width: Math.round((height * 16) / 9 / 2) * 2,
      height,
      bitrate: Math.round(mbps * 1000),
    };
  }
  const validQuality = id => !!qualityDefinition(id);
  const MANAGEMENT = Object.freeze([
    'room.visibility',
    'media.load',
    'media.quality.set',
    'media.tracks.set',
    'media.stream.refresh',
    'media.ready.start',
    'media.ready.wait',
    'media.ready.cancel',
  ]);
  // Display metadata only. Identity and permissions continue to use Discord/account IDs.
  function senderName(value, fallback = 'Discord user') {
    return syncProtocol.senderName(value, fallback);
  }
  function validate(command) {
    const syncValidated = validateSyncCommand(command);
    if (syncValidated) return syncValidated;
    const action = command.action;
    const a = command.args || {};
    let args = {};
    switch (action) {
      case 'room.publish':
      case 'room.unpublish':
        break;
      case 'room.event.create':
      case 'room.event.edit':
      case 'room.event.cancel':
        if (action !== 'room.event.create') {
          if (typeof a.eventKey !== 'string' || !/^[0-9a-f-]{36}$/i.test(a.eventKey))
            throw new Error('Choose the event');
          args.eventKey = a.eventKey;
          if (action === 'room.event.edit') {
            if (typeof a.eventVersion !== 'string' || !/^[0-9a-f]{64}$/.test(a.eventVersion))
              throw new Error('Refresh the event');
            args.eventVersion = a.eventVersion;
          }
        }
        if (action !== 'room.event.cancel') {
          if (
            typeof a.title !== 'string' ||
            !a.title.trim() ||
            a.title.trim().length > 100 ||
            /[\u0000-\u001f\u007f]/.test(a.title)
          )
            throw new Error('Use an event title of 1–100 characters');
          if (
            typeof a.description !== 'string' ||
            a.description.length > 1000 ||
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(a.description)
          )
            throw new Error('Use an event description of up to 1000 characters');
          for (const field of ['startLocal', 'endLocal'])
            if (typeof a[field] !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(a[field]))
              throw new Error('Choose the event date and times');
          if (typeof a.timeZone !== 'string' || a.timeZone.length > 100) throw new Error('Choose a time zone');
          Object.assign(args, {
            title: a.title.trim(),
            description: a.description,
            startLocal: a.startLocal,
            endLocal: a.endLocal,
            timeZone: a.timeZone,
          });
          if (a.discord !== undefined) {
            if (typeof a.discord !== 'boolean') throw new Error('Choose whether to post to Discord');
            args.discord = a.discord;
          }
        }
        break;
      case 'media.previous':
      case 'media.next':
        break;
      case 'queue.add':
      case 'queue.playNow':
        if (!a.item || typeof a.item !== 'object' || Array.isArray(a.item)) throw new Error('Choose a queue item');
        args.item = a.item;
        break;
      case 'queue.offer.start':
        if (
          typeof a.mediaId !== 'string' ||
          !/^\d{1,20}$/.test(a.mediaId) ||
          typeof a.showId !== 'string' ||
          !/^\d{1,20}$/.test(a.showId)
        )
          throw new Error('Choose an offer item');
        args = { mediaId: a.mediaId, showId: a.showId };
        break;
      case 'queue.bulk':
        if (
          !['show', 'season'].includes(a.type) ||
          typeof a.mediaId !== 'string' ||
          !/^\d{1,20}$/.test(a.mediaId) ||
          typeof a.unfinished !== 'boolean' ||
          typeof a.includeSpecials !== 'boolean'
        )
          throw new Error('Choose show or season queue options');
        args = { type: a.type, mediaId: a.mediaId, unfinished: a.unfinished, includeSpecials: a.includeSpecials };
        break;
      case 'queue.auto':
        if (!['off', 'continue', 'following', 'random'].includes(a.mode) || typeof a.includeSpecials !== 'boolean')
          throw new Error('Choose an auto-queue mode');
        args = { mode: a.mode, includeSpecials: a.includeSpecials };
        if (['following', 'random'].includes(a.mode)) {
          if (
            !a.scope ||
            !['show', 'library', 'collection'].includes(a.scope.type) ||
            (a.mode === 'following' && a.scope.type !== 'show') ||
            (a.scope.id !== undefined && (typeof a.scope.id !== 'string' || !/^\d{1,20}$/.test(a.scope.id)))
          )
            throw new Error('Choose an auto-queue source');
          args.scope = { type: a.scope.type, ...(a.scope.id ? { id: a.scope.id } : {}) };
        } else {
          args.scope = null;
        }
        break;
      case 'queue.auto.skip':
      case 'queue.auto.pin':
        break;
      case 'queue.auto.playNow':
        if (a.skipPrevious !== undefined) {
          if (typeof a.skipPrevious !== 'boolean') throw new Error('Choose whether to skip upcoming items');
          args.skipPrevious = a.skipPrevious;
        }
        break;
      case 'queue.move':
      case 'queue.remove':
      case 'queue.history.replay':
      case 'queue.playEntry':
      case 'queue.skipTo':
      case 'queue.history.goBack':
        if (typeof a.entryId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(a.entryId))
          throw new Error('Choose a queue entry');
        args.entryId = a.entryId;
        if (action === 'queue.remove' && a.advance !== undefined) {
          if (typeof a.advance !== 'boolean') throw new Error('Choose whether to advance after removal');
          args.advance = a.advance;
        }
        if (action === 'queue.move') args.targetRank = numeric(a.targetRank, 0, 999999);
        if (action === 'queue.history.replay') {
          if (typeof a.resume !== 'boolean') throw new Error('Choose resume or start over');
          args.resume = a.resume;
        }
        break;
      case 'queue.clear':
      case 'queue.shuffle':
      case 'queue.history.clear':
        break;
      case 'media.stream.refresh':
        for (const name of ['mediaVersion', 'streamVersion']) {
          if (
            typeof a[name] !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a[name])
          )
            throw new Error('Stream refresh expired.');
          args[name] = a[name];
        }
        break;
      case 'media.tracks.set':
        for (const name of ['mediaVersion', 'streamVersion']) {
          if (
            typeof a[name] !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a[name])
          )
            throw new Error('Track selection expired.');
          args[name] = a[name];
        }
        if (a.audioId !== undefined) {
          if (typeof a.audioId !== 'string' || !/^(?:auto|\d{1,20})$/.test(a.audioId))
            throw new Error('Choose an audio track.');
          args.audioId = a.audioId;
        }
        if (a.subtitleId !== undefined) {
          if (typeof a.subtitleId !== 'string' || !/^(?:auto|off|\d{1,20})$/.test(a.subtitleId))
            throw new Error('Choose subtitles or Off.');
          args.subtitleId = a.subtitleId;
        }
        if (a.subtitleOffset !== undefined) args.subtitleOffset = numeric(a.subtitleOffset, -30, 30);
        if (a.subtitleMode !== undefined) {
          if (!['auto', 'burn'].includes(a.subtitleMode)) throw new Error('Choose automatic subtitles or burn-in.');
          args.subtitleMode = a.subtitleMode;
        }
        if (
          a.audioId === undefined &&
          a.subtitleId === undefined &&
          a.subtitleOffset === undefined &&
          a.subtitleMode === undefined
        )
          throw new Error('Choose a track setting.');
        break;
      case 'media.quality.set':
        if (!validQuality(a.quality)) throw new Error('Choose a playback quality');
        args.quality = a.quality;
        if (a.compatible !== undefined) {
          if (typeof a.compatible !== 'boolean') throw new Error('Invalid compatibility setting');
          args.compatible = a.compatible;
        }
        if (a.fallback !== undefined) {
          if (!['av1', 'vp8', 'vp9', 'plex', 'audio'].includes(a.fallback))
            throw new Error('Invalid playback fallback');
          args.fallback = a.fallback;
        }
        if (a.reset === true) args.reset = true;
        if (typeof a.reason === 'string') args.reason = a.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
        break;
      case 'media.reporting.set':
        if (a.activity !== undefined) {
          if (typeof a.activity !== 'boolean') throw new Error('Choose activity reporting on or off');
          args.activity = a.activity;
        }
        if (a.watchState !== undefined) {
          if (typeof a.watchState !== 'boolean') throw new Error('Choose watch state sync on or off');
          args.watchState = a.watchState;
        }
        if (args.activity === undefined && args.watchState === undefined) throw new Error('Choose a reporting setting');
        break;
      case 'media.load':
        if (!mediaIdentity(a.mediaId)) throw new Error('Choose a library item');
        if (!validQuality(a.quality)) throw new Error('Choose a playback quality');
        args = { mediaId: a.mediaId, quality: a.quality };
        if (a.position !== undefined) {
          if (typeof a.position !== 'number' || !Number.isFinite(a.position) || a.position < 0)
            throw new Error('Invalid playback position');
          args.position = a.position;
        }
        if (a.resume !== undefined) {
          if (typeof a.resume !== 'boolean') throw new Error('Invalid resume setting');
          args.resume = a.resume;
        }
        break;
      default:
        throw new Error('Unsupported command');
    }
    if (action.startsWith('queue.') && a.expectedRevision !== undefined) {
      if (!Number.isSafeInteger(a.expectedRevision) || a.expectedRevision < 0)
        throw new Error('Invalid queue revision');
      args.expectedRevision = a.expectedRevision;
    }
    return { action, args };
  }
  const api = {
    CONTROLS,
    QUALITIES,
    qualityId,
    mediaIdentity,
    qualityDefinition,
    validQuality,
    MANAGEMENT,
    controls,
    controlFor,
    controlAllowed,
    senderName,
    validate,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.uburoomRoomProtocol = api;
})(globalThis);
