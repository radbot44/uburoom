'use strict';
const { randomBytes } = require('node:crypto');

/** Short-lived media grants: a viewer's right to read one media selection of one room. */
function mediaGrants({ watch, cookies, login }) {
  const grants = new Map();
  /** @type {Map<string, Set<any>>} */
  const viewerGrants = new Map();
  function revoke(grant) {
    if (!grant) return;
    if (grants.get(grant.id) === grant) grants.delete(grant.id);
    const own = viewerGrants.get(grant.viewerId);
    if (own) {
      own.delete(grant);
      if (!own.size) viewerGrants.delete(grant.viewerId);
    }
    grant.abort?.abort();
  }
  function revokeGrant(id) {
    revoke(grants.get(id));
  }
  function revokeWhere(predicate) {
    for (const grant of [...grants.values()]) {
      if (predicate(grant)) revoke(grant);
    }
  }
  function cleanupViewerGrants(viewerId) {
    const own = viewerGrants.get(viewerId);
    if (!own) return;
    for (const grant of [...own]) revoke(grant);
    viewerGrants.delete(viewerId);
  }
  async function validGrant(grant) {
    return (
      grant &&
      !grant.abort?.signal.aborted &&
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
      !grant.abort?.signal.aborted &&
      grant.expires > Date.now() &&
      (await grant.alive()) &&
      watch.rooms.get(grant.room.roomId) === grant.room &&
      grant.version === grant.room.mediaVersion &&
      (!grant.captionVersion || grant.captionVersion === captionVersion) &&
      viewer?.media?.captionVersion === captionVersion &&
      (await watch.canView(grant.room, grant.actor))
    );
  }
  // A grant lasts 15 s. Its tab's own presence (clock exchanges, pongs) renews it;
  // a client's own request renews it too, and the server's publications only read it.
  // Grants are found by their tab, so renewal never looks at anyone else's.
  function renewGrants(socket, viewerId) {
    const own = viewerGrants.get(viewerId);
    if (!own) return;
    const expires = Date.now() + 15000;
    for (const grant of [...own]) {
      if (grants.get(grant.id) !== grant) {
        own.delete(grant);
        continue;
      }
      const viewer = grant.room.viewers.get(viewerId);
      if (viewer?.watchSocket === socket && viewer.userId === grant.actor.userId) grant.expires = expires;
    }
    if (!own.size) viewerGrants.delete(viewerId);
  }
  function issueOrReuse(match, create, auth, req, renew) {
    const credential = req.headers.authorization || cookies(req).uburoom;
    const { room, viewerId } = create;
    const own = viewerGrants.get(viewerId);
    const existing = own && [...own].find(match);
    if (
      existing &&
      !existing.abort?.signal.aborted &&
      (existing.credential === credential ||
        Boolean(req.headers.authorization) === Boolean(existing.headers?.authorization))
    ) {
      existing.credential = credential;
      existing.headers = { cookie: req.headers.cookie, authorization: req.headers.authorization };
      if (renew) existing.expires = Date.now() + 15000;
      return existing.id;
    }
    if (existing) revoke(existing);
    const id = randomBytes(24).toString('hex');
    const grant = {
      ...create,
      id,
      actor: auth.actor,
      credential,
      headers: { cookie: req.headers.cookie, authorization: req.headers.authorization },
      expires: Date.now() + 15000,
      abort: new AbortController(),
      alive: async () => {
        const liveHeaders = room.viewers.get(viewerId)?.watchSocket?.watchHeaders || grant.headers;
        return (await login({ headers: liveHeaders }))?.userId === auth.actor.userId;
      },
    };
    grants.set(id, grant);
    if (!viewerGrants.has(viewerId)) viewerGrants.set(viewerId, new Set());
    viewerGrants.get(viewerId).add(grant);
    return id;
  }
  function mediaGrant(room, auth, req, viewerId, fallback = false, renew = true) {
    const viewer = room.viewers.get(viewerId);
    const media = fallback ? watch.fallbackFor(room, viewer || {}) : viewer?.media;
    if (!media || media.playbackError) return;
    return issueOrReuse(
      g =>
        !g.caption &&
        g.room === room &&
        g.viewerId === viewerId &&
        g.actor.userId === auth.actor.userId &&
        g.version === room.mediaVersion &&
        g.streamVersion === viewer.streamVersion &&
        g.media === media &&
        !!g.fallback === fallback,
      {
        room,
        media,
        fallback,
        streamVersion: viewer.streamVersion,
        viewerId,
        version: room.mediaVersion,
      },
      auth,
      req,
      renew,
    );
  }
  function captionGrant(room, auth, req, viewerId, renew = true) {
    const viewer = room.viewers.get(viewerId);
    const media = viewer?.media;
    if (!media || media.playbackError || !media.captionVersion) return;
    const captionVersion = media.captionVersion;
    return issueOrReuse(
      g =>
        g.caption === true &&
        g.room === room &&
        g.viewerId === viewerId &&
        g.actor.userId === auth.actor.userId &&
        g.version === room.mediaVersion &&
        g.captionVersion === captionVersion,
      {
        room,
        media,
        caption: true,
        captionVersion,
        viewerId,
        version: room.mediaVersion,
      },
      auth,
      req,
      renew,
    );
  }
  return {
    grants,
    validGrant,
    validCaptionGrant,
    renewGrants,
    mediaGrant,
    captionGrant,
    cleanupViewerGrants,
    revokeGrant,
    revokeWhere,
  };
}
module.exports = { mediaGrants };
