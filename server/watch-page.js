'use strict';

const { svgMarkup, spriteMarkup } = require('../web/icons');
const { homeCards } = require('../web/watch-library');

const escapeText = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
function replaceTemplate(html, target, replacement) {
  if (!html.includes(target)) {
    throw new Error('watch.html template target missing: ' + target);
  }
  return html.replace(target, replacement);
}

// Personalized HTML is sent with no-store. JSON remains inert, and every value
// used in the initial visible room rows is escaped independently of that JSON.
function watchPage(template, initial, scrollbarStyleNonce) {
  let html = replaceTemplate(
    template,
    '<svg id="icon-sprite" hidden aria-hidden="true" width="0" height="0"></svg>',
    spriteMarkup(),
  );
  if (scrollbarStyleNonce) {
    // The nonce is a server-generated base64 token (no user input).
    html = replaceTemplate(
      html,
      '<script type="module" src="/watch.js"></script>',
      '<script type="module" src="/watch.js" data-os-style-nonce="' + scrollbarStyleNonce + '"></script>',
    );
  }
  if (initial.me?.status === 200 && initial.rooms?.status === 200) {
    const me = initial.me.value;
    html = replaceTemplate(
      html,
      'id="queue-empty-browse" type="button" class="quiet" aria-label="Browse media" title="Browse media" disabled',
      'id="queue-empty-browse" type="button" class="quiet" aria-label="Browse media" title="Browse media"',
    );
    if (me.name) {
      const label = escapeText(me.name + (initial.config?.demo ? ' · local demo' : ''));
      const disabledAttr = initial.config?.unifiedAccounts ? '' : ' disabled';
      html = replaceTemplate(
        html,
        '<button id="identity" type="button" aria-haspopup="dialog" aria-controls="account-dialog" aria-label="Account settings" title="Account settings" disabled></button>',
        '<button id="identity" type="button" aria-haspopup="dialog" aria-controls="account-dialog" aria-label="' +
          label +
          ' · Account settings" title="Account settings"' +
          disabledAttr +
          '>' +
          label +
          '</button>',
      );
    }
    if (me.adminEligible ?? me.owner) {
      const checked = Boolean(me.adminMode);
      const title = checked ? 'Admin mode on: turn off' : 'Admin mode off: turn on';
      html = replaceTemplate(
        html,
        '<button id="admin-mode" class="admin-toggle" role="switch" aria-checked="false" aria-label="Admin mode" title="Admin mode" hidden>',
        '<button id="admin-mode" class="admin-toggle" role="switch" aria-checked="' +
          checked +
          '" aria-label="Admin mode" title="' +
          title +
          '">',
      );
    }
    if (me.durableRooms && !me.guestRoomId && !initial.config?.singleRoom) {
      html = replaceTemplate(html, 'id="lobby-reopen" class="quiet" hidden', 'id="lobby-reopen" class="quiet"');
      html = replaceTemplate(
        html,
        'id="reopen" class="quiet watch-control watch-control-responsive" aria-label="Reopen room" title="Reopen room" hidden',
        'id="reopen" class="quiet watch-control watch-control-responsive" aria-label="Reopen room" title="Reopen room"',
      );
    }
    if (initial.events?.status === 200 && initial.events.value?.canSchedule && !initial.config?.singleRoom) {
      html = replaceTemplate(
        html,
        'id="lobby-schedule" class="quiet" type="button" aria-label="Schedule event" hidden',
        'id="lobby-schedule" class="quiet" type="button" aria-label="Schedule event"',
      );
    }
    if (initial.library?.status === 200) {
      const lib = initial.library.value;
      const cards = homeCards(lib.items || []).map(card => {
        const title = escapeText(card.title);
        return (
          '<button type="button" class="library-home-card" aria-label="' +
          title +
          '" title="' +
          title +
          '" data-section="' +
          escapeText(card.id) +
          '" data-tab="' +
          card.tab +
          '">' +
          svgMarkup(card.icon) +
          '<span class="library-home-title">' +
          title +
          '</span></button>'
        );
      });
      if (lib.testVideo || me.adminMode) {
        let other = '<article class="library-home-card library-other"><h3>Other</h3>';
        if (lib.testVideo) {
          other +=
            '<button type="button" class="library-key" aria-label="Play synchronization video" title="Play synchronization video" data-action="play" data-play="demo">' +
            svgMarkup('play') +
            '<span>Synchronization video</span></button>';
        }
        if (me.adminMode) {
          other +=
            '<button id="library-codec-test" type="button" class="library-key" aria-label="Open codec tester" title="Open codec tester">' +
            svgMarkup('settings') +
            '<span>Codec tester</span></button>';
        }
        other += '</article>';
        cards.push(other);
      }
      html = replaceTemplate(
        html,
        '<div id="library-content"></div>',
        '<div id="library-content"><div class="library-landing">' + cards.join('') + '</div></div>',
      );
    }
    if (!initial.targetRoom && !initial.inviteCode && !me.guestRoomId) {
      const rows = initial.rooms.value.rooms
        .map(room => {
          const info =
            (room.title || 'No video selected') + ' · ' + room.viewers + (room.viewers === 1 ? ' viewer' : ' viewers');
          const action = room.locked
            ? '<button class="quiet" disabled>Join</button>'
            : '<a class="quiet" href="/room/' + encodeURIComponent(room.slug || room.id) + '">Join</a>';
          return (
            '<div class="saved-room"><div><strong>' +
            escapeText(room.name || room.hostName) +
            '</strong><p class="hint">' +
            escapeText(info) +
            '</p></div><div class="room-actions">' +
            action +
            '</div></div>'
          );
        })
        .join('');
      html = replaceTemplate(html, 'class="auth-pending outside-room idle-player"', 'class="outside-room idle-player"');
      html = replaceTemplate(
        html,
        'id="auth-overlay" class="lobby-auth"',
        'id="auth-overlay" class="lobby-auth" hidden',
      );
      html = replaceTemplate(html, 'id="room-lobby" hidden', 'id="room-lobby"');
      html = replaceTemplate(
        html,
        '<div id="lobby-rooms" class="lobby-rooms" aria-label="Active rooms"></div>',
        '<div id="lobby-rooms" class="lobby-rooms" aria-label="Active rooms">' + rows + '</div>',
      );
    } else if (initial.targetRoom?.name) {
      const roomName = escapeText(initial.targetRoom.name);
      const media = initial.targetRoom.media;
      html = replaceTemplate(
        html,
        'id="auth-overlay" class="lobby-auth"',
        'id="auth-overlay" class="lobby-auth" hidden',
      );
      html = replaceTemplate(
        html,
        '<span id="options-title" class="watch-panel-title">Room</span>',
        '<span id="options-title" class="watch-panel-title">' + roomName + '</span>',
      );
      html = replaceTemplate(
        html,
        '<div id="current-room" class="room-content-columns" hidden>',
        '<div id="current-room" class="room-content-columns">',
      );
      html = replaceTemplate(
        html,
        '<button id="switch-room" class="quiet watch-control" aria-label="Choose room" title="Choose room"><span class="watch-control-label">Choose room</span></button>',
        '<button id="switch-room" class="quiet watch-control" aria-label="Switch room" title="Switch room"><span class="watch-control-label">Switch room</span></button>',
      );
      html = replaceTemplate(
        html,
        '<button id="create" class="quiet watch-control" aria-label="New room" title="New room"><span class="watch-control-label">New room</span></button>',
        '<button id="create" class="quiet watch-control" aria-label="New room" title="New room" hidden><span class="watch-control-label">New room</span></button>',
      );
      html = replaceTemplate(
        html,
        'id="close-room" class="quiet watch-control watch-control-responsive" aria-label="Leave room" title="Leave room" hidden',
        'id="close-room" class="quiet watch-control watch-control-responsive" aria-label="Leave room" title="Leave room"',
      );
      if (media?.title) {
        html = replaceTemplate(html, 'class="auth-pending outside-room idle-player"', 'class=""');
        html = replaceTemplate(html, '<div id="empty-stage">', '<div id="empty-stage" hidden>');
        html = replaceTemplate(
          html,
          '<h1 id="title">Watch together</h1><p id="details"></p>',
          '<h1 id="title">' +
            escapeText(media.title) +
            '</h1><p id="details">' +
            escapeText(media.subtitle || '') +
            '</p>',
        );
        html = replaceTemplate(
          html,
          '<h3 class="queue-empty-title">The queue lives in a room</h3><p class="queue-empty-text">',
          '<h3 class="queue-empty-title" hidden>The queue lives in a room</h3><p class="queue-empty-text" hidden>',
        );
      } else {
        html = replaceTemplate(html, 'class="auth-pending outside-room idle-player"', 'class="idle-player"');
        html = replaceTemplate(
          html,
          '<h1 id="empty-title">Join or create a room</h1>',
          '<h1 id="empty-title">' + roomName + '</h1>',
        );
        html = replaceTemplate(
          html,
          '<p id="empty-hint">Choose an active room or create your own.</p>',
          '<p id="empty-hint"></p>',
        );
      }
    }
  }
  const data = JSON.stringify(initial).replace(
    /[<>&\u2028\u2029]/g,
    char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'),
  );
  return replaceTemplate(
    html,
    '<script type="module" src="/watch.js"',
    '<script id="watch-bootstrap" type="application/json">' + data + '</script><script type="module" src="/watch.js"',
  );
}

module.exports = { watchPage };
