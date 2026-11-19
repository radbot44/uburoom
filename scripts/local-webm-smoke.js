/* Actual software WebM conversion and watch clients; only synthetic providers/media. */
'use strict';
const { EVIDENCE } = require('./lib/evidence');
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { fixturePlex } = require('./playback-baseline');
const { playbackBrowser, pause } = require('./lib/playback-browser');
const { findOnPath } = require('../server/media-tools');
const { accountFixture } = require('./account-fixture');
const { openPage, navigatePage } = require('./lib/ui-fixture');
async function main() {
  const option = (key, fallback) =>
    process.argv.find(s => s.startsWith('--' + key + '='))?.slice(key.length + 3) || fallback;
  const name = option('browser', 'chrome'),
    codec = option('codec', 'vp9'),
    failFirst = process.argv.includes('--fail-first');
  if (failFirst && codec !== 'vp8') throw new Error('Use --codec=vp8 for the injected VP9 failure check');
  if (!['vp8', 'vp9'].includes(codec)) throw new Error('Choose vp8 or vp9');
  const output = path.resolve(
    option('out', path.join(EVIDENCE, 'local-webm-') + name + '-' + codec + '-' + Date.now()),
  );
  fs.mkdirSync(output, { recursive: false });
  const directory = path.resolve(option('media', path.join(EVIDENCE, 'playback-media-initial'))),
    manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const fixture = accountFixture();
  const config = {
    cert: fs.readFileSync('certs/server-cert.pem'),
    key: fs.readFileSync('certs/server-key.pem'),
    publicUrl: 'https://localhost',
    ownerId: fixture.subjects.host,
    guildId: 'fixture',
    channels: ['fixture'],
    demo: true,
    unifiedAccounts: true,
    demoSubjects: fixture.subjects,
    plexUrl: 'http://plex-fixture.invalid:32400',
    plexToken: 'fixture-owner',
    ffmpegPath: findOnPath('ffmpeg'),
    ffprobePath: findOnPath('ffprobe'),
    transcoding: {
      policy: 'override',
      plex: false,
      uburoom: true,
      encoder: 'software',
      cpuFallback: true,
      formats: failFirst ? ['vp9', 'vp8'] : [codec],
      maxJobs: 5,
    },
  };
  // Accounts and the media server's identity come from the account fixture; the synthetic
  // playback media (its metadata, file and streams) from the playback fixture.
  const mediaServer = fixturePlex(directory, manifest, { requests: [] });
  const plexFetch = (input, options = {}) => {
    const url = new URL(input);
    if (
      url.origin !== 'http://plex-fixture.invalid:32400' ||
      !/^\/(library\/(metadata|parts|streams)|video)\//.test(url.pathname)
    )
      return fixture.fetch(input, options);
    return mediaServer('http://playback-fixture.invalid:32400' + url.pathname + url.search, {
      ...options,
      headers: { ...options.headers, 'X-Plex-Token': 'synthetic-playback-only' },
    });
  };
  const app = createApp(config, { plexFetch, oauthFetch: fixture.discordFetch, plexDemo: fixture }),
    browsers = [],
    pages = [];
  let room;
  app.access.connect({
    refresh: async () => true,
    isMember: () => true,
    voiceChannel: () => 'call',
    validVoiceChannel: () => true,
    options: () => ({ available: true }),
  });
  const manager = app.watch.pipeline.av1,
    run = manager.run,
    segments = manager.segments;
  // Video is one long-running process per source; sound is one short process per chunk.
  let runs = 0;
  const injected = args =>
    failFirst && args.includes('libvpx-vp9')
      ? Promise.reject(new (require('../server/errors').PlaybackError)('Injected unavailable VP9 encoder'))
      : undefined;
  manager.run = (binary, args, ...rest) => injected(args) || run(binary, args, ...rest);
  manager.segments = (binary, args, ...rest) => {
    runs++;
    return injected(args) || segments(binary, args, ...rest);
  };
  const media = index => app.watch.rooms.get(room)?.viewers.get(viewers[index])?.media,
    viewers = [];
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    config.publicUrl = 'https://localhost:' + app.server.address().port;
    for (const persona of ['host', 'guest']) {
      const browser = await playbackBrowser(name);
      browsers.push(browser);
      // The synthetic file offers only Original, above the default 720p4 preference, so each
      // viewer has saved Original as theirs, as a returning viewer would.
      const url = config.publicUrl + '/?demo=' + persona;
      const page = await openPage(browser, url);
      await browser.evaluate(page, 'localStorage.setItem("uburoom.player",JSON.stringify({quality:"direct"}));true');
      await navigatePage(browser, page, url);
      pages.push(page);
      await browser.until(page, 'typeof transport!=="undefined"&&transport?.ready', 'Login');
      await browser.viewport(page, 1200, 850);
    }
    // Create the room through the lobby, then the guest joins it there.
    await browsers[0].evaluate(pages[0], 'document.getElementById("create").click();true');
    await browsers[0].until(pages[0], 'document.getElementById("room-dialog").open', 'Create chooser');
    await browsers[0].evaluate(
      pages[0],
      'document.getElementById("room-name").value="Local WebM";document.getElementById("room-create").click();true',
    );
    await browsers[0].until(pages[0], 'state?.durable && !document.getElementById("room-dialog").open', 'Room');
    room = [...app.watch.rooms.keys()][0];
    await browsers[1].until(pages[1], '!!document.querySelector("#lobby-rooms .room-actions :is(a,button)")', 'Lobby');
    await browsers[1].evaluate(
      pages[1],
      'document.querySelector("#lobby-rooms .room-actions :is(a,button)").click();true',
    );
    await browsers[1].until(pages[1], '!!state', 'Guest joins');
    await browsers[0].evaluate(
      pages[0],
      'execute({action:"media.load",args:{mediaId:"101",quality:"direct"}}).then(()=>true)',
    );
    // The guest converts first, so the shared output is produced under the guest's lease.
    for (const index of [1, 0]) {
      await browsers[index].until(pages[index], 'state?.mediaId==="101"', 'Shared source');
      viewers[index] = [...app.watch.rooms.get(room).viewers].find(
        ([, viewer]) => viewer.name === (index ? 'Demo guest' : 'Demo host'),
      )?.[0];
      // Exercise configured automatic selection rather than exposing a codec menu: the player's
      // compatibility fallback tries the configured local formats this browser decodes, in order.
      await browsers[index].evaluate(
        pages[index],
        '(async()=>{for(const codec of uburoomPlayback.fallbackCodecs(config.localFormats||["av1"],new Set(),m=>MediaSource.isTypeSupported(m))){try{await execute({action:"media.quality.set",args:{quality:"direct",compatible:true,fallback:codec,reason:"Synthetic compatibility check"}});return codec}catch{}}return null})()',
      );
      await browsers[index].until(
        pages[index],
        'state?.format===' + JSON.stringify(codec) + ' && videoFrames>2',
        'Configured codec decodes',
        30000,
      );
    }
    assert.equal(media(0).av1Lease.group, media(1).av1Lease.group);
    assert.equal(media(0).audioCodec, 'opus');
    const group = media(0).av1Lease.group;
    assert.equal(group.refs, 2);
    assert.equal(runs, 1, 'matching viewers share one conversion process');
    const returned = JSON.parse(
      await browsers[0].evaluate(pages[0], 'fetch(state.mediaUrl).then(r=>r.json()).then(JSON.stringify)'),
    );
    assert.equal(returned.format, codec);
    assert.ok(returned.mime.includes(codec));
    await browsers[0].evaluate(
      pages[0],
      'execute({action:"media.pause"}).then(()=>execute({action:"media.seek.absolute",args:{seconds:12}})).then(()=>true)',
    );
    for (const index of [0, 1])
      await browsers[index].until(
        pages[index],
        'video.paused&&!video.seeking&&Math.abs(video.currentTime-12)<.7',
        'Shared paused seek',
        15000,
      );
    await browsers[0].evaluate(pages[0], 'execute({action:"media.seek.absolute",args:{seconds:1}}).then(()=>true)');
    for (const index of [0, 1])
      await browsers[index].until(pages[index], '!video.seeking&&Math.abs(video.currentTime-1)<.7', 'Cached rewind');
    const before = runs;
    await pause(300);
    assert.equal(runs, before, 'cached rewind does not start new work');
    await browsers[0].screenshot(pages[0], path.join(output, 'player.png'));
    await browsers[0].evaluate(
      pages[0],
      'document.getElementById("tracks-open").click();document.getElementById("settings-more").click();true',
    );
    await browsers[0].until(pages[0], '!!document.getElementById("tracks-dialog").open', 'Player settings');
    await browsers[0].evaluate(pages[0], 'document.querySelector("[data-player-section=media]")?.click();true');
    await browsers[0].screenshot(pages[0], path.join(output, 'settings.png'));
    // The guest, whose lease produced the shared output, leaves; the host plays on from it.
    await browsers[0].evaluate(pages[0], 'document.getElementById("tracks-dialog").close();true');
    await browsers[1].close();
    await browsers[0].evaluate(pages[0], 'execute({action:"media.play"}).then(()=>true)');
    await browsers[0].until(
      pages[0],
      '!video.paused&&video.currentTime>2&&state.format===' + JSON.stringify(codec),
      'Playback survives producer departure',
    );
    app.watch.remove(room);
    assert.equal(manager.groups.size, 0);
    for (let i = 0; i < 50 && app.watch.pipeline.conversionPolicy.jobs.size; i++) await pause(100);
    assert.equal(app.watch.pipeline.conversionPolicy.jobs.size, 0, 'the conversion job ends with its viewers');
    const report = {
      passed: true,
      browser: name,
      version: browsers[1].version,
      codec,
      failFirst,
      runs,
      checks: [
        'configured automatic codec selection',
        'authorized codec-specific manifest',
        'shared chunk output from one long-running process',
        'exact Opus delivery',
        'paused seek',
        'cached rewind',
        'producer departure',
        'final reference cleanup',
      ],
      limits:
        'Synthetic providers and software encoding; no real PMS/Discord, physical audio or hardware support claim.',
    };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } catch (error) {
    for (let i = 0; i < browsers.length; i++)
      console.error(
        await browsers[i]
          .evaluate(
            pages[i],
            'JSON.stringify({format:state?.format,error:playbackError,frames:videoFrames,position:video.currentTime,paused:video.paused})',
          )
          .catch(() => ''),
      );
    throw error;
  } finally {
    await Promise.allSettled(browsers.map(browser => browser.close()));
    await app.close();
  }
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
