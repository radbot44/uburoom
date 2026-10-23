/* Feedback labels for watch-room commands. */
(function (root) {
  'use strict';
  const icons = root.uburoomIcons, global = root;
  function badgeDetails(command, state = {}) {
    const { action, args = {} } = command, picture = state.picture || {};
    const percent = n => Number(((n ?? 1) * 100).toFixed(2)) + '%';
    const position = (axis, n) => axis.toUpperCase() + ' ' + (n > 0 ? '+' : '') + percent(n ?? 0);
    let symbol, value = '', label;
    switch (action) {
      case 'media.play': case 'media.pause': case 'media.toggle':
        symbol = action === 'media.toggle' ? (state.paused ? 'pause' : 'play') : action.slice(6);
        label = symbol === 'play' ? 'Play' : 'Pause'; break;
      case 'media.mute': case 'media.unmute': case 'media.volume.set':
        symbol = icons.volumeName(state.volume ?? args.percent, action === 'media.mute' || (action !== 'media.unmute' && !!state.muted));
        label = action === 'media.volume.set' ? 'Volume' : action === 'media.mute' ? 'Mute' : 'Unmute';
        if (action === 'media.volume.set') value = (state.volume ?? args.percent) + '%'; break;
      case 'media.seek.relative':
        symbol = args.seconds < 0 ? 'back' : 'forward'; label = args.seconds < 0 ? 'Seek back' : 'Seek forward';
        if (![15, 30, 60].includes(Math.abs(Number(args.seconds)))) value = Math.abs(Number(args.seconds)) + 's';
        break;
      case 'media.seek.absolute': {
        const seconds = Math.floor(state.position ?? args.seconds ?? 0);
        symbol = 'end'; value = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); label = 'Seek'; break;
      }
      case 'media.load': symbol = 'play'; label = 'Video selected'; break;
      case 'media.previous': symbol = 'start'; label = 'Previous / restart'; break;
      case 'media.next': symbol = 'end'; label = 'Next video'; break;
      case 'media.quality.set': symbol = 'settings'; value = global.uburoom?.QUALITIES?.find(q => q.id === global.uburoom.qualityId(args.quality))?.label || (args.quality === 'direct' ? 'Original' : args.quality); label = 'Quality'; break;
      case 'media.seek.start': symbol = 'start'; label = 'Back to start'; break;
      case 'media.seek.end': symbol = 'end'; label = 'Go to end / live'; break;
      case 'zoom.set': case 'zoom.adjust': case 'reset.zoom':
        symbol = 'zoom'; value = percent(picture.zoom); label = action === 'reset.zoom' ? 'Reset zoom' : 'Zoom'; break;
      case 'stretch.set': case 'stretch.adjust': case 'reset.stretchX': case 'reset.stretchY':
        symbol = args.axis || action.slice(6); value = percent(picture[symbol]);
        label = (action.startsWith('reset.') ? 'Reset ' : '') + (symbol === 'stretchX' ? 'width' : 'height'); break;
      case 'pan.step': case 'pan.edge':
        symbol = args.axis === 'x' ? (args.sign < 0 ? 'left' : 'right') : (args.sign < 0 ? 'up' : 'down');
        value = action === 'pan.edge' ? 'Offscreen' : position(args.axis, picture[args.axis]); label = 'Move ' + symbol; break;
      case 'pan.set': case 'pan.move':
        symbol = 'center'; value = position('x', picture.x) + ' · ' + position('y', picture.y); label = 'Position'; break;
      case 'reset.pan': symbol = 'center'; value = 'Centered'; label = 'Recenter'; break;
      case 'reset.stretch': symbol = 'refresh'; value = 'Width / height'; label = 'Reset stretch'; break;
      case 'reset.all': symbol = 'refresh'; value = 'Reset all'; label = value; break;
      case 'profile.load': case 'profile.save':
        symbol = 'bookmark'; value = (action === 'profile.load' ? '↥ Load ' : '↧ Save ') + args.slot; label = value; break;
      case 'room.visibility': symbol = args.visibility === 'private' ? 'lock' : 'users'; value = args.visibility === 'private' ? 'Private' : 'Public'; label = value; break;
      default: return;
    }
    const color = { zoom:'var(--accent-text)', stretchX:'var(--accent-text)', stretchY:'var(--accent-text)' }[symbol] ||
      (action === 'reset.all' ? '#ea3035' : 'var(--text)');
    return { symbol, value, label, color, ...(action === 'media.seek.relative' ? { seekSeconds: Math.abs(args.seconds) } : {}) };
  }
  root.uburoomWatchFeedback = { badgeDetails };
})(globalThis);
