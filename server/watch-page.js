'use strict';

const { svgMarkup, spriteMarkup } = require('../web/icons');
const { homeCards } = require('../web/watch-library');

const escapeText = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Edits the watch.html template by element, so its formatting does not matter. An element is found by one
 * exact attribute (`id="…"`, or `class="…"` for elements without an id); each target must exist exactly once,
 * or rendering fails rather than sending a page with a stale first paint. Values are escaped by the caller.
 * @param {string} source
 */
function template(source) {
  let html = source;
  function find(attribute, value) {
    const pattern = new RegExp(
      '<([a-zA-Z][\\w-]*)((?:\\s[^>]*?)?\\s' + attribute + '="' + escapeRegExp(value) + '"[^>]*)>',
      'g',
    );
    const matches = [...html.matchAll(pattern)];
    if (matches.length !== 1)
      throw new Error(
        'watch.html template target ' + (matches.length ? 'repeated' : 'missing') + ': ' + attribute + '=' + value,
      );
    const [whole, tag, attributes] = matches[0];
    return { start: matches[0].index, end: matches[0].index + whole.length, tag, attributes };
  }
  // The end of the element that opens at `open`, counting nested elements with the same tag name.
  function closeOf(open) {
    const pattern = new RegExp('<(/?)' + open.tag + '\\b[^>]*>', 'g');
    pattern.lastIndex = open.end;
    let depth = 1;
    for (let match; (match = pattern.exec(html));) {
      depth += match[1] ? -1 : 1;
      if (!depth) return { start: match.index, end: match.index + match[0].length };
    }
    throw new Error('watch.html template element is not closed: ' + open.tag);
  }
  function attributes(open, change) {
    let text = open.attributes;
    for (const [name, value] of Object.entries(change)) {
      const existing = new RegExp('\\s' + name + '(?:="[^"]*")?(?=[\\s/]|$)');
      const next =
        value === false || value === undefined ? '' : value === true ? ' ' + name : ' ' + name + '="' + value + '"';
      text = existing.test(text) ? text.replace(existing, next) : text.replace(/\s*$/, next + text.match(/\s*$/)[0]);
    }
    html = html.slice(0, open.start) + '<' + open.tag + text + '>' + html.slice(open.end);
  }
  return {
    /** Sets (string), adds (true) or removes (false) attributes of one element. */
    set(attribute, value, change) {
      attributes(find(attribute, value), change);
      return this;
    },
    /** Replaces one element's contents with markup. */
    content(attribute, value, markup) {
      const open = find(attribute, value),
        close = closeOf(open);
      html = html.slice(0, open.end) + markup + html.slice(close.start);
      return this;
    },
    /** Replaces one whole element with markup. */
    replace(attribute, value, markup) {
      const open = find(attribute, value),
        close = closeOf(open);
      html = html.slice(0, open.start) + markup + html.slice(close.end);
      return this;
    },
    /** Inserts markup right before one element. */
    before(attribute, value, markup) {
      const open = find(attribute, value);
      html = html.slice(0, open.start) + markup + html.slice(open.start);
      return this;
    },
    toString: () => html,
  };
}

// Personalized HTML is sent with no-store. JSON remains inert, and every value
// used in the initial visible room rows is escaped independently of that JSON.
function watchPage(source, initial, scrollbarStyleNonce) {
  const page = template(source).replace('id', 'icon-sprite', spriteMarkup());
  // The nonce is a server-generated base64 token (no user input).
  if (scrollbarStyleNonce) page.set('src', '/watch.js', { 'data-os-style-nonce': scrollbarStyleNonce });
  if (initial.me?.status === 200 && initial.rooms?.status === 200) {
    const me = initial.me.value;
    page.set('id', 'queue-empty-browse', { disabled: false });
    if (me.name) {
      const label = escapeText(me.name + (initial.config?.demo ? ' · local demo' : ''));
      page
        .set('id', 'identity', {
          'aria-label': label + ' · Account settings',
          disabled: !initial.config?.unifiedAccounts,
        })
        .content('id', 'identity', label);
    }
    if (me.adminEligible ?? me.owner) {
      const checked = Boolean(me.adminMode);
      page.set('id', 'admin-mode', {
        'aria-checked': String(checked),
        title: checked ? 'Admin mode on: turn off' : 'Admin mode off: turn on',
        hidden: false,
      });
    }
    if (me.durableRooms && !me.guestRoomId && !initial.config?.singleRoom) {
      page.set('id', 'lobby-reopen', { hidden: false }).set('id', 'reopen', { hidden: false });
    }
    if (initial.events?.status === 200 && initial.events.value?.canSchedule && !initial.config?.singleRoom) {
      page.set('id', 'lobby-schedule', { hidden: false });
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
      if (lib.testVideo) {
        const other =
          '<article class="library-home-card library-other"><h3>Other</h3>' +
          '<button type="button" class="library-key" aria-label="Play synchronization video" title="Play synchronization video" data-action="play" data-play="demo">' +
          svgMarkup('play') +
          '<span>Synchronization video</span></button></article>';
        cards.push(other);
      }
      page.content('id', 'library-content', '<div class="library-landing">' + cards.join('') + '</div>');
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
      page
        .set('id', 'watch-body', { class: 'outside-room idle-player' })
        .set('id', 'auth-overlay', { hidden: true })
        .set('id', 'room-lobby', { hidden: false })
        .content('id', 'lobby-rooms', rows);
    } else if (initial.targetRoom?.name) {
      const roomName = escapeText(initial.targetRoom.name);
      const media = initial.targetRoom.media;
      page
        .set('id', 'auth-overlay', { hidden: true })
        .content('id', 'options-title', roomName)
        .set('id', 'current-room', { hidden: false })
        .set('id', 'switch-room', { 'aria-label': 'Switch room', title: 'Switch room' })
        .content('id', 'switch-room', '<span class="watch-control-label">Switch room</span>')
        .set('id', 'create', { hidden: true })
        .set('id', 'close-room', { hidden: false });
      if (media?.title) {
        page
          .set('id', 'watch-body', { class: '' })
          .set('id', 'empty-stage', { hidden: true })
          .content('id', 'title', escapeText(media.title))
          .content('id', 'details', escapeText(media.subtitle || ''))
          .set('class', 'queue-empty-title', { hidden: true })
          .set('class', 'queue-empty-text', { hidden: true });
      } else {
        page
          .set('id', 'watch-body', { class: 'idle-player' })
          .content('id', 'empty-title', roomName)
          .content('id', 'empty-hint', '');
      }
    }
  }
  const data = JSON.stringify(initial).replace(
    /[<>&\u2028\u2029]/g,
    char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'),
  );
  return page
    .before('src', '/watch.js', '<script id="watch-bootstrap" type="application/json">' + data + '</script>')
    .toString();
}

module.exports = { watchPage };
