'use strict';
// Entry rules (phase 3 of docs/media-sources-plan.md): the owner picks which rules let people in and
// any one that matches is enough. Each rule admits on its own; someone matching none stays out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture } = require('./helpers/account-app');
const { accessPolicy } = require('./helpers/access');
const { Admission } = require('../server/admission');
const { Accounts, credentialVault } = require('../server/accounts');
const { isServerOperator } = require('../server/operator-policy');

const tls = { skip: !fs.existsSync(path.join(__dirname, '../certs/server-cert.pem')) };

test('a Discord server member gets in through the Discord rule, and nobody else does', tls, async t => {
  const f = await fixture(t, undefined, { accessPolicy: accessPolicy() });
  const member = f.browser();
  await member.discord('guest');
  assert.equal((await member.request('/api/watch/me')).status, 200);
  // A Plex account is no way in while no member rule names a Plex source.
  const plex = f.browser();
  assert.equal((await plex.plex('alice')).status, 302);
  assert.equal((await plex.request('/api/watch/me')).status, 401);
  // Without the server password rule, entering a password admits nobody.
  const guesser = f.browser();
  assert.equal((await guesser.request('/api/watch/entry', { password: 'anything' })).status, 403);
  assert.equal((await guesser.request('/api/watch/me')).status, 401);
  // A Discord account that is not a member is not let in either.
  f.members.delete(f.provider.subjects.guest2);
  const outsider = f.browser();
  await outsider.discord('guest2');
  assert.equal((await outsider.request('/api/watch/me')).status, 401);
  const config = (await outsider.request('/api/watch/config')).body;
  assert.deepEqual(config.access, { discord: true, plex: false, password: false, accounts: false, publicWeb: true });
});

test(
  'the server password lets anyone in as a named guest, once per browser, and only with the right password',
  tls,
  async t => {
    const f = await fixture(t, undefined, {
      accessPolicy: accessPolicy({ discordServer: false, password: true }),
      serverPassword: 'swordfish',
      channels: [],
    });
    const first = f.browser();
    assert.equal((await first.request('/api/watch/entry', { password: 'wrong' })).status, 403);
    assert.equal(
      (await first.request('/api/watch/entry', { password: 'swordfish' }, { Origin: 'https://attacker.invalid' }))
        .status,
      429,
      'another site cannot enter for a visitor',
    );
    const entered = await first.request('/api/watch/entry', { password: 'swordfish', name: 'Visitor' });
    assert.equal(entered.status, 200);
    assert.equal(entered.body.name, 'Visitor');
    const me = (await first.request('/api/watch/me')).body;
    assert.equal(me.account.name, 'Visitor');
    assert.equal(me.account.guest, 1, 'a password guest is a guest, not an account');
    assert.equal(me.owner, false);
    assert.equal(me.adminEligible, false);
    assert.equal(JSON.stringify(me).includes('swordfish'), false);
    assert.equal((await f.app.hub.mediaFor({ userId: me.account.id })).principal, 'discord-shared');
    assert.equal((await first.post('/api/watch/rooms', {})).status, 201);
    // The same browser keeps its guest and name; entering again with a new name renames it.
    const again = await first.request('/api/watch/entry', { password: 'swordfish' });
    assert.equal((await first.request('/api/watch/me')).body.account.id, me.account.id);
    assert.equal(again.body.name, 'Visitor');
    await first.request('/api/watch/entry', { password: 'swordfish', name: 'Visitor Two' });
    assert.equal((await first.request('/api/watch/me')).body.account.id, me.account.id);
    assert.equal((await first.request('/api/watch/me')).body.account.name, 'Visitor Two');
    // Another browser is another guest, offered a random name when it gives none.
    const second = f.browser();
    const other = await second.request('/api/watch/entry', { password: 'swordfish' });
    assert.equal(other.status, 200);
    assert.ok(other.body.name);
    const secondMe = (await second.request('/api/watch/me')).body;
    assert.notEqual(secondMe.account.id, me.account.id);
    // Names follow the ordinary display-name rules.
    assert.equal(
      (await f.browser().request('/api/watch/entry', { password: 'swordfish', name: 'a\u0000b' })).status,
      400,
    );
    // Wrong guesses are limited per address.
    const statuses = [];
    for (let attempt = 0; attempt < 12; attempt++)
      statuses.push((await f.browser().request('/api/watch/entry', { password: 'guess' + attempt })).status);
    assert.ok(statuses.includes(429), 'guessing is rate limited');
    assert.deepEqual((await second.request('/api/watch/config')).body.access, {
      discord: false,
      plex: false,
      password: true,
      accounts: false,
      publicWeb: true,
    });
  },
);

test('changing the server password ends every session admitted with the old one', tls, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-password-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const disk = { accountFile: path.join(dir, 'accounts.sqlite'), credentialKeyFile: path.join(dir, 'original.key') };
  const start = password =>
    fixture(t, undefined, {
      ...disk,
      accessPolicy: accessPolicy({ discordServer: false, password: true }),
      serverPassword: password,
    });
  let f = await start('first-password');
  const browser = f.browser();
  await browser.request('/api/watch/entry', { password: 'first-password', name: 'Returning' });
  const id = (await browser.request('/api/watch/me')).body.account.id;
  const cookie = browser.jar.get('uburoom');
  await f.app.close();
  // Same password after a restart: the session stays.
  f = await start('first-password');
  let again = f.browser();
  again.jar.set('uburoom', cookie);
  assert.equal((await again.request('/api/watch/me')).status, 200);
  await f.app.close();
  // A new password: the old session no longer gets in, though the browser keeps its guest name.
  f = await start('second-password');
  again = f.browser();
  again.jar.set('uburoom', cookie);
  assert.equal((await again.request('/api/watch/me')).status, 401);
  assert.equal((await again.request('/api/watch/entry', { password: 'first-password' })).status, 403);
  const entered = await again.request('/api/watch/entry', { password: 'second-password' });
  assert.equal(entered.body.name, 'Returning');
  assert.equal((await again.request('/api/watch/me')).body.account.id, id);
  // The database never holds the password in the clear.
  const raw = f.app.registry.db.prepare('SELECT value FROM meta WHERE key = ?').get('serverPassword')?.value || '';
  assert.ok(raw);
  assert.equal(raw.includes('second-password'), false);
  await f.app.close();
});

test('uburoom accounts get in through the accounts rule only, and any verified identity can be an operator', () => {
  const registry = new Accounts(undefined, credentialVault());
  try {
    const account = registry.resolve('uburoom', 'alice', 'Alice');
    const admitted = async rules =>
      new Admission({ ownerId: '', accessPolicy: accessPolicy(rules) }, registry).admit(account.id, {});
    return (async () => {
      assert.equal(await admitted({ accounts: true, discordServer: false }), true);
      assert.equal(await admitted({ accounts: false }), false, 'an account is no way in without the rule');
      const operator = { serverOperator: { identities: [{ provider: 'uburoom', subject: 'alice' }] } };
      assert.equal(isServerOperator(registry, operator, account.id), true);
      assert.equal(isServerOperator(registry, { serverOperator: { identities: [] } }, account.id), false);
    })().finally(() => registry.close());
  } catch (error) {
    registry.close();
    throw error;
  }
});

test('a rule that cannot get an answer keeps admitted people in and lets nobody new in', async () => {
  // Discord gives no answer, and a member source gives none either.
  let answer = true;
  const registry = new Accounts(undefined, credentialVault());
  try {
    const known = registry.resolve('discord', '100000000000000005', 'Known'),
      fresh = registry.resolve('plex', '555', 'New');
    const source = {
      id: 'living-room',
      memberIdentity: 'plex',
      members: async () => {
        throw new Error('Plex is offline');
      },
    };
    const admission = new Admission(
      { ownerId: '', accessPolicy: accessPolicy({ sourceMembers: ['living-room'] }) },
      registry,
      { list: [source] },
      () => ({ isMember: () => false, refresh: async () => answer }),
    );
    assert.equal(await admission.admit(known.id, {}), true);
    answer = undefined;
    admission.confirmed.get(known.id).recheck = 0;
    assert.equal(await admission.admit(known.id, {}), true, 'an outage is not a denial');
    assert.equal(await admission.admit(fresh.id, {}), false, 'nobody new gets in without an answer');
    answer = false;
    admission.confirmed.get(known.id).recheck = 0;
    assert.equal(await admission.admit(known.id, {}), false, "Discord's own no removes them");
  } finally {
    registry.close();
  }
});

test('a member rule asks each named source about each verified identity, whatever its type', async () => {
  const registry = new Accounts(undefined, credentialVault());
  try {
    const viewer = registry.resolve('discord', '100000000000000007', 'Viewer');
    registry.link(viewer.id, 'jellyfin:' + 'f'.repeat(32), 'a'.repeat(32), 'Viewer on Jellyfin');
    const asked = [];
    // A Jellyfin-like source: only its own server's identities can be members.
    const jellyfin = {
      id: 'jf',
      memberIdentity: 'jellyfin',
      members: async identity => {
        asked.push(identity.provider);
        if (identity.provider !== 'jellyfin:' + 'f'.repeat(32))
          throw Object.assign(new Error('another server'), { noServerAccess: true });
        return true;
      },
    };
    const other = {
      id: 'cabin',
      memberIdentity: 'plex',
      members: async () => Promise.reject(Object.assign(new Error('no'), { noServerAccess: true })),
    };
    const admit = members =>
      new Admission(
        { ownerId: '', accessPolicy: accessPolicy({ discordServer: false, sourceMembers: members }) },
        registry,
        { list: [jellyfin, other] },
      ).admit(viewer.id, {});
    assert.equal(await admit(['jf']), true, "the Jellyfin server's own user is its member");
    assert.ok(asked.includes('jellyfin:' + 'f'.repeat(32)));
    assert.equal(await admit(['cabin']), false, 'membership of one source never admits through a rule naming another');
    const revoked = new Admission(
      { ownerId: '', accessPolicy: accessPolicy({ discordServer: false, sourceMembers: ['jf'] }) },
      registry,
      {
        list: [
          {
            id: 'jf',
            memberIdentity: 'jellyfin',
            members: async () => Promise.reject(Object.assign(new Error('revoked'), { revoked: true })),
          },
        ],
      },
    );
    assert.equal(await revoked.admit(viewer.id, {}), false, 'a revoked sign-in is a denial');
  } finally {
    registry.close();
  }
});
