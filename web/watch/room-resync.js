import { store } from './store.js';

/* Takes the room's state again: a resync on the open connection, or a fresh join on a new one. A late answer never overwrites a newer one. */
export function mount(host, deps) {
  // Asks the server for this tab's room state again. The lanes arrive as pushes
  // before the answer, so the page shows the server's state once this resolves.
  async function refreshState() {
    if (!store.room.selected) return;
    const id = store.room.selected;
    try {
      await deps.tracked('room-poll', () => deps.connected().resync());
    } catch {
      if (id === store.room.selected) deps.connectionLost();
    }
  }
  // Takes this tab's place in its room again on a new connection: the same viewer, joined afresh.
  async function rejoinRoom() {
    if (!store.room.selected) return;
    const id = store.room.selected,
      sent = deps.time.mono(),
      exchange = deps.time.clock.begin(),
      sequence = ++store.connection.stateRequestSequence;
    try {
      const next = await deps.roomLink.join(id);
      if (id !== store.room.selected || sequence !== store.connection.stateRequestSequence) return;
      deps.time.clock.add(exchange, next.timing);
      deps.diagnostics.record('clock-sample', {
        ...deps.time.clock.read(),
        requestRttMs: deps.time.mono() - exchange.sent,
        serverProcessingMs: next.timing?.serverProcessingMs,
      });
      const revision = deps.time.observation.update(next.observationEpoch, next.serverNow, sent, deps.time.mono());
      if (revision !== store.player.observationClockRevision) {
        store.player.observationBreak++;
        store.player.observationClockRevision = revision;
      }
      deps.applyState(next);
      deps.fail(store.player.playbackError);
      void deps.reportReadiness();
    } catch (error) {
      if (id === store.room.selected && sequence === store.connection.stateRequestSequence) {
        if (!error.status || error.status >= 500) deps.connectionLost();
        else {
          deps.diagnostics.record('room-state-unavailable', {
            status: error.status,
            connectionId: store.connection.transport?.connectionId,
            visibility: document.visibilityState,
          });
          deps.unavailable(error.message, 'room-poll');
        }
      }
    }
  }
  return { refreshState, rejoinRoom };
}
