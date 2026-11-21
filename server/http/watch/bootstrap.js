'use strict';
const { clientAddress } = require('../../client-address');

/** What the watch page is given before it opens a connection: public configuration and its first reads. */
function pageBootstrap({
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
}) {
  const publicConfig = () => ({
    watchVersion: 19,
    keepDiagnostics: diagnosticLog ? config.diagnostics.keepDays : 0,
    unifiedAccounts: true,
    accountDemo: !!config.demo,
    watchUrl: config.publicUrl,
    clientId: config.clientId,
    discordRichPresence: config.discordRichPresence !== false,
    demo: !!config.demo,
    // Every media source by name and type, and whether it is available; never an address or credential.
    sources: watch.providers.summary(),
    // Plex sign-in is offered for entry only when a member rule names a Plex source.
    plexSignIn: !!config.accessPolicy?.plex,
    // Linking a Plex account (for personal watch-state sync) needs some Plex source to sync with.
    plexLink: (watch.providers.list || []).some(provider => provider.memberIdentity === 'plex'),
    testVideo: !!watch.demoMedia,
    access: entryPolicy?.public(),
    guests: !!hub.guestsEnabled(),
    singleRoom: !!config.singleRoom,
    localFormats:
      config.transcoding && (!config.transcoding.uburoom || config.transcoding.policy === 'disabled')
        ? []
        : config.transcoding?.formats || ['av1'],
    outputs: config.transcoding?.policy === 'disabled' ? [] : config.transcoding?.outputs,
    // uburoom can keep a picture and convert only its sound itself (server/remux.js).
    copyVideo:
      config.transcoding?.policy !== 'disabled' && !!(watch.pipeline?.av1?.ffmpeg && watch.pipeline.av1.ffprobe),
  });
  async function admissionStatus(req) {
    const identity = await rawLogin(req);
    return {
      identity: !!identity,
      activityOnly: !config.accessPolicy.publicWeb && !identity?.activity,
      admitted: !!identity && !!(await login(req)),
      csrf: identity?.csrf,
      pendingIdentity: identity
        ? { name: identity.name, csrf: identity.csrf, account: registry.summary(identity.userId) }
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
      initial.me = await operations.call(ctx, 'me');
      if (initial.me.status === 200) {
        const [rooms, events, library] = await Promise.all([
          operations.call(ctx, 'rooms.list'),
          operations.call(ctx, 'events.list'),
          !initial.me.value.guestRoomId
            ? operations.call({ ...ctx, signal: AbortSignal.timeout(1500) }, 'library.browse')
            : undefined,
        ]);
        initial.rooms = rooms;
        if (events?.status === 200) initial.events = events;
        if (library?.status === 200) initial.library = library;
        if (config.accessPolicy)
          initial.admission = {
            identity: true,
            activityOnly: false,
            admitted: true,
            csrf: initial.me.value.csrf,
          };
      } else if (config.accessPolicy) {
        initial.admission = await admissionStatus(req);
      }
      const roomMatch = /^\/room\/([a-z0-9-]+)$/i.exec(reqUrl.pathname);
      const requested = roomMatch ? roomMatch[1] : reqUrl.searchParams.get('room');
      if (initial.me.status === 200 && requested) {
        const identity = await login(req);
        const actor = identity && webActor(identity);
        let record;
        let roomId, roomSlug, roomName;
        try {
          const room = watch.roomState.store.getBySlug(requested);
          record = room;
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
        if (!roomId && watch.rooms) {
          const activeRoom = [...watch.rooms.values()].find(r => r?.slug === requested || r?.roomId === requested);
          if (activeRoom) {
            roomId = activeRoom.roomId;
            roomSlug = activeRoom.slug;
            roomName = activeRoom.name;
          }
        }
        const active = watch.rooms?.get(roomId);
        if (roomId && actor && hub.authorize(actor, active || record, 'room.view').ok) {
          initial.targetRoom = { id: roomId, slug: roomSlug, name: roomName };
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
  return { publicConfig, admissionStatus, bootstrap };
}
module.exports = { pageBootstrap };
