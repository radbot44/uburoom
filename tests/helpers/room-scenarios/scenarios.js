'use strict';
// Scripted room scenarios: the acceptance baseline for room-authority and
// protocol rewrites. Each reads as a list of user-visible steps; the harness
// records what every tab sees after each one. People: alice is the server
// owner and creates the rooms, bob and carol are ordinary signed-in members.
// Steps default to one server second; `wait` lets more scenario time pass.

/** alice creates a public room and joins it; the others join after her. */
async function together(s, names = ['bob']) {
  const alice = await s.tab('alice');
  await s.step('alice creates a public room and joins it', async () => {
    await alice.connect();
    const created = await alice.createRoom({ name: 'Scenario room' });
    return created.ok ? alice.join() : created;
  });
  const others = {};
  for (const name of names) {
    const viewer = (others[name] = await s.tab(name));
    await s.step(name + ' joins the room', async () => {
      await viewer.connect();
      return viewer.join(alice.roomId);
    });
  }
  return { alice, ...others };
}
const load = viewer => viewer.command('media.load', { mediaId: 'demo', quality: 'direct' });
const allReady = async viewers =>
  Object.fromEntries(await Promise.all(viewers.map(async viewer => [viewer.label, await viewer.ready()])));
/** Loads the demo video and lets everyone in `viewers` report ready, so it plays. */
async function startPlayback(s, loader, viewers) {
  await s.step(loader.label + ' loads the demo video', () => load(loader));
  await s.step('everyone reports ready', () => allReady(viewers));
}

const scenarios = [
  {
    name: 'create-and-join',
    async run(s) {
      const alice = await s.tab('alice'),
        bob = await s.tab('bob'),
        carol = await s.tab('carol');
      await s.step('alice and bob open the site', async () => {
        await alice.connect();
        await bob.connect();
      });
      await s.step('alice creates a public room', () => alice.createRoom({ name: 'Scenario room' }));
      await s.step('alice joins her room', () => alice.join());
      await s.step('bob joins the room', () => bob.join(alice.roomId));
      await s.step('bob joins again from the same tab', () => bob.join());
      await s.step('alice loads the demo video', () => load(alice));
      await s.step('carol opens the site and joins', async () => {
        await carol.connect();
        return carol.join(alice.roomId);
      });
      await s.step('carol leaves the room', () => carol.leave());
      await s.step('bob leaves the room', () => bob.leave());
    },
  },
  {
    name: 'play-pause-seek-readiness',
    async run(s) {
      const { alice, bob } = await together(s);
      await s.step('alice loads the demo video', () => load(alice));
      await s.step('alice reports ready; bob is still buffering', () => alice.ready());
      await s.step('three seconds pass', undefined, { wait: 3000 });
      await s.step('bob reports ready', () => bob.ready());
      await s.step('two seconds of playback', undefined, { wait: 2000 });
      await s.step('bob pauses', () => bob.command('media.pause'));
      await s.step('alice seeks to 30s while paused', () => alice.command('media.seek.absolute', { seconds: 30 }));
      await s.step('both report ready at 30s', () => allReady([alice, bob]));
      await s.step('alice plays', () => alice.command('media.play'));
      await s.step('three seconds of playback', undefined, { wait: 3000 });
      await s.step('alice seeks back 10s while playing', () => alice.command('media.seek.relative', { seconds: -10 }));
      await s.step('only alice reports ready after the seek', () => alice.ready());
      await s.step('bob reports ready after the seek', () => bob.ready());
      await s.step('two seconds of playback', undefined, { wait: 2000 });
      await s.step('bob pauses with a stale room epoch', () => bob.command('media.pause', undefined, { stale: true }));
      await s.step('alice seeks while bob never reports ready', () =>
        alice.command('media.seek.absolute', { seconds: 10 }),
      );
      await s.step('alice alone reports ready', () => alice.ready());
      await s.step('the readiness wait runs out', undefined, { wait: 10000 });
    },
  },
  {
    name: 'late-join-during-playback',
    async run(s) {
      const { alice } = await together(s, []);
      await startPlayback(s, alice, [alice]);
      await s.step('five seconds of playback', undefined, { wait: 5000 });
      const { bob, carol } = { bob: await s.tab('bob'), carol: await s.tab('carol') };
      await s.step('bob joins while the video plays', async () => {
        await bob.connect();
        return bob.join(alice.roomId);
      });
      await s.step('bob reports ready', () => bob.ready());
      await s.step('two seconds of playback', undefined, { wait: 2000 });
      await s.step('carol joins while the video plays', async () => {
        await carol.connect();
        return carol.join(alice.roomId);
      });
      await s.step('carol never reports ready; three seconds pass', undefined, { wait: 3000 });
    },
  },
  {
    name: 'host-disconnect-and-transfer',
    async run(s) {
      const { alice, bob, carol } = await together(s, ['bob', 'carol']);
      await s.step('alice makes bob a host', () => alice.settings({ action: 'host.add', userId: bob.me.accountId }));
      await startPlayback(s, alice, [alice, bob, carol]);
      await s.step('alice loses her connection', () => alice.disconnect());
      await s.step('five seconds pass', undefined, { wait: 5000 });
      await s.step('six more seconds pass', undefined, { wait: 6000 });
      await s.step('bob pauses as the new controller', () => bob.command('media.pause'));
      await s.step('bob plays', () => bob.command('media.play'));
      await s.step('everyone reports ready', () => allReady([bob, carol]));
      await s.step('bob leaves the room', () => bob.leave());
      await s.step('five seconds pass with only carol', undefined, { wait: 5000 });
      await s.step('carol tries to play', () => carol.command('media.play'));
      await s.step('alice comes back and rejoins', async () => {
        await alice.connect();
        return alice.join();
      });
      await s.step('alice plays', () => alice.command('media.play'));
      await s.step('everyone reports ready', () => allReady([alice, carol]));
    },
  },
  {
    name: 'reconnect-within-grace',
    async run(s) {
      const { alice, bob } = await together(s);
      await startPlayback(s, alice, [alice, bob]);
      await s.step('bob loses his connection', () => bob.disconnect());
      await s.step('four seconds pass', undefined, { wait: 4000 });
      await s.step('bob reconnects and rejoins with the same tab', async () => {
        await bob.connect();
        return bob.join();
      });
      await s.step('bob reports ready', () => bob.ready());
      await s.step('bob loses his connection again', () => bob.disconnect());
      await s.step('fifteen seconds pass', undefined, { wait: 15000 });
      await s.step('bob reconnects within the reconnect grace', async () => {
        await bob.connect();
        return bob.join();
      });
      await s.step('bob reports ready', () => bob.ready());
      await s.step('bob closes his tab', () => bob.disconnect({ abrupt: false }));
      await s.step('three seconds pass', undefined, { wait: 3000 });
    },
  },
  {
    name: 'queue-advance-and-autoplay',
    async run(s) {
      const { alice, bob } = await together(s);
      await s.step('alice queues the first video', () => alice.queueAdd({ title: 'First video', duration: 60 }));
      await s.step('alice queues two more', async () => ({
        second: await alice.queueAdd({ title: 'Second video', duration: 60 }),
        third: await alice.queueAdd({ title: 'Third video', duration: 60 }),
      }));
      await s.step('everyone reports ready', () => allReady([alice, bob]));
      await s.step('alice seeks to the end', () => alice.command('media.seek.absolute', { seconds: 60 }));
      await s.step('five seconds of countdown', undefined, { wait: 5000 });
      await s.step('the countdown finishes', undefined, { wait: 5000 });
      await s.step('everyone reports ready', () => allReady([alice, bob]));
      await s.step('two seconds of playback', undefined, { wait: 2000 });
      await s.step('alice seeks to the end again', () => alice.command('media.seek.absolute', { seconds: 60 }));
      await s.step('bob, a viewer, tries to cancel the countdown', () => bob.command('media.autoplay.cancel'));
      await s.step('alice cancels the countdown', () => alice.command('media.autoplay.cancel'));
      await s.step('ten seconds pass', undefined, { wait: 10000 });
      await s.step('alice skips to the next video', () => alice.command('media.next'));
      await s.step('everyone reports ready', () => allReady([alice, bob]));
      await s.step('alice turns autoplay off', () => alice.command('media.autoplay.set', { enabled: false }));
      await s.step('alice seeks to the end of the last video', () =>
        alice.command('media.seek.absolute', { seconds: 60 }),
      );
      await s.step('ten seconds pass', undefined, { wait: 10000 });
    },
  },
  {
    name: 'kick',
    async run(s) {
      const { alice, bob, carol } = await together(s, ['bob', 'carol']);
      await startPlayback(s, alice, [alice, bob, carol]);
      await s.step('bob, a viewer, tries to remove carol', () =>
        bob.command('room.kick', { userId: carol.me.accountId }),
      );
      await s.step('alice removes bob', () => alice.command('room.kick', { userId: bob.me.accountId }));
      await s.step('bob rejoins from the same tab', () => bob.join());
      const again = await s.tab('bob-tab2');
      await s.step('bob rejoins from a new tab', async () => {
        await again.connect();
        return again.join(alice.roomId);
      });
      await s.step('alice tries to remove herself', () => alice.command('room.kick', { userId: alice.me.accountId }));
    },
  },
  {
    name: 'private-room-revocation',
    async run(s) {
      const { alice, bob, carol } = await together(s, ['bob', 'carol']);
      await s.step('alice makes bob a host', () => alice.settings({ action: 'host.add', userId: bob.me.accountId }));
      await startPlayback(s, alice, [alice, bob, carol]);
      await s.step('alice makes the room private', () => alice.command('room.visibility', { visibility: 'private' }));
      await s.step('two seconds pass', undefined, { wait: 2000 });
      await s.step('carol tries to rejoin', () => carol.join());
      await s.step('alice makes the room public again', () =>
        alice.command('room.visibility', { visibility: 'public' }),
      );
      await s.step('carol rejoins', () => carol.join());
    },
  },
  {
    name: 'restart-recovery',
    disk: true,
    async run(s) {
      const { alice, bob } = await together(s);
      await startPlayback(s, alice, [alice, bob]);
      await s.step('five seconds of playback', undefined, { wait: 5000 });
      await s.step('the server restarts', () => s.restart());
      await s.step('alice reconnects and rejoins', async () => {
        await alice.connect();
        return alice.join();
      });
      await s.step('alice reports ready', () => alice.ready());
      await s.step('bob reconnects and rejoins', async () => {
        await bob.connect();
        return bob.join();
      });
      await s.step('bob reports ready', () => bob.ready());
      await s.step('two seconds of playback', undefined, { wait: 2000 });
    },
  },
  {
    // Fixture Plex items play as a direct file, so no transcode session starts.
    name: 'plex-item-playback',
    async run(s) {
      const { alice, bob } = await together(s);
      await s.step('alice loads a Plex item', () => alice.command('media.load', { mediaId: '1', quality: 'direct' }));
      await s.step('everyone reports ready', () => allReady([alice, bob]));
      await s.step('three seconds of playback', undefined, { wait: 3000 });
      await s.step('bob picks a different quality', () => bob.command('media.quality.set', { quality: '720p4' }));
      await s.step('bob reports ready on his new stream', () => bob.ready());
      await s.step('alice queues a second Plex item', () =>
        alice.queueAdd({ mediaId: '2', title: 'Second item', duration: 60 }),
      );
      await s.step('two seconds of playback', undefined, { wait: 2000 });
      await s.step('alice moves to the next item', () => alice.command('media.next'));
      await s.step('everyone reports ready', () => allReady([alice, bob]));
      await s.step('alice turns autoplay off', () => alice.command('media.autoplay.set', { enabled: false }));
      await s.step('bob picks a quality the source cannot serve', () =>
        bob.command('media.quality.set', { quality: '360p1' }),
      );
      await s.step('alice seeks to the end of the last item', () =>
        alice.command('media.seek.absolute', { seconds: 60 }),
      );
      await s.step('ten seconds pass', undefined, { wait: 10000 });
    },
  },
  {
    // Plex answers nothing while held. The demo video keeps playing for everyone
    // meanwhile; a Plex item's own stream would stall the once-a-second republish.
    name: 'slow-plex-during-commands',
    async run(s) {
      const { alice, bob } = await together(s);
      const carol = await s.tab('carol'),
        plex = s.server.plex;
      await startPlayback(s, alice, [alice, bob]);
      await s.step('Plex becomes slow', () => plex.hold());
      let loading, joining;
      await s.step('alice loads a Plex item; Plex does not answer', () => {
        loading = alice.background(() => alice.command('media.load', { mediaId: '1', quality: 'direct' }));
      });
      await s.step('bob pauses', () => bob.command('media.pause'));
      await s.step('alice queues a video while the load waits', () =>
        alice.queueAdd({ mediaId: '3', title: 'Extra video', duration: 60 }),
      );
      await s.step('bob plays', () => bob.command('media.play'));
      await s.step('carol joins', async () => {
        await carol.connect();
        joining = carol.background(() => carol.join(alice.roomId));
      });
      await s.step('two seconds pass', undefined, { wait: 2000 });
      await s.step('Plex answers; alice and carol hear back', async () => {
        plex.release();
        return { load: await loading, carolJoin: await joining };
      });
      await s.step('two seconds pass', undefined, { wait: 2000 });
      await s.step('alice queues the video', () =>
        alice.queueAdd({ mediaId: '3', title: 'Extra video', duration: 60 }),
      );
      await s.step('alice loads the Plex item again', () =>
        alice.command('media.load', { mediaId: '1', quality: 'direct' }),
      );
      await s.step('everyone reports ready', () => allReady([alice, bob, carol]));
    },
  },
  {
    name: 'empty-room-lifecycle',
    async run(s) {
      const alice = await s.tab('alice'),
        bob = await s.tab('bob');
      await s.step('alice and bob open the site', async () => {
        await alice.connect();
        await bob.connect();
      });
      await s.step('alice creates a room and never joins it', () => alice.createRoom({ name: 'Unused room' }));
      const unused = alice.roomId;
      await s.step('thirty-five seconds pass', undefined, { wait: 35000 });
      await s.step('bob tries to join the unused room', () => bob.join(unused));
      await s.step('alice creates another room and joins it', async () => {
        await alice.createRoom({ name: 'Scenario room' });
        return alice.join();
      });
      await s.step('alice loads the demo video', () => load(alice));
      await s.step('alice reports ready', () => alice.ready());
      await s.step('alice loses her connection; nobody is left', () => alice.disconnect());
      await s.step('fifteen seconds pass; the room freezes', undefined, { wait: 15000 });
      await s.step('alice returns within the grace period', async () => {
        await alice.connect();
        return alice.join();
      });
      await s.step('alice reports ready', () => alice.ready());
      await s.step('two seconds of playback', undefined, { wait: 2000 });
      await s.step('alice leaves; the room is empty', () => alice.leave());
      await s.step('three seconds pass', undefined, { wait: 3000 });
      await s.step('alice tries to join the room again', () => alice.join());
      await s.step('alice creates a third room and joins it', async () => {
        await alice.createRoom({ name: 'Second scenario room' });
        return alice.join();
      });
      await s.step('alice loses her connection', () => alice.disconnect());
      await s.step('eighty seconds pass; the grace period ends', undefined, { wait: 80000 });
      await s.step('alice returns after the grace period', async () => {
        await alice.connect();
        return alice.join();
      });
      await s.step('alice creates a fourth room and joins it', () =>
        alice.createRoom({ name: 'Third scenario room' }).then(created => (created.ok ? alice.join() : created)),
      );
      await s.step('alice loses her connection again', () => alice.disconnect());
      await s.step('fifteen seconds pass; the room freezes', undefined, { wait: 15000 });
      await s.step('bob joins the frozen room', () => bob.join(alice.roomId));
      await s.step('ten seconds pass', undefined, { wait: 10000 });
    },
  },
  {
    // Viewing grants last 15 s unless the server renews them, so a lapse shows up as a 403.
    name: 'long-playback-grants',
    async run(s) {
      const { alice, bob } = await together(s);
      await s.step('alice loads a Plex item', () => alice.command('media.load', { mediaId: '1', quality: 'direct' }));
      await s.step('everyone reports ready', () => allReady([alice, bob]));
      const access = async () => ({ mediaStatus: [await alice.mediaStatus(), await bob.mediaStatus()] });
      for (let seconds = 0; seconds < 40; seconds += 10)
        await s.step(`streams checked after ${seconds} seconds; ten seconds pass with no commands`, access, {
          wait: 10000,
        });
      await s.step('streams checked after 40 seconds', access);
    },
  },
];
module.exports = { scenarios };
