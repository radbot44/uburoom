'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Jellyfin } = require('../server/jellyfin-provider');

test('Jellyfin requests stay on the configured server, carry the key only as a header and act as the configured user', async () => {
  const user = 'a'.repeat(32),
    item = 'b'.repeat(32),
    seen = [];
  const jellyfin = new Jellyfin(
    { url: 'http://jellyfin.invalid:8096/base', apiKey: 'fixture-key', user: 'Viewer' },
    {
      pipeline: {},
      fetcher: async (input, options) => {
        const url = new URL(input);
        seen.push({ url, authorization: new Headers(options.headers).get('authorization') });
        if (url.pathname === '/base/Users')
          return Response.json([
            { Id: 'c'.repeat(32), Name: 'Owner' },
            { Id: user, Name: 'viewer' },
          ]);
        return Response.json({ Items: url.searchParams.get('ids') === item ? [{ Id: item, Type: 'Movie' }] : [] });
      },
    },
  );
  for (const resource of [
    'http://elsewhere.invalid/Items',
    'http://jellyfin.invalid:8096/other/Items',
    '/Items',
    '../x',
  ])
    assert.throws(() => jellyfin.url(resource), /Invalid Jellyfin resource/);
  assert.equal(jellyfin.url('Items?api_key=x&ApiKey=y&a=1').search, '?a=1');
  assert.equal(await jellyfin.allows(item), true);
  assert.equal(await jellyfin.allows('d'.repeat(32)), false, 'an item the configured user cannot see is not watchable');
  assert.equal(await jellyfin.allows('../../System/Info'), false);
  await assert.rejects(jellyfin.source('../../System/Info'), /Invalid Jellyfin item/);
  assert.ok(seen.length >= 3);
  for (const { url, authorization } of seen) {
    assert.ok(url.href.startsWith('http://jellyfin.invalid:8096/base/'));
    assert.ok(!url.href.includes('fixture-key'));
    assert.match(authorization, /^MediaBrowser .*Token="fixture-key"$/);
    if (url.pathname !== '/base/Users') assert.equal(url.searchParams.get('userId'), user);
  }
});
