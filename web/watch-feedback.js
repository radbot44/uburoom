/* Feedback labels for watch-room commands. */
import * as uburoomIcons from './icons.js';

const icons = uburoomIcons;
function badgeDetails(command, state = {}) {
  const { action, args = {} } = command;
  let symbol,
    value = '',
    label;
  switch (action) {
    case 'media.play':
    case 'media.pause':
    case 'media.toggle':
      symbol = action === 'media.toggle' ? (state.paused ? 'pause' : 'play') : action.slice(6);
      label = symbol === 'play' ? 'Play' : 'Pause';
      break;
    case 'media.mute':
    case 'media.unmute':
    case 'media.volume.set':
      symbol = icons.volumeName(
        state.volume ?? args.percent,
        action === 'media.mute' || (action !== 'media.unmute' && !!state.muted),
      );
      label = action === 'media.volume.set' ? 'Volume' : action === 'media.mute' ? 'Mute' : 'Unmute';
      if (action === 'media.volume.set') value = (state.volume ?? args.percent) + '%';
      break;
    case 'media.seek.relative':
      symbol = args.seconds < 0 ? 'back' : 'forward';
      label = args.seconds < 0 ? 'Seek back' : 'Seek forward';
      if (![15, 30, 60].includes(Math.abs(Number(args.seconds)))) value = Math.abs(Number(args.seconds)) + 's';
      break;
    case 'media.seek.absolute': {
      const seconds = Math.floor(state.position ?? args.seconds ?? 0);
      symbol = 'end';
      value = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
      label = 'Seek';
      break;
    }
    case 'media.load':
      symbol = 'play';
      label = 'Video selected';
      break;
    case 'media.previous':
      symbol = 'start';
      label = 'Previous / restart';
      break;
    case 'media.next':
      symbol = 'end';
      label = 'Next video';
      break;
    case 'media.quality.set':
      return;
    case 'media.seek.start':
      symbol = 'start';
      label = 'Back to start';
      break;
    case 'media.seek.end':
      symbol = 'end';
      label = 'Go to end / live';
      break;
    case 'room.visibility':
      symbol = args.visibility === 'private' ? 'lock' : 'users';
      value = args.visibility === 'private' ? 'Private' : 'Public';
      label = value;
      break;
    default:
      return;
  }
  return {
    symbol,
    value,
    label,
    color: 'var(--text)',
    ...(action === 'media.seek.relative' ? { seekSeconds: Math.abs(args.seconds) } : {}),
  };
}
export { badgeDetails };
