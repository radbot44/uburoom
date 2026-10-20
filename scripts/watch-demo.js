'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server/app');
const root = path.resolve(__dirname, '..');
const port = Number(process.env.DEMO_PORT || 6768);
// Fixture demos never read private configuration or inherited provider secrets.
const provider = !process.argv.includes('--accounts') && process.argv.includes('--plex') ? require('../server/config').loadConfig() : {};
const config = { publicUrl: `https://localhost:${port}`, cert: fs.readFileSync(path.join(root, 'certs/server-cert.pem')),
  key: fs.readFileSync(path.join(root, 'certs/server-key.pem')), ownerId: 'demo-host', guildId: 'demo-guild', channels: ['demo-commands'], demo: true,
  plexUrl: provider.plexUrl, plexToken: provider.plexToken };
const fixture=process.argv.includes('--accounts')?require('./account-fixture').accountFixture():undefined;
if(fixture)Object.assign(config,{unifiedAccounts:true,ownerId:fixture.subjects.host,demoSubjects:fixture.subjects,clientId:'100000000000000010',clientSecret:'fixture-secret',plexUrl:'http://plex-fixture.invalid:32400',plexToken:'fixture-owner'});
const app = createApp(config,fixture?{plexFetch:fixture.fetch,oauthFetch:fixture.discordFetch,plexDemo:fixture}:undefined);
const members=fixture?Object.values(fixture.subjects):['demo-host','demo-guest','demo-guest2'];
app.hub.access = { refresh: async id => members.includes(id), isMember: id => members.includes(id),
  voiceChannel: () => 'demo-voice', validVoiceChannel: id => id === 'demo-voice', options: () => ({ available: true }) };
app.server.listen(port, '127.0.0.1', () => {
  console.log(`[uburoom demo] Host: ${config.publicUrl}/watch?demo=host`);
  console.log(`[uburoom demo] Guest: ${config.publicUrl}/watch?demo=guest`);
  console.log('Isolated local demo identities; no Discord account or extension needed. Ctrl+C stops the demo.');
  if(fixture)console.log(`[uburoom accounts demo] Plex-only: ${config.publicUrl}/auth/plex (simulated provider; identities reset at shutdown).`);
});
app.server.on('error', error => { console.error('[uburoom demo] ' + error.code); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
