'use strict';
// A real uburoom server assembled from the existing isolated fixtures: the
// account/Plex fixture used by the demo and smoke runners, demo identities,
// the bundled demo video and an in-memory account database. Restart scenarios
// use a disposable directory so the database and key survive the restart.
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  https = require('node:https');
const { createApp } = require('../../../server/app');
const { accountFixture } = require('../../../scripts/account-fixture');
const root = path.join(__dirname, '../../..');
const certFile = path.join(root, 'certs/server-cert.pem');

async function startServer({ disk = false } = {}) {
  if (!fs.existsSync(certFile)) throw new Error('Room scenarios need development TLS files; run npm run pretest');
  const cert = fs.readFileSync(certFile),
    provider = accountFixture(),
    directory = disk ? fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-room-scenario-')) : undefined;
  const config = {
    cert,
    key: fs.readFileSync(path.join(root, 'certs/server-key.pem')),
    publicUrl: 'https://localhost',
    ownerId: provider.subjects.host,
    guildId: 'fixture',
    channels: ['fixture'],
    demo: true,
    unifiedAccounts: true,
    demoSubjects: provider.subjects,
    plexUrl: 'http://plex-fixture.invalid:32400',
    plexToken: 'fixture-owner',
    ...(directory
      ? {
          accountFile: path.join(directory, 'accounts.sqlite'),
          credentialKeyFile: path.join(directory, 'original.key'),
        }
      : {}),
  };
  // Fake Plex with a slow switch. While held, every request to the media server
  // waits until release(); account-service requests are not held. Release only
  // at a step boundary, and within the server's 12 s fetch timeout (scenario time).
  let gate;
  const plex = {
    hold() {
      gate ??= Promise.withResolvers();
    },
    release() {
      gate?.resolve();
      gate = undefined;
    },
  };
  async function plexFetch(input, options) {
    if (gate && new URL(input).hostname === new URL(config.plexUrl).hostname) await gate.promise;
    return provider.fetch(input, options);
  }
  let app, port;
  async function listen() {
    app = createApp(config, { plexFetch, oauthFetch: provider.discordFetch, plexDemo: provider });
    app.hub.access = {
      refresh: async () => true,
      isMember: () => true,
      voiceChannel: () => 'fixture',
      validVoiceChannel: () => true,
      options: () => ({ available: true }),
    };
    // A restart keeps the same port so the public URL and socket origin stay valid.
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(port || 0, '127.0.0.1', resolve);
    });
    port = app.server.address().port;
    config.publicUrl = 'https://localhost:' + port;
  }
  await listen();
  /** Signs in one fixture persona; returns the socket identity. */
  function login(persona) {
    return new Promise((resolve, reject) => {
      const request = https.request(
        config.publicUrl + '/api/watch/demo-login',
        { method: 'POST', ca: cert, headers: { Origin: config.publicUrl, 'Content-Type': 'application/json' } },
        response => {
          let raw = '';
          response.on('data', bytes => (raw += bytes));
          response.on('end', () => {
            const value = JSON.parse(raw);
            if (response.statusCode !== 200) reject(new Error('Fixture login failed: ' + raw));
            else resolve({ token: value.token, csrf: value.csrf });
          });
        },
      );
      request.on('error', reject);
      request.end(JSON.stringify({ persona }));
    });
  }
  return {
    config,
    cert,
    login,
    plex,
    get app() {
      return app;
    },
    async restart() {
      await app.close();
      await listen();
    },
    async close() {
      plex.release();
      await app.close();
      if (directory) {
        if (path.dirname(directory) !== path.resolve(os.tmpdir())) throw new Error('Unexpected scenario directory');
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}
module.exports = { startServer };
