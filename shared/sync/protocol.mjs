// @ts-check
/* Media-agnostic synchronization command validation and control categories.
 * Does not assume Plex media IDs, Discord identities, or catalog queues.
 */

export function createProtocolApi() {
  const DEFAULT_UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  const READINESS_ID_PATTERN = /^[a-f0-9-]{36}$/;

  const CONTROLS = Object.freeze({ playback: true });
  const none = () => ({});
  const readiness = (a, { readinessIdPattern }) => {
    if (typeof a.readinessId !== 'string' || !readinessIdPattern.test(a.readinessId)) {
      throw new Error('Readiness choice expired.');
    }
    return { readinessId: a.readinessId };
  };
  // Media-agnostic commands, each declared once with its argument validator.
  // Host applications add their own facts and extension commands on top.
  /** @type {Readonly<Record<string, {management?: boolean, args: (a: any, options: {userIdPattern: RegExp, readinessIdPattern: RegExp}) => Record<string, any>}>>} */
  const SYNC_COMMANDS = Object.freeze({
    'room.kick': {
      args(a, { userIdPattern }) {
        if (typeof a.userId !== 'string' || !userIdPattern.test(a.userId)) throw new Error('Choose a participant');
        return { userId: a.userId };
      },
    },
    'room.visibility': {
      management: true,
      args(a) {
        if (!['public', 'private'].includes(a.visibility)) throw new Error('Choose Public or Private');
        return { visibility: a.visibility };
      },
    },
    'media.play': { args: none },
    'media.pause': { args: none },
    'media.toggle': { args: none },
    'media.seek.start': { args: none },
    'media.seek.end': { args: none },
    'media.seek.relative': { args: a => ({ seconds: numeric(a.seconds, -600, 600) }) },
    'media.seek.absolute': { args: a => ({ seconds: numeric(a.seconds, 0, 1e9) }) },
    'media.ready.start': { management: true, args: readiness },
    'media.ready.wait': { management: true, args: readiness },
    'media.ready.cancel': { management: true, args: readiness },
    'media.autoplay.set': {
      args(a) {
        if (typeof a.enabled !== 'boolean') throw new Error('Choose autoplay on or off');
        return { enabled: a.enabled };
      },
    },
    'media.autoplay.cancel': { args: none },
    'media.volume.set': { args: a => ({ percent: numeric(a.percent, 0, 100) }) },
    'media.mute': { args: none },
    'media.unmute': { args: none },
  });
  const SYNC_ACTIONS = Object.freeze(Object.keys(SYNC_COMMANDS));
  const SYNC_MANAGEMENT_ACTIONS = Object.freeze(SYNC_ACTIONS.filter(action => SYNC_COMMANDS[action].management));

  function controls(value = CONTROLS) {
    if (!value || typeof value.playback !== 'boolean') {
      throw new Error('Invalid control permissions');
    }
    return { playback: value.playback };
  }

  function controlFor(command) {
    if (command.action.startsWith('media.')) return 'playback';
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
    const clean =
      typeof value === 'string'
        ? value
            .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
            .trim()
            .slice(0, 100)
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
    if (!Object.hasOwn(SYNC_COMMANDS, action)) return undefined;
    const args = SYNC_COMMANDS[action].args(command.args || {}, {
      userIdPattern: options.userIdPattern || DEFAULT_UUID_PATTERN,
      readinessIdPattern: options.readinessIdPattern || READINESS_ID_PATTERN,
    });
    return { action, args };
  }

  return {
    CONTROLS,
    SYNC_COMMANDS,
    SYNC_MANAGEMENT_ACTIONS,
    SYNC_ACTIONS,
    numeric,
    controls,
    controlFor,
    controlAllowed,
    senderName,
    validateSyncCommand,
  };
}

export const {
  CONTROLS,
  SYNC_COMMANDS,
  SYNC_MANAGEMENT_ACTIONS,
  SYNC_ACTIONS,
  numeric,
  controls,
  controlFor,
  controlAllowed,
  senderName,
  validateSyncCommand,
} = createProtocolApi();
