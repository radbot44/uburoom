'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Logger, redact, stripAnsi } = require('../server/logger');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-logger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('redact masks sensitive tokens, passwords, and cookies', () => {
  assert.equal(
    redact('Connecting to Plex at https://192.168.1.50:32400?X-Plex-Token=secret12345&foo=bar'),
    'Connecting to Plex at https://192.168.1.50:32400?X-Plex-Token=[REDACTED]&foo=bar'
  );

  assert.equal(
    redact("Setting token: 'my-super-secret-token'"),
    "Setting token: '[REDACTED]'"
  );

  assert.equal(
    redact('Cookie: uburoom=abcdef1234567890; other=ok'),
    'Cookie: uburoom=[REDACTED]; other=ok'
  );

  assert.equal(
    redact('Authorization: Bearer my_jwt_token_here!'),
    'Authorization: Bearer [REDACTED]!'
  );

  const error = new Error('Plex rejected token=bad_token_99');
  const redactedError = redact(error);
  assert.equal(redactedError.message, 'Plex rejected token=[REDACTED]');

  const obj = {
    url: 'https://plex.example.com?token=secret',
    token: 'direct_secret',
    nested: {
      password: 'mypassword',
      safe: 'visible'
    }
  };
  const redactedObj = redact(obj);
  assert.equal(redactedObj.url, 'https://plex.example.com?token=[REDACTED]');
  assert.equal(redactedObj.token, '[REDACTED]');
  assert.equal(redactedObj.nested.password, '[REDACTED]');
  assert.equal(redactedObj.nested.safe, 'visible');
});

test('redact masks uburoom_* cookies, Buffer, authorization/csrf, URL, Date, shared siblings, and cycles', () => {
  // uburoom_* cookies
  assert.equal(
    redact('Cookie: uburoom_session=secret123; uburoom_csrf=csrf456; uburoom=main789; other=fine'),
    'Cookie: uburoom_session=[REDACTED]; uburoom_csrf=[REDACTED]; uburoom=[REDACTED]; other=fine'
  );

  // Date preservation
  const date = new Date('2026-10-29T12:00:00.000Z');
  assert.equal(redact(date), '2026-10-29T12:00:00.000Z');
  const invalidDate = new Date('invalid');
  assert.equal(redact(invalidDate), 'Invalid Date');

  // URL redaction
  const url = new URL('https://plex.example.com/library?X-Plex-Token=mysecrettoken&limit=10');
  assert.equal(redact(url), 'https://plex.example.com/library?X-Plex-Token=[REDACTED]&limit=10');

  // Buffer and Binary views
  assert.equal(redact(Buffer.from('hello world')), '[Binary 11B]');
  assert.equal(redact(new Uint8Array(32)), '[Binary 32B]');
  assert.equal(redact(new ArrayBuffer(16)), '[Binary 16B]');

  // authorization and csrf masking (non-boolean)
  const authObj = {
    authorization: 'Bearer supersecret',
    csrfToken: 'token123',
    secretBuffer: Buffer.from('bytes'),
    hasToken: true,
    hasPassword: false
  };
  const redactedAuth = redact(authObj);
  assert.equal(redactedAuth.authorization, '[REDACTED]');
  assert.equal(redactedAuth.csrfToken, '[REDACTED]');
  assert.equal(redactedAuth.secretBuffer, '[REDACTED]');
  assert.equal(redactedAuth.hasToken, true, 'boolean flags are preserved');
  assert.equal(redactedAuth.hasPassword, false, 'boolean flags are preserved');

  // Shared non-circular siblings
  const shared = { hello: 'world' };
  const siblings = [shared, shared];
  const redactedSiblings = redact(siblings);
  assert.deepEqual(redactedSiblings, [{ hello: 'world' }, { hello: 'world' }]);

  // Cyclic object
  const cycleObj = { name: 'cycle' };
  cycleObj.self = cycleObj;
  const redactedCycle = redact(cycleObj);
  assert.equal(redactedCycle.name, 'cycle');
  assert.equal(redactedCycle.self, '[Circular]');

  // Error name, stack, and cyclic cause
  const err = new TypeError('Test error with token=12345');
  err.cause = err;
  const redactedErr = redact(err);
  assert.equal(redactedErr.name, 'TypeError');
  assert.equal(redactedErr.message, 'Test error with token=[REDACTED]');
  assert.equal(redactedErr.cause, '[Circular]');

  // Error with nested cause
  const outerErr = new Error('Outer error');
  outerErr.cause = new Error('Root cause token=abc');
  const redactedOuter = redact(outerErr);
  assert.equal(redactedOuter.cause.message, 'Root cause token=[REDACTED]');
});

test('Logger respects log levels and level gating', async (t) => {
  const dir = temporary(t);
  const logFile = path.join(dir, 'test.log');
  const logger = new Logger({ level: 'info', file: logFile, isTTY: false });

  logger.debug('Test', 'this debug message should be skipped');
  logger.info('Test', 'this info message should be logged');
  logger.warn('Test', 'this warn message should be logged');
  logger.error('Test', 'this error message should be logged');

  await logger.close();

  const content = fs.readFileSync(logFile, 'utf8');
  assert.ok(!content.includes('debug message should be skipped'));
  assert.ok(content.includes('this info message should be logged'));
  assert.ok(content.includes('this warn message should be logged'));
  assert.ok(content.includes('this error message should be logged'));
});

test('Logger debug level outputs debug messages', async (t) => {
  const dir = temporary(t);
  const logFile = path.join(dir, 'debug.log');
  const logger = new Logger({ level: 'debug', file: logFile, isTTY: false });

  logger.debug('DebugTag', 'verbose payload: X-Plex-Token=secret-debug');
  await logger.close();

  const content = fs.readFileSync(logFile, 'utf8');
  assert.ok(content.includes('[DebugTag] verbose payload: X-Plex-Token=[REDACTED]'));
});

test('Logger child loggers append subsystem tags', async (t) => {
  const dir = temporary(t);
  const logFile = path.join(dir, 'child.log');
  const logger = new Logger({ level: 'info', file: logFile, isTTY: false });
  const httpLogger = logger.child('HTTP');

  httpLogger.info('GET /watch 200 5ms');
  await logger.close();

  const content = fs.readFileSync(logFile, 'utf8');
  assert.ok(content.includes('[HTTP] GET /watch 200 5ms'));
});
