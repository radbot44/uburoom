'use strict';
const { hash } = require('./core');
const { isServerOperator } = require('./operator-policy');
const { runningSettings } = require('./operator-settings');
const { isAllowedBrowserOrigin } = require('./origins');
const { bootId } = require('./http/health');

function operatorHttp({
  config,
  registry,
  editor,
  discordServers,
  watch,
  onRestart,
  canRestart = Boolean(process.send),
  user,
  protectedPost,
  validIdentity,
  logins,
  COOKIES,
  cookies,
  body,
  json,
}) {
  let restartState;
  // The settings this process is running with. Flush before the final checks, rather than deferring
  // the response: logout, account changes or operator removal during persistence must win.
  async function running(req, res, reply, value) {
    const login = await user(req);
    const current = () =>
      !!login &&
      logins.get(hash(cookies(req)[COOKIES.session] || '')) === login &&
      validIdentity(login) &&
      (login.expires === null || login.expires > Date.now());
    if (!current()) return json(res, 401, { error: 'Sign in to read operator settings' });
    if (!isServerOperator(registry, config, login.userId)) return json(res, 403, { error: 'Server operator required' });
    await registry.flush();
    if (!current()) return reply(401, { error: 'Sign in to read operator settings' });
    if (!isServerOperator(registry, config, login.userId)) return reply(403, { error: 'Server operator required' });
    return reply(200, value());
  }
  async function route(req, res, url, reply) {
    if (req.method === 'GET' && url.pathname === '/api/operator/settings') {
      await running(req, res, reply, () => runningSettings(config, { canRestart }));
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/operator/discord/servers') {
      await running(req, res, reply, () => ({ servers: discordServers?.() ?? null }));
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/operator/restart') {
      const login = await user(req);
      const current = () =>
        !!login &&
        logins.get(hash(cookies(req)[COOKIES.session] || '')) === login &&
        validIdentity(login) &&
        (login.expires === null || login.expires > Date.now());
      const operator = () => current() && isServerOperator(registry, config, login.userId);
      if (!current()) {
        json(res, 401, { error: 'Sign in to restart uburoom' });
        return true;
      }
      if (!operator()) {
        json(res, 403, { error: 'Server operator required' });
        return true;
      }
      if ((await protectedPost(req)) !== login) {
        json(res, 403, { error: 'Valid origin and CSRF proof required' });
        return true;
      }
      let data = {};
      if (req.headers['content-type'] || Number(req.headers['content-length']) > 0) {
        try {
          data = await body(req);
        } catch (error) {
          json(res, error?.status || 400, { error: error?.message || 'Invalid JSON request body' });
          return true;
        }
      }
      if (
        Object.keys(data).some(key => key !== 'confirmActive') ||
        (data.confirmActive !== undefined && typeof data.confirmActive !== 'boolean')
      ) {
        json(res, 400, { error: 'Use only confirmActive boolean' });
        return true;
      }
      await registry.flush();
      if (
        !operator() ||
        !isAllowedBrowserOrigin(config, req.headers.origin, req) ||
        req.headers['x-csrf-token'] !== login.csrf ||
        (login.oauth && login.oauth.expires <= Date.now())
      ) {
        reply(current() ? 403 : 401, { error: 'Operator authorization changed' });
        return true;
      }
      if (!onRestart) {
        reply(503, { error: 'Restart is unavailable in this server instance' });
        return true;
      }
      const activity = () => {
        let openRooms = 0;
        let activeViewers = 0;
        let anyPlaying = false;
        for (const room of watch?.rooms?.values?.() || []) {
          if (room.closed) continue;
          openRooms++;
          activeViewers += room.viewers?.size || 0;
          if (room.playing || (room.media && !room.state?.paused)) anyPlaying = true;
        }
        return { openRooms, activeViewers, anyPlaying };
      };
      const confirmActive = data.confirmActive === true;
      const needsConfirmation = snapshot => !confirmActive && (snapshot.activeViewers > 0 || snapshot.anyPlaying);
      const askToConfirm = ({ openRooms, activeViewers }) =>
        reply(409, {
          code: 'ACTIVE_ROOMS',
          openRooms,
          activeViewers,
          error: 'Viewers are currently active in a room; confirm restart to interrupt playback.',
        });
      const accepted = { ok: true, restarting: true, supervised: Boolean(process.send), bootId };
      if (restartState) {
        if (restartState === 'accepted') reply(202, accepted);
        else reply(409, { error: 'A restart request is already being checked. Try again shortly.' });
        return true;
      }
      const before = activity();
      if (needsConfirmation(before)) {
        askToConfirm(before);
        return true;
      }
      restartState = 'checking';
      try {
        registry.audit(login.userId, 'operator-restart', {
          phase: 'requested',
          confirmActive,
          openRooms: before.openRooms,
          activeViewers: before.activeViewers,
        });
        await registry.flush();
      } catch (error) {
        restartState = undefined;
        reply(503, { error: 'Could not record restart audit event' });
        return true;
      }
      if (
        !operator() ||
        !isAllowedBrowserOrigin(config, req.headers.origin, req) ||
        req.headers['x-csrf-token'] !== login.csrf ||
        (login.oauth && login.oauth.expires <= Date.now())
      ) {
        restartState = undefined;
        reply(current() ? 403 : 401, { error: 'Operator authorization changed' });
        return true;
      }
      // A viewer may have joined while the request audit was being persisted. Check
      // again at the final decision boundary, without awaiting any more work.
      const after = activity();
      if (needsConfirmation(after)) {
        restartState = undefined;
        askToConfirm(after);
        return true;
      }
      restartState = 'accepted';
      let triggered = false;
      const trigger = () => {
        if (triggered) return;
        triggered = true;
        onRestart();
      };
      res.once('finish', trigger);
      const fallback = setTimeout(trigger, 150);
      fallback.unref();
      reply(202, accepted);
      return true;
    }
    if (url.pathname !== '/api/operator/settings/saved' || !['GET', 'POST'].includes(req.method)) return false;
    let saved = false;
    let current = () => false;
    try {
      const login = await user(req);
      current = () =>
        !!login &&
        logins.get(hash(cookies(req)[COOKIES.session] || '')) === login &&
        validIdentity(login) &&
        (login.expires === null || login.expires > Date.now());
      const operator = () => current() && isServerOperator(registry, config, login.userId);
      if (!current()) {
        json(res, 401, { error: 'Sign in to manage operator settings' });
        return true;
      }
      if (!operator()) {
        json(res, 403, { error: 'Server operator required' });
        return true;
      }
      if (req.method === 'POST' && (await protectedPost(req)) !== login) {
        json(res, 403, { error: 'Valid origin and CSRF proof required' });
        return true;
      }
      if (!editor) {
        json(res, 503, { error: 'Saved settings are unavailable' });
        return true;
      }
      await registry.flush();
      if (!operator()) {
        reply(current() ? 403 : 401, { error: 'Operator authorization changed' });
        return true;
      }
      if (req.method === 'GET') {
        const result = await editor.readEditable({
          verifiedIdentities: registry.identities(login.userId),
          pinnedSourceId: id => registry.meta?.('source:' + id + ':identity') || undefined,
        });
        await registry.flush();
        if (!operator()) {
          reply(current() ? 403 : 401, { error: 'Operator authorization changed' });
          return true;
        }
        if (result.access) result.access.runningAccounts = !!config.accessPolicy?.accounts;
        reply(200, result);
      } else {
        const data = await body(req);
        if (Object.keys(data).some(key => !['revision', 'changes'].includes(key))) {
          reply(400, { error: 'Use only revision and changes' });
          return true;
        }
        const canSave = () =>
          operator() &&
          isAllowedBrowserOrigin(config, req.headers.origin, req) &&
          req.headers['x-csrf-token'] === login.csrf &&
          (!login.oauth || login.oauth.expires > Date.now());
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
        reply(503, {
          error: 'Settings saved, but audit persistence could not be confirmed',
          saved: true,
          restartRequired: true,
        });
      } else if (error.code === 'CONFIG_CONFLICT') {
        reply(409, { code: 'CONFIG_CONFLICT', error: 'Saved configuration changed; read it again before saving' });
      } else if (error.code === 'CONFIG_AUTHORIZATION') {
        reply(current() ? 403 : 401, { error: 'Operator authorization changed; no settings were saved' });
      } else if (['CONFIG_INVALID', 'CONFIG_FORBIDDEN'].includes(error.code)) {
        reply(400, { code: error.code, error: 'Invalid or noneditable settings; no settings were saved' });
      } else {
        reply(error instanceof SyntaxError ? 400 : 503, {
          error: 'Settings request failed; check configuration or storage',
        });
      }
    }
    return true;
  }
  return { route };
}

module.exports = { operatorHttp };
