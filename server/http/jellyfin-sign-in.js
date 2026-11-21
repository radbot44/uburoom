'use strict';

const { clientAddress } = require('../client-address');

const path = '/api/account/jellyfin';
const binding = 'uburoom_jellyfin';

function jellyfinSignInRoute({ config, registry, entryPolicy, body, cookie, cookies, json, throttle, finishSession }) {
  return async function route(req, res) {
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST to sign in with Jellyfin' });
    if (!config.accessPolicy?.publicWeb || req.headers.origin !== config.publicUrl || req.headers.authorization)
      return json(res, 403, { error: 'Browser sign-in unavailable' });

    try {
      const { source: sourceId, action, username, password } = await body(req);
      const source = entryPolicy.memberSignIns('jellyfin').find(item => item.id === sourceId);
      if (!source) return json(res, 404, { error: 'Jellyfin sign-in unavailable' });

      const signIn = source.signIn;
      let identity;
      if (action === 'cancel') {
        // Ends this browser's Quick Connect attempt: its code stops working here at once.
        signIn.cancel(cookies(req)[binding]);
        res.setHeader('Set-Cookie', cookie(binding, '', 0));
        return json(res, 200, { ok: true });
      }
      if (action === 'poll') {
        // The only handle understood here comes from the browser's HttpOnly cookie.
        const id = cookies(req)[binding];
        if (!(await signIn.poll(id))) return json(res, 200, { pending: true });
        identity = await signIn.finish(id);
      } else {
        if (!['start', 'password'].includes(action)) return json(res, 400, { error: 'Unknown sign-in action' });
        if (!throttle('jellyfin-login:' + (clientAddress(req) || 'local'), 12))
          return json(res, 429, { error: 'Too many sign-in attempts. Try again in a minute.' });
        if (action === 'start') {
          try {
            const { id, code, expires } = await signIn.startQuickConnect();
            res.setHeader('Set-Cookie', cookie(binding, id, Math.ceil((expires - Date.now()) / 1000)));
            return json(res, 200, { code, expiresIn: Math.max(0, Math.floor((expires - Date.now()) / 1000)) });
          } catch (error) {
            if (error.code !== 'JELLYFIN_NO_QUICK_CONNECT') throw error;
            res.setHeader('Set-Cookie', cookie(binding, '', 0));
            return json(res, 200, { password: true });
          }
        }
        if (await signIn.quickConnect()) return json(res, 409, { error: 'Use Quick Connect to sign in' });
        identity = await signIn.password(username, password);
      }

      const account = registry.resolve(identity.provider, identity.subject, identity.name);
      if (!(await entryPolicy.admit(account.id, {})))
        return json(res, 403, { error: 'This account cannot enter the server.' });
      finishSession(req, res, account);
      res.setHeader('Set-Cookie', [res.getHeader('Set-Cookie'), cookie(binding, '', 0)]);
      return json(res, 200, { ok: true });
    } catch (error) {
      if (/^JELLYFIN_[A-Z_]+$/.test(error?.code || '')) return json(res, error.status || 400, { error: error.message });
      return json(res, 400, { error: 'Jellyfin sign-in could not be completed. Try again.' });
    }
  };
}

module.exports = { path, jellyfinSignInRoute };
