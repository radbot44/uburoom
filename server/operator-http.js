'use strict';
const { hash } = require('./core');
const { isServerOperator } = require('./operator-policy');

function operatorHttp({ config, registry, editor, user, protectedPost, validIdentity, logins, cookies, body, json }) {
  async function route(req, res, url, reply) {
    if (url.pathname !== '/api/operator/settings/saved' || !['GET', 'POST'].includes(req.method)) return false;
    let saved = false;
    let current = () => false;
    try {
      const login = await user(req);
      current = () => !!login && logins.get(hash(cookies(req).uburoom || '')) === login && validIdentity(login) &&
        (login.expires === null || login.expires > Date.now());
      const operator = () => current() && isServerOperator(registry, config, login.userId);
      if (!current()) { json(res, 401, { error: 'Sign in to manage operator settings' }); return true; }
      if (!operator()) { json(res, 403, { error: 'Server operator required' }); return true; }
      if (req.method === 'POST' && await protectedPost(req) !== login) {
        json(res, 403, { error: 'Valid origin and CSRF proof required' }); return true;
      }
      if (!editor) { json(res, 503, { error: 'Saved settings are unavailable' }); return true; }
      await registry.flush();
      if (!operator()) { reply(current() ? 403 : 401, { error: 'Operator authorization changed' }); return true; }
      if (req.method === 'GET') {
        const result = await editor.readEditable();
        await registry.flush();
        if (!operator()) { reply(current() ? 403 : 401, { error: 'Operator authorization changed' }); return true; }
        reply(200, result);
      } else {
        const data = await body(req);
        if (Object.keys(data).some(key => !['revision', 'changes'].includes(key))) {
          reply(400, { error: 'Use only revision and changes' }); return true;
        }
        const canSave = () => operator() && req.headers.origin === config.publicUrl &&
          req.headers['x-csrf-token'] === login.csrf && (!login.oauth || login.oauth.expires > Date.now());
        await editor.save(data, { beforeReplace: canSave });
        saved = true;
        // YAML replacement and audit persistence are separate operations. A
        // later audit failure must never be reported as an unsaved YAML file.
        registry.audit(login.userId, 'operator-settings-save', { settings: Object.keys(data.changes).sort() });
        await registry.flush();
        reply(200, { ok: true, restartRequired: true });
      }
    } catch (error) {
      if (saved) {
        reply(503, { error: 'Settings saved, but audit persistence could not be confirmed', saved: true, restartRequired: true });
      } else if (error.code === 'CONFIG_CONFLICT') {
        reply(409, { code: 'CONFIG_CONFLICT', error: 'Saved configuration changed; read it again before saving' });
      } else if (error.code === 'CONFIG_AUTHORIZATION') {
        reply(current() ? 403 : 401, { error: 'Operator authorization changed; no settings were saved' });
      } else if (['CONFIG_INVALID', 'CONFIG_FORBIDDEN'].includes(error.code)) {
        reply(400, { code: error.code, error: 'Invalid or noneditable settings; no settings were saved' });
      } else {
        reply(error instanceof SyntaxError ? 400 : 503, { error: 'Settings request failed; check configuration or storage' });
      }
    }
    return true;
  }
  return { route };
}

module.exports = { operatorHttp };
