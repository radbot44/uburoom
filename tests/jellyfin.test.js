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

test('Jellyfin backdrops and title logos use the right images at their sizes, and other kinds are refused first', async () => {
  const user = 'a'.repeat(32),
    movie = 'b'.repeat(32),
    show = 'c'.repeat(32),
    episode = 'd'.repeat(32),
    images = [];
  const jellyfin = new Jellyfin(
    { url: 'http://jellyfin.invalid:8096', apiKey: 'fixture-key', user: 'Viewer' },
    {
      pipeline: {},
      fetcher: async input => {
        const url = new URL(input);
        if (url.pathname === '/Users') return Response.json([{ Id: user, Name: 'Viewer' }]);
        if (url.pathname.includes('/Images/')) {
          images.push([url.pathname, url.searchParams.get('maxWidth')]);
          return new Response(Buffer.from('fixture image'), { headers: { 'Content-Type': 'image/jpeg' } });
        }
        return Response.json({ Items: [] });
      },
    },
  );
  const [film, part] = jellyfin.items([
    { Id: movie, Type: 'Movie', Name: 'Film', BackdropImageTags: ['x'], ImageTags: { Primary: 'p', Logo: 'l' } },
    {
      Id: episode,
      Type: 'Episode',
      Name: 'Part',
      ParentBackdropImageTags: ['y'],
      ParentBackdropItemId: show,
      ImageTags: { Logo: 'l' },
    },
  ]);
  assert.equal(film.hasBackdrop, true);
  assert.equal(part.hasBackdrop, true);
  assert.equal(film.hasLogo, true);
  assert.equal(part.hasLogo, false, 'an episode page is titled by the episode, not a logo');
  await jellyfin.artwork(movie, 'backdrop');
  await jellyfin.artwork(episode, 'backdrop');
  await jellyfin.artwork(movie, 'logo');
  await assert.rejects(jellyfin.artwork(episode, 'logo'), /Artwork unavailable/);
  assert.deepEqual(images, [
    [`/Items/${movie}/Images/Backdrop`, '1280'],
    [`/Items/${show}/Images/Backdrop`, '1280'],
    [`/Items/${movie}/Images/Logo`, '800'],
  ]);
  for (const kind of ['constructor', '__proto__', 'art'])
    await assert.rejects(jellyfin.artwork(movie, kind), /Invalid artwork/);
  assert.equal(images.length, 3, 'a refused kind never reaches Jellyfin');
});
