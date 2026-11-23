'use strict';
const { randomBytes } = require('node:crypto');
const { hash } = require('./core');
const { isServerOperator } = require('./operator-policy');
const { clientAddress } = require('./client-address');
const { isLanRequest } = require('./origins');
const { COOKIES: DEFAULT_COOKIES } = require('./http/sessions');
const { safeReturn } = require('./http/auth');
const jellyfin = require('./http/jellyfin-sign-in');

function accountHttp({
  config,
  registry,
  plexAuth,
  plexIdentity,
  entryPolicy,
  providers,
  uburoomAccounts,
  hub,
  watch,
  watchRoutes,
  user,
  protectedPost,
  webActor,
  body,
  json,
  COOKIES = DEFAULT_COOKIES,
  cookies,
  cookie,
  replaceBrowserSession,
  revokeAccountSessions,
  logins,
  loginStore,
  discordStart,
  throttle,
}) {
  const attempts = new Map(),
    previews = new Map(),
    merges = new Map(),
    errors = new Map();
  const secret = () => randomBytes(32).toString('hex');
  const sourceHash = req => cookies(req)[COOKIES.session] && hash(cookies(req)[COOKIES.session]);
  const busy = ids =>
    [...watch.rooms.values()].some(
      room => ids.includes(room.hostId) || [...room.viewers.values()].some(v => ids.includes(v.userId)),
    );
  async function invalidate(ids, ownerChanged = false) {
    if (revokeAccountSessions) {
      await revokeAccountSessions(ids, { ownerChanged });
      return;
    }
    for (const id of ids) if (hub.adminUsers.delete(id)) hub.adminEpoch++;
    if (ownerChanged || ids.includes(registry.identity('discord', config.ownerId)?.userId)) {
      hub.adminMode = false;
      hub.adminEpoch++;
    }
    for (const [token, login] of logins) if (ids.includes(login.userId)) logins.delete(token);
    loginStore.save();
    entryPolicy?.invalidate?.(ids);
    plexAuth.clear();
    await watchRoutes.invalidate(ids);
  }
  async function session(req, res, account, name, oauth, extraCookies = [], { preservePrevious = false } = {}) {
    const record = {
      userId: account.id,
      accountRevision: account.revision,
      name,
      csrf: secret(),
      expires: null,
      ...(oauth ? { oauth } : {}),
    };
    if (replaceBrowserSession) {
      await replaceBrowserSession(req, res, record, { maxAge: 31536000, extraCookies, preservePrevious });
      return;
    }
    const previous = !preservePrevious && sourceHash(req);
    if (previous) logins.delete(previous);
    const token = secret();
    logins.set(hash(token), record);
    loginStore.save();
    const list = [cookie(COOKIES.session, token, 31536000), ...extraCookies.filter(Boolean)];
    res.setHeader('Set-Cookie', list.length === 1 ? list[0] : list);
  }
  /**
   * Finishes a sign-in whose identity is already verified, with no account signed in to link it to:
   * the person becomes that identity's account in this browser, replacing a guest session here.
   * Plex sign-in and the hand-off from first-run setup both end here.
   * @param {{provider: string, subject: string, name: string, credential?: any} | {userId: string}} who
   */
  async function completeSignIn(req, res, who, extraCookies = []) {
    let account;
    if ('userId' in who) account = registry.canonical(who.userId);
    else {
      account = registry.resolve(who.provider, who.subject, who.name);
      if (who.credential) registry.credential(who.provider, who.subject, who.credential);
      plexAuth.clear();
    }
    if (account && !registry.isGuest(account.id)) registry.seen(account.id);
    await session(req, res, account, account.name, undefined, extraCookies);
    return account;
  }
  const jellyfinRoute = jellyfin.jellyfinSignInRoute({
    config,
    registry,
    entryPolicy,
    providers,
    body,
    user,
    protectedPost,
    COOKIES,
    cookie,
    cookies,
    json,
    throttle,
    verifiedLink,
    async finishSession(req, res, account, clearCookie) {
      if (account && !registry.isGuest(account.id)) registry.seen(account.id);
      await session(req, res, account, account.name, undefined, clearCookie ? [clearCookie] : []);
    },
  });
  function mergePreview(req, login, incoming) {
    const source = registry.canonical(login.userId),
      other = registry.canonical(incoming.conflict.id),
      all = [...registry.identities(source.id), ...registry.identities(other.id)];
    if (new Set(all.map(i => i.provider)).size !== all.length)
      throw new Error('Accounts have conflicting identities; owner assistance is required');
    const id = secret();
    merges.set(sourceHash(req), {
      id,
      sourceHash: sourceHash(req),
      sourceId: source.id,
      otherId: other.id,
      version: JSON.stringify([source.revision, other.revision]),
      credential: incoming.credential,
      subject: incoming.subject,
      provider: incoming.provider,
      name: incoming.name,
      oauth: incoming.oauth || login.oauth,
      expires: Date.now() + 300000,
    });
    return { pendingMerge: true };
  }
  async function verifiedLink(req, res, login, provider, subject, name, credential, oauth, extraCookies = []) {
    const result = registry.link(login.userId, provider, subject, name);
    if (result.conflict)
      return mergePreview(req, login, { ...result, provider, subject, name, credential, oauth: oauth || login.oauth });
    if (credential) registry.credential(provider, subject, credential);
    plexAuth.clear();
    registry.audit(login.userId, 'self-link', { provider, subject });
    await invalidate([login.userId]);
    await session(req, res, result.user, result.user.name, oauth || login.oauth, extraCookies);
    return { linked: true };
  }
  function plexOffered() {
    return (
      !config.accessPolicy ||
      !!config.accessPolicy.plex ||
      !!plexAuth?.configured ||
      (!!config.guests?.enabled && !!config.guests?.requireSignIn)
    );
  }
  async function startPlex(req, res, login, returnTo) {
    if (attempts.size >= 200) throw new Error('Plex sign-in is busy');
    const state = secret(),
      attempt = await plexIdentity.start(config.publicUrl + '/auth/plex/callback?state=' + state);
    attempts.set(state, {
      ...attempt,
      expires: Date.now() + 300000,
      ...(login ? { sourceId: login.userId, sourceHash: sourceHash(req), revision: login.accountRevision } : {}),
      ...(returnTo ? { returnTo } : {}),
    });
    res.setHeader('Set-Cookie', cookie(COOKIES.plex, state, 300));
    return config.demo && plexIdentity.demo ? config.publicUrl + '/demo-plex?state=' + state : attempt.url;
  }
  function pending(req, login) {
    const merge = merges.get(sourceHash(req));
    return merge && merge.expires > Date.now() && merge.sourceId === login.userId
      ? { id: merge.id, accounts: [registry.summary(merge.sourceId), registry.summary(merge.otherId)] }
      : undefined;
  }
  async function refreshRooms() {
    for (const room of watch.rooms.values()) {
      const record = watch.roomState?.store?.get(room.roomId);
      if (record) await watch.inRoom(room, () => watch.roomState.apply(room, record), undefined);
    }
  }
  async function route(req, res, url) {
    const route = url.pathname;
    if (!route.startsWith('/api/account') && !route.startsWith('/auth/plex')) return false;
    if (!throttle('account:' + (clientAddress(req, config) || 'local'), 120)) {
      json(res, 429, { error: 'Too many account requests' });
      return true;
    }
    if (route === jellyfin.path) {
      await jellyfinRoute(req, res);
      return true;
    }
    try {
      if (req.method === 'GET' && route === '/api/account/auth-error') {
        const id = cookies(req)[COOKIES.authError],
          record = errors.get(id);
        errors.delete(id);
        json(res, 200, {
          error: record && record.expires > Date.now() ? record.message : 'Sign-in expired. Start again from uburoom.',
        });
        return true;
      }
      if (req.method === 'GET' && route === '/auth/plex') {
        if (!plexOffered()) throw new Error('Plex sign-in is not offered on this server');
        if (isLanRequest(config, req))
          throw new Error(
            'Plex sign-in is only available at ' +
              config.publicUrl +
              ' for now. Sign in with a uburoom account here or open ' +
              config.publicUrl +
              '.',
          );
        // A guest signing in starts a separate account; guests never link providers.
        const current = await user(req);
        const linking = current && !registry.isGuest(current.userId) ? current : undefined;
        const returnTo = safeReturn(url.searchParams.get('return'));
        const destination = await startPlex(req, res, linking, returnTo);
        res.writeHead(302, { Location: destination });
        res.end();
        return true;
      }
      if (req.method === 'GET' && route === '/auth/plex/demo') {
        const state = url.searchParams.get('state'),
          attempt = attempts.get(state);
        if (
          !config.demo ||
          !plexIdentity.demo ||
          !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
          !attempt ||
          attempt.expires <= Date.now() ||
          cookies(req)[COOKIES.plex] !== state
        )
          throw new Error('Isolated Plex demo is unavailable');
        plexIdentity.demo.choose(attempt.pinId, url.searchParams.get('persona'));
        res.writeHead(302, { Location: '/auth/plex/callback?state=' + state });
        res.end();
        return true;
      }
      if (req.method === 'POST' && route === '/api/account/demo-login') {
        if (
          !config.demo ||
          !plexIdentity.demo ||
          req.headers.origin !== config.publicUrl ||
          !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
        )
          throw new Error('Isolated account demo is unavailable');
        const data = await body(req);
        if (!['host', 'guest', 'guest2'].includes(data.persona)) throw new Error('Choose a demo identity');
        const subject =
          config.demoSubjects?.[data.persona] ||
          (data.persona === 'host' ? config.ownerId : data.persona === 'guest2' ? 'demo-guest2' : 'demo-guest');
        const account = registry.resolve('discord', subject, 'Demo ' + data.persona);
        registry.seen(account.id);
        await session(req, res, account, account.name, undefined, [], { preservePrevious: true });
        json(res, 200, { ok: true });
        return true;
      }
      if (req.method === 'GET' && route === '/auth/plex/callback') {
        const state = url.searchParams.get('state'),
          attempt = attempts.get(state);
        attempts.delete(state);
        if (!state || cookies(req)[COOKIES.plex] !== state || !attempt || attempt.expires <= Date.now())
          throw new Error('Plex sign-in expired; start again');
        const login = attempt.sourceId ? await user(req) : undefined;
        if (
          attempt.sourceId &&
          (!login ||
            login.userId !== attempt.sourceId ||
            sourceHash(req) !== attempt.sourceHash ||
            login.accountRevision !== attempt.revision)
        )
          throw new Error('The account changed during Plex linking; start again');
        // Plex sign-in proves which Plex account this is; admission decides whether it gets in.
        const identity = await plexIdentity.identify(attempt);
        await plexAuth.prime(identity.credential);
        let pendingMerge = false;
        if (login) {
          if ((await user(req)) !== login) throw new Error('Account sign-in expired during linking');
          const linkResult = await verifiedLink(
            req,
            res,
            login,
            'plex',
            identity.subject,
            identity.name,
            identity.credential,
          );
          if (linkResult?.pendingMerge) pendingMerge = true;
        } else
          await completeSignIn(req, res, {
            provider: 'plex',
            subject: identity.subject,
            name: identity.name,
            credential: identity.credential,
          });
        const existing = res.getHeader('Set-Cookie');
        res.setHeader('Set-Cookie', [
          ...(existing ? (Array.isArray(existing) ? existing : [existing]) : []),
          cookie(COOKIES.plex, '', 0),
        ]);
        const destination = (!pendingMerge && safeReturn(attempt.returnTo)) || '/?account=1';
        res.writeHead(302, { Location: destination });
        res.end();
        return true;
      }
      const login = req.method === 'GET' ? await user(req) : await protectedPost(req);
      if (!login) {
        json(res, 401, { error: 'Sign in to manage your account' });
        return true;
      }
      if (req.method === 'GET' && route === '/api/account') {
        const account = registry.summary(login.userId);
        const memberIds = new Set(entryPolicy?.memberSignIns?.('jellyfin').map(source => source.id) || []);
        const jellyfinSources = (providers?.list || []).filter(
          source =>
            source.kind === 'jellyfin' &&
            source.signIn &&
            (memberIds.has(source.id) || source.watchStateReporting === true),
        );
        const sourceByProvider = new Map(
          jellyfinSources.filter(source => source.serverId).map(source => ['jellyfin:' + source.serverId, source]),
        );
        const labelFor = identity => {
          if (identity.provider === 'discord') return 'Discord';
          if (identity.provider === 'plex') return 'Plex';
          if (identity.provider === 'uburoom') return 'uburoom account';
          if (identity.provider.startsWith('jellyfin:')) {
            const source = sourceByProvider.get(identity.provider);
            return source && jellyfinSources.length > 1 ? `Jellyfin (${source.name})` : 'Jellyfin';
          }
          return identity.provider;
        };
        const identities = await Promise.all(
          account.identities.map(async identity => ({
            ...identity,
            label: labelFor(identity),
            canUnlink: entryPolicy
              ? await entryPolicy.wouldAdmitWithout(login.userId, identity.provider, identity.subject, { live: false })
              : false,
          })),
        );
        const currentMerge = pending(req, login);
        if (currentMerge) {
          currentMerge.accounts = currentMerge.accounts.map(entry => ({
            ...entry,
            identities: entry.identities.map(identity => ({ ...identity, label: labelFor(identity) })),
          }));
        }
        const jellyfinList = jellyfinSources.map(source => {
          const provider = source.serverId ? 'jellyfin:' + source.serverId : undefined;
          const linked = provider ? identities.find(identity => identity.provider === provider) : undefined;
          return {
            id: source.id,
            name: source.name,
            serverId: source.serverId,
            provider,
            memberRule: memberIds.has(source.id),
            watchState: source.watchStateReporting === true,
            identity: linked,
            canUnlink: linked?.canUnlink ?? false,
          };
        });
        json(res, 200, {
          account: { ...account, identities },
          jellyfin: jellyfinList,
          merge: currentMerge,
          owner: hub.isOwner(webActor(login)),
          admin: hub.isOwner(webActor(login)) && hub.isAdmin(webActor(login)),
          serverOperator: isServerOperator(registry, config, login.userId),
        });
        return true;
      }
      if (req.method === 'POST' && route === '/api/account/plex/connect') {
        if (registry.isGuest(login.userId) || !plexOffered())
          throw new Error('Plex sign-in is not offered on this server');
        if (isLanRequest(config, req))
          throw new Error('Linking Plex is only available at ' + config.publicUrl + ' for now.');
        json(res, 200, { url: await startPlex(req, res, login) });
        return true;
      }
      if (req.method === 'POST' && route === '/api/account/discord/connect') {
        if (isLanRequest(config, req))
          throw new Error('Linking Discord is only available at ' + config.publicUrl + ' for now.');
        await discordStart(req, res, login);
        return true;
      }
      const remove = /^\/api\/account\/(discord|plex|jellyfin)\/remove$/.exec(route);
      if (req.method === 'POST' && remove) {
        const kind = remove[1],
          data = await body(req);
        let targetProvider = kind;
        let targetSubject = data.subject;
        if (kind === 'jellyfin') {
          if (
            typeof data.provider !== 'string' ||
            !/^jellyfin:[0-9a-f]{32}$/.test(data.provider) ||
            typeof data.subject !== 'string' ||
            !/^[0-9a-f]{32}$/.test(data.subject)
          )
            throw new Error('Invalid Jellyfin account');
          targetProvider = data.provider;
        } else if (targetSubject == null) {
          targetSubject = registry.identities(login.userId).find(i => i.provider === targetProvider)?.subject;
        }
        const ownerChanged = hub.isOwner(webActor(login));
        if (!entryPolicy) throw new Error('Connect another sign-in method before removing this account');
        await entryPolicy.wouldAdmitWithout(login.userId, targetProvider, targetSubject, { live: true });
        if ((await user(req)) !== login) throw new Error('Account sign-in changed; open Account again');
        if (busy([login.userId])) throw new Error('Leave your watch rooms before removing a connected account');
        const account = registry.unlink(login.userId, targetProvider, targetSubject);
        await invalidate([account.id], ownerChanged);
        merges.delete(sourceHash(req));
        await session(req, res, account, account.name, targetProvider === 'discord' ? undefined : login.oauth);
        json(res, 200, { removed: true });
        return true;
      }
      if (req.method === 'POST' && route === '/api/account/merge') {
        const data = await body(req),
          merge = merges.get(sourceHash(req));
        if (!merge || merge.id !== data.id || merge.expires <= Date.now() || merge.sourceId !== login.userId)
          throw new Error('Merge verification expired; connect the account again');
        const a = registry.canonical(merge.sourceId),
          b = registry.canonical(merge.otherId);
        if (JSON.stringify([a.revision, b.revision]) !== merge.version)
          throw new Error('Accounts changed; connect again');
        if (busy([a.id, b.id])) throw new Error('Leave all watch rooms for both accounts before merging');
        const current = await user(req);
        if (!current || current !== login) throw new Error('Account sign-in changed; connect again');
        if (JSON.stringify([registry.canonical(a.id)?.revision, registry.canonical(b.id)?.revision]) !== merge.version)
          throw new Error('Accounts changed; connect again');
        if (busy([a.id, b.id])) throw new Error('Leave all watch rooms for both accounts before merging');
        registry.merge(a.id, b.id, a.id, 'self-merge', {
          provider: merge.provider,
          subject: merge.subject,
          name: merge.name,
        });
        if (merge.credential) registry.credential(merge.provider, merge.subject, merge.credential);
        await invalidate([a.id, b.id]);
        await refreshRooms();
        merges.delete(sourceHash(req));
        await session(req, res, registry.canonical(a.id), a.name, merge.oauth || login.oauth);
        json(res, 200, { merged: true });
        return true;
      }
      if (!hub.isOwner(webActor(login)) || !hub.isAdmin(webActor(login))) {
        json(res, 403, { error: 'Enable owner Admin mode to match accounts' });
        return true;
      }
      if (req.method === 'GET' && route === '/api/account/admin') {
        json(res, 200, { accounts: registry.list() });
        return true;
      }
      if (req.method === 'POST' && route === '/api/account/admin/preview') {
        const data = await body(req);
        if (
          typeof data.discordId !== 'string' ||
          typeof data.plexId !== 'string' ||
          !/^\d{17,20}$/.test(data.discordId) ||
          !/^\d{1,20}$/.test(data.plexId)
        )
          throw new Error('Use Discord and Plex account IDs, not names or email addresses');
        if (data.discordId === config.ownerId)
          throw new Error('Connect the owner account through verified self-service linking');
        const profile = await hub.access.identity(data.discordId);
        if (!profile) throw new Error('Discord identity unavailable; check the ID and bot connection');
        const current = await user(req);
        if (!current || current !== login || !hub.isOwner(webActor(current)) || !hub.isAdmin(webActor(current))) {
          json(res, 403, { error: 'Owner Admin permission changed; preview again' });
          return true;
        }
        const preview = registry.preview(data.discordId, data.plexId),
          id = secret();
        const discordName = profile.name,
          plexName = registry.identity('plex', data.plexId)?.name || 'Awaiting Plex sign-in';
        previews.set(id, { ...preview, discordName, sourceHash: sourceHash(req), expires: Date.now() + 300000 });
        json(res, 200, {
          id,
          discordId: data.discordId,
          discordName,
          plexId: data.plexId,
          plexName,
          accounts: preview.users,
        });
        return true;
      }
      if (req.method === 'POST' && route === '/api/account/admin/assign') {
        const data = await body(req),
          preview = previews.get(data.id);
        if (preview && preview.expires <= Date.now()) previews.delete(data.id);
        if (!preview || preview.sourceHash !== sourceHash(req) || preview.expires <= Date.now())
          throw new Error('Match preview expired; preview again');
        if (busy(preview.users.map(u => u.id)))
          throw new Error('Both accounts must leave their watch rooms before matching');
        const current = await user(req);
        if (!current || current !== login || !hub.isOwner(webActor(current)) || !hub.isAdmin(webActor(current))) {
          json(res, 403, { error: 'Owner Admin permission changed; preview again' });
          return true;
        }
        if (busy(preview.users.map(u => u.id)))
          throw new Error('Both accounts must leave their watch rooms before matching');
        previews.delete(data.id);
        const id = registry.assign(preview, current.userId);
        await invalidate(preview.users.map(u => u.id));
        await refreshRooms();
        json(res, 200, { account: registry.summary(id) });
        return true;
      }
      json(res, 404, { error: 'Account action unavailable' });
      return true;
    } catch (error) {
      const message = error.message.includes('UNIQUE') ? 'Account identity conflict; preview again' : error.message;
      if (req.method === 'GET' && route.startsWith('/auth/plex')) {
        failAuth(res, message);
      } else json(res, 400, { error: message });
      return true;
    }
  }
  function failAuth(res, message) {
    const id = secret();
    errors.set(id, { message, expires: Date.now() + 60000 });
    res.setHeader('Set-Cookie', cookie(COOKIES.authError, id, 60));
    res.writeHead(302, { Location: '/auth/error' });
    res.end();
  }
  function sweep() {
    for (const map of [attempts, previews, merges, errors])
      for (const [key, value] of map) if (value.expires <= Date.now()) map.delete(key);
  }
  return {
    route,
    sweep,
    failAuth,
    verifiedLink,
    completeSignIn,
    close() {
      attempts.clear();
      previews.clear();
      merges.clear();
      errors.clear();
    },
  };
}
module.exports = { accountHttp };
