'use strict';
// A full app with fixture Discord and Plex accounts, signed-in browsers and an optional delivery fetch, for account tests.
const fs = require('node:fs'),
  path = require('node:path'),
  https = require('node:https');
const { createApp } = require('../../server/app');
const { accountFixture } = require('../../scripts/account-fixture');

async function fixture(t, deliveryFetch, overrides = {}, services = {}) {
  const provider = accountFixture(),
    cert = fs.readFileSync(path.join(__dirname, '../../certs/server-cert.pem'));
  const config = {
    cert,
    key: fs.readFileSync(path.join(__dirname, '../../certs/server-key.pem')),
    publicUrl: 'https://localhost:6768',
    ownerId: provider.subjects.host,
    clientId: '100000000000000010',
    clientSecret: 'fixture-secret',
    guildId: 'guild',
    channels: ['commands'],
    demo: true,
    unifiedAccounts: true,
    demoSubjects: provider.subjects,
    plexUrl: 'http://plex-fixture.invalid:32400',
    plexToken: 'fixture-owner',
    ...overrides,
  };
  const app = createApp(config, {
    plexFetch: deliveryFetch ? (input, options) => deliveryFetch(input, options, provider) : provider.fetch,
    plexDemo: provider,
    oauthFetch: provider.discordFetch,
    ...services,
  });
  const members = new Set(Object.values(provider.subjects));
  app.access.connect({
    identity: async id =>
      Object.values(provider.subjects).includes(id) ? { id, name: 'Known Discord user' } : undefined,
    refresh: async id => members.has(id),
    isMember: id => members.has(id),
    voiceChannel: id => (members.has(id) ? 'call' : undefined),
    validVoiceChannel: id => id === 'call',
    options: () => ({ available: true }),
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  config.publicUrl = `https://localhost:${app.server.address().port}`;
  function browser() {
    const jar = new Map();
    const control = require('./control-client').controlClient(t, config, cert);
    const request = (route, data, extra = {}) =>
      control.handles(route)
        ? control.request(route, data, { Cookie: [...jar].map(([k, v]) => k + '=' + v).join('; '), ...extra })
        : new Promise((resolve, reject) => {
            const req = https.request(
              {
                hostname: 'localhost',
                port: app.server.address().port,
                path: route,
                method: data === undefined ? 'GET' : 'POST',
                ca: cert,
                headers: {
                  Origin: config.publicUrl,
                  'Content-Type': 'application/json',
                  Cookie: [...jar].map(([k, v]) => k + '=' + v).join('; '),
                  ...extra,
                },
              },
              res => {
                for (const cookie of res.headers['set-cookie'] || []) {
                  const pair = cookie.split(';')[0],
                    i = pair.indexOf('=');
                  jar.set(pair.slice(0, i), pair.slice(i + 1));
                }
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                  const raw = Buffer.concat(chunks).toString();
                  resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: res.headers['content-type']?.includes('json') ? JSON.parse(raw) : raw,
                  });
                });
              },
            );
            req.on('error', reject);
            req.end(data === undefined ? undefined : JSON.stringify(data));
          });
    const csrf = async () => (await request('/api/watch/me')).body.csrf;
    const post = async (route, data) => request(route, data, { 'X-CSRF-Token': (await csrf()) || '' });
    const discord = async (persona = 'host', link = false) => {
      const start = link ? await post('/api/account/discord/connect', {}) : await request('/auth/discord');
      const url = new URL(link ? start.body.url : start.headers.location, config.publicUrl);
      return request('/auth/callback?' + new URLSearchParams({ state: url.searchParams.get('state'), code: persona }));
    };
    const plex = async (persona = 'alice', link = false) => {
      const start = link ? await post('/api/account/plex/connect', {}) : await request('/auth/plex');
      const url = new URL(link ? start.body.url : start.headers.location, config.publicUrl);
      const selected = await request(
        '/auth/plex/demo?' + new URLSearchParams({ state: url.searchParams.get('state'), persona }),
      );
      if (selected.status !== 302) return selected;
      return request(selected.headers.location);
    };
    return { request, post, discord, plex, jar, csrf };
  }
  return { app, provider, config, members, browser };
}

module.exports = { fixture };
