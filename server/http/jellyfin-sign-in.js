'use strict';

const { hash } = require('../core');
const { clientAddress } = require('../client-address');

const path = '/api/account/jellyfin';

function jellyfinSignInRoute({
  config,
  registry,
  entryPolicy,
  providers,
  body,
  cookie,
  COOKIES,
  cookies,
  json,
  throttle,
  user,
  protectedPost,
  verifiedLink,
  finishSession,
}) {
  const binding = COOKIES.jellyfin;
  /** @type {Map<string, {sourceId: string, expires: number, userId?: string, sourceHash?: string, revision?: number}>} */
  const attemptMeta = new Map();

  function sweepMeta() {
    const now = Date.now();
    for (const [id, meta] of attemptMeta) if (meta.expires <= now) attemptMeta.delete(id);
  }

  function linkableSources() {
    const memberIds = new Set(entryPolicy.memberSignIns('jellyfin').map(source => source.id));
    return (providers?.list || []).filter(
      provider =>
        provider.kind === 'jellyfin' &&
        provider.signIn &&
        (memberIds.has(provider.id) || provider.watchStateReporting === true),
    );
  }

  return async function route(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST to sign in with Jellyfin' });
    if (!config.accessPolicy?.publicWeb || req.headers.origin !== config.publicUrl || req.headers.authorization)
      return json(res, 403, { error: 'Browser sign-in unavailable' });

    try {
      sweepMeta();
      const { source: sourceId, action, username, password, link } = await body(req);
      let linking;
      if (link === true) {
        linking = await protectedPost(req);
        if (!linking || registry.isGuest(linking.userId))
          return json(res, 403, { error: 'Sign in with an account before linking Jellyfin' });
      } else {
        const current = cookies(req)[COOKIES.session] ? await user(req) : undefined;
        if (
          current &&
          !registry.isGuest(current.userId) &&
          req.headers['x-csrf-token'] === current.csrf &&
          (await entryPolicy.admit(current.userId, current))
        )
          linking = current;
      }

      const eligibleSources = linking ? linkableSources() : entryPolicy.memberSignIns('jellyfin');
      const source = eligibleSources.find(item => item.id === sourceId);
      if (!source) return json(res, 404, { error: 'Jellyfin sign-in unavailable' });

      const signIn = source.signIn;
      const currentSessionHash = cookies(req)[COOKIES.session] ? hash(cookies(req)[COOKIES.session]) : undefined;
      let identity;
      if (action === 'cancel') {
        // Ends this browser's Quick Connect attempt: its code stops working here at once.
        const handle = cookies(req)[binding];
        signIn.cancel(handle);
        if (handle) attemptMeta.delete(handle);
        res.setHeader('Set-Cookie', cookie(binding, '', 0));
        return json(res, 200, { ok: true });
      }
      if (action === 'poll') {
        // The only handle understood here comes from the browser's HttpOnly cookie.
        const id = cookies(req)[binding];
        const meta = id && attemptMeta.get(id);
        if (meta && meta.sourceId !== source.id)
          return json(res, 400, { error: 'Jellyfin sign-in expired; start again' });
        if (
          linking &&
          (!meta ||
            meta.userId !== linking.userId ||
            meta.sourceHash !== currentSessionHash ||
            meta.revision !== linking.accountRevision)
        )
          return json(res, 403, { error: 'Account changed during Jellyfin linking; start again' });
        if (!(await signIn.poll(id))) return json(res, 200, { pending: true });
        identity = await signIn.finish(id, { persistCredential: false });
        if (id) attemptMeta.delete(id);
      } else {
        if (!['start', 'password'].includes(action)) return json(res, 400, { error: 'Unknown sign-in action' });
        if (!throttle('jellyfin-login:' + (clientAddress(req, config) || 'local'), 12))
          return json(res, 429, { error: 'Too many sign-in attempts. Try again in a minute.' });
        if (action === 'start') {
          try {
            const { id, code, expires } = await signIn.startQuickConnect();
            attemptMeta.set(id, {
              sourceId: source.id,
              expires,
              ...(linking
                ? { userId: linking.userId, sourceHash: currentSessionHash, revision: linking.accountRevision }
                : {}),
            });
            res.setHeader('Set-Cookie', cookie(binding, id, Math.ceil((expires - Date.now()) / 1000)));
            return json(res, 200, { code, expiresIn: Math.max(0, Math.floor((expires - Date.now()) / 1000)) });
          } catch (error) {
            if (error.code !== 'JELLYFIN_NO_QUICK_CONNECT') throw error;
            res.setHeader('Set-Cookie', cookie(binding, '', 0));
            return json(res, 200, { password: true });
          }
        }
        if (await signIn.quickConnect()) return json(res, 409, { error: 'Use Quick Connect to sign in' });
        identity = await signIn.password(username, password, { persistCredential: false });
      }

      if (linking) {
        if ((await user(req)) !== linking) return json(res, 403, { error: 'Account sign-in expired during linking' });
        const linked = await verifiedLink(
          req,
          res,
          linking,
          identity.provider,
          identity.subject,
          identity.name,
          { token: identity.token },
          undefined,
          [cookie(binding, '', 0)],
        );
        if (!res.getHeader('Set-Cookie')) res.setHeader('Set-Cookie', cookie(binding, '', 0));
        return json(res, 200, { ok: true, pendingMerge: !!linked?.pendingMerge });
      }

      try {
        if ((await source.members(identity)) !== true)
          return json(res, 403, { error: 'This account cannot enter the server.' });
      } catch (error) {
        if (error?.noServerAccess || error?.revoked)
          return json(res, 403, { error: 'This account cannot enter the server.' });
        return json(res, error?.status || 503, { error: error?.message || 'Jellyfin did not answer; try again.' });
      }

      const account = registry.resolve(identity.provider, identity.subject, identity.name);
      registry.credential(identity.provider, identity.subject, { token: identity.token });
      if (!(await entryPolicy.admit(account.id, {})))
        return json(res, 403, { error: 'This account cannot enter the server.' });
      await finishSession(req, res, account, cookie(binding, '', 0));
      return json(res, 200, { ok: true });
    } catch (error) {
      if (/^JELLYFIN_[A-Z_]+$/.test(error?.code || '')) return json(res, error.status || 400, { error: error.message });
      return json(res, 400, { error: 'Jellyfin sign-in could not be completed. Try again.' });
    }
  };
}

module.exports = { path, jellyfinSignInRoute };
