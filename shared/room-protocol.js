/* Room and playback command validation. Generic sync commands come from shared/sync;
 * Plex media, track, quality and catalog queue extensions stay here.
 */
(function (root) {
  'use strict';
  const syncProtocol = typeof module !== 'undefined' && module.exports
    ? require('./sync/protocol.mjs')
    : root.uburoomSyncProtocol;
  const { CONTROLS, controls, controlFor, controlAllowed, numeric, validateSyncCommand } = syncProtocol;
  const QUALITIES = Object.freeze([
    { id:'direct', label:'Original' },
    { id:'1080p20', label:'1080p · 20 Mbps', width:1920, height:1080, bitrate:20000 },
    { id:'1080p12', label:'1080p · 12 Mbps', width:1920, height:1080, bitrate:12000 },
    { id:'1080p8', label:'1080p · 8 Mbps', width:1920, height:1080, bitrate:8000 },
    { id:'720p4', label:'720p · 4 Mbps', width:1280, height:720, bitrate:4000 },
    { id:'720p2', label:'720p · 2 Mbps', width:1280, height:720, bitrate:2000 }
  ]);
  const qualityId = id => ({'720p':'720p4','1080p':'1080p8'}[id] || id);
  function qualityDefinition(id) {
    id = qualityId(id);
    if (id === 'direct') return QUALITIES[0];
    const match = /^(\d{3,4})p(\d{1,3}(?:\.\d{1,3})?)$/.exec(id || '');
    if (!match) return;
    const height = Number(match[1]), mbps = Number(match[2]);
    if (height < 144 || height > 4320 || height % 2 || mbps < .1 || mbps > 200 || Math.abs(mbps * 1000 - Math.round(mbps * 1000)) > 1e-8) return;
    return {id,label:height+'p · '+mbps+' Mbps',width:Math.round(height*16/9/2)*2,height,bitrate:Math.round(mbps*1000)};
  }
  const validQuality = id => !!qualityDefinition(id);
  const MANAGEMENT = Object.freeze(['room.visibility', 'media.load', 'media.quality.set','media.tracks.set','media.stream.refresh','media.ready.start','media.ready.wait','media.ready.cancel']);
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
      case 'media.previous': case 'media.next': break;
      case 'queue.add': case 'queue.playNow':
        if (!a.item || typeof a.item !== 'object' || Array.isArray(a.item)) throw new Error('Choose a queue item');
        args.item = a.item; break;
      case 'queue.offer.start':
        if (typeof a.mediaId !== 'string' || !/^\d{1,20}$/.test(a.mediaId) ||
            typeof a.showId !== 'string' || !/^\d{1,20}$/.test(a.showId)) throw new Error('Choose an offer item');
        args = { mediaId: a.mediaId, showId: a.showId }; break;
      case 'queue.bulk':
        if (!['show','season'].includes(a.type) || typeof a.mediaId !== 'string' || !/^\d{1,20}$/.test(a.mediaId) ||
            typeof a.unfinished !== 'boolean' || typeof a.includeSpecials !== 'boolean') throw new Error('Choose show or season queue options');
        args = { type:a.type, mediaId:a.mediaId, unfinished:a.unfinished, includeSpecials:a.includeSpecials }; break;
      case 'queue.auto':
        if (!['off','continue','following','random'].includes(a.mode) || typeof a.includeSpecials !== 'boolean') throw new Error('Choose an auto-queue mode');
        args = { mode:a.mode, includeSpecials:a.includeSpecials };
        if (['following','random'].includes(a.mode)) {
          if (!a.scope || !['show','library','collection'].includes(a.scope.type) ||
              a.mode === 'following' && a.scope.type !== 'show' ||
              a.scope.id !== undefined && (typeof a.scope.id !== 'string' || !/^\d{1,20}$/.test(a.scope.id))) throw new Error('Choose an auto-queue source');
          args.scope = { type:a.scope.type, ...(a.scope.id ? { id:a.scope.id } : {}) };
        } else {
          args.scope = null;
        }
        break;
      case 'queue.auto.skip': case 'queue.auto.pin': break;
      case 'queue.auto.playNow':
        if (a.skipPrevious !== undefined) {
          if (typeof a.skipPrevious !== 'boolean') throw new Error('Choose whether to skip upcoming items');
          args.skipPrevious = a.skipPrevious;
        }
        break;
      case 'queue.move': case 'queue.remove': case 'queue.history.replay':
      case 'queue.playEntry': case 'queue.skipTo': case 'queue.history.goBack':
        if (typeof a.entryId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(a.entryId)) throw new Error('Choose a queue entry');
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
      case 'queue.clear': case 'queue.shuffle': case 'queue.history.clear': break;
      case 'media.stream.refresh':
        for (const name of ['mediaVersion','streamVersion']) {
          if (typeof a[name]!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a[name])) throw new Error('Stream refresh expired.');
          args[name]=a[name];
        }
        break;
      case 'media.tracks.set':
        for (const name of ['mediaVersion','streamVersion']) {
          if (typeof a[name]!=='string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a[name])) throw new Error('Track selection expired.');
          args[name]=a[name];
        }
        if (a.audioId!==undefined) {
          if (typeof a.audioId!=='string' || !/^(?:auto|\d{1,20})$/.test(a.audioId)) throw new Error('Choose an audio track.');
          args.audioId=a.audioId;
        }
        if (a.subtitleId!==undefined) {
          if (typeof a.subtitleId!=='string' || !/^(?:auto|off|\d{1,20})$/.test(a.subtitleId)) throw new Error('Choose subtitles or Off.');
          args.subtitleId=a.subtitleId;
        }
        if (a.subtitleOffset!==undefined) args.subtitleOffset=numeric(a.subtitleOffset,-30,30);
        if(a.subtitleMode!==undefined){if(!['auto','burn'].includes(a.subtitleMode))throw new Error('Choose automatic subtitles or Plex burn-in.');args.subtitleMode=a.subtitleMode;}
        if (a.audioId===undefined && a.subtitleId===undefined && a.subtitleOffset===undefined && a.subtitleMode===undefined) throw new Error('Choose a track setting.');
        break;
      case 'media.quality.set':
        if (!validQuality(a.quality)) throw new Error('Choose a playback quality');
        args.quality = a.quality;
        if (a.compatible !== undefined) {
          if (typeof a.compatible !== 'boolean') throw new Error('Invalid compatibility setting');
          args.compatible = a.compatible;
        }
        if (a.fallback !== undefined) {
          if (!['av1','vp8','vp9'].includes(a.fallback)) throw new Error('Invalid playback fallback');
          args.fallback = a.fallback;
        }
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
        if (typeof a.mediaId !== 'string' || !/^(?:demo|[0-9]{1,20})$/.test(a.mediaId)) throw new Error('Choose a library item');
        if (!validQuality(a.quality)) throw new Error('Choose a playback quality');
        args = { mediaId: a.mediaId, quality: a.quality }; break;
      default: throw new Error('Unsupported command');
    }
    if (action.startsWith('queue.') && a.expectedRevision !== undefined) {
      if (!Number.isSafeInteger(a.expectedRevision) || a.expectedRevision < 0) throw new Error('Invalid queue revision');
      args.expectedRevision = a.expectedRevision;
    }
    return { action, args };
  }
  const api = { CONTROLS, QUALITIES, qualityId, qualityDefinition, validQuality, MANAGEMENT, controls, controlFor, controlAllowed, senderName, validate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.uburoomRoomProtocol = api;
})(globalThis);
