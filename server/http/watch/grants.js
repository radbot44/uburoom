'use strict';
const { randomBytes } = require('node:crypto');

/** Short-lived media grants: a viewer's right to read one media selection of one room. */
function mediaGrants({ watch, cookies, login }) {
  const grants = new Map();
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
  // A grant lasts 15 s. Its tab's own presence (clock exchanges, pongs) renews it;
  // a client's own request renews it too, and the server's publications only read it.
  // Grants are found by their tab, so renewal never looks at anyone else's.
  /** @type {Map<string, Set<any>>} */
  const viewerGrants = new Map();
  function renewGrants(socket, viewerId) {
    const own = viewerGrants.get(viewerId);
    if (!own) return;
    const expires = Date.now() + 15000;
    for (const grant of own) {
      if (grants.get(grant.id) !== grant) {
        own.delete(grant);
        continue;
      }
      const viewer = grant.room.viewers.get(viewerId);
      if (viewer?.watchSocket === socket && viewer.userId === grant.actor.userId) grant.expires = expires;
    }
    if (!own.size) viewerGrants.delete(viewerId);
  }
  function mediaGrant(room, auth, req, viewerId, fallback = false, renew = true) {
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
        if (renew) g.expires = Date.now() + 15000;
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
      if (renew) existing.expires = Date.now() + 15000;
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
    if (!viewerGrants.has(viewerId)) viewerGrants.set(viewerId, new Set());
    viewerGrants.get(viewerId).add(grant);
    return id;
  }
  return { grants, validGrant, validCaptionGrant, renewGrants, mediaGrant };
}
module.exports = { mediaGrants };
