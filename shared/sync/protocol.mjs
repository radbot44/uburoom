// @ts-check
/* Media-agnostic synchronization command validation and control categories.
 * Does not assume Plex media IDs, Discord identities, or catalog queues.
 */

export function createProtocolApi() {
  const DEFAULT_UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  const READINESS_ID_PATTERN = /^[a-f0-9-]{36}$/;

  const CONTROLS = Object.freeze({ playback: true, transform: true });
  const SYNC_MANAGEMENT_ACTIONS = Object.freeze([
    'room.visibility',
    'media.ready.start',
    'media.ready.wait',
    'media.ready.cancel'
  ]);
  const SYNC_ACTIONS = Object.freeze([
    'room.kick',
    'room.visibility',
    'media.play',
    'media.pause',
    'media.toggle',
    'media.seek.start',
    'media.seek.end',
    'media.seek.relative',
    'media.seek.absolute',
    'media.ready.start',
    'media.ready.wait',
    'media.ready.cancel',
    'media.autoplay.set',
    'media.autoplay.cancel',
    'media.volume.set',
    'media.mute',
    'media.unmute'
  ]);

  function controls(value = CONTROLS) {
    if (!value || typeof value.playback !== 'boolean' || typeof value.transform !== 'boolean') {
      throw new Error('Invalid control permissions');
    }
    return { playback: value.playback, transform: value.transform };
  }

  function controlFor(command) {
    if (command.action.startsWith('media.')) return 'playback';
    if (/^(zoom|stretch|pan|reset|profile)\./.test(command.action)) return 'transform';
    return undefined;
  }

  function controlAllowed(value, command) {
    const category = controlFor(command);
    return !category || controls(value)[category];
  }

  function numeric(n, min, max) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
      throw new Error('Value outside supported range');
    }
    return n;
  }

  function senderName(value, fallback = 'Participant') {
    const clean = typeof value === 'string'
      ? value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 100)
      : '';
    return clean || fallback;
  }

  /**
   * Validate a media-agnostic synchronization or room-coordination command.
   * Returns `{ action, args }` for recognized sync commands, `undefined` for
   * host/catalog-specific commands, and throws when a sync command has invalid arguments.
   * @param {any} command
   * @param {{userIdPattern?:RegExp, readinessIdPattern?:RegExp}} [options]
   */
  function validateSyncCommand(command, options = {}) {
    if (!command || typeof command !== 'object') throw new Error('Invalid command');
    const action = command.action;
    if (typeof action !== 'string') throw new Error('Unsupported command');
    const a = command.args || {};
    const args = {};
    const userIdPattern = options.userIdPattern || DEFAULT_UUID_PATTERN;
    const readinessIdPattern = options.readinessIdPattern || READINESS_ID_PATTERN;

    switch (action) {
      case 'room.kick':
        if (typeof a.userId !== 'string' || !userIdPattern.test(a.userId)) throw new Error('Choose a participant');
        args.userId = a.userId;
        return { action, args };
      case 'room.visibility':
        if (!['public', 'private'].includes(a.visibility)) throw new Error('Choose Public or Private');
        args.visibility = a.visibility;
        return { action, args };
      case 'media.pause':
      case 'media.play':
      case 'media.mute':
      case 'media.unmute':
      case 'media.toggle':
      case 'media.seek.start':
      case 'media.seek.end':
      case 'media.autoplay.cancel':
        return { action, args };
      case 'media.autoplay.set':
        if (typeof a.enabled !== 'boolean') throw new Error('Choose autoplay on or off');
        args.enabled = a.enabled;
        return { action, args };
      case 'media.ready.start':
      case 'media.ready.wait':
      case 'media.ready.cancel':
        if (typeof a.readinessId !== 'string' || !readinessIdPattern.test(a.readinessId)) {
          throw new Error('Readiness choice expired.');
        }
        args.readinessId = a.readinessId;
        return { action, args };
      case 'media.volume.set':
        args.percent = numeric(a.percent, 0, 100);
        return { action, args };
      case 'media.seek.relative':
        args.seconds = numeric(a.seconds, -600, 600);
        return { action, args };
      case 'media.seek.absolute':
        args.seconds = numeric(a.seconds, 0, 1e9);
        return { action, args };
      default:
        return undefined;
    }
  }

  return {
    CONTROLS,
    SYNC_MANAGEMENT_ACTIONS,
    SYNC_ACTIONS,
     numeric,
    controls,
    controlFor,
    controlAllowed,
    senderName,
    validateSyncCommand
  };
}

export const {
  CONTROLS,
  SYNC_MANAGEMENT_ACTIONS,
  SYNC_ACTIONS,
  numeric,
  controls,
  controlFor,
  controlAllowed,
  senderName,
  validateSyncCommand
} = createProtocolApi();
