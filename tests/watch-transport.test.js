'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const WatchTransport = require('../web/watch-transport');
const { PROTOCOL_VERSION } = require('../shared/wire-protocol');
const PlaybackDiagnostics = require('../web/playback-diagnostics');

class MockSocket {
  constructor(url) {
    this.url = url;
    this.connectionId = ++MockSocket.nextId;
    this.readyState = 0;
    this.sent = [];
    this.autoAuth = true;
    queueMicrotask(() => {
      if (this.readyState === 0) {
        this.readyState = 1;
        this.onopen?.();
      }
    });
  }
  send(data) {
    const msg = JSON.parse(data);
    this.sent.push(msg);
    if (this.autoAuth && msg.type === 'hello') {
      queueMicrotask(() => this.receive({ type: 'welcome', protocol: msg.protocol, connectionId: this.connectionId }));
    }
  }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCode = code;
    this.closeReason = reason;
    this.onclose?.({ code, reason, wasClean: code === 1000 });
  }
  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

MockSocket.nextId = 0;

test('socket diagnostics distinguish an abnormal loss from an intentional reconnect', async () => {
  const closes = [];
  const transport = new WatchTransport({
    url: 'wss://example.test/watch-socket',
    WebSocket: MockSocket,
    identity: () => ({ token: 'tok', csrf: 'csr' }),
    onClose: details => closes.push(details),
  });
  await transport.connect();
  const firstId = transport.connectionId;
  assert.ok(firstId > 0);
  transport.socket.close(1006);
  assert.equal(closes.length, 1);
  assert.equal(closes[0].connectionId, firstId);
  assert.equal(closes[0].connectionAttempt, 1);
  assert.equal(closes[0].closeInitiator, 'none');
  assert.equal(closes[0].wasReady, true);
  assert.ok(closes[0].connectionAgeMs >= 0);
  await transport.connect();
  assert.equal(transport.connectionAttempt, 2);
  assert.notEqual(transport.connectionId, firstId);
  transport.interrupt(1000);
  assert.equal(closes[1].closeInitiator, 'interrupt');
  assert.equal(closes[1].connectionAttempt, 2);
  transport.close();
  // The first disconnect scheduled a 500ms retry, which was superseded by
  // the manual connect. It must not reopen the transport after final close.
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(transport.connectionAttempt, 2, 'an orphan retry must not resurrect a stopped transport');
  assert.equal(transport.stopped, true);
});

test('diagnostic exports distinguish missing and locked rooms without leaking room identifiers', () => {
  const diagnostics = PlaybackDiagnostics.create({ now: () => 1000, monotonic: () => 0 });
  diagnostics.record('control-connected', {
    connectionId: 4,
    connectionAttempt: 2,
    visibility: 'hidden',
    url: 'wss://secret',
  });
  diagnostics.record('room-list-unavailable', {
    roomListState: 'locked',
    roomCount: 2,
    connectionId: 4,
    roomId: 'secret',
    reason: 'private',
  });
  diagnostics.record('control-disconnected', {
    socketCloseCode: 1006,
    connectionId: 4,
    connectionAgeMs: 400000,
    closeInitiator: 'none',
    socketCloseClean: false,
    socketWasReady: true,
    reason: 'secret',
  });
  const rows = diagnostics.snapshot().entries;
  const room = rows.find(row => row.event === 'room-list-unavailable');
  assert.equal(room.roomListState, 'locked');
  assert.equal(room.roomCount, 2);
  assert.equal(room.connectionId, 4);
  assert.equal(Object.hasOwn(room, 'roomId'), false);
  const closed = rows.find(row => row.event === 'control-disconnected');
  assert.equal(closed.closeInitiator, 'none');
  assert.equal(closed.socketWasReady, true);
  assert.equal(closed.socketCloseClean, false);
  assert.equal(Object.hasOwn(closed, 'reason'), false);
  assert.equal(
    Object.hasOwn(
      rows.find(row => row.event === 'control-connected'),
      'url',
    ),
    false,
  );
});

test('clock sample resolves promptly, suppresses inflight duplicates, expires on timeout, and reacquires cleanly', async () => {
  const clocks = [];
  let sampleNum = 0;
  const transport = new WatchTransport({
    url: 'wss://example.test/watch-socket',
    WebSocket: MockSocket,
    identity: () => ({ token: 'tok', csrf: 'csr' }),
    beginClock: () => ({ sample: ++sampleNum }),
    onClock: (msg, ex) => clocks.push({ msg, ex }),
    clockTimeoutMs: 40,
    heartbeatTimeoutMs: 300,
  });

  await transport.connect();
  const socket = transport.socket;
  assert.equal(socket.sent[0].type, 'hello');
  assert.equal(socket.sent[0].protocol, PROTOCOL_VERSION);
  assert.equal(transport.ready, true);

  // 1. Initial clock sample resolves promptly and cleans up pending entry
  const firstClocks = socket.sent.filter(m => m.type === 'clock');
  assert.equal(firstClocks.length, 1);
  const firstId = firstClocks[0].id;

  // While clock is inflight, duplicate clock calls do not send another request
  transport.clock();
  assert.equal(socket.sent.filter(m => m.type === 'clock').length, 1);

  // Prompt resolution
  socket.receive({
    type: 'clock',
    id: firstId,
    serverNow: 500,
    timing: { serverReceivedAt: 200, serverSentAt: 205, serverProcessingMs: 5 },
  });
  assert.equal(clocks.length, 1);
  assert.equal(clocks[0].ex.sample, 1);
  assert.equal(transport.pending.size, 0);

  // 2. Second clock sample: test expiry and reacquisition
  transport.clock();
  const secondClocks = socket.sent.filter(m => m.type === 'clock');
  assert.equal(secondClocks.length, 2);
  const secondId = secondClocks[1].id;

  // Wait for the clock sample expiry (40ms)
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(transport.pending.has(secondId), false, 'expired clock sample is removed from pending');
  assert.equal(socket.readyState, 1, 'socket remains open after clock sample expiry');

  // Next clock call can send immediately without waiting for 30s heartbeat
  transport.clock();
  const thirdClocks = socket.sent.filter(m => m.type === 'clock');
  assert.equal(thirdClocks.length, 3, 'fresh clock sample is sent promptly');
  const thirdId = thirdClocks[2].id;
  assert.notEqual(thirdId, secondId);

  // Stale clock response arriving after expiry is ignored
  socket.receive({ type: 'clock', id: secondId, serverNow: 999, timing: {} });
  assert.equal(clocks.length, 1, 'stale response does not call onClock');

  // Fresh clock response is accepted
  socket.receive({ type: 'clock', id: thirdId, serverNow: 1000, timing: {} });
  assert.equal(clocks.length, 2);
  assert.equal(clocks[1].ex.sample, 3);

  transport.close();
});

test('socket liveness timeout resets on healthy traffic and closes socket when deadline expires', async () => {
  const closes = [];
  const transport = new WatchTransport({
    url: 'wss://example.test/watch-socket',
    WebSocket: MockSocket,
    identity: () => ({ token: 'tok', csrf: 'csr' }),
    onClose: detail => closes.push(detail),
    clockTimeoutMs: 20,
    heartbeatTimeoutMs: 60,
  });
  await transport.connect();
  const socket = transport.socket;

  // Send periodic state messages from server every 25ms for 75ms total (longer than 60ms heartbeat)
  for (let i = 0; i < 3; i++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    socket.receive({ type: 'lobby', version: i, identity: {}, rooms: [] });
  }
  assert.equal(socket.readyState, 1, 'socket remains open because messages arrived');

  // Wait for heartbeat deadline without messages (60ms)
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(socket.readyState, 3, 'socket closed on heartbeat timeout');
  assert.equal(socket.closeCode, 4000);
  assert.equal(socket.closeReason, 'Server heartbeat timed out');

  transport.close();
});

test('real WebSocket server integration verifies the handshake, clock exchanges, requests and a protocol mismatch', async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  wss.on('connection', ws => {
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'hello') {
        if (msg.token === 'outdated') {
          ws.send(JSON.stringify({ type: 'error', code: 'protocol', status: 426, message: 'Update this app.' }));
          ws.close(4010, 'Protocol mismatch');
        } else ws.send(JSON.stringify({ type: 'welcome', protocol: msg.protocol, connectionId: 1 }));
      } else if (msg.type === 'clock') {
        ws.send(
          JSON.stringify({
            type: 'clock',
            id: msg.id,
            serverNow: 12345,
            timing: { serverReceivedAt: 10, serverSentAt: 11, serverProcessingMs: 1, clockEpoch: 'epoch-1' },
          }),
        );
      } else if (msg.type === 'call') {
        ws.send(
          JSON.stringify(
            msg.op === 'me'
              ? { type: 'ack', id: msg.id, value: { ok: true, echo: msg.op } }
              : { type: 'error', id: msg.id, code: 'refused', status: 409, message: 'Not now', rejoin: true },
          ),
        );
      }
    });
  });

  const clocks = [];
  const transport = new WatchTransport({
    url: `ws://127.0.0.1:${port}`,
    identity: () => ({ token: 'test-token', csrf: 'csrf-123' }),
    beginClock: () => ({ t: Date.now() }),
    onClock: (msg, ex) => clocks.push({ msg, ex }),
    clockTimeoutMs: 1000,
    heartbeatTimeoutMs: 5000,
  });

  await transport.connect();
  assert.equal(transport.ready, true);

  // Request test
  assert.deepEqual(await transport.call('me'), { ok: true, echo: 'me' });
  await assert.rejects(transport.call('rooms.list'), { message: 'Not now', status: 409, rejoin: true });

  // Clock exchange test
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(clocks.length >= 1);
  assert.equal(clocks[0].msg.serverNow, 12345);

  transport.close();

  // A server that speaks another protocol version says so; the client reports it and stops retrying.
  const pushed = [];
  const outdated = new WatchTransport({
    url: `ws://127.0.0.1:${port}`,
    identity: () => ({ token: 'outdated' }),
    onMessage: message => pushed.push(message),
  });
  await assert.rejects(outdated.connect(), { code: 'protocol', status: 426, message: 'Update this app.' });
  assert.equal(pushed[0].code, 'protocol');
  assert.equal(outdated.stopped, true);
  assert.equal(outdated.retry, undefined);

  wss.close();
  await new Promise(resolve => server.close(resolve));
});
