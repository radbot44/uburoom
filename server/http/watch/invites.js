'use strict';
const { randomBytes } = require('node:crypto');
const { hash } = require('../../core');
const { displayName } = require('../../accounts');
const { clientAddress } = require('../../plex-delivery');
const Ubumfa = require('../../../web/ubumfa');
const Policy = require('../../room-policy');

/** Room invites: preview a room by code, join it, or enter it as a guest. */
function roomInvites({
  config,
  watch,
  hub,
  body,
  json,
  throttle,
  cookie,
  cookies,
  registry,
  accounts,
  logins,
  allowedOrigin,
  rawLogin,
  login,
}) {
  // Room invites. 'preview' names the room; 'join' lets the person in. Someone the
  // server already admits just goes to the room (and is remembered by a private
  // room). Anyone else enters as a guest when the room allows guests.
  async function joinInvite(req, res) {
    if (!allowedOrigin(req) || !throttle('invite:' + (clientAddress(req) || 'local'), 20))
      return json(res, 429, { error: 'Too many tries; wait a minute and try again' });
    const data = await body(req);
    if (!['preview', 'join'].includes(data.action)) return json(res, 400, { error: 'Unsupported invite action' });
    const record = watch.roomState.store.byInvite(data.code);
    if (!record)
      return json(res, 404, { error: 'No room has that invite code. Check it, or ask for the current link.' });
    const room = { id: record.id, name: record.name, slug: record.slug };
    const identity = await rawLogin(req);
    const signedIn = !!identity && !registry.isGuest(identity.userId);
    const device = cookies(req).uburoom_device,
      deviceHash = /^[a-f0-9]{64}$/.test(device || '') ? hash(device) : undefined;
    const subjects = [
      ...(identity ? ['user:' + identity.userId] : []),
      ...(deviceHash ? ['device:' + deviceHash] : []),
    ];
    if (watch.roomState.store.blocked(record.id, subjects))
      return json(res, 403, { error: 'You were removed from this room. Ask a host for a new invite.' });
    // Already in this room as a guest: nothing more to do.
    if (identity?.guestRoom === record.id && (identity.guestUntil ?? Infinity) > Date.now())
      return json(res, 200, { room, guest: true });
    const member = !!identity && !identity.guestRoom && !!(await login(req));
    const guestsAllowed = !!hub.guestsEnabled() && record.allowGuests;
    const signInRequired = !!config.guests?.requireSignIn;
    if (data.action === 'preview')
      return json(res, 200, {
        room,
        member,
        signedIn,
        name: signedIn ? registry.canonical(identity.userId)?.name : undefined,
        guestsAllowed,
        signInRequired,
        providers: {
          discord: config.accessPolicy?.discord !== false && !!config.clientId,
          plex: config.accessPolicy?.plex !== false,
        },
      });
    if (member) {
      if (record.visibility === 'private' && !Policy.admitted(record, identity.userId)) {
        const updated = await watch.roomState.store.invite(record.id, identity.userId);
        const live = watch.rooms.get(record.id);
        if (live) watch.roomState.apply(live, updated);
      }
      return json(res, 200, { room });
    }
    if (identity?.activity) return json(res, 403, { error: 'Your Discord account can’t join this server.' });
    if (!guestsAllowed)
      return json(res, 403, {
        error:
          'This room isn’t taking guests right now. Sign in with an account that can join this server, or ask a host to allow guests.',
      });
    if (!signedIn && signInRequired)
      return json(res, 403, { error: 'Sign in with Discord or Plex to join as a guest.' });
    const guests = hub.guestMembers(record.id);
    if (guests.size >= config.guests.maxPerRoom)
      return json(res, 429, { error: 'This room has as many guests as it allows. Try again when one leaves.' });
    const now = Date.now(),
      until = now + config.guests.sessionHours * 3600000;
    let name;
    if (!signedIn) {
      try {
        name = displayName(typeof data.name === 'string' && data.name.trim() ? data.name : Ubumfa.ubunym().fullName);
      } catch (error) {
        return json(res, 400, { error: error.message });
      }
      // Names are unverified, so a guest may not borrow the name of someone signed in here.
      const present = [...(watch.rooms.get(record.id)?.viewers.values() || [])].map(viewer => viewer.userId);
      if (
        present.some(
          userId =>
            !registry.isGuest(userId) &&
            registry.canonical(userId)?.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
        )
      )
        return json(res, 409, { error: 'Someone in this room already uses that name. Choose another.' });
    }
    // A browser marker lets a kick keep this browser out until the code changes.
    const cookiesOut = [];
    let browser = deviceHash;
    if (!browser) {
      const token = randomBytes(32).toString('hex');
      browser = hash(token);
      cookiesOut.push(cookie('uburoom_device', token, 31536000));
    }
    if (signedIn) {
      const login = logins.get(hash(cookies(req).uburoom || ''));
      if (!login || login.userId !== identity.userId)
        return json(res, 409, { error: 'Your sign-in changed; open the invite again' });
      login.guestRoom = record.id;
      login.guestUntil = until;
      login.device = browser;
    } else {
      const previous = cookies(req).uburoom;
      if (previous && identity) logins.delete(hash(previous));
      const id = randomBytes(32).toString('hex'),
        account = registry.canonical(registry.createGuest(name));
      logins.set(hash(id), {
        userId: account.id,
        accountRevision: account.revision,
        name: account.name,
        csrf: randomBytes(32).toString('hex'),
        expires: until,
        guestRoom: record.id,
        device: browser,
      });
      cookiesOut.push(cookie('uburoom', id, config.guests.sessionHours * 3600));
    }
    if (cookiesOut.length) res.setHeader('Set-Cookie', cookiesOut);
    registry.audit(identity?.userId || 'guest', 'room-guest-join', { roomId: record.id, signedIn });
    await accounts.save();
    json(res, 200, { room, guest: true });
  }
  return { joinInvite };
}
module.exports = { roomInvites };
