'use strict';

const escapeText = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

// Personalized HTML is sent with no-store. JSON remains inert, and every value
// used in the initial visible room rows is escaped independently of that JSON.
function watchPage(template, initial) {
  let html = template;
  if (initial.me?.status === 200 && initial.rooms?.status === 200) {
    const rows = initial.rooms.value.rooms.map(room => {
      const info = (room.title || 'No video selected') + ' · ' + room.viewers + (room.viewers === 1 ? ' viewer' : ' viewers');
      const action = room.locked ? '<button class="quiet" disabled>Join</button>' : '<a class="quiet" href="/watch?room=' + encodeURIComponent(room.id) + '">Join</a>';
      return '<div class="saved-room"><div><strong>' + escapeText(room.name || room.hostName) + '</strong><p class="hint">' + escapeText(info) + '</p></div><div class="room-actions">' + action + '</div></div>';
    }).join('');
    html = html.replace('class="auth-pending outside-room idle-player"', 'class="outside-room idle-player"')
      .replace('id="auth-overlay" class="lobby-auth"', 'id="auth-overlay" class="lobby-auth" hidden')
      .replace('id="room-lobby" hidden', 'id="room-lobby"')
      .replace('<div id="lobby-rooms" class="lobby-rooms" aria-label="Active rooms"></div>', '<div id="lobby-rooms" class="lobby-rooms" aria-label="Active rooms">' + rows + '</div>');
    if(initial.me.value.durableRooms)html=html.replace('id="lobby-reopen" class="quiet" hidden','id="lobby-reopen" class="quiet"');
  }
  const data = JSON.stringify(initial).replace(/[<>&\u2028\u2029]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
  return html.replace('<script src="/watch.js">', '<script id="watch-bootstrap" type="application/json">' + data + '</script><script src="/watch.js">');
}

module.exports = { watchPage };
