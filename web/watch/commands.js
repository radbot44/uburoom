import * as uburoom from '../../shared/engine.mjs';
import { $ } from './page.js';
import { store } from './store.js';

/* Room commands through the shared validated command engine: one control at a time, fresh mapped deadlines, never queued while reconnecting. */
export function mount(host, deps) {
  async function execute(command) {
    if (store.connection.reconnecting || !store.connection.transport?.ready)
      throw new Error('Reconnecting. Wait for the room connection.');
    if (store.lobby.switchingRoom) throw new Error('Wait for the room to open.');
    if (!store.room.selected || !store.room.state || store.room.pending)
      throw new Error('Wait for an available viewing room');
    const qualityChange = command.action === 'media.quality.set',
      volumeChange = command.action === 'media.volume.set';
    if (volumeChange && store.player.volumePending) throw new Error('Wait for your volume update to finish.');
    if (
      store.stream.qualityPending &&
      [
        'media.quality.set',
        'media.tracks.set',
        'media.stream.refresh',
        'media.load',
        'media.next',
        'media.previous',
      ].includes(command.action)
    )
      throw new Error('Wait for your quality change to finish.');
    if (
      (command.action === 'media.play' || (command.action === 'media.toggle' && !store.room.state.waitingForReady)) &&
      store.room.state.state.paused &&
      (store.player.autoplayBlocked || store.stream.readyVersion !== store.room.state.mediaVersion) &&
      deps.expected() < store.room.state.state.duration - 0.1
    )
      await deps.unlockLocal();
    const id = store.room.selected,
      epoch = store.room.state.epoch,
      qualityRequest = qualityChange ? {} : undefined;
    if (qualityChange) {
      store.stream.qualityPending = qualityRequest;
      store.stream.lastQualityRequest = deps.time.wall();
    } else if (volumeChange) store.player.volumePending = true;
    else store.room.pending = true;
    deps.fail('');
    deps.renderTransport();
    if (
      command.action.startsWith('media.seek') ||
      ['media.load', 'media.next', 'media.previous', 'queue.history.replay', 'queue.playNow'].includes(command.action)
    )
      deps.choppyDetector.interrupt();
    deps.diagnosticSample('command-start', { action: command.action });
    try {
      const timing = deps.time.clock.read();
      if (!timing.valid)
        throw new Error('Playback timing is refreshing. Retry the control after the next room update.');
      const preparing =
        qualityChange ||
        ['media.load'].includes(command.action) ||
        (store.room.state?.durable &&
          ([
            'media.next',
            'media.previous',
            'queue.history.replay',
            'queue.history.goBack',
            'queue.playNow',
            'queue.playEntry',
            'queue.skipTo',
            'queue.auto.playNow',
            'queue.offer.start',
            'queue.bulk',
            'queue.auto',
            'queue.auto.skip',
            'queue.auto.pin',
          ].includes(command.action) ||
            (!store.room.state?.mediaUrl && ['media.play', 'media.toggle', 'queue.add'].includes(command.action))));
      const result = await deps.roomLink.command(
        id,
        { viewerId: store.identity.viewerId, epoch, expiresAt: timing.serverTime + 2500, command },
        preparing ? { timeoutMs: 35000 } : {},
      );
      if (store.room.selected !== id) return { status: 'unavailable' };
      if (result.status !== 'applied') throw new Error(result.message);
      deps.diagnostics.record('command-ok', { action: command.action });
      if (command.action === 'media.volume.set')
        deps.savePlayerPreferences({ volume: command.args.percent, muted: false });
      if (['media.mute', 'media.unmute'].includes(command.action))
        deps.savePlayerPreferences({ muted: command.action === 'media.mute' });
      if (command.action === 'media.reporting.set') {
        const change = {};
        if (typeof command.args?.activity === 'boolean') change.plexReporting = command.args.activity;
        if (typeof command.args?.watchState === 'boolean') change.plexWatchState = command.args.watchState;
        deps.savePlayerPreferences(change);
      }
      await deps.refreshState();
      if (command.action === 'room.visibility') await deps.refreshRooms();
      return result;
    } catch (error) {
      deps.diagnostics.record('command-failed', { action: command.action });
      if (qualityChange && store.room.selected === id) await deps.refreshState();
      throw error;
    } finally {
      if (qualityChange) {
        if (store.stream.qualityPending === qualityRequest) store.stream.qualityPending = false;
      } else if (volumeChange) store.player.volumePending = false;
      else store.room.pending = false;
      if (qualityChange && store.room.selected === id && store.room.state?.mediaUrl)
        $('quality').value = uburoom.qualityId(store.room.state.quality);
      deps.renderLibrary();
      deps.renderVisibility();
      deps.renderTransport();
      deps.pumpVolume();
    }
  }
  return { execute };
}
