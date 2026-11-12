'use strict';
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { randomBytes, randomUUID } = require('node:crypto');
const { UUID, hash } = require('./core');
const { PlaybackError, CHUNK, AUDIO_LEAD, AUDIO_MIME } = require('./av1');
const { Handoff, SECRET } = require('./handoff');
const Playback = require('../web/playback-policy');
const Subtitles = require('./subtitles');
const SubtitleResources = require('./subtitle-resources');
const { watchOperations } = require('./watch-operations');
const { PlexDelivery, clientAddress } = require('./plex-delivery');
const { displayName } = require('./accounts');
const Ubumfa = require('../web/ubumfa');
const Policy = require('./room-policy');

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
  cookie,
  accounts,
  logins,
  plexAuth,
}) {
  const identities = new Map(),
    grants = new Map();
  const delivery = new PlexDelivery(config, watch.plex, plexAuth, hub.plexFor?.bind(hub));
  watch.delivery = delivery;
  const clockEpoch = randomUUID();
  const publicConfig = () => ({
    watchVersion: 19,
    keepDiagnostics: diagnosticLog ? config.diagnostics.keepDays : 0,
    unifiedAccounts: !!registry,
    accountDemo: !!config.demo && !!config.unifiedAccounts,
    watchUrl: config.publicUrl,
    clientId: config.clientId,
    demo: !!config.demo,
    plexConfigured: watch.plex.configured,
    testVideo: !!watch.demoMedia,
    access: entryPolicy?.public(),
    guests: !!hub.guestsEnabled?.(),
    singleRoom: !!config.singleRoom,
    localFormats:
      config.transcoding && (!config.transcoding.uburoom || config.transcoding.policy === 'disabled')
        ? []
        : config.transcoding?.formats || ['av1'],
    outputs: config.transcoding?.policy === 'disabled' ? [] : config.transcoding?.outputs,
  });
  const handoff = new Handoff();
  const activityOrigin = /^\d{17,20}$/.test(config.clientId || '')
    ? `https://${config.clientId}.discordsays.com`
    : undefined;
  const allowedOrigin = req =>
    req.headers.origin === config.publicUrl || (activityOrigin && req.headers.origin === activityOrigin);
  if (config.demo && (!['localhost', '127.0.0.1'].includes(new URL(config.publicUrl).hostname) || config.botToken))
    throw new Error('Demo identities are restricted to an isolated localhost server without a bot token');
  function issue(login, customLifetime) {
    const token = randomBytes(32).toString('hex');
    const lifetime =
      customLifetime ||
      (config.demo && Number.isSafeInteger(config.demoIdentityMs) && config.demoIdentityMs >= 10000
        ? config.demoIdentityMs
        : 3600000);
    login.expires = Date.now() + lifetime;
    login.viewerId = randomUUID();
    identities.set(token, login);
    return { token, expiresAt: login.expires };
  }
  async function rawLogin(req) {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
    const identity = req.headers.authorization ? token && identities.get(token) : await user(req);
    if (!identity || !validIdentity(identity) || (identity.expires != null && identity.expires <= Date.now())) return;
    if (token && identity.expires != null) identity.expires = Math.max(identity.expires, Date.now() + 3600000);
    return identity;
  }
  async function login(req) {
    const identity = await rawLogin(req);
    if (!identity) return;
    if (config.accessPolicy) {
      if (!config.accessPolicy.publicWeb && !identity.activity) return;
      if (!entryPolicy.password(req, identity)) return;
      entryPolicy.entered(identity.userId);
      if (!(await entryPolicy.admit(identity.userId, identity))) return;
    } else if (
      !(hub.access?.canWatch ? hub.access.canWatch(identity.userId) : hub.access?.isMember(identity.userId)) &&
      !(await (hub.access?.refreshWatch || hub.access?.refresh)?.(identity.userId))
    )
      return;
    const current = await rawLogin(req);
    return current?.userId === identity.userId && current?.accountRevision === identity.accountRevision
      ? current
      : undefined;
  }
  async function authorized(req, write = false) {
    const identity = await login(req);
    if (
      !identity ||
      (req.controlSocket && req.controlSocket.readyState !== 1) ||
      (write && (!allowedOrigin(req) || (!req.headers.authorization && req.headers['x-csrf-token'] !== identity.csrf)))
    )
      return;
    return { identity, actor: webActor(identity) };
  }
  async function validGrant(grant) {
    return (
      grant &&
      grant.expires > Date.now() &&
      (await grant.alive()) &&
      watch.rooms.get(grant.room.roomId) === grant.room &&
      grant.version === grant.room.mediaVersion &&
      (grant.fallback
        ? watch.fallbackFor(grant.room, grant.room.viewers.get(grant.viewerId) || {}) === grant.media
        : grant.room.viewers.get(grant.viewerId)?.media === grant.media) &&
      grant.streamVersion === grant.room.viewers.get(grant.viewerId)?.streamVersion &&
      (await watch.canView(grant.room, grant.actor))
    );
  }
  async function validCaptionGrant(grant, captionVersion) {
    const viewer = grant && grant.room.viewers.get(grant.viewerId);
    return (
      grant &&
      grant.expires > Date.now() &&
      (await grant.alive()) &&
      watch.rooms.get(grant.room.roomId) === grant.room &&
      grant.version === grant.room.mediaVersion &&
      viewer?.media?.captionVersion === captionVersion &&
      (await watch.canView(grant.room, grant.actor))
    );
  }
  function mediaGrant(room, auth, req, viewerId, fallback = false) {
    const viewer = room.viewers.get(viewerId);
    const media = fallback ? watch.fallbackFor(room, viewer || {}) : viewer?.media;
    if (!media || media.playbackError) return;
    const credential = req.headers.authorization || cookies(req).uburoom;
    for (const g of grants.values()) {
      if (
        g.room === room &&
        g.viewerId === viewerId &&
        g.actor.userId === auth.actor.userId &&
        g.version === room.mediaVersion &&
        g.media?.captionVersion &&
        g.media.captionVersion === viewer.media.captionVersion &&
        (g.credential === credential || Boolean(req.headers.authorization) === Boolean(g.headers?.authorization))
      ) {
        g.credential = credential;
        g.headers = { cookie: req.headers.cookie, authorization: req.headers.authorization };
        g.expires = Date.now() + 15000;
      }
    }
    const existing = [...grants.values()].find(
      g =>
        g.room === room &&
        g.viewerId === viewerId &&
        g.actor.userId === auth.actor.userId &&
        g.version === room.mediaVersion &&
        g.streamVersion === viewer.streamVersion &&
        g.media === media &&
        !!g.fallback === fallback,
    );
    if (
      existing &&
      (existing.credential === credential ||
        Boolean(req.headers.authorization) === Boolean(existing.headers?.authorization))
    ) {
      existing.credential = credential;
      existing.headers = { cookie: req.headers.cookie, authorization: req.headers.authorization };
      existing.expires = Date.now() + 15000;
      return existing.id;
    }
    if (existing) grants.delete(existing.id);
    const id = randomBytes(24).toString('hex');
    const grant = {
      id,
      room,
      media,
      fallback,
      streamVersion: viewer.streamVersion,
      actor: auth.actor,
      viewerId,
      version: room.mediaVersion,
      credential,
      headers: { cookie: req.headers.cookie, authorization: req.headers.authorization },
      expires: Date.now() + 15000,
      alive: async () =>
        (await login({ headers: req.controlSocket?.watchHeaders || grant.headers }))?.userId === auth.actor.userId,
    };
    grants.set(id, grant);
    return id;
  }
  function resource(media, url) {
    const target = watch.plex.url(url).href;
    for (const [key, value] of media.resources) if (value === target) return key;
    if (media.resources.size > 20000) throw new Error('Too many media resources');
    const key = randomBytes(12).toString('hex');
    media.resources.set(key, target);
    return key;
  }
  function rewriteManifest(text, upstream, media, grantId) {
    const resolve = value => {
      if (media.directHls) {
        const source = watch.plex.url(new URL(value, upstream).href);
        const target = new URL(source.pathname + source.search, media.directHls.origin);
        return Playback.directHlsUrl(target.href, { ...media.directHls, session: media.transcodeId });
      }
      return `/api/watch/media/${grantId}/${resource(media, new URL(value, upstream).href)}`;
    };
    return text
      .split(/\r?\n/)
      .map(line =>
        !line.trim()
          ? line
          : line.startsWith('#')
            ? line.replace(/URI="([^"\r\n]+)"/g, (_, value) => `URI="${resolve(value)}"`)
            : resolve(line.trim()),
      )
      .join('\n');
  }
  async function stream(req, res, grant, key, url) {
    if (key.startsWith('subtitle-')) {
      const match = /^subtitle-([a-f0-9-]{36})(?:\/(data|index|window|font-\d{1,2}))?$/.exec(key);
      if (!match || !(await validCaptionGrant(grant, match[1])))
        return json(res, 403, { error: 'Subtitle selection changed or access expired.' });
      const currentMedia = () => grant.room.viewers.get(grant.viewerId)?.media;
      const controller = new AbortController(),
        cancel = () => controller.abort();
      res.on('close', cancel);
      const check = setInterval(async () => {
        try {
          if (!(await validCaptionGrant(grant, match[1]))) controller.abort();
        } catch {
          controller.abort();
        }
      }, 1000);
      try {
        const media = currentMedia();
        const windowed =
          ['pgs', 'cues'].includes(media?.selection?.subtitle?.delivery) && !media?.selection?.subtitle?.external;
        if (!match[2] && windowed) {
          if (controller.signal.aborted || !(await validCaptionGrant(grant, match[1])))
            return json(res, 403, { error: 'Subtitle access expired or selection changed.' });
          res.setHeader('Cache-Control', 'no-store');
          const base = `/api/watch/media/${grant.id}/subtitle-${match[1]}/`;
          return json(res, 200, {
            format: media.selection.subtitle.delivery,
            data: base + 'data',
            window: base + 'window',
            fonts: [],
          });
        }
        if (match[2] === 'window' && windowed) {
          if (controller.signal.aborted || !(await validCaptionGrant(grant, match[1])))
            return json(res, 403, { error: 'Subtitle access expired or selection changed.' });
          const atMs = url?.searchParams?.has('atMs') ? Number(url.searchParams.get('atMs')) : 0;
          const beforeMs = url?.searchParams?.has('beforeMs') ? Number(url.searchParams.get('beforeMs')) : 15000;
          const afterMs = url?.searchParams?.has('afterMs') ? Number(url.searchParams.get('afterMs')) : 60000;
          const win = await SubtitleResources.window(media.plexContext || watch.plex, media, {
            atMs,
            beforeMs,
            afterMs,
            signal: controller.signal,
          });
          if (controller.signal.aborted || !(await validCaptionGrant(grant, match[1])))
            return json(res, 403, { error: 'Subtitle access expired or selection changed.' });
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': win.data.length,
            'Cache-Control': 'no-store',
            'X-Subtitle-Start-Ms': String(win.startMs),
            'X-Subtitle-End-Ms': String(win.endMs),
            'X-Subtitle-Cues': String(win.cues),
          });
          return res.end(req.method === 'HEAD' ? undefined : win.data);
        }
        if (
          match[2] === 'data' &&
          media?.selection?.subtitle?.delivery === 'pgs' &&
          !media?.selection?.subtitle?.external
        ) {
          if (controller.signal.aborted || !(await validCaptionGrant(grant, match[1])))
            return json(res, 403, { error: 'Subtitle access expired or selection changed.' });
          req.setTimeout?.(0);
          res.setTimeout?.(0);
          await SubtitleResources.pipe(media.plexContext || watch.plex, media, req, res, controller.signal);
          return;
        }
        const result = await SubtitleResources.load(media.plexContext || watch.plex, media, controller.signal);
        if (controller.signal.aborted || !(await validCaptionGrant(grant, match[1])))
          return json(res, 403, { error: 'Subtitle access expired or selection changed.' });
        res.setHeader('Cache-Control', 'no-store');
        if (!match[2]) {
          const base = `/api/watch/media/${grant.id}/subtitle-${match[1]}/`;
          return json(res, 200, {
            format: result.format,
            fileName: result.fileName,
            data: base + 'data',
            ...(result.assets.has('index') ? { index: base + 'index' } : {}),
            fonts: [...result.assets.keys()].filter(k => k.startsWith('font-')).map(k => base + k),
          });
        }
        const data = result.assets.get(match[2]);
        if (!data) return json(res, 404, { error: 'Subtitle resource unavailable.' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length });
        return res.end(req.method === 'HEAD' ? undefined : data);
      } catch (error) {
        if (!res.headersSent && !res.destroyed)
          json(res, 503, {
            error: error instanceof PlaybackError ? error.message : 'Subtitles could not load. Try burn-in.',
          });
        else if (!res.destroyed) res.destroy();
      } finally {
        clearInterval(check);
        res.off('close', cancel);
      }
      return;
    }
    if (key.startsWith('captions-')) {
      const match = /^captions-([a-f0-9-]{36})$/.exec(key);
      if (!match || !(await validCaptionGrant(grant, match[1])))
        return json(res, 403, { error: 'Subtitle selection changed or access expired.' });
      const abort = new AbortController(),
        cancel = () => abort.abort();
      res.on('close', cancel);
      const check = setInterval(async () => {
        try {
          if (!(await validCaptionGrant(grant, match[1]))) abort.abort();
        } catch {
          abort.abort();
        }
      }, 2000);
      try {
        const media = grant.room.viewers.get(grant.viewerId)?.media;
        const cues = await Subtitles.load(media.plexContext || watch.plex, media, abort.signal);
        if (abort.signal.aborted || !(await validCaptionGrant(grant, match[1])))
          return json(res, 403, { error: 'Subtitle access expired or selection changed.' });
        json(res, 200, { cues });
      } catch (error) {
        if (!res.destroyed)
          json(res, 503, { error: error instanceof PlaybackError ? error.message : 'Subtitles could not load.' });
      } finally {
        clearInterval(check);
        res.off('close', cancel);
      }
      return;
    }
    if (!(await validGrant(grant))) return json(res, 403, { error: 'Viewing access expired or was revoked' });
    const media = grant.media;
    if (media.bootstrapFallback) return json(res, 409, { error: 'Your selected quality is still preparing.' });
    // A direct output never serves video through this process, even if a client
    // tries a stale or manually constructed resource URL. Its start is text only.
    if (media.directHls && key === 'start' && !media.initialManifest)
      return json(res, 409, { error: 'Direct Plex playlist unavailable' });
    if (media.directHls && key !== 'start') return json(res, 409, { error: 'Use the direct Plex media route' });
    if (Playback.localFormat(media.format)) {
      if (key === 'start')
        return json(res, 200, {
          format: media.format,
          mime: Playback.LOCAL_CODECS[media.format],
          audioMime: AUDIO_MIME,
          chunkSeconds: CHUNK,
          audioLead: AUDIO_LEAD,
          duration: media.duration,
          buffer: Playback.BUFFER,
        });
      const match = /^chunk-(video|audio)-(\d{1,9})$/.exec(key),
        index = Number(match?.[2]);
      // The authoritative timeline selects source time. The grant cannot be used
      // as an arbitrary transcoding API, even by an authenticated viewer.
      const window = Playback.chunkWindow(watch.position(grant.room), media.duration);
      if (!match || index < window.first || index > window.last)
        return json(res, 403, { error: 'Chunk is outside the shared playback window' });
      const abort = new AbortController();
      const cancel = () => abort.abort();
      res.on('close', cancel);
      const check = setInterval(async () => {
        try {
          if (!(await validGrant(grant))) abort.abort();
        } catch {
          abort.abort();
        }
      }, 2000);
      try {
        const background = req.headers['x-uburoom-prefetch'] === '1';
        const chunk = await watch.plex.av1.chunk(media.av1Lease, index, abort.signal, {
            urgent: !background && Math.abs(index - Math.floor(watch.position(grant.room) / CHUNK)) <= 1,
            background,
          }),
          bytes = chunk[match[1]];
        if (abort.signal.aborted || !(await validGrant(grant))) return;
        res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': bytes.length });
        if (req.method === 'HEAD') res.end();
        else await pipeline(Readable.from([bytes]), res);
      } catch (error) {
        if (!res.headersSent && !res.destroyed)
          json(res, 503, { error: error instanceof PlaybackError ? error.message : 'Local video conversion failed' });
        else res.destroy();
      } finally {
        clearInterval(check);
        res.off('close', cancel);
      }
      return;
    }
    if (media.kind === 'demo') {
      if (key !== 'start') return json(res, 404, { error: 'Media unavailable' });
      const size = media.size || (media.size = (await fs.promises.stat(media.file)).size),
        range = req.headers.range;
      let start = 0,
        end = size - 1;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          return res.end();
        }
        if (!match[1]) start = Math.max(0, size - Number(match[2]));
        else {
          start = Number(match[1]);
          if (match[2]) end = Math.min(end, Number(match[2]));
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          return res.end();
        }
      }
      const headers = { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' };
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === 'HEAD') return res.end();
      const source = fs.createReadStream(media.file, { start, end });
      const check = setInterval(async () => {
        try {
          if (!(await validGrant(grant))) source.destroy();
        } catch {
          source.destroy();
        }
      }, 2000);
      try {
        await pipeline(source, res);
      } catch {
        res.destroy();
      } finally {
        clearInterval(check);
      }
      return;
    }
    const target = key === 'start' ? media.start : media.resources.get(key);
    if (!target) return json(res, 404, { error: 'Media unavailable' });
    if (key === 'start' && media.initialManifest) {
      // Repeated master loads must keep the captured session. Reissuing start
      // after restoring Plex's audio preference could select another track.
      let text;
      try {
        text = rewriteManifest(media.initialManifest, target, media, grant.id);
      } catch {
        return json(res, 409, { error: 'Plex playlist could not use the selected delivery route' });
      }
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end(req.method === 'HEAD' ? undefined : text);
    }
    const abort = new AbortController();
    let response;
    const timer = setTimeout(() => abort.abort(), 12000);
    const disconnect = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on('close', disconnect);
    try {
      // The grant's own source access is checked before cached or producer bytes.
      response =
        (media.plexContext || watch.plex).hlsPool?.response(media.hlsLease, target, req.method, req.headers.range) ||
        (await (media.hlsContext || media.plexContext || watch.plex).request(target, {
          method: req.method,
          signal: abort.signal,
          streaming: true,
          headers: {
            Accept: '*/*',
            ...(media.transcodeId ? { 'X-Plex-Client-Identifier': media.transcodeId } : {}),
            ...(req.headers.range ? { Range: req.headers.range } : {}),
          },
        }));
      if (!(await validGrant(grant))) {
        abort.abort();
        void response.body?.cancel().catch(() => {});
        return json(res, 403, { error: 'Viewing access was revoked' });
      }
      const type = response.headers.get('content-type') || 'application/octet-stream';
      if (req.method !== 'HEAD' && (new URL(target).pathname.endsWith('.m3u8') || /mpegurl/i.test(type))) {
        const text = await response.text().finally(() => clearTimeout(timer));
        if (text.length > 2e6) throw new Error('Manifest too large');
        if (!(await validGrant(grant))) {
          abort.abort();
          void response.body?.cancel().catch(() => {});
          return json(res, 403, { error: 'Viewing access was revoked' });
        }
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        return res.end(rewriteManifest(text, target, media, grant.id));
      }
      clearTimeout(timer);
      const headers = { 'Content-Type': type };
      for (const name of ['content-length', 'content-range', 'accept-ranges'])
        if (response.headers.has(name)) headers[name] = response.headers.get(name);
      res.writeHead(response.status, headers);
      if (req.method === 'HEAD') return res.end();
      const check = setInterval(async () => {
        try {
          if (!(await validGrant(grant))) abort.abort();
        } catch {
          abort.abort();
        }
      }, 2000);
      try {
        await pipeline(Readable.fromWeb(response.body), res);
      } finally {
        clearInterval(check);
      }
    } catch (error) {
      if (!res.headersSent)
        json(
          res,
          media.transcodeId &&
            ([404, 410].includes(error.status) || (media.hlsLease && [401, 403].includes(error.status)))
            ? 410
            : 502,
          { error: 'Plex playback failed; try a different quality or check server access' },
        );
      else res.destroy();
    } finally {
      clearTimeout(timer);
      res.off('close', disconnect);
    }
  }
  // Room invites. 'preview' names the room; 'join' lets the person in. Someone the
  // server already admits just goes to the room (and is remembered by a private
  // room). Anyone else enters as a guest when the room allows guests.
  async function joinInvite(req, res) {
    if (!allowedOrigin(req) || !throttle('invite:' + (clientAddress(req) || 'local'), 20))
      return json(res, 429, { error: 'Too many tries; wait a minute and try again' });
    if (!registry || !watch.roomState) return json(res, 404, { error: 'Room invites are unavailable on this server' });
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
    const guestsAllowed = !!hub.guestsEnabled?.() && record.allowGuests;
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
  const operations = watchOperations({
    config,
    watch,
    hub,
    authorized,
    login,
    mediaGrant,
    cookies,
    throttle,
    registry,
    clockEpoch,
    delivery,
    validGrant: id => validGrant(grants.get(id)),
  });
  async function route(req, res, url) {
    if (!url.pathname.startsWith('/api/watch/')) return false;
    const sharedPoster = /^\/api\/watch\/shared-poster\/([a-f0-9-]{36})\/([a-f0-9]{48})$/.exec(url.pathname);
    if (sharedPoster && req.method === 'GET') {
      const art = watch.publications?.posterResource(sharedPoster[1], sharedPoster[2]);
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
      if (!allowedOrigin(req) || !throttle('entry:' + (clientAddress(req) || 'local'), 10)) {
        json(res, 429, { error: 'Entry is unavailable; wait a minute and try again' });
        return true;
      }
      const identity = await rawLogin(req),
        data = await body(req);
      if (!config.accessPolicy.publicWeb && !identity?.activity) {
        json(res, 403, { error: 'Open uburoom through Discord Activity' });
        return true;
      }
      if (entryPolicy.passwordRequired) {
        const grant = entryPolicy.enter(data.password, identity);
        if (!grant) {
          json(res, 403, { error: 'Incorrect server password' });
          return true;
        }
        res.setHeader('Set-Cookie', cookie('uburoom_entry', grant, 43200));
      }
      if (entryPolicy.anonymous && !identity) {
        // Anonymous visitors are guests too: an unverified, random ubunym they can change.
        const id = randomBytes(32).toString('hex'),
          accountId = registry.createGuest(Ubumfa.ubunym().fullName),
          account = registry.canonical(accountId);
        logins.set(hash(id), {
          userId: account.id,
          accountRevision: account.revision,
          name: account.name,
          csrf: randomBytes(32).toString('hex'),
          expires: Date.now() + 86400000,
        });
        accounts.save();
        const existing = res.getHeader('Set-Cookie');
        res.setHeader('Set-Cookie', [...(existing ? [existing] : []), cookie('uburoom', id, 86400)]);
      }
      json(res, 200, { ok: true });
      return true;
    }
    if (url.pathname === '/api/watch/invite' && req.method === 'POST') {
      await joinInvite(req, res);
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
    if (!throttle('watch:' + (clientAddress(req) || 'local'), 600)) {
      json(res, 429, { error: 'Too many requests' });
      return true;
    }
    try {
      if (req.method === 'POST' && url.pathname === '/api/watch/handoff/native/start') {
        if (!throttle('handoff-native-start:' + (clientAddress(req) || 'local'), 30)) {
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
        if (req.headers.origin !== config.publicUrl || req.headers.authorization) {
          json(res, 403, { error: 'Forbidden' });
          return true;
        }
        const identity = await login(req);
        if (!identity) {
          json(res, 401, { error: 'Sign in to approve native client', loginUrl: '/auth/discord' });
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
        if (req.headers.origin !== config.publicUrl || req.headers.authorization) {
          json(res, 403, { error: 'Forbidden' });
          return true;
        }
        const identity = await login(req);
        if (!identity) {
          json(res, 401, { error: 'Sign in to approve native client' });
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
        if (!throttle('handoff-native-poll:' + (clientAddress(req) || 'local'), 180)) {
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
        const nonce = cookies(req).uburoom_handoff;
        if (
          req.headers.origin !== config.publicUrl ||
          req.headers.authorization ||
          !SECRET.test(nonce || '') ||
          !throttle('handoff-browser:' + (clientAddress(req) || 'local'), 120)
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
          if (existing?.userId !== attempt.source.userId) browserLogin(res, attempt.source);
          else res.setHeader('Set-Cookie', 'uburoom_handoff=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
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
        // Never trust guild/channel/user IDs supplied by the iframe. Membership
        // and its current voice channel come from the connected bot's guild.
        if (
          config.accessPolicy?.discord === false ||
          !(await hub.access?.refresh(identity.id)) ||
          !hub.access.validVoiceChannel(hub.access.voiceChannel(identity.id))
        ) {
          json(res, 403, { error: 'Join a voice channel in the configured Discord server first' });
          return true;
        }
        const login = discordIdentity({
          userId: identity.id,
          name: EngineName(identity.global_name || identity.username),
          activity: true,
        });
        const previous = await rawLogin(req);
        if (previous?.activity && previous.userId === login.userId && previous.entryAuthorized)
          login.entryAuthorized = true;
        json(res, 200, {
          ...issue(login),
          accessToken: tokens.access_token,
          name: login.name,
          owner: hub.isOwner(webActor(login)),
        });
        return true;
      }
      if (
        req.method === 'GET' &&
        [
          '/api/watch/me',
          '/api/watch/playback',
          '/api/watch/library',
          '/api/watch/library/item',
          '/api/watch/library/availability',
          '/api/watch/library/filters',
          '/api/watch/library/art',
        ].includes(url.pathname)
      ) {
        const reply = await operations.execute({ headers: req.headers, remoteAddress: clientAddress(req) }, url.href);
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
        if (identity?.activity && entryPolicy.password(req, identity))
          auth = { identity, actor: webActor(identity), pending: true };
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
          ((auth.pending && config.accessPolicy?.requirePlex) || data.connectPlex) &&
          watch.plex.configured &&
          config.accessPolicy?.plex !== false,
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
      json(res, 400, {
        error:
          error instanceof PlaybackError
            ? error.message
            : 'Request failed; check Plex/Discord configuration and try again',
      });
      return true;
    }
  }
  const EngineName = value => require('../shared/engine').senderName(value);
  function sweep() {
    entryPolicy?.sweep();
    handoff.sweep();
    for (const [token, value] of identities) if (value.expires <= Date.now()) identities.delete(token);
    for (const [token, value] of grants) if (value.expires <= Date.now()) grants.delete(token);
  }
  async function logout(loginHash) {
    for (const [id, grant] of grants)
      if (grant.credential && !grant.credential.startsWith('Bearer ') && hash(grant.credential) === loginHash)
        grants.delete(id);
    for (const room of [...watch.rooms.values()])
      for (const [id, viewer] of [...room.viewers])
        if (viewer.browserLoginHash === loginHash) {
          viewer.watchSocket?.close(4003, 'Sign in again');
          await watch.leave(room, viewer.actor, id, 'logout');
        }
    for (const room of [...watch.rooms.values()])
      for (const [id, viewer] of [...room.disconnectedViewers])
        if (viewer.browserLoginHash === loginHash) await watch.leave(room, { userId: viewer.userId }, id, 'logout');
  }
  async function invalidate(ids) {
    for (const [token, identity] of identities) if (ids.includes(identity.userId)) identities.delete(token);
    for (const [id, grant] of grants) if (ids.includes(grant.actor.userId)) grants.delete(id);
    for (const room of [...watch.rooms.values()])
      for (const [id, viewer] of [...room.viewers])
        if (ids.includes(viewer.userId)) {
          viewer.watchSocket?.close(4003, 'Sign in again');
          await watch.leave(room, viewer.actor, id, 'account-changed');
        }
    for (const room of [...watch.rooms.values()])
      for (const [id, viewer] of [...room.disconnectedViewers])
        if (ids.includes(viewer.userId)) await watch.leave(room, { userId: viewer.userId }, id, 'account-changed');
  }
  async function admissionStatus(req) {
    const identity = await rawLogin(req);
    return {
      identity: !!identity,
      passwordNeeded: !entryPolicy.password(req, identity),
      activityOnly: !config.accessPolicy.publicWeb && !identity?.activity,
      plexRequired: entryPolicy.requiresPlex(identity),
      admitted: !!identity && !!(await login(req)),
      csrf: identity?.csrf,
      pendingIdentity: identity
        ? { name: identity.name, csrf: identity.csrf, account: registry?.summary(identity.userId) }
        : undefined,
    };
  }
  async function bootstrap(req) {
    const initial = { config: publicConfig() };
    const reqUrl = new URL(req.url, config.publicUrl);
    const query = reqUrl.searchParams;
    if (query.has('frame_id') || (config.demo && ['host', 'guest', 'guest2'].includes(query.get('demo'))))
      return initial;
    if (/^\/join\/([^/]+)$/.test(reqUrl.pathname)) initial.inviteCode = true;
    try {
      const ctx = { headers: req.headers, remoteAddress: clientAddress(req) };
      initial.me = await operations.execute(ctx, '/api/watch/me');
      if (initial.me.status === 200) {
        const [rooms, events, library] = await Promise.all([
          operations.execute(ctx, '/api/watch/rooms'),
          watch.events ? operations.execute(ctx, '/api/watch/events') : undefined,
          !initial.me.value.guestRoomId
            ? operations.execute({ ...ctx, signal: AbortSignal.timeout(1500) }, '/api/watch/library')
            : undefined,
        ]);
        initial.rooms = rooms;
        if (events?.status === 200) initial.events = events;
        if (library?.status === 200) initial.library = library;
        if (config.accessPolicy)
          initial.admission = {
            identity: true,
            passwordNeeded: false,
            activityOnly: false,
            plexRequired: false,
            admitted: true,
            csrf: initial.me.value.csrf,
          };
      } else if (config.accessPolicy) {
        initial.admission = await admissionStatus(req);
      }
      const roomMatch = /^\/room\/([a-z0-9-]+)$/i.exec(reqUrl.pathname);
      const requested = roomMatch ? roomMatch[1] : reqUrl.searchParams.get('room');
      if (requested) {
        let roomId, roomSlug, roomName;
        if (watch.roomState) {
          try {
            const room = watch.roomState.store.getBySlug(requested);
            roomId = room.id;
            roomSlug = room.slug;
            roomName = room.name;
          } catch {
            const activeRoom = [...watch.rooms.values()].find(r => r.previousSlugs?.has(requested.toLowerCase()));
            if (activeRoom) {
              roomId = activeRoom.roomId;
              roomSlug = activeRoom.slug;
              roomName = activeRoom.name;
            }
          }
        }
        if (!roomId && watch.rooms) {
          const activeRoom = [...watch.rooms.values()].find(r => r?.slug === requested || r?.roomId === requested);
          if (activeRoom) {
            roomId = activeRoom.roomId;
            roomSlug = activeRoom.slug;
            roomName = activeRoom.name;
          }
        }
        if (roomId) {
          initial.targetRoom = { id: roomId, slug: roomSlug, name: roomName };
          const active = watch.rooms?.get(roomId);
          if (active?.media?.title) {
            initial.targetRoom.media = {
              title: active.media.title,
              subtitle: active.media.subtitle || (active.media.year ? String(active.media.year) : ''),
            };
          } else {
            const listed =
              initial.rooms?.status === 200 && Array.isArray(initial.rooms.value?.rooms)
                ? initial.rooms.value.rooms.find(r => r.id === roomId || r.slug === roomSlug)
                : undefined;
            if (listed?.title && listed.title !== 'No video selected') {
              initial.targetRoom.media = { title: listed.title, subtitle: listed.subtitle || '' };
            }
          }
        }
      }
    } catch {
      initial.me = { status: 503, value: { error: 'Sign-in temporarily unavailable. Try again.' } };
    }
    return initial;
  }
  return {
    route,
    bootstrap,
    execute: operations.execute,
    sweep,
    logout,
    invalidate,
    authorized,
    clockEpoch,
    close: () => {
      identities.clear();
      grants.clear();
      handoff.close();
    },
    rewriteManifest,
    deliveryOrigins: req =>
      delivery.deliveryOrigins(typeof req === 'string' || req === undefined ? req : clientAddress(req)),
  };
}
module.exports = { watchHttp };
