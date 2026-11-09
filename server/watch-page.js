'use strict';

const escapeText = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const svgIcon = name => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-tabler-icon="' + name + '"><use href="#icon-' + name + '"></use></svg>';

// Personalized HTML is sent with no-store. JSON remains inert, and every value
// used in the initial visible room rows is escaped independently of that JSON.
function watchPage(template, initial, scrollbarStyleNonce) {
  let html = template;
  if (scrollbarStyleNonce) {
    // The nonce is a server-generated base64 token (no user input).
    html = html.replace('<script src="/watch-scrollbars.js"></script>',
      '<script src="/watch-scrollbars.js" data-os-style-nonce="' + scrollbarStyleNonce + '"></script>');
  }
  if (initial.me?.status === 200 && initial.rooms?.status === 200) {
    const me = initial.me.value;
    html = html.replace(
      'id="queue-empty-browse" type="button" class="quiet" aria-label="Browse media" title="Browse media" disabled',
      'id="queue-empty-browse" type="button" class="quiet" aria-label="Browse media" title="Browse media"'
    );
    if (me.name) {
      const label = escapeText(me.name + (initial.config?.demo ? ' · local demo' : ''));
      const disabledAttr = initial.config?.unifiedAccounts ? '' : ' disabled';
      html = html.replace(
        '<button id="identity" type="button" aria-haspopup="dialog" aria-controls="account-dialog" aria-label="Account settings" title="Account settings" disabled></button>',
        '<button id="identity" type="button" aria-haspopup="dialog" aria-controls="account-dialog" aria-label="' + label + ' · Account settings" title="Account settings"' + disabledAttr + '>' + label + '</button>'
      );
    }
    if (me.adminEligible ?? me.owner) {
      const checked = Boolean(me.adminMode);
      const title = checked ? 'Admin mode on: turn off' : 'Admin mode off: turn on';
      html = html.replace(
        '<button id="admin-mode" class="admin-toggle" role="switch" aria-checked="false" aria-label="Admin mode" title="Admin mode" hidden>',
        '<button id="admin-mode" class="admin-toggle" role="switch" aria-checked="' + checked + '" aria-label="Admin mode" title="' + title + '">'
      );
    }
    if (me.durableRooms && !me.guestRoomId && !initial.config?.singleRoom) {
      html = html.replace('id="lobby-reopen" class="quiet" hidden', 'id="lobby-reopen" class="quiet"')
        .replace('id="reopen" class="quiet watch-control watch-control-responsive" aria-label="Reopen room" title="Reopen room" hidden', 'id="reopen" class="quiet watch-control watch-control-responsive" aria-label="Reopen room" title="Reopen room"');
    }
    if (initial.events?.status === 200 && initial.events.value?.canSchedule && !initial.config?.singleRoom) {
      html = html.replace('id="lobby-schedule" class="quiet" type="button" aria-label="Schedule event" hidden', 'id="lobby-schedule" class="quiet" type="button" aria-label="Schedule event"');
    }
    if (initial.library?.status === 200) {
      const lib = initial.library.value;
      const cards = [];
      for (const tab of ['library', 'collections']) {
        for (const section of lib.items || []) {
          const title = escapeText(tab === 'library' ? section.title : (section.title === 'Movies' ? 'Movie' : section.title) + ' Collections');
          const icon = tab === 'library' ? (section.mediaType === 'show' ? 'device-tv' : 'movie') : 'layout-grid';
          cards.push('<button type="button" class="library-home-card" aria-label="' + title + '" title="' + title + '" data-section="' + escapeText(section.id) + '" data-tab="' + tab + '">' + svgIcon(icon) + '<span class="library-home-title">' + title + '</span></button>');
        }
      }
      if (lib.testVideo || me.adminMode) {
        let other = '<article class="library-home-card library-other"><h3>Other</h3>';
        if (lib.testVideo) {
          other += '<button type="button" class="library-key" aria-label="Play synchronization video" title="Play synchronization video" data-action="play" data-play="demo">' + svgIcon('player-play') + '<span>Synchronization video</span></button>';
        }
        if (me.adminMode) {
          other += '<button id="library-codec-test" type="button" class="library-key" aria-label="Open codec tester" title="Open codec tester">' + svgIcon('settings') + '<span>Codec tester</span></button>';
        }
        other += '</article>';
        cards.push(other);
      }
      html = html.replace('<div id="library-content"></div>', '<div id="library-content"><div class="library-tools"></div><div class="library-landing">' + cards.join('') + '</div></div>');
    }
    if (!initial.targetRoom && !initial.inviteCode && !me.guestRoomId) {
      const rows = initial.rooms.value.rooms.map(room => {
        const info = (room.title || 'No video selected') + ' · ' + room.viewers + (room.viewers === 1 ? ' viewer' : ' viewers');
        const action = room.locked ? '<button class="quiet" disabled>Join</button>' : '<a class="quiet" href="/room/' + encodeURIComponent(room.slug || room.id) + '">Join</a>';
        return '<div class="saved-room"><div><strong>' + escapeText(room.name || room.hostName) + '</strong><p class="hint">' + escapeText(info) + '</p></div><div class="room-actions">' + action + '</div></div>';
      }).join('');
      html = html.replace('class="auth-pending outside-room idle-player"', 'class="outside-room idle-player"')
        .replace('id="auth-overlay" class="lobby-auth"', 'id="auth-overlay" class="lobby-auth" hidden')
        .replace('id="room-lobby" hidden', 'id="room-lobby"')
        .replace('<div id="lobby-rooms" class="lobby-rooms" aria-label="Active rooms"></div>', '<div id="lobby-rooms" class="lobby-rooms" aria-label="Active rooms">' + rows + '</div>');
    } else if (initial.targetRoom?.name) {
      html = html.replace('<h1 id="empty-title">Join or create a room</h1>', '<h1 id="empty-title">' + escapeText(initial.targetRoom.name) + '</h1>')
        .replace('<p id="auth-status" role="status">Loading rooms...</p>', '<p id="auth-status" role="status">Joining room...</p>');
    }
  }
  const data = JSON.stringify(initial).replace(/[<>&\u2028\u2029]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  return html.replace('<script src="/watch.js">', '<script id="watch-bootstrap" type="application/json">' + data + '</script><script src="/watch.js">');
}

module.exports = { watchPage };
