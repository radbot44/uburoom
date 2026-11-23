'use strict';
const { randomBytes, randomUUID } = require('node:crypto');
const { UUID, hash } = require('./core');
const { PlaybackError } = require('./errors');
const { Handoff, SECRET } = require('./handoff');
const { watchOperations } = require('./watch-operations');
const { CALLS } = require('../shared/wire-protocol.mjs');
const { clientAddress } = require('./client-address');
const { isAllowedBrowserOrigin, unconfiguredOriginMessage } = require('./origins');
const { COOKIES: DEFAULT_COOKIES } = require('./http/sessions');
const { displayName } = require('./accounts');
const Ubumfa = require('../shared/ubumfa.mjs');
const { watchIdentity } = require('./http/watch/identity');
const { mediaGrants } = require('./http/watch/grants');
const { mediaStream } = require('./http/watch/stream');
const { roomInvites } = require('./http/watch/invites');
const { pageBootstrap } = require('./http/watch/bootstrap');

function watchHttp({
  config,
  watch,
  hub,
  user,
  webActor,
  body,
  json,
  oauthFetch,
  throttle,
  browserLogin,
  cookies,
  discordIdentity = value => value,
  validIdentity = () => true,
  registry,
  entryPolicy,
  diagnosticLog,
  COOKIES = DEFAULT_COOKIES,
  cookie,
  replaceBrowserSession,
  accounts,
  logins,
  loginSeconds,
  plexAuth,
}) {
  const identity = watchIdentity({ config, hub, user, webActor, entryPolicy, validIdentity });
  const { identities, issue, rawLogin, login, authorized, allowedOrigin, activityOrigin } = identity;
  const {
    grants,
    validGrant,
    validCaptionGrant,
    renewGrants,
    mediaGrant,
    captionGrant,
    cleanupViewerGrants,
    revokeGrant,
    revokeWhere,
  } = mediaGrants({ watch, cookies, login });
  watch.onViewerRemoved = viewerId => cleanupViewerGrants(viewerId);
  watch.onRoomMediaDropped = room => revokeWhere(grant => grant.room === room);
  const { stream, rewriteManifest } = mediaStream({ config, watch, json, grants, validCaptionGrant, validGrant });
  const invites = roomInvites({
    config,
    watch,
    hub,
    body,
    json,
    throttle,
    COOKIES,
    cookie,
    cookies,
    replaceBrowserSession,
    registry,
    accounts,
    logins,
    allowedOrigin,
    rawLogin,
    login,
    entryPolicy,
  });
  const clockEpoch = randomUUID();
  const handoff = new Handoff();
  // The reads a page may make by GET before it has a room connection (shared/wire-protocol.mjs).
  const READS = Object.fromEntries([
    ...Object.entries(CALLS)
      .filter(([, call]) => call.http)
      .map(([op, call]) => [call.http, op]),
    ['/api/watch/library/art', 'library.art'],
  ]);
  const operations = watchOperations({
    config,
    watch,
    hub,
    authorized,
    login,
    mediaGrant,
    captionGrant,
    cookies,
    throttle,
    registry,
    clockEpoch,
    validGrant: id => validGrant(grants.get(id)),
  });
  const page = pageBootstrap({
    config,
    watch,
    hub,
    registry,
    entryPolicy,
    diagnosticLog,
    rawLogin,
    login,
    webActor,
    operations,
  });
  const { publicConfig, admissionStatus, bootstrap } = page;
  async function route(req, res, url) {
    if (!url.pathname.startsWith('/api/watch/')) return false;
    const sharedPoster = /^\/api\/watch\/shared-poster\/([a-f0-9-]{36})\/([a-f0-9]{48})$/.exec(url.pathname);
    if (sharedPoster && req.method === 'GET') {
      const art = watch.publications.posterResource(sharedPoster[1], sharedPoster[2]);
      if (!art) {
        json(res, 404, { error: 'Poster unavailable' });
        return true;
      }
      res.writeHead(200, {
        'Content-Type': art.type,
        'Content-Length': art.bytes.length,
        'Cache-Control': 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(art.bytes);
      return true;
    }
    if (config.accessPolicy && url.pathname === '/api/watch/entry' && req.method === 'POST') {
      if (!allowedOrigin(req)) {
        const unconfigured = unconfiguredOriginMessage(config, req);
        if (unconfigured) {
          json(res, 403, { error: unconfigured });
          return true;
        }
        json(res, 429, { error: 'Entry is unavailable; wait a minute and try again' });
        return true;
      }
      if (!throttle('entry:' + (clientAddress(req, config) || 'local'), 10)) {
        json(res, 429, { error: 'Entry is unavailable; wait a minute and try again' });
        return true;
      }
      const data = await body(req);
      if (!config.accessPolicy.publicWeb) {
        json(res, 403, { error: 'Open uburoom through Discord Activity' });
        return true;
      }
      // The server password is its own way in (access.password): whoever knows it enters as a
      // server-wide guest with the name they choose, never an account. Wrong guesses share the
      // per-address limit above.
      if (!config.accessPolicy.password || !entryPolicy.password.matches(data.password)) {
        json(res, 403, { error: 'Incorrect server password' });
        return true;
      }
      const typed = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : '';
      // The same browser keeps its guest, and its name, across visits and password changes.
      const token = cookies(req)[COOKIES.session],
        previous = token && logins.get(hash(token));
      if (previous && registry.isGuest(previous.userId) && !previous.guestRoom) {
        if (typed && typed !== previous.name)
          try {
            if (hub.renameAccount) {
              await hub.renameAccount(previous.userId, typed);
              previous.name = registry.canonical(previous.userId).name;
            } else {
              const nextName = displayName(typed);
              if (
                [...watch.rooms.values()].some(room =>
                  [...room.viewers.values()].some(
                    viewer =>
                      !registry.isGuest(viewer.userId) &&
                      viewer.name?.toLocaleLowerCase() === nextName.toLocaleLowerCase(),
                  ),
                )
              )
                throw Object.assign(new Error('Someone in this room already uses that name. Choose another.'), {
                  status: 409,
                });
              registry.rename(previous.userId, nextName);
              previous.name = registry.canonical(previous.userId).name;
            }
          } catch (error) {
            json(res, error.status || 400, { error: error.message });
            return true;
          }
        previous.serverPassword = entryPolicy.password.revision;
        previous.accountRevision = registry.canonical(previous.userId).revision;
        accounts.save();
        json(res, 200, { ok: true, name: previous.name });
        return true;
      }
      // Entering replaces any other sign-in in this browser: a password guest is not an account.
      let account;
      try {
        const name = typed ? displayName(typed) : Ubumfa.ubunym().fullName;
        if (
          typed &&
          [...watch.rooms.values()].some(room =>
            [...room.viewers.values()].some(
              viewer =>
                !registry.isGuest(viewer.userId) && viewer.name?.toLocaleLowerCase() === name.toLocaleLowerCase(),
            ),
          )
        ) {
          json(res, 409, { error: 'Someone in this room already uses that name. Choose another.' });
          return true;
        }
        account = registry.canonical(registry.createGuest(name));
      } catch (error) {
        json(res, 400, { error: error.message });
        return true;
      }
      const loginRecord = {
        userId: account.id,
        accountRevision: account.revision,
        name: account.name,
        csrf: randomBytes(32).toString('hex'),
        expires: null,
        serverPassword: entryPolicy.password.revision,
      };
      if (replaceBrowserSession) {
        await replaceBrowserSession(req, res, loginRecord, { maxAge: loginSeconds });
      } else {
        if (previous) logins.delete(hash(token));
        const id = randomBytes(32).toString('hex');
        logins.set(hash(id), loginRecord);
        accounts.save();
        res.setHeader('Set-Cookie', cookie(COOKIES.session, id, loginSeconds));
      }
      json(res, 200, { ok: true, name: account.name });
      return true;
    }
    if (url.pathname === '/api/watch/invite' && req.method === 'POST') {
      await invites.joinInvite(req, res);
      return true;
    }
    if (config.accessPolicy && url.pathname === '/api/watch/admission' && req.method === 'GET') {
      json(res, 200, await admissionStatus(req));
      return true;
    }
    if (['GET', 'HEAD'].includes(req.method) && url.pathname.startsWith('/api/watch/media/')) {
      const match =
        /^\/api\/watch\/media\/([a-f0-9]{48})\/(start|chunk-(?:video|audio)-\d{1,9}|captions-[a-f0-9-]{36}|subtitle-[a-f0-9-]{36}(?:\/(?:data|index|window|font-\d{1,2}))?|[a-f0-9]{24})$/.exec(
          url.pathname,
        );
      if (!match) {
        json(res, 404, { error: 'Media unavailable' });
        return true;
      }
      await stream(req, res, grants.get(match[1]), match[2], url);
      return true;
    }
    if (!throttle('watch:' + (clientAddress(req, config) || 'local'), 600)) {
      json(res, 429, { error: 'Too many requests' });
      return true;
    }
    try {
      if (req.method === 'POST' && url.pathname === '/api/watch/handoff/native/start') {
        if (!throttle('handoff-native-start:' + (clientAddress(req, config) || 'local'), 30)) {
          json(res, 429, { error: 'Too many requests' });
          return true;
        }
        const attempt = handoff.issueNative();
        json(res, 200, {
          id: attempt.id,
          code: attempt.code,
          proof: attempt.proof,
          verification: attempt.verification,
          expires: attempt.expires,
          url: config.publicUrl + '/auth/native#' + attempt.code,
        });
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/watch/handoff/native/claim') {
        if (!isAllowedBrowserOrigin(config, req.headers.origin, req) || req.headers.authorization) {
          json(res, 403, { error: 'Forbidden' });
          return true;
        }
        const identity = await login(req);
        if (!identity) {
          json(res, 401, { error: 'Sign in to approve native client', loginUrl: '/auth/discord' });
          return true;
        }
        if (identity.guestRoom || registry.isGuest(identity.userId)) {
          json(res, 403, { error: 'Guests cannot authorize native clients' });
          return true;
        }
        const data = await body(req);
        const attempt = handoff.claimNative(data.code, identity);
        if (!attempt) {
          json(res, 410, { error: 'Authorization request expired or was already claimed' });
          return true;
        }
        json(res, 200, {
          id: attempt.id,
          name: identity.name,
          userId: identity.userId,
          verification: attempt.verification,
          csrf: identity.csrf,
        });
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/watch/handoff/native/approve') {
        if (!isAllowedBrowserOrigin(config, req.headers.origin, req) || req.headers.authorization) {
          json(res, 403, { error: 'Forbidden' });
          return true;
        }
        const identity = await login(req);
        if (!identity) {
          json(res, 401, { error: 'Sign in to approve native client' });
          return true;
        }
        if (identity.guestRoom || registry.isGuest(identity.userId)) {
          json(res, 403, { error: 'Guests cannot authorize native clients' });
          return true;
        }
        const data = await body(req);
        if (typeof data.csrf !== 'string' || data.csrf !== identity.csrf) {
          json(res, 403, { error: 'Invalid CSRF token' });
          return true;
        }
        const attempt = handoff.get(data.id);
        if (
          !attempt ||
          !attempt.native ||
          attempt.state !== 'claimed' ||
          attempt.claimedActor?.userId !== identity.userId
        ) {
          json(res, 403, { error: 'Authorization request unavailable or user mismatch' });
          return true;
        }
        const issued = issue(
          {
            userId: identity.userId,
            name: identity.name,
            accountRevision: identity.accountRevision,
            activity: false,
            native: true,
          },
          7 * 86400000,
        );
        if (
          !handoff.approveNative(attempt, {
            token: issued.token,
            expiresAt: issued.expiresAt,
            userId: identity.userId,
            name: identity.name,
          })
        ) {
          json(res, 410, { error: 'Authorization request expired or already completed' });
          return true;
        }
        json(res, 200, { ok: true });
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/watch/handoff/native/poll') {
        if (!throttle('handoff-native-poll:' + (clientAddress(req, config) || 'local'), 180)) {
          json(res, 429, { error: 'Too many requests' });
          return true;
        }
        const data = await body(req);
        const attempt = handoff.pollNative(data.id, data.proof);
        if (!attempt) {
          json(res, 410, { error: 'Authorization request expired or invalid proof' });
          return true;
        }
        if (attempt.state !== 'approved') {
          json(res, 202, { pending: true });
          return true;
        }
        handoff.remove(attempt);
        json(res, 200, {
          token: attempt.token,
          expiresAt: attempt.expiresAt,
          userId: attempt.userId,
          name: attempt.name,
        });
        return true;
      }
      if (req.method === 'POST' && ['/api/watch/handoff/claim', '/api/watch/handoff/redeem'].includes(url.pathname)) {
        // These browser endpoints never accept an Activity bearer or a cross-origin request.
        const nonce = cookies(req)[COOKIES.handoff];
        if (
          req.headers.origin !== config.publicUrl ||
          req.headers.authorization ||
          !SECRET.test(nonce || '') ||
          !throttle('handoff-browser:' + (clientAddress(req, config) || 'local'), 120)
        ) {
          json(res, 403, { error: 'Browser sign-in unavailable; open a fresh link from the Activity' });
          return true;
        }
        const data = await body(req);
        const attempt = url.pathname.endsWith('/claim')
          ? handoff.claim(data.code, data.proof, nonce)
          : handoff.browser(data.id, data.proof, nonce);
        if (!attempt || attempt.redeeming || !['claimed', 'approved'].includes(attempt.state)) {
          json(res, 410, { error: 'Browser sign-in expired or was already used; open a fresh link from the Activity' });
          return true;
        }
        const alive = async () =>
          (attempt.linkOnly
            ? await rawLogin({ headers: { authorization: attempt.authorization } })
            : await login({ headers: { authorization: attempt.authorization } })) === attempt.source;
        if (!(await alive()) || handoff.get(attempt.id) !== attempt) {
          handoff.remove(attempt);
          json(res, 403, { error: 'Activity sign-in is no longer available' });
          return true;
        }
        const existing = await user(req);
        if (url.pathname.endsWith('/claim')) {
          json(res, 200, {
            id: attempt.id,
            name: attempt.source.name,
            verification: attempt.verification,
            expires: attempt.expires,
            switchRequired: !!existing && existing.userId !== attempt.source.userId,
            existingName: existing?.name,
          });
          return true;
        }
        if (attempt.state !== 'approved') {
          json(res, 202, { pending: true });
          return true;
        }
        if (existing && existing.userId !== attempt.source.userId && data.switchAccount !== true) {
          json(res, 409, { error: 'Confirm switching this browser to the Activity account', switchRequired: true });
          return true;
        }
        attempt.redeeming = true;
        try {
          const room = watch.rooms.get(attempt.roomId);
          const roomId = (await watch.canView(room, webActor(attempt.source))) ? room.roomId : undefined;
          if (!(await alive()) || !handoff.consume(attempt)) {
            json(res, 410, { error: 'Activity sign-in expired or was cancelled' });
            return true;
          }
          if (existing?.userId !== attempt.source.userId || existing?.guestRoom)
            await browserLogin(req, res, attempt.source);
          else res.setHeader('Set-Cookie', cookie(COOKIES.handoff, '', 0));
          const target = roomId ? (room?.slug ? '/room/' + room.slug : '/room/' + roomId) : '/';
          json(res, 200, {
            destination: attempt.connectPlex
              ? '/auth/plex' + (roomId ? '?return=' + encodeURIComponent(target) : '')
              : attempt.linkOnly
                ? '/?account=1'
                : target,
          });
          return true;
        } finally {
          attempt.redeeming = false;
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/watch/config') {
        json(res, 200, publicConfig());
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/watch/demo-login') {
        if (
          !config.demo ||
          !allowedOrigin(req) ||
          !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
        ) {
          json(res, 403, { error: 'Demo login is disabled' });
          return true;
        }
        const data = await body(req);
        if (!['host', 'guest', 'guest2'].includes(data.persona)) throw new Error('Choose a demo identity');
        const identity = discordIdentity({
          userId:
            config.demoSubjects?.[data.persona] ||
            (data.persona === 'host' ? config.ownerId : data.persona === 'guest2' ? 'demo-guest2' : 'demo-guest'),
          name: data.persona === 'host' ? 'Demo host' : data.persona === 'guest2' ? 'Demo guest 2' : 'Demo guest',
          activity: data.activity === true,
        });
        json(res, 200, { ...issue(identity), name: identity.name, owner: hub.isOwner(webActor(identity)) });
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/watch/activity-login') {
        if (!activityOrigin || req.headers.origin !== activityOrigin || !config.clientSecret) {
          json(res, 403, { error: 'Activity authentication unavailable' });
          return true;
        }
        const data = await body(req);
        if (typeof data.code !== 'string' || !data.code || data.code.length > 512)
          throw new Error('Invalid login code');
        if (typeof data.instanceId !== 'string' || !/^[\w-]{1,200}$/.test(data.instanceId)) {
          json(res, 403, { error: 'Discord Activity instance unavailable' });
          return true;
        }
        const response = await oauthFetch('https://discord.com/api/oauth2/token', {
          method: 'POST',
          signal: AbortSignal.timeout(10000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            grant_type: 'authorization_code',
            code: data.code,
          }),
        });
        if (!response.ok) throw new Error('Discord rejected the login');
        const tokens = await response.json();
        const profile = await oauthFetch('https://discord.com/api/users/@me', {
          signal: AbortSignal.timeout(10000),
          headers: { Authorization: 'Bearer ' + tokens.access_token },
        });
        if (!profile.ok) throw new Error('Discord identity unavailable');
        const identity = await profile.json();
        const instance = await oauthFetch(
          `https://discord.com/api/v10/applications/${config.clientId}/activity-instances/${data.instanceId}`,
          {
            signal: AbortSignal.timeout(5000),
            redirect: 'error',
            headers: { Authorization: 'Bot ' + config.botToken },
          },
        );
        const details = instance.ok ? await instance.json() : null;
        const location = details?.location;
        // The instance location and occupants come from Discord. The bot also checks
        // current membership and voice state in precisely that eligible guild.
        if (
          config.accessPolicy?.discord === false ||
          details?.application_id !== config.clientId ||
          details?.instance_id !== data.instanceId ||
          !Array.isArray(details?.users) ||
          !details.users.includes(identity.id) ||
          location?.kind !== 'gc' ||
          !location.guild_id ||
          !location.channel_id ||
          !(await hub.access.raw()?.activityVoice?.(identity.id, location.guild_id, location.channel_id))
        ) {
          json(res, 403, { error: 'Join a voice channel in a Discord server that allows entry first' });
          return true;
        }
        const login = discordIdentity({
          userId: identity.id,
          name: EngineName(identity.global_name || identity.username),
          activity: true,
          activityLocation: { subject: identity.id, guildId: location.guild_id, channelId: location.channel_id },
        });
        json(res, 200, {
          ...issue(login),
          accessToken: tokens.access_token,
          name: login.name,
          owner: hub.isOwner(webActor(login)),
        });
        return true;
      }
      const readable = req.method === 'GET' && READS[url.pathname];
      if (readable) {
        const reply = await operations.call(
          { headers: req.headers, remoteAddress: clientAddress(req, config) },
          readable,
          {
            args: Object.fromEntries(url.searchParams),
          },
        );
        if (reply.resource) {
          const art = reply.resource;
          res.writeHead(reply.status, {
            'Content-Type': art.type,
            'Content-Length': art.bytes.length,
            'Cache-Control': 'private, no-store',
          });
          res.end(art.bytes);
        } else json(res, reply.status, reply.value);
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/watch/diagnostics') {
        // Player diagnostics are not room controls: a plain upload that never touches room state.
        const auth = await authorized(req, true);
        if (!auth || !diagnosticLog) {
          json(res, auth ? 404 : 401, { error: auth ? 'Diagnostics are off on this server' : 'Sign in again' });
          return true;
        }
        if (!throttle('diagnostics:' + auth.actor.userId, 12)) {
          json(res, 429, { error: 'Too many diagnostics uploads' });
          return true;
        }
        const data = await body(req, 256 * 1024),
          room = watch.rooms.get(data.roomId),
          viewer = room?.viewers.get(data.viewerId);
        if (
          !UUID.test(data.viewerId || '') ||
          !UUID.test(data.stream || '') ||
          !Array.isArray(data.rows) ||
          data.rows.length > 2000
        )
          throw new Error('Invalid diagnostics');
        // A final upload can arrive just after the viewer left, so the room is enough then.
        if (!room || (viewer && viewer.userId !== auth.actor.userId) || !(await watch.canView(room, auth.actor))) {
          json(res, 403, { error: 'Room unavailable' });
          return true;
        }
        const kept = diagnosticLog.viewer({
          room,
          viewerId: data.viewerId,
          name: auth.actor.name || auth.actor.userId,
          title: room.media?.title,
          stream: data.stream,
          rows: data.rows,
        });
        json(res, 200, { kept });
        return true;
      }
      if (!['/api/watch/handoff', '/api/watch/handoff/status', '/api/watch/handoff/action'].includes(url.pathname)) {
        json(res, 404, { error: 'Room controls require an authenticated WebSocket' });
        return true;
      }
      let auth = await authorized(req, req.method !== 'GET');
      if (!auth && config.accessPolicy && allowedOrigin(req) && req.headers.authorization) {
        const identity = await rawLogin(req);
        if (identity?.activity) auth = { identity, actor: webActor(identity), pending: true };
      }
      if (!auth) {
        json(res, 401, { error: 'Log in with Discord' });
        return true;
      }
      if (url.pathname === '/api/watch/handoff' && req.method === 'POST') {
        if (
          !auth.identity.activity ||
          !req.headers.authorization ||
          !throttle('handoff-issue:' + auth.actor.userId, 6)
        ) {
          json(res, 403, { error: 'Open in Browser requires an authenticated Activity' });
          return true;
        }
        const data = await body(req),
          room = watch.rooms.get(data.roomId);
        if (data.roomId !== undefined && (!UUID.test(data.roomId) || !(await watch.canView(room, auth.actor)))) {
          json(res, 403, { error: 'Room unavailable or private' });
          return true;
        }
        const issued = handoff.issue(auth.identity, data.roomId);
        handoff.get(issued.id).authorization = req.headers.authorization;
        handoff.get(issued.id).linkOnly = Boolean(
          auth.pending || config.accessPolicy?.publicWeb === false || data.account,
        );
        handoff.get(issued.id).connectPlex = Boolean(
          data.connectPlex && watch.providers.configured && (!!config.accessPolicy?.plex || !!plexAuth?.configured),
        );
        json(res, 200, {
          id: issued.id,
          expires: issued.expires,
          url: config.publicUrl + '/auth/handoff#' + issued.code,
        });
        return true;
      }
      if (url.pathname === '/api/watch/handoff/status' && req.method === 'POST') {
        const data = await body(req),
          attempt = handoff.get(data.id);
        if (!attempt || attempt.source !== auth.identity) {
          json(res, 410, { error: 'Browser sign-in expired or was cancelled' });
          return true;
        }
        json(res, 200, { state: attempt.state, verification: attempt.verification });
        return true;
      }
      if (url.pathname === '/api/watch/handoff/action' && req.method === 'POST') {
        const data = await body(req),
          attempt = handoff.get(data.id);
        if (!attempt || attempt.source !== auth.identity) {
          json(res, 410, { error: 'Browser sign-in expired or was cancelled' });
          return true;
        }
        if (data.action === 'cancel') handoff.remove(attempt);
        else if (data.action !== 'approve' || !handoff.approve(attempt, data.verification)) {
          json(res, 409, { error: 'Wait for the browser and check its code before approving' });
          return true;
        }
        json(res, 200, { ok: true });
        return true;
      }
      json(res, 404, { error: 'Room controls require an authenticated WebSocket' });
      return true;
    } catch (error) {
      if (!(error instanceof PlaybackError))
        hub.logger?.warn('Request', 'Request failed: ' + (error?.message || String(error)));
      json(res, 400, {
        error:
          error instanceof PlaybackError
            ? error.message
            : 'Request failed; check the server configuration and try again',
      });
      return true;
    }
  }
  const EngineName = value => require('../shared/engine.mjs').senderName(value);
  function sweep() {
    entryPolicy?.sweep();
    handoff.sweep();
    const now = Date.now();
    for (const [token, value] of identities) if (value.expires <= now) identities.delete(token);
    for (const [id, grant] of [...grants]) {
      const viewer = grant.room.viewers.get(grant.viewerId);
      if (
        grant.expires <= now ||
        watch.rooms.get(grant.room.roomId) !== grant.room ||
        grant.version !== grant.room.mediaVersion ||
        !viewer ||
        (!grant.caption && grant.streamVersion !== viewer.streamVersion)
      ) {
        revokeGrant(id);
        continue;
      }
      if (!grant.checking) {
        grant.checking = true;
        void (grant.caption ? validCaptionGrant(grant, grant.captionVersion) : validGrant(grant))
          .then(
            ok => {
              if (!ok) revokeGrant(id);
            },
            () => revokeGrant(id),
          )
          .finally(() => {
            grant.checking = false;
          });
      }
    }
  }
  async function logout(loginHash) {
    revokeWhere(
      grant => grant.credential && !grant.credential.startsWith('Bearer ') && hash(grant.credential) === loginHash,
    );
    for (const room of [...watch.rooms.values()])
      for (const [id, viewer] of [...room.viewers])
        if (viewer.browserLoginHash === loginHash) {
          cleanupViewerGrants(id);
          viewer.watchSocket?.close(4003, 'Sign in again');
          await watch.leave(room, viewer.actor, id, 'logout');
        }
    for (const room of [...watch.rooms.values()])
      for (const [id, viewer] of [...room.disconnectedViewers])
        if (viewer.browserLoginHash === loginHash) {
          cleanupViewerGrants(id);
          await watch.leave(room, { userId: viewer.userId }, id, 'logout');
        }
  }
  async function invalidate(ids) {
    for (const [token, identity] of identities) if (ids.includes(identity.userId)) identities.delete(token);
    revokeWhere(grant => ids.includes(grant.actor.userId));
    for (const room of [...watch.rooms.values()])
      for (const [id, viewer] of [...room.viewers])
        if (ids.includes(viewer.userId)) {
          cleanupViewerGrants(id);
          viewer.watchSocket?.close(4003, 'Sign in again');
          await watch.leave(room, viewer.actor, id, 'account-changed');
        }
    for (const room of [...watch.rooms.values()])
      for (const [id, viewer] of [...room.disconnectedViewers])
        if (ids.includes(viewer.userId)) {
          cleanupViewerGrants(id);
          await watch.leave(room, { userId: viewer.userId }, id, 'account-changed');
        }
  }
  return {
    renewGrants,
    route,
    bootstrap,
    operations,
    sweep,
    logout,
    invalidate,
    authorized,
    clockEpoch,
    close: () => {
      identities.clear();
      revokeWhere(() => true);
      grants.clear();
      handoff.close();
    },
    rewriteManifest,
    deliveryOrigins: req =>
      watch.providers.directOrigins(typeof req === 'string' || req === undefined ? req : clientAddress(req, config)),
    embedPolicy: () => watch.providers.embedPolicy(),
  };
}
module.exports = { watchHttp };
