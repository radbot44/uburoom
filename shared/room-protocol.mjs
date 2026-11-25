/* Room and playback command validation. Generic sync commands come from shared/sync;
 * Media, track, quality and catalog queue extensions stay here.
 */
/** @typedef {{id: string, demo: boolean, itemId?: string, versionId?: string}} MediaIdentity */
import { numeric, senderName as syncSenderName, validateSyncCommand } from './sync/protocol.mjs';

const QUALITIES = Object.freeze([
  { id: 'direct', label: 'Original' },
  { id: '1080p20', label: '1080p · 20 Mbps', width: 1920, height: 1080, bitrate: 20000 },
  { id: '1080p12', label: '1080p · 12 Mbps', width: 1920, height: 1080, bitrate: 12000 },
  { id: '1080p8', label: '1080p · 8 Mbps', width: 1920, height: 1080, bitrate: 8000 },
  { id: '720p4', label: '720p · 4 Mbps', width: 1280, height: 720, bitrate: 4000 },
  { id: '720p2', label: '720p · 2 Mbps', width: 1280, height: 720, bitrate: 2000 },
]);
const qualityId = id => ({ '720p': '720p4', '1080p': '1080p8' })[id] || id;
// A media selector: "<item>" or "<item>:<version>", and a selector retains its explicit
// version. The parts are opaque here; each provider checks its own form before using
// them, and equality of items alone never establishes timeline identity.
const ITEM = /^[A-Za-z0-9_-]{1,64}$/;
function mediaIdentity(value) {
  if (value === 'demo') return { id: value, demo: true };
  const match = typeof value === 'string' && /^([A-Za-z0-9_-]{1,64})(?::([A-Za-z0-9_-]{1,64}))?$/.exec(value);
  return match ? { id: value, itemId: match[1], versionId: match[2], demo: false } : undefined;
}
// The server a media selector belongs to, when a request names one. Opaque here; the
// server accepts only the id of a provider it is configured with.
function withServer(args, a) {
  if (a.serverId === undefined) return args;
  if (typeof a.serverId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(a.serverId))
    throw new Error('Choose a library item');
  return { ...args, serverId: a.serverId };
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
// Display metadata only. Identity and permissions continue to use Discord/account IDs.
function senderName(value, fallback = 'Discord user') {
  return syncSenderName(value, fallback);
}
const VERSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A track choice: 'auto', 'off', or a track id, which only the media's provider interprets.
const TRACK = /^[A-Za-z0-9_-]{1,64}$/;
const ENTRY = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const none = () => ({});
function versions(a, message) {
  const args = {};
  for (const name of ['mediaVersion', 'streamVersion']) {
    if (typeof a[name] !== 'string' || !VERSION.test(a[name])) throw new Error(message);
    args[name] = a[name];
  }
  return args;
}
function entry(a, action) {
  if (typeof a.entryId !== 'string' || !ENTRY.test(a.entryId)) throw new Error('Choose a queue entry');
  const args = { entryId: a.entryId };
  if (action === 'queue.remove' && a.advance !== undefined) {
    if (typeof a.advance !== 'boolean') throw new Error('Choose whether to advance after removal');
    args.advance = a.advance;
  }
  if (action === 'queue.remove' && a.role !== undefined) {
    if (!['upcoming', 'history', 'current'].includes(a.role)) throw new Error('Choose a valid queue entry role');
    args.role = a.role;
  }
  if (action === 'queue.move') args.targetRank = numeric(a.targetRank, 0, 999999);
  if (action === 'queue.history.replay') {
    if (typeof a.resume !== 'boolean') throw new Error('Choose resume or start over');
    args.resume = a.resume;
  }
  return args;
}
function queueItem(a) {
  if (!a.item || typeof a.item !== 'object' || Array.isArray(a.item)) throw new Error('Choose a queue item');
  return { item: a.item };
}
function suggestItem(a) {
  const { item } = queueItem(a);
  const id = item.mediaId || item.id;
  if (typeof id !== 'string' || !mediaIdentity(id)) throw new Error('Choose a library item');
  return { item };
}
function suggestion(a) {
  if (typeof a.suggestionId !== 'string' || !ENTRY.test(a.suggestionId)) throw new Error('Choose a suggestion');
  return { suggestionId: a.suggestionId };
}
function suggestionAgreement(a) {
  if (typeof a.agree !== 'boolean') throw new Error('Choose to agree or not');
  return { ...suggestion(a), agree: a.agree };
}
function event(a, action) {
  const args = {};
  if (action !== 'room.event.create') {
    if (typeof a.eventKey !== 'string' || !/^[0-9a-f-]{36}$/i.test(a.eventKey)) throw new Error('Choose the event');
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
    Object.assign(args, {
      title: a.title.trim(),
      description: a.description,
    });
    const newStart = action === 'room.event.create' || a.startLocal !== undefined || a.timeZone !== undefined;
    if (newStart) {
      if (typeof a.startLocal !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(a.startLocal))
        throw new Error('Choose the event date and time');
      if (typeof a.timeZone !== 'string' || a.timeZone.length > 100) throw new Error('Choose a time zone');
      args.startLocal = a.startLocal;
      args.timeZone = a.timeZone;
    }
    if (a.durationMinutes !== undefined) {
      if (!Number.isSafeInteger(a.durationMinutes) || a.durationMinutes <= 0 || a.endLocal !== undefined)
        throw new Error('Choose the event duration');
      args.durationMinutes = a.durationMinutes;
    } else if (newStart || a.endLocal !== undefined) {
      if (!newStart || typeof a.endLocal !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(a.endLocal))
        throw new Error('Choose the event end time');
      args.endLocal = a.endLocal;
    }
    if (a.discord !== undefined) {
      if (typeof a.discord !== 'boolean') throw new Error('Choose whether to post to Discord');
      args.discord = a.discord;
    }
  }
  return args;
}
/**
 * The command table: every room command, declared once. Generic sync commands
 * take their argument validator from shared/sync; every other entry has `args`.
 * Adding a command means adding its entry here and its handler.
 * - `args(a, action)`: validates arguments, throwing a viewer-facing message.
 * - `scope`: 'room' changes the room for everyone; 'personal' changes only the
 *   sending viewer's player and needs that viewer's watch tab.
 * - `capability`: the room capability it requires; `null` when none grants it.
 * - `host`: requires a room host or Admin mode instead of a capability; never a guest.
 * - `idle`: another capability that suffices while the room has no media or queue.
 * - `also`: a second capability it requires as well.
 * - `hostless`: with no host or administrator present, also requires continueWithoutHost.
 * - `prepares`: may wait on media preparation, so its deadline is extended:
 *   always (true), only when personal ('personal') or only while the room is idle ('idle').
 * - `preparesSaved`: its deadline is extended when queued on a room that is not open.
 * - `loadsFirstItem`: can start playback when adding the first item to an empty room.
 * - `service`: runs through the Discord publication or scheduled-event service.
 * - `handler`: the personal player handler that applies it.
 * - `persists`: moves the shared timeline, so it cancels autoplay and saves the room.
 * - `roomLocal`: wakes only the room's subscribers, never the lobby.
 * - `refillsAutoQueue`: changes the queue, so an active auto-queue is regenerated afterwards.
 * - `liveOnly`: requires an open live room (never runs against a closed saved room).
 * @typedef {{args?: (a: any, action: string) => Record<string, any>, scope: 'room'|'personal',
 *   capability: string|null, host?: boolean, idle?: string, also?: string, hostless?: boolean,
 *   prepares?: true|'personal'|'idle', preparesSaved?: boolean, loadsFirstItem?: boolean,
 *   service?: 'publish'|'unpublish'|'event',
 *   handler?: 'quality'|'tracks'|'stream'|'delivery'|'player'|'reporting', persists?: boolean, roomLocal?: boolean,
 *   refillsAutoQueue?: boolean, liveOnly?: boolean}} Command
 */
/** @type {Readonly<Record<string, Command>>} */
const COMMANDS = Object.freeze({
  'room.kick': { scope: 'room', capability: 'kickParticipants' },
  'room.visibility': { scope: 'room', capability: 'roomSettings' },
  'room.publish': { scope: 'room', capability: null, host: true, prepares: true, service: 'publish', args: none },
  'room.unpublish': { scope: 'room', capability: null, host: true, service: 'unpublish', args: none },
  'room.event.create': { scope: 'room', capability: 'roomSettings', service: 'event', args: event },
  'room.event.edit': { scope: 'room', capability: 'roomSettings', service: 'event', args: event },
  'room.event.cancel': { scope: 'room', capability: 'roomSettings', service: 'event', args: event },
  'media.play': {
    scope: 'room',
    capability: 'playPause',
    hostless: true,
    prepares: 'idle',
    persists: true,
    roomLocal: true,
  },
  'media.pause': { scope: 'room', capability: 'playPause', persists: true, roomLocal: true },
  'media.toggle': {
    scope: 'room',
    capability: 'playPause',
    hostless: true,
    prepares: 'idle',
    persists: true,
    roomLocal: true,
  },
  'media.seek.start': { scope: 'room', capability: 'seek', persists: true, roomLocal: true },
  'media.seek.end': { scope: 'room', capability: 'seek', persists: true, roomLocal: true },
  'media.seek.relative': { scope: 'room', capability: 'seek', persists: true, roomLocal: true },
  'media.seek.absolute': { scope: 'room', capability: 'seek', persists: true, roomLocal: true },
  'media.ready.start': { scope: 'room', capability: 'chooseMedia', hostless: true, roomLocal: true },
  'media.ready.wait': { scope: 'room', capability: 'chooseMedia', roomLocal: true },
  'media.ready.cancel': { scope: 'room', capability: 'chooseMedia', roomLocal: true },
  'check.ask': { scope: 'room', capability: 'playPause', roomLocal: true, liveOnly: true },
  'check.clear': { scope: 'room', capability: 'playPause', roomLocal: true, liveOnly: true },
  'check.reply': { scope: 'room', capability: null, roomLocal: true, liveOnly: true },
  'break.start': {
    scope: 'room',
    capability: 'playPause',
    roomLocal: true,
    liveOnly: true,
    args(a) {
      const minutes = Number(a.minutes);
      if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes < 1 || minutes > 120) {
        throw new Error('Choose a break length between 1 and 120 minutes');
      }
      const out = { minutes };
      if (a.autoResume !== undefined) {
        if (typeof a.autoResume !== 'boolean') throw new Error('Invalid auto-resume option');
        out.autoResume = a.autoResume;
      }
      return out;
    },
  },
  'break.extend': {
    scope: 'room',
    capability: 'playPause',
    roomLocal: true,
    liveOnly: true,
    args(a) {
      const minutes = a.minutes === undefined ? 5 : Number(a.minutes);
      if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
        throw new Error('Choose an extension between 1 and 60 minutes');
      }
      return { minutes, ...validateSyncCommand({ action: 'check.clear', args: a }).args };
    },
  },
  'break.end': {
    scope: 'room',
    capability: 'playPause',
    roomLocal: true,
    liveOnly: true,
    args: a => validateSyncCommand({ action: 'check.clear', args: a }).args,
  },
  'announce.send': {
    scope: 'room',
    capability: 'announce',
    roomLocal: true,
    liveOnly: true,
    args(a) {
      if (typeof a.text !== 'string') throw new Error('Enter an announcement');
      const text = a.text.replace(/\s+/g, ' ').trim();
      if (!text) throw new Error('Enter an announcement');
      if (text.length > 140) throw new Error('Announcement must be 140 characters or fewer');
      const out = { text };
      if (a.pinned !== undefined) {
        if (typeof a.pinned !== 'boolean') throw new Error('Invalid pin option');
        out.pinned = a.pinned;
      }
      return out;
    },
  },
  'announce.clear': { scope: 'room', capability: 'announce', roomLocal: true, liveOnly: true, args: none },
  'poll.start': {
    scope: 'room',
    capability: 'runPolls',
    roomLocal: true,
    liveOnly: true,
    args(a) {
      if (typeof a.question !== 'string') throw new Error('Enter a poll question');
      const question = a.question.replace(/\s+/g, ' ').trim();
      if (!question || question.length > 140) throw new Error('Poll question must be 1–140 characters');
      if (!Array.isArray(a.options) || a.options.length < 2 || a.options.length > 6) {
        throw new Error('Provide between 2 and 6 poll options');
      }
      const optionIds = new Set();
      const options = a.options.map((opt, idx) => {
        if (!opt || typeof opt !== 'object') throw new Error('Invalid poll option');
        const label = typeof opt.label === 'string' ? opt.label.replace(/\s+/g, ' ').trim() : '';
        if (!label || label.length > 100) throw new Error('Each option must be 1–100 characters');
        const id = typeof opt.id === 'string' && opt.id.trim() ? opt.id.trim().slice(0, 40) : `opt-${idx + 1}`;
        if (optionIds.has(id)) throw new Error('Poll option IDs must be unique');
        optionIds.add(id);
        let media;
        if (opt.media && typeof opt.media === 'object') {
          const mediaId = mediaIdentity(opt.media.mediaId || opt.media.id)?.id;
          const serverId = typeof opt.media.serverId === 'string' ? opt.media.serverId.trim() : '';
          if (!mediaId || !serverId) throw new Error('Invalid media option');
          media = {
            serverId,
            mediaId,
            type: opt.media.type === 'episode' ? 'episode' : 'movie',
            title:
              typeof opt.media.title === 'string' && opt.media.title.trim()
                ? opt.media.title.trim().slice(0, 200)
                : label,
            ...(typeof opt.media.subtitle === 'string' && opt.media.subtitle.trim()
              ? { subtitle: opt.media.subtitle.trim().slice(0, 200) }
              : {}),
            ...(Number.isSafeInteger(opt.media.year) ? { year: opt.media.year } : {}),
            ...(typeof opt.media.suggestionId === 'string' && opt.media.suggestionId.trim()
              ? { suggestionId: opt.media.suggestionId.trim().slice(0, 64) }
              : {}),
          };
        }
        return { id, label, ...(media ? { media } : {}) };
      });
      const allMedia = options.every(opt => !!opt.media);
      let durationSeconds = null;
      if (a.durationSeconds !== undefined && a.durationSeconds !== null) {
        const secs = Number(a.durationSeconds);
        if (!Number.isInteger(secs) || secs < 30 || secs > 600) {
          throw new Error('Poll duration must be between 30 and 600 seconds');
        }
        durationSeconds = secs;
      }
      const onClose = a.onClose === undefined ? (allMedia ? 'queueNext' : 'results') : a.onClose;
      if (!['results', 'queueNext', 'playNow'].includes(onClose)) throw new Error('Invalid poll close action');
      if (onClose !== 'results' && !allMedia) throw new Error('Queue and play actions require media options');
      const tieRule = a.tieRule === undefined ? 'host' : a.tieRule;
      if (!['host', 'random'].includes(tieRule)) throw new Error('Invalid tie rule');
      return { question, options, durationSeconds, onClose, tieRule };
    },
  },
  'poll.vote': {
    scope: 'room',
    capability: null,
    roomLocal: true,
    liveOnly: true,
    args(a) {
      if (typeof a.pollId !== 'string' || !a.pollId.trim()) throw new Error('Invalid poll');
      if (typeof a.optionId !== 'string' || !a.optionId.trim()) throw new Error('Choose a poll option');
      return { pollId: a.pollId.trim(), optionId: a.optionId.trim() };
    },
  },
  'poll.close': {
    scope: 'room',
    capability: 'runPolls',
    roomLocal: true,
    liveOnly: true,
    args(a) {
      const out = {};
      if (a.pollId !== undefined) {
        if (typeof a.pollId !== 'string' || !a.pollId.trim()) throw new Error('Invalid poll');
        out.pollId = a.pollId.trim();
      }
      if (a.winnerOptionId !== undefined) {
        if (typeof a.winnerOptionId !== 'string' || !a.winnerOptionId.trim()) throw new Error('Invalid winner option');
        out.winnerOptionId = a.winnerOptionId.trim();
      }
      return out;
    },
  },
  'poll.clear': {
    scope: 'room',
    capability: 'runPolls',
    roomLocal: true,
    liveOnly: true,
    args(a) {
      if (a.pollId === undefined) return {};
      if (typeof a.pollId !== 'string' || !a.pollId.trim()) throw new Error('Invalid poll');
      return { pollId: a.pollId.trim() };
    },
  },
  'media.autoplay.set': { scope: 'room', capability: 'autoplay', roomLocal: true },
  'media.autoplay.cancel': { scope: 'room', capability: 'autoplay', roomLocal: true },
  'media.load': {
    scope: 'room',
    capability: 'chooseMedia',
    prepares: true,
    persists: true,
    args(a) {
      if (!mediaIdentity(a.mediaId)) throw new Error('Choose a library item');
      if (!validQuality(a.quality)) throw new Error('Choose a playback quality');
      const args = { mediaId: a.mediaId, quality: a.quality };
      if (a.position !== undefined) {
        if (typeof a.position !== 'number' || !Number.isFinite(a.position) || a.position < 0)
          throw new Error('Invalid playback position');
        args.position = a.position;
      }
      if (a.resume !== undefined) {
        if (typeof a.resume !== 'boolean') throw new Error('Invalid resume setting');
        args.resume = a.resume;
      }
      return withServer(args, a);
    },
  },
  'media.previous': { scope: 'room', capability: 'chooseMedia', prepares: true, persists: true, args: none },
  'media.next': {
    scope: 'room',
    capability: 'chooseMedia',
    idle: 'playPause',
    hostless: true,
    prepares: true,
    persists: true,
    args: none,
  },
  'media.quality.set': {
    scope: 'personal',
    capability: null,
    prepares: 'personal',
    handler: 'quality',
    roomLocal: true,
    args(a) {
      if (!validQuality(a.quality)) throw new Error('Choose a playback quality');
      const args = { quality: a.quality };
      if (a.compatible !== undefined) {
        if (typeof a.compatible !== 'boolean') throw new Error('Invalid compatibility setting');
        args.compatible = a.compatible;
      }
      if (a.fallback !== undefined) {
        if (!['av1', 'vp8', 'vp9', 'provider', 'audio'].includes(a.fallback))
          throw new Error('Invalid playback fallback');
        args.fallback = a.fallback;
      }
      if (a.ubuplayer !== undefined) {
        if (typeof a.ubuplayer !== 'boolean') throw new Error('Invalid UbuPlayer setting');
        args.ubuplayer = a.ubuplayer;
      }
      if (a.gpuTonemap !== undefined) {
        if (typeof a.gpuTonemap !== 'boolean') throw new Error('Invalid GPU tonemapping setting');
        args.gpuTonemap = a.gpuTonemap;
      }
      if (a.reset === true) args.reset = true;
      if (typeof a.reason === 'string') args.reason = a.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
      return args;
    },
  },
  'media.tracks.set': {
    scope: 'personal',
    capability: null,
    prepares: 'personal',
    handler: 'tracks',
    roomLocal: true,
    args(a) {
      const args = versions(a, 'Track selection expired.');
      if (a.audioId !== undefined) {
        if (typeof a.audioId !== 'string' || !TRACK.test(a.audioId) || a.audioId === 'off')
          throw new Error('Choose an audio track.');
        args.audioId = a.audioId;
      }
      if (a.subtitleId !== undefined) {
        if (typeof a.subtitleId !== 'string' || !TRACK.test(a.subtitleId)) throw new Error('Choose subtitles or Off.');
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
      return args;
    },
  },
  'media.stream.refresh': {
    scope: 'personal',
    capability: null,
    prepares: 'personal',
    handler: 'stream',
    roomLocal: true,
    args: a => versions(a, 'Stream refresh expired.'),
  },
  'media.delivery.set': {
    scope: 'personal',
    capability: null,
    prepares: 'personal',
    handler: 'delivery',
    roomLocal: true,
    args(a) {
      if (a.mode !== 'local' && a.mode !== 'auto') throw new Error('Choose a playback source.');
      if (typeof a.mediaVersion !== 'string' || !VERSION.test(a.mediaVersion))
        throw new Error('Playback source selection expired.');
      const args = { mode: a.mode, mediaVersion: a.mediaVersion };
      if (a.native !== undefined) {
        if (typeof a.native !== 'boolean') throw new Error('Invalid local playback mode.');
        args.native = a.native;
      }
      return args;
    },
  },
  'media.volume.set': { scope: 'personal', capability: null, handler: 'player', roomLocal: true },
  'media.mute': { scope: 'personal', capability: null, handler: 'player', roomLocal: true },
  'media.unmute': { scope: 'personal', capability: null, handler: 'player', roomLocal: true },
  'media.reporting.set': {
    scope: 'personal',
    capability: null,
    handler: 'reporting',
    roomLocal: true,
    args(a) {
      const args = {};
      if (a.activity !== undefined) {
        if (typeof a.activity !== 'boolean') throw new Error('Choose activity reporting on or off');
        args.activity = a.activity;
      }
      if (a.watchState !== undefined) {
        if (typeof a.watchState !== 'boolean') throw new Error('Choose watch state sync on or off');
        args.watchState = a.watchState;
      }
      if (args.activity === undefined && args.watchState === undefined) throw new Error('Choose a reporting setting');
      return args;
    },
  },
  'queue.add': {
    scope: 'room',
    refillsAutoQueue: true,
    capability: 'addQueue',
    preparesSaved: true,
    loadsFirstItem: true,
    args: queueItem,
  },
  'queue.suggest': {
    scope: 'room',
    capability: 'suggestMedia',
    roomLocal: true,
    liveOnly: true,
    args: suggestItem,
  },
  'queue.suggestion.accept': {
    scope: 'room',
    refillsAutoQueue: true,
    capability: 'addQueue',
    loadsFirstItem: true,
    liveOnly: true,
    args: suggestion,
  },
  'queue.suggestion.playNow': {
    scope: 'room',
    refillsAutoQueue: true,
    capability: 'chooseMedia',
    prepares: true,
    liveOnly: true,
    args: suggestion,
  },
  'queue.suggestion.dismiss': {
    scope: 'room',
    capability: 'addQueue',
    roomLocal: true,
    liveOnly: true,
    args: suggestion,
  },
  'queue.suggestion.agree': {
    scope: 'room',
    capability: 'suggestMedia',
    roomLocal: true,
    liveOnly: true,
    args: suggestionAgreement,
  },
  'queue.playNow': {
    refillsAutoQueue: true,
    scope: 'room',
    capability: 'chooseMedia',
    prepares: true,
    preparesSaved: true,
    args: queueItem,
  },
  'queue.offer.start': {
    scope: 'room',
    capability: 'addQueue',
    also: 'playPause',
    prepares: true,
    args(a) {
      if (
        typeof a.mediaId !== 'string' ||
        !ITEM.test(a.mediaId) ||
        typeof a.showId !== 'string' ||
        !ITEM.test(a.showId)
      )
        throw new Error('Choose an offer item');
      return withServer({ mediaId: a.mediaId, showId: a.showId }, a);
    },
  },
  'queue.bulk': {
    refillsAutoQueue: true,
    scope: 'room',
    capability: 'addQueue',
    prepares: true,
    preparesSaved: true,
    args(a) {
      if (
        !['show', 'season', 'playlist'].includes(a.type) ||
        typeof a.mediaId !== 'string' ||
        !ITEM.test(a.mediaId) ||
        typeof a.unfinished !== 'boolean' ||
        typeof a.includeSpecials !== 'boolean'
      )
        throw new Error('Choose show, season or playlist queue options');
      return withServer(
        { type: a.type, mediaId: a.mediaId, unfinished: a.unfinished, includeSpecials: a.includeSpecials },
        a,
      );
    },
  },
  'queue.auto': {
    scope: 'room',
    capability: 'editQueue',
    prepares: true,
    preparesSaved: true,
    args(a) {
      if (!['off', 'continue', 'following', 'random'].includes(a.mode) || typeof a.includeSpecials !== 'boolean')
        throw new Error('Choose an auto-queue mode');
      /** @type {Record<string, any>} */
      const args = { mode: a.mode, includeSpecials: a.includeSpecials };
      if (['following', 'random'].includes(a.mode)) {
        if (
          !a.scope ||
          !['show', 'library', 'collection'].includes(a.scope.type) ||
          (a.mode === 'following' && a.scope.type !== 'show') ||
          (a.scope.id !== undefined && (typeof a.scope.id !== 'string' || !ITEM.test(a.scope.id)))
        )
          throw new Error('Choose an auto-queue source');
        args.scope = withServer({ type: a.scope.type, ...(a.scope.id ? { id: a.scope.id } : {}) }, a.scope);
      } else {
        args.scope = null;
      }
      return args;
    },
  },
  'queue.auto.skip': { scope: 'room', capability: 'editQueue', prepares: true, preparesSaved: true, args: none },
  'queue.auto.pin': { scope: 'room', capability: 'addQueue', prepares: true, preparesSaved: true, args: none },
  'queue.auto.playNow': {
    scope: 'room',
    capability: 'chooseMedia',
    idle: 'playPause',
    hostless: true,
    prepares: true,
    args(a) {
      const args = {};
      if (a.skipPrevious !== undefined) {
        if (typeof a.skipPrevious !== 'boolean') throw new Error('Choose whether to skip upcoming items');
        args.skipPrevious = a.skipPrevious;
      }
      return args;
    },
  },
  'queue.move': { scope: 'room', refillsAutoQueue: true, capability: 'editQueue', args: entry },
  'queue.remove': { scope: 'room', refillsAutoQueue: true, capability: 'editQueue', args: entry },
  'queue.history.replay': {
    refillsAutoQueue: true,
    scope: 'room',
    capability: 'chooseMedia',
    idle: 'playPause',
    hostless: true,
    prepares: true,
    args: entry,
  },
  'queue.playEntry': {
    scope: 'room',
    refillsAutoQueue: true,
    capability: 'chooseMedia',
    prepares: true,
    args: entry,
  },
  'queue.skipTo': { scope: 'room', refillsAutoQueue: true, capability: 'chooseMedia', prepares: true, args: entry },
  'queue.history.goBack': {
    scope: 'room',
    refillsAutoQueue: true,
    capability: 'chooseMedia',
    prepares: true,
    args: entry,
  },
  'queue.clear': { scope: 'room', refillsAutoQueue: true, capability: 'editQueue', args: none },
  'queue.shuffle': { scope: 'room', refillsAutoQueue: true, capability: 'editQueue', args: none },
  'queue.history.clear': { scope: 'room', refillsAutoQueue: true, capability: 'editQueue', args: none },
});
/** @param {unknown} action @returns {Command | undefined} */
function command(action) {
  return typeof action === 'string' && Object.hasOwn(COMMANDS, action) ? COMMANDS[action] : undefined;
}
function validate(input) {
  const syncValidated = validateSyncCommand(input);
  if (syncValidated) return syncValidated;
  const action = input.action;
  const declared = command(action);
  if (!declared?.args) throw new Error('Unsupported command');
  const a = input.args || {};
  const args = declared.args(a, action);
  if (action.startsWith('queue.') && a.expectedRevision !== undefined) {
    if (!Number.isSafeInteger(a.expectedRevision) || a.expectedRevision < 0) throw new Error('Invalid queue revision');
    args.expectedRevision = a.expectedRevision;
  }
  return { action, args };
}
export {
  QUALITIES,
  qualityId,
  mediaIdentity,
  qualityDefinition,
  validQuality,
  COMMANDS,
  command,
  senderName,
  validate,
};
