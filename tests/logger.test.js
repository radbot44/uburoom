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
