// @ts-check
'use strict';
// Constants and small helpers the parts of Watch share.

// A tab the room let go of (privacy, presence timeout) must join again; looking never readmits it.
const REJOIN = 'You are no longer in this room; join again';
// Plain room and viewer fields the room core manages beyond its own (see ROOM_STATE_KEYS).
const ROOM_KEYS = ['saved', 'ownerId', 'ownerName', 'autoplayCountdown', 'endedVersion'];
const PERSONAL_KEYS = [
  'quality',
  'preferredQuality',
  'volume',
  'muted',
  'plexReporting',
  'plexWatchState',
  'trackChoice',
  'subtitleOffset',
  'compatible',
  'fallback',
  'directProxyVersion',
  'browserSubtitles',
  'localCodecs',
  'localDelivery',
  'browserLoginHash',
];
// The access a viewer's republish relies on is rechecked this often from their own presence.
const ACCESS_RECHECK_MS = 3000;
// A stream that keeps a Plex transcode open is pinged this often.
const TRANSCODE_PING_MS = 15000;
// The answer to a command whose room, epoch, deadline or permission moved on before it applied.
const expired = () => ({ status: 'unavailable', message: 'Room changed or command expired.' });
// Admission's answer when the command's work is already running outside the mailbox.
const later = promise => () => promise;

function formatEntrySubtitle(entry) {
  if (!entry) return '';
  if (entry.subtitle) return entry.subtitle;
  if (entry.type === 'episode') {
    return [entry.grandparentTitle, entry.parentTitle].filter(Boolean).join(' Â· ');
  }
  return entry.parentTitle || '';
}

module.exports = {
  REJOIN,
  ROOM_KEYS,
  PERSONAL_KEYS,
  ACCESS_RECHECK_MS,
  TRANSCODE_PING_MS,
  expired,
  later,
  formatEntrySubtitle,
};
