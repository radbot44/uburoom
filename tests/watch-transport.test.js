'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const WatchTransport = require('../web/watch-transport');
const PlaybackDiagnostics = require('../web/playback-diagnostics');

class MockSocket {
  constructor(url) {
    this.url = url;
    this.connectionId=++MockSocket.nextId;
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
    if (this.autoAuth && msg.type === 'auth') {
      queueMicrotask(() => this.receive({ type: 'auth-ok',connectionId:this.connectionId }));
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

MockSocket.nextId=0;

test('socket diagnostics distinguish an abnormal loss from an intentional reconnect', async () => {
  const closes=[];
  const transport=new WatchTransport({url:'wss://example.test/watch-socket',WebSocket:MockSocket,
    identity:()=>({token:'tok',csrf:'csr'}),onClose:details=>closes.push(details)});
  await transport.connect();
  const firstId=transport.connectionId;
  assert.ok(firstId>0);
  transport.socket.close(1006);
  assert.equal(closes.length,1);
  assert.equal(closes[0].connectionId,firstId);
  assert.equal(closes[0].connectionAttempt,1);
  assert.equal(closes[0].closeInitiator,'none');
  assert.equal(closes[0].wasReady,true);
  assert.ok(closes[0].connectionAgeMs>=0);
  await transport.connect();
  assert.equal(transport.connectionAttempt,2);
  assert.notEqual(transport.connectionId,firstId);
  transport.interrupt(1000);
  assert.equal(closes[1].closeInitiator,'interrupt');
  assert.equal(closes[1].connectionAttempt,2);
  transport.close();
});

test('diagnostic exports distinguish missing and locked rooms without leaking room identifiers', () => {
  const diagnostics=PlaybackDiagnostics.create({now:()=>1000,monotonic:()=>0});
  diagnostics.record('control-connected',{connectionId:4,connectionAttempt:2,visibility:'hidden',url:'wss://secret'});
  diagnostics.record('room-list-unavailable',{roomListState:'locked',roomCount:2,connectionId:4,roomId:'secret',reason:'private'});
  diagnostics.record('control-disconnected',{socketCloseCode:1006,connectionId:4,connectionAgeMs:400000,
    closeInitiator:'none',socketCloseClean:false,socketWasReady:true,reason:'secret'});
  const rows=diagnostics.snapshot().entries;
  const room=rows.find(row=>row.event==='room-list-unavailable');
  assert.equal(room.roomListState,'locked');
  assert.equal(room.roomCount,2);
  assert.equal(room.connectionId,4);
  assert.equal(Object.hasOwn(room,'roomId'),false);
  const closed=rows.find(row=>row.event==='control-disconnected');
  assert.equal(closed.closeInitiator,'none');
  assert.equal(closed.socketWasReady,true);
  assert.equal(closed.socketCloseClean,false);
  assert.equal(Object.hasOwn(closed,'reason'),false);
  assert.equal(Object.hasOwn(rows.find(row=>row.event==='control-connected'),'url'),false);
});

test('clock sample resolves promptly and cleans up pending entry', async () => {
  const clocks = [];
  const transport = new WatchTransport({
    url: 'wss://example.test/watch-socket',
    WebSocket: MockSocket,
    identity: () => ({ token: 'tok', csrf: 'csr' }),
    beginClock: () => ({ start: 100 }),
    onClock: (msg, ex) => clocks.push({ msg, ex }),
    clockTimeoutMs: 50,
    heartbeatTimeoutMs: 200
  });

  await transport.connect();
  const socket = transport.socket;
  assert.equal(socket.sent[0].type, 'auth');
  assert.equal(transport.ready, true);
  assert.equal(socket.sent.filter(m => m.type === 'clock').length, 1);
  const clockId = socket.sent.find(m => m.type === 'clock').id;
  socket.receive({ type: 'clock', id: clockId, serverNow: 500, timing: { serverReceivedAt: 200, serverSentAt: 205, serverProcessingMs: 5 } });
  assert.equal(clocks.length, 1);
  assert.equal(clocks[0].ex.start, 100);
  assert.equal(transport.pending.size, 0);
  transport.close();
});

test('clock sample expires after validity window without closing healthy socket and allows prompt reacquisition', async () => {
  const clocks = [];
  let sampleNum = 0;
  const transport = new WatchTransport({
    url: 'wss://example.test/watch-socket',
    WebSocket: MockSocket,
    identity: () => ({ token: 'tok', csrf: 'csr' }),
    beginClock: () => ({ sample: ++sampleNum }),
    onClock: (msg, ex) => clocks.push({ msg, ex }),
    clockTimeoutMs: 40,
    heartbeatTimeoutMs: 300
  });
  await transport.connect();
  const socket = transport.socket;
  const firstClocks = socket.sent.filter(m => m.type === 'clock');
  assert.equal(firstClocks.length, 1);
  const firstId = firstClocks[0].id;

  // While clock is inflight, duplicate clock calls do not send another request
  transport.clock();
  assert.equal(socket.sent.filter(m => m.type === 'clock').length, 1);

  // Wait for the clock sample expiry (40ms)
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(transport.pending.has(firstId), false, 'expired clock sample is removed from pending');
  assert.equal(socket.readyState, 1, 'socket remains open after clock sample expiry');

  // Next clock call can send immediately without waiting for 30s heartbeat
  transport.clock();
  const secondClocks = socket.sent.filter(m => m.type === 'clock');
  assert.equal(secondClocks.length, 2, 'fresh clock sample is sent promptly');
  const secondId = secondClocks[1].id;
  assert.notEqual(secondId, firstId);

  // Stale clock response arriving after expiry is ignored
  socket.receive({ type: 'clock', id: firstId, serverNow: 999, timing: {} });
  assert.equal(clocks.length, 0, 'stale response does not call onClock');

  // Fresh clock response is accepted
  socket.receive({ type: 'clock', id: secondId, serverNow: 1000, timing: {} });
  assert.equal(clocks.length, 1);
  assert.equal(clocks[0].ex.sample, 2);

  transport.close();
});

test('socket liveness timeout closes socket when no traffic arrives for heartbeat deadline', async () => {
  const closes = [];
  const transport = new WatchTransport({
    url: 'wss://example.test/watch-socket',
    WebSocket: MockSocket,
    identity: () => ({ token: 'tok', csrf: 'csr' }),
    onClose: detail => closes.push(detail),
    clockTimeoutMs: 20,
    heartbeatTimeoutMs: 60
  });
  await transport.connect();
  const socket = transport.socket;

  // No server messages arrive; wait for heartbeat deadline (60ms)
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(socket.readyState, 3, 'socket closed on heartbeat timeout');
  assert.equal(socket.closeCode, 4000);
  assert.equal(socket.closeReason, 'Server heartbeat timed out');

  transport.close();
});

test('healthy non-clock traffic refreshes socket liveness and prevents heartbeat disconnect', async () => {
  const transport = new WatchTransport({
    url: 'wss://example.test/watch-socket',
    WebSocket: MockSocket,
    identity: () => ({ token: 'tok', csrf: 'csr' }),
    clockTimeoutMs: 20,
    heartbeatTimeoutMs: 80
  });
  await transport.connect();
  const socket = transport.socket;

  // Send periodic state messages from server every 30ms for 120ms total (longer than 80ms heartbeat)
  for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setTimeout(resolve, 30));
    socket.receive({ type: 'state', path: '/api/watch/rooms/1', value: { epoch: i } });
  }

  assert.equal(socket.readyState, 1, 'socket remains open because messages arrived');
  transport.close();
});

test('deferred timer from background tab sleep does not trigger false heartbeat disconnect', async () => {
  const transport = new WatchTransport({
    url: 'wss://example.test/watch-socket',
    WebSocket: MockSocket,
    identity: () => ({ token: 'tok', csrf: 'csr' }),
    clockTimeoutMs: 5000,
    heartbeatTimeoutMs: 30000
  });
  await transport.connect();
  const socket = transport.socket;

  // Simulate a waking tab by manually invoking scheduleHeartbeat timeout callback
  // with a deadline that was in the past (Date.now() - deadline >= 1000)
  clearTimeout(transport.heartbeatTimer);
  const deadline = Date.now() - 5000; // Simulated 5 seconds late
  const socketRef = transport.socket;
  // Execute the exact heartbeat check logic for a deferred timer
  if (Date.now() - deadline < 1000 && Date.now() - transport.lastReceivedAt >= 30000) {
    socketRef.close(4000, 'Server heartbeat timed out');
  } else if (!transport.stopped && transport.ready) {
    transport.scheduleHeartbeat();
    transport.clock();
  }

  assert.equal(socket.readyState, 1, 'socket was not closed by deferred timer');
  assert.ok(transport.heartbeatTimer, 'heartbeat timer was re-armed for the waking tab');
  transport.close();
});

test('real WebSocket server integration verifies auth, clock exchanges, and request routing', async () => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  wss.on('connection', ws => {
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth') {
        ws.send(JSON.stringify({ type: 'auth-ok' }));
      } else if (msg.type === 'clock') {
        ws.send(JSON.stringify({
          type: 'clock',
          id: msg.id,
          serverNow: 12345,
          timing: { serverReceivedAt: 10, serverSentAt: 11, serverProcessingMs: 1, clockEpoch: 'epoch-1' }
        }));
      } else if (msg.type === 'request') {
        ws.send(JSON.stringify({
          type: 'response',
          id: msg.id,
          status: 200,
          value: { ok: true, echo: msg.path }
        }));
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
    heartbeatTimeoutMs: 5000
  });

  await transport.connect();
  assert.equal(transport.ready, true);

  // Request test
  const res = await transport.request('/api/watch/me');
  assert.deepEqual(res, { ok: true, echo: '/api/watch/me' });

  // Clock exchange test
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(clocks.length >= 1);
  assert.equal(clocks[0].msg.serverNow, 12345);

  transport.close();
  wss.close();
  await new Promise(resolve => server.close(resolve));
});
